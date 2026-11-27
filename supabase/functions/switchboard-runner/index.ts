// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createClient } from "jsr:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";
import { createServiceClient } from "../_shared/alfred-tools/supabase-client.ts";
import {
  type Action, type Deps, handle, HELPER_KINDS, LONG_PICK_KINDS, type Picked, type PickedAction, type RunOutcome, SF_RUN_MODES, type Statement,
  type StatementResult,
} from "./core.ts";

// switchboard-runner: the only code that executes queued SQL, and the only code using SUPABASE_DB_URL.
// Spec: docs/technical-spec-switchboard2-h8r.md 8.1. Routes and refusals are in core.ts.
//
// 🛑 A SERVER-TO-SERVER EXCEPTION, LIKE clip-capture. Not an MCP tool: no defineTool, no ctx.db.
//
//   POST /queue    x-switchboard-queue-secret. { project_code, sql, description, expected?, test? } -> { ok, action_id, headline }
//   POST /preview  Alex's JWT. { token } -> { headline, description, sql, fingerprint, test, stakes?, ... }. Runs nothing.
//                  stakes is change or none, from switchboard_stakes (s86ac); left out while that function is missing.
//   POST /dry-run  Alex's JWT. { token } -> { run_id, summary, counts, mismatch }. Rolled back; the link is not spent,
//                  unless it's a test action, whose one run this is.
//   POST /approve  Alex's JWT. { token, fingerprint } -> { run_id, summary, conformance, counts }. Needs a clean latest dry run.
//   POST /cancel   Alex's JWT. { token, reason? } -> { run_id, cancelled, reason }. Spends the link; runs nothing.
//   A git, sf_check (s86pa), sb_setup, sf_read, sf_dataop, sf_dataquery or sf_datawrite link: /preview adds kind and payload; /approve
//   only spends the link, so the action is consumed for the helper, and runs nothing here; /cancel needs no dry run;
//   /dry-run is refused.
//   POST /pickup   x-switchboard-pickup-key. { kinds? } -> { action (with kind) | null, timed_out }. The desktop helper.
//                  No kinds: git only, by switchboard_pickup_git. All seven, sf_datawrite included, the six of
//                  dataop_link-k7d or the five of dataops_alfred-d4x: switchboard_pickup_helper with p_kinds (the six
//                  never get an sf_datawrite, the five never an sf_dataquery). The
//                  four without sf_dataop, or the older three (a helper before s89c): the same, with no p_kinds, so
//                  never a production kind (dataops_alfred-d4x O3). A pick with no result is failed after 30 minutes,
//                  an sf_dataop's, sf_dataquery's or sf_datawrite's (LONG_PICK_KINDS) after 4 hours.
//                  sb3_runner-r4q r4: optional pickup_id, a uuid the helper makes per approve click and sends on every
//                  retry; passed as p_pickup_id, so a repeat gets the same action (migration 247). Anything else is
//                  refused with its fix.
//                  sb3_runner-r4q s4: all eight kinds (sf_run too) are passed whole; the seven never get an sf_run.
//                  A picked sf_run comes with link (its switchboard_run_links row by payload.link_id, without
//                  token_hash) and request (that link's switchboard_run_requests row, whole); a missing one fails the
//                  action and answers 409 with the fix. sf_run picks get 4 hours.
//                  s6 (M): every reply adds expired: [{action_id, kind, project_code}], the helper-kind actions whose
//                  run was closed with failure_reason expired_not_picked_up in the last 24 hours (by a pickup, or a
//                  run page's resend), read after the pickup function returns. Repeats are expected (the helper
//                  de-dupes by action id); left out if the read fails twice. An older helper ignores it.
//   POST /pending  x-switchboard-pickup-key. {} -> { ok, clear, unpicked: [{action_id, kind, project_code, status,
//                  approved_at, stale}], unreported: [{action_id, run_id, kind, project_code, picked_up_at, stale}] }.
//                  Read-only, for B's reinstall check at Alex's click, never on a timer. An unpicked stale one never
//                  runs and doesn't block; every unreported one blocks, since the helper may still be running it.
//   POST /result   x-switchboard-pickup-key. { action_id, run_id, ok, summary, exit_code?, output?, query_counts?, pass?,
//                  datawrite? }
//                  -> { status }. Any helper kind. An sf_read's or sf_dataop's run keeps no output (O8): a read's rows
//                  went to /sf-result, a data run's receipt is a clip push. An sf_dataquery's keeps only ok, exit_code,
//                  query_counts (one whole number per query) and pass, with Ids scrubbed from its summary; a report that
//                  doesn't fit is refused and closes the run as failed (dataop_link-k7d). An sf_datawrite's keeps only
//                  ok, exit_code, pass and datawrite {stage, query_counts, gate, write, check}, every number checked
//                  against the payload, and the reply carries the line "datawrite <id> done|failed"; any other key,
//                  output included, is refused (dataop_write-j5w).
//                  An sf_run's body adds pass, checks [{check, org, commit?}] and sample?. Its run keeps only ok,
//                  exit_code, pass and checks, never the sample or output; then switchboard_record_run_evidence (251)
//                  for a pass with checks, then switchboard_store_run_sample (250) by the link's request_id, then the
//                  status. A failed write answers 503 {retry: true} naming it and leaves the action consumed; a repeat
//                  records nothing twice. The reply's line is "run <link id> done: PASS|done: FAIL|failed".
//                  sb3_pages-h6v s29: a pretend sf_run's run (mode pretend, 256) is taken like a real one's, and its
//                  lines start "SIMULATION ". The runner only records it, through the same functions, which refuse a
//                  run and request that disagree on pretend (55000).
//                  s4b: the link and request are read first; a data operation's write (sfRunKind) records no evidence
//                  or sample, and drops the request's sample (switchboard_drop_run_sample) at its final status. A
//                  refusal with SQLSTATE P0002, 23514 or 55000 fails the run at once (422, retry: false, the fix named).
//                  s5: a write's body may add write {...}, its outcome: after the run row and before the status,
//                  switchboard_record_run_outcome (254) keeps it on the request, never on the run row. 254's refusals
//                  (22023, P0002, 55000) are noted in the summary; other errors 503 {retry: true}. The 409 pickup
//                  refusal carries project_code.
//   POST /sf-result x-switchboard-pickup-key. { action_id, run_id, ok, summary, level, object, production_full_data, count,
//                  rows, query? } or { ..., ok: false, reason } -> { stored }. An sf_read's rows, before its /result (s89e):
//                  into switchboard_sf_results for at most 10 minutes, plus a switchboard_sf_read_log row. The run is untouched.
//
// The pickup key is SWITCHBOARD_PICKUP_KEY: never logged, never in an error, separate from the queue key.
// ⚠️ verify_jwt must be false in config.toml: /queue has no user token, so the run routes check the JWT themselves.
// After every deploy an unauthenticated POST to /queue must come back 401 with this function's own body.
// ⚠️ THE SERVICE ROLE BYPASSES RLS, so user_id is set explicitly, from CLIPBOARD_USER_ID.

const RUN_LOCK = "switchboard-runner";
const ROLLBACK = Symbol("rollback");
const MAX_ROWS = 200;

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const userClient = (jwt: string) =>
  createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: `Bearer ${jwt}` } } });

/** All or nothing, in one connection. A dry run rolls back; only one run at a time holds the lock. */
async function runSql(statements: Statement[], commit: boolean): Promise<RunOutcome> {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL") ?? "", { prepare: false, max: 1, idle_timeout: 5 });
  const results: StatementResult[] = [];
  let failedAt = 0;
  try {
    await sql.begin(async (tx) => {
      const [{ locked }] = await tx`select pg_try_advisory_xact_lock(hashtextextended(${RUN_LOCK}, 0)) as locked`;
      if (!locked) throw new BusyError();
      await tx.unsafe("set local statement_timeout = '120s'");
      await tx.unsafe("set local lock_timeout = '10s'");
      for (const [i, s] of statements.entries()) {
        failedAt = i + 1;
        // simple: false is the extended protocol, which refuses two commands in one send. So if the splitter ever
        // misread a string, a `commit` hidden in this text fails instead of making a dry run real.
        // postgres.js honours the option in unsafe() but leaves it out of its types, hence the cast.
        const res = await tx.unsafe(s.text, [], { simple: false } as never);
        results.push({ command: res.command ?? "", count: Number(res.count ?? 0), rows: [...res].slice(0, MAX_ROWS) });
      }
      if (!commit) throw ROLLBACK;
    });
    return { ok: true, results };
  } catch (e) {
    if (e === ROLLBACK) return { ok: true, results };
    if (e instanceof BusyError) return { ok: false, busy: true, results: [], error: "another run is in progress." };
    return { ok: false, results: [], failedAt, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

class BusyError extends Error {}

async function conformance(): Promise<string> {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL") ?? "", { prepare: false, max: 1, idle_timeout: 5 });
  try {
    const [{ result }] = await sql`select public.platform_check_conformance() as result`;
    return String(result);
  } catch (e) {
    return `conformance check failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const ACTION_COLUMNS = "id, user_id, kind, payload, fingerprint, headline, status, link_used_at, link_expires_at, project_code";
/** Every switchboard_run_links column but token_hash (250). */
const RUN_LINK_COLUMNS =
  "id, user_id, request_id, request_version, review_id, desktop, used_at, action_id, rerun_at, rerun_action_id, voided_at, void_reason, created_at";

function deps(): Deps {
  const db = createServiceClient();
  const must = <T>(res: { data: T | null; error: { message: string } | null }): T => {
    if (res.error) throw new Error(res.error.message);
    return res.data as T;
  };
  const coded = <T>(res: { data: T | null; error: { message: string; code?: string } | null }): T => {
    if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.code ?? "" });
    return res.data as T;
  };
  const latestDryRun: Deps["latestDryRun"] = async (actionId) =>
    must(await db.from("switchboard_runs").select("id, result").eq("action_id", actionId).eq("mode", "dry_run")
      .order("started_at", { ascending: false }).limit(1).maybeSingle()) as { id: string; result: Record<string, unknown> | null } | null;
  return {
    queueSecret: Deno.env.get("SWITCHBOARD_QUEUE_SECRET") ?? "",
    pickupKey: Deno.env.get("SWITCHBOARD_PICKUP_KEY") ?? "",
    userId: Deno.env.get("CLIPBOARD_USER_ID") ?? "",
    // r4: p_pickup_id (migration 247) only when the helper sent one.
    pickupGit: async (userId, pickupId) =>
      must(await db.rpc("switchboard_pickup_git", { p_user: userId, ...(pickupId ? { p_pickup_id: pickupId } : {}) })) as PickedAction | null,
    // p_kinds only when the helper runs sf_dataop; the default leaves it out (O3).
    pickupHelper: async (userId, kinds, pickupId) =>
      must(await db.rpc("switchboard_pickup_helper", {
        p_user: userId, ...(kinds ? { p_kinds: kinds } : {}), ...(pickupId ? { p_pickup_id: pickupId } : {}),
      })) as PickedAction | null,
    // r4: what the helper still owes, for B's reinstall check. Reads only.
    pendingActions: async (userId) => {
      const unpicked = must(await db.from("switchboard_actions").select("id, kind, project_code, status, link_used_at, created_at")
        .eq("user_id", userId).in("kind", [...HELPER_KINDS]).is("picked_up_at", null)
        .or("status.eq.consumed,and(status.eq.queued,needs_click.is.false)")
        .order("created_at")) as { id: string; kind: string; project_code: string; status: string; link_used_at: string | null; created_at: string }[];
      const pickedRows = must(await db.from("switchboard_actions").select("id, kind, project_code, picked_up_at")
        .eq("user_id", userId).in("kind", [...HELPER_KINDS]).eq("status", "consumed").not("picked_up_at", "is", null)
        .order("picked_up_at")) as { id: string; kind: string; project_code: string; picked_up_at: string }[];
      // s29: a pretend sf_run's open run (mode pretend, 256) counts as one owed too; other kinds' runs are only real.
      const runs = pickedRows.length
        ? must(await db.from("switchboard_runs").select("id, action_id").in("action_id", pickedRows.map((a) => a.id))
          .in("mode", SF_RUN_MODES).is("finished_at", null)) as { id: string; action_id: string }[]
        : [];
      const picked = pickedRows.map((a) => ({ ...a, run_id: runs.find((r) => r.action_id === a.id)?.id ?? null }));
      return { unpicked, picked };
    },
    expiredSince: async (userId, since) => {
      // s6 (M): the run rows 247's and 248's pickups close for an approval never picked up, then their actions.
      const runs = must(await db.from("switchboard_runs").select("action_id").eq("user_id", userId)
        .eq("failure_reason", "expired_not_picked_up").gte("finished_at", since)
        .order("finished_at", { ascending: false }).limit(200)) as { action_id: string }[];
      if (!runs.length) return [];
      const actions = must(await db.from("switchboard_actions").select("id, kind, project_code").eq("user_id", userId)
        .in("id", [...new Set(runs.map((r) => r.action_id))]).in("kind", [...HELPER_KINDS])) as
        { id: string; kind: string; project_code: string }[];
      return actions.map((a) => ({ action_id: a.id, kind: a.kind, project_code: a.project_code }));
    },
    stalePicks: async (userId, before, dataopBefore) => {
      // sf_dataop, sf_dataquery and sf_datawrite (LONG_PICK_KINDS) get 4 hours; every other helper kind 30 minutes.
      const others = HELPER_KINDS.filter((k) => !LONG_PICK_KINDS.includes(k));
      const actions = [
        ...must(await db.from("switchboard_actions").select("id").eq("user_id", userId).in("kind", others)
          .eq("status", "consumed").lt("picked_up_at", before)) as { id: string }[],
        ...must(await db.from("switchboard_actions").select("id").eq("user_id", userId).in("kind", LONG_PICK_KINDS)
          .eq("status", "consumed").lt("picked_up_at", dataopBefore)) as { id: string }[],
      ];
      if (!actions.length) return [];
      // s29: real or pretend, so a timed-out pretend sf_run's run is finished too.
      const runs = must(await db.from("switchboard_runs").select("id, action_id")
        .in("action_id", actions.map((a) => a.id)).in("mode", SF_RUN_MODES).is("finished_at", null)) as { id: string; action_id: string }[];
      return actions.map((a) => ({ action_id: a.id, run_id: runs.find((r) => r.action_id === a.id)?.id ?? null }));
    },
    findPicked: async (actionId, runId) => {
      const action = must(await db.from("switchboard_actions").select("id, user_id, kind, status, picked_up_at, payload")
        .eq("id", actionId).maybeSingle()) as Picked["action"] | null;
      if (!action) return null;
      const run = must(await db.from("switchboard_runs").select("id, action_id, mode, finished_at, result")
        .eq("id", runId).maybeSingle()) as Picked["run"];
      return { action, run };
    },
    finishRun: async (runId, fields) => {
      must(await db.from("switchboard_runs").update(fields).eq("id", runId));
    },
    insertAction: async (row) => must(await db.from("switchboard_actions").insert(row).select("id").single()),
    authUser: async (jwt) => {
      const { data, error } = await db.auth.getUser(jwt);
      return error ? null : data.user?.id ?? null;
    },
    findByLinkHash: async (hash, userId) =>
      must(await db.from("switchboard_actions").select(ACTION_COLUMNS).eq("link_hash", hash).eq("user_id", userId).maybeSingle()) as Action | null,
    hasCleanDryRun: async (actionId) => (await latestDryRun(actionId))?.result?.ok === true,
    latestDryRun,
    noteCancelled: async (runId, result) => {
      must(await db.from("switchboard_runs").update({ result }).eq("id", runId));
    },
    // With Alex's JWT, so that auth.uid() in the function is his.
    consume: async (jwt, token, fingerprint) =>
      must(await userClient(jwt).rpc("switchboard_consume_link", { p_token: token, p_fingerprint: fingerprint })),
    runSql,
    recordRun: async (run) => (must(await db.from("switchboard_runs").insert(run).select("id").single()) as { id: string }).id,
    setStatus: async (id, status) => {
      must(await db.from("switchboard_actions").update({ status }).eq("id", id));
    },
    conformance,
    // s86ac: null until the stakes migration lands (or on any error), so the preview simply has no stakes.
    stakes: async (kind, payload) => {
      const { data, error } = await db.rpc("switchboard_stakes", { p_kind: kind, p_payload: payload });
      return !error && (data === "change" || data === "none") ? data : null;
    },
    // s89e: Salesforce reads. The service role bypasses RLS, so user_id is always the action's own.
    sfReadsEnabled: async (userId) => {
      const row = must(await db.from("switchboard_settings").select("sf_reads_enabled").eq("user_id", userId).maybeSingle()) as
        { sf_reads_enabled: boolean } | null;
      return row?.sf_reads_enabled === true;
    },
    insertSfResult: async (row) => {
      const { error } = await db.from("switchboard_sf_results").insert(row);
      if (error && (error as { code?: string }).code === "23505") return { conflict: true };
      if (error) throw new Error(error.message);
      return { conflict: false };
    },
    logSfRead: async (row) => {
      must(await db.from("switchboard_sf_read_log").insert(row));
    },
    // sb3_runner-r4q s4: an sf_run's link and request (250). Named columns, so token_hash is never read.
    runLink: async (linkId, userId) =>
      must(await db.from("switchboard_run_links").select(RUN_LINK_COLUMNS).eq("id", linkId).eq("user_id", userId)
        .maybeSingle()) as Record<string, unknown> | null,
    runRequest: async (requestId, userId) =>
      must(await db.from("switchboard_run_requests").select("*").eq("id", requestId).eq("user_id", userId)
        .maybeSingle()) as Record<string, unknown> | null,
    // The three rpcs keep the SQLSTATE on the error, so core can tell a refusal (final) from a network error (retried).
    storeRunSample: async (requestId, sample) =>
      coded(await db.rpc("switchboard_store_run_sample", { p_request_id: requestId, p_sample: sample })),
    recordRunEvidence: async (runId) =>
      coded(await db.rpc("switchboard_record_run_evidence", { p_run_id: runId })) as Record<string, unknown>,
    dropRunSample: async (requestId) =>
      Number(coded(await db.rpc("switchboard_drop_run_sample", { p_request_id: requestId })) ?? 0),
    recordRunOutcome: async (runId, outcome) =>
      coded(await db.rpc("switchboard_record_run_outcome", { p_run_id: runId, p_outcome: outcome })) as Record<string, unknown>,
  };
}

Deno.serve(async (req) => {
  try {
    return await handle(req, deps());
  } catch (e) {
    console.error("[switchboard-runner]", e instanceof Error ? e.message : String(e));
    return new Response(JSON.stringify({ ok: false, error: "the runner hit an error; see its logs." }), {
      status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
});
