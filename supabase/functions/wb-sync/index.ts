// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { createServiceClient } from "../_shared/alfred-tools/supabase-client.ts";
import * as core from "../_shared/wb-sync-core.ts";

// wb-sync — daily SimpleFIN pull into the wb_ tables.
//
// Spec: docs/technical-spec-warren_buffet-w7b.md section 7. Pure logic lives in
// _shared/wb-sync-core.ts, which is where the tests are.
//
// NOT an MCP tool. Called by pg_cron via pg_net (Step 4) or by hand, with no
// user token, so like notify-dispatch it is deployed with verify_jwt = false
// and the x-wb-sync-secret header is checked FIRST, before anything else.
//
// SERVICE ROLE: RLS does not scope anything here, so every row carries the
// user_id and context_id read from the Money context row (WB_CONTEXT_ID).
//
// 🛑 NEVER LOG the access URL, the request URL, or any secret. Logs carry
// counts and status only. Any error text stored on the run is passed through
// core.redact first, because a fetch error can quote the URL it failed on.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Constant-time secret comparison; false for absent or wrong-length input. */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const CHUNK = 500;
const PAGE = 1000;

function chunks<T>(rows: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** Page past PostgREST's row cap. */
async function selectAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/** A failure with the platform_runs status and failure_kind it should close with. */
class RunFailure extends Error {
  constructor(message: string, readonly status: "failed" | "auth_expired", readonly kind: string) {
    super(message);
  }
}

type Obj = Record<string, unknown>;

async function fetchSimplefin(accessUrl: string, windowStart: Date): Promise<Obj> {
  let request;
  try {
    request = core.buildRequest(accessUrl, windowStart);
  } catch {
    throw new RunFailure("SIMPLEFIN_ACCESS_URL is not a valid access URL.", "failed", "config");
  }
  let res: Response;
  try {
    res = await fetch(request.url, { headers: { Authorization: request.authorization } });
  } catch {
    // The underlying error quotes the URL, so it is not kept.
    throw new RunFailure("SimpleFIN request failed: network error.", "failed", "network");
  }
  if (res.status === 403) {
    throw new RunFailure("SimpleFIN refused the access URL (HTTP 403): revoked or invalid.", "auth_expired", "auth");
  }
  if (res.status === 402) {
    throw new RunFailure("SimpleFIN says payment is required (HTTP 402).", "failed", "payment");
  }
  if (!res.ok) throw new RunFailure(`SimpleFIN returned HTTP ${res.status}.`, "failed", "http");
  try {
    return (await res.json()) as Obj;
  } catch {
    throw new RunFailure("SimpleFIN returned a body that is not JSON.", "failed", "parse");
  }
}

interface Counts {
  accounts: number;
  snapshots_written: number;
  snapshots_skipped_manual: number;
  holdings: number;
  transactions_new: number;
  transactions_updated: number;
  transactions_unchanged: number;
  pending_deleted: number;
}

async function sync(
  db: SupabaseClient,
  body: Obj,
  owner: core.Owner,
  now: Date,
  windowStart: Date,
  hasBlockingErrors: boolean,
): Promise<Counts> {
  const nowIso = now.toISOString();
  const asOf = core.localDate(now);
  const accounts = (Array.isArray(body.accounts) ? body.accounts : []) as Obj[];
  const counts: Counts = {
    accounts: 0,
    snapshots_written: 0,
    snapshots_skipped_manual: 0,
    holdings: 0,
    transactions_new: 0,
    transactions_updated: 0,
    transactions_unchanged: 0,
    pending_deleted: 0,
  };
  if (accounts.length === 0) return counts;

  // 1. Accounts. Only sync-owned columns are in the payload, so human columns
  //    are never touched by the upsert's update.
  const { data: acctRows, error: acctErr } = await db
    .from("wb_accounts")
    .upsert(accounts.map((a) => core.mapAccount(a, owner, nowIso)), { onConflict: "source,external_id" })
    .select("id, external_id");
  if (acctErr) throw new Error(`wb_accounts upsert: ${acctErr.message}`);
  const idByExternal = new Map((acctRows ?? []).map((r) => [r.external_id as string, r.id as string]));
  const accountIds = [...idByExternal.values()];
  counts.accounts = accountIds.length;

  // 2. Today's balances, skipping any account whose row today is manual or import.
  const planned = accounts
    .filter((a) => idByExternal.has(String(a.id)))
    .map((a) => core.mapSnapshot(a, idByExternal.get(String(a.id))!, owner, asOf));
  const { data: todayRows, error: todayErr } = await db
    .from("wb_balance_snapshots")
    .select("account_id, source")
    .eq("as_of", asOf)
    .in("account_id", accountIds);
  if (todayErr) throw new Error(`wb_balance_snapshots read: ${todayErr.message}`);
  const { write, skipped } = core.filterSnapshotsForUpsert(planned, todayRows ?? []);
  counts.snapshots_skipped_manual = skipped;
  if (write.length > 0) {
    const { error } = await db.from("wb_balance_snapshots").upsert(write, { onConflict: "account_id,as_of" });
    if (error) throw new Error(`wb_balance_snapshots upsert: ${error.message}`);
  }
  counts.snapshots_written = write.length;

  // 3. Today's holdings.
  const holdings = new Map<string, ReturnType<typeof core.mapHolding>>();
  for (const a of accounts) {
    const accountId = idByExternal.get(String(a.id));
    if (!accountId || !Array.isArray(a.holdings)) continue;
    for (const h of a.holdings as Obj[]) {
      const row = core.mapHolding(h, accountId, owner, asOf);
      holdings.set(`${accountId}|${row.external_id}`, row);
    }
  }
  for (const part of chunks([...holdings.values()])) {
    const { error } = await db.from("wb_holding_snapshots").upsert(part, { onConflict: "account_id,as_of,external_id" });
    if (error) throw new Error(`wb_holding_snapshots upsert: ${error.message}`);
  }
  counts.holdings = holdings.size;

  // 4. Transactions. Deduped first: one upsert statement cannot touch a row twice.
  const txns = new Map<string, ReturnType<typeof core.mapTransaction>>();
  const returnedIdsByAccount = new Map<string, Set<string>>();
  for (const a of accounts) {
    const accountId = idByExternal.get(String(a.id));
    if (!accountId) continue;
    const returned = new Set<string>();
    returnedIdsByAccount.set(accountId, returned);
    if (!Array.isArray(a.transactions)) continue;
    for (const t of a.transactions as Obj[]) {
      const row = core.mapTransaction(t, accountId, owner, nowIso);
      returned.add(row.external_id);
      txns.set(`${accountId}|${row.external_id}`, row);
    }
  }
  const txnRows = [...txns.values()];

  // New / updated / unchanged, for the run's counts only. "Updated" means a
  // stored field changed; every returned row still gets last_seen_at.
  let existing = 0;
  let changed = 0;
  for (const part of chunks(txnRows, 200)) {
    const { data, error } = await db
      .from("wb_transactions")
      .select("account_id, external_id, posted_at, transacted_at, amount, description, payee, memo, mcc, pending, raw")
      .in("account_id", accountIds)
      .in("external_id", part.map((r) => r.external_id));
    if (error) throw new Error(`wb_transactions read: ${error.message}`);
    const stored = new Map((data ?? []).map((r) => [`${r.account_id}|${r.external_id}`, r as Obj]));
    for (const row of part) {
      const s = stored.get(`${row.account_id}|${row.external_id}`);
      if (!s) continue;
      existing++;
      if (core.transactionChanged(s, row)) changed++;
    }
  }
  for (const part of chunks(txnRows)) {
    const { error } = await db.from("wb_transactions").upsert(part, { onConflict: "account_id,external_id" });
    if (error) throw new Error(`wb_transactions upsert: ${error.message}`);
  }
  counts.transactions_new = txnRows.length - existing;
  counts.transactions_updated = changed;
  counts.transactions_unchanged = existing - changed;

  // 5. Pending rows that this fetch covered and did not return.
  const storedPending = await selectAll<core.StoredPending>((from, to) =>
    db
      .from("wb_transactions")
      .select("id, account_id, external_id, transacted_at, posted_at, first_seen_at")
      .eq("pending", true)
      .in("account_id", accountIds)
      .order("id")
      .range(from, to)
  );
  const doomed = core.pendingRowsToDelete(storedPending, returnedIdsByAccount, windowStart, hasBlockingErrors);
  for (const part of chunks(doomed, 200)) {
    // pending = true again here: a posted row can never be deleted by the sync.
    const { error } = await db.from("wb_transactions").delete().in("id", part).eq("pending", true);
    if (error) throw new Error(`wb_transactions pending delete: ${error.message}`);
  }
  counts.pending_deleted = doomed.length;

  return counts;
}

/** Trimmed env value; a pasted secret can carry a trailing space or newline. */
function env(name: string): string | null {
  const v = Deno.env.get(name)?.trim();
  return v ? v : null;
}

/** An early failure, before a run row exists. `error` must never carry a secret. */
function early(stage: string, status: number, error: string, extra: Obj = {}): Response {
  console.error(`[wb-sync] stage=${stage}: ${error}`);
  return json({ ok: false, stage, error, ...extra }, status);
}

Deno.serve(async (req) => {
  // ── 1. The gate. Nothing above this line touches state. ──────────────────
  const expected = env("WB_SYNC_SECRET");
  if (!expected) return early("config", 503, "WB_SYNC_SECRET is not set; refusing all requests.");
  if (!secretMatches(req.headers.get("x-wb-sync-secret")?.trim() ?? null, expected)) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const contextId = env("WB_CONTEXT_ID");
  if (!contextId) return early("config", 503, "WB_CONTEXT_ID is not set.");
  const accessUrl = env("SIMPLEFIN_ACCESS_URL");
  const secrets = [...core.secretParts(accessUrl), expected];

  const db = createServiceClient();

  // ── 2. Owner, from the Money context row. Nothing is hard-coded. ─────────
  // Length only, never the value, so a bad paste is visible in the log.
  console.log(`[wb-sync] stage=context: WB_CONTEXT_ID length=${contextId.length}`);
  const { data: ctxRow, error: ctxErr } = await db
    .from("contexts")
    .select("user_id")
    .eq("id", contextId)
    .maybeSingle();
  if (ctxErr) {
    return early("context", 500, `Context lookup failed: ${core.redact(ctxErr.message, secrets)}`, {
      code: ctxErr.code ?? null,
    });
  }
  if (!ctxRow) {
    return early("context", 500, "No contexts row matches WB_CONTEXT_ID.", { context_id_length: contextId.length });
  }
  const owner: core.Owner = { user_id: ctxRow.user_id as string, context_id: contextId };

  // ── 3. Window, from the last ok run. ─────────────────────────────────────
  const now = new Date();
  const { data: lastOk, error: lastErr } = await db
    .from("platform_runs")
    .select("started_at")
    .eq("user_id", owner.user_id)
    .eq("app", core.APP)
    .eq("job", core.JOB)
    .eq("status", "ok")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastErr) {
    return early("last_run", 500, `Could not read platform_runs: ${core.redact(lastErr.message, secrets)}`, {
      code: lastErr.code ?? null,
    });
  }
  const windowStart = core.chooseWindowStart(now, lastOk ? new Date(lastOk.started_at as string) : null);
  const coveredFrom = core.localDate(windowStart);
  const coveredTo = core.localDate(now);

  // ── 4. Open the run before any work, so a crash leaves a trace. ──────────
  const { data: run, error: runErr } = await db
    .from("platform_runs")
    .insert({
      user_id: owner.user_id,
      app: core.APP,
      job: core.JOB,
      executor: core.EXECUTOR,
      host: "supabase-edge",
      status: "running",
      started_at: now.toISOString(),
    })
    .select("id")
    .single();
  if (runErr || !run) {
    return early("open_run", 500, `Could not open a run: ${core.redact(runErr?.message ?? "no row", secrets)}`, {
      code: runErr?.code ?? null,
    });
  }
  const runId = run.id as string;

  const close = async (patch: Obj) => {
    const { error } = await db
      .from("platform_runs")
      .update({ finished_at: new Date().toISOString(), ...patch })
      .eq("id", runId)
      .eq("status", "running");
    if (error) console.error("[wb-sync] Could not close the run.");
  };

  // ── 5. Work. ─────────────────────────────────────────────────────────────
  try {
    if (!accessUrl) throw new RunFailure("SIMPLEFIN_ACCESS_URL is not set.", "failed", "config");

    const body = await fetchSimplefin(accessUrl, windowStart);
    const { informational, blocking } = core.classifyErrors(core.errorMessages(body));
    const counts = await sync(db, body, owner, now, windowStart, blocking.length > 0);
    const status = core.runStatus(blocking);
    const blockingSafe = blocking.map((m) => core.redact(m, secrets));

    await close({
      status,
      covered_from: coveredFrom,
      covered_to: coveredTo,
      details: {
        ...counts,
        simplefin_errors: blockingSafe,
        simplefin_notices: informational.map((m) => core.redact(m, secrets)),
        ...(status === "partial" ? { failure_kind: "simplefin_errors" } : {}),
      },
      error_message: status === "partial" ? blockingSafe.join(" | ") : null,
    });
    console.log(
      `[wb-sync] ${status}: accounts=${counts.accounts} snapshots=${counts.snapshots_written} ` +
        `skipped_manual=${counts.snapshots_skipped_manual} holdings=${counts.holdings} ` +
        `txn_new=${counts.transactions_new} txn_updated=${counts.transactions_updated} ` +
        `txn_unchanged=${counts.transactions_unchanged} notices=${informational.length} ` +
        `pending_deleted=${counts.pending_deleted} errors=${blocking.length}`,
    );
    return json({ ok: true, run_id: runId, status, ...counts, simplefin_errors: blocking.length });
  } catch (err) {
    const failure = err instanceof RunFailure ? err : null;
    const status = failure?.status ?? "failed";
    const kind = failure?.kind ?? "db";
    const message = core.redact(err instanceof Error ? err.message : String(err), secrets);
    await close({ status, error_message: message, details: { failure_kind: kind } });
    console.error(`[wb-sync] ${status}: failure_kind=${kind}`);
    return json({ ok: false, run_id: runId, status, failure_kind: kind, error: message }, 500);
  }
});
