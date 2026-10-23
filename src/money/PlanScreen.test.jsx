import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";

// Invented data only.
jest.mock("./moneyApi", () => ({ getPlanOverview: jest.fn() }));
jest.mock("./moneyFormat", () => ({ ...jest.requireActual("./moneyFormat"), pacificToday: () => "2031-06-15" }));
const api = require("./moneyApi");
const PlanScreen = require("./PlanScreen").default;

const item = (over) => ({
  id: over.name, name: over.name, project_id: null, amount: -100, due_on: "2031-07-01", interval_count: null,
  interval_unit: null, ends_on: null, stage: "quoted", is_draft: false, amount_tolerance: 0, ...over,
});

beforeEach(() => {
  api.getPlanOverview.mockResolvedValue({
    projects: [
      { project_id: "p1", name: "ZZ Remodel", status: "active", budget: 1000, spent: -300, budget_left: 700, planning: false },
      { project_id: "p2", name: "ZZ Trip", status: "active", budget: null, spent: 0, budget_left: null, planning: true },
      { project_id: "p3", name: "ZZ Old", status: "done", budget: 100, spent: -150, budget_left: -50, planning: false },
    ],
    items: [
      item({ name: "ZZ Tiles", project_id: "p1", amount: -500 }),
      item({ name: "ZZ Hotel", project_id: "p2", stage: "draft", due_on: "2031-12-01" }),
      item({ name: "ZZ Paid one", stage: "paid" }),
      item({ name: "ZZ Late one", due_on: "2031-06-01", stage: "invoiced" }),
      item({ name: "ZZ Premium", interval_count: 1, interval_unit: "month", stage: null, due_on: "2031-01-05" }),
      item({ name: "ZZ Ended", interval_count: 1, interval_unit: "month", stage: null, due_on: "2030-01-05", ends_on: "2030-12-05" }),
      item({ name: "ZZ Side gig", interval_count: 2, interval_unit: "week", stage: null, amount: 40, is_draft: true }),
    ],
    confirmed: [{ planned_item_id: "ZZ Tiles", occurrence_on: null, amount_applied: -200 }],
    missed: [
      { planned_item_id: "ZZ Late one", name: "ZZ Late one", due_on: "2031-06-01", occurrence_on: null, amount: -100,
        confirmed_total: 0, remaining: -100, within_window: true, has_suggestion: false, project_name: null },
      { planned_item_id: "ZZ Premium", name: "ZZ Premium", due_on: "2031-05-05", occurrence_on: "2031-05-05", amount: -100,
        confirmed_total: -40, remaining: -60, within_window: false, has_suggestion: true, project_name: "ZZ Remodel" },
    ],
  });
});

const section = async (title) => (await screen.findByRole("heading", { name: new RegExp(`^${title}`) })).closest("section");

it("lists projects active first, with spent, budget left, over budget and planning", async () => {
  render(<PlanScreen onOpenProject={() => {}} onOpenItem={() => {}} />);
  const rows = within(await section("Projects")).getAllByRole("listitem");
  expect(rows.map((r) => r.textContent)).toEqual([
    expect.stringMatching(/ZZ Remodel.*Spent \$300\.00.*\$700\.00 left/),
    expect.stringMatching(/ZZ Trip.*Planning.*Spent \$0\.00/),
    expect.stringMatching(/ZZ Old.*Done.*Over budget by \$50\.00/),
  ]);
});

it("shows upcoming one-offs with what is left and the stage; drafts are marked What if", async () => {
  render(<PlanScreen onOpenProject={() => {}} onOpenItem={() => {}} />);
  const s = await section("Upcoming");
  const names = within(s).getAllByRole("listitem").map((r) => r.textContent);
  expect(names).toEqual([expect.stringMatching(/ZZ Tiles.*ZZ Remodel.*Quoted.*-\$300\.00.*of -\$500\.00/),
    expect.stringMatching(/ZZ Hotel.*ZZ Trip.*What if/)]);
  expect(within(s).queryByText("ZZ Paid one")).not.toBeInTheDocument();
  expect(within(s).queryByText("ZZ Late one")).not.toBeInTheDocument();
});

it("lists repeating items still running, with their schedule", async () => {
  render(<PlanScreen onOpenProject={() => {}} onOpenItem={() => {}} />);
  const s = await section("Repeating");
  expect(within(s).getByText("ZZ Premium").parentElement).toHaveTextContent("Monthly from Jan 5, 2031");
  expect(within(s).getByText("ZZ Side gig").closest("li")).toHaveTextContent(/Every 2 weeks.*What if/);
  expect(within(s).queryByText("ZZ Ended")).not.toBeInTheDocument();
});

it("lists missed dates read-only, each opening its item, with no Not needed button", async () => {
  const onOpenItem = jest.fn();
  render(<PlanScreen onOpenProject={() => {}} onOpenItem={onOpenItem} />);
  const s = await section("Missed dates");
  expect(within(s).getAllByRole("listitem")).toHaveLength(2);
  expect(within(s).getByText("ZZ Late one").closest("li")).toHaveTextContent(/May still post/);
  expect(within(s).getByText("ZZ Premium").closest("li")).toHaveTextContent(/Suggestion in Review.*-\$60\.00.*of -\$100\.00/);
  expect(within(s).queryByRole("button", { name: /not needed/i })).not.toBeInTheDocument();
  fireEvent.click(within(s).getByText("ZZ Premium"));
  expect(onOpenItem).toHaveBeenCalledWith("ZZ Premium");
});

it("every ? opens its own entry", async () => {
  render(<PlanScreen onOpenProject={() => {}} onOpenItem={() => {}} />);
  await section("Projects");
  const helps = screen.getAllByRole("button", { name: /^About / }).map((b) => b.getAttribute("aria-label"));
  expect(helps).toEqual(["About What if", "About Projects", "About Planning", "About Upcoming", "About Repeating", "About Missed dates"]);
});

it("opens a project", async () => {
  const onOpenProject = jest.fn();
  render(<PlanScreen onOpenProject={onOpenProject} onOpenItem={() => {}} />);
  fireEvent.click(await screen.findByText("ZZ Trip"));
  expect(onOpenProject).toHaveBeenCalledWith("p2");
});
