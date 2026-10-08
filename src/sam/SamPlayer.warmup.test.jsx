// The warm-up ladder end to end through SamPlayer (warm-up spec §4, §6, §7):
//   - the button appears only where a ladder applies, and says nothing about a
//     whole song;
//   - pressing it starts a session at rung one's tempo and loops;
//   - a qualifying pass advances the rung, and the NEXT cycle plays at the new
//     tempo;
//   - every ladder pass records the rung it was played at;
//   - stop and pause end the ladder, deliberately;
//   - once it completes, it keeps looping and offers to start again.
//
// It also covers the rest of what the playing bar says about targets, because it
// is the same bar and the same harness (2026-09-28): the in-a-row run on a
// consecutive item, the accuracy and tempo each strip group names, the
// playthrough figure against its target, and the "this pass cannot qualify"
// warning. See the describe blocks at the foot of the file.

import React from "react";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";
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

function seed({
  snippetLadder = SNIPPET_LADDER, itemLadder = null, goalIsWarmup = false,
  songLadder = null, withPlan = true,
  // For the in-a-row strip: the item's own flags, and what the database says
  // today's best run was.
  consecutive = false, targetPasses = 4, streakToday = 0,
} = {}) {
  mockDb.tables = {
    sam_practice_plans: withPlan
      ? [{ id: "plan-1", status: "active", day_note: "Slow and even." }]
      : [],
    sam_practice_plan_songs: [{ id: "ps-1", plan_id: "plan-1", song_id: SONG_ID, position: 1, song_note: null }],
    sam_practice_plan_items: [
      { id: "item-snip", plan_id: "plan-1", song_id: SONG_ID, snippet_id: "snip-1", position: 1,
        is_free_play: false, target_bpm: 60, target_playback_speed: 100, target_effective_bpm: 60,
        target_passes: targetPasses, accuracy_target: 90, instruction: "Count out loud.",
        warmup_ladder: itemLadder, goal_is_warmup: goalIsWarmup, consecutive },
    ],
    sam_songs: [{ id: SONG_ID, title: "Throwaway", audio_file_path: null, default_bpm: 65,
      warmup_ladder: songLadder }],
    sam_snippets: [{ id: "snip-1", song_id: SONG_ID, title: "Opening bar", start_measure: 1, end_measure: 1,
      rest_measures: 0, settings: { handMode: "rh" }, archived: false, warmup_ladder: snippetLadder }],
  };
  mockDb.progressRows = streakToday
    ? [{ plan_item_id: "item-snip", attempts: streakToday, qualifying: streakToday,
         longest_qualifying_streak: streakToday, ladder_completions: 0 }]
    : [];
  mockDb.songLadder = songLadder;
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
  mockFetchSongById.mockReset().mockImplementation(async () => ({
    song: { ...JSON.parse(JSON.stringify(SONG)), warmupLadder: mockDb.songLadder ?? null },
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

// The strip speaks each rung as the bar it must clear and the tempo it sets. The
// item is 60 BPM at 90%, and these rungs carry no accuracy of their own, so both
// inherit 90 and rung one lands at 42.
const rung1 = (filled) => `rung 1: 90 percent accuracy, at 42 BPM, ${filled} of 2 passes`;
const rung2 = (filled) => `rung 2: 90 percent accuracy, at 60 BPM, ${filled} of 2 passes`;
const bpmValue = () => Number(bpmBox().value);
const playingBpm = () => mockScrollProps.bpm;
const warmUpButton = () => screen.queryByRole("button", { name: /^Warm up/ });
const passInserts = () => mockDb.inserts.filter((i) => i.table === "sam_passes" && !i.isUpdate);
const strip = () => screen.queryByLabelText("Warm-up ladder");
const warmupLine = () => screen.queryByTestId("warmup-line");
// The in-a-row strip, and the live run it draws: the item is 3 in a row at 60
// BPM and 90%.
const inARow = () => screen.queryByLabelText("Plan goal");
const runLabel = (filled, of = 3) =>
  `current run: 90 percent accuracy, at 60 BPM, ${filled} of ${of} passes`;
// The playthrough badge, which carries the target and the §6 warning.
const badge = () => document.querySelector("[data-goal]");

// Open the song directly and pick the saved snippet from the Snippet panel, which
// is how a range with no plan item gets loaded.
async function openSnippetOffPlan() {
  render(
    <MemoryRouter initialEntries={[`/sam/songs/${SONG_ID}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SamPlayer onBack={() => {}} />
    </MemoryRouter>
  );
  await screen.findByLabelText(/BPM:/);
  fireEvent.click(await screen.findByRole("button", { name: "Snippets" }));
  fireEvent.click(await screen.findByRole("button", { name: /^Saved snippets/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^Measures 1-1 RH/ }));
  await waitFor(() => expect(warmUpButton()).toBeInTheDocument());
}

async function pressWarmUp() {
  fireEvent.click(warmUpButton());
  await screen.findByRole("button", { name: /Pause/ });
  mockScrollProps.scrollStateExtRef.current = { scrollStartT: 0 };
}

// A plain sitting: no ladder, the tempo box as the item left it.
async function pressPlay() {
  fireEvent.click(screen.getByRole("button", { name: /^Play$/ }));
  await screen.findByRole("button", { name: /Pause/ });
  mockScrollProps.scrollStateExtRef.current = { scrollStartT: 0 };
}

// ScrollEngine is mocked, so the beat events it would emit are handed over by
// hand. `copies` is what it really does when looping — three renderings of the
// same bars — and the count must survive that.
function emitBeats(n, copies = 3) {
  const events = [];
  for (let c = 0; c < copies; c++) {
    for (let b = 1; b <= n; b++) {
      events.push({ meas: 1, beat: b, allMidi: [60], rhMidi: [60], lhMidi: [] });
    }
  }
  act(() => { mockScrollProps.onBeatEvents(events); });
}

// One chord, scored, without ending the playthrough — which is what the live
// readouts are about.
async function playChord(result = "hit") {
  mockNextResult = result;
  await act(async () => { mockOnChord([60]); });
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
  expect(screen.getByLabelText(rung1(0))).toBeInTheDocument();
  expect(screen.getByLabelText(rung2(0))).toBeInTheDocument();
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
  expect(screen.getByLabelText(rung1(1))).toBeInTheDocument();
  // Still at the rung's tempo: one pass is not an advance.
  expect(playingBpm()).toBe(42);

  await playPass(2);
  // Advanced to the 100% rung, and the tempo followed at the wrap.
  expect(playingBpm()).toBe(60);
  expect(screen.getByLabelText(rung2(0))).toBeInTheDocument();
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
  expect(screen.getByLabelText(rung1(1))).toBeInTheDocument();
  await playPass(2, "miss");
  expect(screen.getByLabelText(rung1(0))).toBeInTheDocument();
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
  expect(screen.getByLabelText(rung1(0))).toBeInTheDocument();
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
  expect(screen.getByLabelText(rung1(0))).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Pause/ })).toBeInTheDocument();
});

test("PAUSE ends the ladder — deliberately, because consecutive means without stopping", async () => {
  await openPlanItem();
  await pressWarmUp();
  await playPass(1);
  expect(screen.getByLabelText(rung1(1))).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /Pause/ }));
  await waitFor(() => expect(strip()).not.toBeInTheDocument());

  // §6.6: "Resuming starts a new session at rung 1." The streak is gone with the
  // session it belonged to, and the ramp begins again at the bottom — rather than
  // leaving him looping at a warm-up tempo with no ladder and nothing saying so.
  fireEvent.click(await screen.findByRole("button", { name: /^Resume$/ }));
  await waitFor(() => expect(strip()).toBeInTheDocument());
  expect(screen.getByLabelText(rung1(0))).toBeInTheDocument();
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
  expect(screen.getByLabelText(rung1(1))).toBeInTheDocument();
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

test("a warm-up item's button is filled, under Practice in the rail", async () => {
  seed({ goalIsWarmup: true });
  await openPlanItem();
  expect(warmUpButton()).toHaveAttribute("data-variant", "primary");
  const buttons = screen.getAllByRole("button").map((b) => b.textContent);
  expect(buttons.indexOf("Warm up")).toBe(buttons.indexOf("Practice") + 1);
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


// --- The warm-up line, wherever Warm up is available (2026-09-27) ------------
//
// It used to render only under the plan line, so the three cases below said
// nothing at all — and the default case is the one that actually misled him.

describe("the warm-up line says what Warm up will do", () => {
  test("on a range with NO plan item", async () => {
    seed({ withPlan: false });
    await openSnippetOffPlan();
    expect(warmupLine()).toHaveTextContent("Warm-up · 70% → 100% · from this snippet");
  });

  test("when the ladder comes from the SONG", async () => {
    seed({
      snippetLadder: null,
      songLadder: [
        { target_percent: 60, accuracy_target: null, target_passes: 2, consecutive: true },
        { target_percent: 100, accuracy_target: null, target_passes: 2, consecutive: true },
      ],
    });
    await openPlanItem();
    expect(warmupLine()).toHaveTextContent("Warm-up · 60% → 100% · from the song");
  });

  test("when it comes from the app DEFAULT — the case that misled him", async () => {
    seed({ snippetLadder: null });
    await openPlanItem();
    await waitFor(() => expect(warmupLine()).toBeInTheDocument());
    expect(warmupLine()).toHaveTextContent("Warm-up · 85% → 100% · default");
  });

  test("a plan item's own ladder still wins, and says so", async () => {
    seed({ itemLadder: [
      { target_percent: 50, accuracy_target: null, target_passes: 1, consecutive: true },
      { target_percent: 70, accuracy_target: null, target_passes: 1, consecutive: true },
      { target_percent: 100, accuracy_target: null, target_passes: 1, consecutive: true },
    ] });
    await openPlanItem();
    expect(warmupLine()).toHaveTextContent("Warm-up · 50% → 70% → 100% · from the plan");
  });

  test("no line when there is no warm-up for the range", async () => {
    seed({ snippetLadder: [] });
    await openPlanItem();
    expect(warmupLine()).not.toBeInTheDocument();
  });

  test("no line on a whole song, where there is no button either", async () => {
    await openWholeSong();
    expect(warmupLine()).not.toBeInTheDocument();
    expect(warmUpButton()).not.toBeInTheDocument();
  });
});

// --- The snippet ladder editor, end to end (§7.4) -----------------------------

const openLadderDialog = async () => {
  // Idempotent: the panel is only toggled when the flame is not already on screen,
  // so a test can open the dialog twice without closing the panel in between.
  if (!screen.queryByRole("button", { name: /Warm-up ladder for m\.1-1/ })) {
    if (!screen.queryByRole("button", { name: /^Saved snippets/ })) {
      fireEvent.click(await screen.findByRole("button", { name: "Snippets" }));
    }
    fireEvent.click(await screen.findByRole("button", { name: /^Saved snippets/ }));
  }
  fireEvent.click(await screen.findByRole("button", { name: /Warm-up ladder for m\.1-1/ }));
  return screen.findByRole("dialog", { name: "Warm-up ladder" });
};

const ladderUpdates = () =>
  mockDb.inserts.filter((i) => i.table === "sam_snippets" && i.isUpdate && "warmup_ladder" in i.row);

describe("editing a snippet's ladder from the app", () => {
  const dialog = () => screen.getByRole("dialog", { name: "Warm-up ladder" });
  const modeRadio = (name) => within(dialog()).getByRole("radio", { name });
  const save = () => within(dialog()).getByRole("button", { name: /^Save$/ });
  const cancel = () => within(dialog()).getByRole("button", { name: /^Cancel$/ });

  test("the dialog opens on the snippet row and shows what will run", async () => {
    await openPlanItem();
    const dlg = await openLadderDialog();
    expect(modeRadio("Set here")).toBeChecked();
    expect(dlg).toHaveTextContent("As things stand, pressing Warm up runs 70% → 100% · from this snippet.");
  });

  test("a rung edit writes nothing until Save, then applies straight away", async () => {
    await openPlanItem();
    await openLadderDialog();
    fireEvent.change(screen.getByLabelText("Rung 1 percent of target tempo"), { target: { value: "50" } });
    // The one thing this whole change is about: still nothing written.
    expect(ladderUpdates()).toHaveLength(0);

    fireEvent.click(save());
    await waitFor(() => expect(ladderUpdates()).toHaveLength(1));
    expect(ladderUpdates()[0].row.warmup_ladder).toEqual([
      { target_percent: 50, accuracy_target: null, target_passes: 2, consecutive: true },
      { target_percent: 100, accuracy_target: null, target_passes: 2, consecutive: true },
    ]);
    // Save closes the dialog, and the loaded range picks the ladder up without a
    // reload — the line under the plan line is the check.
    await waitFor(() => expect(warmupLine()).toHaveTextContent("Warm-up · 50% → 100% · from this snippet"));
  });

  test("Cancel discards a rung edit AND a state change", async () => {
    await openPlanItem();
    await openLadderDialog();
    fireEvent.change(screen.getByLabelText("Rung 1 percent of target tempo"), { target: { value: "50" } });
    fireEvent.click(modeRadio("No warm-up here"));
    fireEvent.click(cancel());

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Warm-up ladder" })).not.toBeInTheDocument());
    expect(ladderUpdates()).toHaveLength(0);
    // Nothing moved: the snippet still runs what it ran before.
    expect(warmupLine()).toHaveTextContent("Warm-up · 70% → 100% · from this snippet");

    // And reopening starts from what is stored, not from the abandoned draft.
    await openLadderDialog();
    expect(modeRadio("Set here")).toBeChecked();
    expect(screen.getByLabelText("Rung 1 percent of target tempo")).toHaveValue(70);
  });

  test("Inherit, saved, makes the range fall through to the default", async () => {
    await openPlanItem();
    await openLadderDialog();
    fireEvent.click(modeRadio("Inherit"));
    expect(ladderUpdates()).toHaveLength(0);
    fireEvent.click(save());
    await waitFor(() => expect(ladderUpdates()).toHaveLength(1));
    expect(ladderUpdates()[0].row.warmup_ladder).toBeNull();
    await waitFor(() => expect(warmupLine()).toHaveTextContent("Warm-up · 85% → 100% · default"));
  });

  test("No warm-up here, saved, removes the Warm up button for that range", async () => {
    await openPlanItem();
    await openLadderDialog();
    fireEvent.click(modeRadio("No warm-up here"));
    expect(screen.getByTestId("ladder-consequence"))
      .toHaveTextContent("There will be no warm-up for this range.");
    fireEvent.click(save());
    await waitFor(() => expect(ladderUpdates()).toHaveLength(1));
    expect(ladderUpdates()[0].row.warmup_ladder).toEqual([]);

    await waitFor(() => expect(warmUpButton()).not.toBeInTheDocument());
    expect(warmupLine()).not.toBeInTheDocument();
  });

  test("and switching back to Inherit restores the inherited ladder", async () => {
    seed({ snippetLadder: [] });
    await openPlanItem();
    expect(warmUpButton()).not.toBeInTheDocument();

    await openLadderDialog();
    expect(modeRadio("No warm-up here")).toBeChecked();
    fireEvent.click(modeRadio("Inherit"));
    fireEvent.click(save());
    await waitFor(() => expect(ladderUpdates()).toHaveLength(1));
    expect(ladderUpdates()[0].row.warmup_ladder).toBeNull();

    await waitFor(() => expect(warmUpButton()).toBeInTheDocument());
    expect(warmupLine()).toHaveTextContent("Warm-up · 85% → 100% · default");
  });

  test("a plan item's ladder is shown read-only above the snippet's, and says why", async () => {
    seed({ itemLadder: [
      { target_percent: 50, accuracy_target: null, target_passes: 1, consecutive: true },
      { target_percent: 100, accuracy_target: null, target_passes: 1, consecutive: true },
    ] });
    await openPlanItem();
    const dlg = await openLadderDialog();
    // The item block is folded by default — it is context, not the thing he came
    // to change — so its state shows in the header until he opens it.
    expect(screen.getByTestId("ladder-collapsed-summary")).toHaveTextContent("50% → 100% · set here");
    fireEvent.click(within(dlg).getByRole("button", { expanded: false }));
    expect(screen.getByTestId("ladder-readonly-note")).toHaveTextContent(/plans are never edited/);
    // The snippet's own editor is still there and still editable underneath.
    expect(dlg).toHaveTextContent("As things stand, pressing Warm up runs 50% → 100% · from the plan.");
    expect(within(dlg).getByRole("button", { name: /^Save$/ })).toBeInTheDocument();
  });

  test("an invalid ladder never reaches the database", async () => {
    await openPlanItem();
    await openLadderDialog();
    // The target rung's percent cannot be typed into any more, so the reachable
    // mistake is a rung above it that is not below it.
    fireEvent.change(screen.getByLabelText("Rung 1 percent of target tempo"), { target: { value: "100" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Warm-up ladder" })).getByRole("button", { name: /^Save$/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("higher than the rung above (100%)");
    expect(ladderUpdates()).toHaveLength(0);
    // The dialog stays open, because there is something to fix in it.
    expect(screen.getByRole("dialog", { name: "Warm-up ladder" })).toBeInTheDocument();
  });
});

// The inline plus controls, through the real dialog (2026-09-27).
test("a rung inserted with the plus above the 100 row is saved with the rest", async () => {
  await openPlanItem();
  const dlg = await openLadderDialog();
  const pluses = within(dlg).getAllByRole("button", { name: /^Insert a rung/ });
  // Two rungs, so two pluses: above rung 1, and above the target.
  expect(pluses).toHaveLength(2);

  fireEvent.click(pluses[1]);
  fireEvent.change(screen.getByLabelText("Rung 2 percent of target tempo"), { target: { value: "85" } });
  expect(mockDb.inserts.filter((i) => i.isUpdate && "warmup_ladder" in i.row)).toHaveLength(0);

  fireEvent.click(within(dlg).getByRole("button", { name: /^Save$/ }));
  await waitFor(() => expect(mockDb.inserts.filter((i) => i.isUpdate && "warmup_ladder" in i.row)).toHaveLength(1));
  const saved = mockDb.inserts.filter((i) => i.isUpdate && "warmup_ladder" in i.row)[0].row.warmup_ladder;
  expect(saved.map((r) => r.target_percent)).toEqual([70, 85, 100]);
  await waitFor(() => expect(warmupLine()).toHaveTextContent("Warm-up · 70% → 85% → 100% · from this snippet"));
});

// --- the advancing pass records the tempo it was PLAYED at (2026-09-27) --------
//
// The rung advance moves the tempo at the loop WRAP, and the pass row is written on
// a macrotask after that. So the row used to come out with the NEXT rung's tempo
// under the rung it had just left: a 70% pass at 42 BPM written as 51. The label was
// never wrong; the tempo was.

test("the pass that causes an advance records its own rung's tempo, not the next one", async () => {
  await openPlanItem();
  await pressWarmUp();
  expect(playingBpm()).toBe(42);      // 70% of the item's 60 BPM target

  await playPass(1);                  // credited at rung 1, no advance
  await playPass(2);                  // credited at rung 1, and ADVANCES to rung 2
  expect(playingBpm()).toBe(60);      // the box has moved on

  await waitFor(() => expect(passInserts().length).toBe(2));
  for (const [i, row] of passInserts().map((p) => p.row).entries()) {
    expect(row.warmup_rung).toBe(1);
    expect(row.warmup_target_percent).toBe(70);
    // Both passes were heard at 42. Before the fix the second said 60.
    expect(row.bpm).toBe(42);
    expect(row.playback_speed).toBe(100);
  }
});

test("the pass after the advance records the new rung's tempo", async () => {
  await openPlanItem();
  await pressWarmUp();
  await playPass(1);
  await playPass(2);                  // advances
  await playPass(3);                  // first pass at the top rung
  await waitFor(() => expect(passInserts().length).toBe(3));
  const third = passInserts()[2].row;
  expect(third.warmup_rung).toBe(2);
  expect(third.warmup_target_percent).toBe(100);
  expect(third.bpm).toBe(60);
});

test("a pass with no ladder still records the tempo box, as it always did", async () => {
  seed({ snippetLadder: [] });
  await openPlanItem();
  fireEvent.click(await screen.findByRole("button", { name: /^Play$/ }));
  await screen.findByRole("button", { name: /Pause/ });
  mockScrollProps.scrollStateExtRef.current = { scrollStartT: 0 };
  await playPass(1);
  await waitFor(() => expect(passInserts().length).toBe(1));
  expect(passInserts()[0].row).toMatchObject({ bpm: 60, playback_speed: 100, warmup_rung: null });
});

// --- The playing bar's target readouts (2026-09-28) --------------------------
//
// Three numbers share this bar and they are different numbers on purpose: the
// warm-up rung's bar, the live in-a-row run, and the day's best run from the
// database. Each block below pins one of them down.

describe("the in-a-row strip: the CURRENT run, beside the day's best", () => {
  test("it fills as qualifying passes land, and empties on a pass that fails", async () => {
    seed({ consecutive: true, targetPasses: 3, snippetLadder: [], streakToday: 2 });
    await openPlanItem();
    await pressPlay();

    expect(screen.getByLabelText(runLabel(0))).toBeInTheDocument();
    await playPass(1);
    expect(screen.getByLabelText(runLabel(1))).toBeInTheDocument();
    await playPass(2);
    expect(screen.getByLabelText(runLabel(2))).toBeInTheDocument();

    await playPass(3, "miss");
    expect(screen.getByLabelText(runLabel(0))).toBeInTheDocument();
    // Item 3: the day's best is a different number and does NOT roll back with
    // the run. Both are on screen, and each says which it is.
    expect(screen.getByTestId("consecutive-best")).toHaveTextContent("best 2 of 3 today");
  });

  test("a pass below the item's tempo does not count — the warm-up rungs fill, the run does not", async () => {
    seed({ consecutive: true, targetPasses: 3 });
    await openPlanItem();
    await pressWarmUp();
    await playPass(1);
    // Rung one is 42 BPM, under the item's 60, so the database would not count
    // this pass either. The ladder moves; the run stays where it was.
    expect(screen.getByLabelText(rung1(1))).toBeInTheDocument();
    expect(screen.getByLabelText(runLabel(0))).toBeInTheDocument();
  });

  test("the run belongs to one sitting: pause and resume start it again", async () => {
    seed({ consecutive: true, targetPasses: 3, snippetLadder: [] });
    await openPlanItem();
    await pressPlay();
    await playPass(1);
    expect(screen.getByLabelText(runLabel(1))).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Pause/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Resume$/ }));
    await screen.findByRole("button", { name: /Pause/ });
    expect(screen.getByLabelText(runLabel(0))).toBeInTheDocument();
  });

  test("an item that is not consecutive gets the goal line without best-of-today", async () => {
    seed({ snippetLadder: [] });
    await openPlanItem();
    await pressPlay();
    expect(inARow()).toHaveTextContent("Goal");
    expect(inARow()).toHaveTextContent("90% (60)");
    expect(inARow()).toHaveTextContent("Plan 0/4");
    expect(screen.queryByTestId("consecutive-best")).not.toBeInTheDocument();
  });
});

// --- The glance line (sam_glance, 2026-10-05) --------------------------------
//
// Everything is asserted after onContentEnd and BEFORE onLoopCount: that gap is
// the rest bar, the only moment he can read the screen. The database is left
// saying what it said before, so anything that moved got there live.

async function endMusic(n, result = "hit") {
  mockNextResult = result;
  await act(async () => { mockOnChord([60]); });
  await act(async () => { mockScrollProps.onContentEnd(n); });
}
async function nextPass(n) {
  await act(async () => { mockScrollProps.onLoopCount(n); });
  await drain();
}
// eslint-disable-next-line testing-library/no-node-access
const dots = () => screen.getByTestId("goal-dots").querySelectorAll("[data-mark=filled]").length;
const goalPlan = () => screen.getByTestId("goal-plan");

describe("at pass end, before the rest bar is over", () => {
  test("a qualifying pass on a plain item: dot, Plan n/m, pulse and a green figure, all before the database", async () => {
    seed({ snippetLadder: [] });
    await openPlanItem();
    await pressPlay();
    await endMusic(1);
    expect(dots()).toBe(1);
    expect(goalPlan()).toHaveTextContent("Plan 1/4");
    expect(inARow()).toHaveAttribute("data-pulse", "qualified");
    expect(badge()).toHaveAttribute("data-goal", "met");
    expect(badge()).toHaveTextContent("100%");
    expect(within(badge()).getByText("100%")).toHaveClass("text-done-strong");

    // The next pass starts: the figure goes back to the dash.
    await nextPass(1);
    expect(badge()).toHaveAttribute("data-goal", "none");
    expect(badge()).toHaveTextContent("—");
    // The refetch still says 0, and the count does not flicker back.
    expect(goalPlan()).toHaveTextContent("Plan 1/4");
    expect(dots()).toBe(1);
  });

  test("the database catching up moves the count on, never back", async () => {
    seed({ snippetLadder: [] });
    await openPlanItem();
    await pressPlay();
    // This pass plus two from another device, as the refetch will see it.
    mockDb.progressRows = [{ plan_item_id: "item-snip", attempts: 3, qualifying: 3,
      longest_qualifying_streak: 1, ladder_completions: 0 }];
    await endMusic(1);
    await nextPass(1);
    await waitFor(() => expect(goalPlan()).toHaveTextContent("Plan 3/4"));
  });

  test("a pass that misses: amber figure, no dot, no pulse", async () => {
    seed({ snippetLadder: [] });
    await openPlanItem();
    await pressPlay();
    await endMusic(1, "miss");
    expect(dots()).toBe(0);
    expect(inARow()).toHaveAttribute("data-pulse", "none");
    expect(badge()).toHaveAttribute("data-goal", "short");
    expect(within(badge()).getByText("0%")).toHaveClass("text-amber-700");
  });

  test("a pass that became impossible shows its final figure amber in the rest, not the red warning", async () => {
    seed({ snippetLadder: [] });
    await openPlanItem();
    await pressPlay();
    emitBeats(4);
    await playChord("miss");
    expect(badge()).toHaveAttribute("data-goal", "impossible");
    await act(async () => { mockScrollProps.onContentEnd(1); });
    expect(badge()).toHaveAttribute("data-goal", "short");
  });

  test("in a row: a broken run flashes amber and best-of-today holds", async () => {
    seed({ consecutive: true, targetPasses: 3, snippetLadder: [] });
    await openPlanItem();
    await pressPlay();
    await endMusic(1);
    await nextPass(1);
    await endMusic(2, "miss");
    expect(inARow()).toHaveAttribute("data-pulse", "broke");
    expect(screen.getByLabelText(runLabel(0))).toBeInTheDocument();
    expect(screen.getByTestId("consecutive-best")).toHaveTextContent("best 1 of 3 today");
    expect(goalPlan()).toHaveTextContent("Plan 1/3");
  });

  test("in a row: the pass that completes it turns the line green with a check, before the database", async () => {
    seed({ consecutive: true, targetPasses: 2, snippetLadder: [] });
    await openPlanItem();
    await pressPlay();
    await endMusic(1);
    await nextPass(1);
    await endMusic(2);
    expect(inARow()).toHaveAttribute("data-done", "true");
    expect(inARow()).toHaveClass("bg-done");
    expect(screen.getByLabelText("Plan item done")).toBeInTheDocument();
    expect(goalPlan()).toHaveTextContent("Plan ✓");
    expect(screen.getByTestId("consecutive-best")).toHaveTextContent("best 2 of 2 today");
    await nextPass(2);
    expect(inARow()).toHaveAttribute("data-done", "true");
  });

  test("a warm-up item: no goal line, and its plan readout ends the warm-up strip", async () => {
    seed({ goalIsWarmup: true });
    await openPlanItem();
    await pressWarmUp();
    expect(inARow()).not.toBeInTheDocument();
    expect(screen.getByTestId("warmup-plan")).toHaveTextContent(/^Warm-up · /);
    expect(screen.getByText(/Completed Passes:/).parentElement).not.toHaveTextContent(/Warm-up ·/); // eslint-disable-line testing-library/no-node-access
  });
});

describe("the strip names the accuracy it wants, with the tempo in brackets", () => {
  test("a rung shows the bar it must clear and the BPM it sets", async () => {
    await openPlanItem();
    await pressWarmUp();
    // The rungs carry no accuracy of their own, so both inherit the item's 90.
    expect(strip()).toHaveTextContent("90% (42)");
    expect(strip()).toHaveTextContent("90% (60)");
    // The percent OF TARGET TEMPO is gone: it is the one number he does not play
    // to, and it read as an accuracy at a glance.
    expect(strip()).not.toHaveTextContent("70%");
  });

  test("the in-a-row strip says the same two things", async () => {
    seed({ consecutive: true, targetPasses: 3, snippetLadder: [] });
    await openPlanItem();
    await pressPlay();
    expect(inARow()).toHaveTextContent("90% (60)");
  });
});

describe("playthrough accuracy against the target", () => {
  test("at or above the target: the figure, the bar, and the word", async () => {
    seed({ snippetLadder: [] });
    await openPlanItem();
    await pressPlay();
    await playChord("hit");
    expect(badge()).toHaveAttribute("data-goal", "met");
    expect(badge()).toHaveTextContent("100%");
    expect(badge()).toHaveTextContent("/ 90%");
    // Not colour alone: the word and the shape both say it.
    expect(badge()).toHaveTextContent(/met/);
    expect(within(badge()).getByLabelText("Target met")).toBeInTheDocument();
  });

  test("below it: short, with its own word and shape", async () => {
    seed({ snippetLadder: [] });
    await openPlanItem();
    await pressPlay();
    await playChord("miss");
    expect(badge()).toHaveAttribute("data-goal", "short");
    expect(badge()).toHaveTextContent("0%");
    expect(badge()).toHaveTextContent(/short/);
    expect(within(badge()).getByLabelText("Below target")).toBeInTheDocument();
  });

  test("while a ladder runs it is the RUNG's bar, not the item's", async () => {
    seed({ snippetLadder: [
      { target_percent: 70, accuracy_target: 60, target_passes: 2, consecutive: true },
      { target_percent: 100, accuracy_target: null, target_passes: 2, consecutive: true },
    ] });
    await openPlanItem();
    await pressWarmUp();
    await playChord("hit");
    expect(badge()).toHaveTextContent("/ 60%");
  });

  test("no target, no fraction: the badge is exactly what it always was", async () => {
    // Off plan, and no ladder running: there is no bar to measure against.
    seed({ withPlan: false });
    await openSnippetOffPlan();
    await pressPlay();
    await playChord("hit");
    expect(badge()).toHaveAttribute("data-goal", "none");
    expect(badge()).not.toHaveTextContent("/");
  });
});

describe("the target has become impossible (§6)", () => {
  // Four scoreable beats at a 90% bar: one miss leaves a ceiling of 3/4 = 75%.
  const seedFour = async () => {
    seed({ snippetLadder: [] });
    await openPlanItem();
    await pressPlay();
    emitBeats(4);
  };

  test("one miss too many turns the badge red and says so in words", async () => {
    await seedFour();
    await playChord("miss");
    expect(badge()).toHaveAttribute("data-goal", "impossible");
    expect(badge()).toHaveTextContent(/can't reach/);
    expect(within(badge()).getByLabelText("Target out of reach")).toBeInTheDocument();
    expect(badge().className).toMatch(/bg-destructive/);
  });

  test("it clears when the next playthrough starts", async () => {
    await seedFour();
    await playChord("miss");
    expect(badge()).toHaveAttribute("data-goal", "impossible");
    await act(async () => {
      mockScrollProps.onContentEnd(1);
      mockScrollProps.onLoopCount(1);
    });
    await drain();
    expect(badge()).not.toHaveAttribute("data-goal", "impossible");
  });

  test("a miss that still leaves the target reachable says nothing", async () => {
    seed({ snippetLadder: [] });
    await openPlanItem();
    await pressPlay();
    emitBeats(40);          // one miss in forty still rounds to 98%
    await playChord("miss");
    expect(badge()).toHaveAttribute("data-goal", "short");
  });

  test("with no beat count it stays quiet — a false give-up is the worse failure", async () => {
    seed({ snippetLadder: [] });
    await openPlanItem();
    await pressPlay();
    await playChord("miss");   // no onBeatEvents at all
    expect(badge()).toHaveAttribute("data-goal", "short");
  });
});
