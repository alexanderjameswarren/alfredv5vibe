// switchboard-runner's logic, free of Deno and the database so `node --test` can run it. index.ts supplies `Deps`.
// Spec: docs/technical-spec-switchboard2-h8r.md 8.1, and 11 for the helper's pickup and result.

import { createHash, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
// s32 (item e): the check line and the check result's shape, from the pages' one copy of the contract (as mcp's
// tools import it). Pure functions: no client, no network.
import { checkLine, checkResultProblem } from "../../../src/switchboard/runs/runContract.js";

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
 * sf_dataquery since dataop_link-k7d; sf_datawrite since dataop_write-j5w; sf_run (a run page's approval, migration 248)
 * since sb3_runner-r4q s4.
 */
export const HELPER_KINDS = ["git", "sf_check", "sb_setup", "sf_read", "sf_dataop", "sf_dataquery", "sf_datawrite", "sf_run"] as const;
/** What a helper from dataop_write-j5w asks for; served as today, never handed an sf_run (sb3_runner-r4q s4). */
const J5W_HELPER_KINDS = ["git", "sf_check", "sb_setup", "sf_read", "sf_dataop", "sf_dataquery", "sf_datawrite"];
/** What a helper from dataop_link-k7d asks for; served as today, never handed an sf_datawrite (dataop_write-j5w). */
const K7D_HELPER_KINDS = ["git", "sf_check", "sb_setup", "sf_read", "sf_dataop", "sf_dataquery"];
/** What a helper from dataops_alfred-d4x asks for; still handed an sf_dataop, never an sf_dataquery (dataop_link-k7d). */
const D4X_HELPER_KINDS = ["git", "sf_check", "sb_setup", "sf_read", "sf_dataop"];
/**
 * The kinds whose picks get the 4-hour limit: a data run's batch and waits, or a large export, take that long. An sf_run
 * is a run page's pre-check, data operation or undo, so it gets the same.
 */
export const LONG_PICK_KINDS = ["sf_dataop", "sf_dataquery", "sf_datawrite", "sf_run"];
/** What a helper from before dataops_alfred-d4x asks for; still served, and never handed an sf_dataop (O3). */
const S89_HELPER_KINDS = ["git", "sf_check", "sb_setup", "sf_read"];
/** What a helper from before s89c asks for; still served, so an older install keeps picking up. */
const OLDER_HELPER_KINDS = ["git", "sf_check", "sb_setup"];
export type Picked = {
  action: { id: string; user_id: string; kind: string; status: string; picked_up_at: string | null; payload?: Record<string, unknown> | null };
  run: { id: string; action_id: string; mode: string; finished_at: string | null; result?: Record<string, unknown> | null } | null;
};
export type Deps = {
  queueSecret: string;
  /** The desktop helper's key, SWITCHBOARD_PICKUP_KEY. Separate from the queue key. */
  pickupKey: string;
  userId: string;
  /**
   * switchboard_pickup_git, with the service role: git only, for a helper that asks for no other kind. `pickupId`
   * (sb3_runner-r4q r4, migration 247) is passed only when the helper sent one: a repeat returns the same action.
   */
  pickupGit(userId: string, pickupId?: string): Promise<PickedAction | null>;
  /**
   * switchboard_pickup_helper, with the service role. `kinds` is passed only for a helper that runs sf_dataop; without
   * it the function serves today's four and never hands one out (O3). `pickupId` as for pickupGit.
   */
  pickupHelper(userId: string, kinds?: string[], pickupId?: string): Promise<PickedAction | null>;
  /**
   * The pending route's rows (r4): the user's helper-kind actions ready and not picked up (consumed, or queued needing
   * no click), and those picked up and still waiting for a result, each with its open real run if any. Read-only.
   */
  pendingActions(userId: string): Promise<{
    unpicked: { id: string; kind: string; project_code: string; status: string; link_used_at: string | null; created_at: string }[];
    picked: { id: string; kind: string; project_code: string; picked_up_at: string; run_id: string | null }[];
  }>;
  /**
   * Helper-kind actions still consumed with their open real run if any: picked before `before`, or for a
   * LONG_PICK_KINDS action (an sf_dataop or sf_dataquery, which may take hours) before `dataopBefore`.
   */
  stalePicks(userId: string, before: string, dataopBefore: string): Promise<{ action_id: string; run_id: string | null }[]>;
  /** s6 (M): helper-kind actions whose run row the pickup functions closed with failure_reason expired_not_picked_up
   *  (247, 248) at or after `since`. Read-only. */
  expiredSince(userId: string, since: string): Promise<{ action_id: string; kind: string; project_code: string }[]>;
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
  /** sb3_runner-r4q s4: the user's switchboard_run_links row by id, every column but token_hash; null when missing. */
  runLink(linkId: string, userId: string): Promise<Record<string, unknown> | null>;
  /** The user's switchboard_run_requests row by id, whole; null when missing. */
  runRequest(requestId: string, userId: string): Promise<Record<string, unknown> | null>;
  /** switchboard_store_run_sample (250), with the service role. Throws when refused. */
  storeRunSample(requestId: string, sample: Record<string, unknown>): Promise<unknown>;
  /** switchboard_record_run_evidence (251), with the service role. A repeat returns already: true. Throws when refused. */
  recordRunEvidence(runId: string): Promise<Record<string, unknown>>;
  /** switchboard_drop_run_sample (250), with the service role: how many were deleted (0 or 1). */
  dropRunSample(requestId: string): Promise<number>;
  /** switchboard_record_run_outcome (254), with the service role. A repeat returns already: true. Throws when refused. */
  recordRunOutcome(runId: string, outcome: Record<string, unknown>): Promise<Record<string, unknown>>;
  // These throw an Error whose `code` is the database's SQLSTATE when it refused (see FINAL_SQLSTATES).
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
  // An sf_run has no link of its own: its run page approves it (switchboard-run-pages), never these routes.
  if (action.kind === "sf_run") return reply({ ok: false, error: "an sf_run is approved on its run page, not here." }, 409);
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
 * has its kinds passed on, so only it can be handed one (O3): all seven get every production kind; the six of
 * dataop_link-k7d get sf_dataquery and sf_dataop, never sf_datawrite (dataop_write-j5w); the five of
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
  if (exactly(J5W_HELPER_KINDS)) return { pick: "helper", kinds: [...J5W_HELPER_KINDS] };
  if (exactly(K7D_HELPER_KINDS)) return { pick: "helper", kinds: [...K7D_HELPER_KINDS] };
  if (exactly(D4X_HELPER_KINDS)) return { pick: "helper", kinds: [...D4X_HELPER_KINDS] };
  // A helper from before dataops_alfred-d4x, and one from before s89c (which refuses an sf_read it is handed, and that
  // refusal closes the run). Neither is ever handed an sf_dataop: the pickup's default leaves it out.
  if (exactly(S89_HELPER_KINDS) || exactly(OLDER_HELPER_KINDS)) return { pick: "helper" };
  return { error: `kinds must be ["git"], all of ${HELPER_KINDS.join(", ")}, or one of the older full sets; the pickup cannot serve a part of them.` };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * r4: body `pickup_id`, one uuid per approve click that the helper sends again on every retry of that pickup, so a
 * retry after a lost reply gets the same action (switchboard_pickup_* p_pickup_id, migration 247). Absent or null:
 * none. Sent in lower case.
 */
function pickupIdOf(body: Record<string, unknown> | null): { pickupId?: string; error?: string } {
  const id = body?.pickup_id;
  if (id === undefined || id === null) return {};
  if (typeof id !== "string" || !UUID.test(id)) {
    return { error: "pickup_id: not a uuid — send one uuid per approve click, the same on every retry, or leave it out." };
  }
  return { pickupId: id.toLowerCase() };
}

/** An approved action not picked up within this long is failed by the next pickup (migration 247), so it never runs. */
export const APPROVED_PICKUP_LIMIT_MS = 15 * 60 * 1000;

/** A queued action needing no click and not picked up within this long is failed by the next pickup. */
const QUEUED_PICKUP_LIMIT_MS = 10 * 60 * 1000;

/**
 * r4, for B's reinstall check, asked at Alex's click only: what the helper still owes. `unpicked` are actions ready
 * for the helper and not yet picked up: approved (consumed), or queued needing no click. `stale` marks one the next
 * pickup fails anyway (approved over 15 minutes ago, queued over 10), so it never runs and doesn't block.
 * `unreported` are picked-up actions with no result yet. Their `stale` says the next pickup will mark them timed
 * out (30 minutes, or 4 hours for LONG_PICK_KINDS), but the helper may still be running one, so every unreported
 * entry blocks. `clear` is true when nothing blocks. Read-only: it fails nothing and picks nothing.
 */
async function handlePending(req: Request, deps: Deps, now: number): Promise<Response> {
  if (!pickupAuthorised(req, deps)) return json({ ok: false, error: "unauthorized" }, 401);
  const { unpicked, picked } = await deps.pendingActions(deps.userId);
  const unpickedOut = unpicked.map((a) => {
    const queued = a.status === "queued";
    const approvedAt = queued ? a.created_at : a.link_used_at ?? a.created_at;
    const limit = queued ? QUEUED_PICKUP_LIMIT_MS : APPROVED_PICKUP_LIMIT_MS;
    return { action_id: a.id, kind: a.kind, project_code: a.project_code, status: a.status, approved_at: approvedAt,
             stale: Date.parse(approvedAt) < now - limit };
  });
  const unreported = picked.map((a) => {
    const limit = LONG_PICK_KINDS.includes(a.kind) ? DATAOP_PICK_TIMEOUT_MS : PICK_TIMEOUT_MS;
    return { action_id: a.id, run_id: a.run_id, kind: a.kind, project_code: a.project_code, picked_up_at: a.picked_up_at,
             stale: Date.parse(a.picked_up_at) < now - limit };
  });
  const clear = !unreported.length && !unpickedOut.some((e) => !e.stale);
  return json({ ok: true, clear, unpicked: unpickedOut, unreported });
}

/** Fail every pick older than the timeout, then hand out the next ready action of a kind the helper asked for, or null. */
async function handlePickup(req: Request, deps: Deps, now: number): Promise<Response> {
  if (!pickupAuthorised(req, deps)) return json({ ok: false, error: "unauthorized" }, 401);
  const body = await readBody(req);
  const { pick, kinds, error } = pickupKinds(body);
  if (error) return json({ ok: false, error }, 400);
  const { pickupId, error: idError } = pickupIdOf(body);
  if (idError) return json({ ok: false, error: idError }, 400);
  const stale = await deps.stalePicks(deps.userId, new Date(now - PICK_TIMEOUT_MS).toISOString(),
    new Date(now - DATAOP_PICK_TIMEOUT_MS).toISOString());
  for (const s of stale) {
    if (s.run_id) {
      await deps.finishRun(s.run_id, { summary: TIMED_OUT, result: { ok: false, timed_out: true }, finished_at: new Date(now).toISOString() });
    }
    await deps.setStatus(s.action_id, "failed");
  }
  // r4: the pickup id only when sent, so a helper without one calls exactly as before.
  const picked = pick === "helper"
    ? await (pickupId ? deps.pickupHelper(deps.userId, kinds, pickupId)
      : kinds ? deps.pickupHelper(deps.userId, kinds) : deps.pickupHelper(deps.userId))
    : await (pickupId ? deps.pickupGit(deps.userId, pickupId) : deps.pickupGit(deps.userId));
  // pickup_git returns no kind; everything it hands out is git.
  const action = picked && pick === "git" ? { ...picked, kind: "git" } : picked;
  const extra = { timed_out: stale.map((s) => s.action_id), ...(await expiredOf(deps, now)) };
  if (action?.kind === "sf_run") return sfRunPickup(action, deps, now, extra);
  return json({ ok: true, action, ...extra });
}

/** How far back /pickup's `expired` looks. The helper calls /pickup only when something prompts it, so pickups can be
 *  hours apart: a day covers a lost reply, a failed read or a 500 (the next pickup repeats them), and any clock gap. */
export const EXPIRED_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * s6 (M): the approved helper actions failed for never being picked up, read after this call's pickup function has
 * returned. That function's expiry commits before it returns, so this read sees every expiry it made, and any a
 * concurrent pickup (or a run page's resend, which writes the same failure_reason) committed first: repeats, which the
 * helper de-dupes by action id. Each one is in the reply of the call that made it, and in every reply for a day. The
 * read is tried twice; if both fail the field is left out, never failing the pickup, whose action is already picked.
 */
async function expiredOf(deps: Deps, now: number): Promise<{ expired?: { action_id: string; kind: string; project_code: string }[] }> {
  const since = new Date(now - EXPIRED_LOOKBACK_MS).toISOString();
  try {
    const rows = await deps.expiredSince(deps.userId, since).catch(() => deps.expiredSince(deps.userId, since));
    const seen = new Set<string>();
    const expired = [];
    for (const r of rows) {
      if (seen.has(r.action_id)) continue;
      seen.add(r.action_id);
      expired.push({ action_id: r.action_id, kind: r.kind, project_code: r.project_code });
    }
    return { expired };
  } catch (e) {
    console.error("[switchboard-runner] expired read failed:", messageOf(e));
    return {};
  }
}

// ---------------------------------------------------------------------------
// sb3_runner-r4q s4: sf_run, a run page's approval (248; pages contract parts 2, 4.4, 4.5, 10c). The action's payload
// is {link_id} only: what to run is the run link's request, read here with the service role. The helper reports
// {ok, pass, checks, sample?}; the runner records the run, then the evidence (251), then the sample (250).
// ---------------------------------------------------------------------------

/**
 * The result line for a run page's run (part 4.4), by its link id: done: PASS, done: FAIL, or failed. A pretend run's
 * (sb3_pages-h6v s29) starts "SIMULATION ": its data was made up. A real run's is unchanged.
 */
export const sfRunLine = (linkId: string, ok: boolean, pass?: unknown, simulated = false) =>
  `${simulated ? "SIMULATION " : ""}run ${linkId} ${ok ? (pass === true ? "done: PASS" : "done: FAIL") : "failed"}`;

/**
 * The run modes an sf_run's result is taken for (s29): real, and pretend (256: pickup_helper opens a pretend request's
 * sf_run run as pretend, from the payload's pretend that consume sets). The runner only records a pretend result; whether the run and its
 * request agree is the 256 functions' check (evidence and outcome refuse a mismatch, 55000). Other kinds stay real.
 */
export const SF_RUN_MODES = ["real", "pretend"];

const linkIdOf = (payload: Record<string, unknown> | null | undefined) =>
  typeof payload?.link_id === "string" ? payload.link_id : "";

/**
 * The picked sf_run with its link (every column but token_hash) and its request (whole). Never the sample: the page
 * shows it, the helper never needs it. A missing link or request can't be run, so the action fails and the pickup is
 * refused naming the fix; a read that throws leaves the pick open, so the helper's retry with the same pickup_id gets
 * the same action and reads again.
 */
async function sfRunPickup(action: PickedAction, deps: Deps, now: number, extra: Record<string, unknown>): Promise<Response> {
  const linkId = linkIdOf(action.payload);
  const link = linkId ? await deps.runLink(linkId, deps.userId) : null;
  const request = link && typeof link.request_id === "string" ? await deps.runRequest(link.request_id, deps.userId) : null;
  if (!link || !request) {
    const why = !link ? `no run link ${linkId || "(none in the payload)"}` : `run link ${linkId} has no request ${link.request_id}`;
    const error = `sf_run ${action.action_id}: ${why} — its request was deleted; queue the request again and approve its new link.`;
    await deps.finishRun(action.run_id, { summary: error.slice(0, MAX_SUMMARY), result: { ok: false }, finished_at: new Date(now).toISOString() });
    await deps.setStatus(action.action_id, "failed");
    return json({ ok: false, error, action_id: action.action_id, run_id: action.run_id, project_code: action.project_code,
                  ...(linkId ? { line: sfRunLine(linkId, false, undefined, action.payload?.pretend === true) } : {}), ...extra }, 409);
  }
  const { token_hash: _hash, ...shown } = link;
  return json({ ok: true, action: { ...action, link: shown, request }, ...extra });
}

/** The pre-check's check names and orgs, as switchboard_record_run_evidence (251) takes them. */
export const SF_RUN_CHECKS = ["count", "login", "automation", "backup", "sample", "rehearsal"];
const SF_RUN_ORGS = ["production", "sandbox"];
const COMMIT = /^[0-9a-f]{7,40}$/;

/**
 * Why an sf_run report can't be kept, or null. The one place its shape is checked, while the evidence shape is still
 * the data runs thread's proposal: {ok, pass, checks: [{check, org, commit?}], sample?}. pass is required when ok;
 * checks may be left out or empty (a run with nothing to record); sample is an object (250 checks its records).
 * s32: a pre-check that stopped at the rehearsal adds failed_check: 'rehearsal' (item b); a check page's run reports
 * check: {job, at_goal, at_backup, neither} instead of pass (item e), its shape as runContract's checkResultProblem.
 */
export function sfRunReportProblem(body: Record<string, unknown>, kind: SfRunKind = "pre-check"): string | null {
  if (body.pass !== undefined && typeof body.pass !== "boolean") return "pass must be true or false.";
  // s32 (item e): a check reports what it found, not pass; its result is `check`, required when it succeeded.
  if (kind === "check") {
    // s32 cold review: a check reports check instead of pass, and keeps no checks or sample.
    const extra = ["pass", "checks", "failed_check", "sample"].filter((k) => body[k] !== undefined);
    if (extra.length) return `a check page's run reports check, not ${extra.join(", ")}; leave ${extra.length === 1 ? "it" : "them"} out.`;
    if (body.check === undefined) return body.ok === true ? "a check that succeeded must report check: {job, at_goal, at_backup, neither}." : null;
    if (body.ok !== true) return "check comes only with ok true; a failed check run reports no check.";
    return checkResultProblem(body.check);
  }
  if (body.check !== undefined) return "check is reported only by a check page's run.";
  if (body.ok === true && typeof body.pass !== "boolean") return "an sf_run that succeeded must report pass, true or false.";
  if (body.pass === true && body.ok !== true) return "pass can be true only when ok is true.";
  // s32 (item b, 15.3): a pre-check that stopped at the sandbox rehearsal: {ok: true, pass: false, failed_check:
  // 'rehearsal', checks: [the production checks that passed]}, never a rehearsal among them.
  if (body.failed_check !== undefined) {
    if (kind === "write") return "failed_check is reported only by a pre-check.";
    if (body.failed_check !== "rehearsal") return "failed_check must be \"rehearsal\": only a stop at the sandbox rehearsal keeps checks.";
    if (body.ok !== true || body.pass !== false) return "failed_check comes only with ok true and pass false.";
    if (!Array.isArray(body.checks) || body.checks.length === 0) return "failed_check needs checks: the production checks that passed.";
    if (body.checks.some((c) => isPlain(c) && c.check === "rehearsal")) return "a run that failed at the rehearsal never lists a rehearsal in checks.";
    if (body.sample !== undefined) return "a run that failed at the rehearsal keeps no sample; leave it out.";
  }
  if (body.checks !== undefined) {
    if (!Array.isArray(body.checks)) return "checks must be a list of {check, org, commit?}.";
    const bad = body.checks.find((c) => !isPlain(c) || !SF_RUN_CHECKS.includes(c.check as string) || !SF_RUN_ORGS.includes(c.org as string) ||
      (c.commit !== undefined && !(typeof c.commit === "string" && COMMIT.test(c.commit))) ||
      Object.keys(c).some((k) => !["check", "org", "commit"].includes(k)));
    if (bad !== undefined) {
      return `every check must be {check, org, commit?}: check one of ${SF_RUN_CHECKS.join(", ")}; org production or sandbox; commit a hex hash.`;
    }
    if (new Set(body.checks.map((c) => c.check)).size !== body.checks.length) return "checks names a check twice.";
  }
  if (body.sample !== undefined) {
    const records = isPlain(body.sample) ? body.sample.records : undefined;
    if (!Array.isArray(records) || records.length < 1 || records.length > 2) {
      return "sample must be an object: {records: [one record, or two for an upsert]}.";
    }
  }
  return null;
}

/**
 * What an sf_run is, by 251's own rule (switchboard_record_run_evidence): the link's pre-check when it is the link's
 * rerun (rerun_action_id: "Run the pre-check and rehearsal again", or a write's correction Approve) or the link's
 * approval (action_id) on a request whose base_page is precheck; the data operation's write when it is the link's
 * approval on a request whose base_page is dataop or undo; s32 (item e): the check page's check when it is the link's
 * approval on a request whose base_page is check (consume sets action_id on a check page's Approve); anything else (an
 * action the link no longer names) is none of them, and records nothing.
 */
export type SfRunKind = "pre-check" | "write" | "check" | "other";
export function sfRunKind(actionId: string, link: Record<string, unknown>, request: Record<string, unknown>): SfRunKind {
  if (actionId === link.rerun_action_id) return "pre-check";
  if (actionId !== link.action_id) return "other";
  if (request.base_page === "precheck") return "pre-check";
  if (request.base_page === "dataop" || request.base_page === "undo") return "write";
  if (request.base_page === "check") return "check";
  return "other";
}

/**
 * The SQLSTATEs 250's switchboard_store_run_sample and 251's switchboard_record_run_evidence raise for a refusal that
 * a retry can't change: P0002 (no such run, request or link), 23514 (a result or sample that doesn't fit, a run that
 * isn't an sf_run's), 55000 (not finished, not passed, a simulation, a voided or older link, not the link's pre-check,
 * finished before the correction, newer evidence in use, no valid checks for a sample). Anything else (a network or
 * connection error, a server error) is retried.
 */
export const FINAL_SQLSTATES = ["P0002", "23514", "55000"];
const FINAL_FIX: Record<string, string> = {
  P0002: "its run link or request is gone; queue the request again and approve its new link.",
  "23514": "the helper's result doesn't fit what the database records; fix the helper's report and run the pre-check again.",
  "55000": "the run page changed since this run was approved; reload the run page and run the pre-check again.",
};
/** s29: 256's pretend mismatch (55000) names "a pretend run" or "a pretend request"; reloading can't fix it. */
const PRETEND_MISMATCH = /a pretend (run|request)/;
const PRETEND_MISMATCH_FIX = "the run and its request disagree on pretend; queue the request again and approve its new link.";
const finalFix = (code: string, message: string) =>
  (code === "55000" && PRETEND_MISMATCH.test(message) ? PRETEND_MISMATCH_FIX : FINAL_FIX[code]);
/** 254's switchboard_record_run_outcome refusals: 22023 (not an object, over 64 KB; 258: a check's not {check}), P0002
 *  (no such run), 55000 (not a finished run its link approved on a data operation, undo or (258) check, a simulation,
 *  never started, another link's, a pretend mismatch). */
export const OUTCOME_FINAL_SQLSTATES = ["22023", "P0002", "55000"];
/** The function itself unreachable: PostgREST's no such function, undefined function, no permission. Noted, not retried. */
export const OUTCOME_MISSING_CODES = ["PGRST202", "42883", "42501"];
const sqlstateOf = (e: unknown) => (e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "");
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The run of an sf_run. The link and its request are read first, to tell a pre-check from a write; then the result
 * goes on the run row without the sample (only {ok, exit_code?, pass?, checks?}; chat can read that row).
 * - A pre-check, passing with checks: switchboard_record_run_evidence, then the sample if one came (250 stores one
 *   only against valid evidence), both before the status, because a rerun's evidence must be recorded while its
 *   action is still consumed (contract 10c).
 * - A write: no evidence and no sample (251 refuses a data operation's own run); at its final status,
 *   switchboard_drop_run_sample by its own link's request_id. A failed drop doesn't fail the write: the run summary
 *   says so, and the 24-hour prune is the backstop.
 * A refusal with a FINAL_SQLSTATES code fails the run at once, naming the fix (422, retry: false). Any other failed
 * read or write is 503 {retry: true}, with the action still consumed, so the helper sends the same result again.
 *
 * A repeat never records twice: the run row is written only while unfinished (a retry reuses what it holds), the
 * evidence function records a run id once (already: true), the sample is one row per request (replaced, never added),
 * and once the status is set a repeat only answers already.
 */
async function sfRunResult(
  a: Picked["action"], r: NonNullable<Picked["run"]>, body: Record<string, unknown>, summary: string, exitCode: unknown,
  deps: Deps, now: number,
): Promise<Response> {
  const linkId = linkIdOf(a.payload);
  const ids = { action_id: a.id, run_id: r.id, link_id: linkId };
  const retry = (which: string, e: unknown) => json({
    ok: false, retry: true, ...ids, error: `${which}: ${messageOf(e)} — the run is kept; send the same result again.`,
  }, 503);
  if (!a.picked_up_at || !SF_RUN_MODES.includes(r.mode)) {
    return json({ ok: false, error: `this action is ${a.status} and no longer waiting for a result.` }, 409);
  }
  if (a.status !== "consumed") {
    const stored = r.result ?? {};
    if (r.finished_at && stored.timed_out !== true && (a.status === "succeeded" || a.status === "failed")) {
      // From the status too: an action failed by the stale check after a failed write says failed, never PASS.
      // s32: a check's run row keeps its check, so a repeat answers the check line, not a PASS or FAIL.
      const done = a.status === "succeeded" && stored.ok === true;
      return json({ ok: true, already: true, action_id: a.id, run_id: r.id, status: a.status, link_id: linkId,
                    line: done && isPlain(stored.check) && checkResultProblem(stored.check) === null
                      ? checkLine(linkId, stored.check, r.mode === "pretend")
                      : sfRunLine(linkId, done, stored.pass, r.mode === "pretend") });
    }
    return json({ ok: false, error: `this action is ${a.status} and no longer waiting for a result.` }, 409);
  }

  // Any other write that throws (the run row, the status) is retried too: every step is safe to repeat.
  try {
    return await sfRunRecord(a, r, body, summary, exitCode, deps, now, linkId, ids, retry);
  } catch (e) {
    return retry("runner", e);
  }
}

const noted = (summary: string, note: string) => summary.slice(0, MAX_SUMMARY - note.length) + note;

async function sfRunRecord(
  a: Picked["action"], r: NonNullable<Picked["run"]>, body: Record<string, unknown>, summary: string, exitCode: unknown,
  deps: Deps, now: number, linkId: string, ids: Record<string, string>, retry: (which: string, e: unknown) => Response,
): Promise<Response> {
  const finished_at = new Date(now).toISOString();
  const exit = exitCode === undefined ? {} : { exit_code: exitCode };
  const simulated = r.mode === "pretend";

  // The link and its request first, so the kind is known on every path, a refused report's included.
  let link: Record<string, unknown> | null;
  let request: Record<string, unknown> | null;
  try {
    link = linkId ? await deps.runLink(linkId, deps.userId) : null;
    request = link && typeof link.request_id === "string" ? await deps.runRequest(link.request_id, deps.userId) : null;
  } catch (e) {
    return retry("link", e);
  }
  const kind = link && request ? sfRunKind(a.id, link, request) : "other";
  let runSummary = blankIds(summary).slice(0, MAX_SUMMARY);
  let sampleDropped: number | null = null;
  // A write's sample goes at its final status, succeeded or failed; a failed drop is noted, never fatal.
  const drop = async (): Promise<string> => {
    if (kind !== "write") return "";
    try {
      const n = await deps.dropRunSample(link!.request_id as string);
      sampleDropped = typeof n === "number" ? n : 0;
      return "";
    } catch (e) {
      return ` (sample not dropped: ${blankIds(messageOf(e)).slice(0, 100)}; the 24-hour prune removes it)`;
    }
  };
  // s5: a write's outcome (254), from the helper's write object, goes on its request once the run row is finished;
  // never on the run row. 254's refusals are noted and don't undo the run; anything else is retried while `retrying`.
  const outcome: { reply: Record<string, unknown> | null; refused: string | null; error: string | null } = { reply: null, refused: null, error: null };
  // s32 (item e): a check's result goes the same way, as {check} (258), once sfRunReportProblem has passed its shape.
  const outcomeOf = (): unknown => (kind === "write" ? body.write : kind === "check" && body.check !== undefined ? { check: body.check } : undefined);
  const recordOutcome = async (retrying: boolean): Promise<{ note: string; again?: Response }> => {
    const given = outcomeOf();
    if (given === undefined) return { note: "" };
    if (!isPlain(given)) return { note: " (outcome not recorded: the helper's write isn't an object)" };
    try {
      outcome.reply = await deps.recordRunOutcome(r.id, given);
      return { note: "" };
    } catch (e) {
      const code = sqlstateOf(e);
      const msg = blankIds(messageOf(e)).slice(0, 100);
      if (OUTCOME_FINAL_SQLSTATES.includes(code)) {
        outcome.refused = code;
        return { note: ` (outcome refused (${code}): ${msg})` };
      }
      // 254 not applied, or its grant missing: retrying can't help, so the write isn't held for it.
      if (OUTCOME_MISSING_CODES.includes(code)) {
        outcome.error = code;
        return { note: ` (outcome not recorded (${code}): switchboard_record_run_outcome is missing or not granted)` };
      }
      if (retrying) return { note: "", again: retry("outcome", e) };
      outcome.error = code || "error";
      return { note: ` (outcome not recorded (${outcome.error}): ${msg})` };
    }
  };
  const outcomeReply = () => ({ outcome: outcome.reply,
    ...(outcome.refused ? { outcome_refused: outcome.refused } : {}), ...(outcome.error ? { outcome_error: outcome.error } : {}) });
  const writeReply = () => (kind === "write" ? { sample_dropped: sampleDropped, ...outcomeReply() } : kind === "check" ? outcomeReply() : {});
  // Fail the run for good: the run row says why and the fix; the helper is told not to retry. `touch` false (s30, the
  // mode check) leaves the sample and the outcome alone: the run isn't this request's, so it may change neither.
  const final = async (why: string, kept: Record<string, unknown>, status = 422, touch = true) => {
    const reason = touch ? noted(why, await drop()) : why;
    // The mode check on a retry keeps the result the run already holds (s30 cold review): only the summary changes.
    await deps.finishRun(r.id, !touch && r.finished_at ? { summary: reason }
      : { summary: reason, result: { ...kept, ok: false }, finished_at: r.finished_at ?? finished_at });
    // The write may still have run, so its outcome is kept; here a failure to keep it is only noted.
    const { note } = touch ? await recordOutcome(false) : { note: "" };
    if (note) await deps.finishRun(r.id, { summary: noted(reason, note) });
    await deps.setStatus(a.id, "failed");
    return json({ ok: false, retry: false, error: why, ...ids, status: "failed", line: sfRunLine(linkId, false, undefined, simulated),
                  ...(touch ? writeReply() : {}) }, status);
  };

  // s30 (16.5): the run's mode must match its request's pretend, on every kind, before any evidence, sample or
  // outcome call. The database's 55000 (251, 254) stays the backstop.
  if (link && request && simulated !== (request.pretend === true)) {
    return final(`refused by the runner: a ${simulated ? "pretend" : "real"} run on a ${request.pretend === true ? "pretend" : "real"} request — ${PRETEND_MISMATCH_FIX}`,
      { ...exit, refused: "mode" }, 422, false);
  }

  const problem = sfRunReportProblem(body, kind);
  if (problem) {
    // A retry after a failed write keeps the result already on the run; only a first report is closed by its shape.
    if (r.finished_at) return json({ ok: false, error: problem, ...ids }, 400);
    // s32: a check in the wrong shape is refused before anything is stored: no outcome call for it.
    return final(`refused by the runner: ${problem}`, exit, 400, kind !== "check");
  }
  // s32: failed_check (item b) goes on the run row, which is all switchboard_record_run_evidence reads; a check's
  // result (item e) too, so a repeat answers the check line.
  const result: Record<string, unknown> = r.finished_at ? (r.result ?? {}) : {
    ok: body.ok, ...exit,
    ...(typeof body.pass === "boolean" ? { pass: body.pass } : {}),
    ...(Array.isArray(body.checks) ? { checks: body.checks } : {}),
    ...(body.failed_check === "rehearsal" ? { failed_check: "rehearsal" } : {}),
    ...(kind === "check" && isPlain(body.check) ? { check: body.check } : {}),
  };
  if (!link || !request) {
    return final(`sf_run ${a.id}: ${!link ? `no run link ${linkId}` : `run link ${linkId} has no request`} — queue the request again and approve its new link.`, result);
  }
  if (!r.finished_at) await deps.finishRun(r.id, { summary: runSummary, result, finished_at });

  const ok = result.ok === true;
  let evidence: Record<string, unknown> | null = null;
  let sampleStored = false;
  // s32 (item b): a stop at the rehearsal keeps its passed production checks; 258 records them and voids the rehearsal.
  const keptChecks = kind === "pre-check" && ok && result.pass === false && result.failed_check === "rehearsal";
  if (kind === "pre-check" && ok && (result.pass === true || keptChecks) && Array.isArray(result.checks) && result.checks.length > 0) {
    try {
      evidence = await deps.recordRunEvidence(r.id);
    } catch (e) {
      const code = sqlstateOf(e);
      if (!FINAL_SQLSTATES.includes(code)) return retry("evidence", e);
      // 15.3: a refused kept-checks record is noted on the run, never final(): the run stays "done: FAIL".
      if (keptChecks) {
        runSummary = noted(runSummary, ` (kept checks refused (${code}): ${blankIds(messageOf(e)).slice(0, 100)})`);
        await deps.finishRun(r.id, { summary: runSummary });
      } else {
        return final(`evidence refused (${code}): ${blankIds(messageOf(e))} — ${finalFix(code, messageOf(e))}`, { ...result, refused: "evidence", sqlstate: code });
      }
    }
    // Only a passing pre-check's sample is kept; any other is dropped, never stored. Once the evidence is in, a
    // refused sample doesn't undo the run: it is noted, and the page shows no sample.
    if (result.pass === true && isPlain(body.sample)) {
      try {
        await deps.storeRunSample(link.request_id as string, body.sample);
        sampleStored = true;
      } catch (e) {
        const code = sqlstateOf(e);
        if (!FINAL_SQLSTATES.includes(code)) return retry("sample", e);
        runSummary = noted(runSummary, ` (sample refused (${code}): ${blankIds(messageOf(e)).slice(0, 100)})`);
        await deps.finishRun(r.id, { summary: runSummary });
      }
    }
  }
  // A write's outcome, succeeded or failed, before the drop and the status, so a retry still finds the action consumed.
  const kept = await recordOutcome(true);
  if (kept.again) return kept.again;
  if (kept.note) {
    runSummary = noted(runSummary, kept.note);
    await deps.finishRun(r.id, { summary: runSummary });
  }
  const dropNote = await drop();
  if (dropNote) await deps.finishRun(r.id, { summary: noted(runSummary, dropNote) });
  const status = ok ? "succeeded" : "failed";
  await deps.setStatus(a.id, status);
  // s32 (item e): a check that succeeded answers checkLine; a failed one keeps "run <link id> failed".
  const line = kind === "check" && ok && isPlain(result.check)
    ? checkLine(linkId, result.check, simulated) : sfRunLine(linkId, ok, result.pass, simulated);
  return json({ ok: true, ...ids, run_kind: kind, status, line, evidence, sample_stored: sampleStored, ...writeReply() });
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
  // sb3_runner-r4q s4: an sf_run answers a repeat itself, and may retry its writes after the run is recorded.
  if (a.kind === "sf_run") return sfRunResult(a, r, body, summary, exitCode, deps, now);
  if (a.status !== "consumed" || !a.picked_up_at || r.mode !== "real" || r.finished_at) {
    return json({ ok: false, error: `this action is ${a.status} and no longer waiting for a result.` }, 409);
  }
  // dataop_link-k7d: an sf_dataquery's run keeps only {ok, exit_code?, query_counts, pass}, its summary scrubbed.
  if (a.kind === "sf_dataquery") return dataqueryResult(a, r.id, body, summary, exitCode, deps, now);
  // dataop_write-j5w: an sf_datawrite's run keeps only {ok, exit_code?, pass?, datawrite?}, every number checked.
  if (a.kind === "sf_datawrite") return datawriteResult(a, r.id, body, summary, exitCode, deps, now);
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
// dataop_write-j5w: an sf_datawrite's result (docs/technical-spec-dataop_write-j5w.md part 3). Counts only: the same
// rules as the database's switchboard_runs_datawrite_result, plus the two it can't see (the payload's expected and its
// number of queries). The reply's `line` is the chat line, and the helper posts it exactly as returned:
// "datawrite <id> done: PASS", "datawrite <id> done: FAIL" or "datawrite <id> failed".
// ---------------------------------------------------------------------------

/** What the helper may send for an sf_datawrite at /result; anything else is refused, never dropped. */
const DATAWRITE_BODY_KEYS = ["action_id", "run_id", "ok", "summary", "exit_code", "pass", "datawrite"];
const DATAWRITE_KEYS = ["stage", "query_counts", "gate", "write", "check"];
export const DATAWRITE_STAGES = ["gate", "write", "after", "counts", "done"];
const DATAWRITE_PARTS: Record<string, string[]> = {
  gate: ["added", "dropped", "edited"],
  write: ["expected", "changed", "failed", "excluded"],
  check: ["problems", "extras", "new_records"],
};
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The chat line the helper posts for an sf_datawrite, exactly as returned (Alex, s6): "done: PASS" or "done: FAIL" from
 * step 5's pass when ok; "failed" when not ok or when the report was refused.
 */
export const datawriteLine = (actionId: string, ok: boolean, pass?: unknown) =>
  `datawrite ${actionId} ${ok ? (pass === true ? "done: PASS" : "done: FAIL") : "failed"}`;

/**
 * Why an sf_datawrite report can't be kept, or null. Only counts, a stage and pass: no rows, Ids, text or output.
 */
export function datawriteReportProblem(payload: Record<string, unknown> | null | undefined, body: Record<string, unknown>): string | null {
  const extra = Object.keys(body).filter((k) => !DATAWRITE_BODY_KEYS.includes(k)).sort();
  if (extra.length) return `an sf_datawrite report takes no ${extra.join(", ")}: only counts, the stage and pass come back.`;
  const queries = Array.isArray(payload?.queries) ? payload.queries.length : 0;
  if (body.pass !== undefined && typeof body.pass !== "boolean") return "pass must be true or false.";
  const d = body.datawrite;
  if (d === undefined) {
    if (body.ok === true) return "an sf_datawrite that succeeded must report pass and datawrite.";
    if (body.pass === true) return "pass can be true only when ok is true.";
    return null;
  }
  if (!isPlain(d)) return "datawrite must be {stage, query_counts, gate, write, check}.";
  const bad = Object.keys(d).filter((k) => !DATAWRITE_KEYS.includes(k)).sort();
  if (bad.length) return `datawrite takes no ${bad.join(", ")}: only stage, query_counts, gate, write and check.`;
  if (typeof d.stage !== "string" || !DATAWRITE_STAGES.includes(d.stage)) return `datawrite.stage must be one of ${DATAWRITE_STAGES.join(", ")}.`;
  if (d.query_counts !== undefined) {
    if (!Array.isArray(d.query_counts) || !d.query_counts.every(isQueryCount)) {
      return `datawrite.query_counts must be a list of whole numbers from 0 to ${MAX_QUERY_COUNT.toLocaleString("en-US")}.`;
    }
    const n = d.query_counts.length;
    if (body.ok === true ? n !== queries : n > queries) {
      return `datawrite.query_counts has ${n} entries for ${queries} quer${queries === 1 ? "y" : "ies"}.`;
    }
  }
  for (const [part, keys] of Object.entries(DATAWRITE_PARTS)) {
    if (d[part] === undefined) continue;
    const v = d[part];
    if (!isPlain(v) || Object.keys(v).length !== keys.length || !keys.every((k) => isQueryCount(v[k]))) {
      return `datawrite.${part} must be {${keys.join(", ")}}, each a whole number from 0 to ${MAX_QUERY_COUNT.toLocaleString("en-US")}.`;
    }
  }
  const w = d.write as Record<string, number> | undefined;
  if (w && w.expected !== payload?.expected) {
    return `datawrite.write.expected is ${w.expected}, but the link's expected is ${payload?.expected}.`;
  }
  if (body.ok === true) {
    if (typeof body.pass !== "boolean") return "an sf_datawrite that succeeded must report pass and datawrite.";
    if (d.stage !== "done") return `an sf_datawrite that succeeded has stage done, not ${d.stage}.`;
    const missing = ["query_counts", "gate", "write", "check"].filter((k) => d[k] === undefined);
    if (missing.length) return `an sf_datawrite that succeeded must report ${missing.join(", ")}.`;
  }
  if (body.pass === true) {
    if (body.ok !== true) return "pass can be true only when ok is true.";
    const c = d.check as Record<string, number>;
    if (w!.changed + w!.failed + w!.excluded !== w!.expected) {
      return `pass is true, but changed + failed + excluded is ${w!.changed + w!.failed + w!.excluded}, not the expected ${w!.expected}.`;
    }
    if (c.problems !== 0) return `pass is true, but step 5 found ${c.problems} problem${c.problems === 1 ? "" : "s"}.`;
  }
  return null;
}

/**
 * The run of an sf_datawrite: only {ok, exit_code?, pass?, datawrite?} is kept, and the summary loses any Ids or emails.
 * A report that doesn't fit closes the run as failed, saying why, and is refused (400).
 */
async function datawriteResult(
  a: Picked["action"], runId: string, body: Record<string, unknown>, summary: string, exitCode: unknown, deps: Deps, now: number,
): Promise<Response> {
  const finished_at = new Date(now).toISOString();
  const problem = datawriteReportProblem(a.payload, body);
  if (problem) {
    await deps.finishRun(runId, {
      summary: `refused by the runner: ${problem}`.slice(0, MAX_SUMMARY),
      result: { ok: false, ...(exitCode === undefined ? {} : { exit_code: exitCode }) }, finished_at,
    });
    await deps.setStatus(a.id, "failed");
    return json({ ok: false, error: problem, action_id: a.id, run_id: runId, status: "failed", line: datawriteLine(a.id, false) }, 400);
  }
  const result: Record<string, unknown> = { ok: body.ok, ...(exitCode === undefined ? {} : { exit_code: exitCode }) };
  if (typeof body.pass === "boolean") result.pass = body.pass;
  if (isPlain(body.datawrite)) result.datawrite = body.datawrite;
  await deps.finishRun(runId, { summary: blankIds(summary).slice(0, MAX_SUMMARY), result, finished_at });
  const ok = body.ok === true;
  await deps.setStatus(a.id, ok ? "succeeded" : "failed");
  return json({ ok: true, action_id: a.id, run_id: runId, status: ok ? "succeeded" : "failed", line: datawriteLine(a.id, ok, body.pass) });
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

const HELPER_ROUTES = new Set(["pickup", "result", "sf-result", "pending"]);

export async function handle(req: Request, deps: Deps, now = Date.now()): Promise<Response> {
  const route = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  const browser = RUN_ROUTES.has(route);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: browser ? CORS : {} });
  if (route !== "queue" && !browser && !HELPER_ROUTES.has(route)) return json({ ok: false, error: "not found." }, 404);
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed; use POST." }, 405, browser);
  if (route === "pickup") return handlePickup(req, deps, now);
  if (route === "result") return handleResult(req, deps, now);
  if (route === "sf-result") return handleSfResult(req, deps);
  if (route === "pending") return handlePending(req, deps, now);
  return browser ? handleRun(route, req, deps) : handleQueue(req, deps);
}
