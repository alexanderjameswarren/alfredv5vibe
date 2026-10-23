import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";

// Invented data only.
jest.mock("./moneyApi", () => ({
  getPlannedItemDetail: jest.fn(),
  unconfirmPlannedMatch: jest.fn(),
  setPlannedItemBackToInvoiced: jest.fn(),
  getDeletePreview: jest.fn(),
  deletePlannedItem: jest.fn(),
}));
const api = require("./moneyApi");
const { default: PlannedItemDetailView, deleteLines } = require("./PlannedItemDetailView");

const oneOff = (over = {}) => ({
  id: "i1", name: "ZZ Invoice", project_id: "p1", amount: -100, due_on: "2031-06-01", interval_count: null,
  interval_unit: null, ends_on: null, stage: "paid", is_draft: false, amount_tolerance: 1, notes: "ZZ note", tax_year: null,
  project: { name: "ZZ Claim" }, merchant: { name: "ZZ Builder" }, ...over,
});
const match = (over) => ({
  id: "m1", transaction_id: "t1", split_id: "s1", occurrence_on: null, amount_applied: -99.5, status: "confirmed",
  payment: { id: "t1", txn_date: "2031-06-02", amount: -99.5, clean_description: "ZZ BUILDER" }, ...over,
});
const detail = (over = {}) => ({
  item: oneOff(),
  matches: [match({}), match({ id: "m2", transaction_id: "t2", status: "rejected", amount_applied: -100,
    payment: { id: "t2", txn_date: "2031-05-01", amount: -100, clean_description: "ZZ OTHER" } })],
  skips: [],
  ...over,
});
const view = (props = {}) => render(<PlannedItemDetailView plannedItemId="i1" onBack={() => {}} onOpenProject={() => {}}
  onOpenTransaction={() => {}} {...props} />);

it("shows the amount, what is left (0 within tolerance), due date, stage, tolerance, project, merchant and notes", async () => {
  api.getPlannedItemDetail.mockResolvedValue(detail());
  const onOpenProject = jest.fn();
  view({ onOpenProject });
  expect(await screen.findByRole("heading", { name: "ZZ Invoice" })).toBeInTheDocument();
  expect(screen.getByText("Amount").closest("div")).toHaveTextContent("-$100.00");
  expect(screen.getByText(/^Left to/).closest("div")).toHaveTextContent(/\$0\.00.*-\$99\.50 matched/);
  expect(screen.getByText("Due").closest("div")).toHaveTextContent("Jun 1, 2031");
  expect(screen.getByText("Tolerance").closest("div")).toHaveTextContent("± $1.00");
  expect(screen.getByText("ZZ Builder")).toBeInTheDocument();
  expect(screen.getByText("ZZ note")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "ZZ Claim" }));
  expect(onOpenProject).toHaveBeenCalledWith("p1");
});

it("shows a repeating item's schedule, What if, and More than planned", async () => {
  api.getPlannedItemDetail.mockResolvedValue(detail({
    item: oneOff({ interval_count: 1, interval_unit: "month", stage: null, is_draft: true, ends_on: "2031-12-01", amount_tolerance: 0 }),
    matches: [match({ occurrence_on: "2031-06-01", amount_applied: -60 }), match({ id: "m3", occurrence_on: "2031-06-01", amount_applied: -50 })],
    skips: [{ id: "k1", occurrence_on: "2031-05-01", reason: "ZZ before sync" }],
  }));
  view();
  expect(await screen.findByText(/^Repeats/)).toBeInTheDocument();
  expect(screen.getByText(/^Repeats/).closest("div")).toHaveTextContent("Monthly from Jun 1, 2031 to Dec 1, 2031");
  expect(screen.getByText("What if")).toBeInTheDocument();
  expect(screen.getByText("More than planned")).toBeInTheDocument();
  expect(screen.queryByText(/^Left to/)).not.toBeInTheDocument();
  expect(screen.getByText("ZZ before sync")).toBeInTheDocument();
});

it("lists matches confirmed first; only a confirmed one has Remove match; a payment opens", async () => {
  api.getPlannedItemDetail.mockResolvedValue(detail());
  const onOpenTransaction = jest.fn();
  view({ onOpenTransaction });
  const s = (await screen.findByRole("heading", { name: /^Matches/ })).closest("section");
  const rows = within(s).getAllByRole("listitem");
  expect(rows[0]).toHaveTextContent(/ZZ BUILDER.*Confirmed/);
  expect(rows[1]).toHaveTextContent(/ZZ OTHER.*Turned down/);
  expect(within(rows[0]).getByRole("button", { name: "Remove match" })).toBeInTheDocument();
  expect(within(rows[1]).queryByRole("button", { name: "Remove match" })).not.toBeInTheDocument();
  fireEvent.click(within(rows[1]).getByText("ZZ OTHER"));
  expect(onOpenTransaction).toHaveBeenCalledWith("t2");
});

it("Remove match asks Set it back to invoiced? only when paid_not_covered, and changes the stage only on yes", async () => {
  api.getPlannedItemDetail.mockResolvedValue(detail());
  api.unconfirmPlannedMatch.mockResolvedValue({ status: "rejected", paid_not_covered: true });
  api.setPlannedItemBackToInvoiced.mockResolvedValue();
  view();
  fireEvent.click(await screen.findByRole("button", { name: "Remove match" }));
  await waitFor(() => expect(api.unconfirmPlannedMatch).toHaveBeenCalledWith("m1"));
  const ask = await screen.findByRole("dialog", { name: "Set it back to invoiced?" });
  expect(ask.parentElement.parentElement).toBe(document.body);
  expect(api.setPlannedItemBackToInvoiced).not.toHaveBeenCalled();
  fireEvent.click(within(ask).getByRole("button", { name: "Yes, set it back" }));
  await waitFor(() => expect(api.setPlannedItemBackToInvoiced).toHaveBeenCalledWith("i1"));
});

it("No keeps it paid; no question when the item is still covered", async () => {
  api.getPlannedItemDetail.mockResolvedValue(detail());
  api.unconfirmPlannedMatch.mockResolvedValueOnce({ paid_not_covered: true }).mockResolvedValueOnce({ paid_not_covered: false });
  view();
  fireEvent.click(await screen.findByRole("button", { name: "Remove match" }));
  fireEvent.click(await screen.findByRole("button", { name: "No, keep it paid" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "Remove match" }));
  await waitFor(() => expect(api.unconfirmPlannedMatch).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(api.setPlannedItemBackToInvoiced).not.toHaveBeenCalled();
});

it("Delete item reads what would go first, says it plainly, and deletes only on confirm, then goes back", async () => {
  api.getPlannedItemDetail.mockResolvedValue(detail());
  api.getDeletePreview.mockResolvedValue({ confirmed: 1, suggested: 0, rejected: 1, skips: 2 });
  api.deletePlannedItem.mockResolvedValue({});
  const onBack = jest.fn();
  view({ onBack });
  fireEvent.click(await screen.findByRole("button", { name: "Delete item" }));
  const box = await screen.findByRole("dialog", { name: "Delete this item?" });
  expect(box.parentElement.parentElement).toBe(document.body);
  expect(box).toHaveTextContent("1 confirmed match: those payments count in spending again.");
  expect(box).toHaveTextContent("1 turned-down match.");
  expect(box).toHaveTextContent("2 Not needed marks.");
  expect(box).toHaveTextContent("ZZ Claim: its amounts still due will change.");
  expect(box).toHaveTextContent("The payments themselves stay.");
  expect(api.deletePlannedItem).not.toHaveBeenCalled();
  fireEvent.click(within(box).getByRole("button", { name: "Keep it" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Delete item" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete it" }));
  await waitFor(() => expect(api.deletePlannedItem).toHaveBeenCalledWith("i1"));
  await waitFor(() => expect(onBack).toHaveBeenCalled());
});

it("every ? opens its own entry: Stage has the stages, not Upcoming", async () => {
  api.getPlannedItemDetail.mockResolvedValue(detail({ item: oneOff({ stage: "quoted" }) }));
  view();
  await screen.findByRole("heading", { name: "ZZ Invoice" });
  const helps = screen.getAllByRole("button", { name: /^About / }).map((b) => b.getAttribute("aria-label"));
  expect(helps).toEqual(["About Left to pay", "About Stage", "About Matches", "About Delete item"]);
  fireEvent.click(screen.getByRole("button", { name: "About Stage" }));
  expect(screen.getByRole("dialog", { name: "Stage" })).toHaveTextContent(/Estimate: committed.*Paid: set by itself/);
});

it("deleteLines says nothing extra for a bare item", () => {
  expect(deleteLines({ confirmed: 0, suggested: 0, rejected: 0, skips: 0 }, null)).toEqual([]);
  expect(deleteLines({ confirmed: 2, suggested: 1, rejected: 0, skips: 0 }, null)).toEqual([
    "2 confirmed matches: those payments count in spending again.", "1 suggestion waiting in Review."]);
});

it("an item nobody can see says so with Back", async () => {
  api.getPlannedItemDetail.mockResolvedValue(null);
  const onBack = jest.fn();
  view({ onBack });
  fireEvent.click(await screen.findByRole("button", { name: /Back/ }));
  expect(onBack).toHaveBeenCalled();
});
