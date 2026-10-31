// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createClient } from "jsr:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";
import { createServiceClient } from "../_shared/alfred-tools/supabase-client.ts";
import { type Action, type Deps, handle, type RunOutcome, type Statement, type StatementResult } from "./core.ts";

// switchboard-runner: the only code that executes queued SQL, and the only code using SUPABASE_DB_URL.
// Spec: docs/technical-spec-switchboard2-h8r.md 8.1. Routes and refusals are in core.ts.
//
// 🛑 A SERVER-TO-SERVER EXCEPTION, LIKE clip-capture. Not an MCP tool: no defineTool, no ctx.db.
//
//   POST /queue    x-switchboard-queue-secret. { project_code, sql } -> { ok, action_id, headline }
//   POST /preview  Alex's JWT. { token } -> { headline, sql, fingerprint, ... }. Runs nothing.
//   POST /dry-run  Alex's JWT. { token } -> { run_id, summary }. Rolled back; the link is not spent.
//   POST /approve  Alex's JWT. { token, fingerprint } -> { run_id, summary, conformance }. Needs a clean dry run.
//
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

const ACTION_COLUMNS = "id, user_id, payload, fingerprint, headline, status, link_used_at, link_expires_at, project_code";

function deps(): Deps {
  const db = createServiceClient();
  const must = <T>(res: { data: T | null; error: { message: string } | null }): T => {
    if (res.error) throw new Error(res.error.message);
    return res.data as T;
  };
  return {
    queueSecret: Deno.env.get("SWITCHBOARD_QUEUE_SECRET") ?? "",
    userId: Deno.env.get("CLIPBOARD_USER_ID") ?? "",
    insertAction: async (row) => must(await db.from("switchboard_actions").insert(row).select("id").single()),
    authUser: async (jwt) => {
      const { data, error } = await db.auth.getUser(jwt);
      return error ? null : data.user?.id ?? null;
    },
    findByLinkHash: async (hash, userId) =>
      must(await db.from("switchboard_actions").select(ACTION_COLUMNS).eq("link_hash", hash).eq("user_id", userId).maybeSingle()) as Action | null,
    hasCleanDryRun: async (actionId) => {
      const rows = must(await db.from("switchboard_runs").select("id").eq("action_id", actionId).eq("mode", "dry_run")
        .eq("result->>ok", "true").limit(1)) as unknown[];
      return rows.length > 0;
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
