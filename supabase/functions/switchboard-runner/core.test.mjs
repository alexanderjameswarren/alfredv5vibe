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
  assert.deepEqual(body, { ok: true, action: PICKED, timed_out: [] });
  assert.equal(calls.picked, USER);
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
