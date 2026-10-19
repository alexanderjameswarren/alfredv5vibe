import React from "react";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import RecentCompletions from "./RecentCompletions";
import * as api from "./notesApi";

jest.mock("../supabaseClient", () => ({ supabase: {} }));
jest.mock("./notesApi", () => {
  const actual = jest.requireActual("./notesApi");
  return { ...actual, currentUserId: jest.fn(), listRecentCompletions: jest.fn() };
});

test("reloads when a completion is logged, without a page reload", async () => {
  api.currentUserId.mockResolvedValue("me");
  api.listRecentCompletions.mockResolvedValueOnce([]);
  render(<RecentCompletions intentId="i1" />);
  expect(await screen.findByText("None yet")).toBeInTheDocument();

  api.listRecentCompletions.mockResolvedValueOnce([
    { executionId: "x", completedAt: "2026-10-18T12:00:00Z", notes: [] },
  ]);
  await act(async () => {
    api.completionsChanged();
  });
  expect(screen.queryByText("None yet")).toBeNull();
  expect(api.listRecentCompletions).toHaveBeenCalledTimes(2);
});
