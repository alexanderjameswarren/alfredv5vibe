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
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "wb-p3-"));
writeFileSync(join(dir, "platform.ts"), `
export const defineTool = (o) => o;
export const clampLimit = (n) => Math.min(n ?? 20, 50);
export const envelope = (data, meta = {}) => ({ data, meta });
export const describeDbError = (name, e) => name + " failed: " + e.message;
`);
const IMPORT = 'from "../platform.ts";';
for (const f of ["warren-buffet.ts", "warren-buffet-p2.ts", "warren-buffet-p3.ts"]) {
  const src = readFileSync(join(HERE, f), "utf-8");
  if (!src.includes(IMPORT)) throw new Error(`${f} import line changed — update this test.`);
  writeFileSync(join(dir, f), src.replace(IMPORT, 'from "./platform.ts";'));
}
const m = await import(pathToFileURL(join(dir, "warren-buffet-p3.ts")).href);

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
  return {
    log, rpcs, from,
    rpc: (fn, params) => { rpcs.push([fn, params]); return Promise.resolve(rpc(fn, params)); },
    op: (table, name) => log.filter((q) => q.table === table).flatMap((q) => q.ops).filter((o) => o[0] === name),
  };
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
  assert.deepEqual(db.op("wb_planned_items", "limit")[0], ["limit", 50]);
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
