import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import ProjectsSection from "./ProjectsSection";
import { estimatedFinish, projectView } from "./projectsModel";

const TODAY = "2026-10-26";
const SETTINGS = { stall_days: 5, overrun_factor: 1.5, active_project_limit: 3 };
const OVERWATCH = {
  group_id: "mvnv8pa2v6zip3xnpm", name: "overwatch-q4n Overwatch", project_code: "overwatch-q4n", has_plan: true,
  effort_estimate: 49, steps_used: 32, last_report_at: "2026-10-26T18:00:00Z", target_date: null,
  where_now: "Phase 6, Step 32", next_step: "Projects section", waiting_on: "testing", waiting_on_kind: "alex",
};
const ESTIMATES = [
  { group_id: OVERWATCH.group_id, kind: "initial", estimate: 40, steps_added: null, at_step: 17, reason: "plan", created_at: "1" },
  { group_id: OVERWATCH.group_id, kind: "scope_increase", estimate: 44, steps_added: 4, at_step: 18, reason: "estimates", created_at: "2" },
];
const DATA = { projects: [OVERWATCH], estimates: ESTIMATES, memberGroupIds: [OVERWATCH.group_id], groupNames: {}, settings: SETTINGS };

const renderSection = (data = DATA) => render(<MemoryRouter><ProjectsSection data={data} today={TODAY} /></MemoryRouter>);

test("a card: link to the group, status lines, steps with the original, scope changes", () => {
  renderSection();
  expect(screen.getByRole("link", { name: "overwatch-q4n Overwatch" })).toHaveAttribute("href", `/groups/detail/${OVERWATCH.group_id}`);
  expect(screen.getByText("32 of 49 steps (original 40)")).toBeInTheDocument();
  expect(screen.getByText("Phase 6, Step 32")).toBeInTheDocument();
  expect(screen.getByText("You: testing")).toBeInTheDocument();
  expect(screen.getByText("Finish unknown")).toBeInTheDocument();
  expect(screen.getByText("+4 at step 18: estimates")).toBeInTheDocument();
  expect(screen.queryByText(/No item or intention yet/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Overrun/)).not.toBeInTheDocument();
});

test("empty group and overrun are red; a stall is said", () => {
  renderSection({ ...DATA, memberGroupIds: [],
    projects: [{ ...OVERWATCH, steps_used: 80, last_report_at: "2026-10-10T00:00:00Z" }] });
  expect(screen.getByText("No item or intention yet")).toHaveClass("text-destructive");
  expect(screen.getByText("Overrun: steps used are past the estimate")).toHaveClass("text-destructive");
  expect(screen.getByText("Stalled: 16 days since the last report")).toBeInTheDocument();
  expect(screen.getByRole("article").className).toContain("border-destructive");
});

test("the whole card is one link to the group; inner link and copy sit above it", () => {
  const { container } = renderSection({ ...DATA, projectIcon: "SquareKanban", groupNames: { g2: "clip-7b Clipboard" },
    projects: [{ ...OVERWATCH, waiting_on_kind: "project", waiting_on_group_id: "g2" }] });
  expect(screen.getByRole("article").className).toContain("relative");
  expect(screen.getByRole("link", { name: "overwatch-q4n Overwatch" }).className).toContain("after:inset-0");
  expect(screen.getByRole("link", { name: "clip-7b Clipboard" }).className).toContain("z-10");
  expect(screen.getByRole("button", { name: "Copy project for an Overwatch chat" }).className).toContain("z-10");
  expect(container.querySelector("h3 svg")).not.toBeNull();
});

test("waiting on another project links to its group", () => {
  renderSection({ ...DATA, groupNames: { g2: "clip-7b Clipboard" },
    projects: [{ ...OVERWATCH, waiting_on_kind: "project", waiting_on_group_id: "g2", waiting_on: "its API" }] });
  expect(screen.getByRole("link", { name: "clip-7b Clipboard" })).toHaveAttribute("href", "/groups/detail/g2");
});

test("the copy: project, facts, ids, group link, the question", async () => {
  Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue() } });
  renderSection();
  fireEvent.click(screen.getByRole("button", { name: "Copy project for an Overwatch chat" }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
  const text = navigator.clipboard.writeText.mock.calls[0][0];
  expect(text.split("\n").slice(0, 2)).toEqual(["Overwatch: project — overwatch-q4n Overwatch", "Where now: Phase 6, Step 32"]);
  expect(text).toContain("Steps: 32 of 49 (original 40)");
  expect(text).toContain("Scope change: +4 at step 18: estimates");
  expect(text).toContain(`group_id: ${OVERWATCH.group_id}, project_code: overwatch-q4n`);
  expect(text).toContain(`https://alfredv5vibe.vercel.app/groups/detail/${OVERWATCH.group_id}`);
  expect(text.endsWith("Where should this project go next?")).toBe(true);
});

test("estimated finish from pace", () => {
  expect(estimatedFinish({ effort_estimate: 49, steps_used: 32, first_report_at: "2026-10-23T12:00:00Z" }, TODAY))
    .toEqual({ label: "Oct 28", day: "2026-10-28" });
  expect(estimatedFinish({ effort_estimate: 49, steps_used: 50, first_report_at: "2026-10-23" }, TODAY).label).toBe("over estimate");
  expect(estimatedFinish({ effort_estimate: 49, steps_used: 32 }, TODAY).label).toBe("unknown");
});

test("missing settings turn their flags off; the count label", () => {
  const v = projectView({ ...OVERWATCH, steps_used: 80, last_report_at: null }, { today: TODAY, settings: {} });
  expect([v.stalledDays, v.overrun, v.original]).toEqual([null, null, null]);
});

test("no active Projects", () => {
  renderSection({ ...DATA, projects: [] });
  expect(screen.getByText("No active Projects.")).toBeInTheDocument();
});
