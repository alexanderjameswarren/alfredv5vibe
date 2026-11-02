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
