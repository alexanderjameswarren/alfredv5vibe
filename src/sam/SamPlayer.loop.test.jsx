// An early first note at the loop wrap (sam_play_tweaks-h3n, step 2): a press
// that lands on the NEXT pass's beat before the wrap counts toward that pass,
// not the one ending. The engine is mocked, so the wrap is signalled by hand.

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

// The beat the next chord matches: copy 0 is this pass, copy 1 the next.
const beat = (copy) => ({ copy, meas: 1, beat: 1, allMidi: [60], rhMidi: [60], lhMidi: [], svgEls: [], state: "pending" });
let mockMatch = null;
jest.mock("./lib/noteMatching", () => ({
  elapsedAt: (state, atMs) => (atMs ?? 0) - (state.scrollStartT ?? 0),
  findClosestBeat: () => ({ beat: mockMatch, timingDeltaMs: 120 }),
  nearestBeat: () => ({ beat: mockMatch, timingDeltaMs: 120 }),
  matchChord: () => ({ result: "hit", missingNotes: [], extraNotes: [] }),
}));
jest.mock("./lib/audioPlayer", () => ({ uploadAudio: jest.fn(), loadAudio: jest.fn() }));

const SONG_ID = "11111111-1111-1111-1111-111111111111";
const mockFetchSongById = jest.fn();
jest.mock("./lib/songLoad", () => ({
  ...jest.requireActual("./lib/songLoad"),
  fetchSongById: (...args) => mockFetchSongById(...args),
}));

const mockDb = { tables: {}, inserts: [], progressRows: [] };
jest.mock("../supabaseClient", () => {
  function query(table) {
    const filters = [];
    let insert = null;
    const rows = () => (mockDb.tables[table] || []).filter((r) => filters.every((f) => f(r)));
    const api = new Proxy({}, {
      get(_, prop) {
        if (prop === "then") {
          return (resolve, reject) => {
            if (insert) mockDb.inserts.push({ table, row: insert });
            return Promise.resolve({ data: insert ? [] : rows(), count: 0, error: null }).then(resolve, reject);
          };
        }
        if (prop === "eq") return (c, v) => { filters.push((r) => r[c] === v); return api; };
        if (prop === "in") return (c, vs) => { filters.push((r) => vs.includes(r[c])); return api; };
        if (prop === "insert") return (row) => { insert = row; return api; };
        if (prop === "single" || prop === "maybeSingle") {
          return () => ({
            then: (resolve, reject) => {
              if (insert) mockDb.inserts.push({ table, row: insert });
              const data = insert ? { id: `${table}-new` } : rows()[0] ?? null;
              return Promise.resolve({ data, error: null }).then(resolve, reject);
            },
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
      rpc: (fn) => {
        if (fn === "sam_plan_item_progress") return Promise.resolve({ data: mockDb.progressRows, error: null });
        return Promise.resolve({ data: [], error: null });
      },
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
const { resetDefaultLadderCache } = require("./lib/useWarmupLadder");

const SONG = {
  title: "Throwaway", artist: null, defaultBpm: 65, playbackSpeed: 100,
  goalBpm: 72, goalPlaybackSpeed: 100, goalEffectiveBpm: 72, goalSetAt: null,
  audioFilePath: null, showImportedFingerings: true,
  measures: [1, 2].map((n) => ({
    number: n,
    timeSignature: { beats: 4, beatType: 4 },
    rh: [{ duration: "w", notes: [{ midi: 60, name: "C4" }] }],
    lh: [{ duration: "w", notes: [] }],
  })),
};

const LADDER = [
  { target_percent: 70, accuracy_target: null, target_passes: 2, consecutive: true },
  { target_percent: 100, accuracy_target: null, target_passes: 2, consecutive: true },
];

function seed(restMeasures = 0) {
  mockDb.tables = {
    sam_practice_plans: [{ id: "plan-1", status: "active", day_note: null }],
    sam_practice_plan_songs: [{ id: "ps-1", plan_id: "plan-1", song_id: SONG_ID, position: 1, song_note: null }],
    sam_practice_plan_items: [
      { id: "item-snip", plan_id: "plan-1", song_id: SONG_ID, snippet_id: "snip-1", position: 1,
        is_free_play: false, target_bpm: 60, target_playback_speed: 100, target_effective_bpm: 60,
        target_passes: 4, accuracy_target: 90, instruction: null,
        warmup_ladder: null, goal_is_warmup: false, consecutive: false },
    ],
    sam_songs: [{ id: SONG_ID, title: "Throwaway", audio_file_path: null, default_bpm: 65, warmup_ladder: null }],
    sam_snippets: [{ id: "snip-1", song_id: SONG_ID, title: "Opening bar", start_measure: 1, end_measure: 1,
      rest_measures: restMeasures, settings: { handMode: "rh" }, archived: false, warmup_ladder: LADDER }],
  };
  mockDb.progressRows = [];
  mockDb.inserts = [];
}

const drain = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(async () => {
  await drain();
  seed();
  resetDefaultLadderCache();
  mockScrollProps = null;
  window.localStorage.clear();
  mockFetchSongById.mockReset().mockImplementation(async () => ({
    song: JSON.parse(JSON.stringify(SONG)), row: { id: SONG_ID },
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

async function openPlanItem() {
  render(
    <MemoryRouter initialEntries={["/sam"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SamPlayer onBack={() => {}} />
    </MemoryRouter>
  );
  fireEvent.click(await screen.findByRole("button", { name: /Today's plan · / }));
  fireEvent.click(screen.getByRole("button", { name: /Opening bar/ }));
  await screen.findByLabelText(/BPM:/);
}

async function start(name) {
  fireEvent.click(screen.getByRole("button", { name }));
  await screen.findByRole("button", { name: /Pause/ });
  mockScrollProps.scrollStateExtRef.current = { scrollStartT: 0 };
}

async function press(copy) {
  mockMatch = beat(copy);
  await act(async () => { mockOnChord([60]); });
}

const contentEnd = (n) => act(async () => { mockScrollProps.onContentEnd(n); });
const wrapTo = (n) => act(async () => { mockScrollProps.onLoopCount(n); });

// With no rest bars the engine fires both at the wrap.
async function wrapPass(n) {
  await contentEnd(n);
  await wrapTo(n);
  await drain();
}

const passes = () => mockDb.inserts
  .filter((i) => i.table === "sam_passes")
  .map((i) => ({ hits: i.row.hits, misses: i.row.misses, notes: i.row.notes_played }));

test("the early press counts toward the new pass, not the old", async () => {
  await openPlanItem();
  await start(/^Play$/);
  await press(0);          // pass 1, on time
  await press(1);          // pass 2's first note, before the wrap
  await wrapPass(1);
  await wrapPass(2);       // nothing more played: the carried hit is pass 2's
  expect(passes()).toEqual([
    { hits: 1, misses: 0, notes: 1 },
    { hits: 1, misses: 0, notes: 1 },
  ]);
});

test("with rest bars too: pass 2 keeps its early hit", async () => {
  seed(1);
  await openPlanItem();
  await start(/^Play$/);
  await press(0);
  await contentEnd(1);     // music over; the rest bar scrolls
  await press(1);          // early, during the rest, before the wrap
  await wrapTo(1);
  await drain();
  await wrapPass(2);
  expect(passes()).toEqual([
    { hits: 1, misses: 0, notes: 1 },
    { hits: 1, misses: 0, notes: 1 },
  ]);
});

test("the plan line credits both passes", async () => {
  await openPlanItem();
  await start(/^Play$/);
  await press(0);
  await press(1);
  await wrapPass(1);
  await wrapPass(2);
  await waitFor(() => expect(screen.getByTestId("goal-plan")).toHaveTextContent("Plan 2/4"));
});

test("the warm-up ladder advances on the corrected counts", async () => {
  await openPlanItem();
  await start(/^Warm up/);
  expect(mockScrollProps.bpm).toBe(42);
  await press(0);
  await press(1);
  await wrapPass(1);
  await wrapPass(2);
  // Two qualifying passes in a row: rung 1 is done and the tempo moved on.
  expect(mockScrollProps.bpm).toBe(60);
});

test("a fresh run drops an early press it never reached", async () => {
  await openPlanItem();
  await start(/^Play$/);
  await press(0);
  await press(1);
  await wrapTo(0);         // a restart re-emits 0
  await wrapPass(1);
  expect(passes()).toEqual([{ hits: 1, misses: 0, notes: 1 }]);
});
