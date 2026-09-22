// PRACTICE MODE RECORDS NOTHING (spec: docs/technical-spec-sam-practice-mode.md).
//
// The success criterion is a negative one — "after any Practice run, no new rows
// exist in sam_sessions, sam_session_events or sam_passes, and plan progress is
// unchanged" — so this suite drives a whole practice run through every path that
// writes during Play and asserts the database was never touched.
//
// The last test is the control: the SAME run under Play does write. Without it a
// broken supabase mock would make every assertion here pass vacuously.
//
// Harness copied from SamPlayer.hits.test.jsx: useMIDI mocked to hand over the
// chord callback, ScrollEngine mocked to hand over its props, noteMatching
// mocked to decide what each chord scores.

import React from "react";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";

jest.mock("./components/ScoreRenderer", () => () => null);

let mockScrollProps = null;
jest.mock("./components/ScrollEngine", () => (props) => {
  mockScrollProps = props;
  return null;
});

let mockOnChord = null;
jest.mock("./lib/useMIDI", () => ({ onChord }) => {
  mockOnChord = onChord;
  return { connected: true, deviceName: "Test keyboard", lastNote: null };
});

let mockNextResult = "hit";
const THE_BEAT = { meas: 1, beat: 1, allMidi: [60, 64], rhMidi: [60, 64], lhMidi: [],
  svgEls: [], state: "pending", targetTimeMs: 4200 };
jest.mock("./lib/noteMatching", () => ({
  elapsedAt: (state, atMs) => (atMs ?? 0) - (state.scrollStartT ?? 0),
  findClosestBeat: () =>
    mockNextResult === "none" ? null : { beat: THE_BEAT, timingDeltaMs: 0 },
  nearestBeat: () => ({
    beat: { meas: 7, beat: 3, allMidi: [60], rhMidi: [60], lhMidi: [], svgEls: [], state: "pending" },
    timingDeltaMs: -412,
  }),
  matchChord: () =>
    mockNextResult === "allwrong"
      ? { result: "miss", missingNotes: [60, 64], extraNotes: [61] }
      : mockNextResult === "hit"
      ? { result: "hit", missingNotes: [], extraNotes: [] }
      : mockNextResult === "partial"
        ? { result: "partial", missingNotes: [64], extraNotes: [] }
        : { result: "wrong", missingNotes: [64], extraNotes: [61] },
}));

jest.mock("./lib/audioPlayer", () => ({ uploadAudio: jest.fn(), loadAudio: jest.fn() }));

const SONG_ID = "11111111-1111-1111-1111-111111111111";
const mockFetchSongById = jest.fn();
jest.mock("./lib/songLoad", () => ({
  ...jest.requireActual("./lib/songLoad"),
  fetchSongById: (...args) => mockFetchSongById(...args),
}));

// Every WRITE is recorded, not just inserts: a session is created by an insert
// but CLOSED by an update, and the page-hide net writes through neither.
const mockWrites = [];
jest.mock("../supabaseClient", () => {
  function query(table) {
    const api = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "insert") {
            return (payload) => {
              for (const row of Array.isArray(payload) ? payload : [payload]) {
                mockWrites.push({ table, op: "insert", row });
              }
              return api;
            };
          }
          if (prop === "update" || prop === "upsert" || prop === "delete") {
            return (row) => {
              mockWrites.push({ table, op: prop, row });
              return api;
            };
          }
          if (prop === "then") {
            return (resolve, reject) =>
              Promise.resolve({ data: [], count: 0, error: null }).then(resolve, reject);
          }
          if (prop === "single" || prop === "maybeSingle") {
            return () => ({
              then: (resolve, reject) =>
                Promise.resolve({ data: { id: "row-1" }, error: null }).then(resolve, reject),
            });
          }
          return () => api;
        },
      }
    );
    return api;
  }
  return {
    supabase: {
      from: (table) => query(table),
      rpc: () => ({
        then: (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject),
      }),
      auth: {
        getUser: async () => ({ data: { user: { id: "u1" } } }),
        getSession: async () => ({ data: { session: { access_token: "tok" } } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      },
    },
    supabaseUrl: "http://localhost",
    supabaseAnonKey: "anon",
  };
});

const SamPlayer = require("./SamPlayer").default;

const SONG = {
  title: "Throwaway",
  artist: null,
  defaultBpm: 65,
  playbackSpeed: 100,
  goalBpm: 72,
  goalPlaybackSpeed: 100,
  audioFilePath: null,
  showImportedFingerings: true,
  measures: [
    {
      number: 1,
      timeSignature: { beats: 4, beatType: 4 },
      rh: [{ duration: "w", notes: [{ midi: 60, name: "C4" }, { midi: 64, name: "E4" }] }],
      lh: [{ duration: "w", notes: [] }],
    },
  ],
};

let songOverrides = {};

beforeEach(() => {
  mockScrollProps = null;
  mockOnChord = null;
  mockWrites.length = 0;
  songOverrides = {};
  THE_BEAT.state = "pending";
  mockFetchSongById.mockReset().mockImplementation(async () => ({
    song: { ...JSON.parse(JSON.stringify(SONG)), ...songOverrides },
    row: { id: SONG_ID },
  }));
  window.AudioContext = function AudioContext() {
    this.state = "running";
    this.resume = () => Promise.resolve();
    this.currentTime = 0;
  };
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  delete window.AudioContext;
});

async function open() {
  render(
    <MemoryRouter
      initialEntries={[`/sam/songs/${SONG_ID}`]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <SamPlayer onBack={() => {}} />
    </MemoryRouter>
  );
  await screen.findByRole("button", { name: /^Play$/ });
}

async function start(which) {
  await open();
  fireEvent.click(await screen.findByRole("button", { name: which }));
  await screen.findByRole("button", { name: /Pause/ });
  mockScrollProps.scrollStateExtRef.current = { scrollStartT: 0, originPx: 0, pxPerMs: 1 };
}

// What ScrollEngine's frame would read: null while scrolling, the stuck beat's
// scheduled time once the run has stopped.
const frozenAt = () => mockScrollProps.scrollStateExtRef.current.frozenAtMs ?? null;

async function chord(result) {
  mockNextResult = result;
  await act(async () => { mockOnChord([60]); });
}

// Pause and Resume, the only way out of a stopped practice run before step 4.
// Needed between outcomes below: from step 3 the FIRST failing chord freezes the
// run, and every later keystroke is ignored — so without this the writes-nothing
// test would stop exercising the paths it is there to prove are silent.
async function unstick() {
  if (frozenAt() == null) return;
  fireEvent.click(await screen.findByRole("button", { name: /Pause/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Resume/ }));
  await screen.findByRole("button", { name: /Pause/ });
}

// Everything a real run does between starting and stopping: every grading
// outcome, a timed-out miss, and a completed playthrough.
async function playThrough({ unstickBetween = false } = {}) {
  for (const result of ["hit", "partial", "wrong", "allwrong", "none"]) {
    await chord(result);
    if (unstickBetween) await unstick();
  }
  await act(async () => { mockScrollProps.onBeatMiss(THE_BEAT); });
  if (unstickBetween) await unstick();
  // A completed pass, by both routes ScrollEngine can credit one.
  await act(async () => { mockScrollProps.onContentEnd(1); });
  await act(async () => { mockScrollProps.onLoopCount(1); });
  await act(async () => { await Promise.resolve(); });
}

const writesTo = (table) => mockWrites.filter((w) => w.table === table);

// --- the criterion ----------------------------------------------------------

test("a whole Practice run writes nothing, anywhere", async () => {
  await start(/^Practice$/);
  await playThrough({ unstickBetween: true });

  // Pause, resume and stop are all separate write opportunities in Play.
  fireEvent.click(await screen.findByRole("button", { name: /Pause/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Resume/ }));
  await screen.findByRole("button", { name: /Pause/ });
  fireEvent.click(await screen.findByRole("button", { name: /Pause/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^Stop$/ }));

  await act(async () => { await Promise.resolve(); });

  expect(writesTo("sam_sessions")).toEqual([]);
  expect(writesTo("sam_session_events")).toEqual([]);
  expect(writesTo("sam_passes")).toEqual([]);
  // Practice skips ensureRangeIsSaved, so not even a snippet row appears.
  expect(writesTo("sam_snippets")).toEqual([]);
  expect(mockWrites).toEqual([]);
});

test("the page-hide safety net stays quiet after a Practice run", async () => {
  const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true });
  await start(/^Practice$/);
  await playThrough({ unstickBetween: true });

  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });

  expect(fetchSpy).not.toHaveBeenCalled();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

// --- the scroll is Play's scroll, minus the sound ---------------------------

test("Practice hands ScrollEngine the same range but no audio and no synth", async () => {
  await start(/^Practice$/);

  expect(mockScrollProps.audioElement).toBeNull();
  expect(mockScrollProps.scorePlayback).toBe("off");
  expect(mockScrollProps.onScrollStart).toBeNull();
  expect(mockScrollProps.audioEndMs).toBeNull();
  expect(mockScrollProps.audioAnchors).toEqual([]);
  // Same range and same tempo as Play would use.
  expect(mockScrollProps.measures).toHaveLength(1);
  expect(mockScrollProps.bpm).toBe(65);
});

test("Practice folds playbackSpeed into the bpm, since no audio carries the rate", async () => {
  songOverrides = { playbackSpeed: 70 };
  await start(/^Practice$/);
  // 65 bpm at 70% is what Play would sound like through the audio element.
  expect(mockScrollProps.bpm).toBeCloseTo(45.5);
});

test("Play is untouched: full audio wiring, and the speed stays on the element", async () => {
  songOverrides = { playbackSpeed: 70 };
  await start(/^Play$/);

  expect(mockScrollProps.scorePlayback).toBe("off"); // the default, not Practice's override
  expect(mockScrollProps.onScrollStart).toEqual(expect.any(Function));
  // NOT scaled — Play's rate rides on audioElement.playbackRate.
  expect(mockScrollProps.bpm).toBe(65);
});

// --- the control ------------------------------------------------------------

test("the identical run under Play DOES record — so the gate is the mode, not a broken mock", async () => {
  await start(/^Play$/);
  await playThrough();
  fireEvent.click(await screen.findByRole("button", { name: /Pause/ }));

  await waitFor(() => expect(writesTo("sam_sessions").length).toBeGreaterThan(0));
  await waitFor(() => expect(writesTo("sam_session_events").length).toBeGreaterThan(0));
  expect(writesTo("sam_passes").length).toBeGreaterThan(0);
});

// --- switching between the two ---------------------------------------------

test("Play after a Practice run records again", async () => {
  await start(/^Practice$/);
  await chord("hit");
  fireEvent.click(await screen.findByRole("button", { name: /Pause/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^Stop$/ }));
  expect(mockWrites).toEqual([]);

  fireEvent.click(await screen.findByRole("button", { name: /^Play$/ }));
  await screen.findByRole("button", { name: /Pause/ });
  await waitFor(() => expect(writesTo("sam_sessions").length).toBeGreaterThan(0));
});

test("Practice shows its own bar, not the session counters", async () => {
  await start(/^Practice$/);
  expect(screen.getByText("PRACTICE")).toBeInTheDocument();
  expect(screen.queryByText(/Session Accuracy/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Playthrough/)).not.toBeInTheDocument();
});

// =============================================================================
// STEP 3 — stop on incorrect
// =============================================================================

// The freeze value is the stuck beat's own targetTimeMs, and that single number
// is what puts the beat on the play line and what step 4 will resume from.

test("a wrong note stops the run on that beat", async () => {
  await start(/^Practice$/);
  expect(frozenAt()).toBeNull();

  await chord("wrong");

  expect(frozenAt()).toBe(THE_BEAT.targetTimeMs);
  expect(await screen.findByText("m.1")).toBeInTheDocument();
});

test("a partial chord stops the run too — anything that is not a full hit", async () => {
  await start(/^Practice$/);
  await chord("partial");
  expect(frozenAt()).toBe(THE_BEAT.targetTimeMs);
});

test("a full hit does not stop the run", async () => {
  await start(/^Practice$/);
  await chord("hit");
  expect(frozenAt()).toBeNull();
  expect(screen.getByText("Nothing is recorded.")).toBeInTheDocument();
});

test("an all-wrong chord stops immediately, and leaves its beat pending to resume from", async () => {
  await start(/^Practice$/);
  await chord("allwrong");

  // Not waiting out the timing window for the miss scanner.
  expect(frozenAt()).toBe(THE_BEAT.targetTimeMs);
  // Left pending exactly as under Play — step 4 resumes from an unconsumed beat.
  expect(THE_BEAT.state).toBe("pending");
});

test("a missed note stops with the score moved BACK to the missed beat", async () => {
  await start(/^Practice$/);
  // The scanner only fires once the window has closed, so the scroll is already
  // past the beat. Freezing at its targetTimeMs is what pulls the score back.
  await act(async () => { mockScrollProps.onBeatMiss(THE_BEAT); });

  expect(frozenAt()).toBe(THE_BEAT.targetTimeMs);
  expect(await screen.findByText("m.1")).toBeInTheDocument();
});

test("the first stop wins: a later miss does not move the stuck beat", async () => {
  await start(/^Practice$/);
  await chord("wrong");
  const later = { ...THE_BEAT, meas: 9, targetTimeMs: 99999 };
  await act(async () => { mockScrollProps.onBeatMiss(later); });

  expect(frozenAt()).toBe(THE_BEAT.targetTimeMs);
  expect(screen.getByText("m.1")).toBeInTheDocument();
});

test("keys pressed while stopped are ignored entirely", async () => {
  await start(/^Practice$/);
  await chord("wrong");
  const frozen = frozenAt();

  await chord("hit");
  await chord("allwrong");
  await chord("none");     // would be an `extra` under Play
  await chord("partial");

  // Still stuck on the same beat, and still nothing written.
  expect(frozenAt()).toBe(frozen);
  expect(screen.getByText("m.1")).toBeInTheDocument();
  expect(mockWrites).toEqual([]);
});

test("Pause and Stop both leave a stopped run, and still record nothing", async () => {
  await start(/^Practice$/);
  await chord("wrong");
  expect(frozenAt()).toBe(THE_BEAT.targetTimeMs);

  fireEvent.click(await screen.findByRole("button", { name: /Pause/ }));
  expect(frozenAt()).toBeNull();

  fireEvent.click(await screen.findByRole("button", { name: /Resume/ }));
  await screen.findByRole("button", { name: /Pause/ });
  await chord("wrong");
  expect(frozenAt()).toBe(THE_BEAT.targetTimeMs);

  fireEvent.click(await screen.findByRole("button", { name: /Pause/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^Stop$/ }));
  await act(async () => { await Promise.resolve(); });

  expect(frozenAt()).toBeNull();
  expect(mockWrites).toEqual([]);
});

test("a fresh Practice run starts unstuck", async () => {
  await start(/^Practice$/);
  await chord("wrong");
  fireEvent.click(await screen.findByRole("button", { name: /Pause/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^Stop$/ }));

  fireEvent.click(await screen.findByRole("button", { name: /^Practice$/ }));
  await screen.findByRole("button", { name: /Pause/ });
  mockScrollProps.scrollStateExtRef.current = { scrollStartT: 0, originPx: 0, pxPerMs: 1 };
  expect(frozenAt()).toBeNull();
  expect(screen.getByText("Nothing is recorded.")).toBeInTheDocument();
});

// --- Play must not stop, ever ------------------------------------------------

test("Play never freezes: wrong, partial, all-wrong and missed all scroll on", async () => {
  await start(/^Play$/);

  await chord("wrong");
  expect(frozenAt()).toBeNull();
  await chord("partial");
  expect(frozenAt()).toBeNull();
  await chord("allwrong");
  expect(frozenAt()).toBeNull();
  await act(async () => { mockScrollProps.onBeatMiss(THE_BEAT); });
  expect(frozenAt()).toBeNull();

  // And it is still grading and counting as it always did.
  fireEvent.click(await screen.findByRole("button", { name: /Pause/ }));
  await waitFor(() => expect(writesTo("sam_session_events").length).toBeGreaterThan(0));
});
