// The warm-up ladder end to end through SamPlayer (warm-up spec §4, §6, §7):
//   - the button appears only where a ladder applies, and says nothing about a
//     whole song;
//   - pressing it starts a session at rung one's tempo and loops;
//   - a qualifying pass advances the rung, and the NEXT cycle plays at the new
//     tempo;
//   - every ladder pass records the rung it was played at;
//   - stop and pause end the ladder, deliberately;
//   - once it completes, it keeps looping and offers to start again.

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

// Scoring is not what this file tests: a chord is a hit or a miss on demand.
let mockNextResult = "hit";
const THE_BEAT = { meas: 1, beat: 1, allMidi: [60], rhMidi: [60], lhMidi: [], svgEls: [], state: "pending" };
jest.mock("./lib/noteMatching", () => ({
  elapsedAt: (state, atMs) => (atMs ?? 0) - (state.scrollStartT ?? 0),
  findClosestBeat: () => ({ beat: THE_BEAT, timingDeltaMs: 0 }),
  nearestBeat: () => ({ beat: THE_BEAT, timingDeltaMs: 0 }),
  matchChord: () =>
    mockNextResult === "hit"
      ? { result: "hit", missingNotes: [], extraNotes: [] }
      : { result: "wrong", missingNotes: [60], extraNotes: [61] },
}));
jest.mock("./lib/audioPlayer", () => ({ uploadAudio: jest.fn(), loadAudio: jest.fn() }));

const SONG_ID = "11111111-1111-1111-1111-111111111111";
const mockFetchSongById = jest.fn();
jest.mock("./lib/songLoad", () => ({
  ...jest.requireActual("./lib/songLoad"),
  fetchSongById: (...args) => mockFetchSongById(...args),
}));

const mockDb = { tables: {}, inserts: [], rpcs: [], progressRows: [] };
jest.mock("../supabaseClient", () => {
  function query(table) {
    const filters = [];
    let insert = null;
    let update = null;
    const rows = () => (mockDb.tables[table] || []).filter((r) => filters.every((f) => f(r)));
    const api = new Proxy({}, {
      get(_, prop) {
        if (prop === "then") {
          return (resolve, reject) => {
            if (insert) mockDb.inserts.push({ table, row: insert });
            if (update) mockDb.inserts.push({ table, row: update, isUpdate: true });
            return Promise.resolve({ data: insert ? [] : rows(), count: 0, error: null }).then(resolve, reject);
          };
        }
        if (prop === "eq") return (c, v) => { filters.push((r) => r[c] === v); return api; };
        if (prop === "in") return (c, vs) => { filters.push((r) => vs.includes(r[c])); return api; };
        if (prop === "insert") return (row) => { insert = row; return api; };
        if (prop === "update") return (row) => { update = row; return api; };
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
      rpc: (fn, args) => {
        mockDb.rpcs.push({ fn, args });
        if (fn === "sam_default_warmup_ladder") return Promise.resolve({ data: mockDb.defaultLadder, error: null });
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
  title: "Throwaway",
  artist: null,
  defaultBpm: 65,
  playbackSpeed: 100,
  goalBpm: 72,
  goalPlaybackSpeed: 100,
  goalEffectiveBpm: 72,
  goalSetAt: null,
  audioFilePath: null,
  showImportedFingerings: true,
  measures: [1, 2].map((n) => ({
    number: n,
    timeSignature: { beats: 4, beatType: 4 },
    rh: [{ duration: "w", notes: [{ midi: 60, name: "C4" }] }],
    lh: [{ duration: "w", notes: [] }],
  })),
};

// 70% then 100%, two consecutive passes each — the smallest real ladder.
const SNIPPET_LADDER = [
  { target_percent: 70, accuracy_target: null, target_passes: 2, consecutive: true },
  { target_percent: 100, accuracy_target: null, target_passes: 2, consecutive: true },
];

function seed({ snippetLadder = SNIPPET_LADDER, itemLadder = null, goalIsWarmup = false } = {}) {
  mockDb.tables = {
    sam_practice_plans: [{ id: "plan-1", status: "active", day_note: "Slow and even." }],
    sam_practice_plan_songs: [{ id: "ps-1", plan_id: "plan-1", song_id: SONG_ID, position: 1, song_note: null }],
    sam_practice_plan_items: [
      { id: "item-snip", plan_id: "plan-1", song_id: SONG_ID, snippet_id: "snip-1", position: 1,
        is_free_play: false, target_bpm: 60, target_playback_speed: 100, target_effective_bpm: 60,
        target_passes: 4, accuracy_target: 90, instruction: "Count out loud.",
        warmup_ladder: itemLadder, goal_is_warmup: goalIsWarmup, consecutive: false },
    ],
    sam_songs: [{ id: SONG_ID, title: "Throwaway", audio_file_path: null, default_bpm: 65 }],
    sam_snippets: [{ id: "snip-1", song_id: SONG_ID, title: "Opening bar", start_measure: 1, end_measure: 1,
      rest_measures: 0, settings: { handMode: "rh" }, archived: false, warmup_ladder: snippetLadder }],
  };
  mockDb.progressRows = [];
  mockDb.defaultLadder = [
    { target_percent: 85, accuracy_target: null, target_passes: 2, consecutive: true },
    { target_percent: 100, accuracy_target: null, target_passes: 2, consecutive: true },
  ];
  mockDb.inserts = [];
  mockDb.rpcs = [];
}

// A macrotask, awaited. `creditPass` defers the pass write off ScrollEngine's
// frame with setTimeout(0), so a credit has to be given a turn of the loop before
// the row exists — and a credit from the PREVIOUS test has to be drained before
// the insert log is reset, or it lands afterwards and reads as an extra pass.
const drain = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(async () => {
  await drain();
  seed();
  resetDefaultLadderCache();
  mockScrollProps = null;
  mockNextResult = "hit";
  window.localStorage.clear();
  mockFetchSongById.mockReset().mockResolvedValue({ song: JSON.parse(JSON.stringify(SONG)), row: { id: SONG_ID } });
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

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Open the song through its plan item, which is what selects the snippet and
// sets the tempo box to the item's target.
async function openPlanItem() {
  render(
    <MemoryRouter initialEntries={["/sam"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SamPlayer onBack={() => {}} />
    </MemoryRouter>
  );
  fireEvent.click(await screen.findByRole("button", { name: /Today's plan · / }));
  fireEvent.click(screen.getByRole("button", { name: new RegExp(esc("Opening bar")) }));
  await screen.findByLabelText(/BPM:/);
}

async function openWholeSong() {
  render(
    <MemoryRouter initialEntries={[`/sam/songs/${SONG_ID}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SamPlayer onBack={() => {}} />
    </MemoryRouter>
  );
  await screen.findByLabelText(/BPM:/);
}

// While playing, SamPlayer replaces the settings bar with FocusedPlaybackBar, so
// there is no tempo box on screen. The tempo that matters is the one driving
// playback — the prop ScrollEngine is rendered with — so that is what is asserted
// mid-run, and the box itself only when stopped.
const bpmBox = () => screen.getByLabelText(/BPM:/);
const bpmValue = () => Number(bpmBox().value);
const playingBpm = () => mockScrollProps.bpm;
const warmUpButton = () => screen.queryByRole("button", { name: /^Warm up/ });
const passInserts = () => mockDb.inserts.filter((i) => i.table === "sam_passes" && !i.isUpdate);
const strip = () => screen.queryByLabelText("Warm-up ladder");

async function pressWarmUp() {
  fireEvent.click(warmUpButton());
  await screen.findByRole("button", { name: /Pause/ });
  mockScrollProps.scrollStateExtRef.current = { scrollStartT: 0 };
}

// One playthrough, scored as asked, signalled the way ScrollEngine signals it:
// the music ends (onContentEnd banks the pass) and then the loop restarts.
async function playPass(n, result = "hit") {
  mockNextResult = result;
  await act(async () => { mockOnChord([60]); });
  await act(async () => {
    mockScrollProps.onContentEnd(n);
    mockScrollProps.onLoopCount(n);
  });
  await drain();
}

test("the button appears for a snippet with a ladder", async () => {
  await openPlanItem();
  expect(warmUpButton()).toBeInTheDocument();
});

test("a whole song never gets one — §2 scope is drills and snippets", async () => {
  await openWholeSong();
  expect(warmUpButton()).not.toBeInTheDocument();
});

test("a snippet that opts out with an empty ladder has no button", async () => {
  seed({ snippetLadder: [] });
  await openPlanItem();
  expect(warmUpButton()).not.toBeInTheDocument();
});

test("pressing it starts at rung one's tempo — a percent of the ITEM's target, not the box", async () => {
  await openPlanItem();
  // The item's target is 60; the box opens there.
  expect(bpmValue()).toBe(60);
  await pressWarmUp();
  // 70% of 60, rounded.
  expect(playingBpm()).toBe(42);
});

test("the strip says where the ladder came from, and which rung is live", async () => {
  await openPlanItem();
  await pressWarmUp();
  expect(strip()).toBeInTheDocument();
  expect(strip()).toHaveTextContent("from this snippet");
  expect(screen.getByLabelText("70 percent, 0 of 2 passes")).toBeInTheDocument();
  expect(screen.getByLabelText("100 percent, 0 of 2 passes")).toBeInTheDocument();
});

test("a plan item's ladder overrides the snippet's, and the strip says so", async () => {
  seed({
    itemLadder: [
      { target_percent: 50, accuracy_target: null, target_passes: 1, consecutive: true },
      { target_percent: 100, accuracy_target: null, target_passes: 1, consecutive: true },
    ],
  });
  await openPlanItem();
  await pressWarmUp();
  expect(strip()).toHaveTextContent("from the plan");
  expect(playingBpm()).toBe(30);
});

test("a qualifying pass fills the rung; the second advances it and the NEXT cycle is faster", async () => {
  await openPlanItem();
  await pressWarmUp();

  await playPass(1);
  expect(screen.getByLabelText("70 percent, 1 of 2 passes")).toBeInTheDocument();
  // Still at the rung's tempo: one pass is not an advance.
  expect(playingBpm()).toBe(42);

  await playPass(2);
  // Advanced to the 100% rung, and the tempo followed at the wrap.
  expect(playingBpm()).toBe(60);
  expect(screen.getByLabelText("100 percent, 0 of 2 passes")).toBeInTheDocument();
});

test("every ladder pass records the rung it was PLAYED at, not the one it advanced to", async () => {
  await openPlanItem();
  await pressWarmUp();
  await playPass(1);
  await playPass(2);   // the advancing pass
  await playPass(3);   // first pass at the top rung
  expect(passInserts()).toHaveLength(3);

  const rungs = passInserts().map((i) => [i.row.warmup_rung, i.row.warmup_target_percent]);
  expect(rungs).toEqual([[1, 70], [1, 70], [2, 100]]);
});

test("a failed pass resets a consecutive rung to zero", async () => {
  await openPlanItem();
  await pressWarmUp();
  await playPass(1);
  expect(screen.getByLabelText("70 percent, 1 of 2 passes")).toBeInTheDocument();
  await playPass(2, "miss");
  expect(screen.getByLabelText("70 percent, 0 of 2 passes")).toBeInTheDocument();
  expect(playingBpm()).toBe(42);
});

test("three failures at one rung suggest starting lower, and change nothing", async () => {
  await openPlanItem();
  await pressWarmUp();
  await playPass(1, "miss");
  await playPass(2, "miss");
  expect(strip()).not.toHaveTextContent(/starting lower/);
  await playPass(3, "miss");
  expect(strip()).toHaveTextContent(/starting lower/);
  // The ladder has not moved itself.
  expect(playingBpm()).toBe(42);
  expect(screen.getByLabelText("70 percent, 0 of 2 passes")).toBeInTheDocument();
});

test("completing the top rung keeps it looping at target tempo, and offers another go", async () => {
  await openPlanItem();
  await pressWarmUp();
  for (let n = 1; n <= 4; n++) await playPass(n);

  expect(strip()).toHaveTextContent("Warm-up complete — looping at 60 BPM");
  expect(playingBpm()).toBe(60);
  expect(await screen.findByRole("button", { name: /^Warm up again$/ })).toBeInTheDocument();
  // Still playing: completion is not a stop.
  expect(screen.getByRole("button", { name: /Pause/ })).toBeInTheDocument();
});

test("a pass after completion is still recorded, still at the last rung", async () => {
  await openPlanItem();
  await pressWarmUp();
  for (let n = 1; n <= 5; n++) await playPass(n);
  expect(passInserts()).toHaveLength(5);
  expect(passInserts()[4].row).toMatchObject({ warmup_rung: 2, warmup_target_percent: 100 });
});

test("Warm up again restarts at rung one without stopping", async () => {
  await openPlanItem();
  await pressWarmUp();
  for (let n = 1; n <= 4; n++) await playPass(n);

  fireEvent.click(screen.getByRole("button", { name: /^Warm up again$/ }));
  expect(playingBpm()).toBe(42);
  expect(screen.getByLabelText("70 percent, 0 of 2 passes")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Pause/ })).toBeInTheDocument();
});

test("PAUSE ends the ladder — deliberately, because consecutive means without stopping", async () => {
  await openPlanItem();
  await pressWarmUp();
  await playPass(1);
  expect(screen.getByLabelText("70 percent, 1 of 2 passes")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /Pause/ }));
  await waitFor(() => expect(strip()).not.toBeInTheDocument());

  // §6.6: "Resuming starts a new session at rung 1." The streak is gone with the
  // session it belonged to, and the ramp begins again at the bottom — rather than
  // leaving him looping at a warm-up tempo with no ladder and nothing saying so.
  fireEvent.click(await screen.findByRole("button", { name: /^Resume$/ }));
  await waitFor(() => expect(strip()).toBeInTheDocument());
  expect(screen.getByLabelText("70 percent, 0 of 2 passes")).toBeInTheDocument();
  expect(playingBpm()).toBe(42);
});

test("STOP forgets the ladder: Play afterwards is a plain sitting", async () => {
  await openPlanItem();
  await pressWarmUp();
  await playPass(1);
  fireEvent.click(screen.getByRole("button", { name: /Pause/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^Stop$/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^Play$/ }));
  await screen.findByRole("button", { name: /Pause/ });
  expect(strip()).not.toBeInTheDocument();
});

test("a pass with no notes played leaves the ladder exactly where it was", async () => {
  await openPlanItem();
  await pressWarmUp();
  await playPass(1);
  // No chord at all this time: a playback test, not an attempt.
  await act(async () => {
    mockScrollProps.onContentEnd(2);
    mockScrollProps.onLoopCount(2);
  });
  expect(screen.getByLabelText("70 percent, 1 of 2 passes")).toBeInTheDocument();
  expect(playingBpm()).toBe(42);
});

test("the plan line names the ladder and where it came from, before anything runs", async () => {
  await openPlanItem();
  const plan = screen.getByLabelText("Practice plan");
  expect(plan).toHaveTextContent("Warm-up · 70% → 100% · from this snippet");
});

test("a warm-up item's plan line reports the ladder, not a pass count", async () => {
  seed({ goalIsWarmup: true });
  await openPlanItem();
  const plan = screen.getByLabelText("Practice plan");
  expect(plan).toHaveTextContent("warm-up");
  expect(plan).toHaveTextContent("not yet today");
  // And no "0/4 today": passes are not how this item is measured.
  expect(plan).not.toHaveTextContent("0/4");
});

test("a warm-up item's button leads the transport, filled", async () => {
  seed({ goalIsWarmup: true });
  await openPlanItem();
  expect(warmUpButton()).toHaveAttribute("data-variant", "primary");
  // Ahead of Play in the DOM, which is the row order.
  const buttons = screen.getAllByRole("button").map((b) => b.textContent);
  expect(buttons.indexOf("Warm up")).toBeLessThan(buttons.indexOf("Play"));
});

test("mid-run, the plan badge carries the live rung — the only plan readout on screen", async () => {
  seed({ goalIsWarmup: true });
  await openPlanItem();
  await pressWarmUp();
  expect(screen.getByText("Warm-up · rung 1 of 2")).toBeInTheDocument();
  await playPass(1);
  await playPass(2);
  expect(screen.getByText("Warm-up · rung 2 of 2")).toBeInTheDocument();
});

test("no ladder anywhere and no default: no button, and nothing invented", async () => {
  seed({ snippetLadder: null });
  mockDb.defaultLadder = null;
  await openPlanItem();
  expect(warmUpButton()).not.toBeInTheDocument();
});

test("with no ladder of its own, the range falls through to the database default", async () => {
  seed({ snippetLadder: null });
  await openPlanItem();
  await waitFor(() => expect(warmUpButton()).toBeInTheDocument());
  await pressWarmUp();
  expect(strip()).toHaveTextContent("default");
  // 85% of the item's 60 BPM target.
  expect(playingBpm()).toBe(51);
  expect(mockDb.rpcs.some((r) => r.fn === "sam_default_warmup_ladder")).toBe(true);
});
