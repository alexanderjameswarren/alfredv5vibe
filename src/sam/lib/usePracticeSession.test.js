// usePracticeSession: accuracy is null — not 0 — when nothing was measured,
// both live and in the stored session summary (practice plans spec §7.1).

import { renderHook, act, waitFor } from "@testing-library/react";

const mockUpdates = [];
jest.mock("../../supabaseClient", () => {
  function query(table) {
    let update = null;
    const api = {
      insert: () => api,
      select: () => api,
      eq: () => api,
      update: (payload) => { update = payload; return api; },
      single: () => Promise.resolve({ data: { id: "session-1" }, error: null }),
      then: (resolve, reject) => {
        if (update) mockUpdates.push({ table, payload: update });
        return Promise.resolve({ data: [], error: null }).then(resolve, reject);
      },
    };
    return api;
  }
  return {
    supabase: {
      from: (table) => query(table),
      auth: {
        getSession: async () => ({ data: { session: null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      },
    },
    supabaseUrl: "http://localhost",
    supabaseAnonKey: "anon",
  };
});

const usePracticeSession = require("./usePracticeSession").default;

const BEAT = { meas: 1, beat: 1, allMidi: [60] };

beforeEach(() => {
  mockUpdates.length = 0;
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

async function openSession() {
  const { result } = renderHook(() => usePracticeSession());
  await act(async () => {
    await result.current.startSession({ songId: "song-1", settings: { bpm: 60 } });
  });
  return result;
}

// ScrollEngine's miss path: no notes. The MIDI path: the notes played.
function miss(session) {
  act(() => session.current.recordEvent({ beatEvent: BEAT, played: [], timingDeltaMs: null, result: "miss" }));
}
function hit(session) {
  act(() => session.current.recordEvent({ beatEvent: BEAT, played: [60], timingDeltaMs: 0, result: "hit" }));
}
function wrong(session) {
  act(() => session.current.recordEvent({ beatEvent: BEAT, played: [61], timingDeltaMs: 0, result: "wrong" }));
}
function partial(session) {
  act(() => session.current.recordEvent({ beatEvent: BEAT, played: [60], timingDeltaMs: 0, result: "partial" }));
}
function wrap(session, n) {
  act(() => session.current.setLoopIteration(n));
}
async function endAndGetSummary(session) {
  await waitFor(() => expect(session.current.getSessionId()).toBe("session-1"));
  await act(async () => {
    await session.current.endSession();
  });
  await waitFor(() => expect(mockUpdates).toHaveLength(1));
  return mockUpdates[0].payload.summary;
}

test("before anything is played, accuracy is null, not 0", async () => {
  const session = await openSession();
  expect(session.current.stats.accuracyPercent).toBeNull();
  expect(session.current.stats.playthroughAccuracyPercent).toBeNull();
});

test("zero notes played: live and stored accuracy are null", async () => {
  const session = await openSession();
  miss(session); miss(session); miss(session);

  const { stats } = session.current;
  expect(stats.misses).toBe(3);
  expect(stats.accuracyPercent).toBeNull();
  expect(stats.hasPlaythrough).toBe(true);
  expect(stats.playthroughAccuracyPercent).toBeNull();

  const summary = await endAndGetSummary(session);
  expect(summary.accuracyPercent).toBeNull();
  expect(summary.notesPlayed).toBe(0);
  expect(summary.playthroughs).toHaveLength(1);
  expect(summary.playthroughs[0].accuracyPercent).toBeNull();
  expect(summary.bestPlaythroughAccuracyPercent).toBeNull();
});

test("notes played but hits + misses is 0 (partials only): null", async () => {
  const session = await openSession();
  partial(session); partial(session);

  const { stats } = session.current;
  expect(stats.partials).toBe(2);
  expect(stats.accuracyPercent).toBeNull();

  const summary = await endAndGetSummary(session);
  expect(summary.accuracyPercent).toBeNull();
  expect(summary.partials).toBe(2); // partials are still stored
  expect(summary.notesPlayed).toBe(2);
  // A pass with no scored beat is not a playthrough entry (unchanged).
  expect(summary.playthroughs).toEqual([]);
  expect(summary.bestPlaythroughAccuracyPercent).toBeNull();
});

test("a real value otherwise; partials sit outside the ratio", async () => {
  const session = await openSession();
  hit(session); hit(session); hit(session); wrong(session); partial(session);

  expect(session.current.stats.accuracyPercent).toBe(75);
  expect(session.current.stats.playthroughAccuracyPercent).toBe(75);

  const summary = await endAndGetSummary(session);
  expect(summary.accuracyPercent).toBe(75);
  expect(summary.partials).toBe(1);
  expect(summary.playthroughs[0]).toEqual({
    loop: 0, hits: 3, misses: 1, partials: 1, totalBeats: 5, notesPlayed: 5, accuracyPercent: 75,
  });
  expect(summary.bestPlaythroughAccuracyPercent).toBe(75);
});

test("best playthrough ignores unmeasured passes, and is not beaten by a null", async () => {
  const session = await openSession();
  // Pass 0: measured, 50%.
  hit(session); wrong(session);
  wrap(session, 1);
  // Pass 1: keyboard idle, misses only — unmeasured.
  miss(session); miss(session);
  wrap(session, 2);
  // Pass 2 (in progress at the end): measured, 0%.
  wrong(session);

  const summary = await endAndGetSummary(session);
  expect(summary.playthroughs.map((p) => p.accuracyPercent)).toEqual([50, null, 0]);
  expect(summary.bestPlaythroughAccuracyPercent).toBe(50);
  // Session accuracy is measured (notes were played): 1 hit of 5 scored beats.
  expect(summary.accuracyPercent).toBe(20);
});

test("best playthrough is null when every pass is unmeasured", async () => {
  const session = await openSession();
  miss(session);
  wrap(session, 1);
  miss(session);
  const summary = await endAndGetSummary(session);
  expect(summary.playthroughs.map((p) => p.accuracyPercent)).toEqual([null, null]);
  expect(summary.bestPlaythroughAccuracyPercent).toBeNull();
});

test("the live playthrough readout shows the idle pass as null after a measured one", async () => {
  const session = await openSession();
  hit(session);
  wrap(session, 1);
  // Just after the wrap, the last completed (measured) pass stays on screen.
  expect(session.current.stats.playthroughAccuracyPercent).toBe(100);
  miss(session);
  // The idle pass now has a scored beat, so it is the one described: unmeasured.
  expect(session.current.stats.playthroughAccuracyPercent).toBeNull();
});
