// Handler tests for switchboard.ts.
//
// Run:
//   node --experimental-strip-types --test supabase/functions/_shared/tools/switchboard.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTool } from "./test-platform.mjs";
import { createHash } from "node:crypto";

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

// --- get_claim_state (s87e) ------------------------------------------------------------------------------------------

const ALFRED = "C:\\Users\\Alex\\projects\\alfred-v5";
const SWB = "C:\\Users\\Alex\\projects\\switchboard";
const STATE_ROWS = [
  { repo: ALFRED, posted_at: "2026-11-11T07:00:00Z", source_host: "DESK", blocks: [{ waiter: "homer-h4k", holder: "switchboard2-h8r", item: "src/a.js", since: "2026-11-11T06:00:00Z" }],
    claims: [{ item: "src/a.js", owner: "switchboard2-h8r", kind: "file", claimed_at: "2026-11-10T00:00:00Z" },
      { item: "db:deploy", owner: "switchboard2-h8r", kind: "db", claimed_at: "2026-11-11T07:00:00Z" },
      { item: "src/homer/", owner: "homer-h4k", kind: "folder", claimed_at: "2026-11-09T00:00:00Z" }] },
  { repo: SWB, posted_at: "2026-11-10T00:00:00Z", source_host: null, blocks: [], claims: [{ item: "claims/", owner: "main", kind: "folder", claimed_at: "2026-11-01T00:00:00Z" }] },
];
const claimState = (args, db = fakeDb({ tables: { switchboard_claim_state: ok(STATE_ROWS) } })) =>
  m.getClaimStateTool.handler(args, { db }).then((out) => ({ out, db }));

test("get_claim_state: tier 1, reads only its table, named columns, clamped", async () => {
  assert.equal(m.getClaimStateTool.tier, 1);
  const { out, db } = await claimState({});
  assert.deepEqual(db.calls.map((c) => c[1]), ["select", "order", "limit"]);
  assert.equal(db.calls[0][0], "switchboard_claim_state");
  assert.equal(db.calls[0][2], "repo, claims, blocks, posted_at, source_host");
  assert.equal(db.calls[2][2], 50);
  assert.equal(out.repos.length, 2);
});

test("get_claim_state: claims grouped by owner, with live blocks", async () => {
  const { out } = await claimState({});
  const a = out.repos[0];
  assert.equal(a.name, "alfred-v5");
  assert.equal(a.posted_at, "2026-11-11T07:00:00Z");
  assert.deepEqual(Object.keys(a.holders).sort(), ["homer-h4k", "switchboard2-h8r"]);
  assert.deepEqual(a.holders["switchboard2-h8r"].map((c) => c.item), ["src/a.js", "db:deploy"]);
  assert.deepEqual(a.holders["homer-h4k"][0], { item: "src/homer/", kind: "folder", claimed_at: "2026-11-09T00:00:00Z" });
  assert.equal(a.blocks.length, 1);
});

test("get_claim_state: repo by key or folder name; project_code keeps its own claims and blocks", async () => {
  assert.deepEqual((await claimState({ repo: "alfred-v5" })).out.repos.map((r) => r.name), ["alfred-v5"]);
  assert.deepEqual((await claimState({ repo: "c:\\users\\alex\\projects\\switchboard\\" })).out.repos.map((r) => r.name), ["switchboard"]);
  assert.deepEqual((await claimState({ repo: "team-impact" })).out.repos, []);
  const { out } = await claimState({ project_code: "homer-h4k" });
  assert.deepEqual(Object.keys(out.repos[0].holders), ["homer-h4k"]);
  assert.equal(out.repos[0].blocks.length, 1);
  assert.deepEqual(out.repos[1].holders, {});
  assert.deepEqual((await claimState({ project_code: "main" })).out.repos[0].blocks, []);
});

test("get_claim_state: bad filters refused; a database error is passed on", async () => {
  await assert.rejects(claimState({ project_code: "Bad Code" }), /project_code/);
  await assert.rejects(claimState({ repo: "" }), /repo/);
  await assert.rejects(claimState({}, fakeDb({ tables: { switchboard_claim_state: { data: null, error: { code: "42501", message: "denied" } } } })), /claim state/);
});

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

test("git: no_prod_deploy on a Finish is stored and the headline says what approving confirms (w3k s9)", async () => {
  const db = gitDb();
  await queueGit({ project_code: "cd_ab_diagnose-r4m", command: "gitpush", mode: "finish", finish: "phase", no_prod_deploy: true }, db);
  assert.deepEqual(db.calls[0][1].p_payload, { command: "gitpush", mode: "finish", finish: "phase", no_prod_deploy: true });
  assert.equal(db.calls[0][1].p_headline, "GITPUSH FINISH cd_ab_diagnose-r4m: MERGES INTO MAIN, PUSHES, REMOVES THE WORKTREE; " +
    "APPROVING CONFIRMS NOTHING FROM CD_AB_DIAGNOSE-R4M WENT TO PRODUCTION");
  assert.doesNotMatch(m.gitHeadline("p-a1", { command: "gitpush", mode: "finish", finish: "phase" }), /PRODUCTION/);
});

test("git: no_prod_deploy refused off a Finish or when not true, before anything is queued (w3k s9)", async () => {
  for (const [args, want] of [
    [{ command: "gitpush", mode: "checkpoint", all: true, no_prod_deploy: true }, /only for gitpush finish, not checkpoint/],
    [{ command: "gitpush", mode: "push", no_prod_deploy: true }, /only for gitpush finish, not push/],
    [{ command: "gitsync", no_prod_deploy: true }, /only for gitpush finish, not gitsync/],
    [{ command: "gitcom", no_prod_deploy: true }, /only for gitpush finish, not gitcom/],
    [{ command: "gitnewtree", no_prod_deploy: true }, /only for gitpush finish, not gitnewtree/],
    [{ command: "gitpush", mode: "finish", finish: "phase", no_prod_deploy: false }, /can only be true/],
    [{ command: "gitpush", mode: "finish", finish: "phase", no_prod_deploy: "yes" }, /can only be true/],
  ]) {
    const db = gitDb();
    await assert.rejects(queueGit({ project_code: "p-a1", ...args }, db), want, JSON.stringify(args));
    assert.equal(db.calls.length, 0);
  }
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
  const nt = m.gitPayload({ command: "gitnewtree", install: true, repo: " C:\\Users\\Alex\\projects\\alfred-v5 " }).payload;
  assert.equal(nt.repo, "C:\\Users\\Alex\\projects\\alfred-v5");
  assert.equal(m.gitHeadline("p-a1", nt), "GITNEWTREE p-a1: CREATES A WORKTREE FROM ORIGIN/MAIN IN C:\\USERS\\ALEX\\PROJECTS\\ALFRED-V5");
});

test("git: gitnewtree takes client, lane and main: true, as the helper's KEYS.gitnewtree (sb3 E2, r6)", () => {
  const p = m.gitPayload({ command: "gitnewtree", client: "team-impact", lane: "Side road", main: true,
    repo: "C:\\Users\\Alex\\projects\\ti" }).payload;
  assert.deepEqual(p, { command: "gitnewtree", client: "team-impact", lane: "Side road", main: true, repo: "C:\\Users\\Alex\\projects\\ti" });
  for (const lane of ["Fast track", "Main", "Side road", "Country road"]) {
    assert.equal(m.gitPayload({ command: "gitnewtree", lane }).payload.lane, lane);
  }
  assert.equal(m.gitHeadline("p-a1", { command: "gitnewtree", main: true }), "GITNEWTREE p-a1: BINDS MAIN TO THE PROJECT");
  assert.equal(m.gitHeadline("p-a1", { command: "gitnewtree", main: true, repo: "C:\\Users\\Alex\\projects\\ti" }),
    "GITNEWTREE p-a1: BINDS MAIN TO THE PROJECT IN C:\\USERS\\ALEX\\PROJECTS\\TI");
  assert.equal(m.gitHeadline("p-a1", { command: "gitnewtree", client: "acme", lane: "Main" }),
    "GITNEWTREE p-a1: CREATES A WORKTREE FROM ORIGIN/MAIN");
});

test("git: gitnewtree's client, lane and main refused as the helper refuses them, and only on gitnewtree", async () => {
  for (const [args, want] of [
    [{ command: "gitnewtree", client: "Team_Impact" }, /client must be a client slug/],
    [{ command: "gitnewtree", client: "-acme" }, /client must be a client slug/],
    [{ command: "gitnewtree", client: "a".repeat(42) }, /client must be a client slug/],
    [{ command: "gitnewtree", client: 5 }, /client must be a client slug/],
    [{ command: "gitnewtree", lane: "main" }, /lane must be one of Fast track, Main, Side road, Country road/],
    [{ command: "gitnewtree", lane: "" }, /lane must be one of/],
    [{ command: "gitnewtree", main: false }, /main takes only true/],
    [{ command: "gitnewtree", main: "true" }, /main takes only true/],
    [{ command: "gitsync", client: "acme" }, /gitsync does not take client/],
    [{ command: "gitcom", lane: "Main" }, /gitcom does not take lane/],
    [{ command: "gitpush", mode: "push", main: true }, /does not take main/],
  ]) {
    const db = gitDb();
    await assert.rejects(queueGit({ project_code: "p-a1", ...args }, db), want, JSON.stringify(args));
    assert.equal(db.calls.length, 0);
  }
  assert.match(m.gitPayload({ command: "gitnewtree", client: "Acme" }).refused, / — ask for a new link with the client's slug\.$/);
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
    [{ command: "gitsync", repo: "C:\\Users\\Alex\\projects\\alfred-v5" }, /gitsync does not take repo/],
    [{ command: "gitpush", mode: "push", repo: "C:\\Users\\Alex\\projects\\alfred-v5" }, /does not take repo/],
    [{ command: "gitnewtree", repo: "projects\\alfred-v5" }, /absolute path/],
    [{ command: "gitnewtree", repo: "C:/Users/Alex/projects/alfred-v5" }, /absolute path/],
    [{ command: "gitnewtree", repo: "C:\\Users\\Alex\\projects\\alfred-v5\\" }, /absolute path/],
    [{ command: "gitnewtree", repo: "C:\\Users\\Alex\\..\\x" }, /absolute path/],
    [{ command: "gitnewtree", repo: "\\\\server\\share" }, /absolute path/],
    [{ command: "gitnewtree", repo: 5 }, /absolute path/],
    [{ command: "gitnewtree", repo: "C:\\" + "a".repeat(240) }, /absolute path/],
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
const ORG = { alias: "acme-dev", type: "developer", level: "objects", login: "integration", cli_deploy: true, shared: false };
const ORG_ADD = { project_code: "p-a1", command: "org add", client: "acme", orgs: [ORG] };
const START = { sandboxes: "all", integration_ok: false, name: "Acme" };

test("sf_check and sb_setup: tier 2", () => {
  assert.equal(m.queueSwitchboardSfCheckTool.tier, 2);
  assert.equal(m.queueSwitchboardSbSetupTool.tier, 2);
});

test("sf_check: queued with kind sf_check, then its link is issued (s86pa)", async () => {
  const db = helperDb();
  const out = await queueSf({ project_code: "p-a1", check: "metadata", alias: "acme-dev", metadata_type: "ApexClass" }, db);
  assert.deepEqual(db.calls.map((c) => c[0]), ["switchboard_queue_helper", "switchboard_issue_link"]);
  const [, params] = db.calls[0];
  assert.equal(params.p_kind, "sf_check");
  assert.deepEqual(params.p_payload, { check: "metadata", alias: "acme-dev", metadata_type: "ApexClass" });
  assert.equal(params.p_headline, "SF CHECK p-a1: METADATA ApexClass ON SANDBOX acme-dev, READ ONLY");
  assert.deepEqual(db.calls[1][1], { p_action_id: ACTION_ID });
  assert.deepEqual(Object.keys(out).sort(), ["action_id", "expires_at", "headline", "next", "payload", "url"]);
  assert.equal(out.url, LINK.url);
  assert.match(out.next, /Give Alex the url whole; it lasts 30 minutes/);
  assert.match(out.next, new RegExp(`sf ${ACTION_ID} done or failed`));
  assert.doesNotMatch(out.next, /queued/);
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

test("sf_check: project_code is optional; without one the database derives it", async () => {
  const db = helperDb();
  await queueSf({ check: "limits", alias: "acme-dev" }, db);
  assert.equal(db.calls[0][1].p_project_code, null);
  assert.equal(db.calls[0][1].p_headline, "SF CHECK: LIMITS ON SANDBOX acme-dev, READ ONLY");
});

test("sb_setup: org add is queued with kind sb_setup, then its link is issued", async () => {
  const db = helperDb();
  const out = await queueSb({ ...ORG_ADD, orgs: [{ ...ORG, login: "admin", cli_deploy: true, shared: false }], project: "acme-x1" }, db);
  assert.deepEqual(db.calls.map((c) => c[0]), ["switchboard_queue_helper", "switchboard_issue_link"]);
  assert.equal(db.calls[0][1].p_kind, "sb_setup");
  assert.equal(db.calls[0][1].p_payload.project_code, undefined);
  assert.equal(db.calls[0][1].p_project_code, null);
  assert.equal(db.calls[0][1].p_headline, "SB ORG ADD acme: ADDS SANDBOX acme-dev TO ORGS.JSON");
  assert.equal(out.url, LINK.url);
  assert.match(out.next, new RegExp(`sb ${ACTION_ID} done or failed`));
});

test("sb_setup: client start with several orgs, each becoming an --org-setup", async () => {
  const db = helperDb();
  await queueSb({ project_code: "p-a1", command: "client start", client: "acme", repo: "https://github.com/a/b.git", name: "Acme",
    sandboxes: "all", integration_ok: true, orgs: [ORG, { ...ORG, alias: "acme-uat", type: "partial", level: "metadata", shared: true }] }, db);
  assert.equal(db.calls[0][1].p_payload.orgs.length, 2);
  assert.match(db.calls[0][1].p_headline, /SB CLIENT START acme: SETS UP THE CLIENT WITH 2 SANDBOXES/);
});

test("sb_setup: from_sandbox needs a folder inside projects", async () => {
  const start = { command: "client start", client: "acme", from_sandbox: "acme-dev", ...START, orgs: [ORG] };
  for (const folder of ["C:\\Users\\Alex\\projects\\acme", "C:\\Users\\Alex\\projects\\actblue\\acme", "c:\\users\\alex\\projects\\acme"]) {
    const db = helperDb();
    await queueSb({ ...start, folder }, db);
    assert.equal(db.calls[0][1].p_payload.folder, folder);
  }
  for (const args of [
    start, { ...start, folder: "C:\\Users\\Alex\\projects" }, { ...start, folder: "C:\\Users\\Alex\\projects\\" },
    { ...start, folder: "C:\\Users\\Alex\\projects\\a\\..\\b" }, { ...start, folder: "C:\\Users\\Alex\\projectsx\\a" },
    { ...start, folder: "D:\\Users\\Alex\\projects\\a" }, { ...start, folder: "C:/Users/Alex/projects/a" },
    { ...start, folder: "C:\\Users\\Alex\\projects\\a:b" }, { ...start, folder: 5 },
    { ...start, folder: "C:\\Users\\Alex\\projects\\" + "a".repeat(230) },
    { ...start, from_sandbox: undefined, repo: "https://x/a.git", folder: "C:\\Users\\Alex\\projects\\a" },
    { ...start, from_sandbox: undefined, adopt: "C:/a", folder: "C:\\Users\\Alex\\projects\\a" },
    { ...ORG_ADD, folder: "C:\\Users\\Alex\\projects\\a" },
  ]) {
    const db = helperDb();
    await assert.rejects(queueSb(args, db), /refused/, JSON.stringify(args));
    assert.equal(db.calls.length, 0);
  }
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
    { ...ORG_ADD, ...START, command: "client start", repo: "a", adopt: "b" },
    { ...ORG_ADD, ...START, command: "client start", repo: "-x" },
    { ...ORG_ADD, ...START, command: "client start", from_sandbox: "a b", folder: "C:\\Users\\Alex\\projects\\a" },
    { ...ORG_ADD, ...START, command: "client start", adopt: "C:/x", name: "n".repeat(61) },
    { ...ORG_ADD, ...START, command: "client start", adopt: "C:/x", orgs: [ORG, ORG] },
    { ...ORG_ADD, ...START, command: "client start", adopt: "C:/x", orgs: Array.from({ length: 11 }, (_, i) => ({ ...ORG, alias: `a${i}` })) },
  ]) {
    const db = helperDb();
    await assert.rejects(queueSb(args, db), (e) => /refused/.test(e.message) && !/missing/.test(e.message), JSON.stringify(args));
    assert.equal(db.calls.length, 0);
  }
});

// s86aa: sb by link refuses the first question it meets, so the tool names every missing answer at once.
const FULL_START = { command: "client start", client: "acme", adopt: "C:/x", ...START, orgs: [ORG] };

test("sb_setup s86aa: a full client start or org add queues", async () => {
  for (const args of [FULL_START, ORG_ADD]) {
    const db = helperDb();
    await queueSb(args, db);
    assert.equal(db.calls.length, 2, args.command);
  }
});

test("sb_setup s86aa: each missing setting alone is refused by name, nothing queued", async () => {
  const cases = [
    ...["sandboxes", "integration_ok", "name"].map((k) => [{ ...FULL_START, [k]: undefined }, k]),
    ...["login", "cli_deploy", "shared", "type", "level"].flatMap((k) => [
      [{ ...FULL_START, orgs: [{ ...ORG, [k]: undefined }] }, `acme-dev ${k}`],
      [{ ...ORG_ADD, orgs: [{ ...ORG, [k]: undefined }] }, `acme-dev ${k}`],
    ]),
    [{ ...FULL_START, adopt: undefined }, "repo, adopt or from_sandbox"],
    [{ ...FULL_START, adopt: undefined, from_sandbox: "acme-dev" }, "folder"],
    [{ ...FULL_START, client: undefined }, "client"],
    [{ ...ORG_ADD, orgs: undefined }, "orgs"],
    [{ ...ORG_ADD, orgs: [{ ...ORG, alias: undefined }] }, "org 1 alias"],
  ];
  for (const [args, key] of cases) {
    const db = helperDb();
    await assert.rejects(queueSb(args, db), (e) => e.message.includes("1 setting missing") && e.message.includes(`\n- ${key}: `), key);
    assert.equal(db.calls.length, 0);
  }
});

test("sb_setup s86aa: everything missing is one refusal listing all of it", async () => {
  const db = helperDb();
  const start = { command: "client start", client: "common-defense", adopt: "C:/x", orgs: [{ alias: "cd-dev", type: "developer", level: "objects" }, { alias: "cd-uat" }] };
  const err = await queueSb(start, db).catch((e) => e);
  assert.equal(db.calls.length, 0);
  const keys = ["sandboxes", "integration_ok", "name", "cd-dev login", "cd-dev cli_deploy", "cd-dev shared",
    "cd-uat type", "cd-uat level", "cd-uat login", "cd-uat cli_deploy", "cd-uat shared"];
  assert.match(err.message, new RegExp(`${keys.length} settings missing.*all of them at once`));
  assert.match(err.message, /Nothing was queued/);
  for (const k of keys) assert.ok(err.message.includes(`\n- ${k}: `), k);
  const org = await queueSb({ command: "org add", client: "acme", orgs: [{ alias: "a1" }] }, helperDb()).catch((e) => e);
  assert.match(org.message, /5 settings missing/);
  assert.doesNotMatch(org.message, /sandboxes|integration_ok|- name/);
});

test("sf_check and sb_setup: a database refusal is passed on; a link refusal says it was queued", async () => {
  await assert.rejects(queueSf({ project_code: "p-a1", check: "limits", alias: "a" }, helperDb({ queue: { data: null, error: { code: "23514", message: "payload check" } } })),
    /refused: payload check/);
  await assert.rejects(queueSb(ORG_ADD, helperDb({ link: { data: null, error: { code: "55000", message: "another link is live" } } })),
    (e) => e.message.includes(`queued as ${ACTION_ID}`));
  await assert.rejects(queueSf({ check: "limits", alias: "a" }, helperDb({ link: { data: null, error: { code: "55000", message: "another link is live" } } })),
    (e) => e.message.includes(`queued as ${ACTION_ID}`) && e.message.includes("another link is live"));
});

test("git: a queue or link refusal is passed on, and says when the action was queued", async () => {
  await assert.rejects(queueGit({ project_code: "p-a1", command: "gitsync" }, gitDb({ queue: { data: null, error: { code: "23514", message: "payload check" } } })),
    /refused: payload check/);
  await assert.rejects(queueGit({ project_code: "p-a1", command: "gitsync" }, gitDb({ link: { data: null, error: { code: "55000", message: "another link is live" } } })),
    (e) => e.message.includes(`queued as ${ACTION_ID}`) && e.message.includes("another link is live"));
});

// --- s90d: the chained link (then_send, spec 11.9) ------------------------------------------------------------------

const CHAIN = "p-a1-s90e-ab12";

test("chain: then_send on gitsync, checkpoint and push is stored as then: {send}", () => {
  for (const args of [
    { project_code: "p-a1", command: "gitsync", then_send: CHAIN },
    { project_code: "p-a1", command: "gitpush", mode: "checkpoint", paths: ["a.js"], then_send: CHAIN },
    { project_code: "p-a1", command: "gitpush", mode: "push", then_send: CHAIN },
    { project_code: "p-a1", command: "gitsync", then_send: "p-a1-s7-zz99" },
    { project_code: "p-a1", command: "gitsync", then_send: "p-a1-s89ab-c3d4" },
  ]) {
    const out = m.gitPayload(args);
    assert.ok("payload" in out, JSON.stringify(args) + " " + out.refused);
    assert.deepEqual(out.payload.then, { send: args.then_send });
    assert.equal(out.payload.then_send, undefined);
  }
  // Without then_send, nothing changes.
  assert.deepEqual(m.gitPayload({ project_code: "p-a1", command: "gitsync" }), { payload: { command: "gitsync" } });
});

test("chain: refused on gitcom, gitnewtree and a Finish, and for a tag that isn't this project's own", () => {
  const bad = [
    [{ command: "gitcom", message: "m", then_send: CHAIN }, /gitcom can't chain a prompt/],
    [{ command: "gitnewtree", then_send: CHAIN }, /gitnewtree can't chain a prompt/],
    [{ command: "gitpush", mode: "finish", finish: "phase", then_send: CHAIN }, /a Finish can't chain/],
    [{ command: "gitsync", then_send: "p-b2-s90e-ab12" }, /not a run tag of p-a1: a chain only sends into the window it ran in/],
    [{ command: "gitsync", then_send: "p-a1x-s1-ab12" }, /not a run tag of p-a1/],
    [{ command: "gitsync", then_send: "p-a1-s1-ab1" }, /needs the step's digits/],
    [{ command: "gitsync", then_send: "p-a1-sa-ab12" }, /needs the step's digits/],
    [{ command: "gitsync", then_send: "p-a1-s1-AB12" }, /lowercase/],
    [{ command: "gitsync", then_send: 5 }, /must be a run tag/],
    [{ command: "gitsync", then_send: "" }, /must be a run tag/],
    [{ command: "gitsync", then_send: `p-a1-s1-${"x".repeat(33)}` }, /over 40 characters/],
  ];
  for (const [args, why] of bad) {
    const out = m.gitPayload({ project_code: "p-a1", ...args });
    assert.ok("refused" in out, JSON.stringify(args));
    assert.match(out.refused, why, JSON.stringify(args));
  }
});

test("chain: refused before anything is queued", async () => {
  const db = gitDb();
  await assert.rejects(queueGit({ project_code: "p-a1", command: "gitsync", then_send: "p-b2-s1-ab12" }, db), /refused: .*not a run tag of p-a1/);
  assert.deepEqual(db.calls, []);
});

test("chain: queued with then in the payload; headline and next say what follows", async () => {
  const db = gitDb();
  const out = await queueGit({ project_code: "p-a1", command: "gitpush", mode: "checkpoint", paths: ["a.js"], then_send: CHAIN }, db);
  const q = db.calls.find(([n]) => n === "switchboard_queue_git")[1];
  assert.deepEqual(q.p_payload, { command: "gitpush", mode: "checkpoint", paths: ["a.js"], then: { send: CHAIN } });
  assert.equal(q.p_headline, `GITPUSH CHECKPOINT p-a1: MERGES 1 PATH INTO MAIN, PUSHES, THEN SENDS PROMPT ${CHAIN} AT YOUR TAP`);
  assert.match(out.next, /replaces both the git link and the Send link/);
  assert.match(out.next, /ends with the p-a1-s90e-ab12 prompt block/);
  assert.match(out.next, new RegExp(`git ${ACTION_ID} done; prompt sent`));
  assert.match(out.next, /done; send not run: <reason>/);
  assert.match(out.next, /failed; send not run/);
  assert.equal(m.gitHeadline("p-a1", { command: "gitsync", then: { send: CHAIN } }),
    `GITSYNC p-a1: MERGES MAIN INTO THE WORKTREE, THEN SENDS PROMPT ${CHAIN} AT YOUR TAP`);
  assert.equal(m.gitHeadline("p-a1", { command: "gitsync" }), "GITSYNC p-a1: MERGES MAIN INTO THE WORKTREE");
});

// --- s89e: queue_switchboard_sf_read and get_switchboard_sf_result (spec 10) ----------------------------------------

/** A db whose chains on a table answer from that table's list in turn (the last answer repeats); inserts are kept. */
function seqDb({ tables = {}, rpc = {} } = {}) {
  const calls = [];
  const inserted = [];
  const used = {};
  return {
    calls, inserted,
    from(table) {
      const b = new Proxy({}, {
        get: (_t, k) => {
          if (k === "then") {
            return (res) => {
              const list = tables[table] ?? [{ data: null, error: null }];
              const i = used[table] = (used[table] ?? -1) + 1;
              res(list[Math.min(i, list.length - 1)]);
            };
          }
          return (...args) => {
            calls.push([table, k, ...args]);
            if (k === "insert") inserted.push([table, args[0]]);
            return b;
          };
        },
      });
      return b;
    },
    rpc(name, params) {
      calls.push(["rpc", name, params]);
      return Promise.resolve(rpc[name] ?? { data: null, error: null });
    },
  };
}
const READ_LINK = { url: "https://alfredv5vibe.vercel.app/switchboard/approve?t=x&kind=sf_read", expires_at: "2026-11-11T12:30:00Z" };
const readQueueDb = ({ enabled = true, tenMin = 0, day = 0, settings, queue, link } = {}) => seqDb({
  tables: {
    switchboard_settings: [settings ?? ok({ sf_reads_enabled: enabled })],
    // insert answers come from the same list: the budget counts come first, then the queued or refused log write.
    switchboard_sf_read_log: [{ count: tenMin, error: null }, { count: day, error: null }, ok(null)],
  },
  rpc: {
    switchboard_queue_helper: queue ?? ok({ action_id: ACTION_ID, project_code: "sf-cd-prod" }),
    switchboard_issue_link: link ?? ok(READ_LINK),
  },
});
const COUNT_READ = { alias: "ab-dev", production: false, level: "ids", object: "Contact", count: true };
const PROD_READ = { alias: "cd-prod", production: true, level: "data", object: "Contribution__c", fields: ["Id", "Status__c"], limit: 50,
  filters: [{ field: "Status__c", op: "=", value: "Failed" }, { field: "CreatedDate", op: ">=", value: "2026-11-01T00:00:00Z" }] };
const queueRead = (args, db = readQueueDb()) => m.queueSwitchboardSfReadTool.handler(args, { db }).then((out) => ({ out, db }));
const logged = (db) => db.inserted.filter(([t]) => t === "switchboard_sf_read_log").map(([, row]) => row);

test("sf_read: tiers", () => {
  assert.equal(m.queueSwitchboardSfReadTool.tier, 2);
  assert.equal(m.getSwitchboardSfResultTool.tier, 1);
});

test("sf_read: every accepted shape", () => {
  for (const p of [
    { alias: "ab-dev", production: false, level: "objects" },
    { alias: "ab-dev", production: false, level: "metadata", object: "Account" },
    COUNT_READ,
    { ...COUNT_READ, filters: [{ field: "CreatedDate", op: ">=", value: "2026-11-01T00:00:00Z" }] },
    { alias: "cd-prod", production: true, level: "ids", object: "Contact", fields: ["Id", "CreatedDate", "LastModifiedDate"], limit: 200,
      filters: [{ field: "Id", op: "in", value: ["003000000000001", "003000000000002"] }] },
    // An ids filter on any field: the helper applies the contract's filter limit (spec §7, switchboard_prod-w3k).
    { ...COUNT_READ, filters: [{ field: "Email", op: "=", value: "x" }] },
    { alias: "cd-prod", production: true, level: "ids", object: "Contact", fields: ["Id"], limit: 50,
      filters: [{ field: "Recurring_Status__c", op: "in", value: ["Active", "Paused"] }] },
    PROD_READ,
    { ...PROD_READ, filters: [{ field: "Refunded__c", op: "!=", value: true }, { field: "Notes__c", op: "=", value: null }] },
  ]) {
    assert.deepEqual(m.sfReadPayload({ ...p, chat_url: "x" }), { payload: p }, JSON.stringify(p));
  }
});

test("sf_read: refused shapes say why, and never take SOQL text", () => {
  const bad = [
    [{ ...PROD_READ, soql: "SELECT Id FROM Account" }, /Never SOQL text/],
    [{ ...COUNT_READ, query: "x" }, /does not take query/],
    [{ ...COUNT_READ, production: undefined }, /`production` must be true or false/],
    [{ ...COUNT_READ, alias: "-x" }, /`alias`/],
    [{ ...COUNT_READ, level: "all" }, /`level` must be one of/],
    [{ alias: "a", production: false, level: "objects", object: "Account" }, /takes no object/],
    [{ alias: "a", production: false, level: "metadata", object: "Account", count: true }, /describes one object and takes no count/],
    [{ ...COUNT_READ, object: "Account.Owner" }, /no dots/],
    [{ ...COUNT_READ, count: false }, /`count` must be true/],
    [{ ...COUNT_READ, fields: ["Id"] }, /a count takes no fields/],
    [{ ...PROD_READ, fields: [] }, /`fields` must list 1 to 50/],
    [{ ...PROD_READ, fields: ["Account.Name"] }, /`fields`/],
    [{ ...PROD_READ, limit: 5000 }, /`limit`/],
    [{ ...PROD_READ, limit: 1.5 }, /`limit`/],
    [{ ...PROD_READ, filters: [] }, /1 to 10 filters/],
    [{ ...PROD_READ, filters: [{ field: "Name", op: "like", value: "A%" }] }, /`op` must be one of/],
    [{ ...PROD_READ, filters: [{ field: "Name", op: "=", value: "A", or: true }] }, /does not take or/],
    [{ ...PROD_READ, filters: [{ field: "Name", op: "=" }] }, /needs a value/],
    [{ ...PROD_READ, filters: [{ field: "Name", op: "=", value: { a: 1 } }] }, /one plain value/],
    [{ ...PROD_READ, filters: [{ field: "Name", op: "in", value: [] }] }, /1 to 100 plain values/],
    [{ ...PROD_READ, filters: [{ field: "Name", op: "in", value: [{ a: 1 }] }] }, /1 to 100 plain values/],
    [{ alias: "a", production: false, level: "ids", object: "Contact", fields: ["Id", "Email"], limit: 5 },
      /ids returns only Id, CreatedDate, LastModifiedDate; Email needs level data/],
    [{ alias: "a", production: false, level: "ids", object: "Contact", fields: ["Name"], limit: 5,
       filters: [{ field: "Email", op: "=", value: "x" }] }, /Name needs level data/],
  ];
  for (const [p, why] of bad) {
    const r = m.sfReadPayload(p);
    assert.ok("refused" in r, JSON.stringify(p));
    assert.match(r.refused, why, JSON.stringify(p));
  }
});

test("sf_read: headlines name org, level and object; production full data leads", () => {
  assert.equal(m.sfReadHeadline(PROD_READ), "PRODUCTION FULL DATA: SF READ DATA ON PRODUCTION cd-prod: 2 FIELDS OF Contribution__c, UP TO 50 ROWS, READ ONLY");
  assert.equal(m.sfReadHeadline(COUNT_READ), "SF READ IDS ON SANDBOX ab-dev: A COUNT OF Contact, READ ONLY");
  assert.equal(m.sfReadHeadline({ ...COUNT_READ, production: true }), "SF READ IDS ON PRODUCTION ab-dev: A COUNT OF Contact, READ ONLY");
  assert.equal(m.sfReadHeadline({ alias: "a", production: false, level: "objects" }), "SF READ OBJECTS ON SANDBOX a: THE OBJECT LIST, READ ONLY");
  assert.equal(m.sfReadHeadline({ alias: "a", production: false, level: "metadata", object: "Account" }), "SF READ METADATA ON SANDBOX a: THE DESCRIBE OF Account, READ ONLY");
});

test("sf_read queue: queues through switchboard_queue_helper with no code, issues the link, logs queued", async () => {
  const { out, db } = await queueRead({ ...PROD_READ, chat_url: "https://claude.ai/chat/26f0cc8f-6ef0-4f14-81da-a915ad086e5b" });
  const q = db.calls.find((c) => c[0] === "rpc" && c[1] === "switchboard_queue_helper")[2];
  assert.deepEqual(q, { p_kind: "sf_read", p_project_code: null, p_payload: PROD_READ, p_headline: m.sfReadHeadline(PROD_READ),
    p_chat_url: "https://claude.ai/chat/26f0cc8f-6ef0-4f14-81da-a915ad086e5b" });
  assert.deepEqual(db.calls.find((c) => c[1] === "switchboard_issue_link")[2], { p_action_id: ACTION_ID });
  assert.equal(out.url, READ_LINK.url);
  assert.equal(out.action_id, ACTION_ID);
  assert.match(out.headline, /^PRODUCTION FULL DATA: /);
  assert.match(out.next, /get_switchboard_sf_result/);
  const rows = logged(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, "queued");
  assert.equal(rows[0].action_id, ACTION_ID);
  assert.equal(rows[0].org_alias, "cd-prod");
  assert.deepEqual(rows[0].filters, PROD_READ.filters);
});

test("sf_read queue: the budget counts queue attempts only, in both windows", async () => {
  const { db } = await queueRead(COUNT_READ);
  const counts = db.calls.filter((c) => c[0] === "switchboard_sf_read_log" && c[1] === "in");
  assert.equal(counts.length, 2);
  assert.deepEqual(counts[0][3], ["queued", "refused"]);
  for (const [tenMin, day] of [[20, 0], [0, 200]]) {
    const over = readQueueDb({ tenMin, day });
    await assert.rejects(queueRead(COUNT_READ, over), /READ BUDGET EXCEEDED.*Do NOT retry/);
    assert.equal(over.calls.some((c) => c[1] === "switchboard_queue_helper"), false);
    assert.equal(logged(over)[0].stage, "refused");
  }
  await queueRead(COUNT_READ, readQueueDb({ tenMin: 19, day: 199 }));
});

test("sf_read queue: the kill switch, or no settings row, refuses and logs; nothing is queued", async () => {
  for (const db of [readQueueDb({ enabled: false }), readQueueDb({ settings: ok(null) }), readQueueDb({ settings: { data: null, error: { message: "down" } } })]) {
    await assert.rejects(queueRead(COUNT_READ, db), /sf_reads_enabled|kill switch/);
    assert.equal(db.calls.some((c) => c[1] === "switchboard_queue_helper"), false);
    assert.equal(logged(db)[0].stage, "refused");
  }
});

test("sf_read queue: a bad payload is refused and logged, with what was asked, before any read of the settings", async () => {
  const db = readQueueDb();
  await assert.rejects(queueRead({ ...PROD_READ, soql: "SELECT Id FROM Account" }, db), /refused: an sf_read does not take soql/);
  assert.equal(db.calls.some((c) => c[0] === "switchboard_settings"), false);
  const row = logged(db)[0];
  assert.equal(row.stage, "refused");
  assert.equal(row.org_alias, "cd-prod");
  const noAlias = readQueueDb();
  await assert.rejects(queueRead({ level: "objects", production: false }, noAlias), /`alias`/);
  assert.equal(logged(noAlias)[0].org_alias, "?");
});

test("sf_read queue: a queue or link refusal is passed on", async () => {
  await assert.rejects(queueRead(COUNT_READ, readQueueDb({ queue: { data: null, error: { code: "23514", message: "payload check" } } })), /refused: payload check/);
  await assert.rejects(queueRead(COUNT_READ, readQueueDb({ link: { data: null, error: { code: "55000", message: "another link is live" } } })),
    (e) => e.message.includes(`queued as ${ACTION_ID}`) && e.message.includes("another link is live"));
});

const takeDb = ({ take = ok(null), action = ok({ id: ACTION_ID, kind: "sf_read", status: "succeeded" }), run = ok({ summary: "s", finished_at: "t" }) } = {}) =>
  seqDb({ tables: { switchboard_actions: [action], switchboard_runs: [run] }, rpc: { switchboard_take_sf_result: take } });
const take = (db, id = ACTION_ID) => m.getSwitchboardSfResultTool.handler({ action_id: id }, { db });
const TAKEN = { action_id: ACTION_ID, rows: [{ Id: "a0B1", Status__c: "Failed" }], row_count: 1, truncated: false, production_full_data: true };

test("sf result: takes once through switchboard_take_sf_result; a stamped result says PRODUCTION FULL DATA first", async () => {
  const db = takeDb({ take: ok(TAKEN) });
  const out = await take(db);
  assert.deepEqual(db.calls, [["rpc", "switchboard_take_sf_result", { p_action_id: ACTION_ID }]]);
  assert.equal(Object.keys(out)[0], "stamp");
  assert.equal(out.stamp, "PRODUCTION FULL DATA");
  assert.deepEqual(out.rows, TAKEN.rows);
  assert.equal(out.row_count, 1);
  assert.equal(out.truncated, false);
  assert.match(out.note, /deleted from Alfred.*Summarise them/);
  const plain = await take(takeDb({ take: ok({ ...TAKEN, production_full_data: false }) }));
  assert.equal(plain.stamp, undefined);
});

test("sf result: with nothing to take, says not finished, failed, cancelled or gone", async () => {
  const cases = [
    [{ action: ok({ id: ACTION_ID, kind: "sf_read", status: "link_issued" }), run: ok(null) }, "not finished"],
    [{ action: ok({ id: ACTION_ID, kind: "sf_read", status: "consumed" }), run: ok({ summary: "picked up by the helper", finished_at: null }) }, "not finished"],
    [{ action: ok({ id: ACTION_ID, kind: "sf_read", status: "failed" }), run: ok({ summary: "refused: org mismatch", finished_at: "t" }) }, "failed"],
    [{ action: ok({ id: ACTION_ID, kind: "sf_read", status: "cancelled" }) }, "cancelled"],
    [{}, "gone"],
  ];
  for (const [over, state] of cases) {
    const out = await take(takeDb(over));
    assert.equal(out.state, state);
    assert.equal(out.rows, null);
  }
  assert.equal((await take(takeDb(cases[2][0]))).summary, "refused: org mismatch");
});

test("sf result: a bad id, an unknown action, another kind or a database error is refused", async () => {
  await assert.rejects(take(takeDb(), "nope"), /`action_id` must be a UUID/);
  await assert.rejects(take(takeDb({ action: ok(null) })), /no such action/);
  await assert.rejects(take(takeDb({ action: ok({ id: ACTION_ID, kind: "sf_check", status: "succeeded" }) })), /not a Salesforce read/);
  await assert.rejects(take(takeDb({ take: { data: null, error: { message: "down" } } })), /taking the result/);
});

// --- dataops_alfred-d4x: the sf_read objects list, and queue_switchboard_sf_dataop ----------------------------------

const OBJS = Array.from({ length: 20 }, (_, i) => `Obj${i + 1}__c`);
const META = { alias: "cd-prod", production: true, level: "metadata" };

test("sf_read objects: 1 to 20 names at metadata are accepted, and the headline names them", () => {
  for (const objects of [["Contact"], OBJS]) assert.deepEqual(m.sfReadPayload({ ...META, objects }), { payload: { ...META, objects } });
  assert.equal(m.sfReadHeadline({ ...META, objects: ["Contact", "Account"] }),
    "SF READ METADATA ON PRODUCTION cd-prod: THE DESCRIBE OF 2 OBJECTS: Contact, Account, READ ONLY");
  assert.equal(m.sfReadHeadline({ ...META, objects: OBJS }),
    "SF READ METADATA ON PRODUCTION cd-prod: THE DESCRIBE OF 20 OBJECTS: Obj1__c, Obj2__c, Obj3__c, Obj4__c, Obj5__c AND 15 MORE, READ ONLY");
});

test("sf_read objects: 21, empty, dotted, doubled, with object, or at another level is refused", () => {
  for (const [p, why] of [
    [{ ...META, objects: [...OBJS, "Contact"] }, /1 to 20 API names/],
    [{ ...META, objects: [] }, /1 to 20 API names/],
    [{ ...META, objects: ["Account.Name"] }, /1 to 20 API names/],
    [{ ...META, objects: ["Contact", "contact"] }, /listed twice/],
    [{ ...META, objects: ["Contact"], object: "Account" }, /not both/],
    [{ ...META, objects: ["Contact"], count: true }, /takes no count/],
    [{ alias: "cd-prod", production: true, level: "ids", objects: ["Contact"], count: true }, /level metadata only/],
    [{ alias: "cd-prod", production: true, level: "objects", objects: ["Contact"] }, /takes no objects/],
  ]) {
    const r = m.sfReadPayload(p);
    assert.ok("refused" in r, JSON.stringify(p));
    assert.match(r.refused, why, JSON.stringify(p));
  }
});

test("sf_read objects: the log row keeps the list", async () => {
  const { db } = await queueRead({ ...META, objects: ["Contact", "Account"] });
  const row = logged(db).find((r) => r.stage === "queued");
  assert.deepEqual(row.objects, ["Contact", "Account"]);
  assert.equal(row.object, null);
});

const DATAOP = { alias: "cd-prod", repo: "C:\\Users\\Alex\\projects\\common-defense", plan: "dataops/fixc-plan.json",
  stamp: "0123456789abcdef".repeat(4), preflight_at: "2026-11-18T15:00:00.000Z", object: "Demo_Gift__c",
  problem: "Forty-five gifts were saved without a link to their plan.", expected: 26571,
  write: { kind: "batch", class: "FixCLinkBatch" },
  rows: [{ label: "Gifts in the list with no plan link", before: 26571, goal: 0 },
         { label: "Knock-on check: Plans whose paid total went up today", before: 0, goal: 12, knock_on: true }],
  rehearsal: { sandbox: "cd-dev1", at: "2026-11-18T16:00:00Z" } };
const queueDataop = (args, db = helperDb()) => m.queueSwitchboardSfDataopTool.handler(args, { db });

test("sf_dataop: tier 2; queued as sf_dataop with its project code, then the link; nothing else", async () => {
  assert.equal(m.queueSwitchboardSfDataopTool.tier, 2);
  const db = helperDb();
  const out = await queueDataop({ project_code: "cd_ab_link_installments-q8d", chat_url: "x", ...DATAOP }, db);
  assert.deepEqual(db.calls.map((c) => c[0]), ["switchboard_queue_helper", "switchboard_issue_link"]);
  const [, params] = db.calls[0];
  assert.equal(params.p_kind, "sf_dataop");
  assert.equal(params.p_project_code, "cd_ab_link_installments-q8d");
  assert.deepEqual(params.p_payload, DATAOP);
  assert.equal(params.p_headline,
    "PRODUCTION DATA RUN cd_ab_link_installments-q8d ON cd-prod: ABOUT TO CHANGE 26,571 LIVE RECORDS OF Demo_Gift__c BY BATCH FixCLinkBatch");
  assert.equal(out.url, LINK.url);
  assert.match(out.next, /ONLY HIS CLICK ON APPROVE STARTS THE RUN/);
  assert.match(out.next, /About to change 26,571 live records/);
  assert.match(out.next, new RegExp(`dataop ${ACTION_ID} done or failed`));
});

test("sf_dataop: a bulk write without rehearsal is accepted; the headline says BY BULK", () => {
  const { rehearsal: _r, ...rest } = DATAOP;
  const p = { ...rest, expected: 1, write: { kind: "bulk" } };
  assert.deepEqual(m.sfDataopPayload(p), { payload: p });
  assert.equal(m.sfDataopHeadline("p-x", p), "PRODUCTION DATA RUN p-x ON cd-prod: ABOUT TO CHANGE 1 LIVE RECORD OF Demo_Gift__c BY BULK");
});

test("sf_dataop: every refusal says why, and nothing is queued", async () => {
  const bad = [
    [{ ...DATAOP, ids: ["a0D000000000001AAA"] }, /does not take ids.*stamp covers them/],
    [{ ...DATAOP, soql: "SELECT Id FROM Contact" }, /does not take soql/],
    [{ ...DATAOP, stamp: undefined }, /missing stamp/],
    [{ ...DATAOP, stamp: "abc" }, /64 lower-case hex/],
    [{ ...DATAOP, stamp: "A".repeat(64) }, /64 lower-case hex/],
    [{ ...DATAOP, alias: "-x" }, /`alias`/],
    [{ ...DATAOP, repo: "projects\\common-defense" }, /`repo`/],
    [{ ...DATAOP, repo: "C:\\Users\\..\\x" }, /`repo`/],
    [{ ...DATAOP, plan: "../plan.json" }, /`plan`/],
    [{ ...DATAOP, plan: "dataops/plan.csv" }, /`plan`/],
    [{ ...DATAOP, preflight_at: "2026-11-18" }, /`preflight_at`/],
    [{ ...DATAOP, object: "Gift.Plan" }, /`object`/],
    [{ ...DATAOP, problem: "too short" }, /`problem`/],
    [{ ...DATAOP, expected: 0 }, /`expected`/],
    [{ ...DATAOP, expected: 4.5 }, /`expected`/],
    [{ ...DATAOP, expected: "45" }, /`expected`/],
    [{ ...DATAOP, write: { kind: "batch" } }, /deployed class name/],
    [{ ...DATAOP, write: { kind: "bulk", class: "X" } }, /bulk write takes no class/],
    [{ ...DATAOP, write: { kind: "apex" } }, /bulk or batch/],
    [{ ...DATAOP, write: "bulk" }, /`write` must be/],
    [{ ...DATAOP, rows: [] }, /1 to 40 state rows/],
    [{ ...DATAOP, rows: Array.from({ length: 41 }, (_, i) => ({ label: `Row number ${i}`, before: 1, goal: 0 })) }, /1 to 40 state rows/],
    [{ ...DATAOP, rows: [{ label: "Gifts with no link", before: -1, goal: 0 }] }, /whole numbers/],
    [{ ...DATAOP, rows: [{ label: "Gifts with no link", before: 1, goal: 0, soql: "x" }] }, /does not take soql/],
    [{ ...DATAOP, rows: [{ label: "x".repeat(201), before: 1, goal: 0 }] }, /1 to 200 characters/],
    [{ ...DATAOP, rows: [{ label: "two\nlines", before: 1, goal: 0 }] }, /one line/],
    [{ ...DATAOP, rows: [{ label: "Gifts with no link", before: 1, goal: 0, knock_on: "yes" }] }, /knock_on/],
    [{ ...DATAOP, rehearsal: { sandbox: "cd-dev1", at: "2026-11-18T16:00:00Z", passed: true } }, /`rehearsal` must be/],
    [{ ...DATAOP, rehearsal: { sandbox: "cd-dev1", at: "today" } }, /rehearsal.at/],
  ];
  for (const [p, why] of bad) {
    const r = m.sfDataopPayload(p);
    assert.ok("refused" in r, JSON.stringify(p).slice(0, 120));
    assert.match(r.refused, why, JSON.stringify(p).slice(0, 120));
  }
  const db = helperDb();
  await assert.rejects(queueDataop({ project_code: "p-x", ...DATAOP, stamp: "abc" }, db), /refused: `stamp`/);
  await assert.rejects(queueDataop({ ...DATAOP }, db), /`project_code`/);
  assert.equal(db.calls.length, 0);
});

test("sf_dataop: the database's refusal and a link refusal are reported, not retried", async () => {
  await assert.rejects(queueDataop({ project_code: "p-x", ...DATAOP },
    helperDb({ queue: { data: null, error: { code: "23514", message: "violates check constraint" } } })), /refused: violates/);
  await assert.rejects(queueDataop({ project_code: "p-x", ...DATAOP },
    helperDb({ link: { data: null, error: { code: "55000", message: "another link is live" } } })), new RegExp(`queued as ${ACTION_ID}, but no link`));
});

// --- dataop_link-k7d A1: queue_switchboard_sf_dataquery -----------------------------------------------------------

const DQ_CODE = "cd_fixc-q8d";
const hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const SEL = "SELECT Id, GiftCommitmentId FROM GiftTransaction WHERE Source__c = 'ActBlue' AND CreatedDate < 2026-11-18T00:00:00Z\n";
const BROAD = "SELECT Id, GiftCommitmentId, Amount FROM GiftTransaction WHERE Source__c = 'ActBlue'";
const R1 = "SELECT COUNT() FROM GiftTransaction WHERE Source__c = 'ActBlue' AND GiftCommitmentId = null";
const R2 = "SELECT COUNT() FROM GiftCommitment WHERE Rollup_Pending__c = true";
const exp = (step, soql, src) => ({ step, soql, sha256: hex(soql), ...src });
const DQ_BASE = { alias: "cd-prod", org_type: "production", repo: "C:\\Users\\Alex\\projects\\common-defense", run: `data-ops/${DQ_CODE}/fixc-2026-11-19`,
  run_tag: `${DQ_CODE}-s4-ab12`, request_sha256: "0123456789abcdef".repeat(4) };
const DQ_EXPORT = { ...DQ_BASE, queries: [exp("manifest", SEL, { file: "selection.soql" }), exp("before", BROAD, { label: "broad snapshot" })] };
const DQ_COUNT = { ...DQ_BASE, queries: [exp("rules", R1, { label: "Installments with no gift commitment" }),
  exp("rules", R2, { label: "Commitments whose totals are still updating" })] };
const dq = (p) => m.sfDataqueryPayload(DQ_CODE, p);
const queueDq = (args, db = helperDb()) => m.queueSwitchboardSfDataqueryTool.handler(args, { db });
const withQuery = (base, i, patch) => ({ ...base, queries: base.queries.map((q, j) => (j === i ? { ...q, ...patch } : q)) });
const countOf = (soql, label = "A rule") => ({ ...DQ_BASE, queries: [exp("rules", soql, { label })] });

test("sf_dataquery: sha256Hex is the SHA-256 of the UTF-8 bytes, as node and Postgres compute it", async () => {
  for (const s of ["", SEL, "SELECT COUNT() FROM Contact WHERE Name = 'Zoë'", "\r\n\tSELECT"]) assert.equal(await m.sha256Hex(s), hex(s));
});

test("sf_dataquery: jsonbTextLength counts as Postgres prints jsonb", () => {
  assert.equal(m.jsonbTextLength({}), 2);
  assert.equal(m.jsonbTextLength([]), 2);
  assert.equal(m.jsonbTextLength({ a: 1, b: [1, 2] }), '{"a": 1, "b": [1, 2]}'.length);
  assert.equal(m.jsonbTextLength({ s: "x\ny\"" }), '{"s": "x\\ny\\""}'.length);
});

test("sf_dataquery: tier 2; queued as sf_dataquery with its project code, then the link; nothing else", async () => {
  assert.equal(m.queueSwitchboardSfDataqueryTool.tier, 2);
  assert.deepEqual(m.queueSwitchboardSfDataqueryTool.tables, { reads: ["switchboard_actions", "switchboard_settings"], writes: ["switchboard_actions"] });
  const db = helperDb();
  const out = await queueDq({ project_code: DQ_CODE, chat_url: "x", ...DQ_EXPORT }, db);
  assert.deepEqual(db.calls.map((c) => c[0]), ["switchboard_queue_helper", "switchboard_issue_link"]);
  const [, params] = db.calls[0];
  assert.equal(params.p_kind, "sf_dataquery");
  assert.equal(params.p_project_code, DQ_CODE);
  assert.deepEqual(params.p_payload, DQ_EXPORT);
  assert.equal(params.p_chat_url, null);
  assert.equal(params.p_headline, `PRODUCTION EXPORT ${DQ_CODE} ON cd-prod: 2 QUERIES (manifest, before), READ ONLY`);
  assert.equal(out.url, LINK.url);
  assert.equal(out.action_id, ACTION_ID);
  assert.match(out.next, /ONLY HIS CLICK ON APPROVE RUNS THESE PRODUCTION QUERIES/);
  assert.match(out.next, /run\.result\.query_counts/);
});

test("sf_dataquery: count links, an undo export, a file with no request hash, and leading blank space are accepted", async () => {
  const long = `SELECT COUNT() FROM Contact WHERE Name != '${"x".repeat(8000 - 44)}'`;
  assert.equal(long.length, 8000);
  const forty = { ...DQ_BASE, queries: Array.from({ length: 40 }, (_, i) =>
    exp("preflight-counts", `SELECT COUNT() FROM Contact WHERE Name != 'n${i}'`, { label: `Rule ${i}` })) };
  const { request_sha256: _h, ...noHash } = DQ_BASE;
  for (const p of [
    DQ_COUNT,
    countOf(long),
    forty,
    { ...DQ_BASE, queries: [exp("undo", SEL, { file: "selection.soql" })] },
    { ...noHash, queries: [exp("manifest", SEL, { file: "selection.soql" })] },
    { ...DQ_EXPORT, run: `data-ops\\${DQ_CODE}\\fixc-2026-11-19` },
    { ...DQ_BASE, queries: [exp("manifest", `\n\t  ${SEL}`, { file: "selection.soql" })] },
    countOf(`\r\n${R2}`),
  ]) {
    assert.deepEqual(await dq(p), { payload: p }, JSON.stringify(p).slice(0, 160));
  }
  assert.equal(m.sfDataqueryHeadline(DQ_CODE, DQ_COUNT), `PRODUCTION COUNTS ${DQ_CODE} ON cd-prod: 2 QUERIES (rules), READ ONLY`);
  assert.equal(m.sfDataqueryHeadline(DQ_CODE, countOf(R1)), `PRODUCTION COUNTS ${DQ_CODE} ON cd-prod: 1 QUERY (rules), READ ONLY`);
});

// dataquery_fixes-v3n: org_type, required, sandbox or production; the headline and next text follow it.
test("sf_dataquery org_type: a sandbox link is queued with SANDBOX in its headline and next text, never PRODUCTION", async () => {
  const sbx = { ...DQ_COUNT, alias: "actblue", org_type: "sandbox" };
  assert.deepEqual(await dq(sbx), { payload: sbx });
  assert.equal(m.sfDataqueryHeadline(DQ_CODE, sbx), `SANDBOX COUNTS ${DQ_CODE} ON actblue: 2 QUERIES (rules), READ ONLY`);
  assert.equal(m.sfDataqueryHeadline(DQ_CODE, { ...DQ_EXPORT, org_type: "sandbox" }),
    `SANDBOX EXPORT ${DQ_CODE} ON cd-prod: 2 QUERIES (manifest, before), READ ONLY`);
  assert.equal(m.sfDataqueryHeadline(DQ_CODE, DQ_EXPORT), `PRODUCTION EXPORT ${DQ_CODE} ON cd-prod: 2 QUERIES (manifest, before), READ ONLY`);
  const db = helperDb();
  const out = await queueDq({ project_code: DQ_CODE, ...sbx }, db);
  assert.equal(db.calls[0][1].p_payload.org_type, "sandbox");
  assert.match(out.headline, /^SANDBOX COUNTS /);
  assert.match(out.next, /RUNS THESE SANDBOX QUERIES\. The page shows the SANDBOX banner/);
  assert.doesNotMatch(`${out.headline} ${out.next}`, /PRODUCTION/);
});

test("sf_dataquery org_type: missing or any other value is refused, naming the field and both values; nothing is queued", async () => {
  const { org_type: _o, ...noType } = DQ_EXPORT;
  for (const p of [noType, { ...DQ_EXPORT, org_type: "Sandbox" }, { ...DQ_EXPORT, org_type: "prod" },
    { ...DQ_EXPORT, org_type: "" }, { ...DQ_EXPORT, org_type: true }, { ...DQ_EXPORT, org_type: null }]) {
    const r = await dq(p);
    assert.ok("refused" in r, JSON.stringify(p.org_type));
    assert.match(r.refused, /`org_type` must be exactly "sandbox" or "production"/);
  }
  assert.match((await dq({ ...DQ_EXPORT, org_type: "prod" })).refused, /not "prod"/);
  const db = helperDb();
  await assert.rejects(queueDq({ project_code: DQ_CODE, ...noType }, db), /refused: `org_type` must be exactly "sandbox" or "production"/);
  assert.equal(db.calls.length, 0);
});

test("sf_dataquery: every refusal says why, and nothing is queued", async () => {
  const { repo: _r, ...noRepo } = DQ_EXPORT;
  const { run: _u, ...noRun } = DQ_EXPORT;
  const { run_tag: _t, ...noTag } = DQ_EXPORT;
  const { request_sha256: _h, ...noHash } = DQ_COUNT;
  const { file: _f, ...noSource } = DQ_EXPORT.queries[0];
  const forty1 = { ...DQ_BASE, queries: Array.from({ length: 41 }, (_, i) =>
    exp("rules", `SELECT COUNT() FROM Contact WHERE Name != 'n${i}'`, { label: `Rule ${i}` })) };
  const bad = [
    [forty1, /1 to 40 queries/],
    [{ ...DQ_EXPORT, queries: [] }, /1 to 40 queries/],
    [{ ...DQ_EXPORT, queries: [...DQ_EXPORT.queries, DQ_COUNT.queries[0]] }, /all exports .* or all counts/],
    [withQuery(DQ_COUNT, 1, { step: "preflight-counts" }), /a count link is one step/],
    [withQuery(DQ_COUNT, 1, { step: "undo" }), /all exports .* or all counts/],
    [{ ...DQ_BASE, queries: [exp("undo", R1, { label: "Undo as a count" })] }, /is an export/],
    [withQuery(DQ_COUNT, 0, { sha256: "0".repeat(64) }), /isn't the SHA-256/],
    [withQuery(DQ_COUNT, 0, { sha256: hex(R1).toUpperCase() }), /isn't the SHA-256/],
    [withQuery(DQ_COUNT, 0, { soql: `\n${R1}` }), /isn't the SHA-256/],
    [countOf("SELECT COUNT() FROM Contact WHERE Name != null; DELETE"), /semicolon/],
    [countOf("SELECT COUNT() FROM Contact WHERE Name != null GROUP BY Name"), /no GROUP BY/],
    [countOf(`SELECT COUNT() FROM Contact WHERE Name != '${"x".repeat(8000 - 43)}'`), /over 8,000 characters/],
    [countOf("SELECT Id FROM Contact WHERE Name != null"), /is a count/],
    [countOf("SELECT COUNT(Id) FROM Contact WHERE Name != null"), /is a count/],
    [countOf(`-- note\n${R2}`), /is a count/],
    [countOf(`\u00a0${R2}`), /is a count/],
    [{ ...DQ_BASE, queries: [exp("manifest", "SELECT Id, (SELECT COUNT() FROM Contacts) FROM Account WHERE Name != null", { file: "selection.soql" })] }, /no COUNT\(/],
    [{ ...DQ_BASE, queries: [exp("manifest", "SELECT Name, Id FROM Contact WHERE Name != null", { file: "selection.soql" })] }, /is an export/],
    [{ ...DQ_BASE, queries: [exp("manifest", `SELECT Id FROM Contact WHERE Name != '${"x".repeat(100000)}'`, { file: "selection.soql" })] }, /over 100,000 characters/],
    [noRepo, /missing repo/],
    [noRun, /missing run/],
    [noTag, /missing run_tag/],
    [{ ...DQ_EXPORT, ids: ["a0D000000000001AAA"] }, /does not take ids/],
    [withQuery(DQ_COUNT, 0, { rows: [] }), /does not take rows/],
    [{ ...DQ_EXPORT, alias: "-x" }, /`alias`/],
    [{ ...DQ_EXPORT, repo: "projects\\common-defense" }, /`repo`/],
    [{ ...DQ_EXPORT, run: "data-ops/other-code/fixc" }, /`run`/],
    [{ ...DQ_EXPORT, run: `dataops/${DQ_CODE}/fixc` }, /`run`/],
    [{ ...DQ_EXPORT, run: `data-ops/${DQ_CODE}/..` }, /`run`/],
    [{ ...DQ_EXPORT, run: `data-ops/${DQ_CODE}/a/b` }, /`run`/],
    [{ ...DQ_EXPORT, run: `data-ops/${DQ_CODE}` }, /`run`/],
    [{ ...DQ_EXPORT, run: `data-ops/${DQ_CODE}/.` }, /`run`/],
    [{ ...DQ_EXPORT, run_tag: "other-code-s4-ab12" }, /`run_tag`/],
    [{ ...DQ_EXPORT, run_tag: `${DQ_CODE}-s4-ab1` }, /`run_tag`/],
    [{ ...DQ_EXPORT, request_sha256: "abc" }, /`request_sha256`/],
    [noHash, /needs `request_sha256`/],
    [withQuery(DQ_EXPORT, 0, { label: "selection" }), /exactly one of file and label/],
    [{ ...DQ_EXPORT, queries: [noSource] }, /exactly one of file and label/],
    [withQuery(DQ_EXPORT, 0, { file: "../selection.soql" }), /one .soql file name/],
    [withQuery(DQ_EXPORT, 0, { file: "selection.txt" }), /one .soql file name/],
    [withQuery(DQ_COUNT, 1, { label: DQ_COUNT.queries[0].label }), /already used/],
    [withQuery(DQ_COUNT, 0, { label: "two\nlines" }), /one line/],
    [withQuery(DQ_COUNT, 0, { label: "   " }), /one line/],
    [withQuery(DQ_COUNT, 0, { label: "x".repeat(201) }), /one line of 1 to 200/],
    [withQuery(DQ_EXPORT, 1, { step: "gate" }), /step must be one of/],
    [withQuery(DQ_COUNT, 0, { soql: 42 }), /exact text/],
  ];
  for (const [p, why] of bad) {
    const r = await dq(p);
    assert.ok("refused" in r, JSON.stringify(p).slice(0, 160));
    assert.match(r.refused, why, JSON.stringify(p).slice(0, 160));
  }
  const db = helperDb();
  await assert.rejects(queueDq({ project_code: DQ_CODE, ...countOf("SELECT COUNT() FROM X WHERE a = 1;") }, db), /refused: .*semicolon/);
  await assert.rejects(queueDq({ ...DQ_EXPORT }, db), /`project_code`/);
  assert.equal(db.calls.length, 0);
});

test("sf_dataquery: the payload cap is 220,000 characters as Postgres prints it", async () => {
  const big = (n) => `SELECT Id FROM Contact WHERE Name != '${"x".repeat(n)}'`;
  const near = { ...DQ_BASE, queries: [exp("manifest", big(99000), { file: "a.soql" }), exp("before", big(99000), { file: "b.soql" })] };
  assert.ok("payload" in await dq(near));
  const over = { ...near, queries: [...near.queries, exp("undo", big(30000), { file: "c.soql" })] };
  assert.match((await dq(over)).refused, /over 220,000 characters/);
});

test("sf_dataquery: the database's refusal and a link refusal are reported, not retried", async () => {
  await assert.rejects(queueDq({ project_code: DQ_CODE, ...DQ_COUNT },
    helperDb({ queue: { data: null, error: { code: "23514", message: "violates check constraint" } } })), /refused: violates/);
  await assert.rejects(queueDq({ project_code: DQ_CODE, ...DQ_COUNT },
    helperDb({ link: { data: null, error: { code: "55000", message: "another link is live" } } })), new RegExp(`queued as ${ACTION_ID}, but no link`));
});

// --- dataop_write-j5w A2: queue_switchboard_sf_datawrite -----------------------------------------------------------
// The payloads and refusals are supabase/tests/dataop_write-j5w/1_verify_sf_datawrite.sql's, so the tool and the
// database are checked against the same list.

const DW_CODE = "dataop-verify-j5w";
const HEX2 = "fedcba9876543210".repeat(4);
const HEX3 = "aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbccccccccccccccccdddddddddddddddd";
const DW_BROAD = "SELECT Id, GiftCommitmentId, Amount, LastModifiedById FROM GiftTransaction WHERE Source__c = 'ActBlue'";
const DW_GC = "SELECT Id, ExpectedTotalAmount FROM GiftCommitment WHERE Source__c = 'ActBlue'";
const q = (step, soql, src) => ({ step, soql, sha256: hex(soql), ...src });
const Q_SEL = q("gate", SEL, { file: "selection.soql" });
const Q_GBROAD = q("gate", DW_BROAD, { label: "gate: broad snapshot" });
const Q_GGC = q("gate", DW_GC, { label: "gate: gift commitments" });
const Q_ABROAD = q("after", DW_BROAD, { label: "after: broad snapshot" });
const Q_ASEL = q("after", SEL, { label: "after: selection" });
const Q_R1 = q("after-counts", R1, { label: "Installments with no gift commitment" });
const Q_WAIT = q("after-counts", R2, { label: "Commitments whose totals are updating: wait", wait: { stable_minutes: 2, limit_minutes: 30 } });
const DW_BASE = { alias: "cd-prod", org_type: "production", repo: "C:\\Users\\Alex\\projects\\common-defense",
  run: `data-ops/${DW_CODE}/fixc-2026-11-19`, run_tag: `${DW_CODE}-s9-ab12`, request_sha256: "0123456789abcdef".repeat(4),
  selection_sha256: hex(SEL), object: "GiftTransaction",
  problem: "Forty-five installments were saved without a link to their gift commitment.", expected: 45 };
const DW_BATCH = { ...DW_BASE, write: { kind: "batch", class: "FixCLinkBatch" }, queries: [Q_SEL, Q_GBROAD, Q_ABROAD, Q_ASEL, Q_R1, Q_WAIT] };
// s6b: a bulk write uploads nothing; the exclude upload lives on a batch.
const DW_BULK = { ...DW_BASE, org_type: "sandbox", write: { kind: "bulk", operation: "update", csv: "update.csv", csv_sha256: HEX2 },
  queries: [Q_SEL, Q_GGC, Q_ABROAD, Q_R1] };
const EXCLUDE = { purpose: "exclude", file: "exclude.csv", sha256: HEX3, rows: 3 };
const DW_BATCHX = { ...DW_BATCH, uploads: [EXCLUDE] };
const DW_UNDO = { ...DW_BASE, write: { kind: "undo", class: "FixCUndoBatch", ids_file: "undo-ids.csv", ids_sha256: HEX2 },
  uploads: [{ purpose: "undo-ids", file: "undo-ids.csv", sha256: HEX2, rows: 45 }], queries: [Q_GBROAD, Q_ABROAD] };
const idList = (n) => Array.from({ length: n }, (_, i) => `'a0D${String(i + 1).padStart(12, "0")}AAA'`).join(",");
const broadIds = (n) => `SELECT Id, Amount, LastModifiedById FROM GiftTransaction WHERE Id IN (${idList(n)})`;
const setQ = (p, i, query) => ({ ...p, queries: p.queries.map((x, j) => (j === i ? query : x)) });
// s10: Fix C's shape. selection.soql and "after: selection" name n Ids, and so do four rule counts.
const selIds = (n) => `SELECT Id, GiftCommitmentId FROM GiftTransaction WHERE Id IN (${idList(n)})`;
const countIds = (n, label) => q("after-counts", `SELECT COUNT() FROM GiftTransaction WHERE GiftCommitmentId = null AND Id IN (${idList(n)})`, { label });
const fixC = (n) => ({ ...DW_BATCH, selection_sha256: hex(selIds(n)), queries: [
  q("gate", selIds(n), { file: "selection.soql" }), Q_GBROAD, Q_ABROAD, q("after", selIds(n), { label: "after: selection" }),
  countIds(n, "Rule 1"), countIds(n, "Rule 2"), countIds(n, "Rule 3"), countIds(n, "Rule 4")] });
const ID_OVER = (name) => `the query '${name}' lists 201 Ids; a Salesforce query takes at most 200. Select by criteria instead, or split the run.`;
const ID_WHERE = (name, n) =>
  `the query '${name}' lists ${n} Id${n === 1 ? "" : "s"}; Ids go only in selection.soql, "after: selection", an after-count or an export labelled "... broad snapshot". Select by criteria instead.`;
const dwProblem = (p) => m.sfDatawriteProblem(DW_CODE, p);
const queueDw = (args, db = helperDb()) => m.queueSwitchboardSfDatawriteTool.handler(args, { db });
const longExport = (n, label, step) => q(step, `SELECT Id, Name FROM GiftTransaction WHERE Name != '${"x".repeat(n)}'`, { label });
const waits = (n, stable, limit) => Array.from({ length: n }, (_, i) =>
  q("after-counts", R2, { label: `Rule ${i + 1}: wait`, wait: { stable_minutes: stable, limit_minutes: limit } }));
const counts = (n) => Array.from({ length: n }, (_, i) =>
  q("after-counts", `SELECT COUNT() FROM Contact WHERE Name != 'n${i + 1}'`, { label: `Rule ${i + 1}` }));

test("sf_datawrite: the Id pattern counts 15- and 18-character quoted literals only", () => {
  assert.equal(m.datawriteIdCount(broadIds(200)), 200);
  assert.equal(m.datawriteIdCount("WHERE Id = 'a0D000000000001' OR Id = 'a0D000000000001AAA'"), 2);
  assert.equal(m.datawriteIdCount("WHERE Name = 'a0D0000000000012' OR Name = 'Closed Won' OR Id = a0D000000000001AAA"), 0);
});

test("sf_datawrite: tier 2, literal tables; queued as sf_datawrite with its project code, then the link; nothing else", async () => {
  assert.equal(m.queueSwitchboardSfDatawriteTool.tier, 2);
  assert.deepEqual(m.queueSwitchboardSfDatawriteTool.tables, { reads: ["switchboard_actions", "switchboard_settings"], writes: ["switchboard_actions"] });
  const db = helperDb();
  const out = await queueDw({ project_code: DW_CODE, chat_url: "x", ...DW_BATCH }, db);
  assert.deepEqual(db.calls.map((c) => c[0]), ["switchboard_queue_helper", "switchboard_issue_link"]);
  const [, params] = db.calls[0];
  assert.equal(params.p_kind, "sf_datawrite");
  assert.equal(params.p_project_code, DW_CODE);
  assert.deepEqual(params.p_payload, DW_BATCH);
  assert.equal(params.p_chat_url, null);
  assert.equal(params.p_headline, `PRODUCTION DATA WRITE ${DW_CODE} ON cd-prod: ABOUT TO CHANGE 45 LIVE RECORDS OF GiftTransaction BY BATCH FixCLinkBatch`);
  assert.deepEqual(db.calls[1][1], { p_action_id: ACTION_ID });
  assert.equal(out.url, LINK.url);
  assert.equal(out.action_id, ACTION_ID);
  assert.match(out.next, /Give Alex the url whole/);
  assert.match(out.next, /ONLY HIS CLICK ON APPROVE STARTS THIS PRODUCTION WRITE/);
  assert.match(out.next, /about to change 45 live records/);
  assert.match(out.next, new RegExp(`datawrite ${ACTION_ID} done or failed\\) arrives in this chat by itself`));
  assert.match(out.next, /Only counts and pass or fail come back/);
});

test("sf_datawrite: the headline says SANDBOX or PRODUCTION, how many, and how it writes", () => {
  assert.equal(m.sfDatawriteHeadline("p-x", DW_BULK), "SANDBOX DATA WRITE p-x ON cd-prod: ABOUT TO CHANGE 45 RECORDS OF GiftTransaction BY BULK UPDATE");
  assert.equal(m.sfDatawriteHeadline("p-x", DW_UNDO), "PRODUCTION DATA WRITE p-x ON cd-prod: ABOUT TO CHANGE 45 LIVE RECORDS OF GiftTransaction BY UNDO FixCUndoBatch");
  assert.equal(m.sfDatawriteHeadline("p-x", { ...DW_BATCH, expected: 26571 }),
    "PRODUCTION DATA WRITE p-x ON cd-prod: ABOUT TO CHANGE 26,571 LIVE RECORDS OF GiftTransaction BY BATCH FixCLinkBatch");
  assert.equal(m.sfDatawriteHeadline("p-x", { ...DW_BULK, expected: 1 }), "SANDBOX DATA WRITE p-x ON cd-prod: ABOUT TO CHANGE 1 RECORD OF GiftTransaction BY BULK UPDATE");
  assert.doesNotMatch(m.sfDatawriteHeadline("p-x", DW_BULK), /PRODUCTION|LIVE/);
});

test("sf_datawrite: a sandbox bulk link's next text says SANDBOX, never PRODUCTION", async () => {
  const out = await queueDw({ project_code: DW_CODE, ...DW_BULK });
  assert.match(out.next, /STARTS THIS SANDBOX WRITE/);
  assert.match(out.next, /records in the sandbox/);
  assert.doesNotMatch(out.next, /PRODUCTION|live records/);
});

test("sf_datawrite: valid batch, bulk and undo payloads, and the edges of every limit, are accepted", async () => {
  const under = setQ(setQ(DW_BATCH, 1, longExport(95000, "gate: gift commitments", "gate")), 2, longExport(95000, "after: broad snapshot", "after"));
  const len = m.jsonbTextLength(under);
  assert.ok(len > 190000 && len <= 200000, String(len));
  const { problem: _p, ...noProblem } = DW_BATCH;
  for (const p of [
    DW_BATCH, DW_BULK, DW_UNDO, DW_BATCHX, noProblem, under,
    setQ(DW_BATCH, 1, q("gate", broadIds(200), { label: "gate: broad snapshot" })),
    setQ(DW_UNDO, 0, q("gate", broadIds(200), { label: "gate: broad snapshot" })),
    setQ(DW_BATCH, 2, q("after", broadIds(200), { label: "after: broad snapshot" })),
    fixC(136), fixC(200),
    setQ(DW_BATCH, 4, countIds(136, "One record")),
    // s11c: exclude.csv also holds records added at the gate, so its rows may reach or pass expected.
    { ...DW_BATCH, uploads: [{ ...EXCLUDE, rows: 45 }] },
    { ...DW_BATCH, uploads: [{ ...EXCLUDE, rows: 46 }] },
    { ...DW_BATCH, queries: [Q_SEL, Q_ABROAD] },
    { ...DW_BATCH, queries: [Q_SEL, Q_ABROAD, ...counts(40)] },
    { ...DW_BATCH, queries: [Q_SEL, Q_ABROAD, ...waits(3, 60, 60)] },
    { ...DW_BATCH, run: `data-ops\\${DW_CODE}\\fixc-2026-11-19` },
  ]) {
    assert.equal(await dwProblem(p), null, JSON.stringify(p).slice(0, 160));
    assert.deepEqual(await m.sfDatawritePayload(DW_CODE, p), { payload: p });
  }
});

test("sf_datawrite: every refusal gives the database's sentence, and nothing is queued", async () => {
  const big = setQ(setQ(DW_BATCH, 1, longExport(99800, "gate: gift commitments", "gate")), 2, longExport(99800, "after: broad snapshot", "after"));
  const bigLen = m.jsonbTextLength(big);
  assert.ok(bigLen > 200000);
  const idSel = "SELECT Id FROM GiftTransaction WHERE Id = 'a0D000000000001AAA'";
  const oneId = "SELECT COUNT() FROM GiftTransaction WHERE Id = 'a0D000000000001AAA'";
  const bad = [
    [{ ...DW_BATCH, ids: ["a0D000000000001AAA"] }, "the payload does not take ids. Pass sb's printed arguments exactly as they are."],
    [{ ...DW_BATCH, write: { ...DW_BATCH.write, ids: [] } },
      "a batch write is {kind: batch, class} only: the class name, with no Ids or start arguments (production starts new <Class>())."],
    [{ ...DW_BATCH, write: { ...DW_BATCH.write, query: SEL } },
      "a batch write is {kind: batch, class} only: the class name, with no Ids or start arguments (production starts new <Class>())."],
    [setQ(DW_BATCH, 0, { ...Q_SEL, rows: [] }), "the query 'selection.soql' does not take rows."],
    [{ ...DW_BATCH, uploads: [{ ...EXCLUDE, ids: [] }] }, "each upload is {purpose, file, sha256, rows}, nothing more or less."],
    [{ ...DW_BULK, uploads: [EXCLUDE] }, "a bulk write uploads nothing; remove uploads."],
    [{ ...DW_BULK, uploads: [] }, "a bulk write uploads nothing; remove uploads."],
    [{ ...DW_BATCH, org_type: "prod" }, 'org_type must be exactly "sandbox" or "production", as sb printed it from orgs.json.'],
    [(({ org_type: _o, ...r }) => r)(DW_BATCH), "missing org_type: pass every argument sb printed."],
    [(({ selection_sha256: _s, ...r }) => r)(DW_BATCH), "missing selection_sha256: pass every argument sb printed."],
    [setQ(DW_BATCH, 1, { ...Q_GBROAD, sha256: "0".repeat(64) }),
      "the query 'gate: broad snapshot' has a sha256 that isn't the SHA-256 of its soql's exact bytes: pass both as sb printed them."],
    [{ ...DW_BATCH, request_sha256: "0123456789ABCDEF".repeat(4) }, "request_sha256 must be request.json's SHA-256: 64 lower-case hex characters."],
    [{ ...DW_BATCH, selection_sha256: HEX3 },
      'the gate\'s first export must be selection.soql (file "selection.soql"), with its sha256 equal to selection_sha256.'],
    [{ ...DW_BATCH, queries: [Q_SEL, Q_GBROAD, Q_R1, Q_ABROAD] },
      "the query 'after: broad snapshot' (after) comes after a later step: list the gate first, then after, then after-counts."],
    [{ ...DW_BATCH, queries: [Q_ABROAD, Q_SEL, Q_R1] },
      "the query 'selection.soql' (gate) comes after a later step: list the gate first, then after, then after-counts."],
    [{ ...DW_BATCH, queries: [Q_SEL, Q_GBROAD, Q_ABROAD, Q_R1, Q_R1] },
      "the label 'Installments with no gift commitment' is used twice: labels are unique within a link."],
    [setQ(DW_BATCH, 1, q("gate", broadIds(201), { label: "gate: broad snapshot" })), ID_OVER("gate: broad snapshot")],
    [setQ(DW_BATCH, 2, q("after", broadIds(201), { label: "after: broad snapshot" })), ID_OVER("after: broad snapshot")],
    [setQ(fixC(200), 0, q("gate", selIds(201), { file: "selection.soql" })), // its sha256 no longer matches selection_sha256
      'the gate\'s first export must be selection.soql (file "selection.soql"), with its sha256 equal to selection_sha256.'],
    [{ ...fixC(201), queries: fixC(201).queries.slice(0, 1).concat([Q_ABROAD]) }, ID_OVER("selection.soql")],
    [{ ...fixC(201), queries: [Q_SEL, Q_ABROAD, q("after", selIds(201), { label: "after: selection" })], selection_sha256: hex(SEL) },
      "the query 'after: selection' is selection.soql run again: its sha256 must equal selection_sha256."],
    [setQ(DW_BATCH, 4, countIds(201, "One record")), ID_OVER("One record")],
    [setQ(DW_BULK, 1, q("gate", "SELECT Id FROM GiftCommitment WHERE Id = 'a0E000000000001AAA'", { label: "gate: gift commitments" })),
      ID_WHERE("gate: gift commitments", 1)],
    [setQ(DW_BULK, 1, q("gate", `SELECT Id FROM GiftCommitment WHERE Id IN (${idList(3)})`, { label: "gate: gift commitments" })),
      ID_WHERE("gate: gift commitments", 3)],
    [big, `the payload is ${bigLen.toLocaleString("en-US")} characters; the limit is 200,000. Select by criteria instead of long lists, or split the run.`],
    [{ ...DW_UNDO, uploads: [{ ...DW_UNDO.uploads[0], rows: 44 }] },
      "the undo Id file has 44 rows but expected is 45: they must be equal, since expected is the Id file's row count."],
    [{ ...DW_UNDO, uploads: [{ ...DW_UNDO.uploads[0], sha256: HEX3 }] },
      "the undo-ids upload must be the write's Id file: the same file and sha256 as write.ids_file and write.ids_sha256."],
    [{ ...DW_UNDO, uploads: [{ ...DW_UNDO.uploads[0], file: "other.csv" }] },
      "the undo-ids upload must be the write's Id file: the same file and sha256 as write.ids_file and write.ids_sha256."],
    [(({ uploads: _u, ...r }) => r)(DW_UNDO),
      'an undo needs its Id file in uploads: {purpose: "undo-ids", file: <ids_file>, sha256: <ids_sha256>, rows: <expected>}.'],
    [{ ...DW_BATCH, uploads: [{ purpose: "undo-ids", file: "undo-ids.csv", sha256: HEX2, rows: 45 }] },
      "only an undo uploads an Id file: leave the undo-ids upload out."],
    [{ ...DW_BATCH, uploads: [EXCLUDE, EXCLUDE] }, "there are two exclude uploads: list each purpose once."],
    [{ ...DW_UNDO, uploads: [DW_UNDO.uploads[0], EXCLUDE, EXCLUDE] },
      "uploads must list at most 2 files, each {purpose, file, sha256, rows}, or be left out."],
    [{ ...DW_BULK, write: { ...DW_BULK.write, operation: "insert" } }, 'a bulk write is an update only: operation must be "update".'],
    [{ ...DW_BULK, write: (({ csv_sha256: _c, ...r }) => r)(DW_BULK.write) },
      "a bulk write is {kind: bulk, operation: update, csv, csv_sha256}, nothing more or less."],
    [{ ...DW_BATCH, write: { kind: "delete", class: "X" } }, "write.kind must be batch, bulk or undo."],
    [{ ...DW_BATCH, queries: [Q_SEL, Q_GBROAD, Q_ASEL, Q_R1] },
      'the after step needs "after: broad snapshot", the same fields as the before broad snapshot.'],
    [setQ(DW_BATCH, 2, { ...Q_ABROAD, label: "after: other" }),
      'an after export is labelled "after: broad snapshot" (required) or "after: selection" (optional).'],
    [setQ(DW_BATCH, 3, q("after", DW_BROAD, { label: "after: selection" })),
      "the query 'after: selection' is selection.soql run again: its sha256 must equal selection_sha256."],
    [{ ...DW_BATCH, queries: [Q_GBROAD, Q_ABROAD] },
      'the gate\'s first export must be selection.soql (file "selection.soql"), with its sha256 equal to selection_sha256.'],
    [{ ...DW_BATCH, queries: [Q_SEL, Q_GBROAD, Q_GGC, Q_ABROAD] }, "the gate has 3 exports; it takes 1 or 2 (an undo, exactly 1)."],
    [{ ...DW_UNDO, queries: [Q_SEL, Q_ABROAD] },
      'an undo\'s gate is a fresh export of the broad snapshot, labelled e.g. "gate: broad snapshot".'],
    [{ ...DW_UNDO, queries: [Q_GBROAD, Q_GGC, Q_ABROAD] }, "an undo's gate is exactly one export: a fresh export of the broad snapshot."],
    [{ ...DW_UNDO, queries: [Q_GBROAD, Q_ABROAD, Q_ASEL] }, 'an undo\'s after is only "after: broad snapshot": leave "after: selection" out.'],
    [setQ(DW_BATCH, 4, { ...Q_R1, wait: { stable_minutes: 2, limit_minutes: 30 } }),
      "the query 'Installments with no gift commitment' takes no wait: only an after-count labelled \"...: wait\" does."],
    [setQ(DW_BATCH, 5, { ...Q_WAIT, wait: { stable_minutes: 0, limit_minutes: 30 } }),
      "the query 'Commitments whose totals are updating: wait''s wait must be {stable_minutes: 1 to 60, limit_minutes: 1 to 240}."],
    [setQ(DW_BATCH, 5, { ...Q_WAIT, wait: { stable_minutes: 2, limit_minutes: 30, every: 1 } }),
      "the query 'Commitments whose totals are updating: wait''s wait must be {stable_minutes: 1 to 60, limit_minutes: 1 to 240}."],
    [{ ...DW_BATCH, queries: [Q_SEL, Q_ABROAD, ...waits(4, 2, 50)] },
      "the waits add up to 200 minutes; the limit is 180, so the run fits its 4 hours. Shorten the waits, or move a rule to a count link."],
    [{ ...DW_BATCH, queries: [Q_SEL, Q_ABROAD, ...counts(41)] }, "there are 41 after-counts; the limit is 40. Move the rest to a count link."],
    [{ ...DW_BATCH, queries: [Q_SEL] }, "queries must list 2 to 44 queries: the gate, the after export, then the after counts."],
    [{ ...DW_BATCH, expected: 0 }, "expected must be the whole number of records the write changes, 1 to 999,999,999."],
    [{ ...DW_BATCH, expected: "45" }, "expected must be the whole number of records the write changes, 1 to 999,999,999."],
    [{ ...DW_BATCH, expected: 45.5 }, "expected must be the whole number of records the write changes, 1 to 999,999,999."],
    [{ ...DW_BATCH, problem: "Too short" }, "problem must be the request's problem sentence: one line of 20 to 600 characters, or left out."],
    [setQ(DW_BATCH, 1, q("gate", R1, { label: "gate: a count" })),
      "the query 'gate: a count' is an export: SELECT Id, ... FROM ..., with no COUNT(."],
    [setQ(DW_BATCH, 4, q("after-counts", DW_GC, { label: "An export" })),
      "the query 'An export' is a count: SELECT COUNT() FROM <object> WHERE ..., with no GROUP BY."],
    [setQ(DW_BATCH, 4, q("after-counts", "SELECT COUNT() FROM Contact WHERE Name != null; DELETE", { label: "Semi" })),
      "the query 'Semi' has a semicolon: one query, no ;."],
    [setQ(DW_BATCH, 1, { ...Q_GBROAD, step: "before" }), "the query 'gate: broad snapshot' needs a step: gate, after or after-counts."],
    [setQ(DW_BATCH, 0, { ...Q_SEL, label: "selection" }), "the query 'selection' needs exactly one of file and label."],
    [{ ...DW_BATCH, run: "data-ops/other-code/fixc-2026-11-19" },
      `run must be the run folder inside repo: data-ops/${DW_CODE}/<run>, one folder, with no ..`],
    [{ ...DW_BATCH, run_tag: "other-code-s9-ab12" }, `run_tag must be this project's run tag, e.g. ${DW_CODE}-s4-ab12.`],
  ];
  for (const [p, sentence] of bad) {
    assert.equal(await dwProblem(p), sentence, JSON.stringify(p).slice(0, 160));
    assert.deepEqual(await m.sfDatawritePayload(DW_CODE, p), { refused: sentence });
  }
  const db = helperDb();
  await assert.rejects(queueDw({ project_code: DW_CODE, ...DW_BATCH, org_type: "prod" }, db),
    /^Error: queue_switchboard_sf_datawrite: refused: org_type must be exactly "sandbox" or "production"/);
  await assert.rejects(queueDw({ ...DW_BATCH }, db), /`project_code`/);
  assert.equal(db.calls.length, 0);
});

test("sf_datawrite: a label with a quote or backslash is named as Postgres quote_literal names it", async () => {
  assert.equal(await dwProblem(setQ(DW_BATCH, 4, { ...Q_R1, label: "Bob's rule", wait: { stable_minutes: 2, limit_minutes: 3 } })),
    "the query 'Bob''s rule' takes no wait: only an after-count labelled \"...: wait\" does.");
  assert.equal(await dwProblem(setQ(DW_BATCH, 4, { ...Q_R1, label: "a\\b", wait: { stable_minutes: 2, limit_minutes: 3 } })),
    "the query E'a\\\\b' takes no wait: only an after-count labelled \"...: wait\" does.");
});

test("sf_datawrite: refusals say what to fix; operational failures say the call can be made again; neither says do not retry", async () => {
  await assert.rejects(queueDw({ project_code: DW_CODE, ...DW_BATCH },
    helperDb({ queue: { data: null, error: { code: "23514", message: "switchboard_queue_helper: refused: the query 'x' lists 1 Id" } } })),
    /refused: switchboard_queue_helper: refused: the query 'x' lists 1 Id/);
  const opQueue = await queueDw({ project_code: DW_CODE, ...DW_BATCH },
    helperDb({ queue: { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } } })).catch((e) => e);
  assert.match(opQueue.message, /queueing the write link failed: canceling statement due to statement timeout \[57014\]\. Nothing was queued; the same call can be made again\./);
  await assert.rejects(queueDw({ project_code: DW_CODE, ...DW_BATCH },
    helperDb({ link: { data: null, error: { code: "55000", message: "another link is live" } } })), new RegExp(`queued as ${ACTION_ID}, but no link: another link is live`));
  const opLink = await queueDw({ project_code: DW_CODE, ...DW_BATCH },
    helperDb({ link: { data: null, error: { code: "08006", message: "connection failure" } } })).catch((e) => e);
  assert.match(opLink.message, new RegExp(`queued as ${ACTION_ID}, but issuing its link failed: connection failure \\[08006\\]\\. Issue it again with issue_switchboard_link for ${ACTION_ID}\\.`));
  for (const e of [opQueue, opLink]) assert.doesNotMatch(e.message, /not retry|don't retry|do not/i);
});

test("sf_datawrite: v1 sf_dataop is untouched: its payload, headline and next text are as before", async () => {
  assert.deepEqual(m.sfDataopPayload(DATAOP), { payload: DATAOP });
  assert.match(m.sfDataopPayload({ ...DATAOP, queries: DW_BATCH.queries }).refused, /does not take queries/);
  assert.equal(m.sfDataopHeadline("p-x", DATAOP),
    "PRODUCTION DATA RUN p-x ON cd-prod: ABOUT TO CHANGE 26,571 LIVE RECORDS OF Demo_Gift__c BY BATCH FixCLinkBatch");
  const db = helperDb();
  const out = await queueDataop({ project_code: "p-x", ...DATAOP }, db);
  assert.equal(db.calls[0][1].p_kind, "sf_dataop");
  assert.match(out.next, new RegExp(`dataop ${ACTION_ID} done or failed`));
  // And a v1 payload is no sf_datawrite.
  assert.match(await dwProblem(DATAOP), /^the payload does not take plan, preflight_at, rehearsal, rows, stamp\./);
});
