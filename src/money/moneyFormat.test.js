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
