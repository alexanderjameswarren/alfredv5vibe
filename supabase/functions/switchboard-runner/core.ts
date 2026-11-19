// switchboard-runner's logic, free of Deno and the database so `node --test` can run it. index.ts supplies `Deps`.
// Spec: docs/technical-spec-switchboard2-h8r.md 8.1, and 11 for the helper's pickup and result.

import { createHash, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

export const MAX_SQL_CHARS = 512 * 1024;
const MAX_DESCRIPTION = 300;
const MIN_SECRET = 32;
const PROJECT_CODE = /^[a-z0-9_-]{1,40}$/;

export type Statement = { text: string; bare: string };
export type Expected = number | "unknown";
export type Count = { statement: number; action: string; count: number; expected?: Expected; differs: boolean };
export type StatementResult = { command: string; count: number; rows?: unknown[] };
export type RunOutcome = {
  ok: boolean;
  results: StatementResult[];
  error?: string;
  failedAt?: number;
  busy?: boolean;
};
export type Action = {
  id: string;
  user_id: string;
  /** sql, or git (spec 11.3); a row read before kind was selected counts as sql. */
  kind?: string;
  payload: { sql?: string; description?: string; expected?: Expected[]; test?: boolean; [key: string]: unknown };
  fingerprint: string;
  headline: string;
  status: string;
  link_used_at: string | null;
  link_expires_at: string | null;
  project_code: string;
};
export type PickedAction = {
  action_id: string; run_id: string; kind?: string; project_code: string; payload: Record<string, unknown>;
  fingerprint: string; headline: string; chat_url: string | null;
};
/**
 * The kinds the desktop helper runs (spec 10, 11.3-11.6). sf_read since s89e; sf_dataop since dataops_alfred-d4x;
 * sf_dataquery since dataop_link-k7d.
 */
export const HELPER_KINDS = ["git", "sf_check", "sb_setup", "sf_read", "sf_dataop", "sf_dataquery"] as const;
/** What a helper from dataops_alfred-d4x asks for; still handed an sf_dataop, never an sf_dataquery (dataop_link-k7d). */
const D4X_HELPER_KINDS = ["git", "sf_check", "sb_setup", "sf_read", "sf_dataop"];
/** The kinds whose picks get the 4-hour limit: a data run's batch and waits, or a large export, take that long. */
export const LONG_PICK_KINDS = ["sf_dataop", "sf_dataquery"];
/** What a helper from before dataops_alfred-d4x asks for; still served, and never handed an sf_dataop (O3). */
const S89_HELPER_KINDS = ["git", "sf_check", "sb_setup", "sf_read"];
/** What a helper from before s89c asks for; still served, so an older install keeps picking up. */
const OLDER_HELPER_KINDS = ["git", "sf_check", "sb_setup"];
export type Picked = {
  action: { id: string; user_id: string; kind: string; status: string; picked_up_at: string | null; payload?: Record<string, unknown> | null };
  run: { id: string; action_id: string; mode: string; finished_at: string | null } | null;
};
export type Deps = {
  queueSecret: string;
  /** The desktop helper's key, SWITCHBOARD_PICKUP_KEY. Separate from the queue key. */
  pickupKey: string;
  userId: string;
  /** switchboard_pickup_git, with the service role: git only, for a helper that asks for no other kind. */
  pickupGit(userId: string): Promise<PickedAction | null>;
  /**
   * switchboard_pickup_helper, with the service role. `kinds` is passed only for a helper that runs sf_dataop; without
   * it the function serves today's four and never hands one out (O3).
   */
  pickupHelper(userId: string, kinds?: string[]): Promise<PickedAction | null>;
  /**
   * Helper-kind actions still consumed with their open real run if any: picked before `before`, or for a
   * LONG_PICK_KINDS action (an sf_dataop or sf_dataquery, which may take hours) before `dataopBefore`.
   */
  stalePicks(userId: string, before: string, dataopBefore: string): Promise<{ action_id: string; run_id: string | null }[]>;
  findPicked(actionId: string, runId: string): Promise<Picked | null>;
  finishRun(runId: string, fields: Record<string, unknown>): Promise<void>;
  insertAction(row: Record<string, unknown>): Promise<{ id: string }>;
  authUser(jwt: string): Promise<string | null>;
  findByLinkHash(hash: string, userId: string): Promise<Action | null>;
  /** Whether the action's latest dry run was clean. */
  hasCleanDryRun(actionId: string): Promise<boolean>;
  latestDryRun(actionId: string): Promise<{ id: string; result: Record<string, unknown> | null } | null>;
  noteCancelled(runId: string, result: Record<string, unknown>): Promise<void>;
  consume(jwt: string, token: string, fingerprint: string): Promise<unknown>;
  runSql(statements: Statement[], commit: boolean): Promise<RunOutcome>;
  recordRun(run: Record<string, unknown>): Promise<string>;
  setStatus(id: string, status: string): Promise<void>;
  conformance(): Promise<string>;
  /** switchboard_stakes (s86ac): change or none; null when the function is missing or fails. */
  stakes(kind: string, payload: Record<string, unknown>): Promise<"change" | "none" | null>;
  /** switchboard_settings.sf_reads_enabled for the user; false when there is no row (s89e). */
  sfReadsEnabled(userId: string): Promise<boolean>;
  /** One switchboard_sf_results row; conflict true when the action already has one. */
  insertSfResult(row: Record<string, unknown>): Promise<{ conflict: boolean }>;
  /** One switchboard_sf_read_log row. Never rows. */
  logSfRead(row: Record<string, unknown>): Promise<void>;
};

/** The preview's stakes field, or nothing. A runner deployed before the migration never fails a preview on it. */
async function stakesOf(action: Action, deps: Deps): Promise<{ stakes?: "change" | "none" }> {
  try {
    const stakes = await deps.stakes(action.kind ?? "sql", action.payload ?? {});
    return stakes === "change" || stakes === "none" ? { stakes } : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// statements
// ---------------------------------------------------------------------------

/**
 * Split on top-level `;`. `text` is the statement as written, `bare` has comments gone and strings and dollar bodies
 * emptied, so that classifying a statement never reads the words inside a string.
 */
export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = [];
  let text = "";
  let bare = "";
  const flush = () => {
    if (bare.trim()) out.push({ text: text.trim(), bare: bare.trim().replace(/\s+/g, " ") });
    text = "";
    bare = "";
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) (depth++, i += 2);
        else if (sql.startsWith("*/", i)) (depth--, i += 2);
        else i++;
      }
      bare += " ";
    } else if (c === "'") {
      const escapes = /(^|[^\w$])[eE]$/.test(sql.slice(Math.max(0, i - 2), i));
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === "\\") j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      text += sql.slice(i, j + 1);
      bare += "''";
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1;
      text += sql.slice(i, j + 1);
      bare += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === "$" && !/[\w$]/.test(sql[i - 1] ?? "")) {
      const tag = /^\$[A-Za-z_]?\w*\$/.exec(sql.slice(i, i + 80))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end < 0 ? sql.length : end + tag.length;
        text += sql.slice(i, stop);
        bare += "$$$$";
        i = stop;
      } else {
        text += c;
        bare += c;
        i++;
      }
    } else if (c === ";") {
      flush();
      i++;
    } else {
      text += c;
      bare += c;
      i++;
    }
  }
  flush();
  return out;
}

const NAME = String.raw`((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)`;
const IF_EXISTS = String.raw`(?:if (?:not )?exists )?`;
const shortName = (n: string) => n.replace(/"/g, "").replace(/^public\./i, "");
const ACTIONS: [RegExp, (name: string) => string][] = [
  [new RegExp(`^delete from (?:only )?${NAME}`, "i"), (n) => `deletes rows from ${n}`],
  [new RegExp(`^update (?:only )?${NAME}`, "i"), (n) => `updates rows in ${n}`],
  [new RegExp(`^insert into ${NAME}`, "i"), (n) => `inserts rows into ${n}`],
  [new RegExp(`^truncate (?:table )?(?:only )?${NAME}`, "i"), (n) => `empties table ${n}`],
  [new RegExp(`^create (?:unlogged |temp |temporary )?table ${IF_EXISTS}${NAME}`, "i"), (n) => `creates table ${n}`],
  [new RegExp(`^alter table ${IF_EXISTS}(?:only )?${NAME}`, "i"), (n) => `alters table ${n}`],
  [new RegExp(`^drop table ${IF_EXISTS}${NAME}`, "i"), (n) => `drops table ${n}`],
  [new RegExp(`^create (?:or replace )?function ${NAME}`, "i"), (n) => `creates function ${n}`],
  [new RegExp(`^drop function ${IF_EXISTS}${NAME}`, "i"), (n) => `drops function ${n}`],
  [new RegExp(`^create (?:or replace )?view ${NAME}`, "i"), (n) => `creates view ${n}`],
  [new RegExp(`^drop view ${IF_EXISTS}${NAME}`, "i"), (n) => `drops view ${n}`],
];
const READ_ONLY = /^(select|show|explain|values|table)\b/i;
// Words that take a bracket but call nothing, then built-ins that only compute. Any other call may write, and so
// does any schema-qualified one, since a qualified name can be Alfred's own function with a built-in's name.
const NOT_A_WRITING_CALL = new Set(`
  all and any as array between by case cast date decimal distinct else except exists explain filter from group having
  ilike in intersect interval is join lateral like limit not numeric offset on or order over partition row select
  table then time timestamp timestamptz union using values varchar char when where with within
  abs age array_agg array_length avg bool_and bool_or btrim ceil ceiling char_length coalesce concat concat_ws count
  current_timestamp date_part date_trunc dense_rank extract first_value floor format generate_series greatest json_agg
  json_build_array json_build_object json_object_agg jsonb_agg jsonb_array_elements jsonb_array_elements_text
  jsonb_array_length jsonb_build_array jsonb_build_object jsonb_each jsonb_object_agg jsonb_typeof lag last_value lead
  least left length lower ltrim max min mod now nullif position rank replace right round row_number row_to_json rtrim
  split_part string_agg substr substring sum to_char to_date to_json to_jsonb to_timestamp trim unnest upper
`.trim().split(/\s+/));
const CALL = /("[^"]+"|[\w$]+)(\s*\.\s*(?:"[^"]+"|[\w$]+))?\s*\(/g;

/** Why a statement that starts like a read could still change something, or null. Reads only `bare`, so never a string. */
function mayWrite(bare: string): string | null {
  if (/^explain\b/i.test(bare) && /^explain\s*(\([^)]*\b(analyze|analyse)\b[^)]*\)|(verbose\s+)?(analyze|analyse)\b)/i.test(bare)) return "explain analyze";
  if (/^select\b/i.test(bare) && /\binto\b/i.test(bare)) return "select into";
  if (/\bfor (no key )?update\b|\bfor (key )?share\b/i.test(bare)) return "locks rows";
  for (const [, name, schema] of bare.matchAll(CALL)) {
    if (schema || !NOT_A_WRITING_CALL.has(name.toLowerCase())) return `calls function ${name}${(schema ?? "").replace(/\s/g, "")}`;
  }
  return null;
}

function describe(s: Statement): string {
  for (const [re, phrase] of ACTIONS) {
    const m = re.exec(s.bare);
    if (m) return phrase(shortName(m[1]));
  }
  if (READ_ONLY.test(s.bare)) return mayWrite(s.bare) ?? "runs a select";
  if (/^do\b/i.test(s.bare)) return "runs a do block";
  return `runs ${(/^\S+(?: \S+)?/.exec(s.bare)?.[0] ?? "a statement").toLowerCase()}`;
}

/** The capitals line on the click page, from the statements alone. */
export function buildHeadline(sql: string, test = false): string {
  const statements = prepare(sql).statements;
  const phrases = [...new Set(statements.map(describe))].filter((p) => p !== "runs a select");
  if (statements.length && !phrases.length && !test) return "THIS RUNS A SELECT ON THE LIVE ALFRED DATABASE";
  const shown = phrases.slice(0, 4).join(", ");
  const more = phrases.length > 4 ? ` AND ${phrases.length - 4} MORE` : "";
  if (test) return `THIS TEST RUNS ONCE AND IS UNDONE: ${(shown || "runs a select").toUpperCase()}${more}`;
  const lead = statements.length && statements.every((s) => READ_ONLY.test(s.bare))
    ? "THIS MAY CHANGE DATA IN THE LIVE ALFRED DATABASE"
    : "THIS CHANGES THE LIVE ALFRED DATABASE";
  return `${lead}: ${shown.toUpperCase()}${more}`;
}

const NOT_IN_TRANSACTION: RegExp[] = [
  /^create (unique )?index concurrently\b/i,
  /^drop index concurrently\b/i,
  /^reindex\b.*\bconcurrently\b/i,
  /^vacuum\b/i,
  /^alter system\b/i,
  /^(create|drop) (database|tablespace)\b/i,
];
const CREATE_INDEX = new RegExp(`^create (?:unique )?index (?:if not exists )?(?:\\S+ )?on (?:only )?${NAME}`, "i");
const CREATE_TABLE = new RegExp(`^create (?:unlogged )?table ${IF_EXISTS}${NAME}`, "i");

function slow(s: Statement, created: Set<string>): boolean {
  const b = s.bare;
  const index = CREATE_INDEX.exec(b);
  if (index) return !created.has(shortName(index[1]).toLowerCase());
  if (/^(update|delete)\b/i.test(b) && !/\bwhere\b/i.test(b)) return true;
  if (/^alter table\b/i.test(b) && /\b(type|set tablespace|set logged|set unlogged)\b/i.test(b)) return true;
  return /^(reindex|cluster)\b/i.test(b);
}

/** Why these statements belong in the SQL editor, or []. Works on any list, with or without a wrapper. */
function statementReasons(statements: Statement[]): string[] {
  const reasons: string[] = [];
  const created = new Set<string>();
  for (const s of statements) {
    const made = CREATE_TABLE.exec(s.bare);
    if (made) created.add(shortName(made[1]).toLowerCase());
    if (NOT_IN_TRANSACTION.some((re) => re.test(s.bare))) reasons.push(`cannot run in a transaction: ${s.bare.slice(0, 80)}`);
    else if (slow(s, created)) reasons.push(`may exceed the time limit: ${s.bare.slice(0, 80)}`);
  }
  return reasons;
}

const BEGIN = /^(begin|start transaction)\b/i;
const END = /^(commit|end)\b/i;
const CONTROL = /^(begin|start transaction|commit|end|rollback|abort|savepoint|release|prepare transaction)\b/i;

/**
 * The statements the runner may run, and why not. A script's own outer `begin; ... commit;` is dropped: the runner
 * holds the transaction, and a `commit` left in would make a dry run real. Any other transaction control is refused.
 */
export function prepare(sql: string): { statements: Statement[]; reasons: string[] } {
  const all = splitStatements(sql);
  if (!all.length) return { statements: [], reasons: ["there is no statement to run"] };
  const refused = { statements: all, reasons: ["it controls its own transaction, so the runner cannot wrap it"] };
  let statements = all;
  if (BEGIN.test(all[0].bare)) {
    const ends = all.flatMap((s, i) => (END.test(s.bare) ? [i] : []));
    if (ends.length !== 1) return refused;
    statements = all.filter((_, i) => i !== 0 && i !== ends[0]);
  }
  if (statements.some((s) => CONTROL.test(s.bare))) return refused;
  return { statements, reasons: statementReasons(statements) };
}

export const editorReasons = (sql: string): string[] => prepare(sql).reasons;

/** One plain line: "deletes 3 rows from wb_rules; creates table t". */
export function summarise(statements: Statement[], results: StatementResult[]): string {
  return statements
    .map((s, i) => {
      const phrase = describe(s);
      const count = results[i]?.count;
      if (!/ rows /.test(phrase) || count === undefined) return phrase;
      return phrase.replace("rows", `${count} ${count === 1 ? "row" : "rows"}`);
    })
    .filter((p) => p !== "runs a select" || statements.length === 1)
    .join("; ");
}

// A do block or a function call changes rows Postgres doesn't count for it, so only these have a number to compare.
const COUNTED = /^(insert|update|delete|merge)\b|^with\b.*\b(insert|update|delete|merge)\b/i;
const counted = (statements: Statement[]) => statements.filter((s) => COUNTED.test(s.bare));

const validExpected = (expected: unknown, wanted: number): expected is Expected[] =>
  Array.isArray(expected) && expected.length === wanted &&
  expected.every((e) => e === "unknown" || (Number.isInteger(e) && e >= 0));

/** Rows per counted statement, against what the CLI expected. An action queued before expected counts has none. */
export function countsFor(statements: Statement[], results: StatementResult[], expected?: Expected[]): Count[] {
  if (!results.length) return [];
  let at = 0;
  return statements.flatMap((s, i) => {
    if (!COUNTED.test(s.bare)) return [];
    const want = expected?.[at++];
    const count = results[i]?.count ?? 0;
    return [{ statement: i + 1, action: describe(s), count, ...(want === undefined ? {} : { expected: want }), differs: typeof want === "number" && want !== count }];
  });
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const RUN_ROUTES = new Set(["preview", "dry-run", "approve", "cancel"]);
const MAX_REASON = 200;

function json(body: unknown, status = 200, browser = false): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(browser ? CORS : {}) },
  });
}

/** Constant-time comparison; the length pre-check stops timingSafeEqual's throw from leaking the length. */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided || expected.length < MIN_SECRET) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

async function handleQueue(req: Request, deps: Deps): Promise<Response> {
  if (!secretMatches(req.headers.get("x-switchboard-queue-secret"), deps.queueSecret)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  const body = await readBody(req);
  const code = body?.project_code;
  const sql = body?.sql;
  if (typeof code !== "string" || !PROJECT_CODE.test(code)) return json({ ok: false, error: "project_code is missing or malformed." }, 400);
  if (typeof sql !== "string" || !sql.trim()) return json({ ok: false, error: "sql is missing." }, 400);
  if (sql.length > MAX_SQL_CHARS) return json({ ok: false, error: `sql is over ${MAX_SQL_CHARS} characters.` }, 400);
  const description = typeof body?.description === "string" ? body.description.trim() : "";
  if (!description || description.length > MAX_DESCRIPTION || /[\r\n]/.test(description)) {
    return json({ ok: false, error: `description must be one line of at most ${MAX_DESCRIPTION} characters, saying what the SQL does.` }, 400);
  }
  const { statements, reasons } = prepare(sql);
  if (reasons.length) return json({ ok: false, error: "this goes to the SQL editor, not the queue.", reasons }, 422);

  const test = body?.test === true;
  const expected = body?.expected;
  if (test && expected !== undefined) return json({ ok: false, error: "a test action is undone, so it takes no --expect." }, 400);
  const writes = counted(statements);
  if (!test && (writes.length || expected !== undefined) && !validExpected(expected, writes.length)) {
    return json({
      ok: false,
      error: `--expect needs ${writes.length} comma-separated values, one for each insert, update and delete in order: a row count, or "unknown" if it can't be known.`,
      reasons: writes.map(describe),
    }, 422);
  }

  // Only these fields reach the row. The kind, owner and headline are never the caller's.
  const headline = buildHeadline(sql, test);
  const payload = { sql, description, ...(test ? { test } : {}), ...(!test && writes.length ? { expected } : {}) };
  const row = await deps.insertAction({
    user_id: deps.userId, kind: "sql", project_code: code, payload, headline, created_by: "cli",
  });
  return json({ ok: true, action_id: row.id, headline });
}

async function handleRun(route: string, req: Request, deps: Deps): Promise<Response> {
  const reply = (body: unknown, status = 200) => json(body, status, true);
  const jwt = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  const user = jwt ? await deps.authUser(jwt) : null;
  if (!user || user !== deps.userId) return reply({ ok: false, error: "unauthorized" }, 401);

  const body = await readBody(req);
  const token = body?.token;
  if (typeof token !== "string" || !token) return reply({ ok: false, error: "token is missing." }, 400);
  const hash = createHash("sha256").update(token).digest("hex");
  const action = await deps.findByLinkHash(hash, user);
  if (!action) return reply({ ok: false, error: "no such link." }, 404);
  if (action.link_used_at) return reply({ ok: false, error: "this link has already been used." }, 410);
  if (!action.link_expires_at || Date.parse(action.link_expires_at) <= Date.now()) {
    return reply({ ok: false, error: "this link has expired." }, 410);
  }
  if (isHelperKind(action.kind)) return handleHelperRun(route, body, action, jwt, token, deps, reply);
  if (action.kind && action.kind !== "sql") return reply({ ok: false, error: `a ${action.kind} action has no link here yet.` }, 409);

  const sql = action.payload?.sql ?? "";
  const test = action.payload?.test === true;

  if (route === "preview") {
    return reply({
      ok: true, action_id: action.id, headline: action.headline, description: action.payload?.description ?? null, sql, fingerprint: action.fingerprint,
      project_code: action.project_code, expires_at: action.link_expires_at, test, ...(await stakesOf(action, deps)),
    });
  }

  const spend = async (fingerprint: string): Promise<Response | null> => {
    try {
      await deps.consume(jwt, token, fingerprint);
      return null;
    } catch (e) {
      return reply({ ok: false, error: e instanceof Error ? e.message : String(e) }, 409);
    }
  };

  if (route === "cancel") {
    const reason = typeof body?.reason === "string" ? body.reason.replace(/\s+/g, " ").trim() : "";
    if (reason.length > MAX_REASON) return reply({ ok: false, error: `the reason is over ${MAX_REASON} characters.` }, 400);
    const dry = await deps.latestDryRun(action.id);
    if (!dry) return reply({ ok: false, error: "run a dry run first." }, 409);
    const refused = await spend(action.fingerprint);
    if (refused) return refused;
    await deps.setStatus(action.id, "cancelled");
    await deps.noteCancelled(dry.id, { ...dry.result, cancelled: true, reason });
    return reply({ ok: true, run_id: dry.id, cancelled: true, reason });
  }

  if (route === "approve" && test) return reply({ ok: false, error: "a test action only runs undone." }, 409);

  const { statements, reasons } = prepare(sql);
  if (reasons.length) return reply({ ok: false, error: "this goes to the SQL editor.", reasons }, 422);

  const commit = route === "approve";
  if (commit) {
    const fingerprint = body?.fingerprint;
    if (typeof fingerprint !== "string" || !fingerprint) return reply({ ok: false, error: "fingerprint is missing." }, 400);
    if (!(await deps.hasCleanDryRun(action.id))) return reply({ ok: false, error: "run a clean dry run first." }, 409);
    const refused = await spend(fingerprint);
    if (refused) return refused;
  }

  const startedAt = new Date().toISOString();
  const outcome = await deps.runSql(statements, commit);
  if (outcome.busy && !commit) return reply({ ok: false, error: outcome.error }, 409);
  // After the run, so a busy runner leaves the link usable. The run is undone, so a lost race has changed nothing.
  if (test) {
    const refused = await spend(action.fingerprint);
    if (refused) return refused;
  }

  const counts = countsFor(statements, outcome.results, action.payload?.expected);
  const mismatch = counts.some((c) => c.differs);
  // A real run has committed by now, so a mismatch there is reported and doesn't turn it into a failure.
  const ok = outcome.ok && (commit || !mismatch);
  const summary = outcome.ok
    ? summarise(statements, outcome.results) + (mismatch ? ". Counts differ from what was expected." : "")
    : `failed at statement ${outcome.failedAt ?? "?"}: ${outcome.error}`;
  const conformance = commit && outcome.ok ? await deps.conformance() : undefined;
  const runId = await deps.recordRun({
    user_id: action.user_id, action_id: action.id, mode: commit ? "real" : "dry_run", summary,
    result: { ok, statements: outcome.results, counts, mismatch, error: outcome.error, failed_at: outcome.failedAt, conformance },
    started_at: startedAt, finished_at: new Date().toISOString(),
  });
  if (commit || test) await deps.setStatus(action.id, outcome.ok ? "succeeded" : "failed");
  return reply({ ok, run_id: runId, summary, conformance, counts, mismatch, ...(test ? { test } : {}) });
}

/**
 * A git, sf_check (s86pa), sb_setup, sf_read or sf_dataop link (spec 11.3-11.5; dataops_alfred-d4x). Nothing runs here:
 * Approve, with Alex's signed-in session, the token and the fingerprint, spends the link, which marks the action
 * consumed, and the pickup hands it to the desktop helper. For an sf_dataop that click is the only way a production data
 * run starts (D1). No dry run exists, so none is asked for.
 */
async function handleHelperRun(
  route: string, body: Record<string, unknown> | null, action: Action, jwt: string, token: string, deps: Deps,
  reply: (body: unknown, status?: number) => Response,
): Promise<Response> {
  if (route === "preview") {
    return reply({
      ok: true, kind: action.kind, action_id: action.id, headline: action.headline, payload: action.payload,
      fingerprint: action.fingerprint, project_code: action.project_code, expires_at: action.link_expires_at,
      ...(await stakesOf(action, deps)),
    });
  }
  if (route === "dry-run") return reply({ ok: false, error: `a ${action.kind} action has no dry run.` }, 409);

  const spend = async (fingerprint: string): Promise<Response | null> => {
    try {
      await deps.consume(jwt, token, fingerprint);
      return null;
    } catch (e) {
      return reply({ ok: false, error: e instanceof Error ? e.message : String(e) }, 409);
    }
  };

  if (route === "cancel") {
    const reason = typeof body?.reason === "string" ? body.reason.replace(/\s+/g, " ").trim() : "";
    if (reason.length > MAX_REASON) return reply({ ok: false, error: `the reason is over ${MAX_REASON} characters.` }, 400);
    const refused = await spend(action.fingerprint);
    if (refused) return refused;
    await deps.setStatus(action.id, "cancelled");
    return reply({ ok: true, action_id: action.id, cancelled: true, reason });
  }

  // approve
  const fingerprint = body?.fingerprint;
  if (typeof fingerprint !== "string" || !fingerprint) return reply({ ok: false, error: "fingerprint is missing." }, 400);
  const refused = await spend(fingerprint);
  if (refused) return refused;
  return reply({ ok: true, action_id: action.id, sent: true });
}

// ---------------------------------------------------------------------------
// the desktop helper: pickup and result (spec 11)
// ---------------------------------------------------------------------------

/** A picked action with no result after this long is marked failed at the next pickup, so its project's queue moves. */
export const PICK_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * The LONG_PICK_KINDS limit: a production data run's batch and waits, or an sf_dataquery's export, can take far
 * longer than 30 minutes.
 */
export const DATAOP_PICK_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const MAX_SUMMARY = 300;
const MAX_OUTPUT = 8000;
const TIMED_OUT = "timed out: the helper picked this up but never reported a result.";

const pickupAuthorised = (req: Request, deps: Deps) =>
  secretMatches(req.headers.get("x-switchboard-pickup-key"), deps.pickupKey);

const isHelperKind = (k: unknown): k is string => typeof k === "string" && (HELPER_KINDS as readonly string[]).includes(k);

/**
 * The kinds the helper says it runs: body `kinds`, an array. None given means git only, the helper before s86e.
 * Served exactly: git alone, every helper kind, or one of the older full sets. Only a helper naming a production kind
 * has its kinds passed on, so only it can be handed one (O3): all six get sf_dataquery and sf_dataop; the five of
 * dataops_alfred-d4x still get sf_dataop, never sf_dataquery (dataop_link-k7d).
 */
function pickupKinds(body: Record<string, unknown> | null): { pick?: "git" | "helper"; kinds?: string[]; error?: string } {
  const kinds = body?.kinds;
  if (kinds === undefined || kinds === null) return { pick: "git" };
  if (!Array.isArray(kinds) || !kinds.length || !kinds.every(isHelperKind)) {
    return { error: `kinds must be a list of helper kinds: ${HELPER_KINDS.join(", ")}.` };
  }
  const set = new Set(kinds);
  const exactly = (list: readonly string[]) => set.size === list.length && list.every((k) => set.has(k));
  if (set.size === 1 && set.has("git")) return { pick: "git" };
  if (exactly(HELPER_KINDS)) return { pick: "helper", kinds: [...HELPER_KINDS] };
  if (exactly(D4X_HELPER_KINDS)) return { pick: "helper", kinds: [...D4X_HELPER_KINDS] };
  // A helper from before dataops_alfred-d4x, and one from before s89c (which refuses an sf_read it is handed, and that
  // refusal closes the run). Neither is ever handed an sf_dataop: the pickup's default leaves it out.
  if (exactly(S89_HELPER_KINDS) || exactly(OLDER_HELPER_KINDS)) return { pick: "helper" };
  return { error: `kinds must be ["git"], all of ${HELPER_KINDS.join(", ")}, or one of the older full sets; the pickup cannot serve a part of them.` };
}

/** Fail every pick older than the timeout, then hand out the next ready action of a kind the helper asked for, or null. */
async function handlePickup(req: Request, deps: Deps, now: number): Promise<Response> {
  if (!pickupAuthorised(req, deps)) return json({ ok: false, error: "unauthorized" }, 401);
  const { pick, kinds, error } = pickupKinds(await readBody(req));
  if (error) return json({ ok: false, error }, 400);
  const stale = await deps.stalePicks(deps.userId, new Date(now - PICK_TIMEOUT_MS).toISOString(),
    new Date(now - DATAOP_PICK_TIMEOUT_MS).toISOString());
  for (const s of stale) {
    if (s.run_id) {
      await deps.finishRun(s.run_id, { summary: TIMED_OUT, result: { ok: false, timed_out: true }, finished_at: new Date(now).toISOString() });
    }
    await deps.setStatus(s.action_id, "failed");
  }
  const picked = pick === "helper"
    ? await (kinds ? deps.pickupHelper(deps.userId, kinds) : deps.pickupHelper(deps.userId))
    : await deps.pickupGit(deps.userId);
  // pickup_git returns no kind; everything it hands out is git.
  const action = picked && pick === "git" ? { ...picked, kind: "git" } : picked;
  return json({ ok: true, action, timed_out: stale.map((s) => s.action_id) });
}

/** The helper's report: closes the run and marks the action succeeded or failed. Only for a pick still waiting. */
async function handleResult(req: Request, deps: Deps, now: number): Promise<Response> {
  if (!pickupAuthorised(req, deps)) return json({ ok: false, error: "unauthorized" }, 401);
  const body = await readBody(req);
  const actionId = body?.action_id;
  const runId = body?.run_id;
  if (typeof actionId !== "string" || !actionId || typeof runId !== "string" || !runId) {
    return json({ ok: false, error: "action_id and run_id are required." }, 400);
  }
  if (typeof body?.ok !== "boolean") return json({ ok: false, error: "ok must be true or false." }, 400);
  const summary = typeof body?.summary === "string" ? body.summary.trim() : "";
  if (!summary || summary.length > MAX_SUMMARY || /[\r\n]/.test(summary)) {
    return json({ ok: false, error: `summary must be one line of at most ${MAX_SUMMARY} characters.` }, 400);
  }
  const exitCode = body?.exit_code;
  if (exitCode !== undefined && !Number.isInteger(exitCode)) return json({ ok: false, error: "exit_code must be an integer." }, 400);
  let output = typeof body?.output === "string" ? body.output.slice(-MAX_OUTPUT) : undefined;

  const picked = await deps.findPicked(actionId, runId);
  const a = picked?.action;
  const r = picked?.run;
  if (!a || a.user_id !== deps.userId || !isHelperKind(a.kind) || !r || r.action_id !== a.id) {
    return json({ ok: false, error: "no such picked action and run." }, 404);
  }
  if (a.status !== "consumed" || !a.picked_up_at || r.mode !== "real" || r.finished_at) {
    return json({ ok: false, error: `this action is ${a.status} and no longer waiting for a result.` }, 409);
  }
  // dataop_link-k7d: an sf_dataquery's run keeps only {ok, exit_code?, query_counts, pass}, its summary scrubbed.
  if (a.kind === "sf_dataquery") return dataqueryResult(a, r.id, body, summary, exitCode, deps, now);
  // s89e: a read's rows went to /sf-result; its run keeps the summary only, never the window's output. An sf_dataop
  // likewise (O8): its receipt goes to Alfred as a clip push (D6).
  if (a.kind === "sf_read" || a.kind === "sf_dataop") output = undefined;
  await deps.finishRun(r.id, {
    summary, result: { ok: body.ok, ...(exitCode === undefined ? {} : { exit_code: exitCode }), ...(output === undefined ? {} : { output }) },
    finished_at: new Date(now).toISOString(),
  });
  await deps.setStatus(a.id, body.ok ? "succeeded" : "failed");
  return json({ ok: true, action_id: a.id, run_id: r.id, status: body.ok ? "succeeded" : "failed" });
}

/** The largest count an sf_dataquery reports, as the database's switchboard_runs_dataquery_result allows. */
export const MAX_QUERY_COUNT = 999_999_999;
const isQueryCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_QUERY_COUNT;

/**
 * Why an sf_dataquery report can't be kept, or null. query_counts: one whole number per payload query, in order;
 * required when ok, optional when not. pass: a boolean, required when ok.
 */
export function dataqueryReportProblem(payload: Record<string, unknown> | null | undefined, body: Record<string, unknown>): string | null {
  const queries = Array.isArray(payload?.queries) ? payload.queries.length : 0;
  const counts = body.query_counts;
  if (counts === undefined || counts === null) {
    return body.ok === true ? "an sf_dataquery that succeeded must report query_counts, one per query." : null;
  }
  if (!Array.isArray(counts)) return "query_counts must be a list of whole numbers, one per query.";
  if (counts.length !== queries) return `query_counts has ${counts.length} entries for ${queries} quer${queries === 1 ? "y" : "ies"}.`;
  if (!counts.every(isQueryCount)) return `every entry of query_counts must be a whole number from 0 to ${MAX_QUERY_COUNT.toLocaleString("en-US")}.`;
  if (body.ok === true && typeof body.pass !== "boolean") return "an sf_dataquery that succeeded must report pass, true or false.";
  if (body.pass !== undefined && body.pass !== null && typeof body.pass !== "boolean") return "pass must be true or false.";
  return null;
}

/**
 * The run of an sf_dataquery: only {ok, exit_code?, query_counts, pass} is kept, never output or anything else the
 * helper sent, and the summary loses any Ids or emails (blankIds). A report that doesn't fit closes the run as failed,
 * saying why, and is refused.
 */
async function dataqueryResult(
  a: Picked["action"], runId: string, body: Record<string, unknown>, summary: string, exitCode: unknown, deps: Deps, now: number,
): Promise<Response> {
  const finished_at = new Date(now).toISOString();
  const problem = dataqueryReportProblem(a.payload, body);
  if (problem) {
    await deps.finishRun(runId, {
      summary: `refused by the runner: ${problem}`.slice(0, MAX_SUMMARY),
      result: { ok: false, ...(exitCode === undefined ? {} : { exit_code: exitCode }) }, finished_at,
    });
    await deps.setStatus(a.id, "failed");
    return json({ ok: false, error: problem, action_id: a.id, run_id: runId, status: "failed" }, 400);
  }
  const counts = Array.isArray(body.query_counts) ? body.query_counts : undefined;
  const result: Record<string, unknown> = { ok: body.ok, ...(exitCode === undefined ? {} : { exit_code: exitCode }) };
  if (counts) result.query_counts = counts;
  if (typeof body.pass === "boolean") result.pass = body.pass;
  await deps.finishRun(runId, { summary: blankIds(summary).slice(0, MAX_SUMMARY), result, finished_at });
  await deps.setStatus(a.id, body.ok ? "succeeded" : "failed");
  return json({ ok: true, action_id: a.id, run_id: runId, status: body.ok ? "succeeded" : "failed" });
}

// ---------------------------------------------------------------------------
// s89e: a Salesforce read's rows (spec 10)
// ---------------------------------------------------------------------------

export const MAX_SF_ROWS = 1000;
const MAX_QUERY = 20000;
const MAX_SF_ERROR = 500;
const LEVELS = ["objects", "metadata", "ids", "data"];
/** Emails and Salesforce record or org ids out of a reason, as the helper's blankSf does. */
export const blankIds = (s: string): string => s
  .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
  .replace(/\b(?=[A-Za-z]*\d)[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?\b/g, "[id]");
const isRow = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The read window's rows, before the helper's /result. Stores them in switchboard_sf_results for at most 10 minutes
 * and logs the step; never touches the run, which /result closes, so the chat line still goes. A failed read stores
 * nothing and logs why.
 */
async function handleSfResult(req: Request, deps: Deps): Promise<Response> {
  if (!pickupAuthorised(req, deps)) return json({ ok: false, error: "unauthorized" }, 401);
  const body = await readBody(req);
  const actionId = body?.action_id;
  const runId = body?.run_id;
  if (typeof actionId !== "string" || !actionId || typeof runId !== "string" || !runId) {
    return json({ ok: false, error: "action_id and run_id are required." }, 400);
  }
  if (typeof body?.ok !== "boolean") return json({ ok: false, error: "ok must be true or false." }, 400);
  const summary = typeof body?.summary === "string" ? body.summary.trim() : "";
  if (!summary || summary.length > MAX_SUMMARY || /[\r\n]/.test(summary)) {
    return json({ ok: false, error: `summary must be one line of at most ${MAX_SUMMARY} characters.` }, 400);
  }
  if (body.ok && body.rows !== undefined && !(Array.isArray(body.rows) && body.rows.every(isRow))) {
    return json({ ok: false, error: "rows must be a list of objects." }, 400);
  }
  if (body.count !== undefined && body.count !== null && !(Number.isInteger(body.count) && (body.count as number) >= 0)) {
    return json({ ok: false, error: "count must be a whole number." }, 400);
  }

  const picked = await deps.findPicked(actionId, runId);
  const a = picked?.action;
  const r = picked?.run;
  if (!a || a.user_id !== deps.userId || a.kind !== "sf_read" || !r || r.action_id !== a.id) {
    return json({ ok: false, error: "no such picked sf_read action and run." }, 404);
  }
  if (a.status !== "consumed" || !a.picked_up_at || r.mode !== "real" || r.finished_at) {
    return json({ ok: false, error: `this action is ${a.status} and no longer waiting for a result.` }, 409);
  }

  const p = (a.payload ?? {}) as Record<string, unknown>;
  const log = (stage: "ran" | "failed", extra: Record<string, unknown>) => deps.logSfRead({
    user_id: a.user_id, action_id: a.id, stage,
    org_alias: typeof p.alias === "string" && p.alias ? p.alias.slice(0, 80) : "?",
    level: LEVELS.includes(p.level as string) ? p.level : null,
    object: typeof p.object === "string" ? p.object : null,
    // d4x O4: a metadata read of several objects. Needs the migration's objects column, so deploy after it.
    ...(Array.isArray(p.objects) ? { objects: p.objects } : {}),
    fields: Array.isArray(p.fields) ? p.fields : null,
    filters: Array.isArray(p.filters) ? p.filters : null,
    // Optional for now: the helper may add the SOQL it built later.
    query_text: typeof body.query === "string" ? body.query.slice(0, MAX_QUERY) : null,
    ...extra,
  });

  if (!(await deps.sfReadsEnabled(a.user_id))) {
    const error = "refused: Salesforce reads are switched off (switchboard_settings.sf_reads_enabled).";
    await log("failed", { row_count: null, error });
    return json({ ok: false, error }, 409);
  }
  if (!body.ok) {
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason : summary;
    await log("failed", { row_count: null, error: blankIds(reason.replace(/\s+/g, " ").trim()).slice(0, MAX_SF_ERROR) });
    return json({ ok: true, action_id: a.id, stored: false });
  }

  const all = (Array.isArray(body.rows) ? body.rows : []) as Record<string, unknown>[];
  const rows = all.slice(0, MAX_SF_ROWS);
  const rowCount = typeof body.count === "number" ? body.count : rows.length;
  // The stamp from the payload too, so a helper can never leave it off a production full-data read.
  const stamped = body.production_full_data === true || (p.production === true && p.level === "data");
  const stored = await deps.insertSfResult({
    user_id: a.user_id, action_id: a.id, rows, row_count: rowCount, truncated: all.length > MAX_SF_ROWS,
    production_full_data: stamped,
  });
  if (stored.conflict) return json({ ok: false, error: "this action already has a stored result." }, 409);
  await log("ran", { row_count: rowCount, error: null });
  return json({ ok: true, action_id: a.id, stored: true, row_count: rowCount, truncated: all.length > MAX_SF_ROWS });
}

const HELPER_ROUTES = new Set(["pickup", "result", "sf-result"]);

export async function handle(req: Request, deps: Deps, now = Date.now()): Promise<Response> {
  const route = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  const browser = RUN_ROUTES.has(route);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: browser ? CORS : {} });
  if (route !== "queue" && !browser && !HELPER_ROUTES.has(route)) return json({ ok: false, error: "not found." }, 404);
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed; use POST." }, 405, browser);
  if (route === "pickup") return handlePickup(req, deps, now);
  if (route === "result") return handleResult(req, deps, now);
  if (route === "sf-result") return handleSfResult(req, deps);
  return browser ? handleRun(route, req, deps) : handleQueue(req, deps);
}
