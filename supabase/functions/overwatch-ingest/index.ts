// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { createServiceClient } from "../_shared/alfred-tools/supabase-client.ts";
import { type BlockRow, parseBody, plan } from "./ingest.ts";

// overwatch-ingest — the desktop's one door into Overwatch (claims script now; gitpush and Switchboard later).
//
// Spec: docs/technical-spec-overwatch-q4n.md sections 4.5 and 5.1.
//
// 🛑 A SERVER-TO-SERVER EXCEPTION, LIKE clip-capture. Not an MCP tool: no defineTool, no ctx.db. The caller is a
// desktop script with no Supabase session, so authentication is a long-lived shared secret in `x-overwatch-secret`
// (OVERWATCH_INGEST_SECRET, at least 32 characters), checked with a length check plus timingSafeEqual before any
// other work, and the client is the SERVICE ROLE.
//
// ⚠️ RLS IS BYPASSED, SO EVERY WRITE SETS user_id EXPLICITLY, from CLIPBOARD_USER_ID: the same fixed user id
// clip-capture uses, since both write Alex's rows from his desktop.
//
// ⚠️ verify_jwt = false IS DECLARED IN config.toml. The flag has reset silently on redeploy in this project; after
// every deploy an unauthenticated POST must come back 401 with this function's own body.
//
//   POST /overwatch-ingest  { kind: "claim_block", events: [{ event: "new"|"repeat"|"clear", waiter_code,
//                             holder_code, item, run_tag, blocked_at, at }, ...] }
//     -> { ok, inserted, updated, unchanged, rejected: [{ index, error }] }
//
// A bad event is rejected and reported; the rest still apply, so the sender can drop what will never succeed.
// A database error answers 500 and the sender keeps the batch to resend: new and clear are idempotent.

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fail(status: number, error: string, extra: Record<string, unknown> = {}) {
  return json({ ok: false, error, ...extra }, status);
}

/** Constant-time comparison; the length pre-check stops timingSafeEqual's throw from leaking the length. */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const COLUMNS = "id, waiter_code, holder_code, item, run_tag, blocked_at, last_seen_at, repeat_count, cleared_at";

Deno.serve(async (req) => {
  if (req.method !== "POST") return fail(405, "method not allowed; use POST.");

  // 🛑 THE SECRET, BEFORE ANYTHING ELSE.
  const expectedSecret = Deno.env.get("OVERWATCH_INGEST_SECRET");
  const userId = Deno.env.get("CLIPBOARD_USER_ID");
  if (!expectedSecret || expectedSecret.length < 32) {
    console.error("[overwatch-ingest] OVERWATCH_INGEST_SECRET is missing or shorter than 32 characters");
    return fail(500, "server is not configured: OVERWATCH_INGEST_SECRET missing or too short.");
  }
  if (!userId) {
    console.error("[overwatch-ingest] CLIPBOARD_USER_ID is not set");
    return fail(500, "server is not configured: CLIPBOARD_USER_ID missing.");
  }
  if (!secretMatches(req.headers.get("x-overwatch-secret"), expectedSecret)) {
    console.warn("[overwatch-ingest] rejected: bad or missing x-overwatch-secret");
    return fail(401, "unauthorized");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch (e) {
    return fail(400, `body must be JSON: ${(e as Error).message}`);
  }
  const parsed = parseBody(body);
  if (!parsed.ok) return fail(400, parsed.error);

  const client = createServiceClient();
  let inserted = 0, updated = 0, unchanged = 0;

  // One event at a time, re-reading each episode, so two events for the same episode in one batch both land.
  for (const e of parsed.events) {
    const { data: found, error: readError } = await client
      .from("claim_blocks")
      .select(COLUMNS)
      .eq("user_id", userId)
      .eq("waiter_code", e.waiter_code)
      .eq("holder_code", e.holder_code)
      .eq("item", e.item)
      .eq("blocked_at", e.blocked_at)
      .maybeSingle();
    if (readError) return fail(500, `could not read claim_blocks: ${readError.message}`, { inserted, updated, unchanged });

    const p = plan(found as (BlockRow & { id: string }) | null, e);
    if (p.op === "none") {
      unchanged += 1;
      continue;
    }
    const { error } = p.op === "insert"
      ? await client.from("claim_blocks").insert({ ...p.row, user_id: userId })
      : await client.from("claim_blocks").update(p.patch).eq("id", (found as { id: string }).id);
    if (error) return fail(500, `could not write claim_blocks: ${error.message}`, { inserted, updated, unchanged });
    if (p.op === "insert") inserted += 1;
    else updated += 1;
  }

  return json({ ok: true, inserted, updated, unchanged, rejected: parsed.rejected });
});
