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
function extra(session, over = {}) {
  act(() => session.current.recordExtra({ measure: 4, beat: 2, played: [61], timingDeltaMs: -120, ...over }));
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

// --- `extra` rows: recorded, and scoreless by construction ---------------------

test("an extra changes no counter, no accuracy, no timing average and no pass figures", async () => {
  const session = await openSession();
  hit(session); wrong(session);           // a measured 50%
  const before = { ...session.current.stats };
  const beforePass = { ...session.current.getCurrentPlaythrough() };

  extra(session);
  extra(session, { measure: 5, played: [62, 63] });

  expect(session.current.stats).toEqual(before);
  expect(session.current.getCurrentPlaythrough()).toEqual(beforePass);
  expect(session.current.stats.accuracyPercent).toBe(50);

  const summary = await endAndGetSummary(session);
  // Counters and the pass-facing figures ignore them entirely.
  expect(summary).toMatchObject({ hits: 1, misses: 1, partials: 0, totalBeats: 2, notesPlayed: 2, accuracyPercent: 50 });
  // -120 would have dragged a 0 average down if it had been counted.
  expect(summary.avgTimingDeltaMs).toBe(0);
  expect(summary.playthroughs[0]).toMatchObject({ hits: 1, misses: 1, totalBeats: 2, accuracyPercent: 50 });
});

test("an extra IS written to the telemetry, with the struck pitch and no expected notes", async () => {
  const session = await openSession();
  hit(session);
  extra(session);
  await playAndEndNoExtraPlay(session);
  const rows = storedRows();
  expect(rows.map((r) => r.result)).toEqual(["hit", "extra"]);
  expect(rows[1]).toMatchObject({
    measure_number: 4, beat: 2, result: "extra",
    played_notes: [61], expected_notes: [], timing_delta_ms: -120, loop_iteration: 0,
  });
});

test("extras are capped per measure per pass, and an empty keystroke is ignored", async () => {
  const session = await openSession();
  for (let i = 0; i < 20; i++) extra(session);
  // A different measure, and the same measure in the next pass, both have their
  // own allowance.
  for (let i = 0; i < 3; i++) extra(session, { measure: 9 });
  wrap(session, 1);
  for (let i = 0; i < 3; i++) extra(session);
  expect(session.current.recordExtra({ measure: 4, played: [] })).toBe(false);

  await playAndEndNoExtraPlay(session);
  const rows = storedRows().filter((r) => r.result === "extra");
  expect(rows.filter((r) => r.measure_number === 4 && r.loop_iteration === 0)).toHaveLength(12);
  expect(rows.filter((r) => r.measure_number === 9)).toHaveLength(3);
  expect(rows.filter((r) => r.measure_number === 4 && r.loop_iteration === 1)).toHaveLength(3);
});

// Ends the session without adding more scored beats.
async function playAndEndNoExtraPlay(session) {
  await waitFor(() => expect(session.current.getSessionId()).toBe("session-1"));
  await act(async () => { await session.current.endSession(); });
  await waitFor(() => expect(eventRows().length).toBeGreaterThan(0));
}

test("wrong keys carried on a miss reach the row but no counter", async () => {
  const session = await openSession();
  hit(session);
  act(() => session.current.recordEvent({
    beatEvent: BEAT, played: [], attempted: [61, 63], timingDeltaMs: null, result: "miss",
  }));

  // Counted as an ordinary miss: one hit, one miss, and the two wrong keys are
  // NOT notes played, so accuracy stays the measured 50% rather than moving.
  const { stats } = session.current;
  expect(stats).toMatchObject({ hits: 1, misses: 1 });
  expect(session.current.getCurrentPlaythrough()).toEqual({ hits: 1, misses: 1, notesPlayed: 1 });
  expect(stats.accuracyPercent).toBe(50);

  const summary = await endAndGetSummary(session);
  expect(summary).toMatchObject({ hits: 1, misses: 1, notesPlayed: 1, accuracyPercent: 50 });
  const rows = storedRows();
  expect(rows.map((r) => r.result)).toEqual(["hit", "miss"]);
  expect(rows[1]).toMatchObject({ result: "miss", played_notes: [61, 63], timing_delta_ms: null });
});
