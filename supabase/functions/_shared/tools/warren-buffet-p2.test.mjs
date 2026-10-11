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

test("a second rule without a choice is refused in plain words", async () => {
  const db = fixDb({ applyError: { message: "wb_apply_fix: a rule already exists for Corner; update it or add another", code: "23505" } });
  const err = await m.createWbRuleFromTransactionTool.handler({ transaction_id: id(1), set_kind: "spend", confirmed: true }, { db })
    .then(() => null, (e) => e);
  assert.equal(err.message,
    "create_wb_rule_from_transaction: A rule already exists for this merchant: pass update_rule_id to update it (preferred), or add_new_rule: true. Nothing was changed.");
});
