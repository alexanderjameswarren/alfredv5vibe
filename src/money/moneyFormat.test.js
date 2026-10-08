import {
  costBasisLabel, formatMoney, groupAccounts, holdingGain, parseAmountInput, rewardDisplay, syncStatus,
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

describe("amounts", () => {
  it("parses typed amounts and formats signed money", () => {
    expect(parseAmountInput("$1,234.567")).toBe(1234.57);
    expect(parseAmountInput("-50")).toBe(-50);
    expect(parseAmountInput("abc")).toBeNull();
    expect(formatMoney(-12.5)).toBe("-$12.50");
    expect(formatMoney(null)).toBe("—");
  });
});
