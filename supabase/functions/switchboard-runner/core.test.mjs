// switchboard-runner: statement parsing, headlines, refusals and the routes, against fake dependencies.
// Run: node --experimental-strip-types --test supabase/functions/switchboard-runner/core.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildHeadline, editorReasons, handle, prepare, splitStatements, summarise } from "./core.ts";

const SECRET = "q".repeat(40);
const PICKUP = "k".repeat(48);
const PICKED = { action_id: "git-1", run_id: "run-g", project_code: "p-x", payload: { command: "gitsync" }, fingerprint: "fp", headline: "H", chat_url: null };
const USER = "26f0707f-b586-4a3e-841c-8c313d6ab1e5";
const TOKEN = "a".repeat(64);
const hash = (t) => createHash("sha256").update(t).digest("hex");

function fakes(over = {}) {
  const calls = { inserted: [], runs: [], runSql: [], status: [], consumed: [] };
  const action = {
    id: "act-1", user_id: USER, payload: { sql: "delete from wb_rules where id = 1;" }, fingerprint: "fp-1",
    headline: "H", status: "link_issued", link_used_at: null,
    link_expires_at: new Date(Date.now() + 60000).toISOString(), project_code: "p-x",
  };
  const deps = {
    queueSecret: SECRET,
    userId: USER,
    insertAction: async (row) => (calls.inserted.push(row), { id: "new-1" }),
    authUser: async (jwt) => (jwt === "good" ? USER : jwt === "other" ? "someone-else" : null),
    findByLinkHash: async (h) => (h === hash(TOKEN) ? action : null),
    hasCleanDryRun: async () => true,
    latestDryRun: async () => ({ id: "dry-1", result: { ok: true } }),
    noteCancelled: async (id, result) => (calls.cancelled = { id, result }),
    consume: async (jwt, token, fp) => (calls.consumed.push({ jwt, token, fp }), { action_id: "act-1" }),
    runSql: async (statements, commit) => (calls.runSql.push({ statements, commit }), {
      ok: true, results: statements.map(() => ({ command: "DELETE", count: 3 })),
    }),
    recordRun: async (run) => (calls.runs.push(run), "run-1"),
    setStatus: async (id, status) => calls.status.push({ id, status }),
    conformance: async () => "CONFORMANT (97 tables)",
    pickupKey: PICKUP,
    pickupGit: async (u) => (calls.picked = u, PICKED),
    pickupHelper: async (u) => (calls.pickedHelper = u, { ...PICKED, kind: "sf_check" }),
    stalePicks: async (u, before) => (calls.staleBefore = before, []),
    findPicked: async (a, r) => (a === "git-1" && r === "run-g" ? {
      action: { id: "git-1", user_id: USER, kind: "git", status: "consumed", picked_up_at: "2026-11-05T08:00:00Z" },
      run: { id: "run-g", action_id: "git-1", mode: "real", finished_at: null },
    } : null),
    finishRun: async (id, fields) => (calls.finished ??= []).push({ id, ...fields }),
    ...over,
  };
  return { deps, calls, action };
}
const post = (route, body, headers = {}) => new Request(`https://x/functions/v1/switchboard-runner/${route}`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
});
const queue = (body, secret = SECRET) => post("queue", body, secret ? { "x-switchboard-queue-secret": secret } : {});
const jwt = (j = "good") => ({ Authorization: `Bearer ${j}` });

test("split: quotes, comments and dollar bodies hold no statement breaks", () => {
  const s = splitStatements(`-- a; comment
    select 'x;y'; /* b; /* nested; */ */ select "a;b" from t;
    do $$ begin perform 1; end $$;
    create function f() returns int as $body$ select 1; $body$ language sql; select E'it\\'s;'`);
  assert.equal(s.length, 5);
  assert.match(s[0].bare, /^select ''$/);
  assert.match(s[2].text, /perform 1/);
  assert.doesNotMatch(s[2].bare, /perform/);
  assert.equal(s[4].text, "select E'it\\'s;'");
});

test("headline: built from the statements, not their strings", () => {
  assert.equal(buildHeadline("delete from public.wb_rules where id = 1"),
    "THIS CHANGES THE LIVE ALFRED DATABASE: DELETES ROWS FROM WB_RULES");
  assert.equal(buildHeadline("select 'delete from wb_rules'"), "THIS RUNS A SELECT ON THE LIVE ALFRED DATABASE");
  assert.equal(buildHeadline("create table a (id int); alter table a add b int; insert into a values (1); update a set b=1 where id=1; drop table c"),
    "THIS CHANGES THE LIVE ALFRED DATABASE: CREATES TABLE A, ALTERS TABLE A, INSERTS ROWS INTO A, UPDATES ROWS IN A AND 1 MORE");
  assert.equal(buildHeadline("do $$ begin delete from x; end $$"), "THIS CHANGES THE LIVE ALFRED DATABASE: RUNS A DO BLOCK");
});

const SELECT = "THIS RUNS A SELECT ON THE LIVE ALFRED DATABASE";
const MAY = "THIS MAY CHANGE DATA IN THE LIVE ALFRED DATABASE: ";

test("headline: a select that may write says so", () => {
  for (const [sql, why] of [
    ["select delete_all_rows()", "CALLS FUNCTION DELETE_ALL_ROWS"],
    ["select * from public.count(1)", "CALLS FUNCTION PUBLIC.COUNT"],
    ['select "Odd Name" (1)', 'CALLS FUNCTION "ODD NAME"'],
    ["select a from t where wb_process (a)", "CALLS FUNCTION WB_PROCESS"],
    ["select nextval('s')", "CALLS FUNCTION NEXTVAL"],
    ["select pg_terminate_backend(1)", "CALLS FUNCTION PG_TERMINATE_BACKEND"],
    ["values (setval('s', 1))", "CALLS FUNCTION SETVAL"],
    ["select * into new_t from t", "SELECT INTO"],
    ["explain analyze delete from t where a = 1", "EXPLAIN ANALYZE"],
    ["explain analyse select 1", "EXPLAIN ANALYZE"],
    ["explain (verbose, analyze) update t set a = 1 where b = 2", "EXPLAIN ANALYZE"],
    ["select * from t for update", "LOCKS ROWS"],
    ["select * from t for no key update", "LOCKS ROWS"],
    ["select * from t for share", "LOCKS ROWS"],
  ]) assert.equal(buildHeadline(sql), MAY + why, sql);
});

test("headline: a plain select stays a select, including built-ins and strings", () => {
  for (const sql of ["select 1", "select count(*) from t", "select a from t where b in (1, 2) and exists (select 1 from u)",
    "select json_build_object('a', (select json_agg(t) from (select 1) t)) as result", "select lower(a), coalesce(b, 0) from t",
    "select 'delete_all_rows()', 'into', 'for update'", "explain select 1", "show server_version", "table t", "values (1)",
    "select $$evil()$$", "-- evil()\nselect 1", "select a::numeric(10, 2) from t"]) {
    assert.equal(buildHeadline(sql), SELECT, sql);
  }
});

test("headline: a sure write outranks a maybe, and both are named", () => {
  assert.equal(buildHeadline("delete from t where a = 1; select evil()"),
    "THIS CHANGES THE LIVE ALFRED DATABASE: DELETES ROWS FROM T, CALLS FUNCTION EVIL");
  assert.equal(buildHeadline("select 1; select evil()"), `${MAY}CALLS FUNCTION EVIL`);
});

test("editor: what cannot run in a transaction", () => {
  for (const sql of ["create index concurrently i on t (a)", "drop index concurrently i", "vacuum t",
    "alter system set x = 1", "create database d", "reindex table concurrently t"]) {
    assert.match(editorReasons(sql).join(), /cannot run in a transaction/, sql);
  }
});

test("editor: slow statement kinds", () => {
  for (const sql of ["create index i on t (a)", "create unique index if not exists i on public.t (a)",
    "update t set a = 1", "delete from t", "alter table t alter column a type bigint", "reindex table t", "cluster t"]) {
    assert.match(editorReasons(sql).join(), /may exceed the time limit/, sql);
  }
  assert.deepEqual(editorReasons("update t set a = 1 where b = 2; delete from t where c = 3"), []);
  assert.deepEqual(editorReasons("select 'vacuum', 'update t set a = 1'"), []);
});

test("editor: an index on a table this script creates is not slow", () => {
  assert.deepEqual(editorReasons("create table if not exists public.t (a int); create index i on public.t (a)"), []);
  assert.match(editorReasons("create table public.t (a int); create index i on public.u (a)").join(), /time limit/);
});

test("transaction control: an outer begin and commit are dropped, anything else refused", () => {
  const wrapped = prepare("begin; create table t (a int); commit; select 1;");
  assert.deepEqual(wrapped.reasons, []);
  assert.deepEqual(wrapped.statements.map((s) => s.text), ["create table t (a int)", "select 1"]);
  for (const sql of ["commit; drop table t", "begin; drop table t; commit; begin; drop table u; commit",
    "select 1; begin; select 2; commit", "begin; select 1; rollback", "savepoint s", "start transaction; commit; commit"]) {
    assert.match(prepare(sql).reasons.join(), /its own transaction/, sql);
  }
  assert.deepEqual(prepare("-- nothing here\n;").reasons, ["there is no statement to run"]);
});

test("summary: one line with counts", () => {
  const statements = splitStatements("delete from wb_rules where a = 1; create table t (a int); update t set a = 1 where a = 2");
  assert.equal(summarise(statements, [{ command: "DELETE", count: 3 }, { command: "CREATE TABLE", count: 0 }, { command: "UPDATE", count: 1 }]),
    "deletes 3 rows from wb_rules; creates table t; updates 1 row in t");
});

test("queue: refused without the key, and with a wrong or short one", async () => {
  for (const secret of [null, "wrong", "q".repeat(39), "x".repeat(40)]) {
    const { deps, calls } = fakes();
    const res = await handle(queue({ project_code: "p-x", sql: "select 1" }, secret), deps);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, error: "unauthorized" });
    assert.equal(calls.inserted.length, 0);
  }
});

test("queue: a JWT is not the key", async () => {
  const { deps } = fakes();
  const res = await handle(post("queue", { project_code: "p-x", sql: "select 1" }, jwt()), deps);
  assert.equal(res.status, 401);
});

test("queue: an unset or short server secret refuses everyone", async () => {
  for (const queueSecret of ["", "short"]) {
    const { deps } = fakes({ queueSecret });
    const res = await handle(queue({ project_code: "p-x", sql: "select 1" }, queueSecret || "x"), deps);
    assert.equal(res.status, 401);
  }
});

test("queue: inserts kind sql for Alex's user, with a server headline", async () => {
  const { deps, calls } = fakes();
  const res = await handle(queue({ project_code: "p-x", sql: "select 1", description: "  Reads the number 1.  ", kind: "git", user_id: "evil", headline: "FINE", fingerprint: "x" }), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, action_id: "new-1", headline: "THIS RUNS A SELECT ON THE LIVE ALFRED DATABASE" });
  assert.deepEqual(calls.inserted, [{
    user_id: USER, kind: "sql", project_code: "p-x", payload: { sql: "select 1", description: "Reads the number 1." },
    headline: "THIS RUNS A SELECT ON THE LIVE ALFRED DATABASE", created_by: "cli",
  }]);
});

test("preview: carries the description, or null for an older action", async () => {
  const { deps, action } = fakes();
  const body = { token: TOKEN };
  assert.equal((await (await handle(post("preview", body, jwt()), deps)).json()).description, null);
  action.payload.description = "Deletes 1 rule.";
  assert.equal((await (await handle(post("preview", body, jwt()), deps)).json()).description, "Deletes 1 rule.");
});

test("queue: bad input, and SQL for the editor, is refused with no row", async () => {
  const description = "Reads something.";
  const cases = [
    [{ sql: "select 1", description }, 400], [{ project_code: "Bad Code", sql: "select 1", description }, 400], [{ project_code: "p-x", description }, 400],
    [{ project_code: "p-x", sql: "x".repeat(600000), description }, 400], [{ project_code: "p-x", sql: "vacuum t", description }, 422],
    [{ project_code: "p-x", sql: "select 1" }, 400], [{ project_code: "p-x", sql: "select 1", description: "   " }, 400],
    [{ project_code: "p-x", sql: "select 1", description: 7 }, 400], [{ project_code: "p-x", sql: "select 1", description: "two\nlines" }, 400],
    [{ project_code: "p-x", sql: "select 1", description: "x".repeat(301) }, 400],
  ];
  for (const [body, status] of cases) {
    const { deps, calls } = fakes();
    assert.equal((await handle(queue(body), deps)).status, status);
    assert.equal(calls.inserted.length, 0);
  }
});

test("routes: other paths and methods are refused", async () => {
  const { deps } = fakes();
  assert.equal((await handle(post("nope", {}), deps)).status, 404);
  assert.equal((await handle(new Request("https://x/switchboard-runner/queue"), deps)).status, 405);
});

for (const route of ["preview", "dry-run", "approve"]) {
  test(`${route}: needs Alex's JWT and a live link`, async () => {
    const { deps, calls, action } = fakes();
    const body = { token: TOKEN, fingerprint: "fp-1" };
    assert.equal((await handle(post(route, body), deps)).status, 401);
    assert.equal((await handle(post(route, body, jwt("bad")), deps)).status, 401);
    assert.equal((await handle(post(route, body, jwt("other")), deps)).status, 401);
    assert.equal((await handle(post(route, body, { "x-switchboard-queue-secret": SECRET }), deps)).status, 401);
    assert.equal((await handle(post(route, { ...body, token: "b".repeat(64) }, jwt()), deps)).status, 404);
    action.link_used_at = new Date().toISOString();
    assert.equal((await handle(post(route, body, jwt()), deps)).status, 410);
    action.link_used_at = null;
    action.link_expires_at = new Date(Date.now() - 1000).toISOString();
    assert.equal((await handle(post(route, body, jwt()), deps)).status, 410);
    assert.equal(calls.runSql.length, 0);
    assert.equal(calls.consumed.length, 0);
  });
}

test("preview: shows what will run, and runs nothing", async () => {
  const { deps, calls } = fakes();
  const res = await handle(post("preview", { token: TOKEN }, jwt()), deps);
  const out = await res.json();
  assert.equal(out.sql, "delete from wb_rules where id = 1;");
  assert.equal(out.fingerprint, "fp-1");
  assert.equal(out.headline, "H");
  assert.equal(calls.runSql.length, 0);
});

test("dry run: rolls back, records the run, and leaves the link unspent", async () => {
  const { deps, calls } = fakes();
  const res = await handle(post("dry-run", { token: TOKEN }, jwt()), deps);
  const out = await res.json();
  assert.equal(calls.runSql[0].commit, false);
  assert.equal(calls.consumed.length, 0);
  assert.deepEqual(calls.status, []);
  assert.equal(calls.runs[0].mode, "dry_run");
  assert.equal(calls.runs[0].user_id, USER);
  assert.equal(out.run_id, "run-1");
  assert.equal(out.summary, "deletes 3 rows from wb_rules");
});

test("dry run: a failing statement is reported and recorded", async () => {
  const { deps, calls } = fakes({ runSql: async () => ({ ok: false, results: [], error: "boom", failedAt: 1 }) });
  const res = await handle(post("dry-run", { token: TOKEN }, jwt()), deps);
  const out = await res.json();
  assert.equal(out.ok, false);
  assert.match(out.summary, /failed at statement 1: boom/);
  assert.equal(calls.runs[0].result.ok, false);
});

test("approve: no clean dry run, no real run", async () => {
  const { deps, calls } = fakes({ hasCleanDryRun: async () => false });
  const res = await handle(post("approve", { token: TOKEN, fingerprint: "fp-1" }, jwt()), deps);
  assert.equal(res.status, 409);
  assert.equal(calls.consumed.length, 0);
  assert.equal(calls.runSql.length, 0);
});

test("approve: needs the fingerprint, and consumes before it runs", async () => {
  const order = [];
  const { deps, calls } = fakes();
  assert.equal((await handle(post("approve", { token: TOKEN }, jwt()), deps)).status, 400);
  const { consume, runSql } = deps;
  deps.consume = async (...a) => (order.push("consume"), consume(...a));
  deps.runSql = async (...a) => (order.push("run"), runSql(...a));
  const res = await handle(post("approve", { token: TOKEN, fingerprint: "fp-1" }, jwt()), deps);
  const out = await res.json();
  assert.deepEqual(order, ["consume", "run"]);
  assert.deepEqual(calls.consumed[0], { jwt: "good", token: TOKEN, fp: "fp-1" });
  assert.equal(calls.runSql[0].commit, true);
  assert.equal(calls.runs[0].mode, "real");
  assert.deepEqual(calls.status, [{ id: "act-1", status: "succeeded" }]);
  assert.equal(out.run_id, "run-1");
  assert.equal(out.conformance, "CONFORMANT (97 tables)");
  assert.equal(calls.runs[0].result.conformance, "CONFORMANT (97 tables)");
});

test("approve: a refused link runs nothing", async () => {
  const { deps, calls } = fakes({ consume: async () => { throw new Error("switchboard_consume_link: the SQL does not match what this link approved."); } });
  const res = await handle(post("approve", { token: TOKEN, fingerprint: "changed" }, jwt()), deps);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /does not match/);
  assert.equal(calls.runSql.length, 0);
  assert.equal(calls.runs.length, 0);
});

test("approve: a failed run is recorded failed, and skips conformance", async () => {
  let checked = false;
  const { deps, calls } = fakes({
    runSql: async () => ({ ok: false, results: [], error: "boom", failedAt: 1 }),
    conformance: async () => { checked = true; return "x"; },
  });
  const res = await handle(post("approve", { token: TOKEN, fingerprint: "fp-1" }, jwt()), deps);
  assert.equal((await res.json()).ok, false);
  assert.deepEqual(calls.status, [{ id: "act-1", status: "failed" }]);
  assert.equal(checked, false);
});

test("one at a time: a busy runner refuses, and approve keeps the action failed-free", async () => {
  const { deps, calls } = fakes({ runSql: async () => ({ ok: false, busy: true, results: [], error: "another run is in progress" }) });
  const res = await handle(post("dry-run", { token: TOKEN }, jwt()), deps);
  assert.equal(res.status, 409);
  assert.equal(calls.runs.length, 0);
});

test("run routes refuse SQL that belongs in the editor, even if a row holds it", async () => {
  const { deps, calls, action } = fakes();
  action.payload = { sql: "vacuum t" };
  for (const route of ["dry-run", "approve"]) {
    assert.equal((await handle(post(route, { token: TOKEN, fingerprint: "fp-1" }, jwt()), deps)).status, 422);
  }
  assert.equal(calls.runSql.length, 0);
  assert.equal(calls.consumed.length, 0);
});

const WRITES = "insert into t values (1), (2); update t set a = 1 where a = 2; create table u (a int); delete from t where a = 3";
const DESCRIBED = { project_code: "p-x", description: "Changes t." };
const answers = (...counts) => async (statements) => ({
  ok: true, results: statements.map((_, i) => ({ command: "X", count: counts[i] ?? 0 })),
});

test("queue: stores one expected count per insert, update and delete; a schema change needs none", async () => {
  const { deps, calls } = fakes();
  const res = await handle(queue({ ...DESCRIBED, sql: WRITES, expected: [2, "unknown", 1] }), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(calls.inserted[0].payload.expected, [2, "unknown", 1]);
  const schema = fakes();
  assert.equal((await handle(queue({ ...DESCRIBED, sql: "create table u (a int); alter table u add b int" }), schema.deps)).status, 200);
  assert.equal("expected" in schema.calls.inserted[0].payload, false);
});

test("queue: a missing, short, long or malformed expected list is refused and names the statements", async () => {
  for (const expected of [undefined, [], [1, 2], [1, 2, 3, 4], [1, -1, 2], [1, "lots", 2], [1, 1.5, 2], "2,1,1"]) {
    const { deps, calls } = fakes();
    const res = await handle(queue({ ...DESCRIBED, sql: WRITES, expected }), deps);
    assert.equal(res.status, 422, JSON.stringify(expected));
    const out = await res.json();
    assert.match(out.error, /--expect/);
    assert.equal(out.reasons.length, 3);
    assert.equal(calls.inserted.length, 0);
  }
  const { deps } = fakes();
  assert.equal((await handle(queue({ ...DESCRIBED, sql: "select 1", expected: [1] }), deps)).status, 422);
});

test("queue: a with statement that writes needs a count; one that only reads does not", async () => {
  const sql = "with d as (delete from t where a = 1 returning *) select count(*) from d";
  assert.equal((await handle(queue({ ...DESCRIBED, sql }), fakes().deps)).status, 422);
  assert.equal((await handle(queue({ ...DESCRIBED, sql, expected: ["unknown"] }), fakes().deps)).status, 200);
  assert.equal((await handle(queue({ ...DESCRIBED, sql: "with a as (select 1) select * from a" }), fakes().deps)).status, 200);
});

test("dry run: counts come back per statement, and a match is clean", async () => {
  const { deps, calls, action } = fakes({ runSql: answers(2, 1, 0, 3) });
  action.payload = { sql: WRITES, expected: [2, "unknown", 3] };
  const out = await (await handle(post("dry-run", { token: TOKEN }, jwt()), deps)).json();
  assert.equal(out.ok, true);
  assert.equal(out.mismatch, false);
  assert.deepEqual(out.counts, [
    { statement: 1, action: "inserts rows into t", count: 2, expected: 2, differs: false },
    { statement: 2, action: "updates rows in t", count: 1, expected: "unknown", differs: false },
    { statement: 4, action: "deletes rows from t", count: 3, expected: 3, differs: false },
  ]);
  assert.equal(calls.runs[0].result.ok, true);
  assert.deepEqual(calls.runs[0].result.counts, out.counts);
});

test("dry run: a count off the expected one is not clean, and is recorded so", async () => {
  const { deps, calls, action } = fakes({ runSql: answers(2, 9, 0, 3) });
  action.payload = { sql: WRITES, expected: [2, 1, 3] };
  const out = await (await handle(post("dry-run", { token: TOKEN }, jwt()), deps)).json();
  assert.equal(out.ok, false);
  assert.equal(out.mismatch, true);
  assert.equal(out.counts[1].differs, true);
  assert.match(out.summary, /differ/);
  assert.equal(calls.runs[0].result.ok, false);
  assert.equal(calls.runs[0].result.mismatch, true);
});

test("dry run: an older action with no expected counts still shows its counts", async () => {
  const { deps } = fakes();
  const out = await (await handle(post("dry-run", { token: TOKEN }, jwt()), deps)).json();
  assert.equal(out.ok, true);
  assert.deepEqual(out.counts, [{ statement: 1, action: "deletes rows from wb_rules", count: 3, differs: false }]);
});

test("cancel: spends the link, marks the action cancelled, and notes the reason on the latest dry run", async () => {
  const { deps, calls } = fakes();
  const res = await handle(post("cancel", { token: TOKEN, reason: "  wrong\n table " }, jwt()), deps);
  const out = await res.json();
  assert.deepEqual(out, { ok: true, run_id: "dry-1", cancelled: true, reason: "wrong table" });
  assert.deepEqual(calls.consumed[0], { jwt: "good", token: TOKEN, fp: "fp-1" });
  assert.deepEqual(calls.status, [{ id: "act-1", status: "cancelled" }]);
  assert.deepEqual(calls.cancelled, { id: "dry-1", result: { ok: true, cancelled: true, reason: "wrong table" } });
  assert.equal(calls.runSql.length, 0);
});

test("cancel: the reason is optional, one short line; with no dry run nothing is spent", async () => {
  const quiet = fakes();
  assert.equal((await (await handle(post("cancel", { token: TOKEN }, jwt()), quiet.deps)).json()).reason, "");
  const long = fakes();
  assert.equal((await handle(post("cancel", { token: TOKEN, reason: "x".repeat(201) }, jwt()), long.deps)).status, 400);
  assert.equal(long.calls.consumed.length, 0);
  const none = fakes({ latestDryRun: async () => null });
  assert.equal((await handle(post("cancel", { token: TOKEN }, jwt()), none.deps)).status, 409);
  assert.equal(none.calls.consumed.length, 0);
  assert.deepEqual(none.calls.status, []);
});

test("cancel: needs Alex's JWT and a live link, and a spent link can't be cancelled", async () => {
  const { deps, calls, action } = fakes();
  assert.equal((await handle(post("cancel", { token: TOKEN }), deps)).status, 401);
  action.link_used_at = new Date().toISOString();
  assert.equal((await handle(post("cancel", { token: TOKEN }, jwt()), deps)).status, 410);
  assert.equal(calls.consumed.length, 0);
  const lost = fakes({ consume: async () => { throw new Error("this link has already been used."); } });
  assert.equal((await handle(post("cancel", { token: TOKEN }, jwt()), lost.deps)).status, 409);
  assert.deepEqual(lost.calls.status, []);
});

test("test action: queued with its flag and its own headline; takes no expected counts", async () => {
  const { deps, calls } = fakes();
  const out = await (await handle(queue({ ...DESCRIBED, sql: "update t set a = 1 where b = 2", test: true }), deps)).json();
  assert.equal(calls.inserted[0].payload.test, true);
  assert.equal(out.headline, "THIS TEST RUNS ONCE AND IS UNDONE: UPDATES ROWS IN T");
  assert.equal(buildHeadline("select 1", true), "THIS TEST RUNS ONCE AND IS UNDONE: RUNS A SELECT");
  assert.equal((await handle(queue({ ...DESCRIBED, sql: "select 1", test: true, expected: [1] }), fakes().deps)).status, 400);
  const plain = fakes();
  await handle(queue({ ...DESCRIBED, sql: "select 1", test: "yes" }), plain.deps);
  assert.equal("test" in plain.calls.inserted[0].payload, false);
});

test("test action: runs undone, spends the link, is marked done; Approve is refused", async () => {
  const { deps, calls, action } = fakes();
  action.payload = { sql: "delete from t where a = 1", test: true };
  assert.equal((await (await handle(post("preview", { token: TOKEN }, jwt()), deps)).json()).test, true);
  assert.equal((await handle(post("approve", { token: TOKEN, fingerprint: "fp-1" }, jwt()), deps)).status, 409);
  assert.equal(calls.runSql.length, 0);
  const out = await (await handle(post("dry-run", { token: TOKEN }, jwt()), deps)).json();
  assert.equal(out.test, true);
  assert.equal(out.run_id, "run-1");
  assert.equal(calls.runSql[0].commit, false);
  assert.equal(calls.runs[0].mode, "dry_run");
  assert.deepEqual(calls.consumed, [{ jwt: "good", token: TOKEN, fp: "fp-1" }]);
  assert.deepEqual(calls.status, [{ id: "act-1", status: "succeeded" }]);
});

test("test action: a failure is marked failed; a busy runner keeps the link; a lost race records nothing", async () => {
  const sql = { sql: "select 1", test: true };
  const failed = fakes({ runSql: async () => ({ ok: false, results: [], error: "boom", failedAt: 1 }) });
  failed.action.payload = sql;
  await handle(post("dry-run", { token: TOKEN }, jwt()), failed.deps);
  assert.deepEqual(failed.calls.status, [{ id: "act-1", status: "failed" }]);
  const busy = fakes({ runSql: async () => ({ ok: false, busy: true, results: [], error: "another run is in progress." }) });
  busy.action.payload = sql;
  assert.equal((await handle(post("dry-run", { token: TOKEN }, jwt()), busy.deps)).status, 409);
  assert.equal(busy.calls.consumed.length, 0);
  const lost = fakes({ consume: async () => { throw new Error("this link has already been used."); } });
  lost.action.payload = sql;
  assert.equal((await handle(post("dry-run", { token: TOKEN }, jwt()), lost.deps)).status, 409);
  assert.equal(lost.calls.runs.length, 0);
});

test("index.ts: only the latest dry run makes an action clean", () => {
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(src, /order\("started_at", \{ ascending: false \}\)/);
});

test("index.ts: one command per send, in a transaction it holds", () => {
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(src, /tx\.unsafe\(s\.text, \[\], \{ simple: false \} as never\)/);
  assert.match(src, /sql\.begin\(/);
  assert.match(src, /pg_try_advisory_xact_lock/);
});

test("browser calls: a preflight passes on the run routes only", async () => {
  const { deps } = fakes();
  const ok = await handle(new Request("https://x/switchboard-runner/approve", { method: "OPTIONS" }), deps);
  assert.equal(ok.status, 204);
  assert.match(ok.headers.get("access-control-allow-headers"), /authorization/i);
  const no = await handle(new Request("https://x/switchboard-runner/queue", { method: "OPTIONS" }), deps);
  assert.equal(no.headers.get("access-control-allow-origin"), null);
});

const helper = (route, body = {}, key = PICKUP) => post(route, body, key ? { "x-switchboard-pickup-key": key } : {});
const result = (over = {}) => ({ action_id: "git-1", run_id: "run-g", ok: true, summary: "gitsync: merged main", ...over });

test("pickup and result: refused with no key, a wrong or short one, the queue key, or an unset server key", async () => {
  for (const route of ["pickup", "result"]) {
    for (const key of [null, "wrong", PICKUP.slice(1), SECRET]) {
      const { deps, calls } = fakes();
      const res = await handle(helper(route, result(), key), deps);
      assert.equal(res.status, 401, `${route} ${key}`);
      assert.equal(calls.picked, undefined);
      assert.equal(calls.finished, undefined);
    }
    const { deps } = fakes({ pickupKey: "" });
    assert.equal((await handle(helper(route, result(), null), deps)).status, 401);
    assert.equal((await handle(helper(route, result(), PICKUP), deps)).status, 401);
  }
  const { deps } = fakes();
  assert.equal((await handle(queue({ project_code: "p-x", sql: "select 1", description: "d" }, PICKUP), deps)).status, 401);
});

test("pickup: returns the next git action for Alex's user, or null", async () => {
  const { deps, calls } = fakes();
  const body = await (await handle(helper("pickup"), deps)).json();
  assert.deepEqual(body, { ok: true, action: { ...PICKED, kind: "git" }, timed_out: [] });
  assert.equal(calls.picked, USER);
  assert.equal(calls.pickedHelper, undefined);
  const none = fakes({ pickupGit: async () => null });
  assert.equal((await (await handle(helper("pickup"), none.deps)).json()).action, null);
});

test("pickup: a pick with no result for 30 minutes is failed first, so its project's queue moves", async () => {
  const now = Date.parse("2026-11-05T09:00:00Z");
  const { deps, calls } = fakes({ stalePicks: async (u, before) => (calls.staleBefore = before, [
    { action_id: "old-1", run_id: "run-old" }, { action_id: "old-2", run_id: null },
  ]) });
  const body = await (await handle(helper("pickup"), deps, now)).json();
  assert.equal(calls.staleBefore, "2026-11-05T08:30:00.000Z");
  assert.deepEqual(body.timed_out, ["old-1", "old-2"]);
  assert.deepEqual(calls.status, [{ id: "old-1", status: "failed" }, { id: "old-2", status: "failed" }]);
  assert.equal(calls.finished.length, 1);
  assert.equal(calls.finished[0].id, "run-old");
  assert.match(calls.finished[0].summary, /timed out/);
  assert.equal(calls.finished[0].result.ok, false);
  assert.equal(body.action.action_id, "git-1");
});

test("result: closes the run and marks the action succeeded or failed", async () => {
  for (const ok of [true, false]) {
    const { deps, calls } = fakes();
    const res = await handle(helper("result", result({ ok, exit_code: ok ? 0 : 1, output: "x".repeat(9000) })), deps);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, ok ? "succeeded" : "failed");
    assert.deepEqual(calls.status, [{ id: "git-1", status: ok ? "succeeded" : "failed" }]);
    assert.equal(calls.finished[0].id, "run-g");
    assert.equal(calls.finished[0].summary, "gitsync: merged main");
    assert.equal(calls.finished[0].result.ok, ok);
    assert.equal(calls.finished[0].result.output.length, 8000);
    assert.ok(calls.finished[0].finished_at);
  }
});

test("result: bad input is refused and changes nothing", async () => {
  for (const body of [result({ action_id: "" }), result({ run_id: undefined }), result({ ok: "yes" }),
    result({ summary: "" }), result({ summary: "a\nb" }), result({ summary: "s".repeat(301) }), result({ exit_code: 1.5 })]) {
    const { deps, calls } = fakes();
    assert.equal((await handle(helper("result", body), deps)).status, 400);
    assert.deepEqual(calls.status, []);
  }
});

test("result: only for a pick still waiting, with its own run", async () => {
  const base = { id: "git-1", user_id: USER, kind: "git", status: "consumed", picked_up_at: "t" };
  const run = { id: "run-g", action_id: "git-1", mode: "real", finished_at: null };
  for (const [picked, status] of [
    [null, 404],
    [{ action: { ...base, kind: "sql" }, run }, 404],
    [{ action: { ...base, user_id: "someone-else" }, run }, 404],
    [{ action: base, run: null }, 404],
    [{ action: base, run: { ...run, action_id: "other" } }, 404],
    [{ action: { ...base, status: "failed" }, run }, 409],
    [{ action: { ...base, picked_up_at: null }, run }, 409],
    [{ action: base, run: { ...run, finished_at: "t" } }, 409],
    [{ action: base, run: { ...run, mode: "dry_run" } }, 409],
  ]) {
    const { deps, calls } = fakes({ findPicked: async () => picked });
    assert.equal((await handle(helper("result", result()), deps)).status, status);
    assert.deepEqual(calls.status, []);
    assert.equal(calls.finished, undefined);
  }
});

test("helper routes: POST only, and no browser preflight", async () => {
  const { deps } = fakes();
  assert.equal((await handle(new Request("https://x/switchboard-runner/pickup", { method: "GET" }), deps)).status, 405);
  const pre = await handle(new Request("https://x/switchboard-runner/pickup", { method: "OPTIONS" }), deps);
  assert.equal(pre.headers.get("access-control-allow-origin"), null);
});

// --- git links (spec 11.3) ---

const GIT_PAYLOAD = { command: "gitpush", mode: "finish", finish: "phase" };
function gitFakes(over = {}) {
  const f = fakes({ hasCleanDryRun: async () => false, latestDryRun: async () => null, ...over });
  Object.assign(f.action, { kind: "git", payload: GIT_PAYLOAD });
  return f;
}
const nothingRan = (calls) => {
  assert.equal(calls.runSql.length, 0);
  assert.equal(calls.runs.length, 0);
};

test("git preview: kind and payload, no SQL, nothing spent", async () => {
  const { deps, calls } = gitFakes();
  const out = await (await handle(post("preview", { token: TOKEN }, jwt()), deps)).json();
  assert.equal(out.kind, "git");
  assert.deepEqual(out.payload, GIT_PAYLOAD);
  assert.equal(out.sql, undefined);
  assert.equal(out.fingerprint, "fp-1");
  assert.equal(out.project_code, "p-x");
  assert.equal(calls.consumed.length, 0);
  nothingRan(calls);
});

test("git approve: no dry run needed; spends the link with the fingerprint and runs nothing", async () => {
  const { deps, calls } = gitFakes();
  const res = await handle(post("approve", { token: TOKEN, fingerprint: "fp-1" }, jwt()), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, action_id: "act-1", sent: true });
  assert.deepEqual(calls.consumed, [{ jwt: "good", token: TOKEN, fp: "fp-1" }]);
  assert.deepEqual(calls.status, []);
  nothingRan(calls);
});

test("git approve: no fingerprint, a mismatch, an expired or a used link is refused", async () => {
  const a = gitFakes();
  assert.equal((await handle(post("approve", { token: TOKEN }, jwt()), a.deps)).status, 400);
  assert.equal(a.calls.consumed.length, 0);

  const b = gitFakes({ consume: async () => { throw new Error("switchboard_consume_link: the SQL does not match what this link approved."); } });
  const mis = await handle(post("approve", { token: TOKEN, fingerprint: "other" }, jwt()), b.deps);
  assert.equal(mis.status, 409);
  assert.match((await mis.json()).error, /does not match/);

  const c = gitFakes();
  c.action.link_expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal((await handle(post("approve", { token: TOKEN, fingerprint: "fp-1" }, jwt()), c.deps)).status, 410);
  c.action.link_expires_at = new Date(Date.now() + 60000).toISOString();
  c.action.link_used_at = new Date().toISOString();
  const used = await handle(post("approve", { token: TOKEN, fingerprint: "fp-1" }, jwt()), c.deps);
  assert.equal(used.status, 410);
  assert.match((await used.json()).error, /already been used/);
  assert.equal(c.calls.consumed.length, 0);
  for (const x of [a, b, c]) nothingRan(x.calls);
});

test("git cancel: no dry run needed; spends the link and marks it cancelled", async () => {
  const { deps, calls } = gitFakes();
  const out = await (await handle(post("cancel", { token: TOKEN, reason: " not  now " }, jwt()), deps)).json();
  assert.deepEqual(out, { ok: true, action_id: "act-1", cancelled: true, reason: "not now" });
  assert.deepEqual(calls.consumed, [{ jwt: "good", token: TOKEN, fp: "fp-1" }]);
  assert.deepEqual(calls.status, [{ id: "act-1", status: "cancelled" }]);
  nothingRan(calls);
});

test("git dry run: refused, nothing spent", async () => {
  const { deps, calls } = gitFakes();
  assert.equal((await handle(post("dry-run", { token: TOKEN }, jwt()), deps)).status, 409);
  assert.equal(calls.consumed.length, 0);
  nothingRan(calls);
});

test("sql with kind sql keeps its clean-dry-run rule, and cancel still needs a dry run", async () => {
  const { deps, calls, action } = fakes({ hasCleanDryRun: async () => false, latestDryRun: async () => null });
  action.kind = "sql";
  assert.equal((await handle(post("approve", { token: TOKEN, fingerprint: "fp-1" }, jwt()), deps)).status, 409);
  assert.equal((await handle(post("cancel", { token: TOKEN }, jwt()), deps)).status, 409);
  assert.equal(calls.consumed.length, 0);
  const preview = await (await handle(post("preview", { token: TOKEN }, jwt()), deps)).json();
  assert.equal(preview.sql, "delete from wb_rules where id = 1;");
  assert.equal(preview.kind, undefined);
});

// --- helper kinds (spec 11.4-11.6) ---

const ALL_KINDS = ["git", "sf_check", "sb_setup"];

test("pickup: an old helper with no kinds, or only git, gets git from pickup_git and never the helper pickup", async () => {
  for (const req of [helper("pickup"), helper("pickup", { kinds: ["git"] }), helper("pickup", { kinds: null }),
    new Request("https://x/switchboard-runner/pickup", { method: "POST", headers: { "x-switchboard-pickup-key": PICKUP } })]) {
    const { deps, calls } = fakes();
    const body = await (await handle(req, deps)).json();
    assert.equal(body.action.kind, "git");
    assert.equal(calls.picked, USER);
    assert.equal(calls.pickedHelper, undefined);
  }
});

test("pickup: all three kinds use the helper pickup and return its kind", async () => {
  const { deps, calls } = fakes();
  const body = await (await handle(helper("pickup", { kinds: ["sb_setup", "git", "sf_check"] }), deps)).json();
  assert.equal(body.action.kind, "sf_check");
  assert.equal(calls.pickedHelper, USER);
  assert.equal(calls.picked, undefined);
  const none = fakes({ pickupHelper: async () => null });
  assert.equal((await (await handle(helper("pickup", { kinds: ALL_KINDS }), none.deps)).json()).action, null);
});

test("pickup: a part of the kinds, an unknown kind or a malformed list is refused and picks nothing", async () => {
  for (const kinds of [["git", "sf_check"], ["sf_check"], ["sb_setup"], ["git", "sql"], ["docs"], [], "git", [1], {}]) {
    const { deps, calls } = fakes({ stalePicks: async () => { throw new Error("not reached"); } });
    const res = await handle(helper("pickup", { kinds }), deps);
    assert.equal(res.status, 400, JSON.stringify(kinds));
    assert.match((await res.json()).error, /kinds/);
    assert.equal(calls.picked, undefined);
    assert.equal(calls.pickedHelper, undefined);
  }
});

test("pickup: the 30-minute rule runs before the helper pickup too", async () => {
  const now = Date.parse("2026-11-05T09:00:00Z");
  const { deps, calls } = fakes({ stalePicks: async (u, before) => (calls.staleBefore = before, [{ action_id: "sf-old", run_id: "run-sf" }]) });
  const body = await (await handle(helper("pickup", { kinds: ALL_KINDS }), deps, now)).json();
  assert.equal(calls.staleBefore, "2026-11-05T08:30:00.000Z");
  assert.deepEqual(body.timed_out, ["sf-old"]);
  assert.deepEqual(calls.status, [{ id: "sf-old", status: "failed" }]);
  assert.match(calls.finished[0].summary, /timed out/);
});

test("result: sf_check and sb_setup are accepted like git; sql and other kinds are not", async () => {
  for (const kind of ["sf_check", "sb_setup"]) {
    for (const ok of [true, false]) {
      const { deps, calls } = fakes({ findPicked: async () => ({
        action: { id: "git-1", user_id: USER, kind, status: "consumed", picked_up_at: "t" },
        run: { id: "run-g", action_id: "git-1", mode: "real", finished_at: null },
      }) });
      const res = await handle(helper("result", result({ ok, output: "out" })), deps);
      assert.equal(res.status, 200, kind);
      assert.deepEqual(calls.status, [{ id: "git-1", status: ok ? "succeeded" : "failed" }]);
      assert.equal(calls.finished[0].result.output, "out");
    }
  }
  for (const kind of ["sql", "sf_deploy", "docs", undefined]) {
    const { deps, calls } = fakes({ findPicked: async () => ({
      action: { id: "git-1", user_id: USER, kind, status: "consumed", picked_up_at: "t" },
      run: { id: "run-g", action_id: "git-1", mode: "real", finished_at: null },
    }) });
    assert.equal((await handle(helper("result", result()), deps)).status, 404, String(kind));
    assert.deepEqual(calls.status, []);
  }
});

const SB_PAYLOAD = { command: "org add", client: "acme", orgs: [{ alias: "acme-dev", type: "developer", level: "objects" }] };
const sbFakes = (over = {}) => {
  const f = gitFakes(over);
  Object.assign(f.action, { kind: "sb_setup", payload: SB_PAYLOAD });
  return f;
};

test("sb_setup preview: kind and payload, nothing spent", async () => {
  const { deps, calls } = sbFakes();
  const out = await (await handle(post("preview", { token: TOKEN }, jwt()), deps)).json();
  assert.equal(out.kind, "sb_setup");
  assert.deepEqual(out.payload, SB_PAYLOAD);
  assert.equal(out.sql, undefined);
  assert.equal(calls.consumed.length, 0);
  nothingRan(calls);
});

test("sb_setup approve: no dry run, spends the link with the fingerprint for pickup; cancel marks it cancelled", async () => {
  const a = sbFakes();
  assert.equal((await handle(post("approve", { token: TOKEN }, jwt()), a.deps)).status, 400);
  const res = await handle(post("approve", { token: TOKEN, fingerprint: "fp-1" }, jwt()), a.deps);
  assert.deepEqual(await res.json(), { ok: true, action_id: "act-1", sent: true });
  assert.deepEqual(a.calls.consumed, [{ jwt: "good", token: TOKEN, fp: "fp-1" }]);
  assert.deepEqual(a.calls.status, []);
  const b = sbFakes();
  const out = await (await handle(post("cancel", { token: TOKEN }, jwt()), b.deps)).json();
  assert.equal(out.cancelled, true);
  assert.deepEqual(b.calls.status, [{ id: "act-1", status: "cancelled" }]);
  for (const x of [a, b]) nothingRan(x.calls);
});

test("sb_setup dry run: refused, nothing spent", async () => {
  const { deps, calls } = sbFakes();
  const res = await handle(post("dry-run", { token: TOKEN }, jwt()), deps);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /sb_setup action has no dry run/);
  assert.equal(calls.consumed.length, 0);
});

const SF_PAYLOAD = { check: "limits", alias: "acme-dev" };
const sfFakes = (over = {}) => {
  const f = gitFakes(over);
  Object.assign(f.action, { kind: "sf_check", payload: SF_PAYLOAD });
  return f;
};

test("sf_check preview: kind and payload, nothing spent (s86pa)", async () => {
  const { deps, calls } = sfFakes();
  const out = await (await handle(post("preview", { token: TOKEN }, jwt()), deps)).json();
  assert.equal(out.kind, "sf_check");
  assert.deepEqual(out.payload, SF_PAYLOAD);
  assert.equal(out.sql, undefined);
  assert.equal(out.fingerprint, "fp-1");
  assert.equal(calls.consumed.length, 0);
  nothingRan(calls);
});

test("sf_check approve: spends the link with the fingerprint for pickup; cancel marks it cancelled", async () => {
  const a = sfFakes();
  assert.equal((await handle(post("approve", { token: TOKEN }, jwt()), a.deps)).status, 400);
  const res = await handle(post("approve", { token: TOKEN, fingerprint: "fp-1" }, jwt()), a.deps);
  assert.deepEqual(await res.json(), { ok: true, action_id: "act-1", sent: true });
  assert.deepEqual(a.calls.consumed, [{ jwt: "good", token: TOKEN, fp: "fp-1" }]);
  assert.deepEqual(a.calls.status, []);
  const b = sfFakes();
  const out = await (await handle(post("cancel", { token: TOKEN, reason: "not now" }, jwt()), b.deps)).json();
  assert.deepEqual([out.cancelled, out.reason], [true, "not now"]);
  assert.deepEqual(b.calls.status, [{ id: "act-1", status: "cancelled" }]);
  for (const x of [a, b]) nothingRan(x.calls);
});

test("sf_check dry run: refused, nothing spent", async () => {
  const { deps, calls } = sfFakes();
  const res = await handle(post("dry-run", { token: TOKEN }, jwt()), deps);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /sf_check action has no dry run/);
  assert.equal(calls.consumed.length, 0);
  nothingRan(calls);
});

// s86ac: stakes from switchboard_stakes; none in the preview while that function is missing.
const previewOf = async (deps) => (await handle(post("preview", { token: TOKEN }, jwt()), deps)).json();

test("preview stakes: asked with the action's kind and payload, for sql and helper kinds", async () => {
  const seen = [];
  const stakes = async (kind, payload) => (seen.push([kind, payload]), kind === "sf_check" ? "none" : "change");
  assert.equal((await previewOf(fakes({ stakes }).deps)).stakes, "change");
  assert.equal((await previewOf(sfFakes({ stakes }).deps)).stakes, "none");
  assert.deepEqual(seen, [["sql", { sql: "delete from wb_rules where id = 1;" }], ["sf_check", SF_PAYLOAD]]);
});

test("preview stakes: left out when the function is missing, fails or says something else", async () => {
  for (const stakes of [async () => null, async () => { throw new Error("function does not exist"); }, async () => "green", undefined]) {
    for (const f of [fakes({ stakes }), sfFakes({ stakes })]) {
      const res = await handle(post("preview", { token: TOKEN }, jwt()), f.deps);
      assert.equal(res.status, 200);
      const out = await res.json();
      assert.equal(out.ok, true);
      assert.ok(!("stakes" in out));
    }
  }
});

test("other kinds with a link are refused, not read as SQL", async () => {
  const { deps, calls, action } = fakes();
  action.kind = "sf_deploy";
  const res = await handle(post("dry-run", { token: TOKEN }, jwt()), deps);
  assert.equal(res.status, 409);
  assert.equal(calls.runSql.length, 0);
});

// --- s89e: Salesforce reads (spec 10) ---

const READ_PAYLOAD = { alias: "cd-prod", production: true, level: "data", object: "Contribution__c", fields: ["Id", "Status__c"],
  limit: 50, filters: [{ field: "Status__c", op: "=", value: "Failed" }] };
/** A picked sf_read waiting for its result, with the read's deps recorded. */
function readFakes({ payload = READ_PAYLOAD, enabled = true, conflict = false, picked = {}, run = {} } = {}) {
  return fakes({
    findPicked: async (a, r) => (a === "rd-1" && r === "run-r" ? {
      action: { id: "rd-1", user_id: USER, kind: "sf_read", status: "consumed", picked_up_at: "t", payload, ...picked },
      run: { id: "run-r", action_id: "rd-1", mode: "real", finished_at: null, ...run },
    } : null),
    sfReadsEnabled: async (u) => (u === USER ? enabled : false),
    insertSfResult: async function (row) { (this.stored ??= []).push(row); return { conflict }; },
    logSfRead: async function (row) { (this.logged ??= []).push(row); },
  });
}
const rowsBody = (over = {}) => ({ action_id: "rd-1", run_id: "run-r", ok: true, summary: "sf read data Contribution__c on cd-prod: 2 rows",
  level: "data", object: "Contribution__c", production_full_data: true, count: 2,
  rows: [{ Id: "a0B000000000001AAA", Status__c: "Failed" }, { Id: "a0B000000000002AAA", Status__c: "Failed" }], ...over });

test("pickup: all four kinds, sf_read too, use the helper pickup; the older three still do", async () => {
  for (const kinds of [["git", "sf_check", "sb_setup", "sf_read"], ["sf_read", "sb_setup", "git", "sf_check"], ALL_KINDS]) {
    const { deps, calls } = fakes();
    assert.equal((await handle(helper("pickup", { kinds }), deps)).status, 200, JSON.stringify(kinds));
    assert.equal(calls.pickedHelper, USER);
  }
  for (const kinds of [["sf_read"], ["git", "sf_read"], ["git", "sf_check", "sf_read"]]) {
    const { deps, calls } = fakes();
    assert.equal((await handle(helper("pickup", { kinds }), deps)).status, 400, JSON.stringify(kinds));
    assert.equal(calls.pickedHelper, undefined);
  }
});

test("sf-result: stores the rows and the stamp, logs ran with no rows, and leaves the run for /result", async () => {
  const { deps, calls } = readFakes();
  const res = await handle(helper("sf-result", rowsBody({ query: "SELECT Id, Status__c FROM Contribution__c LIMIT 50" })), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, action_id: "rd-1", stored: true, row_count: 2, truncated: false });
  assert.equal(deps.stored.length, 1);
  assert.deepEqual(deps.stored[0], { user_id: USER, action_id: "rd-1", rows: rowsBody().rows, row_count: 2, truncated: false, production_full_data: true });
  assert.equal(deps.logged.length, 1);
  const log = deps.logged[0];
  assert.equal(log.stage, "ran");
  assert.equal(log.row_count, 2);
  assert.equal(log.org_alias, "cd-prod");
  assert.equal(log.object, "Contribution__c");
  assert.deepEqual(log.fields, ["Id", "Status__c"]);
  assert.equal(log.query_text, "SELECT Id, Status__c FROM Contribution__c LIMIT 50");
  assert.equal(JSON.stringify(log).includes("a0B000000000001AAA"), false);
  assert.equal(calls.finished, undefined);
  assert.deepEqual(calls.status, []);
});

test("sf-result: a count read keeps the count; rows are capped at 1000 and marked truncated", async () => {
  const counted = readFakes({ payload: { alias: "ab-dev", production: false, level: "ids", object: "Contact", count: true } });
  await handle(helper("sf-result", rowsBody({ rows: [], count: 4213, production_full_data: false })), counted.deps);
  assert.equal(counted.deps.stored[0].row_count, 4213);
  assert.equal(counted.deps.stored[0].production_full_data, false);
  assert.equal(counted.deps.logged[0].query_text, null);

  const many = readFakes();
  const rows = Array.from({ length: 1005 }, (_, i) => ({ Id: `r${i}` }));
  const out = await (await handle(helper("sf-result", rowsBody({ rows, count: 1005 })), many.deps)).json();
  assert.equal(many.deps.stored[0].rows.length, 1000);
  assert.equal(many.deps.stored[0].truncated, true);
  assert.equal(out.truncated, true);
});

test("sf-result: the stamp comes from the payload too, so production full data is never unstamped", async () => {
  const { deps } = readFakes();
  await handle(helper("sf-result", rowsBody({ production_full_data: false })), deps);
  assert.equal(deps.stored[0].production_full_data, true);
  const sandbox = readFakes({ payload: { ...READ_PAYLOAD, production: false } });
  await handle(helper("sf-result", rowsBody({ production_full_data: false })), sandbox.deps);
  assert.equal(sandbox.deps.stored[0].production_full_data, false);
});

test("sf-result: a failed read stores nothing and logs failed with ids and emails blanked", async () => {
  const { deps } = readFakes();
  const res = await handle(helper("sf-result", { action_id: "rd-1", run_id: "run-r", ok: false, summary: "sf read refused",
    reason: "org 00D5e000000AbCdEAB is production but alex@example.com's entry says sandbox" }), deps);
  assert.deepEqual(await res.json(), { ok: true, action_id: "rd-1", stored: false });
  assert.equal(deps.stored, undefined);
  assert.equal(deps.logged[0].stage, "failed");
  assert.equal(deps.logged[0].error, "org [id] is production but [email]'s entry says sandbox");
});

test("sf-result: the kill switch refuses, stores nothing and logs failed", async () => {
  const { deps } = readFakes({ enabled: false });
  const res = await handle(helper("sf-result", rowsBody()), deps);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /sf_reads_enabled/);
  assert.equal(deps.stored, undefined);
  assert.equal(deps.logged[0].stage, "failed");
});

test("sf-result: only a waiting sf_read with its own run; a second result is refused", async () => {
  for (const over of [{ picked: { kind: "sf_check" } }, { picked: { user_id: "someone" } }, { run: { action_id: "other" } }]) {
    const { deps } = readFakes(over);
    assert.equal((await handle(helper("sf-result", rowsBody()), deps)).status, 404, JSON.stringify(over));
    assert.equal(deps.stored, undefined);
  }
  for (const over of [{ picked: { status: "succeeded" } }, { picked: { picked_up_at: null } }, { run: { finished_at: "t" } }, { run: { mode: "dry_run" } }]) {
    const { deps } = readFakes(over);
    assert.equal((await handle(helper("sf-result", rowsBody()), deps)).status, 409, JSON.stringify(over));
    assert.equal(deps.stored, undefined);
  }
  const unknown = readFakes();
  assert.equal((await handle(helper("sf-result", rowsBody({ action_id: "nope" })), unknown.deps)).status, 404);
  const twice = readFakes({ conflict: true });
  const res = await handle(helper("sf-result", rowsBody()), twice.deps);
  assert.equal(res.status, 409);
  assert.equal(twice.deps.logged, undefined);
});

test("sf-result: no key or a wrong one, and bad input, are refused before any read", async () => {
  for (const key of [null, "wrong", SECRET]) {
    const { deps } = readFakes();
    assert.equal((await handle(helper("sf-result", rowsBody(), key), deps)).status, 401);
  }
  for (const over of [{ action_id: undefined }, { run_id: "" }, { ok: "yes" }, { summary: "" }, { summary: "a\nb" },
    { rows: "x" }, { rows: [1, 2] }, { rows: [[]] }, { count: -1 }, { count: 1.5 }]) {
    const { deps } = readFakes({ picked: { kind: "not reached" } });
    assert.equal((await handle(helper("sf-result", rowsBody(over)), deps)).status, 400, JSON.stringify(over));
    assert.equal(deps.stored, undefined);
    assert.equal(deps.logged, undefined);
  }
});

test("result: an sf_read's run keeps its summary and never the window's output", async () => {
  const { deps, calls } = readFakes();
  const res = await handle(helper("result", { action_id: "rd-1", run_id: "run-r", ok: true, summary: "sf read: 2 rows", exit_code: 0,
    output: "Result: sf read data Contribution__c on cd-prod: 2 rows." }), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(calls.finished[0].result, { ok: true, exit_code: 0 });
  assert.deepEqual(calls.status, [{ id: "rd-1", status: "succeeded" }]);
});

test("sf_read link: preview has kind and payload; approve only spends the link", async () => {
  const { deps, calls, action } = gitFakes();
  Object.assign(action, { kind: "sf_read", payload: READ_PAYLOAD });
  const preview = await (await handle(post("preview", { token: TOKEN }, jwt()), deps)).json();
  assert.equal(preview.kind, "sf_read");
  assert.deepEqual(preview.payload, READ_PAYLOAD);
  const res = await handle(post("approve", { token: TOKEN, fingerprint: "fp-1" }, jwt()), deps);
  assert.deepEqual(await res.json(), { ok: true, action_id: "act-1", sent: true });
  nothingRan(calls);
});
