// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createClient } from "jsr:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";
import { createServiceClient } from "../_shared/alfred-tools/supabase-client.ts";
import {
  type Action, type Deps, handle, HELPER_KINDS, type Picked, type PickedAction, type RunOutcome, type Statement, type StatementResult,
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
//   A git, sf_check (s86pa) or sb_setup link (spec 11.3-11.5): /preview adds kind and payload; /approve only spends
//   the link, so the action is consumed for the helper, and runs nothing here; /cancel needs no dry run; /dry-run is refused.
//   POST /pickup   x-switchboard-pickup-key. { kinds? } -> { action (with kind) | null, timed_out }. The desktop helper.
//                  No kinds: git only, by switchboard_pickup_git. All of git, sf_check, sb_setup: switchboard_pickup_helper.
//   POST /result   x-switchboard-pickup-key. { action_id, run_id, ok, summary, exit_code?, output? } -> { status }. Any helper kind.
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

function deps(): Deps {
  const db = createServiceClient();
  const must = <T>(res: { data: T | null; error: { message: string } | null }): T => {
    if (res.error) throw new Error(res.error.message);
    return res.data as T;
  };
  const latestDryRun: Deps["latestDryRun"] = async (actionId) =>
    must(await db.from("switchboard_runs").select("id, result").eq("action_id", actionId).eq("mode", "dry_run")
      .order("started_at", { ascending: false }).limit(1).maybeSingle()) as { id: string; result: Record<string, unknown> | null } | null;
  return {
    queueSecret: Deno.env.get("SWITCHBOARD_QUEUE_SECRET") ?? "",
    pickupKey: Deno.env.get("SWITCHBOARD_PICKUP_KEY") ?? "",
    userId: Deno.env.get("CLIPBOARD_USER_ID") ?? "",
    pickupGit: async (userId) => must(await db.rpc("switchboard_pickup_git", { p_user: userId })) as PickedAction | null,
    pickupHelper: async (userId) => must(await db.rpc("switchboard_pickup_helper", { p_user: userId })) as PickedAction | null,
    stalePicks: async (userId, before) => {
      const actions = must(await db.from("switchboard_actions").select("id").eq("user_id", userId).in("kind", [...HELPER_KINDS])
        .eq("status", "consumed").lt("picked_up_at", before)) as { id: string }[];
      if (!actions.length) return [];
      const runs = must(await db.from("switchboard_runs").select("id, action_id")
        .in("action_id", actions.map((a) => a.id)).eq("mode", "real").is("finished_at", null)) as { id: string; action_id: string }[];
      return actions.map((a) => ({ action_id: a.id, run_id: runs.find((r) => r.action_id === a.id)?.id ?? null }));
    },
    findPicked: async (actionId, runId) => {
      const action = must(await db.from("switchboard_actions").select("id, user_id, kind, status, picked_up_at")
        .eq("id", actionId).maybeSingle()) as Picked["action"] | null;
      if (!action) return null;
      const run = must(await db.from("switchboard_runs").select("id, action_id, mode, finished_at")
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
