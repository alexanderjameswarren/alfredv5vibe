// A hidden speed % on a song without audio (sam_play_tweaks-h3n): it is folded
// into the BPM box, so the box, Play and Practice all run at one tempo.

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";

jest.mock("./components/ScoreRenderer", () => () => null);

let mockScrollProps = null;
jest.mock("./components/ScrollEngine", () => (props) => {
  mockScrollProps = props;
  return null;
});
jest.mock("./lib/useMIDI", () => () => ({
  connected: false, deviceName: null, lastNote: null,
  cancelPendingChord: () => {}, resetHeldKeys: () => {},
}));
jest.mock("./lib/audioPlayer", () => ({
  uploadAudio: jest.fn(),
  // A plain function: CRA's resetMocks would strip a jest.fn's implementation.
  loadAudio: () => new Promise(() => {}),
}));

const SONG_ID = "11111111-1111-1111-1111-111111111111";
const mockFetchSongById = jest.fn();
jest.mock("./lib/songLoad", () => ({
  ...jest.requireActual("./lib/songLoad"),
  fetchSongById: (...args) => mockFetchSongById(...args),
}));

const mockDb = { tables: {} };
jest.mock("../supabaseClient", () => {
  function query(table) {
    const filters = [];
    let insert = null;
    const rows = () => (mockDb.tables[table] || []).filter((r) => filters.every((f) => f(r)));
    const api = new Proxy({}, {
      get(_, prop) {
        if (prop === "then") {
          return (resolve, reject) =>
            Promise.resolve({ data: insert ? [] : rows(), count: 0, error: null }).then(resolve, reject);
        }
        if (prop === "eq") return (c, v) => { filters.push((r) => r[c] === v); return api; };
        if (prop === "in") return (c, vs) => { filters.push((r) => vs.includes(r[c])); return api; };
        if (prop === "insert") return (row) => { insert = row; return api; };
        if (prop === "single" || prop === "maybeSingle") {
          return () => ({
            then: (resolve, reject) =>
              Promise.resolve({ data: insert ? { id: `${table}-new` } : rows()[0] ?? null, error: null })
                .then(resolve, reject),
          });
        }
        return () => api;
      },
    });
    return api;
  }
  return {
    supabase: {
      from: (table) => query(table),
      rpc: () => Promise.resolve({ data: [], error: null }),
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

const song = (over = {}) => ({
  title: "Throwaway", artist: null, defaultBpm: 60, playbackSpeed: 70,
  goalBpm: 72, goalPlaybackSpeed: 100, audioFilePath: null, showImportedFingerings: true,
  measures: [{
    number: 1,
    timeSignature: { beats: 4, beatType: 4 },
    rh: [{ duration: "w", notes: [{ midi: 60, name: "C4" }] }],
    lh: [{ duration: "w", notes: [] }],
  }],
  ...over,
});

function seed(itemSpeed = 100) {
  mockDb.tables = {
    sam_practice_plans: [{ id: "plan-1", status: "active", day_note: null }],
    sam_practice_plan_songs: [{ id: "ps-1", plan_id: "plan-1", song_id: SONG_ID, position: 1, song_note: null }],
    sam_practice_plan_items: [
      { id: "item-whole", plan_id: "plan-1", song_id: SONG_ID, snippet_id: null, position: 1,
        is_free_play: false, target_bpm: 80, target_playback_speed: itemSpeed,
        target_effective_bpm: Math.round(80 * itemSpeed / 100),
        target_passes: 2, accuracy_target: 90, instruction: null },
    ],
    sam_songs: [{ id: SONG_ID, title: "Throwaway", audio_file_path: null, default_bpm: 60 }],
    sam_snippets: [],
  };
}

beforeEach(() => {
  seed();
  mockScrollProps = null;
  window.localStorage.clear();
  mockFetchSongById.mockReset().mockResolvedValue({ song: song(), row: { id: SONG_ID } });
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

async function openSong() {
  render(
    <MemoryRouter initialEntries={[`/sam/songs/${SONG_ID}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SamPlayer onBack={() => {}} />
    </MemoryRouter>
  );
  await screen.findByRole("button", { name: /^Play$/ });
}

async function start(name) {
  fireEvent.click(screen.getByRole("button", { name }));
  await screen.findByRole("button", { name: /Pause/ });
}

test("a saved 70% shows as BPM 42, not 60", async () => {
  await openSong();
  expect(await screen.findByLabelText(/BPM:/)).toHaveValue(42);
});

test("Play scrolls at the BPM shown, on the wall clock", async () => {
  await openSong();
  await screen.findByDisplayValue("42");
  await start(/^Play$/);
  expect(mockScrollProps.bpm).toBe(42);
  // No audio, so rate 1: the lead-in is timed from this bpm alone.
  expect(mockScrollProps.audioElement).toBeNull();
});

test("Practice scrolls at the same tempo as Play", async () => {
  await openSong();
  await screen.findByDisplayValue("42");
  await start(/^Practice$/);
  expect(mockScrollProps.bpm).toBe(42);
});

test("a plan item's 70% is folded the same way", async () => {
  seed(70);
  mockFetchSongById.mockResolvedValue({ song: song({ playbackSpeed: 100 }), row: { id: SONG_ID } });
  render(
    <MemoryRouter initialEntries={["/sam"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SamPlayer onBack={() => {}} />
    </MemoryRouter>
  );
  fireEvent.click(await screen.findByRole("button", { name: /Today's plan · / }));
  fireEvent.click(screen.getByRole("button", { name: /Whole song/ }));
  expect(await screen.findByDisplayValue("56")).toBeInTheDocument();
  await start(/^Play$/);
  expect(mockScrollProps.bpm).toBe(56);
});

test("a song with audio keeps its speed: the rail shows Speed %", async () => {
  mockFetchSongById.mockResolvedValue({
    song: song({ audioFilePath: "a.mp3" }), row: { id: SONG_ID },
  });
  await openSong();
  expect(await screen.findByLabelText(/Speed %:/)).toHaveValue(70);
});
