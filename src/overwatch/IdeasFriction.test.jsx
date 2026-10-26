import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import IdeasSection from "./IdeasSection";
import { ideaGroups, projectState } from "./ideasModel";
import FrictionSection, { frictionGroups, processName } from "./FrictionSection";

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue() } });
});
const lastCopy = () => navigator.clipboard.writeText.mock.calls.at(-1)[0];

const APPS = [{ id: "sam", name: "Sam", icon: "Music" }, { id: "warren_buffet", name: "Warren Buffet", icon: "Wallet" }];
const ALFRED = "ctx-alfred";
const rec = (id, name, day, tags = [], extra = {}) => ({
  id, name, type: "item", context_id: ALFRED, tags, created_at: `2026-10-${day}T18:00:00Z`, ...extra,
});
const DATA = {
  projects: [{ group_id: "g1", name: "Voice capture", group_status: "active", hurdle_kind: "technology",
    waiting_on: "the M5 Mac", created_at: "2026-10-03T18:00:00Z" }],
  records: [
    rec("i1", "Sam lyric karaoke", "20", ["ui", "sam"]),
    rec("i2", "Sam practice heatmap", "10", ["sam"], { type: "intention" }),
    rec("i3", "Store filter", "15", ["ui"]),
    rec("i4", "Broken back arrow", "05", ["bug", "sam"]),
    rec("i5", "Overview item", "06", ["alfred"]),
    rec("i6", "Money forecast idea", "12", ["warren_buffet"]),
    rec("x1", "Garden pond", "08", ["idea"], { context_id: "ctx-home" }),
    rec("x2", "Not an idea", "08", [], { context_id: "ctx-home" }),
  ],
  contexts: [{ id: ALFRED, name: "Alfred" }, { id: "ctx-home", name: "Home" }],
  alfredContextId: ALFRED,
  groupedIds: ["i5"],
};

test("ideas: the rule and its groups", () => {
  const groups = ideaGroups({ ...DATA, apps: APPS });
  expect(groups.map((g) => [g.title, g.rows.map((r) => r.id)])).toEqual([
    ["Someday and parked Projects", ["g1"]],
    ["Money", ["i6"]],
    ["Sam", ["i2", "i1"]],
    ["No app", ["i3"]],
    ["Home", ["x1"]],
  ]);
  expect(projectState({ hurdle_kind: null })).toBe("Someday");
});

const openAll = () => screen.getAllByRole("button", { expanded: false })
  .filter((b) => / \(\d+\)$/.test(b.textContent)).forEach((b) => fireEvent.click(b));

test("ideas: capture targets are left out everywhere", () => {
  const groups = ideaGroups({ ...DATA, apps: APPS, records: [...DATA.records,
    rec("ct", "Alfred Roadmap", "01", [], { is_capture_target: true }),
    rec("ct2", "Home inbox", "01", ["idea"], { context_id: "ctx-home", is_capture_target: true })] });
  expect(groups.flatMap((g) => g.rows.map((r) => r.id))).not.toEqual(expect.arrayContaining(["ct"]));
  expect(groups.flatMap((g) => g.rows.map((r) => r.id))).not.toContain("ct2");
});

test("ideas: groups start collapsed; the heading toggles; the copy button does not", async () => {
  render(<MemoryRouter><IdeasSection data={DATA} apps={APPS} /></MemoryRouter>);
  const sam = screen.getByRole("button", { name: /Sam \(2\)/ });
  expect(sam).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("link", { name: "Sam practice heatmap" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Copy ideas for an Overwatch chat" }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
  expect(sam).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(sam);
  expect(screen.getByRole("link", { name: "Sam practice heatmap" })).toBeInTheDocument();
  fireEvent.click(sam);
  expect(screen.queryByRole("link", { name: "Sam practice heatmap" })).not.toBeInTheDocument();
});

test("ideas: real links, the copy rule, the group copy", async () => {
  render(<MemoryRouter><IdeasSection data={DATA} apps={APPS} /></MemoryRouter>);
  openAll();
  expect(screen.getByRole("link", { name: "Voice capture" })).toHaveAttribute("href", "/groups/detail/g1");
  const heatmap = screen.getByRole("link", { name: "Sam practice heatmap" });
  expect(heatmap).toHaveAttribute("href", "/i2");
  expect(heatmap.className).toContain("after:inset-0");
  expect(screen.getByText("Parked (technology): waiting on the M5 Mac")).toBeInTheDocument();
  // Sam (2) copies once on its heading; the single-row groups copy on their rows: 1 + 4.
  const sam = screen.getByRole("region", { name: "Sam" });
  expect(sam.querySelectorAll("article button[title='Copy for an Overwatch chat']")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Copy ideas for an Overwatch chat" }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
  expect(lastCopy()).toBe([
    "Overwatch: ideas — Sam",
    "- Sam practice heatmap (intention_id: i2) https://alfredv5vibe.vercel.app/i2",
    "- Sam lyric karaoke (item_id: i1) https://alfredv5vibe.vercel.app/i1",
    "", "Which of these is worth turning into a project, and which should I let go?",
  ].join("\n"));
  expect(screen.getAllByRole("button", { name: "Copy idea for an Overwatch chat" })).toHaveLength(4);
});

test("ideas: a single row copies itself; empty state", async () => {
  const { unmount } = render(<MemoryRouter><IdeasSection data={{ ...DATA, records: [] }} apps={APPS} /></MemoryRouter>);
  openAll();
  fireEvent.click(screen.getByRole("button", { name: "Copy idea for an Overwatch chat" }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
  expect(lastCopy()).toBe([
    "Overwatch: idea — Voice capture", "Added: Oct 3", "Parked (technology): waiting on the M5 Mac",
    "group_id: g1", "https://alfredv5vibe.vercel.app/groups/detail/g1", "",
    "Is this worth turning into a project, or should I let it go?",
  ].join("\n"));
  unmount();
  render(<MemoryRouter><IdeasSection data={{ projects: [], records: [] }} /></MemoryRouter>);
  expect(screen.getByText("No ideas waiting.")).toBeInTheDocument();
});

const NOW = new Date("2026-10-26T20:00:00Z");
const entry = (id, process, day) => ({ id, process, occurred_at: `2026-10-${day}T18:00:00Z`, what_happened: `${id} happened\nmore` });
const ENTRIES = [entry("a", "todos", "25"), entry("b", "todos", "24"),
  { ...entry("c", "todos", "01"), occurred_at: "2026-09-10T18:00:00Z" }, entry("d", "skill:cli-workflow", "20")];
const SETTINGS = { friction_window_days: 30, friction_trigger_count: 3 };

test("friction: plain process names; a pattern only from the plan's window and count", () => {
  expect([processName("cli_testing_steps"), processName("todos"), processName("skill:cli-workflow")])
    .toEqual(["CLI testing steps", "To-dos", "Skill: cli-workflow"]);
  const groups = frictionGroups(ENTRIES, SETTINGS, NOW);
  expect(groups.map((g) => [g.process, g.rows.length, g.pattern])).toEqual([["todos", 3, false], ["skill:cli-workflow", 1, false]]);
  expect(frictionGroups(ENTRIES, { ...SETTINGS, friction_window_days: 50 }, NOW)[0].pattern).toBe(true);
  expect(frictionGroups(ENTRIES, {}, NOW)[0].pattern).toBe(false);
});

test("friction: groups with counts, a red pattern marker, first lines, both copies", async () => {
  jest.useFakeTimers().setSystemTime(NOW);
  render(<FrictionSection entries={ENTRIES} settings={{ ...SETTINGS, friction_window_days: 50 }} />);
  jest.useRealTimers();
  const todos = screen.getByRole("region", { name: "To-dos" });
  expect(todos.className).toContain("border-destructive");
  expect(screen.getByText("Pattern")).toBeInTheDocument();
  expect(screen.getByText("To-dos (3)")).toBeInTheDocument();
  expect(screen.getByText("a happened")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Skill: cli-workflow" }).className).not.toContain("border-destructive");
  // The copy rule: To-dos (3) copies once on its header; Skill: cli-workflow (1) copies on its entry.
  const copies = screen.getAllByRole("button", { name: "Copy friction for an Overwatch chat" });
  expect(copies).toHaveLength(2);
  expect(todos.querySelectorAll('li button[title="Copy for an Overwatch chat"]')).toHaveLength(0);
  fireEvent.click(copies[0]);
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1));
  expect(lastCopy().split("\n")[0]).toBe("Overwatch: friction — To-dos (3 open)");
  expect(lastCopy()).toContain("- Oct 24: b happened\nmore (friction_id: b)");
  expect(lastCopy().endsWith("These keep happening. What's the shared cause and the one fix?")).toBe(true);
  fireEvent.click(copies[1]);
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2));
  expect(lastCopy()).toBe(["Overwatch: friction — Skill: cli-workflow", "Date: Oct 20", "d happened\nmore",
    "friction_id: d", "", "What change would stop this from happening again?"].join("\n"));
});

test("friction: Other entries stand alone, are never a pattern, and each copies itself", () => {
  const others = [entry("o1", "other", "25"), entry("o2", "other", "24"), entry("o3", "other", "23")];
  expect(frictionGroups(others, SETTINGS, NOW)).toEqual([]);
  render(<FrictionSection entries={others} settings={SETTINGS} />);
  expect(screen.queryByText("Pattern")).not.toBeInTheDocument();
  expect(screen.queryByText(/Other \(3\)/)).not.toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Copy friction for an Overwatch chat" })).toHaveLength(3);
  expect(screen.getAllByRole("region").every((r) => !r.className.includes("border-destructive"))).toBe(true);
});

test("friction: empty", () => {
  render(<FrictionSection entries={[]} settings={{}} />);
  expect(screen.getByText("No open friction.")).toBeInTheDocument();
});
