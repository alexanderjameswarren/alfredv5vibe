// Handler tests for warren-buffet.ts.
//
// Run:
//   node --experimental-strip-types --test supabase/functions/_shared/tools/warren-buffet.test.mjs
//
// platform.ts is stubbed (defineTool returns its options). The fake ctx.db
// answers each query through `respond(table, calls)`. No real financial data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "wb-tools-"));
writeFileSync(join(dir, "platform.ts"), `
export const defineTool = (o) => o;
export const clampLimit = (n) => Math.min(n ?? 20, 50);
export const envelope = (data, meta = {}) => ({ data, meta });
export const describeDbError = (name, e) => name + " failed: " + e.message;
`);
const IMPORT = 'from "../platform.ts";';
const src = readFileSync(join(HERE, "warren-buffet.ts"), "utf-8");
if (!src.includes(IMPORT)) throw new Error("warren-buffet.ts import line changed — update this test.");
writeFileSync(join(dir, "warren-buffet.ts"), src.replace(IMPORT, 'from "./platform.ts";'));
const m = await import(pathToFileURL(join(dir, "warren-buffet.ts")).href);

const MONEY = "muvitejhrgt3rgi8t6q";

/** Fake ctx.db. Each query's calls are logged; respond(table, ops) gives its result. */
function fakeDb(respond = () => ({ data: [], error: null, count: 0 })) {
  const log = [];
  const from = (table) => {
    const ops = [];
    log.push({ table, ops });
    const finish = () => Promise.resolve(respond(table, ops));
    const b = new Proxy({}, {
      get: (_t, k) => {
        if (k === "then") return (res, rej) => finish().then(res, rej);
        if (k === "maybeSingle" || k === "single") return () => { ops.push([k]); return finish(); };
        return (...a) => { ops.push([k, ...a]); return b; };
      },
    });
    return b;
  };
  return { log, from, op: (table, name) => log.filter((q) => q.table === table).flatMap((q) => q.ops).filter((o) => o[0] === name) };
}
const has = (ops, name) => ops.some((o) => o[0] === name);
const writes = (db) => db.log.filter((q) => has(q.ops, "insert") || has(q.ops, "update"));

// --- validation helpers ----------------------------------------------------

test("parseDate accepts real dates only", () => {
  assert.equal(m.parseDate("t", "d", "2026-02-28"), "2026-02-28");
  assert.equal(m.parseDate("t", "d", undefined), null);
  assert.throws(() => m.parseDate("t", "d", "2026-02-30"), /not a real date/);
  assert.throws(() => m.parseDate("t", "d", "02/03/2026"), /YYYY-MM-DD/);
});

test("parseMoney rounds to cents and rejects junk", () => {
  assert.equal(m.parseMoney("t", "x", 12.345), 12.35);
  assert.equal(m.parseMoney("t", "x", -5), -5);
  assert.throws(() => m.parseMoney("t", "x", "12"), /must be a number/);
  assert.throws(() => m.parseMoney("t", "x", NaN), /must be a number/);
});

test("searchTerm strips PostgREST syntax", () => {
  assert.equal(m.searchTerm("t", "a,b(c)*%"), "a b c");
  assert.throws(() => m.searchTerm("t", ",()"), /no searchable/);
});

test("pacificMidnight follows daylight time", () => {
  assert.equal(m.pacificMidnight("2026-07-01"), "2026-07-01T00:00:00-07:00");
  assert.equal(m.pacificMidnight("2026-01-15"), "2026-01-15T00:00:00-08:00");
});

// --- reads -----------------------------------------------------------------

test("get_wb_accounts hides hidden by default, merges notes, flags truncation", async () => {
  const db = fakeDb((t) => t === "wb_account_latest"
    ? { data: [{ account_id: "a1", role: "spending_cash" }], error: null, count: 3 }
    : { data: [{ id: "a1", notes: "n", active_from: null, active_until: null }], error: null });
  const out = await m.getWbAccountsTool.handler({ role: "spending_cash", limit: 1 }, { db });
  assert.deepEqual(db.op("wb_account_latest", "eq"), [["eq", "role", "spending_cash"], ["eq", "is_hidden", false]]);
  assert.equal(out.data[0].notes, "n");
  assert.deepEqual(out.meta, { count: 3, limit_applied: 1, truncated: true, total: 3 });
});

test("get_wb_accounts owner none and include_hidden", async () => {
  const db = fakeDb();
  await m.getWbAccountsTool.handler({ owner: "none", include_hidden: true }, { db });
  assert.deepEqual(db.op("wb_account_latest", "is"), [["is", "owner", null]]);
  assert.deepEqual(db.op("wb_account_latest", "eq"), []);
  await assert.rejects(m.getWbAccountsTool.handler({ role: "savings" }, { db }), /role must be one of/);
  await assert.rejects(m.getWbAccountsTool.handler({ limit: 0 }, { db }), /limit/);
});

test("get_wb_balance_history needs exactly one of account_id and role", async () => {
  const db = fakeDb();
  await assert.rejects(m.getWbBalanceHistoryTool.handler({}, { db }), /exactly one/);
  await assert.rejects(m.getWbBalanceHistoryTool.handler({ account_id: "a", role: "loan" }, { db }), /exactly one/);
  await assert.rejects(
    m.getWbBalanceHistoryTool.handler({ account_id: "a", from: "2026-02-01", to: "2026-01-01" }, { db }),
    /after to/,
  );
});

test("get_wb_balance_history by role reads the net worth group column", async () => {
  const db = fakeDb(() => ({ data: [{ as_of: "2026-01-02", credit_owed: -10 }], error: null, count: 1 }));
  const out = await m.getWbBalanceHistoryTool.handler({ role: "emergency_credit", from: "2026-01-01" }, { db });
  assert.equal(db.log[0].table, "wb_net_worth_daily");
  assert.deepEqual(db.op("wb_net_worth_daily", "select")[0][1], "as_of, credit_owed");
  assert.deepEqual(out.data, [{ as_of: "2026-01-02", role_group: "credit_owed", total: -10 }]);
});

test("get_wb_net_worth filters dates before the limit", async () => {
  const db = fakeDb();
  await m.getWbNetWorthTool.handler({ from: "2026-01-01", to: "2026-01-31" }, { db });
  const ops = db.log[0].ops.map((o) => o[0]);
  assert.deepEqual(ops, ["select", "gte", "lte", "order", "limit"]);
});

test("get_wb_transactions never selects raw, and builds its filters", async () => {
  const db = fakeDb();
  await m.getWbTransactionsTool.handler(
    { account_id: "a1", from: "2026-07-01", to: "2026-07-31", search: "coffee", max_amount: -5, pending: false },
    { db },
  );
  const ops = db.log[0].ops;
  assert.ok(!/\braw\b/.test(ops[0][1]), "raw must not be selected");
  assert.deepEqual(ops.find((o) => o[0] === "gte"), ["gte", "posted_at", "2026-07-01T00:00:00-07:00"]);
  assert.deepEqual(ops.find((o) => o[0] === "lt"), ["lt", "posted_at", "2026-08-01T00:00:00-07:00"]);
  assert.deepEqual(ops.find((o) => o[0] === "or"), ["or", "description.ilike.*coffee*,payee.ilike.*coffee*"]);
  assert.deepEqual(ops.find((o) => o[0] === "lte"), ["lte", "amount", -5]);
  assert.ok(ops.findIndex((o) => o[0] === "limit") > ops.findIndex((o) => o[0] === "eq" && o[1] === "pending"));
});

test("get_wb_transactions rejects min above max", async () => {
  await assert.rejects(
    m.getWbTransactionsTool.handler({ min_amount: 10, max_amount: -10 }, { db: fakeDb() }),
    /greater than max_amount/,
  );
});

test("get_wb_holdings uses the latest day when as_of is omitted", async () => {
  const db = fakeDb((t, ops) => has(ops, "maybeSingle")
    ? { data: { as_of: "2026-10-07" }, error: null }
    : { data: [{ symbol: "X" }], error: null, count: 1 });
  const out = await m.getWbHoldingsTool.handler({ account_id: "a1" }, { db });
  assert.deepEqual(db.log[1].ops.filter((o) => o[0] === "eq"), [["eq", "as_of", "2026-10-07"], ["eq", "account_id", "a1"]]);
  assert.equal(out.data.length, 1);
  const empty = fakeDb(() => ({ data: null, error: null }));
  assert.deepEqual((await m.getWbHoldingsTool.handler({}, { db: empty })).data, []);
});

// --- update_wb_account -----------------------------------------------------

const acct = (over = {}) => ({ data: { id: "a1", active_from: null, active_until: null, ...over }, error: null });

test("update_wb_account writes human columns and the Money context", async () => {
  const db = fakeDb(() => acct());
  await m.updateWbAccountTool.handler({ id: "a1", role: "credit_card", owner: "joint", notes: null }, { db });
  const patch = db.op("wb_accounts", "update")[0][1];
  assert.deepEqual(patch, { role: "credit_card", owner: "joint", notes: null, context_id: MONEY });
});

test("update_wb_account refuses synced fields and writes nothing", async () => {
  const db = fakeDb(() => acct());
  await assert.rejects(m.updateWbAccountTool.handler({ id: "a1", name: "x" }, { db }), /name is owned by the sync/);
  await assert.rejects(
    m.updateWbAccountTool.handler({ id: "a1", last4: "1234", institution: "x", notes: "n" }, { db }),
    /last4, institution are owned by the sync/,
  );
  await assert.rejects(m.updateWbAccountTool.handler({ id: "a1", colour: "red" }, { db }), /unknown field/);
  assert.equal(db.log.length, 0);
});

test("update_wb_account refusals", async () => {
  const db = fakeDb(() => acct({ active_until: "2025-12-31" }));
  await assert.rejects(m.updateWbAccountTool.handler({ id: "a1" }, { db }), /nothing to change/);
  await assert.rejects(m.updateWbAccountTool.handler({ id: "a1", role: null }, { db }), /cannot be cleared/);
  await assert.rejects(m.updateWbAccountTool.handler({ id: "a1", role: "savings" }, { db }), /role must be one of/);
  await assert.rejects(m.updateWbAccountTool.handler({ id: "a1", is_hidden: null }, { db }), /is_hidden/);
  await assert.rejects(
    m.updateWbAccountTool.handler({ id: "a1", active_from: "2026-01-01" }, { db }),
    /active_from 2026-01-01 is after active_until 2025-12-31/,
  );
  assert.equal(writes(db).length, 0);
  const none = fakeDb(() => ({ data: null, error: null }));
  await assert.rejects(m.updateWbAccountTool.handler({ id: "zz", notes: "n" }, { db: none }), /no account zz/);
});

// --- create_wb_manual_account ----------------------------------------------

test("create_wb_manual_account inserts a manual row in the Money context", async () => {
  const db = fakeDb((t, ops) => has(ops, "insert") ? { data: { id: "new" }, error: null } : { data: null, error: null });
  const out = await m.createWbManualAccountTool.handler({ name: " Test 401k ", role: "retirement", currency: "usd" }, { db });
  assert.deepEqual(out, { id: "new" });
  const row = db.op("wb_accounts", "insert")[0][1];
  assert.equal(row.source, "manual");
  assert.equal(row.external_id, null);
  assert.equal(row.context_id, MONEY);
  assert.equal(row.name, "Test 401k");
  assert.equal(row.currency, "USD");
  assert.equal(row.is_hidden, false);
  assert.deepEqual(db.op("wb_accounts", "ilike")[0], ["ilike", "name", "Test 401k"]);
});

test("create_wb_manual_account defaults role to unassigned", async () => {
  const db = fakeDb((t, ops) => has(ops, "insert") ? { data: { id: "n" }, error: null } : { data: null, error: null });
  await m.createWbManualAccountTool.handler({ name: "x" }, { db });
  assert.equal(db.op("wb_accounts", "insert")[0][1].role, "unassigned");
});

test("create_wb_manual_account refusals write nothing", async () => {
  const dupe = fakeDb(() => ({ data: { id: "a9", name: "Test 401K" }, error: null }));
  await assert.rejects(m.createWbManualAccountTool.handler({ name: "test 401k" }, { db: dupe }), /already exists/);
  assert.equal(writes(dupe).length, 0);
  const db = fakeDb();
  await assert.rejects(m.createWbManualAccountTool.handler({}, { db }), /name is required/);
  await assert.rejects(m.createWbManualAccountTool.handler({ name: "x", last4: "123456" }, { db }), /four digits/);
  await assert.rejects(m.createWbManualAccountTool.handler({ name: "x", currency: "dollars" }, { db }), /three-letter/);
  await assert.rejects(
    m.createWbManualAccountTool.handler({ name: "x", active_from: "2026-02-01", active_until: "2026-01-01" }, { db }),
    /after active_until/,
  );
  assert.equal(db.log.length, 0);
});

test("create_wb_manual_account escapes LIKE wildcards in the duplicate check", async () => {
  const db = fakeDb((t, ops) => has(ops, "insert") ? { data: { id: "n" }, error: null } : { data: null, error: null });
  await m.createWbManualAccountTool.handler({ name: "100%_rewards" }, { db });
  assert.equal(db.op("wb_accounts", "ilike")[0][2], "100\\%\\_rewards");
});

// --- record_wb_balance -----------------------------------------------------

function balanceDb(account, existing) {
  return fakeDb((t, ops) => {
    if (t === "wb_accounts") return { data: account, error: null };
    if (has(ops, "insert") || has(ops, "update")) return { data: { id: "s1" }, error: null };
    return { data: existing, error: null };
  });
}
const MANUAL = { id: "a1", source: "manual", name: "Test 401k", display_name: null };

test("record_wb_balance inserts a new day in the Money context", async () => {
  const db = balanceDb(MANUAL, null);
  const out = await m.recordWbBalanceTool.handler({ account_id: "a1", as_of: "2026-01-31", balance: 1000.005 }, { db });
  const row = db.op("wb_balance_snapshots", "insert")[0][1];
  assert.deepEqual(row, {
    balance: 1000.01, available_balance: null, source: "manual", notes: null,
    context_id: MONEY, account_id: "a1", as_of: "2026-01-31",
  });
  assert.equal(out.replaced, null);
});

test("record_wb_balance replaces a manual or import row", async () => {
  const db = balanceDb(MANUAL, { id: "s0", source: "import" });
  const out = await m.recordWbBalanceTool.handler({ account_id: "a1", as_of: "2026-01-31", balance: -5, source: "manual" }, { db });
  assert.deepEqual(db.op("wb_balance_snapshots", "eq").at(-1), ["eq", "id", "s0"]);
  assert.equal(out.replaced, "import");
});

test("record_wb_balance refuses synced accounts and sync rows", async () => {
  const synced = balanceDb({ ...MANUAL, source: "simplefin", display_name: "Checking" }, null);
  await assert.rejects(
    m.recordWbBalanceTool.handler({ account_id: "a1", as_of: "2026-01-31", balance: 1 }, { db: synced }),
    /"Checking" is synced from SimpleFIN/,
  );
  assert.equal(writes(synced).length, 0);
  const syncRow = balanceDb(MANUAL, { id: "s0", source: "sync" });
  await assert.rejects(
    m.recordWbBalanceTool.handler({ account_id: "a1", as_of: "2026-01-31", balance: 1 }, { db: syncRow }),
    /came from the sync/,
  );
  assert.equal(writes(syncRow).length, 0);
});

test("record_wb_balance input refusals", async () => {
  const db = balanceDb(MANUAL, null);
  await assert.rejects(m.recordWbBalanceTool.handler({ balance: 1 }, { db }), /account_id is required/);
  await assert.rejects(m.recordWbBalanceTool.handler({ account_id: "a1" }, { db }), /balance is required/);
  await assert.rejects(m.recordWbBalanceTool.handler({ account_id: "a1", balance: 1, as_of: "2999-01-01" }, { db }), /future/);
  await assert.rejects(m.recordWbBalanceTool.handler({ account_id: "a1", balance: 1, source: "sync" }, { db }), /source must be one of/);
  assert.equal(db.log.length, 0);
  const none = balanceDb(null, null);
  await assert.rejects(m.recordWbBalanceTool.handler({ account_id: "zz", balance: 1 }, { db: none }), /no account zz/);
});
