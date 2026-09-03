// MCP platform layer — every tool in every Alfred-family app routes through
// `defineTool` and touches the database only via `ctx.db`. This module
// intentionally does NOT export the Supabase constructor: a tool file that
// wants a client has nowhere to get one except through `defineTool`'s
// handler signature, which is the enforcement mechanism.
//
// See docs/technical-spec-platform-layer.md — sections "Architecture",
// "Write tiers", "Call guardrails". Live contract:
// `COMMENT ON SCHEMA platform`.

import { createClient } from "jsr:@supabase/supabase-js@2";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { crypto as stdCrypto } from "jsr:@std/crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Context {
  /** RLS-scoped Supabase client with the `x-actor: claude` header baked in. */
  db: SupabaseClient;
  /** The authenticated user's UUID (from the bearer token's `sub` claim). */
  userId: string;
}

export type Tier = 1 | 2 | 3;

export interface EnvelopeMeta {
  count?: number;
  truncated?: boolean;
  limit_applied?: number;
  // Total rows that would have been returned without the limit. Set only
  // when `truncated` is true and the handler ran a separate count query.
  // Consumed by the MCP wrapper to render "N of M" in the truncation NOTE
  // per docs/technical-spec-platform-layer.md § Tool house style.
  total?: number;
}

export interface DefineToolOptions<Args, Result> {
  name: string;
  tier: Tier;
  handler: (args: Args, ctx: Context) => Promise<Result>;
}

// ---------------------------------------------------------------------------
// createContext
// ---------------------------------------------------------------------------

/**
 * Build a user-scoped, actor-tagged Supabase client from the request's
 * bearer token. The `x-actor` header is what lets `platform.audit_row()`
 * distinguish AI writes from UI writes — it MUST be set here, and it MUST
 * ride on every request as a PostgREST header (transaction-scoped GUCs do
 * not survive between supabase-js calls; that lesson is baked in).
 *
 * `userId` is the JWT's `sub` claim decoded LOCALLY — no signature check,
 * no auth round-trip. It's for logging and observability only. Every real
 * authorization decision goes through PostgREST + RLS, which do verify.
 * A caller-supplied or forged `sub` here is not a security concern; using
 * it to gate access WOULD be. Do not.
 */
export function createContext(req: Request): Context {
  const authHeader =
    req.headers.get("Authorization") || req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing bearer token");
  }
  const token = authHeader.slice("Bearer ".length);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY not configured");
  }

  const db = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-actor": "claude",
      },
    },
  });

  const userId = unverifiedSubFromJwt(token);
  return { db, userId };
}

/**
 * Decode the `sub` claim from a JWT's payload segment. UNVERIFIED — we do
 * not check the signature. Intended for logging and observability only.
 * See `createContext` for why this is safe: RLS is the real gate.
 */
function unverifiedSubFromJwt(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT: expected 3 parts");
  // base64url → base64: '-' → '+', '_' → '/', pad to multiple of 4.
  let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const rem = payload.length % 4;
  if (rem === 2) payload += "==";
  else if (rem === 3) payload += "=";
  else if (rem !== 0) throw new Error("Invalid JWT payload padding");
  let json: string;
  try {
    json = atob(payload);
  } catch (e) {
    throw new Error(`JWT payload not base64: ${(e as Error).message}`);
  }
  let claims: unknown;
  try {
    claims = JSON.parse(json);
  } catch (e) {
    throw new Error(`JWT payload not JSON: ${(e as Error).message}`);
  }
  const sub = (claims as { sub?: unknown } | null)?.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new Error("JWT missing sub claim");
  }
  return sub;
}

// ---------------------------------------------------------------------------
// hashArgs
// ---------------------------------------------------------------------------

/**
 * Deterministic MD5 hex of `args`, with object keys sorted recursively so
 * `{a:1,b:2}` and `{b:2,a:1}` produce the same hash. Array order is
 * preserved — arrays are ordered data.
 *
 * Used for loop detection: `platform.check_call_budget` compares hashes of
 * the last N invocations of the same tool.
 */
export async function hashArgs(args: unknown): Promise<string> {
  const buf = new TextEncoder().encode(canonicalJson(args));
  const digest = await stdCrypto.subtle.digest("MD5", buf);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_key, value) => {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
}

// ---------------------------------------------------------------------------
// enforceBudget
// ---------------------------------------------------------------------------

interface BudgetResponse {
  allowed: boolean;
  reason: string | null;
  calls_in_window: number;
  repeat_count: number;
  message: string;
}

// ---------------------------------------------------------------------------
// describeDbError — WHICH HOP FAILED, AND WHOSE TOKEN
// ---------------------------------------------------------------------------
//
// 🛑 THIS MESSAGE COST TWO WEEKS OF FIXING THE WRONG LAYER.
//
// It used to read:
//
//     platform_check_call_budget failed: JWT expired
//
// Every word of that is true and the sentence as a whole misleads. It names a
// TOOL, so it reads as a problem with the budget check. It says JWT EXPIRED,
// which reads as "your session timed out, reconnect". Neither is where the fault
// is, and reconnecting is what made it appear fixed for a few minutes each time.
//
// ⚠️ THERE ARE THREE TOKENS IN THIS REQUEST AND THE OLD MESSAGE NAMED NONE OF
// THEM:
//
//   1. The bearer Claude sent to the Edge Function. If this were bad, the
//      request would never have reached this line — `buildCtx` requires it and
//      the function ran.
//   2. THE SAME TOKEN, FORWARDED VERBATIM to PostgREST. This is the one being
//      rejected. The Edge Function does not mint, cache or refresh anything:
//      `app.all("/")` reads the header per request and hands it straight to
//      createClient, so a rejection here is a rejection of the caller's token —
//      not of the function's own credentials, which it does not have.
//   3. The service-role key, used ONLY by ai-enrich. Not in this path at all.
//
// 🛑 SO A 401 HERE MEANS THE CALLER'S TOKEN WAS ALREADY EXPIRED WHEN IT ARRIVED,
//    AND THAT IS A STATEMENT ABOUT THE CLIENT'S REFRESH, NOT ABOUT THIS FUNCTION.
//
// A healthy OAuth client refreshes BEFORE expiry. If an expired token is
// arriving, the refresh is failing — look at POST /auth/v1/oauth/token, and at
// whether the token response carried a `refresh_token` at all. Reconnecting
// issues a fresh access token and appears to fix it for exactly one token
// lifetime, which is why this has looked like a connector problem five or six
// times running.
//
// ⚠️ THE FUNCTION CANNOT SEE THE REFRESH AND MUST NOT CLAIM TO. It reports what
// it observed — a forwarded token refused — and names where to look next
// (§11.20: a diagnostic that infers a CAUSE from one symptom and states a
// REMEDY as fact is worse than no diagnostic).

/** PostgREST codes that mean "the JWT was refused", not "the query was wrong". */
const AUTH_CODES = new Set(["PGRST301", "PGRST302", "42501"]);

function looksLikeAuthFailure(error: { code?: string; message?: string }): boolean {
  if (error.code && AUTH_CODES.has(error.code)) return true;
  const m = (error.message ?? "").toLowerCase();
  // ⚠️ "jws" AS WELL AS "jwt", AND A TEST IS WHY IT IS HERE. PostgREST reports a
  // bad signature as `JWSError JWSInvalidSignature` — JWS, the signature layer,
  // not JWT. Matching only "jwt" sent the one auth failure that is NOT an expiry
  // down the ordinary-error path, where it would read as a broken query.
  return m.includes("jwt") || m.includes("jws") || m.includes("unauthorized") ||
    m.includes("invalid claim") || m.includes("invalid token");
}

export function describeDbError(
  rpcName: string,
  error: { code?: string; message?: string; details?: string; hint?: string },
): string {
  const raw = error.message ?? "(no message)";

  if (!looksLikeAuthFailure(error)) {
    // An ordinary database error. Operational and legitimately retryable, so it
    // carries no do-not-retry wording (platform error contract).
    return `${rpcName} failed: ${raw}` +
      (error.code ? ` [${error.code}]` : "") +
      (error.details ? ` — ${error.details}` : "");
  }

  return (
    `AUTH FAILED AT THE DATABASE HOP, NOT AT THIS FUNCTION. ` +
    `PostgREST refused the caller's token while running ${rpcName}: "${raw}"` +
    (error.code ? ` [${error.code}]` : "") + ". " +
    `⚠️ THIS IS NOT A PROBLEM WITH ${rpcName} AND NOT A PROBLEM WITH THIS ` +
    `FUNCTION'S OWN CREDENTIALS — it has none. The Edge Function reads the ` +
    `Authorization header per request and forwards that exact token to ` +
    `PostgREST; it never mints, caches or refreshes one. The request reached ` +
    `here, so the token was present and well-formed. ` +
    `🛑 AN EXPIRED TOKEN ARRIVING MEANS THE CLIENT'S REFRESH IS FAILING, ` +
    `because a healthy client refreshes before expiry. LOOK AT ` +
    `POST /auth/v1/oauth/token — specifically whether it is returning 400, and ` +
    `whether the original token response carried a refresh_token at all. ` +
    `⚠️ RECONNECTING WILL APPEAR TO FIX THIS FOR ONE ACCESS-TOKEN LIFETIME AND ` +
    `THEN IT WILL STOP AGAIN. That symptom is the diagnosis, not a coincidence.`
  );
}

/**
 * Ask `public.platform_check_call_budget` (the SECURITY DEFINER wrapper
 * around `platform.check_call_budget` — PostgREST does not expose the
 * `platform` schema) whether this call is allowed. When it isn't, throw
 * with the RPC's `message` VERBATIM — the wording ("LOOP DETECTED... Do
 * NOT retry — retrying will not change the result. Stop and report to
 * the user.") is load-bearing and must reach the model unaltered. Do
 * not wrap, prefix, or paraphrase it.
 *
 * We do NOT pass the user id. The wrapper derives it server-side from
 * `auth.uid()` so a caller can't burn another user's budget.
 *
 * A non-null `error` from the RPC is FATAL — a guardrail that fails
 * open is not a guardrail. Do not fall through and run the handler.
 */
export async function enforceBudget(
  ctx: Context,
  toolName: string,
  args: unknown
): Promise<BudgetResponse> {
  const argsHash = await hashArgs(args);
  const { data, error } = await ctx.db.rpc("platform_check_call_budget", {
    p_tool: toolName,
    p_args_hash: argsHash,
  });
  if (error) {
    throw new Error(describeDbError("platform_check_call_budget", error));
  }
  const row: BudgetResponse = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new Error("platform_check_call_budget returned no row");
  }
  if (!row.allowed) {
    // VERBATIM. Do not decorate.
    throw new Error(row.message);
  }
  return row;
}

// ---------------------------------------------------------------------------
// clampLimit + envelope
// ---------------------------------------------------------------------------

/**
 * Response-size ceiling for list tools. Default 20, hard cap 50 — a tool
 * that thinks it wants 200 items is asking the wrong question.
 */
export function clampLimit(requested?: number | null): number {
  return Math.min(requested ?? 20, 50);
}

/**
 * Wrap tool output in the house response shape. `meta.count` is inferred
 * from array length when the handler doesn't set it explicitly; `truncated`
 * and `limit_applied` are only emitted when the handler passed them.
 */
export function envelope<T>(
  data: T,
  meta: EnvelopeMeta = {}
): { data: T; meta: EnvelopeMeta } {
  const inferredCount = Array.isArray(data) ? (data as unknown[]).length : undefined;
  const out: EnvelopeMeta = {};
  const count = meta.count ?? inferredCount;
  if (count !== undefined) out.count = count;
  if (meta.truncated !== undefined) out.truncated = meta.truncated;
  if (meta.limit_applied !== undefined) out.limit_applied = meta.limit_applied;
  if (meta.total !== undefined) out.total = meta.total;
  return { data, meta: out };
}

function isEnvelope(v: unknown): v is { data: unknown; meta: EnvelopeMeta } {
  return (
    typeof v === "object" &&
    v !== null &&
    "data" in v &&
    "meta" in v
  );
}

// ---------------------------------------------------------------------------
// defineTool
// ---------------------------------------------------------------------------

/**
 * Compose the platform stack around a tool handler:
 *
 *   createContext → enforceBudget → tier-3 confirmation gate → handler → envelope
 *
 * The returned function is what an MCP server (or edge dispatcher) invokes.
 * The handler receives `(args, ctx)` and returns raw data OR a pre-formed
 * envelope. Either way the final output has the house shape.
 *
 * Tier 3 (destructive / semantically significant writes) requires an
 * explicit `confirmed: true` argument. Without it, the tool returns a
 * proposal object describing what WOULD happen — no writes fire, no
 * confirmation required to *read* the proposal. Confirming is a second
 * call with `confirmed: true` in the args.
 */
export function defineTool<Args extends Record<string, unknown>, Result>(
  options: DefineToolOptions<Args, Result>
) {
  const { name, tier, handler } = options;
  return async function invoke(args: Args, req: Request) {
    const ctx = await createContext(req);
    await enforceBudget(ctx, name, args);

    if (tier === 3 && !args?.confirmed) {
      // Tier-3 gate: return a proposal envelope instead of writing.
      const proposal = {
        tool: name,
        tier: 3,
        args,
        confirmation_required: true,
        message:
          "Tier 3 write not applied. Re-invoke this tool with `confirmed: true` in args to proceed.",
      };
      return envelope(proposal);
    }

    const result = await handler(args, ctx);
    if (isEnvelope(result)) return result;
    return envelope(result as unknown);
  };
}
