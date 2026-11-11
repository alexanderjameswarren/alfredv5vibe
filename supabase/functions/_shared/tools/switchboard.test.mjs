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
    [{ ...COUNT_READ, filters: [{ field: "Email", op: "=", value: "x" }] }, /ids reads only Id, CreatedDate, LastModifiedDate.*Email needs level data/],
    [{ alias: "a", production: false, level: "ids", object: "Contact", fields: ["Id", "Email"], limit: 5 }, /Email needs level data/],
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
