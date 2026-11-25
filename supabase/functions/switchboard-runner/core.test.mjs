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

// --- sb3_runner-r4q r4: the pickup id and the pending route ---

const PID = "0b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3";

test("pickup: a pickup_id goes to pickup_git, and to the helper pickup with its kinds", async () => {
  const git = fakes({ pickupGit: async (...args) => (git.calls.args = args, PICKED) });
  await handle(helper("pickup", { pickup_id: PID }), git.deps);
  assert.deepEqual(git.calls.args, [USER, PID]);
  const all = ["git", "sf_check", "sb_setup", "sf_read", "sf_dataop", "sf_dataquery", "sf_datawrite"];
  const h = fakes({ pickupHelper: async (...args) => (h.calls.args = args, { ...PICKED, kind: "sf_read" }) });
  const body = await (await handle(helper("pickup", { kinds: all, pickup_id: PID }), h.deps)).json();
  assert.deepEqual(h.calls.args, [USER, all, PID]);
  assert.equal(body.action.kind, "sf_read");
  // The older sets, whose kinds are not passed on, still get the id, written in lower case.
  const old = fakes({ pickupHelper: async (...args) => (old.calls.args = args, { ...PICKED, kind: "git" }) });
  await handle(helper("pickup", { kinds: ALL_KINDS, pickup_id: PID.toUpperCase() }), old.deps);
  assert.deepEqual(old.calls.args, [USER, undefined, PID]);
});

test("pickup: no pickup_id, or null, calls both pickups as before", async () => {
  for (const body of [{}, { pickup_id: null }]) {
    const git = fakes({ pickupGit: async (...args) => (git.calls.args = args, PICKED) });
    await handle(helper("pickup", body), git.deps);
    assert.deepEqual(git.calls.args, [USER]);
    const h = fakes({ pickupHelper: async (...args) => (h.calls.args = args, { ...PICKED, kind: "git" }) });
    await handle(helper("pickup", { ...body, kinds: ALL_KINDS }), h.deps);
    assert.deepEqual(h.calls.args, [USER]);
  }
});

test("pickup: a pickup_id that is not a uuid is refused with its fix, before anything is failed or picked", async () => {
  for (const pickup_id of ["", "abc", 42, true, [PID], { id: PID }, `${PID}x`, PID.replace(/-/g, "")]) {
    const { deps, calls } = fakes({ stalePicks: async () => { throw new Error("not reached"); } });
    const res = await handle(helper("pickup", { pickup_id }), deps);
    assert.equal(res.status, 400, JSON.stringify(pickup_id));
    const { error } = await res.json();
    assert.match(error, /^pickup_id: .+ — .+/);
    assert.equal(calls.picked, undefined);
    assert.deepEqual(calls.status, []);
  }
});

const PENDING_NOW = Date.parse("2026-11-23T12:00:00Z");
const ago = (min) => new Date(PENDING_NOW - min * 60000).toISOString();
const pendingFakes = (rows) => {
  const f = fakes({
    pendingActions: async (u) => (f.calls.pendingUser = u, rows),
    stalePicks: async () => { throw new Error("pending must not fail picks"); },
    pickupGit: async () => { throw new Error("pending must not pick"); },
    pickupHelper: async () => { throw new Error("pending must not pick"); },
  });
  return f;
};

test("pending: refused without the pickup key, POST only", async () => {
  for (const key of [null, "wrong", SECRET]) {
    const { deps } = pendingFakes({ unpicked: [], picked: [] });
    assert.equal((await handle(helper("pending", {}, key), deps)).status, 401);
  }
  const { deps } = pendingFakes({ unpicked: [], picked: [] });
  assert.equal((await handle(new Request("https://x/switchboard-runner/pending", { method: "GET" }), deps)).status, 405);
});

test("pending: nothing approved or running is clear", async () => {
  const { deps, calls } = pendingFakes({ unpicked: [], picked: [] });
  const res = await handle(helper("pending"), deps, PENDING_NOW);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, clear: true, unpicked: [], unreported: [] });
  assert.equal(calls.pendingUser, USER);
  assert.deepEqual(calls.status, []);
  assert.equal(calls.finished, undefined);
});

test("pending: lists unpicked links and unreported runs with ids and kinds", async () => {
  const { deps, calls } = pendingFakes({
    unpicked: [
      { id: "a-new", kind: "git", project_code: "p-a", status: "consumed", link_used_at: ago(5), created_at: ago(20) },
      { id: "a-old", kind: "sf_read", project_code: "sf-x", status: "consumed", link_used_at: ago(16), created_at: ago(30) },
      { id: "a-nolink", kind: "git", project_code: "p-b", status: "consumed", link_used_at: null, created_at: ago(3) },
    ],
    picked: [
      { id: "r-git", kind: "git", project_code: "p-c", picked_up_at: ago(10), run_id: "run-1" },
      { id: "r-old", kind: "sb_setup", project_code: "sb-y", picked_up_at: ago(31), run_id: "run-2" },
      { id: "r-dw", kind: "sf_datawrite", project_code: "p-d", picked_up_at: ago(120), run_id: null },
    ],
  });
  const body = await (await handle(helper("pending"), deps, PENDING_NOW)).json();
  assert.deepEqual(body, {
    ok: true,
    clear: false,
    unpicked: [
      { action_id: "a-new", kind: "git", project_code: "p-a", status: "consumed", approved_at: ago(5), stale: false },
      { action_id: "a-old", kind: "sf_read", project_code: "sf-x", status: "consumed", approved_at: ago(16), stale: true },
      { action_id: "a-nolink", kind: "git", project_code: "p-b", status: "consumed", approved_at: ago(3), stale: false },
    ],
    unreported: [
      { action_id: "r-git", run_id: "run-1", kind: "git", project_code: "p-c", picked_up_at: ago(10), stale: false },
      { action_id: "r-old", run_id: "run-2", kind: "sb_setup", project_code: "sb-y", picked_up_at: ago(31), stale: true },
      { action_id: "r-dw", run_id: null, kind: "sf_datawrite", project_code: "p-d", picked_up_at: ago(120), stale: false },
    ],
  });
  assert.deepEqual(calls.status, []);
});

test("pending: only stale unpicked links left is clear; any unreported run blocks, stale or not", async () => {
  const stale = [
    { id: "a-old", kind: "git", project_code: "p-a", status: "consumed", link_used_at: ago(15.5), created_at: ago(40) },
    { id: "q-old", kind: "sf_check", project_code: "sf-q", status: "queued", link_used_at: null, created_at: ago(10.5) },
  ];
  const only = await (await handle(helper("pending"), pendingFakes({ unpicked: stale, picked: [] }).deps, PENDING_NOW)).json();
  assert.equal(only.clear, true);
  assert.deepEqual(only.unpicked.map((e) => e.stale), [true, true]);
  // A pick past its 4-hour limit may still be running in the helper: it blocks.
  const picked = [{ id: "r-old", kind: "sf_dataop", project_code: "p-d", picked_up_at: ago(241), run_id: "run-9" }];
  const running = await (await handle(helper("pending"), pendingFakes({ unpicked: stale, picked }).deps, PENDING_NOW)).json();
  assert.equal(running.clear, false);
  assert.equal(running.unreported[0].stale, true);
});

test("pending: the limits match the server's, strictly past them", async () => {
  const { deps } = pendingFakes({
    unpicked: [
      { id: "a-15", kind: "git", project_code: "p-a", status: "consumed", link_used_at: ago(15), created_at: ago(40) },
      { id: "q-9", kind: "git", project_code: "p-q", status: "queued", link_used_at: null, created_at: ago(9) },
    ],
    picked: [
      { id: "r-30", kind: "git", project_code: "p-c", picked_up_at: ago(30), run_id: "run-1" },
      { id: "r-dq", kind: "sf_dataquery", project_code: "p-d", picked_up_at: ago(31), run_id: "run-2" },
      { id: "r-dw", kind: "sf_datawrite", project_code: "p-e", picked_up_at: ago(240.5), run_id: "run-3" },
    ],
  });
  const body = await (await handle(helper("pending"), deps, PENDING_NOW)).json();
  assert.deepEqual(body.unpicked.map((e) => [e.action_id, e.stale]), [["a-15", false], ["q-9", false]]);
  assert.equal(body.unpicked[1].approved_at, ago(9));
  assert.deepEqual(body.unreported.map((e) => [e.action_id, e.stale]), [["r-30", false], ["r-dq", false], ["r-dw", true]]);
  assert.equal(body.clear, false);
});

test("pickup: a bad kinds list is refused before a bad pickup_id", async () => {
  const { deps } = fakes();
  const res = await handle(helper("pickup", { kinds: ["nope"], pickup_id: "abc" }), deps);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /^kinds must/);
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

// --- dataops_alfred-d4x: sf_dataop, the production data run by link only ---

const FIVE = ["git", "sf_check", "sb_setup", "sf_read", "sf_dataop"];
const DATAOP_PAYLOAD = { alias: "cd-prod", repo: "C:\\Users\\Alex\\projects\\common-defense", plan: "dataops/fixc-plan.json",
  stamp: "0".repeat(64), preflight_at: "2026-11-18T15:00:00Z", object: "Demo_Gift__c",
  problem: "Forty-five gifts were saved without a link to their plan.", expected: 45, write: { kind: "bulk" },
  rows: [{ label: "Gifts in the list with no plan link", before: 45, goal: 0 }] };
const kindsFakes = () => fakes({ pickupHelper: async function (u, k) { this.args = [u, k]; return { ...PICKED, kind: "sf_dataop" }; } });

test("pickup: only a helper naming all five kinds passes them on, so only it can be handed an sf_dataop", async () => {
  const all = kindsFakes();
  const body = await (await handle(helper("pickup", { kinds: [...FIVE].reverse() }), all.deps)).json();
  assert.equal(body.action.kind, "sf_dataop");
  assert.deepEqual(all.deps.args, [USER, FIVE]);
  for (const kinds of [["git", "sf_check", "sb_setup", "sf_read"], ["git", "sf_check", "sb_setup"]]) {
    const older = kindsFakes();
    assert.equal((await handle(helper("pickup", { kinds }), older.deps)).status, 200, JSON.stringify(kinds));
    assert.deepEqual(older.deps.args, [USER, undefined], JSON.stringify(kinds));
  }
});

test("pickup: sf_dataop with only some of the kinds is refused and picks nothing", async () => {
  for (const kinds of [["sf_dataop"], ["git", "sf_dataop"], ["git", "sf_check", "sb_setup", "sf_dataop"], ["sf_read", "sf_dataop"]]) {
    const { deps, calls } = fakes({ stalePicks: async () => { throw new Error("not reached"); } });
    const res = await handle(helper("pickup", { kinds }), deps);
    assert.equal(res.status, 400, JSON.stringify(kinds));
    assert.equal(calls.pickedHelper, undefined);
  }
});

test("pickup: a picked sf_dataop gets 4 hours before it is failed, every other kind 30 minutes", async () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  const { deps, calls } = fakes({ stalePicks: async (u, before, dataopBefore) => (calls.stale = { before, dataopBefore }, []) });
  await handle(helper("pickup", { kinds: FIVE }), deps, now);
  assert.deepEqual(calls.stale, { before: "2026-11-18T11:30:00.000Z", dataopBefore: "2026-11-18T08:00:00.000Z" });
});

test("result: an sf_dataop's run keeps its summary and never the window's output (O8)", async () => {
  const { deps, calls } = fakes({
    findPicked: async (a, r) => (a === "dop-1" && r === "run-d" ? {
      action: { id: "dop-1", user_id: USER, kind: "sf_dataop", status: "consumed", picked_up_at: "t", payload: DATAOP_PAYLOAD },
      run: { id: "run-d", action_id: "dop-1", mode: "real", finished_at: null },
    } : null),
  });
  const res = await handle(helper("result", { action_id: "dop-1", run_id: "run-d", ok: false, summary: "dataop stopped at step 2",
    exit_code: 1, output: "Step 2 already changed 30 live records. Backup: C:\\x" }), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(calls.finished[0].result, { ok: false, exit_code: 1 });
  assert.equal(calls.finished[0].summary, "dataop stopped at step 2");
  assert.deepEqual(calls.status, [{ id: "dop-1", status: "failed" }]);
});

test("sf_dataop link: preview shows the payload; approve needs Alex's session and only spends the link", async () => {
  const { deps, calls, action } = gitFakes();
  Object.assign(action, { kind: "sf_dataop", payload: DATAOP_PAYLOAD });
  const preview = await (await handle(post("preview", { token: TOKEN }, jwt()), deps)).json();
  assert.equal(preview.kind, "sf_dataop");
  assert.deepEqual(preview.payload, DATAOP_PAYLOAD);
  // No session, another user's, or a bad one: refused before the link is touched.
  for (const headers of [{}, jwt("other"), jwt("bad")]) {
    const res = await handle(post("approve", { token: TOKEN, fingerprint: "fp-1" }, headers), deps);
    assert.equal(res.status, 401, JSON.stringify(headers));
  }
  assert.equal(calls.consumed.length, 0);
  assert.equal((await handle(post("dry-run", { token: TOKEN }, jwt()), deps)).status, 409);
  assert.equal((await handle(post("approve", { token: TOKEN }, jwt()), deps)).status, 400);
  const res = await handle(post("approve", { token: TOKEN, fingerprint: "fp-1" }, jwt()), deps);
  assert.deepEqual(await res.json(), { ok: true, action_id: "act-1", sent: true });
  assert.equal(calls.consumed.length, 1);
  nothingRan(calls);
});

test("queue: the CLI's route never makes an sf_dataop, whatever the body says", async () => {
  const { deps, calls } = fakes();
  const res = await handle(queue({ project_code: "p-x", sql: "select 1", description: "Reads the number 1.", kind: "sf_dataop",
    payload: DATAOP_PAYLOAD, needs_click: false }), deps);
  assert.equal(res.status, 200);
  assert.equal(calls.inserted[0].kind, "sql");
  assert.equal(calls.inserted[0].created_by, "cli");
  assert.equal("needs_click" in calls.inserted[0], false);
  assert.deepEqual(Object.keys(calls.inserted[0].payload).sort(), ["description", "sql"]);
});

// --- dataop_link-k7d: sf_dataquery, production exports and counts by link ---

const SIX = [...FIVE, "sf_dataquery"];
const DQ_PAYLOAD = { alias: "cd-prod", repo: "C:\\Users\\Alex\\projects\\common-defense", run: "data-ops/cd_fixc-q8d/fixc",
  run_tag: "cd_fixc-q8d-s4-ab12", request_sha256: "0".repeat(64),
  queries: [{ step: "rules", soql: "SELECT COUNT() FROM Contact WHERE A = 1", sha256: "1".repeat(64), label: "One" },
            { step: "rules", soql: "SELECT COUNT() FROM Contact WHERE A = 2", sha256: "2".repeat(64), label: "Two" }] };
const dqFakes = () => fakes({
  findPicked: async (a, r) => (a === "dq-1" && r === "run-q" ? {
    action: { id: "dq-1", user_id: USER, kind: "sf_dataquery", status: "consumed", picked_up_at: "t", payload: DQ_PAYLOAD },
    run: { id: "run-q", action_id: "dq-1", mode: "real", finished_at: null },
  } : null),
});
const dqResult = (body) => helper("result", { action_id: "dq-1", run_id: "run-q", summary: "counts done", ...body });

test("pickup: six kinds are passed on whole; five still get sf_dataop as today; four and three get the default", async () => {
  const six = kindsFakes();
  assert.equal((await handle(helper("pickup", { kinds: [...SIX].reverse() }), six.deps)).status, 200);
  assert.deepEqual(six.deps.args, [USER, SIX]);
  const five = kindsFakes();
  const body = await (await handle(helper("pickup", { kinds: FIVE }), five.deps)).json();
  assert.equal(body.action.kind, "sf_dataop");
  assert.deepEqual(five.deps.args, [USER, FIVE]);
  assert.ok(!five.deps.args[1].includes("sf_dataquery"));
  for (const kinds of [["git", "sf_check", "sb_setup", "sf_read"], ["git", "sf_check", "sb_setup"]]) {
    const older = kindsFakes();
    assert.equal((await handle(helper("pickup", { kinds }), older.deps)).status, 200, JSON.stringify(kinds));
    assert.deepEqual(older.deps.args, [USER, undefined], JSON.stringify(kinds));
  }
});

test("pickup: sf_dataquery with only some of the kinds is refused and picks nothing", async () => {
  for (const kinds of [["sf_dataquery"], ["git", "sf_dataquery"], [...FIVE.filter((k) => k !== "sf_dataop"), "sf_dataquery"]]) {
    const { deps, calls } = fakes({ stalePicks: async () => { throw new Error("not reached"); } });
    const res = await handle(helper("pickup", { kinds }), deps);
    assert.equal(res.status, 400, JSON.stringify(kinds));
    assert.equal(calls.pickedHelper, undefined);
  }
});

test("pickup: the 4-hour limit covers sf_dataop, sf_dataquery and sf_datawrite only; the stale query in index.ts uses LONG_PICK_KINDS", async () => {
  const core = await import("./core.ts");
  // dataop_write-j5w added sf_datawrite; sb3_runner-r4q s4 sf_run.
  assert.deepEqual(core.LONG_PICK_KINDS, ["sf_dataop", "sf_dataquery", "sf_datawrite", "sf_run"]);
  assert.equal(core.DATAOP_PICK_TIMEOUT_MS, 4 * 60 * 60 * 1000);
  assert.equal(core.PICK_TIMEOUT_MS, 30 * 60 * 1000);
  const now = Date.parse("2026-11-19T12:00:00Z");
  const { deps, calls } = fakes({ stalePicks: async (u, before, dataopBefore) => (calls.stale = { before, dataopBefore }, []) });
  await handle(helper("pickup", { kinds: SIX }), deps, now);
  assert.deepEqual(calls.stale, { before: "2026-11-19T11:30:00.000Z", dataopBefore: "2026-11-19T08:00:00.000Z" });
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(src, /HELPER_KINDS\.filter\(\(k\) => !LONG_PICK_KINDS\.includes\(k\)\)/);
  assert.match(src, /\.in\("kind", LONG_PICK_KINDS\)\s*\.eq\("status", "consumed"\)\.lt\("picked_up_at", dataopBefore\)/);
});

test("result: an sf_dataquery keeps only ok, exit_code, query_counts and pass; output dropped; summary scrubbed", async () => {
  const { deps, calls } = dqFakes();
  const res = await handle(dqResult({ ok: true, exit_code: 0, query_counts: [26440, 0], pass: true,
    summary: "2 counts, first record 003000000000001AAA, by alex@example.com", output: "Id,Name\n003000000000001AAA,Jo",
    rows: [{ Id: "003000000000001AAA" }] }), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, action_id: "dq-1", run_id: "run-q", status: "succeeded" });
  assert.deepEqual(calls.finished[0].result, { ok: true, exit_code: 0, query_counts: [26440, 0], pass: true });
  assert.equal(calls.finished[0].summary, "2 counts, first record [id], by [email]");
  assert.deepEqual(calls.status, [{ id: "dq-1", status: "succeeded" }]);
});

test("result: a failed sf_dataquery may leave out query_counts; it keeps pass if sent", async () => {
  for (const [body, want] of [
    [{ ok: false, exit_code: 2 }, { ok: false, exit_code: 2 }],
    [{ ok: false, query_counts: [1, 2], pass: false }, { ok: false, query_counts: [1, 2], pass: false }],
  ]) {
    const { deps, calls } = dqFakes();
    assert.equal((await handle(dqResult(body), deps)).status, 200, JSON.stringify(body));
    assert.deepEqual(calls.finished[0].result, want);
    assert.deepEqual(calls.status, [{ id: "dq-1", status: "failed" }]);
  }
});

test("result: an sf_dataquery report that doesn't fit is refused, and the run closes as failed saying why", async () => {
  for (const [body, why] of [
    [{ ok: true, pass: true }, /must report query_counts/],
    [{ ok: true, query_counts: [1], pass: true }, /1 entries for 2 queries/],
    [{ ok: true, query_counts: [1, 2, 3], pass: true }, /3 entries for 2 queries/],
    [{ ok: true, query_counts: [1, "2"], pass: true }, /whole number/],
    [{ ok: true, query_counts: [1, 2.5], pass: true }, /whole number/],
    [{ ok: true, query_counts: [1, -1], pass: true }, /whole number/],
    [{ ok: true, query_counts: [1, 1e10], pass: true }, /whole number/],
    [{ ok: true, query_counts: [1, { Name: "x" }], pass: true }, /whole number/],
    [{ ok: true, query_counts: "1,2", pass: true }, /a list of whole numbers/],
    [{ ok: true, query_counts: [1, 2] }, /must report pass/],
    [{ ok: true, query_counts: [1, 2], pass: "PASS" }, /must report pass/],
    [{ ok: false, query_counts: [1] }, /1 entries for 2 queries/],
    [{ ok: false, query_counts: [1, 2], pass: "no" }, /pass must be true or false/],
  ]) {
    const { deps, calls } = dqFakes();
    const res = await handle(dqResult(body), deps);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, why, JSON.stringify(body));
    assert.deepEqual(calls.finished[0].result, { ok: false }, JSON.stringify(body));
    assert.match(calls.finished[0].summary, /^refused by the runner: /);
    assert.match(calls.finished[0].summary, why);
    assert.deepEqual(calls.status, [{ id: "dq-1", status: "failed" }]);
  }
});

test("result: sf_dataop's and sf_read's runs are unchanged by sf_dataquery (no query_counts, no scrub)", async () => {
  const { deps, calls } = fakes({
    findPicked: async () => ({
      action: { id: "dop-1", user_id: USER, kind: "sf_dataop", status: "consumed", picked_up_at: "t", payload: DATAOP_PAYLOAD },
      run: { id: "run-d", action_id: "dop-1", mode: "real", finished_at: null },
    }),
  });
  await handle(helper("result", { action_id: "dop-1", run_id: "run-d", ok: true, summary: "done 003000000000001AAA",
    exit_code: 0, query_counts: [1], pass: true }), deps);
  assert.deepEqual(calls.finished[0].result, { ok: true, exit_code: 0 });
  assert.equal(calls.finished[0].summary, "done 003000000000001AAA");
});

test("sf_dataquery link: preview shows the payload; approve only spends the link", async () => {
  const { deps, calls, action } = gitFakes();
  Object.assign(action, { kind: "sf_dataquery", payload: DQ_PAYLOAD });
  const preview = await (await handle(post("preview", { token: TOKEN }, jwt()), deps)).json();
  assert.equal(preview.kind, "sf_dataquery");
  assert.deepEqual(preview.payload, DQ_PAYLOAD);
  const res = await handle(post("approve", { token: TOKEN, fingerprint: "fp-1" }, jwt()), deps);
  assert.deepEqual(await res.json(), { ok: true, action_id: "act-1", sent: true });
  nothingRan(calls);
});

// --- dataop_write-j5w: sf_datawrite, Data run v2's write link ---

const SEVEN = [...SIX, "sf_datawrite"];
const DW_QUERY = (step, label) => ({ step, soql: "SELECT Id FROM Contact WHERE A = 1", sha256: "1".repeat(64), label });
const DW_BASE = { alias: "cd-prod", org_type: "production", repo: "C:\\Users\\Alex\\projects\\common-defense", run: "data-ops/cd_fixc-q8d/fixc",
  run_tag: "cd_fixc-q8d-s9-ab12", request_sha256: "0".repeat(64), selection_sha256: "1".repeat(64), object: "GiftTransaction", expected: 45,
  queries: [{ step: "gate", soql: "SELECT Id FROM GiftTransaction WHERE A = 1", sha256: "1".repeat(64), file: "selection.soql" },
            DW_QUERY("gate", "gate: broad snapshot"), DW_QUERY("after", "after: broad snapshot"),
            { step: "after-counts", soql: "SELECT COUNT() FROM Contact WHERE A = 1", sha256: "2".repeat(64), label: "One" }] };
const DW_PAYLOADS = {
  batch: { ...DW_BASE, write: { kind: "batch", class: "FixCLinkBatch" } },
  bulk: { ...DW_BASE, org_type: "sandbox", write: { kind: "bulk", operation: "update", csv: "update.csv", csv_sha256: "3".repeat(64) } },
  undo: { ...DW_BASE, write: { kind: "undo", class: "FixCUndoBatch", ids_file: "undo-ids.csv", ids_sha256: "4".repeat(64) },
    uploads: [{ purpose: "undo-ids", file: "undo-ids.csv", sha256: "4".repeat(64), rows: 45 }],
    queries: [DW_QUERY("gate", "gate: broad snapshot"), DW_QUERY("after", "after: broad snapshot")] },
};
const dwFakes = (payload = DW_PAYLOADS.batch) => fakes({
  findPicked: async (a, r) => (a === "dw-1" && r === "run-w" ? {
    action: { id: "dw-1", user_id: USER, kind: "sf_datawrite", status: "consumed", picked_up_at: "t", payload },
    run: { id: "run-w", action_id: "dw-1", mode: "real", finished_at: null },
  } : null),
});
const dwResult = (body) => helper("result", { action_id: "dw-1", run_id: "run-w", summary: "write done", ...body });
const DW_DONE = (n) => ({ stage: "done", query_counts: Array.from({ length: n }, (_, i) => i * 10),
  gate: { added: 0, dropped: 0, edited: 0 }, write: { expected: 45, changed: 42, failed: 2, excluded: 1 },
  check: { problems: 0, extras: 0, new_records: 3 } });

test("pickup: seven kinds are passed on whole and may get an sf_datawrite; six, five, four and three carry on as now", async () => {
  const seven = kindsFakes();
  assert.equal((await handle(helper("pickup", { kinds: [...SEVEN].reverse() }), seven.deps)).status, 200);
  assert.deepEqual(seven.deps.args, [USER, SEVEN]);
  const six = kindsFakes();
  assert.equal((await handle(helper("pickup", { kinds: SIX }), six.deps)).status, 200);
  assert.deepEqual(six.deps.args, [USER, SIX]);
  assert.ok(!six.deps.args[1].includes("sf_datawrite"));
  const five = kindsFakes();
  assert.equal((await handle(helper("pickup", { kinds: FIVE }), five.deps)).status, 200);
  assert.deepEqual(five.deps.args, [USER, FIVE]);
  for (const kinds of [["git", "sf_check", "sb_setup", "sf_read"], ["git", "sf_check", "sb_setup"]]) {
    const older = kindsFakes();
    assert.equal((await handle(helper("pickup", { kinds }), older.deps)).status, 200, JSON.stringify(kinds));
    assert.deepEqual(older.deps.args, [USER, undefined], JSON.stringify(kinds));
  }
});

test("pickup: sf_datawrite with only some of the kinds is refused and picks nothing", async () => {
  for (const kinds of [["sf_datawrite"], ["git", "sf_datawrite"], [...FIVE, "sf_datawrite"], [...SIX.filter((k) => k !== "sf_dataop"), "sf_datawrite"]]) {
    const { deps, calls } = fakes({ stalePicks: async () => { throw new Error("not reached"); } });
    const res = await handle(helper("pickup", { kinds }), deps);
    assert.equal(res.status, 400, JSON.stringify(kinds));
    assert.equal(calls.pickedHelper, undefined);
  }
});

test("pickup: a picked sf_datawrite gets 4 hours before it is failed (LONG_PICK_KINDS), every other kind 30 minutes", async () => {
  const core = await import("./core.ts");
  assert.ok(core.LONG_PICK_KINDS.includes("sf_datawrite"));
  assert.ok(core.HELPER_KINDS.includes("sf_datawrite"));
  const now = Date.parse("2026-11-19T15:00:00Z");
  const { deps, calls } = fakes({ stalePicks: async (u, before, dataopBefore) => (calls.stale = { before, dataopBefore },
    [{ action_id: "dw-1", run_id: "run-w" }]) });
  const body = await (await handle(helper("pickup", { kinds: SEVEN }), deps, now)).json();
  assert.deepEqual(calls.stale, { before: "2026-11-19T14:30:00.000Z", dataopBefore: "2026-11-19T11:00:00.000Z" });
  assert.deepEqual(body.timed_out, ["dw-1"]);
  assert.deepEqual(calls.finished[0].result, { ok: false, timed_out: true });
  assert.deepEqual(calls.status, [{ id: "dw-1", status: "failed" }]);
});

test("result: a good sf_datawrite for each write kind keeps only ok, exit_code, pass and datawrite; the line says done: PASS", async () => {
  for (const [kind, payload] of Object.entries(DW_PAYLOADS)) {
    const { deps, calls } = dwFakes(payload);
    const datawrite = DW_DONE(payload.queries.length);
    const res = await handle(dwResult({ ok: true, exit_code: 0, pass: true, datawrite,
      summary: "wrote 42 of 45, first 003000000000001AAA, by alex@example.com" }), deps);
    assert.equal(res.status, 200, kind);
    assert.deepEqual(await res.json(), { ok: true, action_id: "dw-1", run_id: "run-w", status: "succeeded", line: "datawrite dw-1 done: PASS" }, kind);
    assert.deepEqual(calls.finished[0].result, { ok: true, exit_code: 0, pass: true, datawrite }, kind);
    assert.equal(calls.finished[0].summary, "wrote 42 of 45, first [id], by [email]", kind);
    assert.deepEqual(calls.status, [{ id: "dw-1", status: "succeeded" }], kind);
  }
});

// s11c: excluded counts only the manifest records the gate left out. Records added at the gate are left out too
// (exclude.csv holds them) but were never in expected, so they are never counted, and nothing compares excluded with
// exclude.csv's rows or the payload's uploads.
test("result: a gate that left out 2 manifest records and found 4 added reports excluded 2 and passes", async () => {
  const payload = { ...DW_PAYLOADS.batch, uploads: [{ purpose: "exclude", file: "exclude.csv", sha256: "e".repeat(64), rows: 6 }] };
  const { deps, calls } = dwFakes(payload);
  const datawrite = { ...DW_DONE(payload.queries.length), gate: { added: 4, dropped: 0, edited: 2 },
    write: { expected: 45, changed: 41, failed: 2, excluded: 2 } };
  const res = await handle(dwResult({ ok: true, pass: true, datawrite }), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, action_id: "dw-1", run_id: "run-w", status: "succeeded", line: "datawrite dw-1 done: PASS" });
  assert.deepEqual(calls.finished[0].result, { ok: true, pass: true, datawrite });
  // Counting the 4 added records as well (excluded 6) breaks the sum, and that is the only check on excluded.
  const bad = dwFakes(payload);
  const refused = await handle(dwResult({ ok: true, pass: true, datawrite: { ...datawrite, write: { ...datawrite.write, excluded: 6 } } }), bad.deps);
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error ?? "", /changed \+ failed \+ excluded is 49, not the expected 45/);
});

test("result: a step 5 FAIL is ok with pass false; the line says done: FAIL", async () => {
  const { deps, calls } = dwFakes();
  const datawrite = { ...DW_DONE(4), write: { expected: 45, changed: 40, failed: 2, excluded: 1 }, check: { problems: 2, extras: 1, new_records: 0 } };
  const res = await handle(dwResult({ ok: true, pass: false, datawrite }), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, action_id: "dw-1", run_id: "run-w", status: "succeeded", line: "datawrite dw-1 done: FAIL" });
  assert.deepEqual(calls.finished[0].result, { ok: true, pass: false, datawrite });
});

test("result: the three lines, exactly: done: PASS, done: FAIL, failed (not ok, or refused)", async () => {
  const core = await import("./core.ts");
  assert.equal(core.datawriteLine("dw-1", true, true), "datawrite dw-1 done: PASS");
  assert.equal(core.datawriteLine("dw-1", true, false), "datawrite dw-1 done: FAIL");
  assert.equal(core.datawriteLine("dw-1", false, true), "datawrite dw-1 failed");
  assert.equal(core.datawriteLine("dw-1", false), "datawrite dw-1 failed");
  const lines = [];
  for (const body of [{ ok: true, pass: true, datawrite: DW_DONE(4) }, { ok: true, pass: false, datawrite: DW_DONE(4) },
                      { ok: false, datawrite: { stage: "gate" } }, { ok: true, pass: true, datawrite: DW_DONE(4), output: "x" }]) {
    const { deps } = dwFakes();
    lines.push((await (await handle(dwResult(body), deps)).json()).line);
  }
  assert.deepEqual(lines, ["datawrite dw-1 done: PASS", "datawrite dw-1 done: FAIL", "datawrite dw-1 failed", "datawrite dw-1 failed"]);
});

test("result: a gate stop and a declined Enter are ok false; nothing written; the line says failed", async () => {
  for (const datawrite of [
    { stage: "gate", query_counts: [45, 31200], gate: { added: 1, dropped: 0, edited: 2 } },
    { stage: "write", query_counts: [45, 31200], gate: { added: 0, dropped: 0, edited: 0 } },
    { stage: "write" },
  ]) {
    const { deps, calls } = dwFakes();
    const res = await handle(dwResult({ ok: false, exit_code: 3, summary: `stopped at the ${datawrite.stage}`, datawrite }), deps);
    assert.equal(res.status, 200, JSON.stringify(datawrite));
    assert.deepEqual(await res.json(), { ok: true, action_id: "dw-1", run_id: "run-w", status: "failed", line: "datawrite dw-1 failed" });
    assert.deepEqual(calls.finished[0].result, { ok: false, exit_code: 3, datawrite });
    assert.deepEqual(calls.status, [{ id: "dw-1", status: "failed" }]);
  }
  const bare = dwFakes();
  assert.equal((await handle(dwResult({ ok: false }), bare.deps)).status, 200);
  assert.deepEqual(bare.calls.finished[0].result, { ok: false });
});

test("result: an sf_datawrite report that doesn't fit is refused (400), and the run closes as failed saying why", async () => {
  const done = DW_DONE(4);
  const withPart = (part, v) => ({ ...done, [part]: v });
  for (const [body, why] of [
    [{ ok: true, pass: true, datawrite: done, output: "Id,Name\n003000000000001AAA,Jo" }, /takes no output/],
    [{ ok: true, pass: true, datawrite: done, rows: [{ Id: "003000000000001AAA" }] }, /takes no rows/],
    [{ ok: true, pass: true, datawrite: done, query_counts: [1] }, /takes no query_counts/],
    [{ ok: true, pass: true, datawrite: { ...done, ids: ["003000000000001AAA"] } }, /datawrite takes no ids/],
    [{ ok: true, pass: true, datawrite: withPart("write", { ...done.write, names: "Jo" }) }, /datawrite\.write must be/],
    [{ ok: true, pass: true, datawrite: withPart("check", { ...done.check, why: "Amount was 20.50" }) }, /datawrite\.check must be/],
    [{ ok: true, pass: true, datawrite: withPart("write", { ...done.write, changed: "42" }) }, /datawrite\.write must be/],
    [{ ok: true, pass: true, datawrite: withPart("gate", { added: -1, dropped: 0, edited: 0 }) }, /datawrite\.gate must be/],
    [{ ok: true, pass: true, datawrite: withPart("gate", { added: 0.5, dropped: 0, edited: 0 }) }, /datawrite\.gate must be/],
    [{ ok: true, pass: true, datawrite: withPart("check", { problems: 0, extras: 0, new_records: 1e9 }) }, /datawrite\.check must be/],
    [{ ok: true, pass: true, datawrite: withPart("gate", { added: 0, dropped: 0 }) }, /datawrite\.gate must be/],
    [{ ok: true, pass: true, datawrite: { ...done, stage: "finished" } }, /stage must be one of gate, write, after, counts, done/],
    [{ ok: true, pass: true, datawrite: (({ stage: _s, ...r }) => r)(done) }, /stage must be one of/],
    [{ ok: true, pass: true, datawrite: { ...done, stage: "after" } }, /has stage done, not after/],
    [{ ok: true, pass: true, datawrite: withPart("write", { ...done.write, expected: 44, changed: 41 }) }, /write\.expected is 44, but the link's expected is 45/],
    [{ ok: true, pass: true, datawrite: withPart("query_counts", [1, 2, 3]) }, /3 entries for 4 queries/],
    [{ ok: true, pass: true, datawrite: withPart("query_counts", [1, 2, 3, 4, 5]) }, /5 entries for 4 queries/],
    [{ ok: false, datawrite: { stage: "gate", query_counts: [1, 2, 3, 4, 5] } }, /5 entries for 4 queries/],
    [{ ok: true, pass: true, datawrite: withPart("query_counts", [1, 2, 3, "4"]) }, /query_counts must be a list of whole numbers/],
    [{ ok: true, pass: true, datawrite: withPart("write", { ...done.write, changed: 41 }) }, /changed \+ failed \+ excluded is 44, not the expected 45/],
    [{ ok: true, pass: true, datawrite: withPart("check", { ...done.check, problems: 1 }) }, /step 5 found 1 problem/],
    [{ ok: false, pass: true, datawrite: { stage: "write" } }, /pass can be true only when ok is true/],
    [{ ok: false, pass: true }, /pass can be true only when ok is true/],
    [{ ok: true, datawrite: done }, /must report pass and datawrite/],
    [{ ok: true, pass: true }, /must report pass and datawrite/],
    [{ ok: true, pass: "PASS", datawrite: done }, /pass must be true or false/],
    [{ ok: true, pass: true, datawrite: (({ check: _c, ...r }) => r)(done) }, /must report check/],
    [{ ok: true, pass: true, datawrite: "stopped at the gate" }, /datawrite must be/],
  ]) {
    const { deps, calls } = dwFakes();
    const res = await handle(dwResult(body), deps);
    assert.equal(res.status, 400, JSON.stringify(body));
    const out = await res.json();
    assert.match(out.error, why, JSON.stringify(body));
    assert.equal(out.status, "failed");
    assert.equal(out.line, "datawrite dw-1 failed");
    assert.deepEqual(calls.finished[0].result, { ok: false }, JSON.stringify(body));
    assert.match(calls.finished[0].summary, /^refused by the runner: /);
    assert.match(calls.finished[0].summary, why);
    assert.deepEqual(calls.status, [{ id: "dw-1", status: "failed" }]);
  }
});

test("result: an over-long or two-line summary is refused before anything is kept", async () => {
  for (const summary of ["x".repeat(301), "two\nlines"]) {
    const { deps, calls } = dwFakes();
    const res = await handle(dwResult({ ok: true, pass: true, datawrite: DW_DONE(4), summary }), deps);
    assert.equal(res.status, 400);
    assert.equal(calls.finished, undefined);
  }
});

test("result: sf_dataop and sf_dataquery are unchanged by sf_datawrite", async () => {
  const dop = fakes({
    findPicked: async () => ({
      action: { id: "dop-1", user_id: USER, kind: "sf_dataop", status: "consumed", picked_up_at: "t", payload: DATAOP_PAYLOAD },
      run: { id: "run-d", action_id: "dop-1", mode: "real", finished_at: null },
    }),
  });
  const r1 = await handle(helper("result", { action_id: "dop-1", run_id: "run-d", ok: true, summary: "done 003000000000001AAA",
    exit_code: 0, datawrite: DW_DONE(4), pass: true }), dop.deps);
  assert.deepEqual(await r1.json(), { ok: true, action_id: "dop-1", run_id: "run-d", status: "succeeded" });
  assert.deepEqual(dop.calls.finished[0].result, { ok: true, exit_code: 0 });
  assert.equal(dop.calls.finished[0].summary, "done 003000000000001AAA");
  const dq = dqFakes();
  const r2 = await handle(dqResult({ ok: true, query_counts: [1, 2], pass: true, datawrite: DW_DONE(2) }), dq.deps);
  assert.deepEqual(await r2.json(), { ok: true, action_id: "dq-1", run_id: "run-q", status: "succeeded" });
  assert.deepEqual(dq.calls.finished[0].result, { ok: true, query_counts: [1, 2], pass: true });
});

test("sf_datawrite link: preview shows the payload; approve only spends the link", async () => {
  const { deps, calls, action } = gitFakes();
  Object.assign(action, { kind: "sf_datawrite", payload: DW_PAYLOADS.undo });
  const preview = await (await handle(post("preview", { token: TOKEN }, jwt()), deps)).json();
  assert.equal(preview.kind, "sf_datawrite");
  assert.deepEqual(preview.payload, DW_PAYLOADS.undo);
  assert.equal((await handle(post("dry-run", { token: TOKEN }, jwt()), deps)).status, 409);
  const res = await handle(post("approve", { token: TOKEN, fingerprint: "fp-1" }, jwt()), deps);
  assert.deepEqual(await res.json(), { ok: true, action_id: "act-1", sent: true });
  nothingRan(calls);
});

// ---------------------------------------------------------------------------
// sb3_runner-r4q s4: sf_run, a run page's approval (migrations 248, 250; 251 for the evidence function)
// ---------------------------------------------------------------------------

const EIGHT = [...SEVEN, "sf_run"];
const LINK_ID = "5d0c3a8e-1b2f-4c6d-9e7a-0f1b2c3d4e5f";
const REQ_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const LINK_ROW = {
  id: LINK_ID, user_id: USER, request_id: REQ_ID, request_version: 1, review_id: null, token_hash: "f".repeat(64),
  desktop: { panel: true, helper: true }, used_at: "2026-11-24T10:00:00Z", action_id: "sr-1", rerun_at: null,
  rerun_action_id: null, voided_at: null, void_reason: null, created_at: "2026-11-24T09:00:00Z",
};
const REQ_ROW = {
  id: REQ_ID, user_id: USER, project_code: "cd_fixc-q8d", page: "precheck", base_page: "precheck", version: 1,
  corrected_at: null, simulation: false, request: { headline: "PRE-CHECK", steps: ["count", "login"] }, evidence: [],
  total_count: null, created_at: "2026-11-24T08:00:00Z", updated_at: "2026-11-24T08:00:00Z",
};
const SR_PICKED = { action_id: "sr-1", run_id: "run-s", kind: "sf_run", project_code: "cd_fixc-q8d", payload: { link_id: LINK_ID },
  fingerprint: "fp", headline: "H", chat_url: null };
const CHECKS = [{ check: "count", org: "production" }, { check: "rehearsal", org: "sandbox", commit: "abc1234" }];
const SAMPLE = { records: [{ Id: "003000000000001AAA", Name: "Sam Ple" }] };

function srFakes({ link = LINK_ROW, request = REQ_ROW, action = {}, run = {}, evidence, sample } = {}) {
  const order = [];
  const f = fakes({
    pickupHelper: async (u, k, p) => (order.push("pickup"), f.calls.helperArgs = [u, k, p], { ...SR_PICKED }),
    runLink: async (id, u) => (order.push(`link ${id}`), f.calls.linkUser = u, link && id === link.id ? { ...link } : null),
    runRequest: async (id, u) => (order.push(`request ${id}`), f.calls.requestUser = u, request && id === request.id ? { ...request } : null),
    findPicked: async (a, r) => (a === "sr-1" && r === "run-s" ? {
      action: { id: "sr-1", user_id: USER, kind: "sf_run", status: "consumed", picked_up_at: "2026-11-24T10:01:00Z",
                payload: { link_id: LINK_ID }, ...action },
      run: { id: "run-s", action_id: "sr-1", mode: "real", finished_at: null, result: null, ...run },
    } : null),
    finishRun: async (id, fields) => (order.push("finish"), (f.calls.finished ??= []).push({ id, ...fields })),
    setStatus: async (id, status) => (order.push(`status ${status}`), f.calls.status.push({ id, status })),
    recordRunEvidence: evidence ?? (async (id) => (order.push(`evidence ${id}`),
      { recorded: 2, already: false, request_id: REQ_ID, page: "precheck" })),
    storeRunSample: sample ?? (async (id, s) => (order.push(`sample ${id}`), f.calls.sample = s,
      { stored: true, request_id: id, expires_at: "2026-11-25T10:00:00Z" })),
    dropRunSample: async (id) => (order.push(`drop ${id}`), 0),
  });
  f.order = order;
  return f;
}
/** /result reads the link and its request first, to tell a pre-check from a write. */
const READS = [`link ${LINK_ID}`, `request ${REQ_ID}`];
const srResult = (over = {}) => helper("result", {
  action_id: "sr-1", run_id: "run-s", ok: true, pass: true, summary: "pre-check passed", checks: CHECKS, ...over,
});

test("sf_run kinds: a helper kind with the 4-hour limit; eight kinds passed whole; seven never get it", async () => {
  const core = await import("./core.ts");
  assert.ok(core.HELPER_KINDS.includes("sf_run"));
  assert.ok(core.LONG_PICK_KINDS.includes("sf_run"));
  const eight = kindsFakes();
  assert.equal((await handle(helper("pickup", { kinds: [...EIGHT].reverse() }), eight.deps)).status, 200);
  assert.deepEqual(eight.deps.args, [USER, EIGHT]);
  const seven = kindsFakes();
  assert.equal((await handle(helper("pickup", { kinds: SEVEN }), seven.deps)).status, 200);
  assert.deepEqual(seven.deps.args, [USER, SEVEN]);
  assert.ok(!seven.deps.args[1].includes("sf_run"));
  for (const kinds of [["sf_run"], ["git", "sf_run"], [...SIX, "sf_run"]]) {
    const { deps, calls } = fakes({ stalePicks: async () => { throw new Error("not reached"); } });
    assert.equal((await handle(helper("pickup", { kinds }), deps)).status, 400, JSON.stringify(kinds));
    assert.equal(calls.pickedHelper, undefined);
  }
  // index.ts's stale and pending queries take HELPER_KINDS and LONG_PICK_KINDS, so sf_run is in both.
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(src, /\.in\("kind", \[\.\.\.HELPER_KINDS\]\)\.is\("picked_up_at", null\)/);
  assert.match(src, /\.in\("kind", LONG_PICK_KINDS\)/);
});

test("sf_run pending: an unpicked one is stale 15 minutes after created_at; a picked one blocks for 4 hours", async () => {
  const { deps } = pendingFakes({
    unpicked: [
      { id: "s-new", kind: "sf_run", project_code: "p-a", status: "consumed", link_used_at: null, created_at: ago(14) },
      { id: "s-old", kind: "sf_run", project_code: "p-b", status: "consumed", link_used_at: null, created_at: ago(16) },
    ],
    picked: [{ id: "s-run", kind: "sf_run", project_code: "p-c", picked_up_at: ago(200), run_id: "run-s" }],
  });
  const body = await (await handle(helper("pending"), deps, PENDING_NOW)).json();
  assert.deepEqual(body.unpicked.map((e) => [e.action_id, e.approved_at, e.stale]), [["s-new", ago(14), false], ["s-old", ago(16), true]]);
  assert.deepEqual(body.unreported.map((e) => [e.action_id, e.stale]), [["s-run", false]]);
  assert.equal(body.clear, false);
});

test("sf_run pickup: reads the link by payload.link_id and its request; returns the request whole and the link without token_hash", async () => {
  const { deps, calls, order } = srFakes();
  const res = await handle(helper("pickup", { kinds: EIGHT, pickup_id: PID }), deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(calls.helperArgs, [USER, EIGHT, PID]);
  assert.deepEqual(order, ["pickup", `link ${LINK_ID}`, `request ${REQ_ID}`]);
  assert.equal(calls.linkUser, USER);
  assert.equal(calls.requestUser, USER);
  const { token_hash: _, ...link } = LINK_ROW;
  assert.deepEqual(body.action, { ...SR_PICKED, link, request: REQ_ROW });
  assert.ok(!JSON.stringify(body).includes("f".repeat(64)));
  assert.deepEqual(calls.status, []);
  assert.equal(calls.finished, undefined);
});

test("sf_run pickup: a missing link or request is refused with its fix, and the action fails so the project moves", async () => {
  for (const [over, why] of [[{ link: null }, /no run link/], [{ request: null }, /no request/]]) {
    const { deps, calls } = srFakes(over);
    const res = await handle(helper("pickup", { kinds: EIGHT }), deps);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, why);
    assert.match(body.error, /^sf_run sr-1: .+ — .+/);
    assert.equal(body.action, undefined);
    assert.equal(body.line, `run ${LINK_ID} failed`);
    assert.equal(calls.finished[0].id, "run-s");
    assert.deepEqual(calls.finished[0].result, { ok: false });
    assert.deepEqual(calls.status, [{ id: "sr-1", status: "failed" }]);
  }
});

test("sf_run pickup: other kinds read no link", async () => {
  const { deps, order } = srFakes();
  deps.pickupHelper = async () => ({ ...PICKED, kind: "sf_check" });
  const body = await (await handle(helper("pickup", { kinds: EIGHT }), deps)).json();
  assert.equal(body.action.kind, "sf_check");
  assert.deepEqual(order, []);
});

test("sf_run result: the sample never reaches the run row; evidence, then the sample, then the status", async () => {
  const { deps, calls, order } = srFakes();
  const res = await handle(srResult({ exit_code: 0, sample: SAMPLE, output: "window text 003000000000001AAA" }), deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, {
    ok: true, action_id: "sr-1", run_id: "run-s", run_kind: "pre-check", status: "succeeded", link_id: LINK_ID,
    line: `run ${LINK_ID} done: PASS`, evidence: { recorded: 2, already: false, request_id: REQ_ID, page: "precheck" },
    sample_stored: true,
  });
  assert.deepEqual(order, [...READS, "finish", "evidence run-s", `sample ${REQ_ID}`, "status succeeded"]);
  assert.deepEqual(calls.finished[0].result, { ok: true, exit_code: 0, pass: true, checks: CHECKS });
  assert.ok(calls.finished[0].finished_at);
  assert.ok(!JSON.stringify(calls.finished).includes("Sam Ple"));
  assert.deepEqual(calls.sample, SAMPLE);
});

test("sf_run result: the summary loses ids and emails", async () => {
  const { deps, calls } = srFakes();
  await handle(srResult({ summary: "checked 003000000000001AAA for a@b.org" }), deps);
  assert.equal(calls.finished[0].summary, "checked [id] for [email]");
});

test("sf_run result: no sample, no sample write", async () => {
  const { deps, order } = srFakes();
  const body = await (await handle(srResult(), deps)).json();
  assert.equal(body.sample_stored, false);
  assert.deepEqual(order, [...READS, "finish", "evidence run-s", "status succeeded"]);
});

test("sf_run result: FAIL and failed record no evidence and drop the sample; the lines say done: FAIL and failed", async () => {
  const fail = srFakes();
  const r1 = await (await handle(srResult({ pass: false, sample: SAMPLE }), fail.deps)).json();
  assert.equal(r1.line, `run ${LINK_ID} done: FAIL`);
  assert.equal(r1.status, "succeeded");
  assert.equal(r1.evidence, null);
  assert.equal(r1.sample_stored, false);
  assert.deepEqual(fail.order, [...READS, "finish", "status succeeded"]);
  const failed = srFakes();
  const r2 = await (await handle(srResult({ ok: false, pass: undefined, checks: undefined, sample: SAMPLE }), failed.deps)).json();
  assert.equal(r2.line, `run ${LINK_ID} failed`);
  assert.equal(r2.status, "failed");
  assert.deepEqual(failed.calls.finished[0].result, { ok: false });
  assert.deepEqual(failed.order, [...READS, "finish", "status failed"]);
});

test("sf_run result: a pass with no checks records no evidence", async () => {
  const { deps, order } = srFakes();
  const body = await (await handle(srResult({ checks: [] }), deps)).json();
  assert.equal(body.evidence, null);
  assert.deepEqual(order, [...READS, "finish", "status succeeded"]);
});

test("sf_run result: a report that doesn't fit is refused (400), closes the run as failed and stores nothing", async () => {
  const bad = [
    [{ pass: "yes" }, /pass must be true or false/],
    [{ pass: undefined }, /must report pass/],
    [{ ok: false, pass: true }, /pass can be true only when ok is true/],
    [{ checks: "count" }, /checks must be a list/],
    [{ checks: [{ check: "count" }] }, /\{check, org, commit\?\}/],
    [{ checks: [{ check: "count", org: "staging" }] }, /\{check, org, commit\?\}/],
    [{ checks: [{ check: "vibes", org: "production" }] }, /\{check, org, commit\?\}/],
    [{ checks: [{ check: "rehearsal", org: "sandbox", commit: "XYZ" }] }, /\{check, org, commit\?\}/],
    [{ checks: [{ check: "count", org: "production", note: "x" }] }, /\{check, org, commit\?\}/],
    [{ sample: [SAMPLE] }, /sample must be an object/],
    [{ sample: { records: [] } }, /one record, or two/],
    [{ sample: { records: [{}, {}, {}] } }, /one record, or two/],
    [{ checks: [{ check: "count", org: "production" }, { check: "count", org: "sandbox" }] }, /names a check twice/],
  ];
  for (const [over, why] of bad) {
    const { deps, calls, order } = srFakes();
    const res = await handle(srResult({ sample: SAMPLE, ...over }), deps);
    assert.equal(res.status, 400, JSON.stringify(over));
    const body = await res.json();
    assert.match(body.error, why, JSON.stringify(over));
    assert.equal(body.line, `run ${LINK_ID} failed`);
    assert.deepEqual(calls.finished[0].result, { ok: false });
    assert.match(calls.finished[0].summary, /^refused by the runner: /);
    assert.ok(!JSON.stringify(calls.finished).includes("Sam Ple"));
    assert.deepEqual(order, [...READS, "finish", "status failed"]);
  }
});

test("sf_run write: a refused report still drops the write's sample", async () => {
  const { deps, order } = srFakes({ request: WRITE_REQ });
  deps.dropRunSample = async (id) => (order.push(`drop ${id}`), 1);
  const res = await handle(srResult({ pass: "yes" }), deps);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).sample_dropped, 1);
  assert.deepEqual(order, [...READS, `drop ${REQ_ID}`, "finish", "status failed"]);
});

test("sf_run result: a run or status write that throws is retried (503), never a bare 500", async () => {
  for (const which of ["finishRun", "setStatus"]) {
    const { deps } = srFakes();
    deps[which] = async () => { throw new Error("connection reset"); };
    const res = await handle(srResult(), deps);
    assert.equal(res.status, 503, which);
    const body = await res.json();
    assert.equal(body.retry, true);
    assert.match(body.error, /^runner: connection reset/);
  }
});

test("sf_run result: the shape check lives in one exported function", async () => {
  const core = await import("./core.ts");
  assert.equal(core.sfRunReportProblem({ ok: true, pass: true, checks: CHECKS, sample: SAMPLE }), null);
  assert.equal(core.sfRunReportProblem({ ok: false }), null);
  assert.match(core.sfRunReportProblem({ ok: true }), /must report pass/);
});

test("sf_run result: an evidence write that fails replies not ok naming it; the action stays consumed and a retry finishes it once", async () => {
  let fail = true;
  const evidenceCalls = [];
  const evidence = async (id) => {
    evidenceCalls.push(id);
    if (fail) throw new Error("connection reset");
    return { recorded: 0, already: false, request_id: REQ_ID, page: "precheck" };
  };
  const first = srFakes({ evidence });
  const res = await handle(srResult({ sample: SAMPLE }), first.deps);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.retry, true);
  assert.match(body.error, /^evidence: /);
  assert.match(body.error, /connection reset/);
  assert.deepEqual(first.calls.status, []);
  assert.equal(first.calls.sample, undefined);
  // The retry: the run already holds the result, so it is not written again.
  fail = false;
  const stored = first.calls.finished[0];
  const again = srFakes({ evidence, run: { finished_at: stored.finished_at, result: stored.result } });
  const res2 = await handle(srResult({ sample: SAMPLE }), again.deps);
  assert.equal(res2.status, 200);
  assert.equal((await res2.json()).line, `run ${LINK_ID} done: PASS`);
  assert.equal(again.calls.finished, undefined);
  assert.deepEqual(again.calls.sample, SAMPLE);
  assert.deepEqual(again.calls.status, [{ id: "sr-1", status: "succeeded" }]);
  assert.deepEqual(evidenceCalls, ["run-s", "run-s"]);
});

test("sf_run result: a sample write that fails replies not ok naming it; the retry finds the evidence already recorded", async () => {
  const sample = async () => { throw Object.assign(new Error("fetch failed"), { code: "" }); };
  const first = srFakes({ sample });
  const res = await handle(srResult({ sample: SAMPLE }), first.deps);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /^sample: /);
  assert.equal(body.retry, true);
  assert.deepEqual(first.order, [...READS, "finish", "evidence run-s"]);
  assert.deepEqual(first.calls.status, []);
  const stored = first.calls.finished[0];
  const again = srFakes({
    run: { finished_at: stored.finished_at, result: stored.result },
    evidence: async () => ({ recorded: 0, already: true, request_id: REQ_ID, page: "precheck" }),
  });
  const body2 = await (await handle(srResult({ sample: SAMPLE }), again.deps)).json();
  assert.equal(body2.evidence.already, true);
  assert.equal(body2.sample_stored, true);
  assert.deepEqual(again.calls.status, [{ id: "sr-1", status: "succeeded" }]);
});

test("sf_run result: a missing link or request at /result fails the run for good, naming the fix", async () => {
  for (const [over, why] of [[{ link: null }, /no run link/], [{ request: null }, /has no request/]]) {
    const { deps, calls } = srFakes(over);
    const res = await handle(srResult({ sample: SAMPLE }), deps);
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.retry, false);
    assert.match(body.error, why);
    assert.match(body.error, / — queue the request again/);
    assert.equal(body.line, `run ${LINK_ID} failed`);
    assert.equal(calls.finished.length, 1);
    assert.equal(calls.finished[0].result.ok, false);
    assert.equal(calls.sample, undefined);
    assert.deepEqual(calls.status, [{ id: "sr-1", status: "failed" }]);
  }
});

test("sf_run result: a link read that throws is retried and writes nothing", async () => {
  const { deps, calls } = srFakes();
  deps.runLink = async () => { throw new Error("fetch failed"); };
  const res = await handle(srResult(), deps);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.retry, true);
  assert.match(body.error, /^link: fetch failed/);
  assert.equal(calls.finished, undefined);
  assert.deepEqual(calls.status, []);
});

const WRITE_REQ = { ...REQ_ROW, page: "dataop", base_page: "dataop", total_count: 45 };
const coded = (code, message = "refused") => Object.assign(new Error(message), { code });

test("sf_run kind: 251's rule, from the link's action_id and rerun_action_id and the request's base_page", async () => {
  const { sfRunKind } = await import("./core.ts");
  const link = { action_id: "a1", rerun_action_id: "a2" };
  assert.equal(sfRunKind("a1", link, { page: "precheck", base_page: "precheck" }), "pre-check");
  assert.equal(sfRunKind("a1", link, { page: "correction", base_page: "precheck" }), "pre-check");
  assert.equal(sfRunKind("a1", link, { page: "dataop", base_page: "dataop" }), "write");
  assert.equal(sfRunKind("a1", link, { page: "undo", base_page: "undo" }), "write");
  // A rerun, or a write's correction Approve (recorded as one, 251), is the link's pre-check even on a dataop request.
  assert.equal(sfRunKind("a2", link, { page: "dataop", base_page: "dataop" }), "pre-check");
  assert.equal(sfRunKind("a2", link, { page: "correction", base_page: "dataop" }), "pre-check");
  assert.equal(sfRunKind("a2", link, { page: "correction", base_page: "undo" }), "pre-check");
  // A write approved before its request was corrected is still the write.
  assert.equal(sfRunKind("a1", link, { page: "correction", base_page: "dataop" }), "write");
  assert.equal(sfRunKind("a1", link, { page: "check", base_page: "check" }), "other");
  assert.equal(sfRunKind("a9", link, { page: "precheck", base_page: "precheck" }), "other");
});

test("sf_run write: no evidence, no sample stored; the sample is dropped by its own request id at its final status", async () => {
  for (const [over, status, line] of [[{}, "succeeded", "done: PASS"], [{ ok: false, pass: undefined }, "failed", "failed"]]) {
    const drops = [];
    const { deps, calls, order } = srFakes({ request: WRITE_REQ });
    deps.dropRunSample = async (id) => (order.push(`drop ${id}`), drops.push(id), 1);
    const res = await handle(srResult({ sample: SAMPLE, ...over }), deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.run_kind, "write");
    assert.equal(body.status, status);
    assert.equal(body.line, `run ${LINK_ID} ${line}`);
    assert.equal(body.evidence, null);
    assert.equal(body.sample_stored, false);
    assert.equal(body.sample_dropped, 1);
    assert.deepEqual(drops, [REQ_ID]);
    assert.deepEqual(order, [...READS, "finish", `drop ${REQ_ID}`, `status ${status}`]);
    assert.equal(calls.sample, undefined);
  }
});

test("sf_run write: a failed drop doesn't fail the write; the run summary says so", async () => {
  const { deps, calls } = srFakes({ request: WRITE_REQ });
  deps.dropRunSample = async () => { throw new Error("fetch failed"); };
  const res = await handle(srResult({ summary: "write done: 45 changed".padEnd(290, ".") }), deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "succeeded");
  assert.equal(body.sample_dropped, null);
  const note = calls.finished[1].summary;
  assert.ok(note.length <= 300);
  assert.match(note, /\(sample not dropped: fetch failed; the 24-hour prune removes it\)$/);
  assert.deepEqual(calls.status, [{ id: "sr-1", status: "succeeded" }]);
});

test("sf_run other: a check page's run, or one the link no longer names, records nothing but its run", async () => {
  for (const over of [{ request: { ...REQ_ROW, page: "check", base_page: "check" } }, { link: { ...LINK_ROW, action_id: "sr-0" } }]) {
    const { deps, order } = srFakes(over);
    deps.dropRunSample = async () => { throw new Error("not called"); };
    const body = await (await handle(srResult({ sample: SAMPLE }), deps)).json();
    assert.equal(body.run_kind, "other");
    assert.equal(body.evidence, null);
    assert.deepEqual(order, [...READS, "finish", "status succeeded"]);
  }
});

test("sf_run result: a sample refused after the evidence is in is noted, not fatal; the run keeps its PASS", async () => {
  for (const code of ["P0002", "23514", "55000"]) {
    const { deps, calls } = srFakes({ sample: async () => { throw coded(code, "no valid checks to hold it against"); } });
    const res = await handle(srResult({ sample: SAMPLE }), deps);
    assert.equal(res.status, 200, code);
    const body = await res.json();
    assert.equal(body.status, "succeeded");
    assert.equal(body.line, `run ${LINK_ID} done: PASS`);
    assert.equal(body.evidence.recorded, 2);
    assert.equal(body.sample_stored, false);
    assert.match(calls.finished.at(-1).summary, new RegExp(`\\(sample refused \\(${code}\\): no valid checks`));
    assert.deepEqual(calls.finished[0].result, { ok: true, pass: true, checks: CHECKS });
  }
});

test("sf_run result: an evidence refusal with P0002, 23514 or 55000 fails the run at once, names the fix, and isn't retried", async () => {
  const { FINAL_SQLSTATES } = await import("./core.ts");
  assert.deepEqual(FINAL_SQLSTATES, ["P0002", "23514", "55000"]);
  for (const code of FINAL_SQLSTATES) {
    for (const which of ["evidence"]) {
      const throws = async () => { throw coded(code, `switchboard_x: refused for 003000000000001AAA`); };
      const { deps, calls } = srFakes({ evidence: throws });
      const res = await handle(srResult({ sample: SAMPLE }), deps);
      assert.equal(res.status, 422, `${which} ${code}`);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.retry, false);
      assert.equal(body.status, "failed");
      assert.equal(body.line, `run ${LINK_ID} failed`);
      assert.match(body.error, new RegExp(`^${which} refused \\(${code}\\): .+ — .+`));
      assert.ok(!body.error.includes("003000000000001AAA"));
      const last = calls.finished.at(-1);
      assert.match(last.summary, new RegExp(`^${which} refused \\(${code}\\)`));
      assert.deepEqual(last.result, { ok: false, pass: true, checks: CHECKS, refused: which, sqlstate: code });
      assert.ok(!JSON.stringify(calls.finished).includes("Sam Ple"));
      assert.deepEqual(calls.status, [{ id: "sr-1", status: "failed" }]);
    }
  }
});

test("sf_run result: any other code (network, PostgREST, server) keeps the 503 retry", async () => {
  for (const code of ["", "PGRST301", "57014", "08006", undefined]) {
    const { deps, calls } = srFakes({ evidence: async () => { throw code === undefined ? new Error("boom") : coded(code); } });
    const res = await handle(srResult(), deps);
    assert.equal(res.status, 503, String(code));
    assert.equal((await res.json()).retry, true);
    assert.deepEqual(calls.status, []);
  }
});

test("sf_run result: a repeat after it finished records nothing and answers already, with the stored line", async () => {
  const { deps, order } = srFakes({
    action: { status: "succeeded" },
    run: { finished_at: "2026-11-24T10:05:00Z", result: { ok: true, pass: false, checks: CHECKS } },
  });
  const res = await handle(srResult({ sample: SAMPLE }), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true, already: true, action_id: "sr-1", run_id: "run-s", status: "succeeded", link_id: LINK_ID,
    line: `run ${LINK_ID} done: FAIL`,
  });
  assert.deepEqual(order, []);
});

test("sf_run result: a run recorded PASS whose action the stale check failed answers failed, never PASS", async () => {
  const { deps, order } = srFakes({
    action: { status: "failed" },
    run: { finished_at: "2026-11-24T10:05:00Z", result: { ok: true, pass: true, checks: CHECKS } },
  });
  const body = await (await handle(srResult(), deps)).json();
  assert.equal(body.line, `run ${LINK_ID} failed`);
  assert.deepEqual(order, []);
});

test("sf_run pickup: a payload with no link_id fails it with no empty-id line", async () => {
  const { deps, calls } = srFakes();
  deps.pickupHelper = async () => ({ ...SR_PICKED, payload: {} });
  const res = await handle(helper("pickup", { kinds: EIGHT }), deps);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).line, undefined);
  assert.deepEqual(calls.status, [{ id: "sr-1", status: "failed" }]);
});

test("sf_run result: a late result after the 4-hour timeout, or before any pickup, is refused", async () => {
  const late = srFakes({
    action: { status: "failed" },
    run: { finished_at: "2026-11-24T14:05:00Z", result: { ok: false, timed_out: true } },
  });
  assert.equal((await handle(srResult(), late.deps)).status, 409);
  assert.deepEqual(late.order, []);
  const unpicked = srFakes({ action: { picked_up_at: null } });
  assert.equal((await handle(srResult(), unpicked.deps)).status, 409);
  assert.deepEqual(unpicked.order, []);
});

test("sf_run link: the runner's approve routes never serve one", async () => {
  const { deps, calls, action } = gitFakes();
  Object.assign(action, { kind: "sf_run", payload: { link_id: LINK_ID } });
  for (const route of ["preview", "approve", "cancel"]) {
    const res = await handle(post(route, { token: TOKEN, fingerprint: "fp-1" }, jwt()), deps);
    assert.equal(res.status, 409, route);
  }
  nothingRan(calls);
});

test("index.ts: the link read names its columns and leaves token_hash out; never reads samples; the two writes by rpc", () => {
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const cols = /const RUN_LINK_COLUMNS =\s*"([^"]+)"/.exec(src)?.[1];
  assert.ok(cols, "RUN_LINK_COLUMNS");
  assert.ok(!cols.includes("token_hash"));
  for (const c of ["id", "user_id", "request_id", "request_version", "review_id", "desktop", "used_at", "action_id", "rerun_at",
                   "rerun_action_id", "voided_at", "void_reason", "created_at"]) {
    assert.ok(cols.split(", ").includes(c), c);
  }
  assert.match(src, /from\("switchboard_run_links"\)\.select\(RUN_LINK_COLUMNS\)/);
  assert.match(src, /from\("switchboard_run_requests"\)\.select\("\*"\)/);
  assert.ok(!src.includes("switchboard_run_samples"));
  assert.match(src, /coded\(await db\.rpc\("switchboard_store_run_sample", \{ p_request_id: requestId, p_sample: sample \}\)\)/);
  assert.match(src, /coded\(await db\.rpc\("switchboard_record_run_evidence", \{ p_run_id: runId \}\)\)/);
  assert.match(src, /coded\(await db\.rpc\("switchboard_drop_run_sample", \{ p_request_id: requestId \}\)\)/);
  // The SQLSTATE rides on the thrown error, so core can tell a refusal from a network error.
  assert.match(src, /throw Object\.assign\(new Error\(res\.error\.message\), \{ code: res\.error\.code \?\? "" \}\)/);
  assert.match(src, /select\("id, action_id, mode, finished_at, result"\)/);
});
