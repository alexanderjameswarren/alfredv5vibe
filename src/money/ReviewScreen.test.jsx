import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// Invented data only.
jest.mock("./moneyApi", () => ({
  getReviewQueue: jest.fn(),
  getTagTree: jest.fn(),
  applyTags: jest.fn(),
  reprocess: jest.fn(),
  setKind: jest.fn(),
  setReviewed: jest.fn(),
  getFixPlan: jest.fn(),
  applyFix: jest.fn(),
  recordSubscriptionPrice: jest.fn(),
  dismissSubscription: jest.fn(),
  confirmPlannedMatch: jest.fn(),
  rejectPlannedMatch: jest.fn(),
  getSubscriptions: jest.fn(),
  getSubscriptionDetail: jest.fn(),
}));
const api = require("./moneyApi");
const ReviewScreen = require("./ReviewScreen").default;

const row = (over) => ({
  transaction_id: "t1", account_label: "Test Card", txn_date: "2026-01-05", amount: -10, clean_description: "TEST SHOP",
  payee: "Test Shop", merchant_name: null, kind: "spend", tag_names: [], detail: null, ...over,
});

beforeEach(() => {
  api.getReviewQueue.mockResolvedValue([
    row({ reason: "missing_required_tag", detail: "Category" }),
    row({ transaction_id: "t2", reason: "transfer_candidate", kind: "transfer", clean_description: "ONLINE TRANSFER" }),
  ]);
  api.getTagTree.mockResolvedValue({
    groups: [{ id: "cat", name: "Category", exclusive: true }],
    tags: [{ id: "food", group_id: "cat", parent_id: null, name: "Food", is_active: true }],
  });
  api.applyTags.mockResolvedValue({});
  api.setKind.mockResolvedValue();
  api.getFixPlan.mockResolvedValue({
    merchant: { id: null, name: "Test", exists: false, add_pattern: "test" }, pattern: "test",
    dry_run: { count: 3, too_narrow: false, samples: [] }, existing_rules: [], warnings: [],
  });
});

it("groups by reason with one-tap fixes", async () => {
  render(<ReviewScreen onOpen={() => {}} />);
  expect(await screen.findByText("Needs a category")).toBeInTheDocument();
  expect(screen.getByText("Looks like a transfer")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Not a transfer" }));
  await waitFor(() => expect(api.setKind).toHaveBeenCalledWith({ id: "t2", transfer_pair_id: null }, "spend"));
});

it("picking a category tags it and offers Always do this", async () => {
  render(<ReviewScreen onOpen={() => {}} />);
  fireEvent.change(await screen.findByLabelText("Choose a category"), { target: { value: "food" } });
  await waitFor(() => expect(api.applyTags).toHaveBeenCalledWith(["t1"], ["food"], []));
  expect(await screen.findByRole("dialog", { name: "Always do this" })).toBeInTheDocument();
  expect(await screen.findByText(/Catches/)).toHaveTextContent("Catches 3 past transactions.");
});

it("subscription rows: record a new price, dismiss, or keep watching", async () => {
  const price = row({ transaction_id: "t3", reason: "price_change", detail: "Test Stream: expected 9.00", subscription_id: "s1" });
  const found = row({ transaction_id: "t4", reason: "new_recurring", detail: "Test Gas", subscription_id: "s2" });
  api.getReviewQueue.mockResolvedValue([price, found]);
  api.recordSubscriptionPrice.mockResolvedValue();
  api.dismissSubscription.mockResolvedValue();
  api.setReviewed.mockResolvedValue();
  render(<ReviewScreen onOpen={() => {}} />);
  expect(await screen.findByText("Subscription price changed")).toBeInTheDocument();
  expect(screen.getByText("Looks like a subscription")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Mark reviewed" })).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: "Record new price" }));
  await waitFor(() => expect(api.recordSubscriptionPrice).toHaveBeenCalledWith("s1", price));
  fireEvent.click(await screen.findByRole("button", { name: "Not a subscription" }));
  await waitFor(() => expect(api.dismissSubscription).toHaveBeenCalledWith("s2"));
  fireEvent.click(await screen.findByRole("button", { name: "Keep watching" }));
  await waitFor(() => expect(api.setReviewed).toHaveBeenCalledWith(["t4"], true));
});

it("a refused dismissal shows the plain sentence", async () => {
  api.getReviewQueue.mockResolvedValue([row({ reason: "new_recurring", detail: "Test Gas", subscription_id: "s2" })]);
  api.dismissSubscription.mockRejectedValue(new Error("Only a detected subscription can be dismissed here."));
  render(<ReviewScreen onOpen={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Not a subscription" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Only a detected subscription can be dismissed here.");
});

const suggestion = row({
  transaction_id: "t5", reason: "planned_match", detail: "ZZ invoice, due 2026-03-10", amount: -198, txn_date: "2026-03-14",
  planned_match_id: "m1", planned_item_id: "p1", planned_item_name: "ZZ invoice", planned_on: "2026-03-10",
  planned_amount: -200, match_amount: -198, planned_tolerance: 5, planned_window_days: 10,
});

it("suggested match: the planned item beside the payment, Confirm and Not this one", async () => {
  api.getReviewQueue.mockResolvedValue([suggestion]);
  api.confirmPlannedMatch.mockResolvedValue({ status: "confirmed" });
  api.rejectPlannedMatch.mockResolvedValue({ status: "rejected" });
  render(<ReviewScreen onOpen={() => {}} />);
  expect(await screen.findByText("Suggested match")).toBeInTheDocument();
  expect(screen.getByText("ZZ invoice")).toBeInTheDocument();
  expect(screen.getByText(/The app suggests this pays/)).toHaveTextContent("due Mar 10, 2026");
  expect(screen.queryByRole("button", { name: "Mark reviewed" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(api.confirmPlannedMatch).toHaveBeenCalledWith("m1"));
  fireEvent.click(await screen.findByRole("button", { name: "Not this one" }));
  await waitFor(() => expect(api.rejectPlannedMatch).toHaveBeenCalledWith("m1"));
});

it("suggested match: confirm for a lower amount", async () => {
  api.getReviewQueue.mockResolvedValue([suggestion]);
  api.confirmPlannedMatch.mockResolvedValue({ status: "confirmed" });
  render(<ReviewScreen onOpen={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Lower amount…" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm amount" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Type the amount");
  fireEvent.change(screen.getByLabelText("Amount for the planned item"), { target: { value: "120" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm amount" }));
  await waitFor(() => expect(api.confirmPlannedMatch).toHaveBeenCalledWith("m1", 120));
});

it("suggested match: the ? shows the working", async () => {
  api.getReviewQueue.mockResolvedValue([suggestion]);
  render(<ReviewScreen onOpen={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "About Suggested match" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("tolerance");
  expect(screen.getByRole("dialog")).toHaveTextContent("4 days apart (window 10 days either side)");
});

it("says so when there is nothing to review", async () => {
  api.getReviewQueue.mockResolvedValue([]);
  render(<ReviewScreen onOpen={() => {}} />);
  expect(await screen.findByText(/Nothing to review/)).toBeInTheDocument();
});
