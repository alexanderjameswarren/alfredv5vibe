// usePracticeSession: accuracy is null — not 0 — when nothing was measured,
// both live and in the stored session summary (practice plans spec §7.1).

import { renderHook, act, waitFor } from "@testing-library/react";

const mockUpdates = [];
const mockInserts = [];
// Set by a test to refuse some inserts, as a check constraint would:
// (table, payload) => error | null. `payload` is a row or an array of rows.
let mockRefuse = null;
jest.mock("../../supabaseClient", () => {
  function query(table) {
    let update = null;
    let insertPayload = null;
    let insertError = null;
    const api = {
      insert: (payload) => {
        insertPayload = payload;
        insertError = mockRefuse ? mockRefuse(table, payload) : null;
        mockInserts.push({ table, payload, refused: !!insertError });
        return api;
      },
      select: () => api,
      eq: () => api,
      update: (payload) => { update = payload; return api; },
      single: () => Promise.resolve({ data: { id: "session-1" }, error: null }),
      then: (resolve, reject) => {
        if (update) mockUpdates.push({ table, payload: update });
        const result = insertPayload && insertError
          ? { data: null, error: insertError }
          : { data: [], error: null };
        return Promise.resolve(result).then(resolve, reject);
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
  mockInserts.length = 0;
  mockRefuse = null;
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
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

// Practice plans (§7.2): every session row carries the plan link.
test("a session row carries the plan link it was started with", async () => {
  const { result } = renderHook(() => usePracticeSession());
  await act(async () => {
    await result.current.startSession({
      songId: "song-1", snippetId: "snip-1", settings: { bpm: 60 },
      planLink: { plan_id: "plan-1", plan_item_id: "item-7" },
    });
  });
  expect(mockInserts).toHaveLength(1);
  expect(mockInserts[0].table).toBe("sam_sessions");
  expect(mockInserts[0].payload).toMatchObject({
    song_id: "song-1", snippet_id: "snip-1", plan_id: "plan-1", plan_item_id: "item-7",
  });
});

test("without a plan link (no plan, or not loaded) both columns are null", async () => {
  const { result } = renderHook(() => usePracticeSession());
  await act(async () => {
    await result.current.startSession({ songId: "song-1", settings: { bpm: 60 } });
  });
  expect(mockInserts[0].payload).toMatchObject({ plan_id: null, plan_item_id: null });
  expect(mockInserts[0].payload).not.toHaveProperty("snippet_id");
});

// --- the fan-out to sam_session_events -----------------------------------------
//
// Telemetry must never cost the sitting, and one refused row must never cost
// the rest of the session (the bug that left 1,067 of 2,204 ended sessions
// with no rows at all).

const eventRows = () => mockInserts.filter((i) => i.table === "sam_session_events");
const storedRows = () =>
  eventRows().filter((i) => !i.refused).flatMap((i) => (Array.isArray(i.payload) ? i.payload : [i.payload]));

async function playAndEnd(session) {
  hit(session); partial(session); wrong(session); hit(session);
  await waitFor(() => expect(session.current.getSessionId()).toBe("session-1"));
  await act(async () => { await session.current.endSession(); });
  await waitFor(() => expect(eventRows().length).toBeGreaterThan(0));
}

test("every beat is fanned out, with the app's four result values", async () => {
  const session = await openSession();
  await playAndEnd(session);
  const rows = storedRows();
  expect(rows).toHaveLength(4);
  expect(rows.map((r) => r.result)).toEqual(["hit", "partial", "wrong", "hit"]);
  expect(rows[0]).toMatchObject({
    session_id: "session-1", song_id: "song-1", measure_number: 1, beat: 1,
    expected_notes: [60], played_notes: [60], loop_iteration: 0,
  });
  // No measure rows in this fake, so measure_id stays null rather than guessing.
  expect(rows[0].measure_id).toBeNull();
});

test("a refused row costs only itself: the rest of the session still lands", async () => {
  // A check constraint that refuses 'wrong', as the database did before 029.
  mockRefuse = (table, payload) => {
    if (table !== "sam_session_events") return null;
    const rows = Array.isArray(payload) ? payload : [payload];
    return rows.some((r) => r.result === "wrong")
      ? { message: 'new row violates check constraint "sam_session_events_result_check"', code: "23514" }
      : null;
  };
  const session = await openSession();
  await playAndEnd(session);

  // The batch was refused, then retried row by row: three of the four stored.
  const rows = storedRows();
  expect(rows).toHaveLength(3);
  expect(rows.map((r) => r.result)).toEqual(["hit", "partial", "hit"]);
  expect(eventRows().some((i) => i.refused)).toBe(true);
  // ...and the refusal was reported, with its reason.
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining("1 of 4 row(s) rejected"),
    expect.objectContaining({
      [`new row violates check constraint "sam_session_events_result_check" (result: wrong, m.1)`]: 1,
    })
  );
});

test("the session itself is saved even when every event row is refused", async () => {
  mockRefuse = (table) => (table === "sam_session_events" ? { message: "boom", code: "XX000" } : null);
  const session = await openSession();
  await playAndEnd(session);
  expect(storedRows()).toHaveLength(0);
  // ended_at and the summary still landed.
  expect(mockUpdates).toHaveLength(1);
  expect(mockUpdates[0].table).toBe("sam_sessions");
  expect(mockUpdates[0].payload.ended_at).toBeTruthy();
  expect(mockUpdates[0].payload.summary.totalBeats).toBe(4);
});
