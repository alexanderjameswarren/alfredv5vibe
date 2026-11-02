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
});

test("issue: a matching fingerprint calls switchboard_issue_link and returns its result", async () => {
  const link = { action_id: ACTION_ID, url: "https://x/approve/t", expires_at: "2026-11-01T12:30:00Z", headline: "H" };
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
  const live = "switchboard_issue_link: another link is live (action z). One at a time: wait until it is used or expires.";
  await assert.rejects(issue({ data: null, error: { code: "55000", message: live } }),
    (e) => e.message.includes("refused") && e.message.includes("another link is live"));
  await assert.rejects(issue({ data: null, error: { code: "57014", message: "timeout" } }),
    (e) => !e.message.includes("refused") && e.message.includes("timeout"));
});
