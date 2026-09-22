// On-screen Hits counts full hits only (practice plans spec §7.1), matching
// sam_passes.hits. A partial chord colours its beat amber and is recorded as a
// partial, but adds to neither Hits nor Misses on screen.
//
// The player is driven through its real handleChord: useMIDI is mocked to hand
// over the chord callback, ScrollEngine to hand over the scroll state, and
// noteMatching to decide what each chord scores.

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
  return {
    connected: true, deviceName: "Test keyboard", lastNote: null,
    cancelPendingChord: () => {}, resetHeldKeys: () => {},
  };
});

let mockNextResult = "hit";
// How far the nearest pending beat is when a keystroke matches nothing.
let mockNearestDelta = -412;
// ONE beat object, so a later onBeatMiss can be handed the very beat the
// chord was played at — which is how the app links the two.
const THE_BEAT = { meas: 1, beat: 1, allMidi: [60, 64], rhMidi: [60, 64], lhMidi: [], svgEls: [], state: "pending" };
// "none" = the matcher finds no beat in the window (a stray keystroke).
jest.mock("./lib/noteMatching", () => ({
  // The press-time clock (2026-09-19). Scoring is mocked here, so all this
  // needs to do is stand in for the real reading.
  elapsedAt: (state, atMs) => (atMs ?? 0) - (state.scrollStartT ?? 0),
  findClosestBeat: () =>
    mockNextResult === "none" ? null : { beat: THE_BEAT, timingDeltaMs: 0 },
  // Used only to name the measure an unmatched keystroke happened in.
  nearestBeat: () => ({
    beat: { meas: 7, beat: 3, allMidi: [60], rhMidi: [60], lhMidi: [], svgEls: [], state: "pending" },
    timingDeltaMs: mockNearestDelta,
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

// Every read is empty; an insert returns an id.
const mockInserts = [];
jest.mock("../supabaseClient", () => {
  function query(table) {
    const api = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "insert") {
            return (payload) => {
              for (const row of Array.isArray(payload) ? payload : [payload]) {
                mockInserts.push({ table, row });
              }
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
      auth: {
        getUser: async () => ({ data: { user: { id: "u1" } } }),
        getSession: async () => ({ data: { session: null } }),
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

beforeEach(() => {
  mockScrollProps = null;
  mockOnChord = null;
  mockInserts.length = 0;
  mockNearestDelta = -412;
  THE_BEAT.state = "pending";
  mockFetchSongById.mockReset().mockResolvedValue({
    song: JSON.parse(JSON.stringify(SONG)),
    row: { id: SONG_ID },
  });
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

async function startPlaying() {
  render(
    <MemoryRouter
      initialEntries={[`/sam/songs/${SONG_ID}`]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <SamPlayer onBack={() => {}} />
    </MemoryRouter>
  );
  const play = await screen.findByRole("button", { name: /^Play$/ });
  fireEvent.click(play);
  await screen.findByRole("button", { name: /Pause/ });
  // What ScrollEngine would publish once scrolling starts.
  mockScrollProps.scrollStateExtRef.current = { scrollStartT: 0 };
}

async function play(result) {
  mockNextResult = result;
  await act(async () => {
    mockOnChord([60]);
  });
}

// "Hits: 0" -> "0". The label is the span's own text; the value is its <strong>.
const counter = (label) =>
  screen.getByText(new RegExp(`^${label}:`)).textContent.replace(`${label}: `, "");

test("a partial chord adds to neither on-screen Hits nor Misses", async () => {
  await startPlaying();
  expect(counter("Hits")).toBe("0");

  await play("partial");
  expect(counter("Hits")).toBe("0");
  expect(counter("Misses")).toBe("0");

  await play("hit");
  expect(counter("Hits")).toBe("1");

  await play("partial");
  await play("partial");
  expect(counter("Hits")).toBe("1");

  await play("wrong");
  expect(counter("Misses")).toBe("1");
  expect(counter("Hits")).toBe("1");
});

test("partials only: nothing is measured, so Session Accuracy is a dash, not 0%", async () => {
  await startPlaying();
  expect(counter("Session Accuracy")).toBe("—");
  await play("partial");
  // Hits + misses is still 0, so accuracy is unmeasured.
  expect(counter("Session Accuracy")).toBe("—");
  await play("hit");
  await play("wrong");
  expect(counter("Session Accuracy")).toBe("50%");
});

// --- `extra` rows: what was struck, recorded without scoring it ---------------

test("a stray keystroke and an all-wrong chord move no counter on screen", async () => {
  await startPlaying();
  await play("hit");
  expect(counter("Hits")).toBe("1");
  expect(counter("Session Accuracy")).toBe("100%");

  // A keystroke that matches no beat at all.
  await play("none");
  // An all-wrong chord: the beat is left pending, so it is not scored either.
  await play("allwrong");

  expect(counter("Hits")).toBe("1");
  expect(counter("Misses")).toBe("0");
  expect(counter("Session Accuracy")).toBe("100%");
  expect(counter("Loop")).toBe("0");
});

// --- one fumble, one row -------------------------------------------------------

const eventRows = () =>
  mockInserts.filter((i) => i.table === "sam_session_events").map((i) => i.row);

// Pause ends the session, which is what flushes the events.
async function stop() {
  fireEvent.click(await screen.findByRole("button", { name: /Pause/ }));
  await waitFor(() => expect(eventRows().length).toBeGreaterThan(0));
}

test("an all-wrong chord produces exactly ONE row carrying those pitches — the miss", async () => {
  await startPlaying();
  await play("allwrong");
  // The beat was left pending; the scanner times it out later.
  await act(async () => { mockScrollProps.onBeatMiss(THE_BEAT); });
  await stop();

  const rows = eventRows();
  const withPitches = rows.filter((r) => (r.played_notes || []).includes(60));
  expect(withPitches).toHaveLength(1);
  expect(withPitches[0]).toMatchObject({
    result: "miss", measure_number: 1, beat: 1, played_notes: [60], timing_delta_ms: null,
  });
  // No companion extra: that is what made one fumble two rows.
  expect(rows.filter((r) => r.result === "extra")).toHaveLength(0);

  // And it is still a miss, on screen and in the counters.
  expect(counter("Misses")).toBe("1");
  expect(counter("Hits")).toBe("0");
  // The wrong keys are NOT counted as notes played, so accuracy stays unmeasured.
  expect(counter("Session Accuracy")).toBe("—");
});

test("a corrected all-wrong chord leaves no row at all: nothing was missed", async () => {
  await startPlaying();
  await play("allwrong");   // held against the beat
  await play("hit");        // corrected in time — the beat is consumed as a hit
  await stop();

  const rows = eventRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ result: "hit", played_notes: [60] });
  expect(counter("Hits")).toBe("1");
});

test("an extra keeps its offset only when the nearest beat is within reach", async () => {
  await startPlaying();
  mockNearestDelta = -412;          // inside 2 x 300ms
  await play("none");
  mockNearestDelta = 4389;          // the live value that prompted this rule
  await play("none");
  await stop();

  const extras = eventRows().filter((r) => r.result === "extra");
  expect(extras).toHaveLength(2);
  expect(extras[0]).toMatchObject({ measure_number: 7, beat: 3, played_notes: [60], timing_delta_ms: -412 });
  expect(extras[1].timing_delta_ms).toBeNull();
  expect(extras[1].played_notes).toEqual([60]);
});
