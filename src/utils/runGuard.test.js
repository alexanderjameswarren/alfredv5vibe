let mockRows = [];
const mockCalls = [];
jest.mock("../supabaseClient", () => {
  const chain = {};
  for (const k of ["from", "select", "eq", "limit"]) {
    chain[k] = (...args) => {
      mockCalls.push([k, ...args]);
      return k === "limit" ? Promise.resolve({ data: mockRows, error: null }) : chain;
    };
  }
  return { supabase: chain };
});

const { assertNoActiveRun, RUN_ACTIVE_MOVE_REASON } = require("./runGuard");

test("an active run on the event refuses the move", async () => {
  mockRows = [{ id: "x" }];
  await expect(assertNoActiveRun("e1")).rejects.toThrow(RUN_ACTIVE_MOVE_REASON);
  expect(mockCalls).toContainEqual(["eq", "event_id", "e1"]);
  expect(mockCalls).toContainEqual(["eq", "status", "active"]);
});

test("no active run lets it through (paused runs are not asked about)", async () => {
  mockRows = [];
  await expect(assertNoActiveRun("e1")).resolves.toBeUndefined();
});
