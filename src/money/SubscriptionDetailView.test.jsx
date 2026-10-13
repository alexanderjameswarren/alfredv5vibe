import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// Invented data only.
jest.mock("./moneyApi", () => ({
  getSubscriptionDetail: jest.fn(),
  getSubscriptionChoices: jest.fn(),
  updateSubscription: jest.fn(),
  setSubscriptionStatus: jest.fn(),
  dismissSubscription: jest.fn(),
  recordPrice: jest.fn(),
  linkCharges: jest.fn(),
  findLinkCandidates: jest.fn(),
}));
const api = require("./moneyApi");
const SubscriptionDetailView = require("./SubscriptionDetailView").default;

const SUB = {
  id: "s1", name: "Test Cleaner", status: "active", cadence: "other", interval_count: 2, interval_unit: "week",
  current_price: 60, merchant_id: "m1", merchant_name: "Test Cleaning Co", amount_tolerance: 0, expected_amount: 60,
  next_expected_on: "2026-01-20", last_charged_on: "2026-01-06", review_date: null, owner: "joint", notes: "Every other Tuesday",
  bundle_id: "s2", bundle_name: "Test Bundle", plan: null, term_end_date: null, auto_renew: null, billed_through_id: null,
};
const charge = (id, day) => ({ id, txn_date: day, amount: -60, clean_description: "TEST CLEANING", account_label: "Test Card", subscription_source: "default" });

function open(props = {}) {
  const handlers = { onBack: jest.fn(), onOpenSubscription: jest.fn(), onOpenTransaction: jest.fn(), ...props };
  render(<SubscriptionDetailView subscriptionId="s1" {...handlers} />);
  return handlers;
}

beforeEach(() => {
  api.getSubscriptionDetail.mockResolvedValue({
    sub: SUB,
    prices: [{ id: "p1", effective_on: "2025-12-01", amount: 60, source: "manual" }],
    charges: [charge("t1", "2026-01-06"), charge("t2", "2025-12-23")],
  });
  api.getSubscriptionChoices.mockResolvedValue({ merchants: [{ id: "m1", name: "Test Cleaning Co" }], subscriptions: [SUB] });
  for (const f of ["updateSubscription", "setSubscriptionStatus", "recordPrice", "linkCharges"]) api[f].mockResolvedValue();
  api.findLinkCandidates.mockResolvedValue([charge("t9", "2025-11-25")]);
});

it("shows the facts, price history and linked charges", async () => {
  const h = open();
  expect(await screen.findByText("Every 2 weeks")).toBeInTheDocument();
  expect(screen.getByText("$60.00 ($130.00 a month)")).toBeInTheDocument();
  expect(screen.getByText(/From Dec 1, 2025/)).toBeInTheDocument();
  expect(screen.getByText("Linked charges")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Test Bundle" }));
  expect(h.onOpenSubscription).toHaveBeenCalledWith("s2");
  fireEvent.click(screen.getAllByText("TEST CLEANING")[0]);
  expect(h.onOpenTransaction).toHaveBeenCalledWith("t1");
});

it("unlinks a charge by hand and links one back", async () => {
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Unlink Jan 6, 2026" }));
  await waitFor(() => expect(api.linkCharges).toHaveBeenCalledWith(["t1"], null));
  fireEvent.click(await screen.findByRole("button", { name: "Link charges" }));
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Link 1 charge" }));
  await waitFor(() => expect(api.linkCharges).toHaveBeenCalledWith(["t9"], "s1"));
  expect(api.findLinkCandidates).toHaveBeenCalledWith(SUB, "");
});

it("records a price as a positive amount from a date", async () => {
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Record price" }));
  fireEvent.change(screen.getByLabelText("New price"), { target: { value: "65.50" } });
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-02-01" } });
  fireEvent.click(screen.getByRole("button", { name: "Save price" }));
  await waitFor(() => expect(api.recordPrice).toHaveBeenCalledWith("s1", 65.5, "2026-02-01"));
});

it("pauses, and edits only the changed fields", async () => {
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
  await waitFor(() => expect(api.setSubscriptionStatus).toHaveBeenCalledWith("s1", "paused"));
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(await screen.findByLabelText("N"), { target: { value: "3" } });
  fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Every third Tuesday" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(api.updateSubscription).toHaveBeenCalledWith(SUB, { interval_count: 3, notes: "Every third Tuesday" }));
});

it("refuses a bad interval in plain words", async () => {
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(await screen.findByLabelText("N"), { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("whole number from 1 to 104");
  expect(api.updateSubscription).not.toHaveBeenCalled();
});

it("dismisses a detected subscription only after a second tap", async () => {
  api.getSubscriptionDetail.mockResolvedValue({ sub: { ...SUB, status: "watching" }, prices: [], charges: [] });
  const h = open();
  fireEvent.click(await screen.findByRole("button", { name: "Not a subscription" }));
  expect(api.dismissSubscription).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Yes, dismiss" }));
  await waitFor(() => expect(api.dismissSubscription).toHaveBeenCalledWith("s1"));
  await waitFor(() => expect(h.onBack).toHaveBeenCalled());
});

it("says so when the subscription is not there", async () => {
  api.getSubscriptionDetail.mockResolvedValue(null);
  open();
  expect(await screen.findByText("No such subscription.")).toBeInTheDocument();
});
