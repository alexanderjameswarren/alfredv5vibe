import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SIMPLEFIN_BRIDGE_URL } from "./moneyFormat";
import {
  MONEY_REVIEW_PATH, intentionDetailPath, moneyAccountPath, moneyPlannedItemPath, moneySubscriptionPath, moneyTransactionPath,
} from "../viewPaths";

// Invented data only, shaped like wb_action_items.
jest.mock("./moneyApi", () => ({
  getAccounts: jest.fn(),
  getLatestNetWorth: jest.fn(),
  getLatestSyncRun: jest.fn(),
  getActionItems: jest.fn(),
}));
const api = require("./moneyApi");
const { default: OverviewScreen, SyncLine, linkTarget, showsBalance, firstBelowIndex, displayTitle } = require("./OverviewScreen");

const last = new Date("2026-03-10T13:05:00Z");
const row = (o) => ({ severity: "info", todo: "ZZ todo", amount: null, on: null, link_kind: null, link_id: null, ...o });
const ITEMS = {
  today: "2031-06-20", days: 14, big_amount: 1000, big_days: 60,
  flags: [row({ type: "card_charge", severity: "red", title: "Interest Charge On Purchases on ZZ Visa", amount: -12,
    on: "2031-06-10", todo: "A card charged interest or a fee.", note: "ZZ asked for a refund", link_kind: "transaction", link_id: "t1" })],
  reconcile: [row({ type: "reconcile_missing_required_tag", title: "11 need a category", count: 11,
    link_kind: "review_reason", link_id: "missing_required_tag" })],
  overdue: [row({ type: "overdue_one_off", title: "ZZ plumber, due Jun 1", amount: -70, link_kind: "planned_item", link_id: "p9" })],
  coming_up: [
    row({ type: "subscription", title: "ZZ stream (late, due Jun 17)", late: true, big: false, amount: -9, on: "2031-06-17",
      link_kind: "subscription", link_id: "s1" }),
    row({ type: "planned_one_off", title: "ZZ roof", late: false, big: true, amount: -5000, on: "2031-06-23",
      link_kind: "planned_item", link_id: "p1" }),
    row({ type: "planned_one_off", title: "ZZ refund", late: false, big: false, amount: 500, on: "2031-06-25",
      link_kind: "planned_item", link_id: "p2" }),
  ],
  big_bites: [
    row({ type: "planned", title: "ZZ roof", amount: -5000, on: "2031-06-23", what_if: false, link_kind: "planned_item", link_id: "p1" }),
    row({ type: "planned", title: "ZZ maybe pool", amount: -3000, on: "2031-07-25", what_if: true, link_kind: "planned_item", link_id: "p3" }),
  ],
  card_bills: [row({ type: "card_days_missing", title: "Set ZZ Visa's statement and due days", link_kind: "account", link_id: "c1" })],
  needs_attention: [
    row({ type: "manual_no_balance", title: "ZZ 401(k) has no balance yet", link_kind: "account", link_id: "a5" }),
    row({ type: "rule_health", title: "Rule ZZ: often overridden", link_kind: "merchant", link_id: "m1" }),
  ],
  money_intentions: [row({ type: "intention", title: "ZZ call the bank", link_kind: "intention", link_id: "i1" })],
  money_inbox: [],
  below_floor: {
    floor_missing: false, floor: 2500, first_below_on: "2031-07-09", closing_then: -500, shortfall_then: 3000,
    low_balance: -900, low_on: "2032-01-22", shortfall_at_low: 3400, reserve_balance: 20000,
    causes: [
      { type: "burn", title: "Everyday spending at the burn rate", amount: -6000, on: null, link_kind: null, link_id: null },
      { type: "subscription", title: "ZZ home insurance", amount: -4000, on: "2031-07-09", link_kind: "subscription", link_id: "s2" },
    ],
    path: [
      { type: "start", title: "Starting balance", amount: null, on: "2031-06-20", balance: 9000, below: false, link_kind: null, link_id: null },
      { type: "planned", title: "ZZ salary", amount: 2000, on: "2031-06-25", balance: 11000, below: false, link_kind: "planned_item", link_id: "p7" },
      { type: "burn", title: "Everyday spending at the burn rate", amount: -6000, on: "2031-07-03", balance: 5000, below: false, link_kind: null, link_id: null },
      { type: "subscription", title: "ZZ home insurance", amount: -4000, on: "2031-07-09", balance: -500, below: true, link_kind: "subscription", link_id: "s2" },
      { type: "burn", title: "Everyday spending at the burn rate", amount: -500, on: "2031-07-09", balance: -500, below: true, link_kind: null, link_id: null },
    ],
  },
  cash_flow: { days: 30, last_30_actual: 640, next_30_projected: -1200, typical_month: -2000, reserve_balance: 20000, runway_months: 10 },
};
const RESERVE = { account_id: "r1", label: "ZZ Savings", role: "reserve_cash", balance: 20000, is_hidden: false, source: "manual" };

beforeEach(() => {
  api.getAccounts.mockResolvedValue([RESERVE]);
  api.getLatestNetWorth.mockResolvedValue({ as_of: "2031-06-20", net_worth: 1234, spending_cash: 1000 });
  api.getLatestSyncRun.mockResolvedValue(null);
  api.getActionItems.mockResolvedValue(ITEMS);
});

const show = async (items = ITEMS) => {
  api.getActionItems.mockResolvedValue(items);
  const onNavigate = jest.fn();
  render(<OverviewScreen onNavigate={onNavigate} />);
  await screen.findByText(/Net worth/);
  return onNavigate;
};
const section = (name) => screen.getByRole("heading", { name: new RegExp(name) }).closest("section");

it("asks for the funds transfer, names the biggest cause, and shows the path on request", async () => {
  const go = await show();
  expect(screen.getByText("Move $3,000.00 from ZZ Savings by Jul 9, 2031")).toBeInTheDocument();
  expect(screen.getByText(/Biggest: ZZ home insurance, -\$4,000\.00 on Jul 9, 2031/)).toBeInTheDocument();
  expect(screen.queryByText("Starting balance")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /See what causes it/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show the path to Jul 9, 2031" }));
  const rows = screen.getByText("Starting balance").closest("ul").querySelectorAll("li");
  expect([...rows].map((r) => r.textContent)).toEqual([
    "Jun 20, 2031Starting balance$9,000.00",
    "Jun 25, 2031ZZ salary+$2,000.00$11,000.00",
    "Jul 3, 2031Everyday spending at the burn rate-$6,000.00$5,000.00",
    "Jul 9, 2031ZZ home insuranceBelow the floor of $2,500.00-$4,000.00",
    "Jul 9, 2031Everyday spending at the burn rate-$500.00-$500.00",
  ]);
  expect(rows[3]).toHaveClass("bg-destructive-light");
  expect(rows[4]).not.toHaveClass("bg-destructive-light");
  expect(within(rows[0]).queryByRole("button")).not.toBeInTheDocument();
  fireEvent.click(within(rows[3]).getByRole("button"));
  expect(go).toHaveBeenLastCalledWith(moneySubscriptionPath("s2"), undefined);
  fireEvent.click(screen.getByRole("button", { name: "Reserve $20,000.00" }));
  expect(go).toHaveBeenLastCalledWith(moneyAccountPath("r1"), { from: "overview" });
});

it("hides the path link while the live function has no path yet", async () => {
  const { path: _p, ...older } = ITEMS.below_floor;
  await show({ ...ITEMS, below_floor: older });
  expect(screen.getByText("Move $3,000.00 from ZZ Savings by Jul 9, 2031")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Show the path/ })).not.toBeInTheDocument();
});

it("shows no funds transfer when the projection stays above the floor", async () => {
  await show({ ...ITEMS, below_floor: { ...ITEMS.below_floor, first_below_on: null, causes: [] } });
  expect(screen.queryByText(/FUNDS TRANSFER REQUIRED/)).not.toBeInTheDocument();
});

it("gives each red flag its own card, linked, with its todo", async () => {
  const go = await show();
  fireEvent.click(screen.getByRole("button", { name: "Interest Charge On Purchases on ZZ Visa" }));
  expect(go).toHaveBeenLastCalledWith(moneyTransactionPath("t1"), { from: "overview" });
  expect(screen.getByText("Note: ZZ asked for a refund")).toBeInTheDocument();
  expect(screen.getByText("A card charged interest or a fee.")).toBeInTheDocument();
});

it("turns a refunded flag green, with the refund linked", async () => {
  const refunded = { ...ITEMS.flags[0], severity: "info", note: null, todo: "The refund came.",
    refund: { amount: 12, on: "2031-06-15", link_kind: "transaction", link_id: "t2" } };
  const go = await show({ ...ITEMS, flags: [refunded] });
  const card = screen.getByText("The refund came.").closest("section");
  expect(card).toHaveClass("bg-success-light");
  fireEvent.click(within(card).getByRole("button", { name: "Refund received: +$12.00 on Jun 15, 2031" }));
  expect(go).toHaveBeenLastCalledWith(moneyTransactionPath("t2"), { from: "overview" });
});

it("keeps an unrefunded flag red", async () => {
  await show();
  expect(screen.getByText("A card charged interest or a fee.").closest("section")).toHaveClass("bg-destructive-light");
  expect(screen.queryByText(/Refund received/)).not.toBeInTheDocument();
});

it("puts the count before the ? in each heading", async () => {
  await show();
  for (const [title, n] of [["To do", 6], ["Major expenses, next 60 days", 2], ["Next 14 days", 3]]) {
    const h = screen.getByRole("heading", { name: new RegExp(`^${title.replace(/[()]/g, "\\$&")} \\(${n}\\)`) });
    expect(h.textContent).toBe(`${title} (${n})`);
    expect(h.lastElementChild.lastElementChild.tagName).toBe("BUTTON");
  }
});

it("lists To do in order with a kind label, each row linked", async () => {
  const go = await show();
  const todo = section("To do");
  const rows = within(within(todo).getByRole("list")).getAllByRole("button").map((b) => b.textContent);
  expect(rows).toEqual([
    "ZZ plumber, due Jun 1Review", "11 need a categoryReview", "Set ZZ Visa's statement and due daysCard",
    "ZZ 401(k) has no balance yetAccount", "Rule ZZ: often overriddenRule", "ZZ call the bankIntention",
  ]);
  fireEvent.click(within(todo).getByRole("button", { name: /ZZ call the bank/ }));
  expect(go).toHaveBeenLastCalledWith(intentionDetailPath("i1"), undefined);
  fireEvent.click(within(todo).getByRole("button", { name: /often overridden/ }));
  expect(go).toHaveBeenLastCalledWith(MONEY_REVIEW_PATH, undefined);
});

it("totals major expenses without what-ifs, which are marked", async () => {
  await show();
  const major = section("Major expenses, next 60 days");
  const total = within(major).getByText(/^Total -\$5,000/);
  expect(total.tagName).toBe("P");
  expect(total).toHaveTextContent("Total -$5,000 (what-ifs not counted)");
  expect(within(major).getByText("What if")).toBeInTheDocument();
});

it("shows the next 14 days in one card: In, Out and a coloured Net, bold big rows, a late badge", async () => {
  await show();
  const next = section("Next 14 days");
  expect(within(next).getByText(/In \+\$500 \| Out -\$5,009 \|/)).toBeInTheDocument();
  expect(within(next).getByText("-$4,509")).toHaveClass("text-destructive");
  expect(within(next).getByText("ZZ roof").closest("li")).toHaveClass("font-medium");
  expect(within(next).getByText("ZZ refund").closest("li")).not.toHaveClass("font-medium");
  expect(within(next).getByText("+$500.00")).toHaveClass("text-success");
  const late = within(next).getByText("late");
  expect(late.closest("button")).toHaveTextContent(/^Jun 17, 2031ZZ stream late/);
  expect(within(next).queryByText("See every item", { exact: false })).not.toBeInTheDocument();
});

it("cuts a long next-14-days list and offers every item", async () => {
  const many = Array.from({ length: 15 }, (_, i) => row({ title: `ZZ bill ${i}`, amount: -1, on: "2031-06-21", big: false, late: false }));
  await show({ ...ITEMS, coming_up: many });
  fireEvent.click(screen.getByRole("button", { name: "See every item (15)" }));
  expect(screen.getByText("ZZ bill 14")).toBeInTheDocument();
});

it("shows cash flow coloured by sign, with the reserve runway", async () => {
  await show();
  const flow = screen.getByText("money in less money out").closest("section");
  expect(within(flow).getByText("+$640")).toHaveClass("text-success");
  expect(within(flow).getByText("-$1,200")).toHaveClass("text-destructive");
  expect(within(flow).getByText(/At this rate the ZZ Savings reserve covers about 10 months\./)).toBeInTheDocument();
});

it("works before cash_flow and big exist: no Cash flow card, nothing bold", async () => {
  const { cash_flow: _drop, ...older } = ITEMS;
  await show({ ...older, coming_up: ITEMS.coming_up.map(({ big: _b, ...r }) => r) });
  expect(screen.queryByText("money in less money out")).not.toBeInTheDocument();
  expect(within(section("Next 14 days")).getByText("ZZ roof").closest("li")).not.toHaveClass("font-medium");
});

it("keeps net worth when the action items fail to load", async () => {
  api.getActionItems.mockRejectedValue(new Error("Couldn't load the action items. Please try again."));
  render(<OverviewScreen onNavigate={jest.fn()} />);
  expect(await screen.findByText("Couldn't load the action items. Please try again.")).toBeInTheDocument();
  expect(screen.getByText("$1,234")).toBeInTheDocument();
});

it("shows a day's balance once, on its last row", () => {
  const path = ITEMS.below_floor.path;
  expect(path.map((_, i) => showsBalance(path, i))).toEqual([true, true, true, false, true]);
  expect(firstBelowIndex(path)).toBe(3);
});

it("ends an unfinished intention or inbox title with an ellipsis, and nothing else", () => {
  const t = (title, s = "money_intentions") => displayTitle({ title }, s);
  expect(t("ZZ: confirm the card did NOT charge on Nov 8 (auto-renew off), and")).toBe("ZZ: confirm the card did NOT charge on Nov 8 (auto-renew off), and…");
  expect(t("ZZ receipt from the plumber,", "money_inbox")).toBe("ZZ receipt from the plumber,…");
  expect(t("ZZ call the bank")).toBe("ZZ call the bank");
  expect(t("ZZ already cut…", "money_inbox")).toBe("ZZ already cut…");
  expect(t("ZZ plumber, due Jun 1 and", "overdue")).toBe("ZZ plumber, due Jun 1 and");
});

it("links every kind, and only Review for a merchant", () => {
  expect(linkTarget({ link_kind: "planned_item", link_id: "p" })).toEqual({ path: moneyPlannedItemPath("p"), state: { from: "overview" } });
  expect(linkTarget({ link_kind: "review_reason", link_id: "no_kind" })).toEqual({ path: MONEY_REVIEW_PATH });
  expect(linkTarget({ link_kind: "account", link_id: "a" })).toEqual({ path: moneyAccountPath("a"), state: { from: "overview" } });
  expect(linkTarget({ link_kind: null })).toBeNull();
});

it("keeps the bank and the reason, and links to SimpleFIN Bridge when a connection needs attention", () => {
  render(<SyncLine status={{ ok: false, last, needsBridge: true,
    problems: ["Last sync partial: Connection to Example Bank may need attention. Auth required"] }} />);
  expect(screen.getByText(/Example Bank may need attention\. Auth required/)).toBeInTheDocument();
  const link = screen.getByRole("link", { name: "SimpleFIN Bridge" });
  expect(link).toHaveAttribute("href", SIMPLEFIN_BRIDGE_URL);
  expect(link).toHaveAttribute("target", "_blank");
});

it("shows no Bridge link for other problems", () => {
  render(<SyncLine status={{ ok: false, last, needsBridge: false, problems: ["Last sync is over 36 hours old"] }} />);
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
