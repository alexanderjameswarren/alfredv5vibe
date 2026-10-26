import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import ActivitySection from "./ActivitySection";
import {
  activityCopy, dayEntries, dayLabel, emptyText, fullDay, groupRows, projectTitle, rowDay, rowPath, rowTime, sourceLabel,
  stepRange, timeLabel, timeRange,
} from "./activityModel";
import { overwatchCopyText } from "./overwatchCopy";
import { pacificToday } from "../money/moneyFormat";
import * as api from "./overwatchApi";

jest.mock("./overwatchApi", () => ({
  ...jest.requireActual("./overwatchApi"), getActivityDay: jest.fn(), getActivityGroupInfo: jest.fn(),
  getApps: jest.fn(),
}));
const APPS = [
  { id: "sam", name: "Sam", icon: "Music", path: "/sam" },
  { id: "warren_buffet", name: "Warren Buffet", icon: "Wallet", path: "/money" },
];

const at = "2026-10-26T11:28:00Z"; // 4:28 am Pacific
const pass = (id) => ({ id, occurred_at: at, app_id: "sam", kind: "progress", title: "practice pass", source: "nightly",
  target_type: "other", target_id: null });
const ROWS = [
  { id: "a", occurred_at: at, app_id: "warren_buffet", kind: "used", title: "Reviewed 14 transactions", source: "claude",
    source_ref: "chat-1", target_type: "group", target_id: "g1" },
  pass("p1"), pass("p2"), pass("p3"),
];

const renderIt = () => render(<MemoryRouter><ActivitySection /></MemoryRouter>);

beforeEach(() => {
  api.getActivityDay.mockReset();
  api.getActivityDay.mockResolvedValue(ROWS);
  api.getApps.mockResolvedValue(APPS);
  api.getActivityGroupInfo.mockResolvedValue({ names: { g9: "Overwatch" }, projectIcon: "SquareKanban" });
  Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue() } });
});

test("labels: day, time, source, links", () => {
  expect(dayLabel("2026-10-26", "2026-10-26")).toBe("Today");
  expect(dayLabel("2026-10-25", "2026-10-26")).toBe("Yesterday");
  expect(dayLabel("2026-10-23", "2026-10-26")).toBe("Fri, Oct 23");
  expect(timeLabel(at)).toBe("4:28 am");
  expect([sourceLabel("nightly"), sourceLabel("trigger"), sourceLabel("cli")]).toEqual([null, "Alfred", "CLI"]);
  expect(rowPath({ target_type: "group", target_id: "g1" })).toBe("/groups/detail/g1");
  expect(rowPath({ target_type: "intention", target_id: "mv7fwa71xlox5paxe2" })).toBe("/mv7fwa71xlox5paxe2");
  expect(rowPath({ target_type: "other", target_id: "x" })).toBeNull();
  expect(emptyText("Today", [])).toBe("Nothing logged today.");
  expect(emptyText("Fri, Oct 23", ["Sam", "Progress"])).toBe("Nothing for Sam, Progress on Fri, Oct 23.");
  expect(groupRows(ROWS).map((g) => g.rows.length)).toEqual([1, 3]);
});

const dayOffset = (n) => new Date(Date.parse(`${pacificToday()}T12:00:00Z`) - n * 864e5).toISOString().slice(0, 10);

test("opens on yesterday; Later goes to Today and stops there", async () => {
  renderIt();
  expect(screen.getByRole("heading", { name: "Yesterday" })).toBeInTheDocument();
  expect(api.getActivityDay).toHaveBeenCalledWith(dayOffset(1));
  const later = screen.getByRole("button", { name: /Later/ });
  expect(later).not.toBeDisabled();
  fireEvent.click(later);
  expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Later/ })).toBeDisabled();
  await screen.findByText("Sam: practice pass ×3");
});

test("a linked row, a grouped busy row that expands, chips; nightly rows say Logged overnight", async () => {
  renderIt();
  const link = await screen.findByRole("link", { name: "Reviewed 14 transactions" });
  expect(link).toHaveAttribute("href", "/groups/detail/g1");
  expect(link.className).toContain("after:inset-0");
  expect(screen.getByText("Claude")).toBeInTheDocument();
  expect(screen.getByText("Sam: practice pass ×3")).toBeInTheDocument();
  expect(screen.queryAllByText("practice pass")).toHaveLength(0);
  expect(screen.getByText("Logged overnight")).toBeInTheDocument();
  expect(screen.getByText("4:28 am")).toBeInTheDocument();
  // Two copy buttons: the Money row (alone) and the Sam group's header.
  expect(screen.getAllByRole("button", { name: "Copy activity for an Overwatch chat" })).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Show all 3" }));
  expect(screen.getAllByText("practice pass")).toHaveLength(3);
  expect(screen.getAllByText("Logged overnight")).toHaveLength(4);
  expect(screen.getAllByRole("button", { name: "Copy activity for an Overwatch chat" })).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("button", { name: "Copy activity for an Overwatch chat" })[1]);
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
  expect(navigator.clipboard.writeText.mock.calls[0][0].split("\n")[0])
    .toMatch(/^Overwatch: activity — Sam: practice pass ×3, \w{3}, \w{3} \d+$/);
  expect(screen.getByRole("button", { name: "Money (1)" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Progress (3)" })).toBeInTheDocument();
});

test("filters narrow the day and persist while paging; an empty filtered day says so", async () => {
  renderIt();
  await screen.findByText("Sam: practice pass ×3");
  fireEvent.click(screen.getByRole("button", { name: "Money (1)" }));
  expect(screen.queryByText("Sam: practice pass ×3")).not.toBeInTheDocument();
  api.getActivityDay.mockResolvedValue([pass("p9")]);
  fireEvent.click(screen.getByRole("button", { name: /Earlier/ }));
  expect(await screen.findByText(/^Nothing for Money on /)).toBeInTheDocument();
  expect(api.getActivityDay).toHaveBeenLastCalledWith(dayOffset(2));
});

const report = (id, step, time, kind = "progress") => ({
  id, occurred_at: `2026-10-24T${time}:00Z`, app_id: "sam", kind, title: `Overwatch Step ${step}: built`,
  source: "cli", source_ref: `overwatch-q4n-s${step}-abcd`, group_id: "g9", target_type: "group", target_id: "g9",
});
const PROJECT_ROWS = [report("r3", 14, "22:55"), report("r2", 12, "22:00"), report("r1", 11, "21:32")];

test("project grouping: title, step range, time range, single rows stay", () => {
  const single = { ...pass("p1"), occurred_at: "2026-10-24T20:00:00Z", group_id: "g2" };
  const entries = dayEntries([...PROJECT_ROWS, single]);
  expect(entries.map((e) => [e.type, e.rows.length])).toEqual([["project", 3], ["rows", 1]]);
  expect(projectTitle("Overwatch", PROJECT_ROWS)).toBe("Overwatch: 3 progress reports, Steps 11 to 14");
  expect(projectTitle("Overwatch", [...PROJECT_ROWS, { ...report("r4", 15, "23:00"), kind: "done" }]))
    .toBe("Overwatch: 4 updates, Steps 11 to 15");
  expect(stepRange([...PROJECT_ROWS, { title: "Checkpoint" }])).toBe("");
  expect(timeRange(PROJECT_ROWS)).toBe("2:32 pm to 3:55 pm");
});

test("a project row: a real link to the group; the chevron expands in place; its own copy", async () => {
  api.getActivityDay.mockResolvedValue(PROJECT_ROWS);
  render(<MemoryRouter><ActivitySection initialDay="2026-10-24" /></MemoryRouter>);
  const link = await screen.findByRole("link", { name: "Overwatch: 3 progress reports, Steps 11 to 14" });
  expect(link).toHaveAttribute("href", "/groups/detail/g9");
  expect(link.className).toContain("after:inset-0");
  expect(screen.getByText("2:32 pm to 3:55 pm")).toBeInTheDocument();
  expect(api.getActivityGroupInfo).toHaveBeenCalledWith(["g9"]);
  const chevron = screen.getByRole("button", { name: "Show all 3" });
  expect(chevron.className).toContain("z-10");
  fireEvent.click(chevron);
  expect(screen.getAllByRole("link", { name: /Overwatch Step \d+: built/ })).toHaveLength(3);
  // The copy rule: the group copies once; its expanded rows have no copy buttons.
  const copies = screen.getAllByRole("button", { name: "Copy activity for an Overwatch chat" });
  expect(copies).toHaveLength(1);
  fireEvent.click(copies[0]);
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
  expect(navigator.clipboard.writeText.mock.calls[0][0]).toBe([
    "Overwatch: activity — Overwatch, Sat, Oct 24", "3 rows", "Steps 11 to 14",
    "https://alfredv5vibe.vercel.app/groups/detail/g9", "", "Where does this project stand now?",
  ].join("\n"));
});

test("chips count the underlying rows; filtering applies before grouping", async () => {
  api.getActivityDay.mockResolvedValue([...PROJECT_ROWS, { ...report("d1", 13, "22:10"), kind: "done" }]);
  render(<MemoryRouter><ActivitySection initialDay="2026-10-24" /></MemoryRouter>);
  await screen.findByRole("link", { name: "Overwatch: 4 updates, Steps 11 to 14" });
  expect(screen.getByRole("button", { name: "Progress (3)" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Done (1)" }));
  expect(screen.getByRole("link", { name: "Overwatch Step 13: built" })).toBeInTheDocument();
});

test("an empty day", async () => {
  api.getActivityDay.mockResolvedValue([]);
  renderIt();
  expect(await screen.findByText("Nothing logged yesterday.")).toBeInTheDocument();
});

test("nightly rows: their day comes from source_ref; copy has the date and no time", () => {
  const row = { ...pass("n1"), source_ref: "sam:2026-10-24", occurred_at: "2026-10-25T18:39:58Z" };
  expect(rowDay(row)).toBe("2026-10-24");
  expect(rowDay({ ...row, source: "cli" })).toBe("2026-10-25");
  expect(rowTime(row)).toBe("Logged overnight");
  expect(overwatchCopyText(activityCopy(row, "Sam")).split("\n")[3]).toBe("When: Oct 24");
  expect(fullDay("2026-10-25")).toBe("Sun, Oct 25");
});

test("the copy: title, app, kind, when, source and ref, link, the question", async () => {
  renderIt();
  await screen.findByRole("link", { name: "Reviewed 14 transactions" });
  fireEvent.click(screen.getAllByRole("button", { name: "Copy activity for an Overwatch chat" })[0]);
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
  expect(navigator.clipboard.writeText.mock.calls[0][0]).toBe([
    "Overwatch: activity — Reviewed 14 transactions", "App: Money", "Kind: Used", "When: Oct 26, 4:28 am",
    "Source: claude (chat-1)", "https://alfredv5vibe.vercel.app/groups/detail/g1", "",
    "What should come next from this?",
  ].join("\n"));
});
