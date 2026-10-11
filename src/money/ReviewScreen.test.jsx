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

it("says so when there is nothing to review", async () => {
  api.getReviewQueue.mockResolvedValue([]);
  render(<ReviewScreen onOpen={() => {}} />);
  expect(await screen.findByText(/Nothing to review/)).toBeInTheDocument();
});
