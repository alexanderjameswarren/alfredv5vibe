// switchboard-runner: statement parsing, headlines, refusals and the routes, against fake dependencies.
// Run: node --experimental-strip-types --test supabase/functions/switchboard-runner/core.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildHeadline, editorReasons, handle, prepare, splitStatements, summarise } from "./core.ts";

const SECRET = "q".repeat(40);
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
    consume: async (jwt, token, fp) => (calls.consumed.push({ jwt, token, fp }), { action_id: "act-1" }),
    runSql: async (statements, commit) => (calls.runSql.push({ statements, commit }), {
      ok: true, results: statements.map(() => ({ command: "DELETE", count: 3 })),
    }),
    recordRun: async (run) => (calls.runs.push(run), "run-1"),
    setStatus: async (id, status) => calls.status.push({ id, status }),
    conformance: async () => "CONFORMANT (97 tables)",
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
  const res = await handle(queue({ project_code: "p-x", sql: "select 1", kind: "git", user_id: "evil", headline: "FINE", fingerprint: "x" }), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, action_id: "new-1", headline: "THIS RUNS A SELECT ON THE LIVE ALFRED DATABASE" });
  assert.deepEqual(calls.inserted, [{
    user_id: USER, kind: "sql", project_code: "p-x", payload: { sql: "select 1" },
    headline: "THIS RUNS A SELECT ON THE LIVE ALFRED DATABASE", created_by: "cli",
  }]);
});

test("queue: bad input, and SQL for the editor, is refused with no row", async () => {
  const cases = [
    [{ sql: "select 1" }, 400], [{ project_code: "Bad Code", sql: "select 1" }, 400], [{ project_code: "p-x" }, 400],
    [{ project_code: "p-x", sql: "x".repeat(600000) }, 400], [{ project_code: "p-x", sql: "vacuum t" }, 422],
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
