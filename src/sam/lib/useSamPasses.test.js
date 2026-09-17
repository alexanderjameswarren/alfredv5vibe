// recordPass writes the practice plan link (practice plans spec §7.2), and a
// link that is missing or fails never costs the pass.

import { renderHook, act, waitFor } from "@testing-library/react";

const mockInserts = [];
jest.mock("../../supabaseClient", () => ({
  supabase: {
    from: (table) => ({
      insert: (row) => {
        mockInserts.push({ table, row });
        return { then: (res, rej) => Promise.resolve({ error: null }).then(res, rej) };
      },
    }),
  },
}));

const useSamPasses = require("./useSamPasses").default;

beforeEach(() => {
  mockInserts.length = 0;
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const SNIPPET = { startMeasure: 5, endMeasure: 12, handMode: "rh", dbId: "snip-1" };

function credit(result, extra) {
  act(() => result.current.armPass());
  let ok;
  act(() => {
    ok = result.current.recordPass({
      songId: "song-1", snippet: SNIPPET, sessionId: "sess-1", bpm: 60, playbackSpeed: 100,
      handMode: "rh", playthrough: { hits: 3, misses: 1, notesPlayed: 4 }, ...extra,
    });
  });
  return ok;
}

test("the pass row carries plan_id and plan_item_id from the link for its song and snippet", async () => {
  const getPlanLink = jest.fn(() => ({ plan_id: "plan-1", plan_item_id: "item-7" }));
  const { result } = renderHook(() => useSamPasses());
  expect(credit(result, { getPlanLink })).toBe(true);
  await waitFor(() => expect(mockInserts).toHaveLength(1));
  expect(getPlanLink).toHaveBeenCalledWith("song-1", "snip-1");
  expect(mockInserts[0].row).toMatchObject({ snippet_id: "snip-1", plan_id: "plan-1", plan_item_id: "item-7" });
});

test("a whole-song pass is looked up with a null snippet", async () => {
  const getPlanLink = jest.fn(() => ({ plan_id: "plan-1", plan_item_id: null }));
  const { result } = renderHook(() => useSamPasses());
  credit(result, { getPlanLink, snippet: null });
  await waitFor(() => expect(mockInserts).toHaveLength(1));
  expect(getPlanLink).toHaveBeenCalledWith("song-1", null);
  expect(mockInserts[0].row).toMatchObject({ snippet_id: null, plan_id: "plan-1", plan_item_id: null });
});

test("no plan, no link function, or a throwing link: nulls, and the pass is still written", async () => {
  const { result } = renderHook(() => useSamPasses());
  credit(result, { getPlanLink: () => ({ plan_id: null, plan_item_id: null }) });
  credit(result, {});
  credit(result, { getPlanLink: () => { throw new Error("plan not ready"); } });
  await waitFor(() => expect(mockInserts).toHaveLength(3));
  for (const { row } of mockInserts) {
    expect(row.plan_id).toBeNull();
    expect(row.plan_item_id).toBeNull();
    expect(row.hits).toBe(3);
  }
});
