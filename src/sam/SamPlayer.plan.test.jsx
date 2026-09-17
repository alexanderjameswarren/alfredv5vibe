// Practice plans M4, end to end through SamPlayer (spec §7.2, §7.3):
//   - the home page shows the active plan's checklist, with progress from
//     sam_plan_item_progress for today;
//   - tapping an item opens its song and snippet at the item's target tempo;
//   - the session and the pass rows written afterwards carry the plan link;
//   - a recorded pass refetches today's progress (and only progress).

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
jest.mock("./lib/useMIDI", () => () => ({ connected: false, deviceName: null, lastNote: null }));
jest.mock("./lib/audioPlayer", () => ({ uploadAudio: jest.fn(), loadAudio: jest.fn() }));

const SONG_ID = "11111111-1111-1111-1111-111111111111";
const mockFetchSongById = jest.fn();
jest.mock("./lib/songLoad", () => ({
  ...jest.requireActual("./lib/songLoad"),
  fetchSongById: (...args) => mockFetchSongById(...args),
}));

// --- Supabase: canned tables, recorded inserts and rpc calls ----------------
const mockDb = { tables: {}, inserts: [], rpcs: [], froms: [] };
jest.mock("../supabaseClient", () => {
  function query(table) {
    mockDb.froms.push(table);
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
      rpc: (fn, args) => {
        mockDb.rpcs.push({ fn, args });
        const data = fn === "sam_plan_item_progress" ? mockDb.progressRows ?? [] : [];
        return Promise.resolve({ data, error: null });
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

const SONG = {
  title: "Throwaway",
  artist: null,
  defaultBpm: 65,
  playbackSpeed: 100,
  goalBpm: 72,
  goalPlaybackSpeed: 100,
  audioFilePath: null,
  showImportedFingerings: true,
  measures: [1, 2].map((n) => ({
    number: n,
    timeSignature: { beats: 4, beatType: 4 },
    rh: [{ duration: "w", notes: [{ midi: 60, name: "C4" }] }],
    lh: [{ duration: "w", notes: [] }],
  })),
};

function seed() {
  mockDb.tables = {
    sam_practice_plans: [{ id: "plan-1", status: "active", day_note: "Slow and even." }],
    sam_practice_plan_songs: [{ id: "ps-1", plan_id: "plan-1", song_id: SONG_ID, position: 1, song_note: null }],
    sam_practice_plan_items: [
      { id: "item-snip", plan_id: "plan-1", song_id: SONG_ID, snippet_id: "snip-1", position: 1,
        is_free_play: false, target_bpm: 60, target_playback_speed: 100, target_effective_bpm: 60,
        target_passes: 4, accuracy_target: 90, instruction: "Count out loud." },
      { id: "item-whole", plan_id: "plan-1", song_id: SONG_ID, snippet_id: null, position: 2,
        is_free_play: false, target_bpm: 55, target_playback_speed: 100, target_effective_bpm: 55,
        target_passes: 2, accuracy_target: 80, instruction: null },
    ],
    sam_songs: [{ id: SONG_ID, title: "Throwaway", audio_file_path: null, default_bpm: 65 }],
    sam_snippets: [{ id: "snip-1", song_id: SONG_ID, title: "Opening bar", start_measure: 1, end_measure: 1,
      rest_measures: 0, settings: { handMode: "rh" }, archived: false }],
  };
  mockDb.progressRows = [{ plan_item_id: "item-whole", day: "2026-09-16", attempts: 2, qualifying: 2 }];
  mockDb.inserts = [];
  mockDb.rpcs = [];
  mockDb.froms = [];
}

beforeEach(() => {
  seed();
  mockScrollProps = null;
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

function renderHome() {
  return render(
    <MemoryRouter initialEntries={["/sam"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SamPlayer onBack={() => {}} />
    </MemoryRouter>
  );
}

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function expandPlan() {
  fireEvent.click(await screen.findByRole("button", { name: /Today's plan · 1 of 2 done/ }));
}

async function openItem(rowText) {
  renderHome();
  await expandPlan();
  fireEvent.click(screen.getByRole("button", { name: new RegExp(esc(rowText)) }));
  await screen.findByLabelText(/BPM:/);
}

async function pressPlay() {
  fireEvent.click(await screen.findByRole("button", { name: /^Play$/ }));
  await waitFor(() => expect(sessionInserts()).toHaveLength(1));
}

const sessionInserts = () => mockDb.inserts.filter((i) => i.table === "sam_sessions");
const passInserts = () => mockDb.inserts.filter((i) => i.table === "sam_passes");

test("the home page shows the plan with today's progress from the database only", async () => {
  renderHome();
  expect(await screen.findByText("Today's plan · 1 of 2 done")).toBeInTheDocument();
  expect(screen.getByText("Slow and even.")).toBeInTheDocument();
  const progressCalls = mockDb.rpcs.filter((r) => r.fn === "sam_plan_item_progress");
  expect(progressCalls.length).toBeGreaterThanOrEqual(1);
  for (const c of progressCalls) {
    expect(c.args.p_plan_id).toBe("plan-1");
    expect(c.args.p_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(c.args.p_to).toBe(c.args.p_from);
  }
  // Passes are never read to count progress.
  expect(mockDb.froms).not.toContain("sam_passes");
});

test("no active plan: no checklist", async () => {
  mockDb.tables.sam_practice_plans = [];
  renderHome();
  await waitFor(() => expect(mockDb.froms).toContain("sam_practice_plans"));
  expect(screen.queryByText(/Today's plan/)).not.toBeInTheDocument();
});

test("regaining focus reloads the plan", async () => {
  renderHome();
  await screen.findByText("Today's plan · 1 of 2 done");
  const before = mockDb.froms.filter((t) => t === "sam_practice_plans").length;
  mockDb.tables.sam_practice_plans = [];
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await waitFor(() => expect(screen.queryByText(/Today's plan/)).not.toBeInTheDocument());
  expect(mockDb.froms.filter((t) => t === "sam_practice_plans").length).toBeGreaterThan(before);
});

test("tapping a snippet item opens its song and snippet at the target tempo; the session and pass carry the link", async () => {
  await openItem("Throwaway · Opening bar");
  expect(mockFetchSongById).toHaveBeenCalledWith(SONG_ID, expect.anything());
  expect(screen.getByLabelText(/BPM:/)).toHaveValue(60);
  // Tempo is applied for this sitting only — nothing was written to the song.
  expect(mockDb.inserts.filter((i) => i.table === "sam_songs")).toEqual([]);

  await pressPlay();
  expect(sessionInserts()[0].row).toMatchObject({
    song_id: SONG_ID, snippet_id: "snip-1", plan_id: "plan-1", plan_item_id: "item-snip",
  });
  expect(sessionInserts()[0].row.settings).toMatchObject({ bpm: 60, handMode: "rh" });

  // One completed loop: a pass, linked the same way, then a progress-only refetch.
  const plansBefore = mockDb.froms.filter((t) => t === "sam_practice_plans").length;
  const progressBefore = mockDb.rpcs.filter((r) => r.fn === "sam_plan_item_progress").length;
  await act(async () => { mockScrollProps.onLoopCount(1); });
  await waitFor(() => expect(passInserts()).toHaveLength(1));
  expect(passInserts()[0].row).toMatchObject({
    snippet_id: "snip-1", bpm: 60, plan_id: "plan-1", plan_item_id: "item-snip",
  });
  await waitFor(() =>
    expect(mockDb.rpcs.filter((r) => r.fn === "sam_plan_item_progress").length).toBe(progressBefore + 1));
  expect(mockDb.froms.filter((t) => t === "sam_practice_plans").length).toBe(plansBefore);
});

test("a whole-song item opens without a snippet and links to the whole-song item", async () => {
  await openItem("55 BPM · 80% · 2 passes");
  expect(screen.getByLabelText(/BPM:/)).toHaveValue(55);
  await pressPlay();
  const row = sessionInserts()[0].row;
  expect(row).not.toHaveProperty("snippet_id");
  expect(row).toMatchObject({ plan_id: "plan-1", plan_item_id: "item-whole" });
});

test("an archived snippet opens the song without it", async () => {
  mockDb.tables.sam_snippets[0].archived = true;
  renderHome();
  await expandPlan();
  const row = screen.getByRole("button", { name: /\(snippet archived\)/ });
  expect(within(row).getByText(/Throwaway/)).toBeInTheDocument();
  fireEvent.click(row);
  expect(await screen.findByLabelText(/BPM:/)).toHaveValue(60);
  await pressPlay();
  // Whole song now, so it matches the whole-song item, not the snippet item.
  expect(sessionInserts()[0].row).not.toHaveProperty("snippet_id");
  expect(sessionInserts()[0].row.plan_item_id).toBe("item-whole");
});
