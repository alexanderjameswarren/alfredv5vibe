// ============================================================================
// supabase/functions/_shared/tools/switchboard.ts
//
// The SQL approval queue, from Claude's side. Spec: docs/technical-spec-switchboard2-h8r.md §8.1.
//
//   get_switchboard_run     tier 1  an action (with its full SQL) and a run
//   issue_switchboard_link  tier 2  issue the approval link for the SQL Claude reviewed
//   get_sql_read            tier 1  one read-only query, as claude_reader (§8.2)
//
// Database access ONLY through ctx.db, except get_sql_read's query itself: see readerSeam.
// ============================================================================

import { defineTool } from "../platform.ts";
import { dbError, fail } from "./claude-notifications.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Named columns: link_hash is a secret column and must never be selected.
const ACTION_COLUMNS = "id, kind, project_code, status, headline, fingerprint, payload, chat_url, needs_click, " +
  "link_expires_at, link_used_at, created_by, created_at, updated_at";
const RUN_COLUMNS = "id, action_id, mode, summary, result, result_pruned_at, started_at, finished_at";
// switchboard_issue_link's own refusals: no user, no such action, not issuable or another link live.
const REFUSALS = new Set(["28000", "P0002", "55000"]);

function requireUuid(tool: string, name: string, v: unknown): string {
  if (typeof v !== "string" || !UUID_RE.test(v.trim())) throw fail(tool, `\`${name}\` must be a UUID.`);
  return v.trim();
}

export const getSwitchboardRunTool = defineTool({
  name: "get_switchboard_run",
  tier: 1,
  tables: { reads: ["switchboard_actions", "switchboard_runs"], writes: [] },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_switchboard_run";
    if ((args.action_id == null) === (args.run_id == null)) throw fail(tool, "pass exactly one of `action_id` or `run_id`.");

    const readAction = async (id: string) => {
      const { data, error } = await ctx.db.from("switchboard_actions").select(ACTION_COLUMNS).eq("id", id).maybeSingle();
      if (error) throw dbError(tool, "reading the action", error);
      if (!data) throw fail(tool, `no such action: ${id}.`);
      return data as unknown as Record<string, unknown>;
    };

    if (args.run_id != null) {
      const id = requireUuid(tool, "run_id", args.run_id);
      const { data: run, error } = await ctx.db.from("switchboard_runs").select(RUN_COLUMNS).eq("id", id).maybeSingle();
      if (error) throw dbError(tool, "reading the run", error);
      if (!run) throw fail(tool, `no such run: ${id}.`);
      return { action: await readAction((run as Record<string, unknown>).action_id as string), run };
    }

    const id = requireUuid(tool, "action_id", args.action_id);
    const action = await readAction(id);
    const { data: run, error } = await ctx.db.from("switchboard_runs").select(RUN_COLUMNS).eq("action_id", id)
      .order("started_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw dbError(tool, "reading the latest run", error);
    return { action, run: run ?? null };
  },
});

export const issueSwitchboardLinkTool = defineTool({
  name: "issue_switchboard_link",
  tier: 2,
  tables: { reads: ["switchboard_actions", "switchboard_settings"], writes: ["switchboard_actions"] },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "issue_switchboard_link";
    const actionId = requireUuid(tool, "action_id", args.action_id);
    if (typeof args.fingerprint !== "string" || !args.fingerprint.trim()) {
      throw fail(tool, "`fingerprint` is required: the fingerprint get_switchboard_run showed for the SQL you reviewed.");
    }
    const { data: action, error: readError } = await ctx.db.from("switchboard_actions").select("fingerprint")
      .eq("id", actionId).maybeSingle();
    if (readError) throw dbError(tool, "reading the action", readError);
    if (!action) throw fail(tool, `no such action: ${actionId}.`);
    if ((action as Record<string, unknown>).fingerprint !== args.fingerprint.trim()) {
      throw fail(tool, "refused: the fingerprint does not match this action. Read it again with get_switchboard_run and review that SQL.");
    }
    const { data, error } = await ctx.db.rpc("switchboard_issue_link", { p_action_id: actionId });
    if (error) {
      if (REFUSALS.has(error.code ?? "")) throw fail(tool, `refused: ${error.message}`);
      throw dbError(tool, "issuing the link", error);
    }
    return data;
  },
});

// ---------------------------------------------------------------------------
// get_sql_read
// ---------------------------------------------------------------------------

const MAX_SQL = 20000;
const MAX_ROWS = 1000;
const BUDGETS = [
  { limit: 20, seconds: 600, words: "10 minutes" },
  { limit: 200, seconds: 86400, words: "day" },
];
const ROLLBACK = Symbol("rollback");

type Tx = { unsafe(text: string, params?: unknown[], options?: unknown): PromiseLike<unknown> & { cursor(size: number): AsyncIterable<unknown[]> } };
type Reader = { begin(fn: (tx: Tx) => Promise<unknown>): Promise<unknown>; end(options?: unknown): Promise<unknown> };

// The one exception to "database access only through ctx.db": the query goes through claude_reader's own login, which
// can reach nothing else, and never through Alex's token. Swappable for the tests, and imported only when used,
// since node can't load npm: specifiers.
export const readerSeam = {
  url: (): string => (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get("SWITCHBOARD_READER_DB_URL") ?? "",
  connect: async (url: string): Promise<Reader> => {
    const { default: postgres } = await import("npm:postgres@3.4.5");
    return postgres(url, { prepare: false, max: 1, idle_timeout: 5, connect_timeout: 10 }) as unknown as Reader;
  },
};

/** An error's words for Claude and the log: a driver's error can quote the address it was given. */
const cleanError = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/postgres(ql)?:\/\/\S+/gi, "[connection string]");

// --- The plan guard: only public and pg_catalog, read from what Postgres says it would do. ---

const READABLE_SCHEMAS = new Set(["public", "pg_catalog"]);
// pg_catalog functions that take a query or a table by name, so the plan can't see what they read.
const RUNS_TEXT = /\b(query_to_xml|query_to_xmlschema|query_to_xml_and_xmlschema|cursor_to_xml|cursor_to_xmlschema|table_to_xml|table_to_xmlschema|table_to_xml_and_xmlschema|schema_to_xml|schema_to_xmlschema|schema_to_xml_and_xmlschema|database_to_xml|database_to_xmlschema|database_to_xml_and_xmlschema|ts_stat|ts_rewrite)\s*\(/gi;
const NAME_IN_PLAN = String.raw`("[^"]+"|[A-Za-z_][\w$]*)`;
const QUALIFIED_CALL = new RegExp(String.raw`${NAME_IN_PLAN}\.${NAME_IN_PLAN}\s*\(`, "g");
const QUALIFIED_CAST = new RegExp(String.raw`::${NAME_IN_PLAN}\.${NAME_IN_PLAN}`, "g");
const NOT_EXPRESSIONS = new Set(["Schema", "Alias", "Relation Name", "Node Type"]);

const stripStrings = (s: string) => s.replace(/'(?:[^']|'')*'/g, "''").replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, "''");

/** What in an EXPLAIN (VERBOSE, FORMAT JSON) plan reaches outside the readable schemas. [] when nothing does. */
export function planProblems(plan: unknown): string[] {
  const found = new Set<string>();
  const readExpression = (text: string) => {
    const bare = stripStrings(text);
    for (const re of [QUALIFIED_CALL, QUALIFIED_CAST]) {
      for (const m of bare.matchAll(re)) {
        const schema = m[1].replace(/"/g, "");
        if (!READABLE_SCHEMAS.has(schema)) found.add(`${schema}.${m[2].replace(/"/g, "")}`);
      }
    }
    for (const m of bare.matchAll(RUNS_TEXT)) found.add(m[1].toLowerCase());
  };
  const walk = (v: unknown, key = "") => {
    if (typeof v === "string") {
      if (key === "Schema" && !READABLE_SCHEMAS.has(v)) found.add(v);
      if (!NOT_EXPRESSIONS.has(key)) readExpression(key === "Function Name" ? `${v}()` : v);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, key);
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  walk(plan);
  return [...found];
}

const outsideReadable = (what: string) =>
  new Error(`refused: this query reaches outside public and pg_catalog (${what}). get_sql_read reads only public and pg_catalog.`);

/** One statement, read only, limited, always rolled back. The extended protocol refuses a second statement. */
async function runReadOnly(text: string) {
  const out = { rows: [] as unknown[], truncated: false, error: null as string | null };
  const url = readerSeam.url();
  if (!url) return { ...out, error: "SWITCHBOARD_READER_DB_URL is not set." };
  let sql: Reader | null = null;
  try {
    sql = await readerSeam.connect(url);
    await sql.begin(async (tx) => {
      await tx.unsafe("set transaction read only");
      await tx.unsafe("set local statement_timeout = '10s'");
      await tx.unsafe("set local lock_timeout = '1s'");
      // information_schema's views expand to pg_catalog tables, so its name is only ever in the query's own text.
      if (/\binformation_schema\b/i.test(stripStrings(text))) throw outsideReadable("information_schema");
      const answer = await tx.unsafe(`explain (verbose, format json) ${text}`, [], { simple: false }) as Record<string, unknown>[];
      const raw = answer[0]?.["QUERY PLAN"];
      const plan = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!plan) throw new Error("refused: the query's plan could not be read.");
      const problems = planProblems(plan);
      if (problems.length) throw outsideReadable(problems.join(", "));
      for await (const batch of tx.unsafe(text, [], { simple: false }).cursor(MAX_ROWS + 1)) {
        out.truncated = batch.length > MAX_ROWS;
        out.rows = batch.slice(0, MAX_ROWS);
        break;
      }
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) {
      out.rows = [];
      out.truncated = false;
      out.error = cleanError(e);
    }
  } finally {
    try { await sql?.end({ timeout: 2 }); } catch { /* the answer is already in hand */ }
  }
  return out;
}

export const getSqlReadTool = defineTool({
  name: "get_sql_read",
  tier: 1,
  tables: { reads: ["*", "switchboard_settings", "switchboard_read_log"], writes: ["switchboard_read_log"] },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_sql_read";
    const given = typeof args.sql === "string" ? args.sql : String(args.sql ?? "");
    const log = async (row: { ok: boolean; row_count: number | null; truncated: boolean; error: string | null; took_ms: number }) => {
      const { error } = await ctx.db.from("switchboard_read_log").insert({ query_text: given.slice(0, MAX_SQL), ...row });
      return error ? error.message ?? "the log write failed" : null;
    };
    const refuse = async (error: Error) => {
      await log({ ok: false, row_count: null, truncated: false, error: error.message, took_ms: 0 });
      return error;
    };

    if (typeof args.sql !== "string" || !args.sql.trim() || args.sql.length > MAX_SQL) {
      throw await refuse(fail(tool, `\`sql\` must be one statement of at most ${MAX_SQL} characters.`));
    }

    // Both checks fail closed: a guard that can't be read stops the query.
    const { data: settings, error: settingsError } = await ctx.db.from("switchboard_settings").select("reads_enabled").maybeSingle();
    if (settingsError) throw await refuse(dbError(tool, "reading the kill switch", settingsError));
    if (!settings) throw await refuse(fail(tool, "refused: no settings row, so the kill switch can't be read."));
    if (!(settings as { reads_enabled: boolean }).reads_enabled) {
      throw await refuse(fail(tool, "refused: read-only queries are switched off (switchboard_settings.reads_enabled)."));
    }

    // Counted from the log, refused calls included. platform_check_call_budget counts every tool's calls, not these,
    // and it adds to the budget defineTool already spends on this call.
    for (const b of BUDGETS) {
      const since = new Date(Date.now() - b.seconds * 1000).toISOString();
      const { count, error } = await ctx.db.from("switchboard_read_log").select("id", { count: "exact", head: true }).gte("created_at", since);
      if (error) throw await refuse(dbError(tool, "reading the read budget", error));
      if ((count ?? 0) >= b.limit) {
        throw await refuse(fail(tool, `READ BUDGET EXCEEDED: ${count} calls in the last ${b.words} (limit ${b.limit}). Do NOT retry. Stop and report to the user.`));
      }
    }

    const started = Date.now();
    const { rows, truncated, error } = await runReadOnly(args.sql);
    const logError = await log({
      ok: error === null, row_count: error === null ? rows.length : null, truncated, error, took_ms: Date.now() - started,
    });
    return { ok: error === null, rows, count: rows.length, truncated, error, ...(logError ? { log_error: logError } : {}) };
  },
});
