// Handler tests for warren-buffet-p4.ts. Invented data only.
// Run: node --test supabase/functions/_shared/tools/warren-buffet-p4.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTool } from "./test-platform.mjs";

const m = await loadTool("warren-buffet-p4.ts");

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fakeDb(result = { data: { updated: 1 }, error: null }) {
  const rpcs = [];
  return { rpcs, rpc: (fn, params) => { rpcs.push([fn, params]); return Promise.resolve(result); } };
}
const tag = (args, db = fakeDb()) => m.setWbOrderItemTagsTool.handler({ tag_id: id(1), ...args }, { db });

test("tiers", () => {
  assert.equal(m.setWbOrderItemTagsTool.tier, 2);
  assert.equal(m.splitWbOrderChargesTool.tier, 2);
  assert.equal(m.recordWbSubscriptionReviewTool.tier, 2);
});

test("tag by ids, by asin, or a site's untagged items", async () => {
  const db = fakeDb();
  await tag({ item_ids: [id(2), id(2)] }, db);
  await tag({ asin: " ZZ1 ", source: "manual" }, db);
  await tag({ untagged_site: "wholefoods" }, db);
  assert.deepEqual(db.rpcs.map(([, p]) => [p.p_item_ids, p.p_asin, p.p_site, p.p_source]), [
    [[id(2)], null, null, "claude"], [null, "ZZ1", null, "manual"], [null, null, "wholefoods", "claude"],
  ]);
  assert.ok(db.rpcs.every(([fn, p]) => fn === "wb_set_order_item_tags" && p.p_tag_id === id(1)));
});

test("tag refuses a bad call before the database", async () => {
  const db = fakeDb();
  await assert.rejects(tag({}, db), /exactly one of/);
  await assert.rejects(tag({ asin: "ZZ1", untagged_site: "amazon" }, db), /exactly one of/);
  await assert.rejects(tag({ untagged_site: "zz" }, db), /untagged_site must be one of/);
  await assert.rejects(tag({ asin: "ZZ1", source: "rule" }, db), /source must be one of/);
  await assert.rejects(m.setWbOrderItemTagsTool.handler({ asin: "ZZ1" }, { db }), /tag_id/);
  assert.equal(db.rpcs.length, 0);
  await assert.rejects(tag({ item_ids: Array.from({ length: 101 }, (_, i) => id(i + 10)) }, db), /at most 100/);
});

test("split runs all or the given charges and returns the report", async () => {
  const report = { split: 1, unchanged: 0, skipped_hand_split: [id(3)] };
  const db = fakeDb({ data: report, error: null });
  assert.deepEqual(await m.splitWbOrderChargesTool.handler({}, { db }), report);
  await m.splitWbOrderChargesTool.handler({ transaction_ids: [id(4)] }, { db });
  assert.deepEqual(db.rpcs, [["wb_split_order_charges", { p_transaction_ids: null }], ["wb_split_order_charges", { p_transaction_ids: [id(4)] }]]);
});

test("a database error is raised", async () => {
  const db = fakeDb({ data: null, error: { message: "wb_set_order_item_tags: the tag must be an active tag in the Category group" } });
  await assert.rejects(tag({ asin: "ZZ1" }, db), /Category group/);
});

// --- record_wb_subscription_review ---

function reviewDb(result = { data: { id: id(9), subscription_id: id(5), verdict: "keep", user_id: id(1) }, error: null }) {
  const db = fakeDb(result);
  db.reads = [];
  db.from = (table) => {
    const b = {
      select: () => b, eq: () => b,
      maybeSingle: () => { db.reads.push(table); return Promise.resolve({ data: { id: id(5), review_date: "2031-01-01" }, error: null }); },
    };
    return b;
  };
  return db;
}
const review = (args, db = reviewDb()) => m.recordWbSubscriptionReviewTool.handler({ subscription_id: id(5), ...args }, { db });

test("review calls the function with every param and returns the review and subscription", async () => {
  const db = reviewDb();
  const out = await review({
    verdict: "keep", next_review_on: "2031-01-01", reviewed_on: "2030-06-01", period_from: "2029-06-01",
    period_to: "2030-05-31", uses: 4, amount_paid: 10, cost_per_use: 2.5, market_check: " ZZ line ", notes: "ZZ",
  }, db);
  assert.deepEqual(db.rpcs, [["wb_record_subscription_review", {
    p_subscription_id: id(5), p_verdict: "keep", p_next_review_on: "2031-01-01", p_reviewed_on: "2030-06-01",
    p_period_from: "2029-06-01", p_period_to: "2030-05-31", p_uses: 4, p_amount_paid: 10, p_cost_per_use: 2.5,
    p_market_check: "ZZ line", p_notes: "ZZ",
  }]]);
  assert.equal(out.review.verdict, "keep");
  assert.ok(!("user_id" in out.review));
  assert.equal(out.subscription.review_date, "2031-01-01");
  assert.deepEqual(db.reads, ["wb_subscription_overview"]);
});

test("review refuses a bad call before the database", async () => {
  const db = reviewDb();
  await assert.rejects(review({}, db), /verdict is required/);
  await assert.rejects(review({ verdict: "maybe" }, db), /verdict must be one of/);
  await assert.rejects(review({ verdict: "keep", uses: -1 }, db), /uses must be a whole number/);
  await assert.rejects(review({ verdict: "keep", next_review_on: "2031-02-30" }, db), /not a real date/);
  await assert.rejects(m.recordWbSubscriptionReviewTool.handler({ verdict: "keep" }, { db }), /subscription_id/);
  assert.equal(db.rpcs.length, 0);
});

test("review passes the database's refusal through as it is, without do-not-retry wording", async () => {
  const msg = "wb_record_subscription_review: a next review date is required unless the verdict is cancel. Nothing was changed.";
  const err = await review({ verdict: "keep" }, reviewDb({ data: null, error: { message: msg, code: "22023" } })).then(() => null, (e) => e);
  assert.ok(err.message.includes(msg));
  assert.ok(!/retry/i.test(err.message));
});
