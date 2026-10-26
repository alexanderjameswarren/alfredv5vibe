import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import OverwatchPage from "./OverwatchPage";
import OverwatchSection from "./OverwatchSection";
import ActionRequiredSection, { displayTitle, kindLabel } from "./ActionRequiredSection";
import { stripTitle } from "./BriefingSection";
import * as api from "./overwatchApi";

jest.mock("./overwatchApi", () => ({
  ...jest.requireActual("./overwatchApi"),
  getNotes: jest.fn(),
  getNote: jest.fn(),
  getNeedsYou: jest.fn(),
  getLatestRuns: jest.fn(),
  getRunForNote: jest.fn(),
  getProjects: jest.fn(),
  getQuiet: jest.fn(),
  getIdeas: jest.fn(),
  getIdeaRecords: jest.fn(),
  getApps: jest.fn(),
  getOpenFriction: jest.fn(),
}));

const NIGHTLY = { id: "n1", period: "nightly", for_date: "2026-10-26",
  body: "Overwatch nightly, 2026-10-26\n## Action Required\n- one stalled" };
const WEEKLY = { id: "w1", period: "weekly", for_date: "2026-10-26", body: "## Action Required\n- week" };
const RUN = { id: "r1", job: "nightly", status: "ok", finished_at: new Date().toISOString(), details: {} };
const ITEM = {
  id: "458af39a-72ab-4027-a161-963524e292dd", captured_text: "Overwatch: overdue — 2026-10-25\nMissed",
  created_at: "2026-10-25T11:30:00Z", source_type: "task", source_metadata: { kind: "overdue" },
};

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}
const renderAt = (path, ui = <OverwatchPage />) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/overwatch/*" element={ui} />
      <Route path="*" element={<Where />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  api.getNotes.mockResolvedValue({ nightly: NIGHTLY, weekly: null });
  api.getNote.mockResolvedValue(WEEKLY);
  api.getNeedsYou.mockResolvedValue([ITEM]);
  api.getLatestRuns.mockResolvedValue({ nightly: RUN, weekly: null });
  api.getRunForNote.mockResolvedValue(RUN);
  api.getProjects.mockResolvedValue({ projects: [], estimates: [], memberGroupIds: [], groupNames: {},
    settings: { active_project_limit: 3 } });
  api.getQuiet.mockResolvedValue({ lastActivity: [], profiles: [{ app_id: "jobs", rhythm_days: 7 }], watch: [] });
  api.getIdeas.mockResolvedValue([]);
  api.getIdeaRecords.mockResolvedValue({ records: [], contexts: [], alfredContextId: null, groupedIds: [] });
  api.getApps.mockResolvedValue([{ id: "warren_buffet", name: "Warren Buffet", icon: "Wallet", path: "/money" }]);
  api.getOpenFriction.mockResolvedValue({ entries: [{ id: "f1", process: "todos", occurred_at: "2026-10-25T10:00:00Z",
    what_happened: "x" }], settings: {} });
  Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue() } });
});

test("live tab: just the title, the status line, six sections; Action Required and Projects open", async () => {
  renderAt("/overwatch");
  const status = await screen.findByRole("link", { name: /Report as of .* · everything scanned/ });
  expect(status).toHaveAttribute("href", "/overwatch/briefing");
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/^Overwatch$/);
  expect(screen.queryByText(/What needs you/)).not.toBeInTheDocument();
  expect(screen.queryByText("one stalled")).not.toBeInTheDocument();
  const order = screen.getAllByRole("region").map((r) => r.getAttribute("aria-labelledby"));
  expect(order).toEqual(["overwatch-action-required", "overwatch-projects", "overwatch-quiet",
    "overwatch-activity", "overwatch-ideas", "overwatch-friction"]);
  for (const t of ["Action Required (1)", "Active Projects (0)"]) {
    expect(screen.getByRole("button", { name: t })).toHaveAttribute("aria-expanded", "true");
  }
  // Jobs has a rhythm and no activity anywhere: one quiet app, the section collapsed.
  expect(screen.getByRole("button", { name: "Quiet lately (1)" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("button", { name: "Ideas (0)" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("button", { name: "Friction (1)" })).toHaveAttribute("aria-expanded", "false");
});

test("a new apps row groups its tagged ideas with no code change (apps are read live)", async () => {
  api.getApps.mockResolvedValue([{ id: "pickleball", name: "Pickleball", icon: "NotAnIcon", path: null }]);
  api.getIdeaRecords.mockResolvedValue({ alfredContextId: "ca", groupedIds: [], contexts: [{ id: "ca", name: "Alfred" }],
    records: [{ id: "n1", name: "Court finder", type: "intention", context_id: "ca", tags: ["pickleball"], created_at: "2026-10-20" }] });
  renderAt("/overwatch");
  fireEvent.click(await screen.findByRole("button", { name: "Ideas (1)" }));
  expect(screen.getByRole("button", { name: /Pickleball \(1\)/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /No app/ })).not.toBeInTheDocument();
});

test("a skipped part reads 'partially scanned', with the app's name", async () => {
  api.getLatestRuns.mockResolvedValue({ nightly: { ...RUN, details: { skipped: [{ part: "pull:warren_buffet" }] } }, weekly: null });
  renderAt("/overwatch");
  expect(await screen.findByRole("link", { name: /partially scanned: Money not checked/ })).toBeInTheDocument();
});

test("a failed run: red 'Scan failed · see Action Required'", async () => {
  api.getLatestRuns.mockResolvedValue({ nightly: { ...RUN, status: "failed" }, weekly: null });
  renderAt("/overwatch");
  const link = await screen.findByRole("link", { name: "Scan failed · see Action Required" });
  expect(link.className).toContain("text-destructive");
});

test("the status line copies the latest briefing", async () => {
  renderAt("/overwatch");
  await screen.findByRole("link", { name: /Report as of/ });
  fireEvent.click(screen.getByRole("button", { name: "Copy nightly briefing 2026-10-26 for an Overwatch chat" }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
  expect(navigator.clipboard.writeText.mock.calls[0][0]).toBe([
    "Overwatch: nightly briefing 2026-10-26",
    "## Action Required\n- one stalled",
    "note_id: n1, run_id: r1",
    "https://alfredv5vibe.vercel.app/overwatch/briefing/n1",
    "",
    "Let's go through this briefing.",
  ].join("\n"));
});

test("/overwatch/briefing: Briefing page, one header per note linking to its own URL, title line stripped", async () => {
  api.getNotes.mockResolvedValue({ nightly: NIGHTLY, weekly: WEEKLY });
  renderAt("/overwatch/briefing");
  expect(await screen.findByRole("heading", { name: "Briefing", level: 2 })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Nightly briefing · Mon, Oct 26" })).toHaveAttribute("href", "/overwatch/briefing/n1");
  expect(screen.getByRole("link", { name: "Weekly briefing · Mon, Oct 26" })).toHaveAttribute("href", "/overwatch/briefing/w1");
  expect(screen.queryByText(/Overwatch nightly, 2026-10-26/)).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/overwatch");
});

test("/overwatch/briefing/<id> shows that one; an unknown id says so", async () => {
  renderAt("/overwatch/briefing/w1");
  expect(await screen.findByRole("link", { name: "Weekly briefing · Mon, Oct 26" })).toBeInTheDocument();
  expect(api.getNote).toHaveBeenCalledWith("w1");
  api.getNote.mockResolvedValue(null);
  renderAt("/overwatch/briefing/nope");
  expect(await screen.findByText("That briefing was not found.")).toBeInTheDocument();
});

test("stripTitle drops only a leading Overwatch title line", () => {
  expect(stripTitle("\n# Overwatch weekly, 2026-10-26\n## Action Required")).toBe("## Action Required");
  expect(stripTitle("## Action Required\n- Overwatch nightly ran")).toBe("## Action Required\n- Overwatch nightly ran");
  expect(stripTitle("**Overwatch nightly, 2026-10-26**\n\n**Needs you**")).toBe("**Needs you**");
});

test("a section toggles open and shows its count", () => {
  render(<OverwatchSection id="x" title="Friction" count={3}><p>inside</p></OverwatchSection>);
  expect(screen.queryByText("inside")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Friction (3)" }));
  expect(screen.getByText("inside")).toBeInTheDocument();
});

test("action required: a short title as a real link over the row, red when overdue; the copy keeps the full line", async () => {
  renderAt("/overwatch/x", <ActionRequiredSection rows={[ITEM]} />);
  const link = screen.getByRole("link", { name: "Overdue" });
  expect(link).toHaveAttribute("href", `/inbox/detail/${ITEM.id}`);
  expect(link.className).toContain("text-destructive");
  expect(screen.getByRole("article").className).toContain("border-destructive");
  fireEvent.click(screen.getByRole("button", { name: "Copy inbox item for an Overwatch chat" }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
  const text = navigator.clipboard.writeText.mock.calls[0][0];
  expect(text.startsWith("Overwatch: inbox item — Overwatch: overdue — 2026-10-25")).toBe(true);
  expect(text).toContain(`inbox_id: ${ITEM.id}`);
  fireEvent.click(link);
  expect(screen.getByTestId("where")).toHaveTextContent(`/inbox/detail/${ITEM.id}`);
});

test("display titles, kind labels, a non-urgent row, empty", () => {
  expect(displayTitle("Overwatch: status request for clip-7b — stalled 6 days")).toBe("Status request for clip-7b — stalled 6 days");
  expect(displayTitle("Overwatch: fading — 2026-10-26")).toBe("Fading");
  expect(displayTitle("Overwatch: friction fix for todos — 3 entries")).toBe("Friction fix for todos — 3 entries");
  expect(kindLabel("status_request")).toBe("Status request");
  expect(kindLabel(undefined)).toBe("Task");
  renderAt("/overwatch/x", <ActionRequiredSection rows={[{ ...ITEM, source_metadata: { kind: "fading" } }]} />);
  expect(screen.getByRole("link").className).not.toContain("text-destructive");
});

test("action required: empty", () => {
  renderAt("/overwatch/x", <ActionRequiredSection rows={[]} />);
  expect(screen.getByText(/Nothing from Overwatch/)).toBeInTheDocument();
});
