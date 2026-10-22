// Invented data only. The fake client logs each query and answers it through
// mockRespond(table, ops).
let mockLog = [];
let mockRespond = () => ({ data: [], error: null });
let mockRpcs = [];
let mockRpc = () => ({ data: {}, error: null });

jest.mock("../supabaseClient", () => {
  const rpc = (fn, params) => {
    mockRpcs.push([fn, params]);
    return Promise.resolve(mockRpc(fn, params));
  };
  const from = (table) => {
    const ops = [];
    mockLog.push({ table, ops });
    const finish = () => Promise.resolve(mockRespond(table, ops));
    const b = new Proxy({}, {
      get: (_t, k) => {
        if (k === "then") return (res, rej) => finish().then(res, rej);
        if (k === "maybeSingle" || k === "single") return () => { ops.push([k]); return finish(); };
        return (...a) => { ops.push([k, ...a]); return b; };
      },
    });
    return b;
  };
  return { supabase: { from, rpc } };
});

const api = require("./moneyApi");
const has = (ops, k) => ops.some((o) => o[0] === k);
const op = (table, k) => mockLog.filter((q) => q.table === table).flatMap((q) => q.ops).filter((o) => o[0] === k);
const writes = () => mockLog.filter((q) => has(q.ops, "insert") || has(q.ops, "update"));

beforeEach(() => {
  mockLog = [];
  mockRespond = () => ({ data: [], error: null });
  mockRpcs = [];
  mockRpc = () => ({ data: {}, error: null });
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

describe("updateAccount", () => {
  it("refuses sync-owned fields and writes nothing", async () => {
    await expect(api.updateAccount("a1", { name: "x", notes: "n" })).rejects.toThrow(/cannot be edited here: name/);
    expect(mockLog).toHaveLength(0);
  });

  it("writes human columns with the Money context", async () => {
    mockRespond = () => ({ data: [{ id: "a1" }], error: null });
    await api.updateAccount("a1", { role: "retirement", owner: "joint" });
    expect(op("wb_accounts", "update")[0][1]).toEqual({ role: "retirement", owner: "joint", context_id: api.MONEY_CONTEXT_ID });
  });
});

describe("createManualAccount", () => {
  it("refuses a duplicate name", async () => {
    mockRespond = () => ({ data: [{ id: "old" }], error: null });
    await expect(api.createManualAccount({ name: "Test Fund" })).rejects.toThrow(/already exists/);
    expect(writes()).toHaveLength(0);
  });

  it("inserts a manual row in the Money context", async () => {
    mockRespond = (t, ops) => (has(ops, "insert") ? { data: [{ id: "new" }], error: null } : { data: [], error: null });
    const out = await api.createManualAccount({ name: " Test Fund ", role: "retirement", notes: null });
    expect(out).toEqual({ id: "new" });
    const row = op("wb_accounts", "insert")[0][1];
    expect(row).toMatchObject({ name: "Test Fund", role: "retirement", source: "manual", external_id: null, context_id: api.MONEY_CONTEXT_ID });
  });
});

describe("recordBalance", () => {
  const MANUAL = { id: "m1", source: "manual" };

  it("refuses a synced account", async () => {
    await expect(api.recordBalance({ id: "s1", source: "simplefin" }, { asOf: "2026-01-02", balance: 1 }))
      .rejects.toThrow(/come from the sync/);
    expect(mockLog).toHaveLength(0);
  });

  it("refuses to replace a sync row", async () => {
    mockRespond = () => ({ data: { id: "x", source: "sync" }, error: null });
    await expect(api.recordBalance(MANUAL, { asOf: "2026-01-02", balance: 1 })).rejects.toThrow(/came from the sync/);
    expect(writes()).toHaveLength(0);
  });

  it("inserts a new date, and replaces a manual one", async () => {
    mockRespond = (t, ops) => (has(ops, "insert") ? { data: [{ id: "n" }], error: null } : { data: null, error: null });
    expect(await api.recordBalance(MANUAL, { asOf: "2026-01-02", balance: 10 })).toEqual({ replaced: null });
    expect(op("wb_balance_snapshots", "insert")[0][1]).toMatchObject({
      account_id: "m1", as_of: "2026-01-02", balance: 10, source: "manual", context_id: api.MONEY_CONTEXT_ID,
    });

    mockLog = [];
    mockRespond = (t, ops) => (has(ops, "update") ? { data: [{ id: "x" }], error: null } : { data: { id: "x", source: "import" }, error: null });
    expect(await api.recordBalance(MANUAL, { asOf: "2026-01-02", balance: 12 })).toEqual({ replaced: "import" });
  });

  it("refuses a future date", async () => {
    await expect(api.recordBalance(MANUAL, { asOf: "2999-01-01", balance: 1 })).rejects.toThrow(/future/);
  });
});

describe("reads", () => {
  it("never selects raw transactions", async () => {
    await api.getTransactions("a1");
    expect(op("wb_transaction_list", "select")[0][1]).not.toMatch(/\braw\b/);
  });

  it("returns null for the sync run when platform_runs is not readable", async () => {
    mockRespond = () => ({ data: null, error: { message: "permission denied" } });
    expect(await api.getLatestSyncRun()).toBeNull();
  });
});

describe("plain errors", () => {
  it("turns known refusals into sentences and never shows the raw message", () => {
    const e = api.plainError("Couldn't save the splits", { message: "wb_replace_splits: splits sum to -57.31, but the transaction is -61.47" });
    expect(e.message).toBe("The split amounts must add up to the transaction amount.");
    expect(e.message).not.toMatch(/\d/);
    expect(api.plainError("Couldn't load transactions", { message: "relation wb_x does not exist" }).message)
      .toBe("Couldn't load transactions. Please try again.");
    expect(api.plainError("x", { message: "new row violates row-level security policy" }).message).toMatch(/Sign in again/);
  });
});

describe("listTransactions", () => {
  it("filters before the page and pages 50 at a time", async () => {
    mockRespond = () => ({ data: [{ id: "t1" }], error: null, count: 120 });
    const out = await api.listTransactions(
      { accountId: "a1", month: "2026-02", kind: "spend", tag: "Food", text: "corner,(cafe)", needsReview: true },
      { offset: 50 });
    expect(out).toEqual({ rows: [{ id: "t1" }], total: 120 });
    const ops = mockLog[0].ops;
    expect(mockLog[0].table).toBe("wb_transaction_list");
    expect(ops.filter((o) => o[0] === "gte" || o[0] === "lte")).toEqual([["gte", "txn_date", "2026-02-01"], ["lte", "txn_date", "2026-02-28"]]);
    expect(ops.find((o) => o[0] === "overlaps")).toEqual(["overlaps", "tag_names", ["Food"]]);
    expect(ops.find((o) => o[0] === "or")[1]).toContain("clean_description.ilike.*corner cafe*");
    expect(ops.find((o) => o[0] === "range")).toEqual(["range", 50, 99]);
    expect(ops.findIndex((o) => o[0] === "range")).toBeGreaterThan(ops.findIndex((o) => o[0] === "eq" && o[1] === "needs_review"));
  });
});

describe("hand edits", () => {
  it("tags and untags with source manual", async () => {
    await api.applyTags(["t1"], ["g1"], ["g2"]);
    expect(mockRpcs).toEqual([["wb_apply_tags", { p_transaction_ids: ["t1"], p_tag_ids: ["g1"], p_source: "manual", p_remove_tag_ids: ["g2"] }]]);
  });

  it("sets the kind by hand, then reprocesses; refuses on a paired transfer", async () => {
    await expect(api.setKind({ id: "t1", transfer_pair_id: "t2" }, "spend")).rejects.toThrow(/Unpair it first/);
    expect(writes()).toHaveLength(0);
    await api.setKind({ id: "t1", transfer_pair_id: null }, "fee");
    expect(op("wb_transactions", "update")[0][1]).toEqual({ kind: "fee", kind_source: "manual" });
    expect(mockRpcs).toEqual([["wb_process_transactions", { ids: ["t1"] }]]);
  });

  it("replaces splits in one call and shows a plain refusal", async () => {
    mockRpc = (fn) => (fn === "wb_replace_splits"
      ? { data: null, error: { message: "wb_replace_splits: splits sum to -5.00, but the transaction is -6.00" } }
      : { data: {}, error: null });
    await expect(api.replaceSplits("t1", [{ amount: -5, tag_ids: [] }])).rejects.toThrow("The split amounts must add up to the transaction amount.");
    expect(mockRpcs.map((r) => r[0])).toEqual(["wb_replace_splits"]);
  });

  it("applies a fix as manual, updating the merchant's rule when asked", async () => {
    await expect(api.applyFix({ transactionId: "t1" })).rejects.toThrow(/Choose a kind/);
    await api.applyFix({ transactionId: "t1", tagIds: ["g1"], updateRuleId: "r1" });
    expect(mockRpcs[0]).toEqual(["wb_apply_fix", {
      p_transaction_id: "t1", p_set_kind: null, p_add_tag_ids: ["g1"], p_pattern: null, p_merchant_name: null,
      p_update_rule_id: "r1", p_add_new_rule: false, p_notes: null, p_created_by: "manual",
    }]);
  });
});

describe("subscriptions screen", () => {
  it("saves edits, relinks both merchants' charges when the merchant changes, then refreshes the dates", async () => {
    mockRespond = (table) => ({ data: table === "wb_transactions" ? [{ id: "t1" }, { id: "t2" }] : null, error: null });
    await api.updateSubscription({ id: "s1", merchant_id: "m1" }, { merchant_id: "m2", notes: "n" });
    expect(op("wb_subscriptions", "update")[0]).toEqual(["update", { merchant_id: "m2", notes: "n" }]);
    expect(op("wb_transactions", "in")[0]).toEqual(["in", "merchant_id", ["m1", "m2"]]);
    expect(mockRpcs.map((r) => r[0])).toEqual(["wb_process_transactions", "wb_refresh_subscriptions"]);
    expect(mockRpcs[1][1]).toEqual({ p_ids: ["s1"] });
  });

  it("does not reprocess when the merchant is unchanged", async () => {
    await api.updateSubscription({ id: "s1", merchant_id: "m1" }, { notes: "n" });
    expect(mockRpcs.map((r) => r[0])).toEqual(["wb_refresh_subscriptions"]);
  });

  it("records a manual price, refusing zero", async () => {
    await api.recordPrice("s1", 9.5, "2026-02-01");
    expect(op("wb_subscription_prices", "upsert")[0][1]).toEqual(
      { subscription_id: "s1", effective_on: "2026-02-01", amount: 9.5, source: "manual" });
    await expect(api.recordPrice("s1", 0, "2026-02-01")).rejects.toThrow("A price must be more than zero.");
  });

  it("links and unlinks by hand", async () => {
    await api.linkCharges(["t1"], null);
    expect(mockRpcs[0]).toEqual(["wb_link_subscription", { p_transaction_ids: ["t1"], p_subscription_id: null, p_source: "manual" }]);
  });

  it("finds unlinked spend for the merchant, or by search across merchants, and nothing without either", async () => {
    await api.findLinkCandidates({ merchant_id: "m1" }, "");
    expect(op("wb_transaction_list", "eq")).toEqual([["eq", "kind", "spend"], ["eq", "merchant_id", "m1"]]);
    expect(op("wb_transaction_list", "is")[0]).toEqual(["is", "subscription_id", null]);
    mockLog = [];
    await api.findLinkCandidates({ merchant_id: "m1" }, "pool");
    expect(op("wb_transaction_list", "or")).toHaveLength(1);
    expect(op("wb_transaction_list", "eq")).toEqual([["eq", "kind", "spend"]]);
    mockLog = [];
    expect(await api.findLinkCandidates({ merchant_id: null }, "")).toEqual([]);
  });
});

describe("subscriptions in review", () => {
  it("attaches subscription_id to subscription rows only", async () => {
    mockRespond = (table) => (table === "wb_review_queue"
      ? { data: [{ reason: "new_recurring", transaction_id: "t1" }, { reason: "no_kind", transaction_id: "t2" }], error: null }
      : { data: [{ id: "t1", subscription_id: "s1" }], error: null });
    const rows = await api.getReviewQueue();
    expect(rows[0].subscription_id).toBe("s1");
    expect(rows[1]).not.toHaveProperty("subscription_id");
    expect(op("wb_transactions", "in")[0]).toEqual(["in", "id", ["t1"]]);
  });

  it("gives planned match rows the project, repeating, and what that date already has confirmed", async () => {
    mockRespond = (table) => ({
      wb_review_queue: { data: [
        { reason: "planned_match", transaction_id: "t1", planned_item_id: "r1", planned_on: "2031-02-05" },
        { reason: "planned_match", transaction_id: "t2", planned_item_id: "o1", planned_on: "2031-03-01" },
      ], error: null },
      wb_planned_items: { data: [
        { id: "r1", interval_count: 1, project_id: null, project: null },
        { id: "o1", interval_count: null, project_id: "p1", project: { name: "ZZ P" } },
      ], error: null },
      wb_planned_matches: { data: [
        { planned_item_id: "r1", occurrence_on: "2031-01-05", amount_applied: -50 },
        { planned_item_id: "r1", occurrence_on: "2031-02-05", amount_applied: -10 },
        { planned_item_id: "o1", occurrence_on: null, amount_applied: -30 },
      ], error: null },
    }[table]);
    const rows = await api.getReviewQueue();
    expect(rows.map((r) => [r.planned_repeating, r.planned_already, r.planned_project_name])).toEqual(
      [[true, 10, null], [false, 30, "ZZ P"]]);
    expect(op("wb_planned_matches", "eq")[0]).toEqual(["eq", "status", "confirmed"]);
  });

  it("records the charge's amount as a positive price from its date", async () => {
    await api.recordSubscriptionPrice("s1", { transaction_id: "t1", txn_date: "2026-01-05", amount: -12.5 });
    expect(op("wb_subscription_prices", "upsert")[0]).toEqual(["upsert",
      { subscription_id: "s1", effective_on: "2026-01-05", amount: 12.5, source: "manual", transaction_id: "t1" },
      { onConflict: "subscription_id,effective_on" }]);
  });

  it("dismisses a watching row: flags the merchant, then deletes the row", async () => {
    mockRespond = (table, ops) => (table === "wb_subscriptions" && has(ops, "maybeSingle")
      ? { data: { id: "s1", merchant_id: "m1", status: "watching" }, error: null } : { data: null, error: null });
    await api.dismissSubscription("s1");
    expect(op("wb_merchants", "update")[0]).toEqual(["update", { not_subscription: true }]);
    expect(op("wb_subscriptions", "delete")).toHaveLength(1);
  });

  it("refuses to dismiss an active subscription, writing nothing", async () => {
    mockRespond = () => ({ data: { id: "s1", merchant_id: "m1", status: "active" }, error: null });
    await expect(api.dismissSubscription("s1")).rejects.toThrow("Only a detected subscription can be dismissed here.");
    expect(writes()).toHaveLength(0);
    expect(op("wb_subscriptions", "delete")).toHaveLength(0);
  });
});

describe("planned matches", () => {
  it("confirm calls wb_confirm_planned_match, with a lower amount as a positive number", async () => {
    await api.confirmPlannedMatch("m1");
    await api.confirmPlannedMatch("m1", -120);
    expect(mockRpcs).toEqual([
      ["wb_confirm_planned_match", { p_match_id: "m1", p_action: "confirm", p_amount: null }],
      ["wb_confirm_planned_match", { p_match_id: "m1", p_action: "confirm", p_amount: 120 }],
    ]);
  });

  it("Not this one rejects", async () => {
    await api.rejectPlannedMatch("m1");
    expect(mockRpcs).toEqual([["wb_confirm_planned_match", { p_match_id: "m1", p_action: "reject", p_amount: null }]]);
  });

  it("an over-amount refusal is a plain sentence", async () => {
    mockRpc = () => ({ data: null, error: { message: "wb_planned_matches: confirmed matches on this split would exceed its amount" } });
    await expect(api.confirmPlannedMatch("m1", 999)).rejects.toThrow("That is more than this payment. Lower the amount.");
  });
});

describe("getKindRule", () => {
  it("names the last matched rule that sets a kind", async () => {
    mockRespond = (table) => table === "wb_transactions"
      ? { data: { matched_rule_ids: ["r1", "r2", "r3"] }, error: null }
      : { data: [{ id: "r3", name: "Tags only", set_kind: null }, { id: "r1", name: "First", set_kind: "spend" },
        { id: "r2", name: "Second", set_kind: "fee" }], error: null };
    expect((await api.getKindRule("t1")).name).toBe("Second");
  });

  it("is null with no matched rules", async () => {
    mockRespond = () => ({ data: { matched_rule_ids: [] }, error: null });
    expect(await api.getKindRule("t1")).toBeNull();
  });
});

describe("getPlanOverview", () => {
  it("reads the four sources, confirmed matches only, bounded, writing nothing", async () => {
    mockRespond = (table) => ({ data: [{ table }], error: null });
    const r = await api.getPlanOverview();
    expect(mockLog.map((q) => q.table).sort()).toEqual(
      ["wb_planned_items", "wb_planned_matches", "wb_planned_unmatched", "wb_project_summary"]);
    expect(op("wb_planned_matches", "eq")[0]).toEqual(["eq", "status", "confirmed"]);
    expect(mockLog.every((q) => has(q.ops, "limit"))).toBe(true);
    expect(writes()).toHaveLength(0);
    expect(r.missed).toEqual([{ table: "wb_planned_unmatched" }]);
  });

  it("turns a failure into a plain sentence", async () => {
    mockRespond = (table) => (table === "wb_planned_unmatched" ? { data: null, error: { message: "boom" } } : { data: [], error: null });
    await expect(api.getPlanOverview()).rejects.toThrow("Couldn't load the plan. Please try again.");
  });
});

describe("planned item detail and its actions", () => {
  it("is null when the item is not visible", async () => {
    mockRespond = () => ({ data: null, error: null });
    expect(await api.getPlannedItemDetail("i1")).toBeNull();
    expect(mockLog).toHaveLength(1);
  });

  it("joins each match to its payment and reads the marks", async () => {
    mockRespond = (table) => ({
      wb_planned_items: { data: { id: "i1", name: "ZZ I" }, error: null },
      wb_planned_matches: { data: [{ id: "m1", transaction_id: "t1", status: "confirmed" }, { id: "m2", transaction_id: "t9", status: "rejected" }], error: null },
      wb_planned_skips: { data: [{ id: "k1", occurrence_on: "2031-01-05" }], error: null },
      wb_transaction_list: { data: [{ id: "t1", txn_date: "2031-01-06" }], error: null },
    }[table]);
    const r = await api.getPlannedItemDetail("i1");
    expect(r.matches.map((m) => [m.id, m.payment?.id ?? null])).toEqual([["m1", "t1"], ["m2", null]]);
    expect(r.skips).toHaveLength(1);
    expect(writes()).toHaveLength(0);
  });

  it("removes a match through wb_unconfirm_planned_match, and says plainly when it is not confirmed", async () => {
    mockRpc = () => ({ data: { paid_not_covered: true }, error: null });
    expect(await api.unconfirmPlannedMatch("m1")).toEqual({ paid_not_covered: true });
    expect(mockRpcs[0]).toEqual(["wb_unconfirm_planned_match", { p_match_id: "m1" }]);
    mockRpc = () => ({ data: null, error: { message: "wb_unconfirm_planned_match: this match is rejected, not confirmed" } });
    await expect(api.unconfirmPlannedMatch("m1")).rejects.toThrow("That match is no longer confirmed, so there is nothing to remove.");
  });

  it("sets a paid one-off back to invoiced only, then asks for suggestions", async () => {
    mockRespond = () => ({ data: [{ id: "i1" }], error: null });
    await api.setPlannedItemBackToInvoiced("i1");
    expect(op("wb_planned_items", "update")[0][1]).toEqual({ stage: "invoiced" });
    expect(op("wb_planned_items", "eq")).toEqual([["eq", "id", "i1"], ["eq", "stage", "paid"]]);
    expect(mockRpcs[0]).toEqual(["wb_suggest_planned_matches", { p_transaction_ids: null, p_planned_item_ids: ["i1"] }]);
    mockRespond = () => ({ data: [], error: null });
    await expect(api.setPlannedItemBackToInvoiced("i1")).rejects.toThrow(/no longer at stage paid/);
  });

  it("previews what a delete removes, then deletes through wb_delete_planned_item", async () => {
    mockRespond = (table) => (table === "wb_planned_matches"
      ? { data: [{ status: "confirmed" }, { status: "suggested" }, { status: "rejected" }, { status: "rejected" }], error: null }
      : { data: [{ id: "k1" }], error: null });
    expect(await api.getDeletePreview("i1")).toEqual({ confirmed: 1, suggested: 1, rejected: 2, skips: 1 });
    mockRpc = () => ({ data: { confirmed: 1 }, error: null });
    expect(await api.deletePlannedItem("i1")).toEqual({ confirmed: 1 });
    expect(mockRpcs.at(-1)).toEqual(["wb_delete_planned_item", { p_id: "i1" }]);
    expect(writes()).toHaveLength(0);
  });
});

describe("setTransactionProject (A17)", () => {
  const txn = { id: "t1", splits: [{ id: "s1" }] };

  it("sets or clears the one part as a hand change", async () => {
    mockRespond = () => ({ data: [{ id: "s1" }], error: null });
    await api.setTransactionProject(txn, "p1");
    expect(op("wb_splits", "update")[0][1]).toEqual({ project_id: "p1", project_source: "manual" });
    expect(op("wb_splits", "eq")).toEqual([["eq", "id", "s1"], ["eq", "transaction_id", "t1"]]);
    await api.setTransactionProject(txn, "");
    expect(op("wb_splits", "update")[1][1]).toEqual({ project_id: null, project_source: "manual" });
  });

  it("refuses a split payment, writing nothing, and says when the row changed", async () => {
    await expect(api.setTransactionProject({ id: "t1", splits: [{ id: "a" }, { id: "b" }] }, "p1")).rejects.toThrow(/ask Claude/);
    expect(writes()).toHaveLength(0);
    mockRespond = () => ({ data: [], error: null });
    await expect(api.setTransactionProject(txn, "p1")).rejects.toThrow(/Nothing was changed/);
  });
});

describe("getProjectDetail", () => {
  it("is null when the project is not visible, and reads nothing more", async () => {
    mockRespond = () => ({ data: null, error: null });
    expect(await api.getProjectDetail("p1")).toBeNull();
    expect(mockLog.map((q) => q.table).sort()).toEqual(["wb_project_summary", "wb_projects"]);
  });

  it("joins each part on the project to its payment, newest first, and reads confirmed matches only", async () => {
    mockRespond = (table) => ({
      wb_project_summary: { data: { project_id: "p1", name: "ZZ P" }, error: null },
      wb_projects: { data: { id: "p1", notes: null }, error: null },
      wb_planned_items: { data: [{ id: "i1" }], error: null },
      wb_splits: { data: [{ id: "s1", transaction_id: "t1", amount: -40 }, { id: "s2", transaction_id: "t2", amount: -10 }], error: null },
      wb_planned_matches: { data: [], error: null },
      wb_transaction_list: { data: [{ id: "t1", txn_date: "2031-01-02" }, { id: "t2", txn_date: "2031-02-03", split_count: 2 }], error: null },
    }[table]);
    const r = await api.getProjectDetail("p1");
    expect(r.payments.map((p) => [p.split_id, p.part_amount])).toEqual([["s2", -10], ["s1", -40]]);
    expect(op("wb_planned_matches", "eq")[0]).toEqual(["eq", "status", "confirmed"]);
    expect(writes()).toHaveLength(0);
  });
});
