// Handler tests for warren-buffet-p2.ts.
//
// Run:
//   node --test supabase/functions/_shared/tools/warren-buffet-p2.test.mjs
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
const dir = mkdtempSync(join(tmpdir(), "wb-p2-"));
writeFileSync(join(dir, "platform.ts"), `
export const defineTool = (o) => o;
export const clampLimit = (n) => Math.min(n ?? 20, 50);
export const envelope = (data, meta = {}) => ({ data, meta });
export const describeDbError = (name, e) => name + " failed: " + e.message;
`);
const IMPORT = 'from "../platform.ts";';
for (const f of ["warren-buffet.ts", "warren-buffet-p2.ts"]) {
  const src = readFileSync(join(HERE, f), "utf-8");
  if (!src.includes(IMPORT)) throw new Error(`${f} import line changed — update this test.`);
  writeFileSync(join(dir, f), src.replace(IMPORT, 'from "./platform.ts";'));
}
const m = await import(pathToFileURL(join(dir, "warren-buffet-p2.ts")).href);

const MONEY = "muvitejhrgt3rgi8t6q";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Fake ctx.db: from() builders log their ops; rpc() logs its params. */
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
const writes = (db) => db.log.filter((q) => has(q.ops, "insert") || has(q.ops, "update"));

// --- pure helpers ----------------------------------------------------------

test("parseMatch keeps known keys and checks their types", () => {
  assert.deepEqual(m.parseMatch("t", { merchant_id: id(1), amount_min: 10, kind: "spend" }),
    { merchant_id: id(1), amount_min: 10, kind: "spend" });
  assert.deepEqual(m.parseMatch("t", { payee_contains: "  corner ", account_ids: [id(2), id(2)] }),
    { payee_contains: "corner", account_ids: [id(2)] });
  assert.throws(() => m.parseMatch("t", {}), /at least one/);
  assert.throws(() => m.parseMatch("t", { payee: "x" }), /unknown key/);
  assert.throws(() => m.parseMatch("t", { amount_min: -5 }), /absolute amount/);
  assert.throws(() => m.parseMatch("t", { amount_min: 9, amount_max: 3 }), /greater than/);
  assert.throws(() => m.parseMatch("t", { merchant_id: "abc" }), /uuid/);
});

test("parsePatterns lower-cases, dedupes and refuses short patterns", () => {
  assert.deepEqual(m.parsePatterns("t", ["Corner  Coffee", "corner coffee", "CAFE"]), ["corner coffee", "cafe"]);
  assert.throws(() => m.parsePatterns("t", ["ab"]), /at least 3/);
  assert.throws(() => m.parsePatterns("t", []), /non-empty/);
});

test("idList dedupes, caps and checks ids", () => {
  assert.deepEqual(m.idList("t", "ids", [id(1), id(1), id(2)], 25), [id(1), id(2)]);
  assert.throws(() => m.idList("t", "ids", [], 25), /non-empty/);
  assert.throws(() => m.idList("t", "ids", Array.from({ length: 26 }, (_, i) => id(i)), 25), /at most 25/);
  assert.throws(() => m.idList("t", "ids", ["nope"], 25), /uuid/);
});

test("parseMonth wants YYYY-MM", () => {
  assert.equal(m.parseMonth("t", "m", "2026-03"), "2026-03-01");
  assert.equal(m.parseMonth("t", "m", undefined), null);
  assert.throws(() => m.parseMonth("t", "m", "2026-13"), /YYYY-MM/);
});

test("buildTagTree nests children under parents and counts usage", () => {
  const groups = [{ id: "g1", name: "Category", exclusive: true, required_for_kinds: ["spend"] }];
  const tags = [
    { id: "t1", group_id: "g1", parent_id: null, name: "Food", is_active: true, sort_order: 0 },
    { id: "t2", group_id: "g1", parent_id: "t1", name: "Coffee", is_active: true, sort_order: 0 },
  ];
  const [g] = m.buildTagTree(groups, tags, new Map([["t2", 3]]));
  assert.equal(g.tags.length, 1);
  assert.equal(g.tags[0].children[0].name, "Coffee");
  assert.equal(g.tags[0].children[0].usage, 3);
  assert.equal(g.tags[0].usage, 0);
});

// --- reads -----------------------------------------------------------------

test("get_wb_review_queue counts every reason and filters the page before the limit", async () => {
  const db = fakeDb((t, ops) => has(ops, "order")
    ? { data: [{ reason: "transfer_candidate" }], error: null, count: 1 }
    : { data: [{ reason: "no_kind" }, { reason: "no_kind" }, { reason: "transfer_candidate" }], error: null });
  const out = await m.getWbReviewQueueTool.handler({ reason: "transfer_candidate", from: "2026-01-01" }, { db });
  assert.deepEqual(out.data.counts, { no_kind: 2, transfer_candidate: 1 });
  const page = db.log[1].ops;
  assert.deepEqual(page.find((o) => o[0] === "eq"), ["eq", "reason", "transfer_candidate"]);
  assert.ok(page.findIndex((o) => o[0] === "limit") > page.findIndex((o) => o[0] === "gte"));
  await assert.rejects(m.getWbReviewQueueTool.handler({ reason: "other" }, { db }), /reason must be one of/);
});

test("get_wb_spending defaults to Category at top level", async () => {
  const db = fakeDb();
  await m.getWbSpendingTool.handler({ from_month: "2026-01" }, { db });
  const ops = db.log[0].ops;
  assert.deepEqual(ops.find((o) => o[0] === "ilike"), ["ilike", "group_name", "Category"]);
  assert.deepEqual(ops.find((o) => o[0] === "eq"), ["eq", "level", "top"]);
  assert.deepEqual(ops.find((o) => o[0] === "gte"), ["gte", "month", "2026-01-01"]);
});

// --- writes ----------------------------------------------------------------

test("tag_wb_transactions caps at 25 rows and calls wb_apply_tags once", async () => {
  const db = fakeDb();
  await assert.rejects(
    m.tagWbTransactionsTool.handler({ transaction_ids: Array.from({ length: 26 }, (_, i) => id(i)), tag_ids: [id(99)] }, { db }),
    /at most 25/);
  assert.equal(db.rpcs.length, 0);
  await m.tagWbTransactionsTool.handler({ transaction_ids: [id(1)], tag_ids: [id(9)] }, { db });
  assert.deepEqual(db.rpcs, [["wb_apply_tags", {
    p_transaction_ids: [id(1)], p_tag_ids: [id(9)], p_source: "claude", p_remove_tag_ids: [],
  }]]);
  await assert.rejects(m.tagWbTransactionsTool.handler({ transaction_ids: [id(1)] }, { db }), /tag_ids and\/or remove_tag_ids/);
});

test("set_wb_transaction_kind refuses a kind change on a paired row, and pairs one row only", async () => {
  const paired = fakeDb((t) => t === "wb_transactions"
    ? { data: [{ id: id(1), transfer_pair_id: id(2) }], error: null } : { data: [], error: null });
  await assert.rejects(m.setWbTransactionKindTool.handler({ transaction_ids: [id(1)], kind: "spend" }, { db: paired }), /unpair: true/);
  assert.equal(writes(paired).length, 0);
  await assert.rejects(
    m.setWbTransactionKindTool.handler({ transaction_ids: [id(1), id(2)], pair_with: id(3) }, { db: fakeDb() }), /exactly one/);
});

test("set_wb_transaction_kind writes the hand source and reprocesses", async () => {
  const db = fakeDb((t) => t === "wb_transactions" ? { data: [{ id: id(1), transfer_pair_id: null }], error: null } : { data: [], error: null });
  await m.setWbTransactionKindTool.handler({ transaction_ids: [id(1)], kind: "fee", source: "manual" }, { db });
  assert.deepEqual(db.op("wb_transactions", "update")[0][1], { kind: "fee", kind_source: "manual" });
  assert.deepEqual(db.rpcs.map((r) => r[0]), ["wb_process_transactions"]);
});

test("split_wb_transaction sends cents and tags to wb_replace_splits", async () => {
  const db = fakeDb();
  await m.splitWbTransactionTool.handler({
    transaction_id: id(1),
    splits: [{ amount: -40.004, tag_ids: [id(7)] }, { amount: -20, description: "treats", tax_year: 2026 }],
  }, { db });
  const [fn, p] = db.rpcs[0];
  assert.equal(fn, "wb_replace_splits");
  assert.deepEqual(p.p_splits, [
    { amount: -40, description: null, tax_year: null, notes: null, tag_ids: [id(7)] },
    { amount: -20, description: "treats", tax_year: 2026, notes: null, tag_ids: [] },
  ]);
  await assert.rejects(m.splitWbTransactionTool.handler({ transaction_id: id(1), splits: [{}] }, { db }), /needs an amount/);
});

test("a split that does not add up is refused in plain words, without the amounts", async () => {
  const raw = { code: "23514", message: "wb_replace_splits: splits sum to -57.31, but the transaction is -61.47" };
  const db = fakeDb(undefined, () => ({ data: null, error: raw }));
  const err = await m.splitWbTransactionTool.handler({
    transaction_id: id(1), splits: [{ amount: -40.31 }, { amount: -17 }],
  }, { db }).then(() => null, (e) => e);
  assert.match(err.message, /Split amounts must add up to the transaction amount/);
  for (const digits of ["57", "31", "61", "47", "40", "17", "23514"]) assert.ok(!err.message.includes(digits), digits);
  assert.ok(!/wb_replace_splits/.test(err.message));
});

test("known database refusals become plain sentences; unknown errors pass through as operational", () => {
  assert.equal(m.dbError("t", { message: "wb_splits: the 2 split(s) of transaction x sum to -5.00, not its amount -6.00" }),
    "t: Split amounts must add up to the transaction amount. Nothing was changed.");
  assert.match(m.dbError("t", { message: "wb_set_transfer_pair: both rows are on the same account" }), /two different accounts/);
  assert.match(m.dbError("t", { message: 'duplicate key value violates unique constraint "wb_merchants_name_key"' }), /merchant with that name/);
  assert.match(m.dbError("t", { message: "wb_apply_tags: two tags from one exclusive group", code: "23505" }), /only one tag/);
  // Unknown: handed to the platform's describeDbError (stubbed here).
  assert.equal(m.dbError("t", { message: "connection reset", code: "08006" }), "t failed: connection reset");
});

test("create_wb_rule needs an action, writes created_by claude, and warns without a merchant", async () => {
  const db = fakeDb(
    (t, ops) => t === "wb_rules" && has(ops, "insert")
      ? { data: { id: id(5), match: { payee_contains: "corner" }, add_tag_ids: [] }, error: null }
      : { data: [], error: null },
    () => ({ data: { count: 2, too_narrow: false, samples: [], ids: [id(1), id(2)] }, error: null }),
  );
  await assert.rejects(m.createWbRuleTool.handler({ name: "x", match: { payee_contains: "corner" } }, { db }), /needs set_kind/);
  const out = await m.createWbRuleTool.handler({ name: "Corner", match: { payee_contains: "corner" }, set_kind: "spend" }, { db });
  const row = db.op("wb_rules", "insert")[0][1];
  assert.equal(row.created_by, "claude");
  assert.equal(row.context_id, MONEY);
  assert.match(out.warning, /merchant/);
  assert.deepEqual(db.rpcs.map((r) => r[0]), ["wb_rule_preview", "wb_process_transactions"]);
});

test("reprocess_wb_transactions needs ids or dates, and runs in chunks of 100", async () => {
  const db = fakeDb(undefined, () => ({ data: { processed: 100 }, error: null }));
  await assert.rejects(m.reprocessWbTransactionsTool.handler({}, { db }), /transaction_ids, or a from\/to/);
  const ids = Array.from({ length: 250 }, (_, i) => id(i));
  const out = await m.reprocessWbTransactionsTool.handler({ transaction_ids: ids }, { db });
  assert.equal(db.rpcs.length, 3);
  assert.equal(db.rpcs[2][1].ids.length, 50);
  assert.equal(out.processed, 300);
});

test("mark_wb_reviewed reports ids it could not see", async () => {
  const db = fakeDb(() => ({ data: [{ id: id(1) }], error: null }));
  const out = await m.markWbReviewedTool.handler({ transaction_ids: [id(1), id(2)] }, { db });
  assert.deepEqual(out, { reviewed: true, updated: 1, not_found: [id(2)] });
});

// --- "Always do this" (spec §6.1) ------------------------------------------

// The plan and the write run in the database (wb_fix_plan, wb_apply_fix, migration
// 117), shared with the Money app; the tool only validates, calls and describes.
const PLAN = {
  transaction: { id: id(1) }, pattern: "corner",
  merchant: { id: null, name: "Corner", exists: false, add_pattern: "corner" },
  rule_match: { merchant_id: "(the new merchant)" },
  dry_run: { count: 1, too_narrow: true, samples: [] }, existing_rules: [],
  warnings: ["This would catch only 1 past transaction(s): probably too narrow. Try a shorter pattern."], ids: [id(1)],
};

function fixDb({ plan = PLAN, apply = null, applyError = null } = {}) {
  return fakeDb(
    (t) => (t === "wb_rules"
      ? { data: { id: id(60), match: { merchant_id: id(50) }, add_tag_ids: [id(7)] }, error: null }
      : { data: [], error: null }),
    (fn) => {
      if (fn === "wb_fix_plan") return { data: plan, error: null };
      if (fn === "wb_apply_fix") {
        return applyError ? { data: null, error: applyError }
          : { data: apply ?? { merchant_id: id(50), merchant_created: true, rule_id: id(60), rule_updated: false,
            matched_now: 3, reprocessed: { processed: 3 } }, error: null };
      }
      return { data: {}, error: null };
    },
  );
}

test("the fix proposal comes from wb_fix_plan and writes nothing", async () => {
  const db = fixDb();
  const out = await m.createWbRuleFromTransactionTool.propose({ transaction_id: id(1), set_kind: "spend", pattern: "Corner" }, { db });
  assert.deepEqual(db.rpcs[0], ["wb_fix_plan", { p_transaction_id: id(1), p_pattern: "corner", p_merchant_name: null }]);
  assert.equal(out.merchant.name, "Corner");
  assert.match(out.warnings[0], /too narrow/);
  assert.equal(out.steps.length, 3);
  assert.ok(!("ids" in out));
  assert.equal(writes(db).length, 0, "a proposal never writes");
  assert.equal(db.rpcs.length, 1);
});

test("an existing rule's warning names the tool's parameters", async () => {
  const db = fixDb({ plan: { ...PLAN, existing_rules: [{ id: id(60), add_tag_ids: [] }],
    warnings: ["A rule already exists for Corner: update it instead of adding another."] } });
  const out = await m.getWbRulePreviewTool.handler({ transaction_id: id(1) }, { db });
  assert.match(out.warnings[0], /pass update_rule_id to update it \(preferred\), or add_new_rule: true/i);
  assert.equal(out.existing_rules[0].id, id(60));
});

test("the confirmed fix calls wb_apply_fix as claude and returns the described rule", async () => {
  const db = fixDb();
  const out = await m.createWbRuleFromTransactionTool.handler(
    { transaction_id: id(1), pattern: "Corner Coffee", add_tag_ids: [id(7)], update_rule_id: id(60), confirmed: true }, { db });
  assert.deepEqual(db.rpcs[0], ["wb_apply_fix", {
    p_transaction_id: id(1), p_set_kind: null, p_add_tag_ids: [id(7)], p_pattern: "corner coffee", p_merchant_name: null,
    p_update_rule_id: id(60), p_add_new_rule: false, p_notes: null, p_created_by: "claude",
  }]);
  assert.equal(out.merchant_id, id(50));
  assert.equal(out.rule.id, id(60));
  assert.equal(out.matched_now, 3);
  assert.equal(writes(db).length, 0, "the database function does the writing");
  await assert.rejects(m.createWbRuleFromTransactionTool.handler({ transaction_id: id(1), confirmed: true }, { db }), /set_kind and\/or add_tag_ids/);
});

// --- subscriptions (Step 7) -------------------------------------------------

const SUB = { id: id(70), name: "ZZ Stream", status: "watching", merchant_id: id(50), merchant_name: "ZZ Stream" };

/** Subscriptions fake: the overview answers with `sub`; transactions with `txn`. */
function subDb({ sub = SUB, txn = null, prices = [] } = {}) {
  return fakeDb((table, ops) => {
    if (table === "wb_subscription_overview") {
      return has(ops, "maybeSingle") ? { data: sub, error: null } : { data: [sub], error: null, count: 1 };
    }
    if (table === "wb_subscription_prices") {
      return has(ops, "single") ? { data: { id: id(80), amount: 6 }, error: null } : { data: prices, error: null };
    }
    if (table === "wb_transaction_list") return { data: txn, error: null };
    if (table === "wb_subscriptions" && has(ops, "single")) return { data: { id: id(71) }, error: null };
    if (table === "wb_transactions") return { data: [{ id: id(1) }, { id: id(2) }], error: null };
    return { data: null, error: null };
  }, (fn) => ({ data: fn === "wb_process_transactions" ? { processed: 2, subscriptions_linked: 1 } : {}, error: null }));
}

test("get_wb_subscriptions filters and attaches price history on request", async () => {
  const db = subDb({ prices: [{ subscription_id: id(70), effective_on: "2026-09-01", amount: 6 }] });
  const out = await m.getWbSubscriptionsTool.handler({ status: "watching", overdue_only: true, include_prices: true }, { db });
  const ops = db.log.find((q) => q.table === "wb_subscription_overview").ops;
  assert.deepEqual(ops.filter((o) => o[0] === "eq"), [["eq", "status", "watching"], ["eq", "overdue", true]]);
  assert.equal(out.data[0].prices.length, 1);
  await assert.rejects(m.getWbSubscriptionsTool.handler({ status: "gone" }, { db }), /status must be one of/);
});

test("upsert_wb_subscription creates as active in the Money context, then reprocesses the merchant", async () => {
  const db = subDb();
  const out = await m.upsertWbSubscriptionTool.handler(
    { name: "ZZ Stream", merchant_id: id(50), cadence: "annual", expected_amount: 60, amount_tolerance: 0.5 }, { db });
  const [, row] = db.op("wb_subscriptions", "insert")[0];
  assert.deepEqual(row, { context_id: MONEY, status: "active", name: "ZZ Stream", merchant_id: id(50), cadence: "annual",
    expected_amount: 60, amount_tolerance: 0.5 });
  assert.deepEqual(db.rpcs[0], ["wb_process_transactions", { ids: [id(1), id(2)] }]);
  assert.equal(out.created, true);
  assert.equal(out.reprocessed.subscriptions_linked, 1);
  await assert.rejects(m.upsertWbSubscriptionTool.handler({ plan: "x" }, { db }), /needs a name/);
  await assert.rejects(m.upsertWbSubscriptionTool.handler({ name: "x", expected_amount: -5 }, { db }), /positive price/);
});

test("not_subscription dismisses only a watching row: merchant flagged, row deleted", async () => {
  const db = subDb();
  const out = await m.upsertWbSubscriptionTool.handler({ id: id(70), not_subscription: true }, { db });
  assert.deepEqual(db.op("wb_merchants", "update")[0], ["update", { not_subscription: true }]);
  assert.equal(db.op("wb_subscriptions", "delete").length, 1);
  assert.equal(out.dismissed, true);
  const active = subDb({ sub: { ...SUB, status: "active" } });
  await assert.rejects(m.upsertWbSubscriptionTool.handler({ id: id(70), not_subscription: true }, { db: active }),
    /only a watching/);
  assert.equal(writes(active).length, 0);
});

test("record_wb_subscription_price uses the charge's date and links the charge by hand", async () => {
  const db = subDb({ txn: { id: id(1), txn_date: "2026-10-01", subscription_id: null } });
  const out = await m.recordWbSubscriptionPriceTool.handler(
    { subscription_id: id(70), amount: 6, transaction_id: id(1) }, { db });
  const [, row, opts] = db.op("wb_subscription_prices", "upsert")[0];
  assert.deepEqual(row, { subscription_id: id(70), effective_on: "2026-10-01", amount: 6, source: "claude",
    transaction_id: id(1), notes: null });
  assert.deepEqual(opts, { onConflict: "subscription_id,effective_on" });
  assert.deepEqual(db.rpcs[0], ["wb_link_subscription",
    { p_transaction_ids: [id(1)], p_subscription_id: id(70), p_source: "claude" }]);
  assert.equal(out.linked, true);
  await assert.rejects(m.recordWbSubscriptionPriceTool.handler({ subscription_id: id(70), amount: 6 }, { db }), /pass effective_on/);
  await assert.rejects(m.recordWbSubscriptionPriceTool.handler({ subscription_id: id(70), amount: 0, effective_on: "2026-10-01" }, { db }),
    /positive price/);
});

test("an interval of every 2 months makes cadence other, and the dates are refreshed", async () => {
  const db = subDb();
  await m.upsertWbSubscriptionTool.handler({ id: id(70), interval_count: 2, interval_unit: "month" }, { db });
  assert.deepEqual(db.op("wb_subscriptions", "update")[0], ["update", { cadence: "other", interval_count: 2, interval_unit: "month" }]);
  assert.deepEqual(db.rpcs.at(-1), ["wb_refresh_subscriptions", { p_ids: [id(70)] }]);
});

test("a named cadence's own interval keeps its name; a clash or half a pair is refused", async () => {
  const db = subDb();
  await m.upsertWbSubscriptionTool.handler({ id: id(70), interval_count: 3, interval_unit: "month", reprocess: false }, { db });
  assert.equal(db.op("wb_subscriptions", "update")[0][1].cadence, "quarterly");
  await assert.rejects(m.upsertWbSubscriptionTool.handler(
    { id: id(70), cadence: "monthly", interval_count: 2, interval_unit: "week" }, { db }), /fixed interval; for every 2 week/);
  await assert.rejects(m.upsertWbSubscriptionTool.handler({ id: id(70), interval_count: 2 }, { db }), /together/);
  await assert.rejects(m.upsertWbSubscriptionTool.handler({ id: id(70), interval_count: 0, interval_unit: "week" }, { db }),
    /from 1 to 104/);
});

test("set_wb_transaction_subscription links or unlinks by hand through wb_link_subscription", async () => {
  const db = subDb();
  await m.setWbTransactionSubscriptionTool.handler({ transaction_ids: [id(1), id(1)], unlink: true }, { db });
  assert.deepEqual(db.rpcs[0], ["wb_link_subscription", { p_transaction_ids: [id(1)], p_subscription_id: null, p_source: "manual" }]);
  const out = await m.setWbTransactionSubscriptionTool.handler({ transaction_ids: [id(2)], subscription_id: id(70) }, { db });
  assert.deepEqual(db.rpcs[1][1].p_subscription_id, id(70));
  assert.equal(out.subscription.id, id(70));
  await assert.rejects(m.setWbTransactionSubscriptionTool.handler({ transaction_ids: [id(1)] }, { db }), /not both/);
  await assert.rejects(m.setWbTransactionSubscriptionTool.handler(
    { transaction_ids: [id(1)], subscription_id: id(70), unlink: true }, { db }), /not both/);
  const many = Array.from({ length: 26 }, (_, i) => id(100 + i));
  await assert.rejects(m.setWbTransactionSubscriptionTool.handler({ transaction_ids: many, unlink: true }, { db }), /at most 25/);
});

test("subscription database refusals are plain sentences", () => {
  assert.match(m.dbError("t", { message: 'violates check constraint "wb_subscriptions_interval_check"' }),
    /fixed intervals; for any other interval use cadence other/);
  assert.equal(m.dbError("t", { message: 'violates check constraint "wb_subscriptions_bundle_check"' }),
    "t: A subscription cannot be billed through or bundled with itself. Nothing was changed.");
  assert.ok(m.REVIEW_REASONS.includes("price_change") && m.REVIEW_REASONS.includes("new_recurring"));
});

test("a second rule without a choice is refused in plain words", async () => {
  const db = fixDb({ applyError: { message: "wb_apply_fix: a rule already exists for Corner; update it or add another", code: "23505" } });
  const err = await m.createWbRuleFromTransactionTool.handler({ transaction_id: id(1), set_kind: "spend", confirmed: true }, { db })
    .then(() => null, (e) => e);
  assert.equal(err.message,
    "create_wb_rule_from_transaction: A rule already exists for this merchant: pass update_rule_id to update it (preferred), or add_new_rule: true. Nothing was changed.");
});

// --- rule health and bulk create (Step 10) ----------------------------------

const HEALTH_ALL = [
  { finding: "too_broad", acknowledged: false }, { finding: "never_fires", acknowledged: false },
  { finding: "never_fires", acknowledged: false }, { finding: "often_overridden", acknowledged: true },
];
function healthDb(rows) {
  return fakeDb((table, ops) => (has(ops, "maybeSingle") ? { data: rows[0] ?? null, error: null }
    : has(ops, "limit") && !has(ops, "order") ? { data: HEALTH_ALL, error: null }
    : { data: rows, error: null, count: rows.length }));
}

test("get_wb_rule_health returns counts by finding and items in the payload, acknowledged ones hidden", async () => {
  const db = healthDb([{ finding: "too_broad", merchant_name: "ZZ Shop", n: 3 }]);
  const out = await m.getWbRuleHealthTool.handler({ finding: "too_broad" }, { db });
  assert.deepEqual(db.op("wb_rule_health", "eq")[0], ["eq", "finding", "too_broad"]);
  assert.equal(out.data.items.length, 1);
  assert.deepEqual(out.data.counts_by_finding, { too_broad: 1, never_fires: 2 });
  assert.equal(out.data.acknowledged_hidden, 1);
  await assert.rejects(m.getWbRuleHealthTool.handler({ finding: "broken" }, { db }), /finding must be one of/);
});

test("get_wb_rule_health can include acknowledged findings, with their reason", async () => {
  const db = healthDb([]);
  const out = await m.getWbRuleHealthTool.handler({ include_acknowledged: true }, { db });
  assert.equal(db.log.filter((q) => q.table === "wb_rule_health").length, 0);
  assert.match(db.log.find((q) => q.table === "wb_rule_health_all").ops.find((o) => o[0] === "select")[1], /ack_reason/);
  assert.deepEqual(out.data.counts_by_finding, { too_broad: 1, never_fires: 2, often_overridden: 1 });
  assert.equal(out.data.acknowledged_hidden, 0);
});

test("acknowledge_wb_rule_health stores the current n and reason for a rule finding", async () => {
  const db = healthDb([{ finding: "often_overridden", n: 4, rule_name: "ZZ ATM", merchant_name: null }]);
  const out = await m.acknowledgeWbRuleHealthTool.handler(
    { finding: "often_overridden", rule_id: id(60), reason: "Gardener re-split, on purpose" }, { db });
  const [, row, opts] = db.op("wb_rule_health_acks", "upsert")[0];
  assert.deepEqual(row, { context_id: MONEY, finding: "often_overridden", subject_id: id(60), acked_n: 4, reason: "Gardener re-split, on purpose" });
  assert.deepEqual(opts, { onConflict: "context_id,finding,subject_id" });
  assert.equal(out.acknowledged_at_n, 4);
});

test("acknowledge_wb_rule_health checks the subject, the reason and that the finding exists", async () => {
  const db = healthDb([]);
  await assert.rejects(m.acknowledgeWbRuleHealthTool.handler({ finding: "often_overridden", merchant_id: id(50), reason: "x" }, { db }),
    /about a rule: pass rule_id/);
  await assert.rejects(m.acknowledgeWbRuleHealthTool.handler({ finding: "too_broad", rule_id: id(60), reason: "x" }, { db }),
    /about a merchant: pass merchant_id/);
  await assert.rejects(m.acknowledgeWbRuleHealthTool.handler({ finding: "too_broad", merchant_id: id(50) }, { db }), /say why/);
  await assert.rejects(m.acknowledgeWbRuleHealthTool.handler({ finding: "too_broad", merchant_id: id(50), reason: "x" }, { db }),
    /no current too_broad finding/);
  assert.equal(writes(db).length, 0);
});

test("unacknowledge deletes the acknowledgement", async () => {
  const db = fakeDb(() => ({ data: [{ id: id(90) }], error: null }));
  const out = await m.acknowledgeWbRuleHealthTool.handler({ finding: "too_broad", merchant_id: id(50), unacknowledge: true }, { db });
  assert.equal(db.op("wb_rule_health_acks", "delete").length, 1);
  assert.deepEqual(db.op("wb_rule_health_acks", "eq"), [["eq", "finding", "too_broad"], ["eq", "subject_id", id(50)]]);
  assert.equal(out.unacknowledged, true);
});

const BULK = {
  tags: [{ group: "Category", name: "ZZ Pets" }],
  merchants: [{ name: "ZZ Shop", match_patterns: ["zz shop"] }],
  rules: [{ name: "ZZ Shop rule", merchant: "ZZ Shop", tags: ["Category/ZZ Pets"] }],
};
const bulkResult = (applied, errorItem) => ({
  applied, counts: { created: 3 },
  results: [
    { kind: "tag", name: "Category/ZZ Pets", status: "created", id: id(80) },
    { kind: "merchant", name: "ZZ Shop", status: "created", id: id(81) },
    errorItem ?? { kind: "rule", name: "ZZ Shop rule", status: "created", id: id(82) },
  ],
});

function bulkDb(result) {
  return fakeDb((table) => (table === "wb_rules"
    ? { data: [{ match: { merchant_id: id(81) } }], error: null }
    : { data: [{ id: id(1) }], error: null }),
  (fn, p) => ({ data: fn === "wb_bulk_create" ? result(p) : { processed: 1 }, error: null }));
}

test("the bulk proposal is a dry run in the Money context and writes nothing", async () => {
  const db = bulkDb(() => bulkResult(false));
  const out = await m.bulkCreateWbTaxonomyTool.propose(BULK, { db });
  assert.deepEqual(db.rpcs[0], ["wb_bulk_create", { p_payload: BULK, p_context_id: MONEY, p_dry_run: true, p_created_by: "claude" }]);
  assert.equal(out.results.length, 3);
  assert.equal(out.errors, undefined);
  assert.equal(writes(db).length, 0);
});

test("a proposal with item errors says confirming would write nothing", async () => {
  const db = bulkDb(() => bulkResult(false, { kind: "rule", name: "ZZ x", status: "error", error: 'no merchant "ZZ Nowhere"' }));
  const out = await m.bulkCreateWbTaxonomyTool.propose(BULK, { db });
  assert.deepEqual(out.errors, ['rule "ZZ x": no merchant "ZZ Nowhere"']);
  assert.match(out.note, /writes nothing/);
});

test("the confirmed bulk create writes, then reprocesses the new merchants once", async () => {
  const db = bulkDb((p) => bulkResult(!p.p_dry_run));
  const out = await m.bulkCreateWbTaxonomyTool.handler({ ...BULK, source: "manual", confirmed: true }, { db });
  assert.deepEqual(db.rpcs[0][1], { p_payload: BULK, p_context_id: MONEY, p_dry_run: false, p_created_by: "manual" });
  assert.deepEqual(db.op("wb_transactions", "in")[0], ["in", "merchant_id", [id(81)]]);
  assert.deepEqual(db.rpcs[1], ["wb_process_transactions", { ids: [id(1)] }]);
  assert.equal(out.reprocessed.processed, 1);
});

test("a confirmed bulk create that is not applied is refused in plain words", async () => {
  const db = bulkDb(() => bulkResult(false, { kind: "rule", name: "ZZ x", status: "error", error: 'no merchant "ZZ Nowhere"' }));
  await assert.rejects(m.bulkCreateWbTaxonomyTool.handler({ ...BULK, confirmed: true }, { db }),
    /nothing was written, because: rule "ZZ x": no merchant "ZZ Nowhere"/);
});

test("bulkPayload checks the lists and the cap", () => {
  assert.throws(() => m.bulkPayload("t", undefined, undefined, undefined), /at least one/);
  assert.throws(() => m.bulkPayload("t", "x", [], []), /list of objects/);
  assert.throws(() => m.bulkPayload("t", Array.from({ length: 51 }, () => ({})), [], []), /at most 50 tags/);
  assert.deepEqual(m.bulkPayload("t", [{ a: 1 }], null, undefined), { tags: [{ a: 1 }], merchants: [], rules: [] });
});
