// Handler tests for switchboard.ts.
//
// Run:
//   node --experimental-strip-types --test supabase/functions/_shared/tools/switchboard.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTool } from "./test-platform.mjs";

const m = await loadTool("switchboard.ts");

const ACTION_ID = "26f0cc8f-6ef0-4f14-81da-a915ad086e5b";
const RUN_ID = "11111111-2222-4333-8444-555555555555";
const FP = "a".repeat(64);
const SQL = `select 1 -- ${"x".repeat(5000)}`;
const ACTION = { id: ACTION_ID, kind: "sql", project_code: "p", status: "queued", headline: "THIS READS", fingerprint: FP,
  payload: { sql: SQL } };
const RUN = { id: RUN_ID, action_id: ACTION_ID, mode: "dry_run", summary: "reads 1 row", result: { ok: true } };

/** Fake db: chains on a table resolve to `tables[table]`; rpc answers from `rpc`. Every call is logged. */
function fakeDb({ tables = {}, rpc = { data: null, error: null } } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const b = new Proxy({}, {
        get: (_t, k) => {
          if (k === "then") return (res) => res(tables[table] ?? { data: null, error: null });
          return (...args) => { calls.push([table, k, ...args]); return b; };
        },
      });
      return b;
    },
    rpc(name, params) {
      calls.push(["rpc", name, params]);
      return Promise.resolve(rpc);
    },
  };
}
const ok = (data) => ({ data, error: null });

test("tiers", () => {
  assert.equal(m.getSwitchboardRunTool.tier, 1);
  assert.equal(m.issueSwitchboardLinkTool.tier, 2);
  assert.equal(m.getSqlReadTool.tier, 1);
});

// --- get_sql_read ---------------------------------------------------------------------------------------------------

const MINUTE = 60 * 1000;
// Shaped as EXPLAIN (VERBOSE, FORMAT JSON) answers.
const planOf = (node) => [{ Plan: node }];
const PLAN_PUBLIC = planOf({ "Node Type": "Seq Scan", Schema: "public", "Relation Name": "items", Alias: "items", Output: ["id", "lower(title)"], Filter: "(status = 'net.http_get('::text)" });

/** A db with the kill switch, two window counts, and a record of what was logged. */
function readDb({ enabled = true, tenMin = 0, day = 0, settingsError = null, countError = null, logError = null } = {}) {
  const logged = [];
  const calls = [];
  return {
    logged,
    calls,
    from(table) {
      calls.push(table);
      if (table === "switchboard_settings") {
        return { select: () => ({ maybeSingle: async () => ({ data: enabled === null ? null : { reads_enabled: enabled }, error: settingsError }) }) };
      }
      assert.equal(table, "switchboard_read_log");
      return {
        select: () => ({
          gte: async (_col, iso) => ({
            count: Date.now() - Date.parse(iso) < 20 * MINUTE ? tenMin : day,
            error: countError,
          }),
        }),
        insert: async (row) => { logged.push(row); return { error: logError }; },
      };
    },
    rpc() { throw new Error("get_sql_read must not touch the budget RPC itself"); },
  };
}

/** Stands in for postgres.js and for how Postgres answers each statement. */
function fakeReader({ rows = [{ n: 1 }], error = null, connectError = null, plan = PLAN_PUBLIC } = {}) {
  const log = { sent: [], options: [], ended: 0, rolledBack: 0, committed: 0, cursorSize: null, url: null };
  const tx = {
    unsafe(text, params, options) {
      log.sent.push(text);
      if (options) log.options.push(options);
      const multi = () => {
        if (/;\s*\S/.test(text)) throw new Error("cannot insert multiple commands into a prepared statement");
      };
      const fail = () => {
        multi();
        if (error) throw new Error(error);
      };
      return {
        then: (res, rej) => {
          try {
            multi();
            res(/^explain/i.test(text) ? [{ "QUERY PLAN": plan }] : []);
          } catch (e) { rej(e); }
        },
        cursor(size) {
          log.cursorSize = size;
          return (async function* () {
            fail();
            yield rows.slice(0, size);
            throw new Error("the caller should have stopped after one batch");
          })();
        },
      };
    },
  };
  const sql = {
    begin: async (fn) => {
      try {
        const out = await fn(tx);
        log.committed++;
        return out;
      } catch (e) {
        log.rolledBack++;
        throw e;
      }
    },
    end: async () => { log.ended++; },
  };
  m.readerSeam.url = () => "postgresql://reader@example/postgres";
  m.readerSeam.connect = async (url) => {
    log.url = url;
    if (connectError) throw new Error(connectError);
    return sql;
  };
  return log;
}

const runRead = (args, db) => m.getSqlReadTool.handler(args, { db });

test("read: begin, read only, both limits, one statement, always rolled back, connection closed", async () => {
  const log = fakeReader();
  const db = readDb();
  const out = await runRead({ sql: "select 1 as n" }, db);
  assert.deepEqual(log.sent.slice(0, 3).map((s) => s.toLowerCase()), [
    "set transaction read only", "set local statement_timeout = '10s'", "set local lock_timeout = '1s'",
  ]);
  assert.equal(log.sent[3], "explain (verbose, format json) select 1 as n");
  assert.equal(log.sent[4], "select 1 as n");
  assert.equal(log.sent.length, 5);
  assert.deepEqual(log.options, [{ simple: false }, { simple: false }]);
  assert.equal(log.committed, 0);
  assert.equal(log.rolledBack, 1);
  assert.equal(log.ended, 1);
  assert.equal(log.url, "postgresql://reader@example/postgres");
  assert.deepEqual(out.rows, [{ n: 1 }]);
  assert.equal(out.ok, true);
  assert.equal(out.count, 1);
  assert.equal(out.truncated, false);
  assert.equal(out.error, null);
});

test("read: the query never goes through ctx.db", async () => {
  fakeReader();
  const db = readDb();
  await runRead({ sql: "select 1" }, db);
  assert.deepEqual([...new Set(db.calls)].sort(), ["switchboard_read_log", "switchboard_settings"]);
});

test("read: capped at 1000 rows, and says so", async () => {
  const log = fakeReader({ rows: Array.from({ length: 2000 }, (_, n) => ({ n })) });
  const db = readDb();
  const out = await runRead({ sql: "select n from t" }, db);
  assert.equal(log.cursorSize, 1001);
  assert.equal(out.rows.length, 1000);
  assert.equal(out.count, 1000);
  assert.equal(out.truncated, true);
  assert.equal(db.logged[0].truncated, true);
  assert.equal(db.logged[0].row_count, 1000);
});

test("read: exactly 1000 rows is not truncated", async () => {
  fakeReader({ rows: Array.from({ length: 1000 }, (_, n) => ({ n })) });
  const out = await runRead({ sql: "select n from t" }, readDb());
  assert.equal(out.count, 1000);
  assert.equal(out.truncated, false);
});

for (const [name, sql, error, want] of [
  ["two statements", "select 1; select 2", null, /multiple commands/],
  ["a write", "delete from t", "cannot execute DELETE in a read-only transaction", /read-only transaction/],
  ["the timeout", "select pg_sleep(11)", "canceling statement due to statement timeout", /statement timeout/],
  ["auth", "select count(*) from auth.users", "permission denied for schema auth", /schema auth/],
]) {
  test(`read: ${name} comes back as Postgres's refusal, rolled back and logged`, async () => {
    const log = fakeReader({ error });
    const db = readDb();
    const out = await runRead({ sql }, db);
    assert.equal(out.ok, false);
    assert.match(out.error, want);
    assert.deepEqual(out.rows, []);
    assert.equal(out.count, 0);
    assert.equal(log.committed, 0);
    assert.equal(log.ended, 1);
    assert.equal(db.logged[0].ok, false);
    assert.match(db.logged[0].error, want);
    assert.equal(db.logged[0].row_count, null);
    assert.equal(db.logged[0].query_text, sql);
  });
}

test("plan guard: a query on public and pg_catalog passes, whatever its strings say", () => {
  assert.deepEqual(m.planProblems(PLAN_PUBLIC), []);
  assert.deepEqual(m.planProblems(planOf({ "Node Type": "Seq Scan", Schema: "pg_catalog", "Relation Name": "pg_class", Output: ["pg_catalog.lower(relname)", "t.n", "(t.a).b"] })), []);
  assert.deepEqual(m.planProblems(planOf({ "Node Type": "Result", Output: ["current_user"] })), []);
  assert.deepEqual(m.planProblems(planOf({ "Node Type": "Function Scan", Schema: "pg_catalog", "Function Name": "generate_series", Output: ["g"] })), []);
});

test("plan guard: finds another schema wherever the plan names it", () => {
  const cases = [
    ["a net table", planOf({ "Node Type": "Seq Scan", Schema: "net", "Relation Name": "_http_response", Output: ["id"] }), /net/],
    ["a table under a join", planOf({ "Node Type": "Hash Join", Schema: undefined, Plans: [{ "Node Type": "Seq Scan", Schema: "public", "Relation Name": "items" }, { "Node Type": "Hash", Plans: [{ "Node Type": "Seq Scan", Schema: "net", "Relation Name": "http_request_queue" }] }] }), /net/],
    ["a net function in the output", planOf({ "Node Type": "Result", Output: ["net.http_get('https://x'::text)"] }), /net\.http_get/],
    ["a function in a filter", planOf({ "Node Type": "Seq Scan", Schema: "public", "Relation Name": "items", Filter: "(net.check(id) = 1)" }), /net\.check/],
    ["a quoted function name", planOf({ "Node Type": "Result", Output: ['"Odd"."fn"(1)'] }), /Odd/],
    ["a function in the from clause", planOf({ "Node Type": "Function Scan", Schema: "vault", "Function Name": "x" }), /vault/],
    ["a cast to another schema's type", planOf({ "Node Type": "Result", Output: ["'a'::net.http_method"] }), /net/],
    ["a function that runs a query from text", planOf({ "Node Type": "Result", Output: ["query_to_xml('select 1 from net._http_response'::text, false, false, ''::text)"] }), /query_to_xml/],
    ["ts_stat", planOf({ "Node Type": "Function Scan", Schema: "pg_catalog", "Function Name": "ts_stat", "Function Call": "ts_stat('select 1'::text)" }), /ts_stat/],
  ];
  for (const [name, plan, want] of cases) assert.match(m.planProblems(plan).join(), want, name);
});

for (const [name, sql, plan, want] of [
  ["net tables", "select * from net._http_response", planOf({ "Node Type": "Seq Scan", Schema: "net", "Relation Name": "_http_response" }), /net/],
  ["net functions", "select net.http_get('https://x')", planOf({ "Node Type": "Result", Output: ["net.http_get('https://x'::text)"] }), /net\.http_get/],
  ["information_schema, whose plan shows only pg_catalog", "select count(*) from information_schema.tables", planOf({ "Node Type": "Aggregate", Plans: [{ "Node Type": "Seq Scan", Schema: "pg_catalog", "Relation Name": "pg_class" }] }), /information_schema/],
  ["information_schema, quoted", 'select 1 from "information_schema"."tables"', PLAN_PUBLIC, /information_schema/],
]) {
  test(`read: the guard refuses ${name} before the query runs, and logs it`, async () => {
    const log = fakeReader({ plan });
    const db = readDb();
    const out = await runRead({ sql }, db);
    assert.equal(out.ok, false);
    assert.match(out.error, want);
    assert.match(out.error, /public and pg_catalog/);
    assert.ok(!log.sent.includes(sql), "the query itself must not be sent");
    assert.equal(log.committed, 0);
    assert.equal(db.logged[0].ok, false);
    assert.match(db.logged[0].error, want);
  });
}

test("read: a query on public still runs, and a string naming a schema doesn't trip it", async () => {
  const log = fakeReader();
  const sql = "select id from items where title = 'information_schema net.http_get('";
  const out = await runRead({ sql }, readDb());
  assert.equal(out.ok, true);
  assert.ok(log.sent.includes(sql));
});

test("read: a plan that comes back as text is read the same", async () => {
  fakeReader({ plan: JSON.stringify(planOf({ "Node Type": "Seq Scan", Schema: "net", "Relation Name": "x" })) });
  assert.equal((await runRead({ sql: "select 1" }, readDb())).ok, false);
});

test("read: a plan that can't be read refuses, rather than running unchecked", async () => {
  const log = fakeReader({ plan: "not json" });
  const out = await runRead({ sql: "select 1" }, readDb());
  assert.equal(out.ok, false);
  assert.ok(!log.sent.includes("select 1"));
});

test("read: a trailing semicolon is still one statement", async () => {
  fakeReader();
  assert.equal((await runRead({ sql: "select 1;" }, readDb())).ok, true);
});

test("read: the log holds the query and the outcome, never the rows", async () => {
  fakeReader({ rows: [{ secret_value: "PRIVATE" }] });
  const db = readDb();
  await runRead({ sql: "select x from t" }, db);
  const row = db.logged[0];
  assert.deepEqual(Object.keys(row).sort(), ["error", "ok", "query_text", "row_count", "took_ms", "truncated"]);
  assert.equal(row.ok, true);
  assert.equal(row.row_count, 1);
  assert.equal(typeof row.took_ms, "number");
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE/);
});

test("read: the kill switch refuses, logs, and never connects", async () => {
  const log = fakeReader();
  const db = readDb({ enabled: false });
  await assert.rejects(runRead({ sql: "select 1" }, db), /reads_enabled|switched off/);
  assert.equal(log.url, null);
  assert.equal(db.logged[0].ok, false);
  assert.match(db.logged[0].error, /switched off/);
});

test("read: no settings row, or an unreadable one, fails closed", async () => {
  const log = fakeReader();
  await assert.rejects(runRead({ sql: "select 1" }, readDb({ enabled: null })), /no settings/);
  await assert.rejects(runRead({ sql: "select 1" }, readDb({ settingsError: { message: "boom" } })), /boom/);
  assert.equal(log.url, null);
});

for (const [name, counts, want] of [
  ["20 in 10 minutes", { tenMin: 20, day: 20 }, /20 .*10 minutes/],
  ["200 in a day", { tenMin: 1, day: 200 }, /200 .*day/],
]) {
  test(`read: the budget stops ${name}, in terminal words, logged, never connecting`, async () => {
    const log = fakeReader();
    const db = readDb(counts);
    await assert.rejects(runRead({ sql: "select 1" }, db), (e) => want.test(e.message) && /Do NOT retry/.test(e.message));
    assert.equal(log.url, null);
    assert.equal(db.logged[0].ok, false);
  });
}

test("read: one under each limit goes through", async () => {
  fakeReader();
  assert.equal((await runRead({ sql: "select 1" }, readDb({ tenMin: 19, day: 199 }))).ok, true);
});

test("read: an unreadable budget fails closed", async () => {
  const log = fakeReader();
  await assert.rejects(runRead({ sql: "select 1" }, readDb({ countError: { message: "boom" } })), /boom/);
  assert.equal(log.url, null);
});

test("read: bad input is refused and logged", async () => {
  const log = fakeReader();
  for (const sql of [undefined, "", "   ", 7, "x".repeat(20001)]) {
    const db = readDb();
    await assert.rejects(runRead({ sql }, db), /`sql`/);
    assert.equal(db.logged.length, 1);
    assert.equal(db.logged[0].ok, false);
    assert.ok(db.logged[0].query_text.length <= 20000);
  }
  assert.equal(log.url, null);
});

test("read: no secret set, or no connection, is an error in words, and logged", async () => {
  fakeReader();
  m.readerSeam.url = () => "";
  const db = readDb();
  const out = await runRead({ sql: "select 1" }, db);
  assert.equal(out.ok, false);
  assert.match(out.error, /SWITCHBOARD_READER_DB_URL/);
  assert.equal(db.logged.length, 1);
  fakeReader({ connectError: "connection refused" });
  const down = await runRead({ sql: "select 1" }, readDb());
  assert.equal(down.ok, false);
  assert.match(down.error, /connection refused/);
});

test("read: a failed log write is said, and the answer still comes back", async () => {
  fakeReader();
  const out = await runRead({ sql: "select 1" }, readDb({ logError: { message: "log down" } }));
  assert.equal(out.ok, true);
  assert.match(out.log_error, /log down/);
});

test("read: an error's text can't carry the connection string", async () => {
  fakeReader({ error: "failed for postgresql://claude_reader.x:hunter2@host:6543/postgres" });
  const db = readDb();
  const out = await runRead({ sql: "select 1" }, db);
  assert.doesNotMatch(out.error, /hunter2/);
  assert.doesNotMatch(db.logged[0].error, /hunter2/);
});

test("get: by action, the whole SQL and the latest run", async () => {
  const db = fakeDb({ tables: { switchboard_actions: ok(ACTION), switchboard_runs: ok(RUN) } });
  const out = await m.getSwitchboardRunTool.handler({ action_id: ACTION_ID }, { db });
  assert.equal(out.action.payload.sql, SQL);
  assert.equal(out.action.fingerprint, FP);
  assert.deepEqual(out.run, RUN);
  assert.ok(db.calls.some((c) => c[0] === "switchboard_runs" && c[1] === "order" && c[2] === "started_at" && c[3].ascending === false));
  assert.ok(db.calls.some((c) => c[0] === "switchboard_runs" && c[1] === "limit" && c[2] === 1));
});

test("get: an action with no run has run null", async () => {
  const db = fakeDb({ tables: { switchboard_actions: ok(ACTION), switchboard_runs: ok(null) } });
  const out = await m.getSwitchboardRunTool.handler({ action_id: ACTION_ID }, { db });
  assert.equal(out.run, null);
});

test("get: by run, that run and its action", async () => {
  const db = fakeDb({ tables: { switchboard_actions: ok(ACTION), switchboard_runs: ok(RUN) } });
  const out = await m.getSwitchboardRunTool.handler({ run_id: RUN_ID }, { db });
  assert.equal(out.run.id, RUN_ID);
  assert.equal(out.action.id, ACTION_ID);
  assert.ok(db.calls.some((c) => c[0] === "switchboard_runs" && c[1] === "eq" && c[2] === "id" && c[3] === RUN_ID));
  assert.ok(db.calls.some((c) => c[0] === "switchboard_actions" && c[1] === "eq" && c[2] === "id" && c[3] === ACTION_ID));
});

test("get: never selects link_hash", async () => {
  const db = fakeDb({ tables: { switchboard_actions: ok(ACTION), switchboard_runs: ok(RUN) } });
  await m.getSwitchboardRunTool.handler({ action_id: ACTION_ID }, { db });
  const selects = db.calls.filter((c) => c[1] === "select");
  assert.equal(selects.length, 2);
  for (const c of selects) {
    assert.doesNotMatch(c[2], /link_hash|\*/);
  }
});

test("get: exactly one id, well formed, and found", async () => {
  const run = m.getSwitchboardRunTool.handler;
  const db = fakeDb({ tables: { switchboard_actions: ok(null), switchboard_runs: ok(null) } });
  await assert.rejects(run({}, { db }), /exactly one of/);
  await assert.rejects(run({ action_id: ACTION_ID, run_id: RUN_ID }, { db }), /exactly one of/);
  await assert.rejects(run({ action_id: "nope" }, { db }), /action_id.*UUID/);
  await assert.rejects(run({ action_id: ACTION_ID }, { db }), /no such action/);
  await assert.rejects(run({ run_id: RUN_ID }, { db }), /no such run/);
  await assert.rejects(run({ action_id: ACTION_ID, project_code: "p-a1" }, { db }), /exactly one of/);
});

test("get: by project_code, its latest action of any kind and that action's latest run", async () => {
  const db = fakeDb({ tables: { switchboard_actions: ok(ACTION), switchboard_runs: ok(RUN) } });
  const out = await m.getSwitchboardRunTool.handler({ project_code: "switchboard2-h8r" }, { db });
  assert.equal(out.action.id, ACTION_ID);
  assert.deepEqual(out.run, RUN);
  const a = db.calls.filter((c) => c[0] === "switchboard_actions");
  assert.ok(a.some((c) => c[1] === "eq" && c[2] === "project_code" && c[3] === "switchboard2-h8r"));
  assert.ok(!a.some((c) => c[1] === "eq" && c[2] === "kind"));
  assert.ok(a.some((c) => c[1] === "order" && c[2] === "created_at" && c[3].ascending === false));
  assert.ok(db.calls.some((c) => c[0] === "switchboard_runs" && c[1] === "eq" && c[2] === "action_id" && c[3] === ACTION_ID));
});

test("get: a bad project_code is refused before any read; an unused one has no action", async () => {
  const run = m.getSwitchboardRunTool.handler;
  const db = fakeDb({ tables: { switchboard_actions: ok(null) } });
  await assert.rejects(run({ project_code: "Bad Code" }, { db }), /project_code/);
  assert.equal(db.calls.length, 0);
  await assert.rejects(run({ project_code: "p-none" }, { db }), /no action for p-none\./);
});

test("issue: a matching fingerprint calls switchboard_issue_link and returns its result", async () => {
  const link = { action_id: ACTION_ID, url: "https://x/approve/t?kind=sql&exp=1793536200", expires_at: "2026-11-01T12:30:00Z", headline: "H" };
  const db = fakeDb({ tables: { switchboard_actions: ok({ fingerprint: FP }) }, rpc: ok(link) });
  const out = await m.issueSwitchboardLinkTool.handler({ action_id: ACTION_ID, fingerprint: FP }, { db });
  assert.deepEqual(out, link);
  assert.ok(db.calls.some((c) => c[0] === "rpc" && c[1] === "switchboard_issue_link" && c[2].p_action_id === ACTION_ID));
});

test("issue: a different fingerprint is refused before any link", async () => {
  const db = fakeDb({ tables: { switchboard_actions: ok({ fingerprint: FP }) } });
  await assert.rejects(m.issueSwitchboardLinkTool.handler({ action_id: ACTION_ID, fingerprint: "b".repeat(64) }, { db }),
    /fingerprint does not match/);
  assert.ok(!db.calls.some((c) => c[0] === "rpc"));
});

test("issue: bad arguments and an unknown action make no link", async () => {
  const run = m.issueSwitchboardLinkTool.handler;
  const db = fakeDb({ tables: { switchboard_actions: ok(null) } });
  await assert.rejects(run({ fingerprint: FP }, { db }), /action_id.*UUID/);
  await assert.rejects(run({ action_id: ACTION_ID }, { db }), /fingerprint/);
  await assert.rejects(run({ action_id: ACTION_ID, fingerprint: FP }, { db }), /no such action/);
  assert.ok(!db.calls.some((c) => c[0] === "rpc"));
});

test("issue: the database's refusal is a refusal, an outage is not", async () => {
  const issue = (rpc) => m.issueSwitchboardLinkTool.handler({ action_id: ACTION_ID, fingerprint: FP },
    { db: fakeDb({ tables: { switchboard_actions: ok({ fingerprint: FP }) }, rpc }) });
  const live = "switchboard_issue_link: another link is live for p-a1b (action z). One at a time per project: wait until it is used or expires.";
  await assert.rejects(issue({ data: null, error: { code: "55000", message: live } }),
    (e) => e.message.includes("refused") && e.message.includes("another link is live"));
  await assert.rejects(issue({ data: null, error: { code: "57014", message: "timeout" } }),
    (e) => !e.message.includes("refused") && e.message.includes("timeout"));
});

// --- queue_switchboard_git ------------------------------------------------------------------------------------------

const LINK = { action_id: ACTION_ID, url: "https://x/approve#t?kind=git&exp=1", expires_at: "2026-11-05T14:00:00Z", headline: "H" };
/** rpc answers by name; every call logged. */
function gitDb({ queue = ok({ action_id: ACTION_ID }), link = ok(LINK) } = {}) {
  const calls = [];
  return {
    calls,
    from() { throw new Error("queue_switchboard_git must not touch a table directly"); },
    rpc(name, params) {
      calls.push([name, params]);
      return Promise.resolve(name === "switchboard_queue_git" ? queue : link);
    },
  };
}
const queueGit = (args, db = gitDb()) => m.queueSwitchboardGitTool.handler(args, { db });

test("git: tier 2", () => assert.equal(m.queueSwitchboardGitTool.tier, 2));

test("git: a Finish queues the payload without project_code, issues the link, headline says what it does", async () => {
  const db = gitDb();
  const out = await queueGit({ project_code: "switchboard2-h8r", command: "gitpush", mode: "finish", finish: "phase" }, db);
  assert.deepEqual(db.calls[0], ["switchboard_queue_git", {
    p_project_code: "switchboard2-h8r", p_payload: { command: "gitpush", mode: "finish", finish: "phase" },
    p_headline: "GITPUSH FINISH switchboard2-h8r: MERGES INTO MAIN, PUSHES, REMOVES THE WORKTREE", p_chat_url: null,
  }]);
  assert.deepEqual(db.calls[1], ["switchboard_issue_link", { p_action_id: ACTION_ID }]);
  assert.equal(out.url, LINK.url);
  assert.equal(out.action_id, ACTION_ID);
});

test("git: headlines", () => {
  const h = (p) => m.gitHeadline("p-a1", p);
  assert.equal(h({ command: "gitcom" }), "GITCOM p-a1: COMMITS ITS CLAIMED FILES");
  assert.equal(h({ command: "gitcom", include_unclaimed: "all" }), "GITCOM p-a1: COMMITS ITS CLAIMED FILES AND EVERY UNCLAIMED CHANGE");
  assert.equal(h({ command: "gitsync" }), "GITSYNC p-a1: MERGES MAIN INTO THE WORKTREE");
  assert.equal(h({ command: "gitnewtree" }), "GITNEWTREE p-a1: CREATES A WORKTREE FROM ORIGIN/MAIN");
  assert.equal(h({ command: "gitpush", mode: "push" }), "GITPUSH PUSH p-a1: COMMITS AND PUSHES MAIN");
  assert.equal(h({ command: "gitpush", mode: "checkpoint", paths: ["a.sql"] }), "GITPUSH CHECKPOINT p-a1: MERGES 1 PATH INTO MAIN, PUSHES");
  assert.equal(h({ command: "gitpush", mode: "checkpoint", all: true, db: "keep" }),
    "GITPUSH CHECKPOINT p-a1: MERGES EVERY UNCOMMITTED PATH INTO MAIN, PUSHES, KEEPS THE DB CLAIMS");
  assert.match(h({ command: "gitpush", mode: "finish", finish: "project-done" }), /REMOVES THE WORKTREE, MOVES THE DOCS TO HISTORY$/);
});

test("git: every accepted shape", () => {
  for (const p of [
    { command: "gitcom", message: " one line ", include_unclaimed: "none" },
    { command: "gitsync" },
    { command: "gitnewtree", install: false },
    { command: "gitpush", mode: "push", message: "m", include_unclaimed: "all" },
    { command: "gitpush", mode: "checkpoint", paths: ["supabase/migrations/207_x.sql", "docs/"], db: "release" },
    { command: "gitpush", mode: "checkpoint", all: true },
    { command: "gitpush", mode: "finish", finish: "project-done", message: "done" },
  ]) assert.ok("payload" in m.gitPayload(p), JSON.stringify(p));
  assert.equal(m.gitPayload({ command: "gitcom", message: " x " }).payload.message, "x");
});

test("git: refused keys and values, before anything is queued", async () => {
  for (const [args, want] of [
    [{ command: "rm" }, /command.*gitcom/],
    [{ command: "gitsync", message: "m" }, /gitsync does not take message/],
    [{ command: "gitcom", sql: "x" }, /does not take sql/],
    [{ command: "gitcom", message: "a\nb" }, /one line/],
    [{ command: "gitcom", message: "--force" }, /not starting with -/],
    [{ command: "gitcom", include_unclaimed: "some" }, /all or none/],
    [{ command: "gitnewtree", install: "yes" }, /true or false/],
    [{ command: "gitpush" }, /needs `mode`/],
    [{ command: "gitpush", mode: "finish" }, /phase .* project-done/],
    [{ command: "gitpush", mode: "push", finish: "phase" }, /only for a Finish/],
    [{ command: "gitpush", mode: "checkpoint" }, /paths.*or `all: true`/],
    [{ command: "gitpush", mode: "checkpoint", paths: ["a"], all: true }, /not both/],
    [{ command: "gitpush", mode: "checkpoint", paths: ["../x"] }, /not a usable path/],
    [{ command: "gitpush", mode: "checkpoint", all: true, db: "drop" }, /release or keep/],
    [{ command: "gitpush", mode: "push", db: "keep" }, /only for a Checkpoint/],
    [{ command: "gitpush", mode: "checkpoint", all: true, include_unclaimed: "all" }, /only for main/],
  ]) {
    const db = gitDb();
    await assert.rejects(queueGit({ project_code: "p-a1", ...args }, db), (e) => /refused/.test(e.message) && want.test(e.message), JSON.stringify(args));
    assert.equal(db.calls.length, 0);
  }
  await assert.rejects(queueGit({ project_code: "Bad Code", command: "gitsync" }), /project_code/);
});

test("git: dot-folders are usable paths; traversal, absolute, drive, backslash and empty segments are not", () => {
  for (const p of [".claude/skills/cli-workflow/SKILL.md", ".clip/x.md", "docs/", "a/.hidden/b.js", "supabase/migrations/208_x.sql"]) {
    assert.ok(m.usablePath(p), p);
  }
  for (const p of ["..", "../x", "a/../b", "a/..", "./a", "a/./b", "/etc/passwd", "C:/x", "C:\\x", "a\\..\\b", "a\\b",
    "a//b", "/", "", "-rf", "a b", 5]) {
    assert.ok(!m.usablePath(p), String(p));
  }
});

test("git: a checkpoint of a .claude path is queued", async () => {
  const db = gitDb();
  await queueGit({ project_code: "p-a1", command: "gitpush", mode: "checkpoint", paths: [".claude/skills/cli-workflow/SKILL.md"] }, db);
  assert.deepEqual(db.calls[0][1].p_payload.paths, [".claude/skills/cli-workflow/SKILL.md"]);
});

test("git: only a claude.ai chat address is kept as chat_url", async () => {
  const chat = `https://claude.ai/chat/${ACTION_ID}`;
  for (const [given, kept] of [[chat, chat], ["https://evil/", null], ["https://claude.ai/project/x", null], [undefined, null]]) {
    const db = gitDb();
    await queueGit({ project_code: "p-a1", command: "gitsync", chat_url: given }, db);
    assert.equal(db.calls[0][1].p_chat_url, kept, String(given));
  }
});

test("git: the reply says the result arrives in this chat", async () => {
  const out = await queueGit({ project_code: "p-a1", command: "gitsync" });
  assert.match(out.next, /arrives in this chat/);
  assert.match(out.next, /check the git run/);
  assert.doesNotMatch(out.next, /send git/);
});

// --- queue_switchboard_sf_check and queue_switchboard_sb_setup --------------------------------------------------------

function helperDb({ queue = ok({ action_id: ACTION_ID }), link = ok(LINK) } = {}) {
  const calls = [];
  return {
    calls,
    from() { throw new Error("the helper tools must not touch a table directly"); },
    rpc(name, params) {
      calls.push([name, params]);
      return Promise.resolve(name === "switchboard_queue_helper" ? queue : link);
    },
  };
}
const queueSf = (args, db = helperDb()) => m.queueSwitchboardSfCheckTool.handler(args, { db });
const queueSb = (args, db = helperDb()) => m.queueSwitchboardSbSetupTool.handler(args, { db });
const ORG = { alias: "acme-dev", type: "developer", level: "objects" };
const ORG_ADD = { project_code: "p-a1", command: "org add", client: "acme", orgs: [ORG] };

test("sf_check and sb_setup: tier 2", () => {
  assert.equal(m.queueSwitchboardSfCheckTool.tier, 2);
  assert.equal(m.queueSwitchboardSbSetupTool.tier, 2);
});

test("sf_check: queued with kind sf_check, no link ever, and the reply asks for the queued line", async () => {
  const db = helperDb();
  const out = await queueSf({ project_code: "p-a1", check: "metadata", alias: "acme-dev", metadata_type: "ApexClass" }, db);
  assert.equal(db.calls.length, 1);
  const [name, params] = db.calls[0];
  assert.equal(name, "switchboard_queue_helper");
  assert.equal(params.p_kind, "sf_check");
  assert.deepEqual(params.p_payload, { check: "metadata", alias: "acme-dev", metadata_type: "ApexClass" });
  assert.equal(params.p_headline, "SF CHECK p-a1: METADATA ApexClass ON SANDBOX acme-dev, READ ONLY");
  assert.equal(out.url, undefined);
  assert.equal(out.queued_line, `sf ${ACTION_ID} queued`);
  assert.match(out.next, new RegExp(`line of its own: sf ${ACTION_ID} queued`));
  assert.match(out.next, new RegExp(`sf ${ACTION_ID} done or failed`));
  assert.match(out.next, /expires unrun after 10 minutes/);
});

test("sf_check: each of the six checks is accepted", async () => {
  for (const check of m.SF_CHECKS) {
    const args = { check, alias: "a1", ...(check === "metadata" ? { metadata_type: "Flow" } : {}) };
    assert.ok("payload" in m.sfCheckPayload(args), check);
  }
});

test("sf_check: refused before anything is queued", async () => {
  for (const args of [
    { check: "sobject-list", alias: "a" }, { check: "limits" }, { check: "limits", alias: "-rf" }, { check: "limits", alias: "a b" },
    { check: "metadata", alias: "a" }, { check: "metadata", alias: "a", metadata_type: "Apex Class" },
    { check: "limits", alias: "a", metadata_type: "Flow" }, { check: "limits", alias: "a", soql: "select" },
  ]) {
    const db = helperDb();
    await assert.rejects(queueSf({ project_code: "p-a1", ...args }, db), /refused/, JSON.stringify(args));
    assert.equal(db.calls.length, 0);
  }
  await assert.rejects(queueSf({ project_code: "BAD CODE", check: "limits", alias: "a" }), /project_code/);
});

test("sb_setup: org add is queued with kind sb_setup, then its link is issued", async () => {
  const db = helperDb();
  const out = await queueSb({ ...ORG_ADD, orgs: [{ ...ORG, login: "admin", cli_deploy: true, shared: false }], project: "acme-x1" }, db);
  assert.deepEqual(db.calls.map((c) => c[0]), ["switchboard_queue_helper", "switchboard_issue_link"]);
  assert.equal(db.calls[0][1].p_kind, "sb_setup");
  assert.equal(db.calls[0][1].p_payload.project_code, undefined);
  assert.equal(db.calls[0][1].p_headline, "SB ORG ADD p-a1: ADDS SANDBOX acme-dev FOR CLIENT acme TO ORGS.JSON");
  assert.equal(out.url, LINK.url);
  assert.match(out.next, new RegExp(`sb ${ACTION_ID} done or failed`));
});

test("sb_setup: client start with several orgs, each becoming an --org-setup", async () => {
  const db = helperDb();
  await queueSb({ project_code: "p-a1", command: "client start", client: "acme", repo: "https://github.com/a/b.git", name: "Acme",
    sandboxes: "all", integration_ok: true, orgs: [ORG, { alias: "acme-uat", type: "partial", level: "metadata", shared: true }] }, db);
  assert.equal(db.calls[0][1].p_payload.orgs.length, 2);
  assert.match(db.calls[0][1].p_headline, /SB CLIENT START p-a1: SETS UP CLIENT acme WITH 2 SANDBOXES/);
});

test("sb_setup: Alex's D2 limits are refused in the tool, before anything is queued", async () => {
  for (const [args, why] of [
    [{ ...ORG_ADD, orgs: [{ ...ORG, type: "production" }] }, /production is never set up by link/],
    [{ ...ORG_ADD, orgs: [{ ...ORG, type: "scratch" }] }, /must be a sandbox/],
    [{ ...ORG_ADD, orgs: [{ ...ORG, level: "ids" }] }, /objects or metadata only/],
    [{ ...ORG_ADD, orgs: [{ ...ORG, level: "data" }] }, /objects or metadata only/],
    [{ ...ORG_ADD, orgs: [{ ...ORG, contract_ok: true }] }, /never set by link/],
    [{ ...ORG_ADD, orgs: [{ ...ORG, "contract-ok": false }] }, /never set by link/],
    [{ ...ORG_ADD, contract_ok: true }, /never set by link/],
    [{ ...ORG_ADD, orgs: [{ ...ORG, production_allowed: true }] }, /never set by link/],
  ]) {
    const db = helperDb();
    await assert.rejects(queueSb(args, db), why, JSON.stringify(args));
    assert.equal(db.calls.length, 0);
  }
});

test("sb_setup: shape refusals, before anything is queued", async () => {
  for (const args of [
    { ...ORG_ADD, command: "org set" }, { ...ORG_ADD, client: "Acme Co" }, { ...ORG_ADD, orgs: [] }, { ...ORG_ADD, orgs: ORG },
    { ...ORG_ADD, orgs: [ORG, { ...ORG, alias: "acme-uat" }] },
    { ...ORG_ADD, orgs: [{ ...ORG, login: "root" }] }, { ...ORG_ADD, orgs: [{ ...ORG, cli_deploy: "yes" }] },
    { ...ORG_ADD, orgs: [{ ...ORG, password: "x" }] }, { ...ORG_ADD, repo: "x" }, { ...ORG_ADD, extra: 1 },
    { ...ORG_ADD, sandboxes: "some" }, { ...ORG_ADD, integration_ok: "no" }, { ...ORG_ADD, project: "Bad Code" },
    { ...ORG_ADD, command: "client start" },
    { ...ORG_ADD, command: "client start", repo: "a", adopt: "b" },
    { ...ORG_ADD, command: "client start", repo: "-x" },
    { ...ORG_ADD, command: "client start", from_sandbox: "a b" },
    { ...ORG_ADD, command: "client start", adopt: "C:/x", name: "n".repeat(61) },
    { ...ORG_ADD, command: "client start", adopt: "C:/x", orgs: [ORG, ORG] },
    { ...ORG_ADD, command: "client start", adopt: "C:/x", orgs: Array.from({ length: 11 }, (_, i) => ({ ...ORG, alias: `a${i}` })) },
  ]) {
    const db = helperDb();
    await assert.rejects(queueSb(args, db), /refused/, JSON.stringify(args));
    assert.equal(db.calls.length, 0);
  }
});

test("sf_check and sb_setup: a database refusal is passed on; a link refusal says it was queued", async () => {
  await assert.rejects(queueSf({ project_code: "p-a1", check: "limits", alias: "a" }, helperDb({ queue: { data: null, error: { code: "23514", message: "payload check" } } })),
    /refused: payload check/);
  await assert.rejects(queueSb(ORG_ADD, helperDb({ link: { data: null, error: { code: "55000", message: "another link is live" } } })),
    (e) => e.message.includes(`queued as ${ACTION_ID}`));
});

test("git: a queue or link refusal is passed on, and says when the action was queued", async () => {
  await assert.rejects(queueGit({ project_code: "p-a1", command: "gitsync" }, gitDb({ queue: { data: null, error: { code: "23514", message: "payload check" } } })),
    /refused: payload check/);
  await assert.rejects(queueGit({ project_code: "p-a1", command: "gitsync" }, gitDb({ link: { data: null, error: { code: "55000", message: "another link is live" } } })),
    (e) => e.message.includes(`queued as ${ACTION_ID}`) && e.message.includes("another link is live"));
});
