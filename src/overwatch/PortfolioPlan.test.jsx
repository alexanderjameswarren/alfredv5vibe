import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import ProjectsSection from "./ProjectsSection";
import { pickPortfolio, portfolioView, sliceCopy } from "./portfolioModel";
import { overwatchCopyText } from "./overwatchCopy";

const TODAY = "2026-10-28";
const PF = { id: "pf1", name: "Alfred ecosystem", context_ids: ["ctx-alfred"], position: 0 };
const CLIENT = { id: "pf2", name: "Client work", context_ids: ["ctx-client"], position: 1 };
const progress = (id, name, extra = {}) => ({
  group_id: id, name, group_status: "active", context_id: "ctx-alfred", project_code: null, has_plan: false,
  effort_estimate: null, steps_used: 0, last_report_at: null, ...extra,
});
const PORTFOLIOS = {
  portfolios: [PF, CLIENT],
  plans: [{ id: "plan1", portfolio_id: "pf1", theory: "Bugs first." }],
  lanes: [{ id: "L2", plan_id: "plan1", name: "SAM", position: 2 }, { id: "L1", plan_id: "plan1", name: "Main", position: 1 },
    { id: "L3", plan_id: "plan1", name: "Quiet", position: 3 }],
  slices: [
    { id: "s1", plan_id: "plan1", lane_id: "L1", position: 1, group_id: "gA", phases: "Phases 1 and 2", why: "unblocks B", status: "done" },
    { id: "s2", plan_id: "plan1", lane_id: "L1", position: 2, group_id: "gB", phases: null, why: "the heavy one", status: "in_progress" },
    { id: "s3", plan_id: "plan1", lane_id: "L1", position: 3, group_id: "gA", phases: "Phase 3", why: null, status: "planned" },
    { id: "s4", plan_id: "plan1", lane_id: "L1", position: 4, group_id: "gC", phases: null, why: null, status: "paused",
      paused_reason: "client first" },
    { id: "s5", plan_id: "plan1", lane_id: "L2", position: 1, group_id: "gS", phases: "Phase 2", why: null, status: "planned" },
    { id: "s6", plan_id: "plan1", lane_id: "L1", position: 5, group_id: "gD", phases: null, why: null, status: "planned" },
  ],
  progress: [progress("gA", "Alpha"), progress("gB", "Beta", { project_code: "beta-b1" }), progress("gS", "Sam import"),
    progress("gN", "Not planned yet", { group_status: "someday" }), progress("gX", "Elsewhere", { context_id: "ctx-other" })],
  groupNames: { gC: "Closed C", gD: "Closed D" },
};
const PROJECTS = { projects: [], estimates: [], memberGroupIds: ["gB"], groupNames: {}, settings: {}, projectIcon: "SquareKanban" };

beforeEach(() => window.localStorage.clear());

const renderPlan = (portfolios = PORTFOLIOS) => render(
  <MemoryRouter><ProjectsSection data={PROJECTS} portfolios={portfolios} today={TODAY} /></MemoryRouter>,
);

test("portfolioView: Now per lane, the first planned per lane is Next, the rest Later, done counted", () => {
  const v = portfolioView(PF, PORTFOLIOS);
  expect(v.now.map((n) => [n.lane.name, n.slice?.id ?? null])).toEqual([["Main", "s2"], ["SAM", null], ["Quiet", null]]);
  expect(v.next.map((n) => [n.lane.name, n.slice.id])).toEqual([["Main", "s3"], ["SAM", "s5"]]);
  expect(v.later.map((l) => [l.lane.name, l.slices.map((s) => s.id), l.done])).toEqual([["Main", ["s4", "s6"], 1]]);
  expect(v.notInPlan.map((p) => p.group_id)).toEqual(["gN"]);
  expect(v.later[0].slices[0].name).toBe("Closed C");
});

test("pickPortfolio: the remembered one if it is still there, else the first", () => {
  expect(pickPortfolio([PF, CLIENT], "pf2")).toBe(CLIENT);
  expect(pickPortfolio([PF, CLIENT], "gone")).toBe(PF);
});

test("sliceCopy names the slice, its plan, lane, status and ids", () => {
  const s = portfolioView(PF, PORTFOLIOS).later[0].slices[0];
  const text = overwatchCopyText(sliceCopy(s, "Alfred ecosystem"));
  expect(text).toMatch(/^Overwatch: slice — Closed C of the Alfred ecosystem plan/);
  expect(text).toMatch(/Lane: Main\nStatus: Paused \(client first\)/);
  expect(text).toMatch(/slice_id: s4, group_id: gC, plan_id: plan1/);
  expect(text).toMatch(/What should I do about this\?$/);
});

test("the plan renders Now, Next, Later and Not in the plan, every slice a real link", () => {
  renderPlan();
  const now = screen.getByRole("region", { name: "Now" });
  expect(within(now).getByRole("link", { name: "Beta" })).toHaveAttribute("href", "/groups/detail/gB");
  expect(within(now).getByText("the heavy one")).toBeInTheDocument();
  expect(within(now).getAllByText(/Nothing in progress/)).toHaveLength(2);
  const next = screen.getByRole("region", { name: "Next" });
  expect(within(next).getByRole("link", { name: "Alpha (Phase 3)" })).toBeInTheDocument();
  expect(within(next).getByRole("link", { name: "Sam import (Phase 2)" })).toBeInTheDocument();
  const later = screen.getByRole("region", { name: "Later in Main" });
  expect(within(later).getByText("Paused: client first")).toBeInTheDocument();
  expect(within(later).getByText("1 done")).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Not in the plan" })).getByRole("link", { name: "Not planned yet" }))
    .toBeInTheDocument();
  expect(screen.queryByText("Elsewhere")).not.toBeInTheDocument();
});

test("one copy button per group: 2 or more copy on the heading, a group of 1 on its row", () => {
  renderPlan();
  const copies = (name) => within(screen.getByRole("region", { name })).getAllByRole("button", { name: /^Copy/ });
  expect(copies("Now")).toHaveLength(1);
  expect(copies("Next")).toHaveLength(1);
  expect(copies("Later in Main")).toHaveLength(1);
  expect(copies("Not in the plan")).toHaveLength(1);
});

test("the switch remembers the portfolio; one with no plan says so and shows the active cards", () => {
  renderPlan();
  expect(screen.getByRole("button", { name: "Alfred ecosystem" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Client work" }));
  expect(screen.getByText("No plan for Client work yet.")).toBeInTheDocument();
  expect(screen.getByText("No active Projects.")).toBeInTheDocument();
  expect(window.localStorage.getItem("overwatch.portfolio")).toBe("pf2");
});

test("no portfolios: the active Project cards as before", () => {
  renderPlan({ portfolios: [], plans: [], lanes: [], slices: [], progress: [], groupNames: {} });
  expect(screen.queryByRole("group", { name: "Portfolio" })).not.toBeInTheDocument();
  expect(screen.getByText("No active Projects.")).toBeInTheDocument();
});
