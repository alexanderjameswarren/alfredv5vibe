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
/** The kinds the desktop helper runs (spec 11.3-11.6). */
export const HELPER_KINDS = ["git", "sf_check", "sb_setup"] as const;
export type Picked = {
  action: { id: string; user_id: string; kind: string; status: string; picked_up_at: string | null };
  run: { id: string; action_id: string; mode: string; finished_at: string | null } | null;
};
export type Deps = {
  queueSecret: string;
  /** The desktop helper's key, SWITCHBOARD_PICKUP_KEY. Separate from the queue key. */
  pickupKey: string;
  userId: string;
  /** switchboard_pickup_git, with the service role: git only, for a helper that asks for no other kind. */
  pickupGit(userId: string): Promise<PickedAction | null>;
  /** switchboard_pickup_helper (218), with the service role: any helper kind. */
  pickupHelper(userId: string): Promise<PickedAction | null>;
  /** Helper-kind actions still consumed that were picked before `before`, with their open real run if any. */
  stalePicks(userId: string, before: string): Promise<{ action_id: string; run_id: string | null }[]>;
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
 * A git, sf_check (s86pa) or sb_setup link (spec 11.3-11.5). Nothing runs here: Approve spends the link, which marks the action
 * consumed, and the pickup hands it to the desktop helper. No dry run exists, so none is asked for.
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
const MAX_SUMMARY = 300;
const MAX_OUTPUT = 8000;
const TIMED_OUT = "timed out: the helper picked this up but never reported a result.";

const pickupAuthorised = (req: Request, deps: Deps) =>
  secretMatches(req.headers.get("x-switchboard-pickup-key"), deps.pickupKey);

const isHelperKind = (k: unknown): k is string => typeof k === "string" && (HELPER_KINDS as readonly string[]).includes(k);

/**
 * The kinds the helper says it runs: body `kinds`, an array. None given means git only, the helper before s86e.
 * switchboard_pickup_helper has no kind filter, so only git alone or every helper kind can be served exactly.
 */
function pickupKinds(body: Record<string, unknown> | null): { pick?: "git" | "helper"; error?: string } {
  const kinds = body?.kinds;
  if (kinds === undefined || kinds === null) return { pick: "git" };
  if (!Array.isArray(kinds) || !kinds.length || !kinds.every(isHelperKind)) {
    return { error: `kinds must be a list of helper kinds: ${HELPER_KINDS.join(", ")}.` };
  }
  const set = new Set(kinds);
  if (set.size === 1 && set.has("git")) return { pick: "git" };
  if (HELPER_KINDS.every((k) => set.has(k))) return { pick: "helper" };
  return { error: `kinds must be ["git"] or all of ${HELPER_KINDS.join(", ")}; the pickup cannot serve a part of them.` };
}

/** Fail every pick older than the timeout, then hand out the next ready action of a kind the helper asked for, or null. */
async function handlePickup(req: Request, deps: Deps, now: number): Promise<Response> {
  if (!pickupAuthorised(req, deps)) return json({ ok: false, error: "unauthorized" }, 401);
  const { pick, error } = pickupKinds(await readBody(req));
  if (error) return json({ ok: false, error }, 400);
  const stale = await deps.stalePicks(deps.userId, new Date(now - PICK_TIMEOUT_MS).toISOString());
  for (const s of stale) {
    if (s.run_id) {
      await deps.finishRun(s.run_id, { summary: TIMED_OUT, result: { ok: false, timed_out: true }, finished_at: new Date(now).toISOString() });
    }
    await deps.setStatus(s.action_id, "failed");
  }
  const picked = pick === "helper" ? await deps.pickupHelper(deps.userId) : await deps.pickupGit(deps.userId);
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
  const output = typeof body?.output === "string" ? body.output.slice(-MAX_OUTPUT) : undefined;

  const picked = await deps.findPicked(actionId, runId);
  const a = picked?.action;
  const r = picked?.run;
  if (!a || a.user_id !== deps.userId || !isHelperKind(a.kind) || !r || r.action_id !== a.id) {
    return json({ ok: false, error: "no such picked action and run." }, 404);
  }
  if (a.status !== "consumed" || !a.picked_up_at || r.mode !== "real" || r.finished_at) {
    return json({ ok: false, error: `this action is ${a.status} and no longer waiting for a result.` }, 409);
  }
  await deps.finishRun(r.id, {
    summary, result: { ok: body.ok, ...(exitCode === undefined ? {} : { exit_code: exitCode }), ...(output === undefined ? {} : { output }) },
    finished_at: new Date(now).toISOString(),
  });
  await deps.setStatus(a.id, body.ok ? "succeeded" : "failed");
  return json({ ok: true, action_id: a.id, run_id: r.id, status: body.ok ? "succeeded" : "failed" });
}

const HELPER_ROUTES = new Set(["pickup", "result"]);

export async function handle(req: Request, deps: Deps, now = Date.now()): Promise<Response> {
  const route = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  const browser = RUN_ROUTES.has(route);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: browser ? CORS : {} });
  if (route !== "queue" && !browser && !HELPER_ROUTES.has(route)) return json({ ok: false, error: "not found." }, 404);
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed; use POST." }, 405, browser);
  if (route === "pickup") return handlePickup(req, deps, now);
  if (route === "result") return handleResult(req, deps, now);
  return browser ? handleRun(route, req, deps) : handleQueue(req, deps);
}
