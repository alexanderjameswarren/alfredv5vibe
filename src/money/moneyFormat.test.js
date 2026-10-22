import {
  billingChoice, billingFields, groupSubscriptions, intervalLabel, monthlyEquivalent, multiplierLabel, reviewSoon,
  subscriptionBreakdown, subscriptionTotals, leftOf, annotatePlannedItem,
} from "./moneyFormat";
import {
  addMonths, costBasisLabel, exclusionLabel, formatMoney, formatMonth, groupAccounts, groupQueue, holdingGain,
  monthOf, monthRange, parseAmountInput, rewardDisplay, spendingForMonth, splitRemainder, syncStatus, tagOptions, tagTops,
} from "./moneyFormat";

// Invented data only.
const NOW = new Date("2026-03-10T18:00:00Z");
const synced = (over = {}) => ({
  account_id: "a", source: "simplefin", role: "spending_cash", is_hidden: false,
  last_synced_at: "2026-03-10T13:05:00Z", staleness_days: 0, name: "Test Checking", ...over,
});

describe("rewards", () => {
  it("shows units, dollars only with a rate, and the expiry", () => {
    expect(rewardDisplay({ balance: 1200, reward_unit: "points" })).toEqual({ units: "1,200 points", dollars: null, expires: null });
    expect(rewardDisplay({ balance: "1000", reward_unit: "miles", reward_value_per_unit: 0.015, expires_on: "2027-01-01" }))
      .toEqual({ units: "1,000 miles", dollars: "$15.00", expires: "2027-01-01" });
  });
});

describe("cost basis", () => {
  it("treats 0 as not reported, never a loss", () => {
    expect(costBasisLabel({ cost_basis: 0 })).toBe("not reported");
    expect(costBasisLabel({ cost_basis: null })).toBe("not reported");
    expect(holdingGain({ cost_basis: 0, market_value: 500 })).toBeNull();
    expect(costBasisLabel({ cost_basis: "250.5" })).toBe("$250.50");
    expect(holdingGain({ cost_basis: 400, market_value: 500 })).toBe(100);
  });
});

describe("groupAccounts", () => {
  it("puts unassigned apart and hides hidden accounts unless asked", () => {
    const rows = [
      synced({ account_id: "1", role: "unassigned", name: "B" }),
      synced({ account_id: "2", role: "retirement", name: "R" }),
      synced({ account_id: "3", role: "closed", is_hidden: true, name: "Old" }),
    ];
    const g = groupAccounts(rows);
    expect(g.unassigned.map((a) => a.account_id)).toEqual(["1"]);
    expect(g.groups.map((x) => x.role)).toEqual(["retirement"]);
    expect(groupAccounts(rows, { showHidden: true }).groups.map((x) => x.role)).toEqual(["retirement", "closed"]);
  });
});

describe("syncStatus", () => {
  it("is ok after a recent sync with fresh accounts", () => {
    const s = syncStatus([synced()], { status: "ok" }, NOW);
    expect(s.ok).toBe(true);
    expect(s.last.toISOString()).toBe("2026-03-10T13:05:00.000Z");
  });

  it("warns on an old sync, a stale account, and a failed run", () => {
    const s = syncStatus(
      [
        synced({ last_synced_at: "2026-03-08T13:00:00Z" }),
        synced({ account_id: "b", name: "Stale One", staleness_days: 3, last_synced_at: "2026-03-08T13:00:00Z" }),
      ],
      { status: "partial", error_message: "bank needs login" },
      NOW,
    );
    expect(s.ok).toBe(false);
    expect(s.problems).toEqual([
      "Last sync is over 36 hours old",
      "1 account not updated: Stale One",
      "Last sync partial: bank needs login",
    ]);
  });

  it("says when SimpleFIN Bridge is where to fix it", () => {
    const run = (status, error_message) => syncStatus([synced()], { status, error_message }, NOW).needsBridge;
    expect(run("partial", "Connection to Example Bank may need attention. Auth required")).toBe(true);
    expect(run("auth_expired", null)).toBe(true);
    expect(run("failed", "timeout reading accounts")).toBe(false);
    expect(run("ok", "may need attention")).toBe(false);
    expect(syncStatus([synced()], null, NOW).needsBridge).toBe(false);
  });

  it("works without a run (Elise cannot read platform_runs) and ignores manual and closed accounts", () => {
    const s = syncStatus(
      [synced(), { source: "manual", staleness_days: 40 }, synced({ role: "closed", staleness_days: 90 })],
      null,
      NOW,
    );
    expect(s.ok).toBe(true);
  });
});

describe("months", () => {
  it("works out month ranges and steps", () => {
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthRange("2028-02").to).toBe("2028-02-29");
    expect(addMonths("2026-01", -2)).toBe("2025-11");
    expect(addMonths("2025-12", 1)).toBe("2026-01");
    expect(formatMonth("2026-10-01")).toBe("Oct 2026");
    expect(monthOf("2026-10-07")).toBe("2026-10");
  });
});

describe("review, tags, spending, splits", () => {
  it("groups the review queue by reason in a fixed order, newest first", () => {
    const groups = groupQueue([
      { reason: "no_kind", txn_date: "2026-01-01" },
      { reason: "missing_required_tag", txn_date: "2026-01-01", transaction_id: "a" },
      { reason: "missing_required_tag", txn_date: "2026-01-09", transaction_id: "b" },
    ]);
    expect(groups.map((g) => g.reason)).toEqual(["missing_required_tag", "no_kind"]);
    expect(groups[0].rows.map((r) => r.transaction_id)).toEqual(["b", "a"]);
    expect(groups[0].label).toBe("Needs a category");
  });

  const TAGS = [
    { id: "food", group_id: "cat", parent_id: null, name: "Food", is_active: true },
    { id: "coffee", group_id: "cat", parent_id: "food", name: "Coffee", is_active: true },
    { id: "pets", group_id: "cat", parent_id: null, name: "Pets", is_active: true },
    { id: "old", group_id: "cat", parent_id: null, name: "Old", is_active: false },
    { id: "alex", group_id: "who", parent_id: null, name: "Alex", is_active: true },
  ];

  it("lists a group's tags with children under parents, active only", () => {
    expect(tagOptions(TAGS, "cat").map((o) => o.label)).toEqual(["Food", "Food › Coffee", "Pets"]);
    expect(tagTops(TAGS).get("coffee")).toBe("food");
  });

  it("builds a month's Category spending, children under their top tag", () => {
    const rows = [
      { month: "2026-01-01", level: "top", tag_id: "food", tag_name: "Food", amount: "-60.00" },
      { month: "2026-01-01", level: "top", tag_id: "pets", tag_name: "Pets", amount: "-80.00" },
      { month: "2026-01-01", level: "top", tag_id: null, tag_name: null, amount: "-5.00" },
      { month: "2026-01-01", level: "leaf", tag_id: "coffee", tag_name: "Coffee", amount: "-20.00" },
      { month: "2026-01-01", level: "leaf", tag_id: "food", tag_name: "Food", amount: "-40.00" },
      { month: "2026-02-01", level: "top", tag_id: "food", tag_name: "Food", amount: "-1.00" },
    ];
    const v = spendingForMonth(rows, TAGS, "2026-01");
    expect(v.groups.map((g) => g.name)).toEqual(["Pets", "Food"]);
    expect(v.groups[1].children).toEqual([
      { tagId: "food", name: "Food (general)", amount: -40 },
      { tagId: "coffee", name: "Coffee", amount: -20 },
    ]);
    expect(v.untagged).toBe(-5);
    expect(v.total).toBe(-145);
  });

  it("counts what is left to split, and labels removals", () => {
    expect(splitRemainder("-60.00", [{ amount: -40 }, { amount: "-15.5" }])).toBe(-4.5);
    expect(splitRemainder(-60, [{ amount: -60 }])).toBe(0);
    expect(exclusionLabel({ source: "manual" })).toBe("removed by you");
    expect(exclusionLabel({ source: "claude" })).toBe("removed by Claude");
  });
});

describe("amounts", () => {
  it("parses typed amounts and formats signed money", () => {
    expect(parseAmountInput("$1,234.567")).toBe(1234.57);
    expect(parseAmountInput("-50")).toBe(-50);
    expect(parseAmountInput("abc")).toBeNull();
    expect(formatMoney(-12.5)).toBe("-$12.50");
    expect(formatMoney(null)).toBe("—");
  });
});

describe("subscriptions", () => {
  const sub = (over) => ({ status: "active", cadence: "monthly", interval_count: 1, interval_unit: "month",
    current_price: "12", owner: null, name: "Test", ...over });

  it("labels the billing interval", () => {
    expect(intervalLabel(sub())).toBe("Monthly");
    expect(intervalLabel(sub({ cadence: "annual", interval_count: 12 }))).toBe("Annual");
    expect(intervalLabel(sub({ cadence: "other", interval_count: 2, interval_unit: "week" }))).toBe("Every 2 weeks");
    expect(intervalLabel(sub({ cadence: "other", interval_count: 1, interval_unit: "week" }))).toBe("Weekly");
    expect(intervalLabel(sub({ cadence: "other", interval_count: null, interval_unit: null }))).toBe("Irregular");
  });

  it("turns any interval into a monthly cost", () => {
    expect(monthlyEquivalent(sub({ cadence: "annual", interval_count: 12, current_price: "120" }))).toBe(10);
    expect(monthlyEquivalent(sub({ cadence: "other", interval_count: 2, interval_unit: "month", current_price: 90 }))).toBe(45);
    expect(monthlyEquivalent(sub({ cadence: "other", interval_count: 2, interval_unit: "week", current_price: 60 }))).toBe(130);
    expect(monthlyEquivalent(sub({ cadence: "other", interval_count: null, interval_unit: null }))).toBeNull();
    expect(monthlyEquivalent(sub({ current_price: null }))).toBeNull();
  });

  it("totals active rows only, by owner, listing what cannot be counted", () => {
    const t = subscriptionTotals([
      sub({ owner: "alex", current_price: 10 }), sub({ owner: "joint", current_price: 20 }), sub({ current_price: 5 }),
      sub({ status: "paused", current_price: 100 }), sub({ status: "watching", current_price: 100 }),
      sub({ name: "Odd", cadence: "other", interval_count: null, interval_unit: null }),
    ]);
    expect(t.total).toBe(35);
    expect(t.byOwner).toEqual({ alex: 10, elise: 0, joint: 20, unassigned: 5 });
    expect(t.notCounted.map((s) => s.name)).toEqual(["Odd"]);
  });

  it("labels the monthly multiplier plainly", () => {
    expect(multiplierLabel(sub())).toBe("×1");
    expect(multiplierLabel(sub({ cadence: "annual", interval_count: 12 }))).toBe("÷12");
    expect(multiplierLabel(sub({ cadence: "other", interval_count: 2, interval_unit: "month" }))).toBe("÷2");
    expect(multiplierLabel(sub({ cadence: "other", interval_count: 2, interval_unit: "week" }))).toBe("×2.17");
    expect(multiplierLabel(sub({ cadence: "other", interval_count: 1, interval_unit: "week" }))).toBe("×4.33");
  });

  it("breaks the total down high to low, rows rounded first so they sum exactly", () => {
    const thirds = [1, 2, 3].map((i) => sub({ id: `a${i}`, name: `Annual ${i}`, cadence: "annual", interval_count: 12, current_price: 100, owner: "elise" }));
    const b = subscriptionBreakdown([
      ...thirds, sub({ id: "w", name: "Weekly", cadence: "other", interval_count: 2, interval_unit: "week", current_price: 30, owner: "joint" }),
      sub({ id: "x", name: "Odd", cadence: "other", interval_count: null, interval_unit: null }),
      sub({ id: "y", name: "Unpriced", current_price: null }),
      sub({ id: "z", name: "Paused", status: "paused" }),
    ]);
    expect(b.rows.map((r) => [r.sub.name, r.multiplier, r.monthly])).toEqual([
      ["Weekly", "×2.17", 65], ["Annual 1", "÷12", 8.33], ["Annual 2", "÷12", 8.33], ["Annual 3", "÷12", 8.33],
    ]);
    expect(b.total).toBe(89.99);
    expect(b.rows.reduce((s, r) => s + Math.round(r.monthly * 100), 0)).toBe(Math.round(b.total * 100));
    expect(b.byOwner).toEqual({ alex: 0, elise: 24.99, joint: 65, unassigned: 0 });
    expect(b.notCounted.map((n) => [n.sub.name, n.reason])).toEqual([
      ["Odd", "No regular billing interval"], ["Unpriced", "No price recorded"],
    ]);
  });

  it("groups by status with overdue first and names A to Z", () => {
    const g = groupSubscriptions([
      sub({ name: "B" }), sub({ name: "A" }), sub({ name: "Late", overdue: true }),
      sub({ name: "C", status: "cancelled" }), sub({ name: "W", status: "watching" }),
    ]);
    expect(g.map((x) => x.key)).toEqual(["overdue", "active", "watching", "cancelled"]);
    expect(g[1].rows.map((s) => s.name)).toEqual(["A", "B"]);
  });

  it("flags a review date within 30 days or past", () => {
    expect(reviewSoon({ review_date: "2026-04-09" }, "2026-03-10")).toBe(true);
    expect(reviewSoon({ review_date: "2026-04-10" }, "2026-03-10")).toBe(false);
    expect(reviewSoon({ review_date: "2026-01-01" }, "2026-03-10")).toBe(true);
    expect(reviewSoon({ review_date: null }, "2026-03-10")).toBe(false);
  });

  it("maps the billing choice to cadence and interval and back", () => {
    expect(billingFields("weeks", "2")).toEqual({ cadence: "other", interval_count: 2, interval_unit: "week" });
    expect(billingFields("months", "3")).toEqual({ cadence: "quarterly" });
    expect(billingFields("months", "2")).toEqual({ cadence: "other", interval_count: 2, interval_unit: "month" });
    expect(billingFields("irregular", "")).toEqual({ cadence: "other", interval_count: null, interval_unit: null });
    expect(billingFields("weeks", "0")).toBeNull();
    expect(billingFields("weeks", "1.5")).toBeNull();
    expect(billingChoice(sub({ cadence: "other", interval_count: 2, interval_unit: "week" }))).toEqual({ choice: "weeks", count: "2" });
    expect(billingChoice(sub({ cadence: "annual" }))).toEqual({ choice: "annual", count: "" });
  });
});

describe("planned items (A45)", () => {
  it("leftOf: nothing due within the tolerance, the same as SQL wb_planned_left", () => {
    expect(leftOf(100, 99.5, 1)).toBe(0);
    expect(leftOf(100, 99, 1)).toBe(0);
    expect(leftOf(100, 98.99, 1)).toBe(1.01);
    expect(leftOf(100, 150, 0)).toBe(0);
    expect(leftOf(100, 0, null)).toBe(100);
  });

  it("annotatePlannedItem: remaining with the sign, over_matched beyond the tolerance, drafts", () => {
    const bill = { id: "b", amount: -100, amount_tolerance: 1, interval_count: null, stage: "invoiced" };
    const a = (it, ...paid) => annotatePlannedItem(it, paid.map((p) => ({ planned_item_id: it.id, ...p })));
    expect(a(bill, { amount_applied: -99.5 }).remaining).toBe(0);
    expect(a(bill, { amount_applied: -98.99 }).remaining).toBe(-1.01);
    expect(a({ ...bill, amount: 100 }, { amount_applied: 98.99 }).remaining).toBe(1.01);
    expect(a(bill, { amount_applied: -101.01 }).over_matched).toBe(true);
    expect(a(bill, { amount_applied: -100.99 }).over_matched).toBe(false);
    const rep = { id: "r", amount: -50, amount_tolerance: 0, interval_count: 1, interval_unit: "month", is_draft: true };
    const r = a(rep, { occurrence_on: "2031-01-05", amount_applied: -50 }, { occurrence_on: "2031-02-05", amount_applied: -50 });
    expect([r.repeating, r.draft, r.remaining, r.over_matched, r.confirmed_total]).toEqual([true, true, null, false, -100]);
    expect(a({ ...bill, stage: "draft" }).draft).toBe(true);
  });
});
