import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";

// Invented data only.
jest.mock("./moneyApi", () => ({
  getSubscriptions: jest.fn(),
  setSubscriptionStatus: jest.fn(),
  dismissSubscription: jest.fn(),
}));
const api = require("./moneyApi");
const SubscriptionsScreen = require("./SubscriptionsScreen").default;

const sub = (over) => ({
  id: over.name, status: "active", cadence: "monthly", interval_count: 1, interval_unit: "month", current_price: 10,
  owner: null, overdue: false, next_expected_on: "2026-11-01", ...over,
});

beforeEach(() => {
  api.getSubscriptions.mockResolvedValue([
    sub({ name: "Test Stream", owner: "alex" }),
    sub({ name: "Test Gym", owner: "joint", current_price: 50, overdue: true, days_past_expected: 9 }),
    sub({ name: "Test Cleaner", cadence: "other", interval_count: 2, interval_unit: "week", current_price: 60 }),
    sub({ name: "Test Pills", cadence: "other", interval_count: null, interval_unit: null }),
    sub({ name: "Test Found", status: "watching" }),
    sub({ name: "Test Old", status: "cancelled" }),
  ]);
  api.setSubscriptionStatus.mockResolvedValue();
  api.dismissSubscription.mockResolvedValue();
});

it("totals active subscriptions per month, by owner, and lists what is not counted", async () => {
  render(<SubscriptionsScreen onOpen={() => {}} />);
  expect(await screen.findByText("$190.00")).toBeInTheDocument();
  expect(screen.getByText(/Not counted/)).toHaveTextContent("Test Pills");
  expect(screen.getByText("Alex").parentElement).toHaveTextContent("$10.00");
});

it("shows a breakdown, high to low, that adds up to the total, with owner subtotals and the rows not counted", async () => {
  render(<SubscriptionsScreen onOpen={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Show breakdown" }));
  const table = screen.getByRole("table");
  const rows = within(table).getAllByRole("row");
  expect(rows[1]).toHaveTextContent("Test Cleaner");
  expect(rows[1]).toHaveTextContent("×2.17");
  expect(rows[1]).toHaveTextContent("$130.00");
  expect(rows[2]).toHaveTextContent("Test Gym");
  expect(rows[3]).toHaveTextContent("Test Stream");
  expect(rows.at(-1)).toHaveTextContent("Total (3)");
  expect(rows.at(-1)).toHaveTextContent("$190.00");
  const subtotal = within(table.querySelector("tfoot")).getByText("Unassigned").closest("tr");
  expect(subtotal).toHaveTextContent("$130.00");
  expect(screen.getByText("No regular billing interval")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Hide breakdown" }));
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});

it("groups by status with Overdue first and Cancelled collapsed", async () => {
  render(<SubscriptionsScreen onOpen={() => {}} />);
  const headings = (await screen.findAllByRole("heading", { level: 3 })).map((h) => h.textContent);
  expect(headings).toEqual(["Overdue (1)", "Active (3)", "Watching (1)", "Cancelled (1)"]);
  expect(screen.getByText("Overdue 9 days")).toBeInTheDocument();
  expect(screen.queryByText("Test Old")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Cancelled/ }));
  expect(screen.getByText("Test Old")).toBeInTheDocument();
  expect(screen.getByText(/Every 2 weeks/)).toBeInTheDocument();
});

it("confirms or dismisses a detected subscription", async () => {
  render(<SubscriptionsScreen onOpen={() => {}} />);
  const row = (await screen.findByText("Test Found")).closest("li");
  fireEvent.click(within(row).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(api.setSubscriptionStatus).toHaveBeenCalledWith("Test Found", "active"));
  fireEvent.click(within((await screen.findByText("Test Found")).closest("li")).getByRole("button", { name: "Not a subscription" }));
  await waitFor(() => expect(api.dismissSubscription).toHaveBeenCalledWith("Test Found"));
});

it("opens a subscription", async () => {
  const onOpen = jest.fn();
  render(<SubscriptionsScreen onOpen={onOpen} />);
  fireEvent.click(await screen.findByText("Test Stream"));
  expect(onOpen).toHaveBeenCalledWith("Test Stream");
});
