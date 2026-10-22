import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";

// Invented data only.
jest.mock("./moneyApi", () => ({ getProjectDetail: jest.fn() }));
const api = require("./moneyApi");
const ProjectDetailView = require("./ProjectDetailView").default;

const summary = (over = {}) => ({
  project_id: "p1", name: "ZZ Claim", status: "active", budget: 1000, spent: -300, received: 120, net: -180,
  budget_left: 700, planned_out_due: -250, planned_in_due: 60, draft_out_due: -400, draft_in_due: 0, planning: false, ...over,
});
const detail = (over = {}) => ({
  summary: summary(),
  project: { id: "p1", starts_on: "2031-01-01", ends_on: null, notes: "ZZ note" },
  items: [
    { id: "i1", name: "ZZ Contractor", amount: -500, due_on: "2031-07-01", interval_count: null, stage: "quoted", amount_tolerance: 0 },
    { id: "i2", name: "ZZ Extra", amount: -400, due_on: "2031-08-01", interval_count: null, stage: "draft", amount_tolerance: 0 },
    { id: "i3", name: "ZZ Insurer", amount: 60, due_on: "2031-06-15", interval_count: 1, interval_unit: "month", stage: null, amount_tolerance: 0 },
  ],
  confirmed: [{ planned_item_id: "i1", occurrence_on: null, amount_applied: -250 }],
  payments: [
    { split_id: "s2", id: "t2", txn_date: "2031-06-10", amount: 120, part_amount: 120, clean_description: "ZZ INSURER", split_count: 1 },
    { split_id: "s1", id: "t1", txn_date: "2031-05-02", amount: -400, part_amount: -300, clean_description: "ZZ BUILDER", split_count: 2 },
  ],
  ...over,
});

const view = (props = {}) => render(<ProjectDetailView projectId="p1" onBack={() => {}} onOpenItem={() => {}}
  onOpenTransaction={() => {}} {...props} />);
const line = (label) => screen.getByText(label).closest("div");

it("shows the totals from wb_project_summary: spent, received, net, budget left, still due, what-ifs apart", async () => {
  api.getProjectDetail.mockResolvedValue(detail());
  view();
  expect(await screen.findByRole("heading", { name: "ZZ Claim" })).toBeInTheDocument();
  expect(line("Spent")).toHaveTextContent("-$300.00");
  expect(line("Received")).toHaveTextContent("$120.00");
  expect(line("Net")).toHaveTextContent("-$180.00");
  expect(line("Budget left")).toHaveTextContent("$700.00");
  expect(line("Still to pay")).toHaveTextContent("-$250.00");
  expect(line("Still to receive")).toHaveTextContent("$60.00");
  expect(screen.getByText(/What-ifs, not counted/).closest("div")).toHaveTextContent("-$400.00");
  expect(screen.getByText("ZZ note")).toBeInTheDocument();
});

it("says over budget, and planning", async () => {
  api.getProjectDetail.mockResolvedValue(detail({ summary: summary({ budget_left: -50, planning: true }) }));
  view();
  expect(await screen.findByText("Over budget by")).toBeInTheDocument();
  expect(line("Over budget by")).toHaveTextContent("$50.00");
  expect(screen.getByText("Planning")).toBeInTheDocument();
});

it("lists its planned items with what is left, drafts marked What if, each opening item detail", async () => {
  const onOpenItem = jest.fn();
  api.getProjectDetail.mockResolvedValue(detail());
  view({ onOpenItem });
  const s = (await screen.findByRole("heading", { name: /^Planned items/ })).closest("section");
  const rows = within(s).getAllByRole("listitem");
  expect(rows[0]).toHaveTextContent(/ZZ Contractor.*Quoted.*-\$250\.00.*of -\$500\.00/);
  expect(rows[1]).toHaveTextContent(/ZZ Extra.*What if/);
  expect(rows[2]).toHaveTextContent(/ZZ Insurer.*Monthly from/);
  fireEvent.click(within(s).getByText("ZZ Extra"));
  expect(onOpenItem).toHaveBeenCalledWith("i2");
});

it("lists payments newest first, a split one showing its part, each opening the payment", async () => {
  const onOpenTransaction = jest.fn();
  api.getProjectDetail.mockResolvedValue(detail());
  view({ onOpenTransaction });
  const s = (await screen.findByRole("heading", { name: /^Payments/ })).closest("section");
  const rows = within(s).getAllByRole("listitem");
  expect(rows[0]).toHaveTextContent("ZZ INSURER");
  expect(rows[1]).toHaveTextContent(/ZZ BUILDER.*-\$300\.00.*part of -\$400\.00/);
  fireEvent.click(within(s).getByText("ZZ BUILDER"));
  expect(onOpenTransaction).toHaveBeenCalledWith("t1");
});

it("every ? opens its own entry", async () => {
  api.getProjectDetail.mockResolvedValue(detail({ summary: summary({ planning: true }) }));
  view();
  await screen.findByRole("heading", { name: "ZZ Claim" });
  const helps = screen.getAllByRole("button", { name: /^About / }).map((b) => b.getAttribute("aria-label"));
  expect(helps).toEqual(["About Planning", "About Spent, received and net", "About What if", "About Planned items", "About Payments"]);
});

it("has empty states", async () => {
  api.getProjectDetail.mockResolvedValue(detail({ items: [], payments: [], confirmed: [] }));
  view();
  expect(await screen.findByText("No planned items on this project.")).toBeInTheDocument();
  expect(screen.getByText("No payments on this project yet.")).toBeInTheDocument();
});
