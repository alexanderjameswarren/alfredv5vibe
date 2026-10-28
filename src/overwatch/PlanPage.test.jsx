import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import PlanPage from "./PlanPage";
import SliceStatusPage from "./SliceStatusPage";
import * as api from "./overwatchApi";
import { planCopy, planLanes } from "./planPageModel";
import { overwatchCopyText } from "./overwatchCopy";

jest.mock("./overwatchApi", () => ({
  ...jest.requireActual("./overwatchApi"),
  getPlanPage: jest.fn(),
  getSlice: jest.fn(),
  updateSliceStatus: jest.fn(),
}));

const PF = { id: "pf1", name: "Alfred ecosystem", archived: false };
const V2 = { id: "p2", portfolio_id: "pf1", active: true, theory: "Bugs first.\nThen tools.", notes_for_next_review: "After Homer",
  review_by: "2020-01-01", reason: "Homer moved up", written_by: "alex", created_at: "2026-10-28T10:00:00Z" };
const V1 = { ...V2, id: "p1", active: false, reason: "First plan", written_by: "overwatch", created_at: "2026-10-20T10:00:00Z" };
const PAGE = {
  portfolio: PF, plan: V2, versions: [V2, V1],
  lanes: [{ id: "L2", name: "SAM", position: 2, note: null }, { id: "L1", name: "Main", position: 1, note: "the heavy work" }],
  slices: [
    { id: "s1", lane_id: "L1", position: 1, group_id: "gA", phases: "Phase 8", why: "finish planning", status: "in_progress" },
    { id: "s2", lane_id: "L2", position: 1, group_id: "gS", phases: "Phase 2", why: null, status: "paused", paused_reason: "waiting" },
  ],
  groups: { gA: { name: "Overwatch", project_code: "overwatch-q4n" }, gS: { name: "SAM import", project_code: null } },
};

const renderPlan = (planId = null) => render(<MemoryRouter><PlanPage portfolioId="pf1" planId={planId} /></MemoryRouter>);

test("the active version: theory, review_by red once passed, lanes in order, slices linked, versions", async () => {
  api.getPlanPage.mockResolvedValue(PAGE);
  renderPlan();
  expect(await screen.findByText("Alfred ecosystem plan")).toBeInTheDocument();
  expect(screen.getByText(/Bugs first\.\s+Then tools\./)).toBeInTheDocument();
  expect(screen.getByText(/\(passed\)/)).toHaveClass("text-destructive");
  expect(screen.getAllByRole("region", { name: /^Lane / }).map((r) => r.getAttribute("aria-label"))).toEqual(["Lane Main", "Lane SAM"]);
  expect(screen.getByText("the heavy work")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Overwatch (Phase 8)" })).toHaveAttribute("href", "/groups/detail/gA");
  expect(screen.getByText("Paused: waiting")).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: "Change status" })[0]).toHaveAttribute("href", "/overwatch/plan/pf1/slice/s1");
  const versions = within(screen.getByRole("region", { name: "Earlier versions" })).getAllByRole("link");
  expect(versions.map((l) => l.getAttribute("href"))).toEqual(["/overwatch/plan/pf1/version/p1"]);
  expect(screen.getAllByRole("button", { name: /^Copy/ })).toHaveLength(1);
});

test("an older version lists the others, the active one labelled and linking to the current plan", async () => {
  api.getPlanPage.mockResolvedValue({ ...PAGE, plan: V1 });
  renderPlan("p1");
  const others = within(await screen.findByRole("region", { name: "Other versions" })).getAllByRole("link");
  expect(others.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([["Oct 28 · Alex · Active", "/overwatch/plan/pf1"]]);
});

test("a plan with one version shows no version list", async () => {
  api.getPlanPage.mockResolvedValue({ ...PAGE, versions: [V2] });
  renderPlan();
  await screen.findByText("Alfred ecosystem plan");
  expect(screen.queryByRole("region", { name: /versions/i })).not.toBeInTheDocument();
});

test("an older version is read only, with a link to the current plan", async () => {
  api.getPlanPage.mockResolvedValue({ ...PAGE, plan: V1 });
  renderPlan("p1");
  expect(await screen.findByText(/An older version, read only/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open the current plan" })).toHaveAttribute("href", "/overwatch/plan/pf1");
  expect(screen.queryByRole("link", { name: "Change status" })).not.toBeInTheDocument();
});

test("no plan, and a version not found, say so", async () => {
  api.getPlanPage.mockResolvedValue({ ...PAGE, plan: null });
  renderPlan("gone");
  expect(await screen.findByText("That version of the Alfred ecosystem plan was not found.")).toBeInTheDocument();
});

test("planCopy: the portfolio plan, theory, slices and the question", () => {
  const text = overwatchCopyText(planCopy(PF, V2, planLanes(PAGE)));
  expect(text).toMatch(/^Overwatch: Alfred ecosystem plan\nTheory:\nBugs first\.\nThen tools\./);
  expect(text).toMatch(/Lane Main:\n {2}1\. Overwatch \(Phase 8\): In progress — finish planning \(group_id: gA\)/);
  expect(text).toMatch(/Lane SAM:\n {2}1\. SAM import \(Phase 2\): Paused \(waiting\) \(group_id: gS\)/);
  expect(text).toMatch(/portfolio_id: pf1, plan_id: p2\nhttps:\/\/alfredv5vibe\.vercel\.app\/overwatch\/plan\/pf1\n\nLet's review this plan\.$/);
});

const SLICE = { id: "s1", plan_id: "p2", lane_id: "L1", group_id: "gA", phases: "Phase 8", status: "in_progress",
  paused_reason: null, lane: "Main", plan: { id: "p2", active: true }, group: { name: "Overwatch" } };

const renderSlice = () => render(
  <MemoryRouter initialEntries={["/overwatch/plan/pf1/slice/s1"]}>
    <Routes>
      <Route path="/overwatch/plan/:pf" element={<p>the plan page</p>} />
      <Route path="*" element={<SliceStatusPage portfolioId="pf1" sliceId="s1" />} />
    </Routes>
  </MemoryRouter>,
);

test("slice status: paused needs a reason; Save writes and returns to the plan", async () => {
  api.getSlice.mockResolvedValue(SLICE);
  api.updateSliceStatus.mockResolvedValue({});
  renderSlice();
  fireEvent.click(await screen.findByLabelText("Paused"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent("A paused slice needs a reason.");
  expect(api.updateSliceStatus).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Why it is paused"), { target: { value: " client first " } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(api.updateSliceStatus).toHaveBeenCalledWith("s1", "paused", "client first"));
  expect(await screen.findByText("the plan page")).toBeInTheDocument();
});

test("slice status: the guard's refusal shows in plain words; Cancel goes back", async () => {
  api.getSlice.mockResolvedValue({ ...SLICE, status: "planned" });
  api.updateSliceStatus.mockRejectedValue(new Error("That lane already has a slice in progress. Mark that one done or paused first."));
  renderSlice();
  fireEvent.click(await screen.findByLabelText("In progress"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("already has a slice in progress");
  const buttons = screen.getAllByRole("button").map((b) => b.textContent);
  expect(buttons.indexOf("Save")).toBeLessThan(buttons.indexOf("Cancel"));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await screen.findByText("the plan page")).toBeInTheDocument();
});

test("slice status: a superseded version's slice is read only", async () => {
  api.getSlice.mockResolvedValue({ ...SLICE, plan: { id: "p1", active: false } });
  renderSlice();
  expect(await screen.findByText(/older version of the plan, which is read only/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
});

test("sliceErrorText puts the database's refusals in plain words", () => {
  const { sliceErrorText } = jest.requireActual("./overwatchApi");
  expect(sliceErrorText({ code: "23505", message: "portfolio_slices_one_in_progress" })).toMatch(/already has a slice in progress/);
  expect(sliceErrorText({ code: "23514", message: "portfolio_slices: this plan version has been superseded and is frozen." }))
    .toMatch(/has been replaced/);
  expect(sliceErrorText({ code: "23514", message: "violates check constraint \"portfolio_slices_paused_reason\"" }))
    .toMatch(/needs a reason/);
  expect(sliceErrorText({ message: "network" })).toMatch(/not saved/);
});
