// Handler tests for warren-buffet-p3.ts.
//
// Run:
//   node --test supabase/functions/_shared/tools/warren-buffet-p3.test.mjs
//
// platform.ts is stubbed (defineTool returns its options). The fake ctx.db
// answers queries through respond(table, ops) and rpc calls through rpc(fn, params).
// Invented data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTool, WB_SETTINGS, withSettings } from "./test-platform.mjs";

// The real platform.ts runs (test-platform.mjs); defineTool returns its options.
const m = await loadTool("warren-buffet-p3.ts");

const MONEY = "muvitejhrgt3rgi8t6q";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fakeDb(respond = () => ({ data: [], error: null, count: 0 }), rpc = () => ({ data: {}, error: null })) {
  const log = [];
  const rpcs = [];
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
  return withSettings({
    log, rpcs, from,
    rpc: (fn, params) => { rpcs.push([fn, params]); return Promise.resolve(rpc(fn, params)); },
    op: (table, name) => log.filter((q) => q.table === table).flatMap((q) => q.ops).filter((o) => o[0] === name),
  }, WB_SETTINGS);
}
const has = (ops, name) => ops.some((o) => o[0] === name);
const writes = (db) => db.log.filter((q) => has(q.ops, "insert") || has(q.ops, "update") || has(q.ops, "upsert") || has(q.ops, "delete"));
const run = (tool, args, db) => tool.handler(args, { db, userId: "u" });

test("tiers", () => {
  const tiers = Object.fromEntries(Object.values(m).filter((t) => t && t.name && t.tier).map((t) => [t.name, t.tier]));
  assert.deepEqual(tiers, {
    get_wb_projects: 1, get_wb_planned_items: 1, get_wb_planned_matches: 1, get_wb_settings: 1, get_wb_free_cash: 1,
    get_wb_true_cost: 1, get_wb_cash_projection: 1, upsert_wb_project: 2, upsert_wb_planned_item: 2,
    create_wb_planned_match: 3, update_wb_planned_match: 2, set_wb_transaction_project: 2, update_wb_settings: 3,
    get_wb_project_summary: 1, get_wb_missed_dates: 1, mark_wb_missed_dates_not_needed: 2, unconfirm_wb_planned_match: 2,
    get_wb_action_items: 1,
  });
  assert.equal(typeof m.createWbPlannedMatchTool.propose, "function");
  assert.equal(typeof m.updateWbSettingsTool.propose, "function");
});

test("planned items: drafts marked, remaining from confirmed matches, bounded", async () => {
  const items = [
    { id: id(1), name: "ZZ bill", amount: -100, stage: "invoiced", interval_count: null, is_draft: false },
    { id: id(2), name: "ZZ what if", amount: -50, stage: "draft", interval_count: null, is_draft: false },
    { id: id(3), name: "ZZ income", amount: 20, stage: null, interval_count: 1, interval_unit: "month", is_draft: true },
  ];
  const db = fakeDb((t) => t === "wb_planned_items" ? { data: items, error: null, count: 3 }
    : { data: [{ planned_item_id: id(1), occurrence_on: null, amount_applied: -40 }], error: null });
  const res = await run(m.getWbPlannedItemsTool, { limit: 99 }, db);
  const [a, b, c] = res.data;
  assert.equal(a.draft, false); assert.equal(a.confirmed_total, -40); assert.equal(a.remaining, -60);
  assert.equal(b.draft, true);
  assert.equal(c.draft, true); assert.equal(c.recurring, true); assert.equal("remaining" in c, false);
  assert.deepEqual(db.op("wb_planned_items", "range")[0], ["range", 0, 49]);
  assert.deepEqual(db.op("wb_planned_matches", "in")[0], ["in", "planned_item_id", [id(1), id(2), id(3)]]);

  const db2 = fakeDb(() => ({ data: [], error: null, count: 0 }));
  await run(m.getWbPlannedItemsTool, { include_drafts: false }, db2);
  assert.deepEqual(db2.op("wb_planned_items", "eq")[0], ["eq", "is_draft", false]);
  assert.equal(db2.op("wb_planned_items", "or").length, 1);
});

test("confirmed_total carries the item's sign: amount = confirmed_total + remaining", () => {
  const bill = m.annotateItem({ id: id(1), amount: -100, stage: "invoiced", interval_count: null },
    [{ planned_item_id: id(1), amount_applied: -30 }, { planned_item_id: id(1), amount_applied: -20 }]);
  assert.deepEqual([bill.confirmed_total, bill.remaining], [-50, -50]);
  assert.equal(bill.confirmed_total + bill.remaining, bill.amount);
  const income = m.annotateItem({ id: id(2), amount: 80, stage: "estimate", interval_count: null },
    [{ planned_item_id: id(2), amount_applied: 25 }]);
  assert.deepEqual([income.confirmed_total, income.remaining], [25, 55]);
  assert.equal(income.confirmed_total + income.remaining, income.amount);
  const recurringBill = m.annotateItem({ id: id(3), amount: -10, stage: null, interval_count: 1 },
    [{ planned_item_id: id(3), amount_applied: -10 }]);
  assert.equal(recurringBill.confirmed_total, -10);
});

test("cash projection: event days and the low point only, truncated with a count", async () => {
  const rows = [];
  for (let d = 1; d <= 30; d++) {
    const day = `2031-06-${String(d).padStart(2, "0")}`;
    rows.push({ day, opening: 1000 - d, planned_in: 0, planned_out: d % 10 === 0 ? -50 : 0, subscriptions: d === 5 ? -10 : 0,
      burn: -1, closing: 1000 - d * 2 });
  }
  const db = fakeDb(undefined, (fn) => ({ data: rows, error: null }));
  const res = await run(m.getWbCashProjectionTool, { limit: 2 }, db);
  assert.equal(db.rpcs[0][0], "wb_cash_projection");
  assert.deepEqual(res.data.days.map((r) => r.day), ["2031-06-05", "2031-06-10"]);
  assert.equal(res.meta.truncated, true); assert.equal(res.meta.total, 4);
  assert.deepEqual(res.data.low_point, { day: "2031-06-30", closing: 940 });
  assert.deepEqual(res.data.start, { day: "2031-06-01", opening: 999 });
});

test("upsert_wb_planned_item: a new one-off needs a stage; every write asks for suggestions", async () => {
  const db0 = fakeDb();
  await assert.rejects(run(m.upsertWbPlannedItemTool, { name: "ZZ x", amount: -10, due_on: "2031-01-01" }, db0), /needs a stage/);
  assert.equal(writes(db0).length, 0);
  await assert.rejects(run(m.upsertWbPlannedItemTool, { name: "ZZ x", amount: 0, due_on: "2031-01-01", stage: "estimate" }, db0), /non-zero/);

  const db = fakeDb((t, ops) => has(ops, "insert")
    ? { data: { id: id(9), name: "ZZ x", amount: -10, stage: "estimate", interval_count: null }, error: null }
    : { data: [], error: null }, () => ({ data: { suggested: 1, removed: 0 }, error: null }));
  const res = await run(m.upsertWbPlannedItemTool, { name: "ZZ x", amount: -10, due_on: "2031-01-01", stage: "estimate" }, db);
  assert.equal(db.op("wb_planned_items", "insert")[0][1].context_id, MONEY);
  assert.deepEqual(db.rpcs[0], ["wb_suggest_planned_matches", { p_transaction_ids: null, p_planned_item_ids: [id(9)] }]);
  assert.deepEqual(res.suggestions, { suggested: 1, removed: 0 });
  assert.equal(res.created, true);
});

/** A db for matchPlan: one planned item, its payment's splits, and any existing matches. */
function matchDb({ item, splits, payment, matches = [] }, rpc) {
  return fakeDb((t, ops) => {
    if (t === "wb_planned_items") return { data: item, error: null };
    if (t === "wb_splits") return { data: splits, error: null };
    if (t === "wb_transaction_list") return { data: payment, error: null };
    if (t === "wb_planned_matches") return has(ops, "insert") ? { data: { id: id(77) }, error: null } : { data: matches, error: null };
    return { data: [], error: null };
  }, rpc);
}
const item = { id: id(1), name: "ZZ invoice", amount: -100, due_on: "2031-03-10", interval_count: null, stage: "invoiced" };
const payment = { id: id(5), txn_date: "2031-03-12", amount: -60, clean_description: "ZZ CONTRACTOR", pending: false };

test("create_wb_planned_match propose: what confirming would do, and nothing written", async () => {
  const db = matchDb({ item, splits: [{ id: id(6), transaction_id: id(5), amount: -60 }], payment });
  const p = await m.createWbPlannedMatchTool.propose({ planned_item_id: id(1), transaction_id: id(5) }, { db });
  assert.deepEqual(p.planned_item, { id: id(1), name: "ZZ invoice", due_on: "2031-03-10", occurrence_on: null, amount: -100 });
  assert.deepEqual(p.payment, { transaction_id: id(5), split_id: id(6), date: "2031-03-12", description: "ZZ CONTRACTOR", amount: -60 });
  assert.equal(p.amount_applied, -60);
  assert.equal(p.would_mark_paid, false);
  assert.equal(writes(db).length, 0);

  const full = matchDb({ item, splits: [{ id: id(6), transaction_id: id(5), amount: -60 }], payment,
    matches: [{ planned_item_id: id(1), split_id: id(8), occurrence_on: null, amount_applied: -40, status: "confirmed" }] });
  const p2 = await m.createWbPlannedMatchTool.propose({ planned_item_id: id(1), transaction_id: id(5) }, { db: full });
  assert.equal(p2.would_mark_paid, true);
});

test("create_wb_planned_match propose refuses what the write would refuse", async () => {
  const P = (args, data) => m.createWbPlannedMatchTool.propose(args, { db: matchDb(data) });
  const ok = { item, splits: [{ id: id(6), transaction_id: id(5), amount: -60 }], payment };
  await assert.rejects(P({ planned_item_id: id(1), transaction_id: id(5) },
    { ...ok, splits: [{ id: id(6), transaction_id: id(5), amount: -30 }, { id: id(7), transaction_id: id(5), amount: -30 }] }), /split into 2 parts/);
  await assert.rejects(P({ planned_item_id: id(1), transaction_id: id(5) }, { ...ok, payment: { ...payment, pending: true } }), /pending/);
  await assert.rejects(P({ planned_item_id: id(1), transaction_id: id(5) }, { ...ok, item: { ...item, interval_count: 1 } }), /occurrence_on/);
  await assert.rejects(P({ planned_item_id: id(1), transaction_id: id(5) }, { ...ok, splits: [{ id: id(6), transaction_id: id(5), amount: 60 }] }), /opposite ways/);
  await assert.rejects(P({ planned_item_id: id(1), transaction_id: id(5), amount: 90 }, ok),
    /That is more than what's left of this payment; lower the amount\. Nothing was changed\./);
  await assert.rejects(P({ planned_item_id: id(1), transaction_id: id(5), amount: 50 },
    { ...ok, matches: [{ planned_item_id: id(9), split_id: id(6), occurrence_on: null, amount_applied: -30, status: "confirmed" }] }),
    /what's left of this payment \(part of it is already matched to another planned item\); lower the amount/);
  await assert.rejects(P({ planned_item_id: id(1), transaction_id: id(5) },
    { ...ok, matches: [{ planned_item_id: id(1), split_id: id(6), occurrence_on: null, amount_applied: -60, status: "rejected" }] }), /already rejected/);
  await assert.rejects(P({ planned_item_id: id(1) }, ok), /transaction_id .* or split_id/);
});

test("create_wb_planned_match: inserts the match, confirms through the function, cleans up on refusal", async () => {
  const data = { item, splits: [{ id: id(6), transaction_id: id(5), amount: -60 }], payment };
  const db = matchDb(data, () => ({ data: { status: "confirmed", stage_paid: false }, error: null }));
  const res = await run(m.createWbPlannedMatchTool, { planned_item_id: id(1), transaction_id: id(5), amount: 25, confirmed: true }, db);
  assert.deepEqual(db.op("wb_planned_matches", "insert")[0][1],
    { planned_item_id: id(1), split_id: id(6), occurrence_on: null, amount_applied: -25, status: "suggested", source: "claude" });
  assert.deepEqual(db.rpcs[0], ["wb_confirm_planned_match", { p_match_id: id(77), p_action: "confirm", p_amount: null }]);
  assert.equal(res.stage_paid, false);

  const bad = matchDb(data, () => ({ data: null, error: { message: "wb_planned_matches: confirmed matches on this split would exceed its amount" } }));
  await assert.rejects(run(m.createWbPlannedMatchTool, { planned_item_id: id(1), transaction_id: id(5), confirmed: true }, bad),
    /That is more than what's left of this payment \(part of it may already be matched to another planned item\); lower the amount\. Nothing was changed\./);
  assert.equal(bad.op("wb_planned_matches", "delete").length, 1);
});

test("update_wb_planned_match goes through wb_confirm_planned_match", async () => {
  const db = fakeDb(undefined, () => ({ data: { status: "confirmed", stage_paid: true }, error: null }));
  const res = await run(m.updateWbPlannedMatchTool, { match_id: id(3), action: "confirm", amount: -12.5 }, db);
  assert.deepEqual(db.rpcs[0], ["wb_confirm_planned_match", { p_match_id: id(3), p_action: "confirm", p_amount: 12.5 }]);
  assert.equal(res.stage_paid, true);
  await assert.rejects(run(m.updateWbPlannedMatchTool, { match_id: id(3), action: "reject", amount: 1 }, fakeDb()), /only goes with confirm/);
  const done = fakeDb(undefined, () => ({ data: null, error: { message: "wb_confirm_planned_match: this match was already confirmed" } }));
  await assert.rejects(run(m.updateWbPlannedMatchTool, { match_id: id(3), action: "reject" }, done), /already confirmed or turned down/);
});

test("set_wb_transaction_project: single splits only, at most 25, project_id required", async () => {
  const db = fakeDb((t, ops) => has(ops, "update") ? { data: null, error: null }
    : { data: [{ id: id(11), transaction_id: id(1) }, { id: id(12), transaction_id: id(2) }, { id: id(13), transaction_id: id(2) }], error: null });
  const res = await run(m.setWbTransactionProjectTool, { transaction_ids: [id(1), id(2), id(3)], project_id: id(9) }, db);
  assert.deepEqual(res, { updated: 1, project_id: id(9), skipped_multi_split: [id(2)], not_found: [id(3)] });
  assert.deepEqual(db.op("wb_splits", "update")[0][1], { project_id: id(9), project_source: "claude" });
  assert.deepEqual(db.op("wb_splits", "in")[1], ["in", "id", [id(11)]]);
  await assert.rejects(run(m.setWbTransactionProjectTool, { transaction_ids: [id(1)] }, fakeDb()), /pass project_id/);
  const many = Array.from({ length: 26 }, (_, i) => id(100 + i));
  await assert.rejects(run(m.setWbTransactionProjectTool, { transaction_ids: many, project_id: null }, fakeDb()), /at most 25/);
});

test("settings: floor_missing with no row; update proposes old against new and writes only when confirmed", async () => {
  const none = fakeDb(() => ({ data: null, error: null }));
  const s = await run(m.getWbSettingsTool, {}, none);
  assert.deepEqual(s, { exists: false, safety_floor: null, floor_missing: true, horizon_months: 12, notes: null });

  const db = fakeDb(() => ({ data: { safety_floor: null, horizon_months: 12, notes: null }, error: null }));
  const p = await m.updateWbSettingsTool.propose({ notes: "ZZ note" }, { db });
  assert.deepEqual(p, {
    current: { safety_floor: null, horizon_months: 12, notes: null },
    proposed: { safety_floor: null, horizon_months: 12, notes: "ZZ note" },
    changing: ["notes"],
  });
  assert.equal(writes(db).length, 0);
  await assert.rejects(m.updateWbSettingsTool.propose({}, { db }), /pass safety_floor, horizon_months or notes/);
  await assert.rejects(m.updateWbSettingsTool.propose({ horizon_months: 30 }, { db }), /1 to 24/);

  const w = fakeDb(() => ({ data: { safety_floor: null, horizon_months: 12, notes: "ZZ note" }, error: null }));
  const r = await run(m.updateWbSettingsTool, { notes: "ZZ note", confirmed: true }, w);
  assert.deepEqual(w.op("wb_settings", "upsert")[0].slice(1), [{ notes: "ZZ note", context_id: MONEY }, { onConflict: "context_id" }]);
  assert.equal(r.floor_missing, true);
});

test("free cash and true cost read their functions and views", async () => {
  const db = fakeDb((t) => t === "wb_true_cost" ? { data: { true_cost_monthly: -5 }, error: null }
    : { data: [{ month: "2031-03-01", included: -1 }], error: null },
  () => ({ data: [{ free_cash: 1, floor_missing: true }], error: null }));
  const f = await run(m.getWbFreeCashTool, { include_drafts: true }, db);
  assert.deepEqual(db.rpcs[0], ["wb_free_cash", { p_include_drafts: true }]);
  assert.deepEqual(f, { free_cash: 1, floor_missing: true, include_drafts: true });
  const tc = await run(m.getWbTrueCostTool, {}, db);
  assert.equal(tc.true_cost_monthly, -5);
  assert.equal(tc.burn_months.length, 1);
});

test("projects: a new one needs a name and goes in the Money context", async () => {
  await assert.rejects(run(m.upsertWbProjectTool, { status: "active" }, fakeDb()), /name is required/);
  const db = fakeDb(() => ({ data: { id: id(4), name: "ZZ P" }, error: null }));
  const r = await run(m.upsertWbProjectTool, { name: "ZZ P" }, db);
  assert.equal(r.created, true);
  assert.deepEqual(db.op("wb_projects", "insert")[0][1], { name: "ZZ P", context_id: MONEY });
  const dup = fakeDb(() => ({ data: null, error: { message: 'duplicate key value violates unique constraint "wb_projects_name_key"' } }));
  await assert.rejects(run(m.upsertWbProjectTool, { name: "ZZ P" }, dup), /A project with that name already exists\. Nothing was changed\./);
});

// ------------------------------------------------------------------ Step 8b

test("over_matched: a one-off in total, a recurring item per date", () => {
  const one = { id: id(1), amount: -100, interval_count: null };
  assert.equal(m.annotateItem(one, [{ planned_item_id: id(1), amount_applied: -100 }]).over_matched, false);
  assert.equal(m.annotateItem(one, [{ planned_item_id: id(1), amount_applied: -60 }, { planned_item_id: id(1), amount_applied: -50 }]).over_matched, true);
  const rec = { id: id(2), amount: -50, interval_count: 1, interval_unit: "month" };
  const two = [{ planned_item_id: id(2), occurrence_on: "2031-01-05", amount_applied: -50 },
               { planned_item_id: id(2), occurrence_on: "2031-02-05", amount_applied: -50 }];
  assert.equal(m.annotateItem(rec, two).over_matched, false);
  assert.equal(m.annotateItem(rec, [...two, { planned_item_id: id(2), occurrence_on: "2031-02-05", amount_applied: -1 }]).over_matched, true);
});

test("tolerance (A45): remaining is 0 and over_matched false within it, for a bill and for income", () => {
  const a = (amount, paid, tol = 1) => m.annotateItem({ id: id(1), amount, interval_count: null, amount_tolerance: tol },
    [{ planned_item_id: id(1), amount_applied: paid }]);
  assert.equal(a(-100, -99.5).remaining, 0);
  assert.equal(a(-100, -99).remaining, 0);
  assert.equal(a(-100, -98.99).remaining, -1.01);
  assert.equal(a(100, 99.01).remaining, 0);
  assert.equal(a(100, 98.99).remaining, 1.01);
  assert.equal(a(-100, -100.99).over_matched, false);
  assert.equal(a(-100, -101.01).over_matched, true);
  assert.equal(a(100, 101).over_matched, false);
  assert.equal(a(100, 101.5).over_matched, true);
  assert.equal(a(100, 99.99, 0).remaining, 0.01);
  const rec = { id: id(2), amount: 200, interval_count: 1, amount_tolerance: 2 };
  assert.equal(m.annotateItem(rec, [{ planned_item_id: id(2), occurrence_on: "2031-01-01", amount_applied: 201.99 }]).over_matched, false);
  assert.equal(m.annotateItem(rec, [{ planned_item_id: id(2), occurrence_on: "2031-01-01", amount_applied: 202.01 }]).over_matched, true);
});

test("create_wb_planned_match: an item covered within tolerance is already paid in full", async () => {
  const it = { ...item, amount_tolerance: 1 };
  const pay = { ...payment, amount: -5 };
  const db = matchDb({ item: it, splits: [{ id: id(6), transaction_id: id(5), amount: -5 }], payment: pay,
    matches: [{ id: id(70), planned_item_id: id(1), split_id: id(60), occurrence_on: null, amount_applied: -99.5, status: "confirmed" }] });
  await assert.rejects(m.createWbPlannedMatchTool.propose({ planned_item_id: id(1), transaction_id: id(5) }, { db }), /already paid in full/);
  const near = matchDb({ item: it, splits: [{ id: id(6), transaction_id: id(5), amount: -5 }], payment: pay,
    matches: [{ id: id(70), planned_item_id: id(1), split_id: id(60), occurrence_on: null, amount_applied: -97, status: "confirmed" }] });
  const p = await m.createWbPlannedMatchTool.propose({ planned_item_id: id(1), transaction_id: id(5), amount: 2.5 }, { db: near });
  assert.equal(p.would_mark_paid, true);
});

test("addMonths clamps to the month end, as Postgres does", () => {
  assert.equal(m.addMonths("2031-01-31", 1), "2031-02-28");
  assert.equal(m.addMonths("2031-01-31", 2), "2031-03-31");
  assert.equal(m.addMonths("2031-11-15", 3), "2032-02-15");
});

/** Projection rows: closing falls by 10 a day from 100. */
const projRows = (n, from = "2031-06-01") => Array.from({ length: n }, (_, i) => {
  const day = new Date(Date.parse(from + "T00:00:00Z") + i * 86400000).toISOString().slice(0, 10);
  return { day, closing: 100 - 10 * i };
});

test("what-if: with and without, difference, days_sooner, dates counted; writes nothing", async () => {
  const db = fakeDb(undefined, (fn) => fn === "wb_free_cash"
    ? { data: [{ free_cash: -20, safety_floor: 20, floor_missing: false }], error: null }
    : { data: projRows(10), error: null });
  const r = await run(m.getWbFreeCashTool, { what_if: [
    { name: "ZZ trip", amount: -30, date: "2031-06-03" },
    { amount: 5, date: "2031-05-20", interval_count: 1, interval_unit: "week" },
    { amount: -1, date: "2031-09-01" },
  ] }, db);
  assert.equal(writes(db).length, 0);
  assert.deepEqual(db.rpcs.map((x) => x[0]), ["wb_free_cash", "wb_cash_projection"]);
  const w = r.what_if;
  // Without: low 10 on the last day; first below 20 on day 10 (closing 10).
  assert.deepEqual(w.without, { free_cash: -10, low_balance: 10, low_on: "2031-06-10", first_below_floor_on: "2031-06-10" });
  // With: -30 from Jun 3, +5 on Jun 3 and Jun 10 (weekly from May 20, past dates not counted).
  assert.equal(w.with.low_balance, -10);
  assert.equal(w.with.first_below_floor_on, "2031-06-07");
  assert.equal(w.difference, -20);
  assert.equal(w.days_sooner, 3);
  assert.equal(w.days_sooner_at_least, false);
  assert.deepEqual(w.items.map((i) => [i.dates_counted, i.first_on, i.outside_horizon]),
    [[1, "2031-06-03", false], [2, "2031-06-03", false], [0, null, true]]);
  assert.equal(r.free_cash, -20);
  assert.equal("affordable" in w, false);
});

test("what-if: one side crossing counts to the day after the horizon, as a lower bound", async () => {
  const mk = () => fakeDb(undefined, (fn) => fn === "wb_free_cash"
    ? { data: [{ free_cash: 0, safety_floor: 5 }], error: null } : { data: projRows(10), error: null });
  // Without: lowest 10, never below 5. With -30 on Jun 8: first below on Jun 8; the horizon ends Jun 10.
  const out = (await run(m.getWbFreeCashTool, { what_if: [{ amount: -30, date: "2031-06-08" }] }, mk())).what_if;
  assert.deepEqual([out.without.first_below_floor_on, out.with.first_below_floor_on, out.days_sooner, out.days_sooner_at_least],
    [null, "2031-06-08", 3, true]);
  // Neither side crosses: null.
  const none = (await run(m.getWbFreeCashTool, { what_if: [{ amount: 30, date: "2031-06-08" }] }, mk())).what_if;
  assert.deepEqual([none.days_sooner, none.days_sooner_at_least], [null, false]);
});

test("what-if: a past one-off counts today; inputs checked", async () => {
  const db = fakeDb(undefined, (fn) => fn === "wb_free_cash"
    ? { data: [{ free_cash: 0, safety_floor: 0 }], error: null } : { data: projRows(3), error: null });
  const r = await run(m.getWbFreeCashTool, { what_if: [{ amount: -5, date: "2031-01-01" }] }, db);
  assert.equal(r.what_if.items[0].first_on, "2031-06-01");
  assert.equal(r.what_if.with.low_balance, 75);
  const T = (a) => run(m.getWbFreeCashTool, { what_if: a }, fakeDb());
  await assert.rejects(T([]), /1 to 10/);
  await assert.rejects(T(Array(11).fill({ amount: -1, date: "2031-01-01" })), /at most 10/);
  await assert.rejects(T([{ amount: 0, date: "2031-01-01" }]), /non-zero/);
  await assert.rejects(T([{ amount: -1 }]), /date is required/);
  await assert.rejects(T([{ amount: -1, date: "2031-01-01", interval_count: 1 }]), /both interval_count and interval_unit/);
});

test("upsert_wb_planned_item backdates a new repeating item with a merchant, unless backdate: false", async () => {
  const mk = (first) => fakeDb((t, ops) => has(ops, "insert")
    ? { data: { id: id(9), ...ops.find((o) => o[0] === "insert")[1] }, error: null } : { data: [], error: null },
  (fn) => fn === "wb_planned_start_from_history" ? { data: first, error: null } : { data: {}, error: null });
  const args = { name: "ZZ premium", amount: -50, due_on: "2031-06-05", interval_count: 1, interval_unit: "month", merchant_id: id(3) };
  const db = mk("2031-03-05");
  const r = await run(m.upsertWbPlannedItemTool, args, db);
  assert.deepEqual(db.rpcs[0], ["wb_planned_start_from_history", { p_merchant_id: id(3), p_amount: -50, p_amount_tolerance: 0 }]);
  assert.equal(db.op("wb_planned_items", "insert")[0][1].due_on, "2031-03-05");
  assert.equal(r.backdated_from, "2031-06-05");
  const later = await run(m.upsertWbPlannedItemTool, args, mk("2031-07-01"));
  assert.equal(later.backdated_from, null);
  const off = mk("2031-03-05");
  const o = await run(m.upsertWbPlannedItemTool, { ...args, backdate: false }, off);
  assert.equal(o.backdated_from, null);
  assert.equal(off.rpcs.some((x) => x[0] === "wb_planned_start_from_history"), false);
  const noMerchant = mk("2031-03-05");
  await run(m.upsertWbPlannedItemTool, { ...args, merchant_id: undefined }, noMerchant);
  assert.equal(noMerchant.rpcs.some((x) => x[0] === "wb_planned_start_from_history"), false);
});

test("project summary and missed dates read their views, bounded", async () => {
  const db = fakeDb(() => ({ data: [{ project_id: id(1) }], error: null, count: 1 }));
  const s = await run(m.getWbProjectSummaryTool, { status: "active", limit: 99 }, db);
  assert.equal(db.log[0].table, "wb_project_summary");
  assert.deepEqual(db.op("wb_project_summary", "limit")[0], ["limit", 50]);
  assert.equal(s.data.length, 1);
  const d = fakeDb(() => ({ data: [], error: null, count: 0 }));
  await run(m.getWbMissedDatesTool, { include_within_window: false }, d);
  assert.equal(d.log[0].table, "wb_planned_unmatched");
  assert.deepEqual(d.op("wb_planned_unmatched", "eq")[0], ["eq", "within_window", false]);
});

test("mark not needed: checked first, all or nothing; undo deletes", async () => {
  const items = [{ id: id(1), name: "ZZ premium", interval_count: 1 }, { id: id(2), name: "ZZ bill", interval_count: null }];
  const mk = (skips = [], missed = []) => fakeDb((t, ops) => {
    if (t === "wb_planned_items") return { data: items, error: null };
    if (t === "wb_planned_skips") return has(ops, "insert") || has(ops, "delete") ? { data: null, error: null } : { data: skips, error: null };
    if (t === "wb_planned_unmatched") return { data: missed, error: null };
    return { data: [], error: null };
  });
  const T = m.markWbMissedDatesNotNeededTool;
  await assert.rejects(run(T, { dates: [{ planned_item_id: id(1) }] }, mk()), /repeats, so pass occurrence_on/);
  await assert.rejects(run(T, { dates: [{ planned_item_id: id(2), occurrence_on: "2031-01-01" }] }, mk()), /one-off/);
  await assert.rejects(run(T, { dates: Array(26).fill({ planned_item_id: id(2) }) }, mk()), /at most 25/);
  const notMissed = mk([], [{ planned_item_id: id(2), occurrence_on: null }]);
  await assert.rejects(run(T, { dates: [{ planned_item_id: id(2) }, { planned_item_id: id(1), occurrence_on: "2031-02-05" }] }, notMissed),
    /ZZ premium on 2031-02-05 is not a missed date/);
  assert.equal(writes(notMissed).length, 0);

  const ok = mk([{ id: id(8), planned_item_id: id(2), occurrence_on: null }],
    [{ planned_item_id: id(1), occurrence_on: "2031-02-05" }]);
  const r = await run(T, { dates: [{ planned_item_id: id(2) }, { planned_item_id: id(1), occurrence_on: "2031-02-05", reason: "ZZ before sync" }] }, ok);
  assert.deepEqual(ok.op("wb_planned_skips", "insert")[0][1],
    [{ planned_item_id: id(1), occurrence_on: "2031-02-05", reason: "ZZ before sync", context_id: MONEY }]);
  assert.equal(r.marked.length, 1);
  assert.equal(r.already_marked[0].name, "ZZ bill");

  const u = mk([{ id: id(8), planned_item_id: id(2), occurrence_on: null }]);
  const ur = await run(T, { undo: true, dates: [{ planned_item_id: id(2) }, { planned_item_id: id(1), occurrence_on: "2031-02-05" }] }, u);
  assert.deepEqual(u.op("wb_planned_skips", "delete").length, 1);
  assert.deepEqual(u.op("wb_planned_skips", "in").at(-1), ["in", "id", [id(8)]]);
  assert.equal(ur.undone.length, 1);
  assert.equal(ur.not_marked.length, 1);
});

test("unconfirm: confirmed only; the hint when paid_not_covered; never writes the stage", async () => {
  const mk = (status, res) => fakeDb(() => ({ data: { id: id(5), status, planned_item: { name: "ZZ invoice" } }, error: null }),
    () => ({ data: res, error: null }));
  await assert.rejects(run(m.unconfirmWbPlannedMatchTool, { match_id: id(5) }, mk("suggested")), /is suggested, not confirmed.*Nothing was changed/);
  const db = mk("confirmed", { status: "rejected", stage: "paid", confirmed_total: 0, paid_not_covered: true });
  const r = await run(m.unconfirmWbPlannedMatchTool, { match_id: id(5) }, db);
  assert.deepEqual(db.rpcs[0], ["wb_unconfirm_planned_match", { p_match_id: id(5) }]);
  assert.equal(writes(db).length, 0);
  assert.match(r.hint, /set it back to invoiced/);
  assert.equal(r.planned_item_name, "ZZ invoice");
  const rec = await run(m.unconfirmWbPlannedMatchTool, { match_id: id(5) },
    mk("confirmed", { status: "rejected", stage: null, paid_not_covered: false }));
  assert.equal("hint" in rec, false);
});

// --- get_wb_action_items ----------------------------------------------------

test("get_wb_action_items passes only the args given and returns the object bare", async () => {
  const obj = { today: "2031-06-20", flags: [], below_floor: { floor_missing: true } };
  const db = fakeDb(undefined, () => ({ data: obj, error: null }));
  assert.deepEqual(await run(m.getWbActionItemsTool, {}, db), obj);
  await run(m.getWbActionItemsTool, { days: 30, big_amount: 2500.5, big_days: 90 }, db);
  assert.deepEqual(db.rpcs, [
    ["wb_action_items", {}],
    ["wb_action_items", { p_days: 30, p_big_amount: 2500.5, p_big_days: 90 }],
  ]);
  assert.equal(writes(db).length, 0);
});

test("get_wb_action_items refusals and errors", async () => {
  const db = fakeDb();
  await assert.rejects(run(m.getWbActionItemsTool, { days: 0 }, db), /days must be a whole number from 1 to 90/);
  await assert.rejects(run(m.getWbActionItemsTool, { big_amount: -5 }, db), /big_amount must be a positive number/);
  await assert.rejects(run(m.getWbActionItemsTool, { big_days: 400 }, db), /big_days must be a whole number from 1 to 366/);
  assert.equal(db.rpcs.length, 0);
  const bad = fakeDb(undefined, () => ({ data: null, error: { message: "timeout" } }));
  const err = await run(m.getWbActionItemsTool, {}, bad).catch((e) => e.message);
  assert.match(err, /could not read the action items: timeout/);
  assert.doesNotMatch(err, /retry/i);
});
