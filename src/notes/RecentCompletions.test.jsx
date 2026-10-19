import React from "react";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import RecentCompletions, { mergeRecent } from "./RecentCompletions";
import * as api from "./notesApi";
import { storage } from "../utils/storage";

jest.mock("../supabaseClient", () => ({ supabase: {} }));
jest.mock("../utils/storage", () => ({ storage: { get: jest.fn() } }));
jest.mock("./notesApi", () => {
  const actual = jest.requireActual("./notesApi");
  return {
    ...actual,
    currentUserId: jest.fn(),
    listRecentCompletions: jest.fn(),
    listRecentSkips: jest.fn(),
    countRecentExecutions: jest.fn(),
  };
});

const done = (id, at) => ({ executionId: id, completedAt: at, notes: [] });
const skip = (id, on) => ({ id, intentId: "i1", skippedOn: on, closedAt: `${on}T15:00:00Z` });

beforeEach(() => {
  api.currentUserId.mockResolvedValue("me");
  api.listRecentSkips.mockResolvedValue([]);
  api.countRecentExecutions.mockResolvedValue(0);
});

test("Show all (N older) when there are more than five; it reads them all, then Last 5", async () => {
  const many = ["10", "11", "12", "13", "14", "15", "16"].map((d) => done(`d${d}`, `2026-10-${d}T12:00:00Z`));
  api.listRecentCompletions.mockImplementation(async ({ limit }) => many.slice(-limit).reverse());
  api.countRecentExecutions.mockResolvedValue(7);
  render(<RecentCompletions intentId="i1" />);
  const toggle = await screen.findByRole("button", { name: "Show all (2 older)" });
  expect(screen.getAllByTitle("Open this completed execution")).toHaveLength(5);
  expect(api.countRecentExecutions).toHaveBeenCalledWith({ itemId: null, intentIds: ["i1"] });
  fireEvent.click(toggle);
  await waitFor(() => expect(screen.getAllByTitle("Open this completed execution")).toHaveLength(7));
  expect(api.listRecentCompletions).toHaveBeenLastCalledWith({ itemId: null, intentId: "i1", limit: 50 });
  fireEvent.click(screen.getByRole("button", { name: "Last 5" }));
  await waitFor(() => expect(screen.getAllByTitle("Open this completed execution")).toHaveLength(5));
});

test("no Show all at five or fewer", async () => {
  api.listRecentCompletions.mockResolvedValue([done("d1", "2026-10-18T12:00:00Z")]);
  api.countRecentExecutions.mockResolvedValue(5);
  render(<RecentCompletions intentId="i1" />);
  await screen.findByTitle("Open this completed execution");
  expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
});

test("reloads when a completion is logged, without a page reload", async () => {
  api.listRecentCompletions.mockResolvedValueOnce([]);
  render(<RecentCompletions intentId="i1" />);
  expect(await screen.findByText("None yet")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Recent executions" })).toBeInTheDocument();

  api.listRecentCompletions.mockResolvedValueOnce([done("x", "2026-10-18T12:00:00Z")]);
  await act(async () => {
    api.completionsChanged();
  });
  expect(screen.queryByText("None yet")).toBeNull();
  expect(api.listRecentCompletions).toHaveBeenCalledTimes(2);
});

test("merge: newest first by the date shown, five at most", () => {
  const rows = mergeRecent(
    [done("d1", "2026-10-15T12:00:00Z"), done("d2", "2026-10-18T12:00:00Z"), done("d3", "2026-10-12T12:00:00Z")],
    [skip("s1", "2026-10-19"), skip("s2", "2026-10-16"), skip("s3", "2026-10-10")],
  );
  expect(rows.map((r) => r.id)).toEqual(["s1", "d2", "s2", "d1", "d3"]);
});

test("a skipped row: Skip icon, '(skipped)', no card border, and it opens its execution", async () => {
  api.listRecentCompletions.mockResolvedValue([done("d1", "2026-10-18T12:00:00Z")]);
  api.listRecentSkips.mockResolvedValue([skip("s1", "2026-10-19")]);
  storage.get.mockResolvedValue({ id: "s1" });
  const onOpenExecution = jest.fn();
  render(<RecentCompletions intentId="i1" onOpenExecution={onOpenExecution} />);
  const skipped = await screen.findByTitle("Open this skipped execution");
  expect(skipped).toHaveTextContent("(skipped)");
  expect(skipped.className).not.toMatch(/border/);
  expect(screen.getByTitle("Open this completed execution").className).toMatch(/border/);
  expect(api.listRecentSkips).toHaveBeenCalledWith(["i1"], 5);
  fireEvent.click(skipped);
  await waitFor(() => expect(onOpenExecution).toHaveBeenCalledWith({ id: "s1" }));
});
