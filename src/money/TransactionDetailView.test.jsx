import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// Invented data only.
jest.mock("./moneyApi", () => ({
  getTransactionDetail: jest.fn(),
  getTagTree: jest.fn(),
  applyTags: jest.fn(),
  setKind: jest.fn(),
  saveNotes: jest.fn(),
  setReviewed: jest.fn(),
  setTransferPair: jest.fn(),
  findPairCandidates: jest.fn(),
  replaceSplits: jest.fn(),
  getFixPlan: jest.fn(),
  applyFix: jest.fn(),
  getProjectChoices: jest.fn(),
  setTransactionProject: jest.fn(),
}));
const api = require("./moneyApi");
const TransactionDetailView = require("./TransactionDetailView").default;
const { projectOptions, projectSourceLabel } = require("./TransactionDetailView");

beforeEach(() => {
  api.getProjectChoices.mockResolvedValue([
    { id: "p1", name: "ZZ Claim", status: "active" },
    { id: "p2", name: "ZZ Old", status: "done" },
  ]);
  api.setTransactionProject.mockResolvedValue();
});

const TREE = {
  groups: [
    { id: "cat", name: "Category", exclusive: true },
    { id: "lbl", name: "Label", exclusive: false },
  ],
  tags: [
    { id: "food", group_id: "cat", parent_id: null, name: "Food", is_active: true },
    { id: "pets", group_id: "cat", parent_id: null, name: "Pets", is_active: true },
    { id: "sub", group_id: "lbl", parent_id: null, name: "Subscription", is_active: true },
  ],
};
const TXN = {
  id: "t1", account_id: "a1", account_label: "Test Card", txn_date: "2026-01-05", amount: -24, description: "TEST SHOP 0001",
  clean_description: "TEST SHOP", payee: "Test Shop", merchant_id: "m1", merchant_name: "Test Shop", kind: "spend",
  kind_source: "rule", transfer_pair_id: null, transfer_candidate: false, reviewed: false, needs_review: false, notes: null,
  splits: [{ id: "s1", amount: -24, tags: [{ tag_id: "food", source: "rule", rule_id: "r1" }] }],
  excluded_tags: [{ tag_id: "sub", tag_name: "Subscription", rule_id: "r1", source: "manual" }],
  pair: null,
};

beforeEach(() => {
  api.getTransactionDetail.mockResolvedValue(TXN);
  api.getTagTree.mockResolvedValue(TREE);
  api.applyTags.mockResolvedValue({});
  api.setKind.mockResolvedValue();
  api.getFixPlan.mockResolvedValue({
    merchant: { id: "m1", name: "Test Shop", exists: true, add_pattern: null }, pattern: null,
    dry_run: { count: 1, too_narrow: true, samples: [] },
    existing_rules: [{ id: "r1", name: "Test Shop", hit_count: 4 }], warnings: [],
  });
  api.applyFix.mockResolvedValue({ rule_updated: true, merchant_created: false, matched_now: 4 });
});

it("shows a tag removed by hand, and undo adds it back", async () => {
  render(<TransactionDetailView transactionId="t1" onBack={() => {}} onOpenTransaction={() => {}} />);
  expect(await screen.findByText(/removed by you/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
  await waitFor(() => expect(api.applyTags).toHaveBeenCalledWith(["t1"], ["sub"], []));
});

it("removing the Category is allowed, by choosing None", async () => {
  render(<TransactionDetailView transactionId="t1" onBack={() => {}} onOpenTransaction={() => {}} />);
  const cat = await screen.findByLabelText("Category");
  expect(cat).toHaveValue("food");
  fireEvent.change(cat, { target: { value: "" } });
  await waitFor(() => expect(api.applyTags).toHaveBeenCalledWith(["t1"], [], ["food"]));
});

it("after a hand change offers Always do this, which updates the existing rule by default", async () => {
  // After the change, the reload shows the new Category.
  api.getTransactionDetail.mockResolvedValueOnce(TXN).mockResolvedValue({
    ...TXN, splits: [{ id: "s1", amount: -24, tags: [{ tag_id: "pets", source: "manual", rule_id: null }] }],
  });
  render(<TransactionDetailView transactionId="t1" onBack={() => {}} onOpenTransaction={() => {}} />);
  fireEvent.change(await screen.findByLabelText("Category"), { target: { value: "pets" } });
  fireEvent.click(await screen.findByRole("button", { name: "Always do this for Test Shop" }));
  expect(await screen.findByText(/probably too narrow/)).toBeInTheDocument();
  expect(screen.getByLabelText(/Update it \(Test Shop, 4 matches\)/)).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
  await waitFor(() => expect(api.applyFix).toHaveBeenCalledWith(expect.objectContaining({
    transactionId: "t1", updateRuleId: "r1", addNewRule: false,
  })));
  expect(await screen.findByText(/It now matches 4 transactions/)).toBeInTheDocument();
});

it("shows a refusal in plain words", async () => {
  api.setKind.mockRejectedValue(new Error("This is paired as a transfer. Unpair it first."));
  render(<TransactionDetailView transactionId="t1" onBack={() => {}} onOpenTransaction={() => {}} />);
  fireEvent.change(await screen.findByLabelText("Kind"), { target: { value: "fee" } });
  expect(await screen.findByRole("alert")).toHaveTextContent("Unpair it first.");
});

it("project picker: put a single-part payment on a project, or take it off", async () => {
  render(<TransactionDetailView transactionId="t1" onBack={() => {}} onOpenTransaction={() => {}} />);
  const pick = await screen.findByLabelText("Project");
  expect([...pick.options].map((o) => o.textContent)).toEqual(["No project", "ZZ Claim"]);
  expect(screen.getByText("No project", { selector: "p" })).toBeInTheDocument();
  fireEvent.change(pick, { target: { value: "p1" } });
  await waitFor(() => expect(api.setTransactionProject).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }), "p1"));
  api.getTransactionDetail.mockResolvedValue({ ...TXN, splits: [{ ...TXN.splits[0], project_id: "p1", project_source: "manual" }] });
  fireEvent.change(await screen.findByLabelText("Project"), { target: { value: "" } });
  await waitFor(() => expect(api.setTransactionProject).toHaveBeenLastCalledWith(expect.objectContaining({ id: "t1" }), null));
});

it("project picker: a split payment says ask Claude instead", async () => {
  api.getTransactionDetail.mockResolvedValue({ ...TXN, splits: [{ id: "a", amount: -10, tags: [] }, { id: "b", amount: -14, tags: [] }] });
  render(<TransactionDetailView transactionId="t1" onBack={() => {}} onOpenTransaction={() => {}} />);
  expect(await screen.findByText(/Split payment: ask Claude/)).toBeInTheDocument();
  expect(screen.queryByLabelText("Project")).not.toBeInTheDocument();
});

it("project picker: keeps a done project that is set, and says who set it", () => {
  const projects = [{ id: "p1", name: "A", status: "active" }, { id: "p2", name: "B", status: "done" }];
  expect(projectOptions(projects, "p2").map((p) => p.id)).toEqual(["p1", "p2"]);
  expect(projectOptions(projects, null).map((p) => p.id)).toEqual(["p1"]);
  expect(projectSourceLabel({ project_id: "p1", project_source: "rule" })).toBe("Set by a rule");
  expect(projectSourceLabel({ project_id: "p1", project_source: "manual" })).toBe("Set by hand");
  expect(projectSourceLabel({ project_id: null, project_source: "manual" })).toMatch(/Taken off by hand; no rule puts one back/);
  expect(projectSourceLabel({ project_id: null, project_source: null })).toBe("No project");
});
