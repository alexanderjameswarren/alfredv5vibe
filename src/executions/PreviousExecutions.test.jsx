import React from "react";
import { render, screen } from "@testing-library/react";
import PreviousExecutions from "./PreviousExecutions";

const mockCalls = [];
let mockRows = [];
jest.mock("../supabaseClient", () => {
  const chain = {};
  for (const k of ["from", "select", "eq", "order", "limit"]) {
    chain[k] = (...args) => {
      mockCalls.push([k, ...args]);
      return k === "limit" ? Promise.resolve({ data: mockRows, error: null }) : chain;
    };
  }
  return { supabase: chain };
});

test("asks for this intention's closed executions, newest first", async () => {
  mockRows = [];
  render(<PreviousExecutions intentId="i1" />);
  expect(await screen.findByText("None yet")).toBeTruthy();
  expect(mockCalls).toContainEqual(["eq", "intent_id", "i1"]);
  expect(mockCalls).toContainEqual(["eq", "status", "closed"]);
  expect(mockCalls).toContainEqual(["order", "closed_at", { ascending: false }]);
});

test("lists date and outcome", async () => {
  mockRows = [{ id: "x", outcome: "done", closed_at: "2026-10-10T18:00:00" }];
  render(<PreviousExecutions intentId="i1" />);
  expect(await screen.findByText("· Done", { exact: false })).toBeTruthy();
  expect(screen.getByText(/Saturday, October 10/)).toBeTruthy();
});
