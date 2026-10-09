// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { createServiceClient } from "../_shared/alfred-tools/supabase-client.ts";
import * as core from "../_shared/wb-sync-core.ts";

// wb-sync — daily SimpleFIN pull into the wb_ tables.
//
// Spec: docs/history/technical-spec-warren_buffet-w7b.md section 7, and
// docs/technical-spec-warren_buffet_p2-m4t.md section 5 for processing. Pure
// logic lives in _shared/wb-sync-core.ts, which is where the tests are.
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

const chunks = <T>(rows: T[], size = CHUNK): T[][] => core.chunks(rows, size);

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
  transactions_processed: number;
}

/**
 * Phase 2 processing for the given ids, in chunks. Never throws: a failed chunk
 * is recorded and its rows stay unprocessed, to be picked up by the next run.
 */
async function processTransactions(db: SupabaseClient, ids: string[]): Promise<core.ProcessTotals> {
  let totals = core.emptyProcessTotals();
  for (const [i, part] of core.chunks(ids, core.PROCESS_CHUNK).entries()) {
    try {
      const { data, error } = await db.rpc("wb_process_transactions", { ids: part });
      totals = core.addProcessResult(
        totals,
        (data ?? null) as Obj | null,
        error ? `chunk ${i + 1} (${part.length} rows): ${error.message}`.slice(0, 300) : null,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      totals = core.addProcessResult(totals, null, `chunk ${i + 1} (${part.length} rows): ${msg}`.slice(0, 300));
    }
  }
  return totals;
}

async function sync(
  db: SupabaseClient,
  body: Obj,
  owner: core.Owner,
  now: Date,
  windowStart: Date,
  hasBlockingErrors: boolean,
): Promise<{ counts: Counts; processing: core.ProcessTotals }> {
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
    transactions_processed: 0,
  };
  if (accounts.length === 0) return { counts, processing: core.emptyProcessTotals() };

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
  const touched = new Set<string>(); // new or changed, for processing
  for (const part of chunks(txnRows, 200)) {
    const { data, error } = await db
      .from("wb_transactions")
      .select("account_id, external_id, posted_at, transacted_at, amount, description, payee, memo, mcc, pending, raw")
      .in("account_id", accountIds)
      .in("external_id", part.map((r) => r.external_id));
    if (error) throw new Error(`wb_transactions read: ${error.message}`);
    const stored = new Map((data ?? []).map((r) => [`${r.account_id}|${r.external_id}`, r as Obj]));
    for (const row of part) {
      const key = core.txnKey(row.account_id, row.external_id);
      const s = stored.get(key);
      if (!s) {
        touched.add(key);
        continue;
      }
      existing++;
      if (core.transactionChanged(s, row)) {
        changed++;
        touched.add(key);
      }
    }
  }
  const upserted: Array<{ id: string; account_id: string; external_id: string }> = [];
  for (const part of chunks(txnRows)) {
    const { data, error } = await db
      .from("wb_transactions")
      .upsert(part, { onConflict: "account_id,external_id" })
      .select("id, account_id, external_id");
    if (error) throw new Error(`wb_transactions upsert: ${error.message}`);
    upserted.push(...((data ?? []) as typeof upserted));
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

  // 6. Phase 2 processing: new and changed rows, plus any never processed
  //    (an earlier failed chunk, or rows from before processing existed).
  let unprocessed: string[] = [];
  let unprocessedError: string | null = null;
  try {
    unprocessed = (await selectAll<{ id: string }>((from, to) =>
      db
        .from("wb_transactions")
        .select("id")
        .eq("context_id", owner.context_id)
        .is("processed_at", null)
        .order("id")
        .range(from, to)
    )).map((r) => r.id);
  } catch (err) {
    unprocessedError = `unprocessed read: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
  }
  const doomedSet = new Set(doomed);
  const ids = core.idsToProcess(upserted, touched, unprocessed).filter((id) => !doomedSet.has(id));
  let processing = await processTransactions(db, ids);
  if (unprocessedError) processing = core.addProcessResult(processing, null, unprocessedError);
  counts.transactions_processed = processing.processed;

  return { counts, processing };
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
  // Test switch, read only after the secret gate: no SimpleFIN call, no wb_ writes,
  // one fake blocking error through the real alert path. Cron never sends it.
  const simulate = req.headers.get(core.SIMULATE_HEADER)?.trim() === core.SIMULATE_VALUE;

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

  // Alerts never fail the run: an inbox problem is logged and reported, not thrown.
  const alert = async (inputs: core.AlertInput[], extraInstitutions: string[]) => {
    try {
      return await raiseAlerts(db, owner, runId, coveredTo, inputs, extraInstitutions);
    } catch {
      console.error("[wb-sync] stage=alert: could not raise the inbox alert.");
      return { created: 0, already_open: 0, alert_failed: true };
    }
  };

  // ── 5. Work. ─────────────────────────────────────────────────────────────
  try {
    if (!accessUrl && !simulate) throw new RunFailure("SIMPLEFIN_ACCESS_URL is not set.", "failed", "config");

    // A simulated run skips SimpleFIN entirely and writes no wb_ data.
    const body: Obj = simulate
      ? { errors: [core.SIMULATED_MESSAGE], accounts: [] }
      : await fetchSimplefin(accessUrl!, windowStart);
    const { informational, blocking } = core.classifyErrors(core.errorMessages(body));
    const { counts, processing } = await sync(db, body, owner, now, windowStart, blocking.length > 0);
    // Processing problems are recorded but never change the status.
    const status = core.runStatus(blocking);
    const blockingSafe = blocking.map((m) => core.redact(m, secrets));

    await close({
      status,
      ...(simulate ? {} : { covered_from: coveredFrom, covered_to: coveredTo }),
      details: {
        ...counts,
        processing: {
          paired: processing.paired,
          transfer_candidates: processing.transfer_candidates,
          rule_tags: processing.rule_tags,
        },
        ...(processing.errors.length
          ? { processing_errors: processing.errors.map((m) => core.redact(m, secrets)) }
          : {}),
        simplefin_errors: blockingSafe,
        simplefin_notices: informational.map((m) => core.redact(m, secrets)),
        ...(status === "partial" ? { failure_kind: "simplefin_errors" } : {}),
        ...(simulate ? { simulated: true } : {}),
      },
      error_message: status === "partial" ? blockingSafe.join(" | ") : null,
    });
    const orgNames = ((body.accounts ?? []) as Obj[]).map((a) => ((a.org ?? {}) as Obj).name as string);
    const alerts = blockingSafe.length
      ? await alert(blockingSafe.map((message) => ({ message, failureKind: null })), orgNames)
      : { created: 0, already_open: 0 };
    console.log(
      `[wb-sync] ${status}${simulate ? " (simulated)" : ""}: accounts=${counts.accounts} snapshots=${counts.snapshots_written} ` +
        `skipped_manual=${counts.snapshots_skipped_manual} holdings=${counts.holdings} ` +
        `txn_new=${counts.transactions_new} txn_updated=${counts.transactions_updated} ` +
        `txn_unchanged=${counts.transactions_unchanged} notices=${informational.length} ` +
        `pending_deleted=${counts.pending_deleted} processed=${counts.transactions_processed} ` +
        `processing_errors=${processing.errors.length} errors=${blocking.length} ` +
        `alerts_created=${alerts.created} alerts_open=${alerts.already_open}`,
    );
    return json({
      ok: true,
      run_id: runId,
      status,
      ...counts,
      processing_errors: processing.errors.length,
      simplefin_errors: blocking.length,
      alerts,
      ...(simulate ? { simulated: true } : {}),
    });
  } catch (err) {
    const failure = err instanceof RunFailure ? err : null;
    const status = failure?.status ?? "failed";
    const kind = failure?.kind ?? "db";
    const message = core.redact(err instanceof Error ? err.message : String(err), secrets);
    await close({ status, error_message: message, details: { failure_kind: kind } });
    const alerts = await alert([{ message, failureKind: kind }], []);
    console.error(`[wb-sync] ${status}: failure_kind=${kind} alerts_created=${alerts.created} alerts_open=${alerts.already_open}`);
    return json({ ok: false, run_id: runId, status, failure_kind: kind, error: message, alerts }, 500);
  }
});

/**
 * One inbox item per distinct blocking error, never a second while one with the
 * same error_key is still open (not archived). Then stamps notified_at.
 */
async function raiseAlerts(
  db: SupabaseClient,
  owner: core.Owner,
  runId: string,
  runDate: string,
  inputs: core.AlertInput[],
  extraInstitutions: string[],
): Promise<{ created: number; already_open: number }> {
  const { data: instRows, error: instErr } = await db
    .from("wb_accounts")
    .select("institution")
    .eq("context_id", owner.context_id);
  if (instErr) throw new Error(instErr.message);
  const institutions = [
    ...new Set([...(instRows ?? []).map((r) => r.institution as string), ...extraInstitutions].filter(Boolean)),
  ];

  const alerts = inputs.map((i) => core.alertFor(i, institutions, runId, runDate));
  const keys = [...new Set(alerts.map((a) => a.key))];
  const { data: openRows, error: openErr } = await db
    .from("inbox")
    .select("source_metadata")
    .eq("user_id", owner.user_id)
    .eq("source_type", "task")
    .or("archived.is.null,archived.eq.false")
    .in("source_metadata->>error_key", keys);
  if (openErr) throw new Error(openErr.message);
  const openKeys = new Set(
    (openRows ?? []).map((r) => ((r.source_metadata ?? {}) as Obj).error_key as string).filter(Boolean),
  );
  const toCreate = core.planAlerts(alerts, openKeys);

  if (toCreate.length) {
    // Every field explicit, matching clip-capture: no auth.uid() under the service role.
    const { error } = await db.from("inbox").insert(
      toCreate.map((a) => ({
        id: crypto.randomUUID(),
        user_id: owner.user_id,
        archived: false,
        triaged_at: null,
        captured_text: a.text,
        source_type: "task",
        source_metadata: {
          task_name: "wb-sync",
          run_date: runDate,
          app: core.APP,
          job: core.JOB,
          run_id: runId,
          error_key: a.key,
          failure_kind: a.failureKind ?? "simplefin_errors",
        },
        ai_status: "not_started",
        suggest_item: false,
        suggest_intent: false,
        suggest_event: false,
        suggested_tags: [],
        suggested_status: "active",
      })),
    );
    if (error) throw new Error(error.message);
  }

  const alreadyOpen = keys.filter((k) => openKeys.has(k)).length;
  if (toCreate.length + alreadyOpen > 0) {
    await db.from("platform_runs").update({ notified_at: new Date().toISOString() }).eq("id", runId);
  }
  return { created: toCreate.length, already_open: alreadyOpen };
}
