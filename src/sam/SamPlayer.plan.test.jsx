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
const mockDb = { tables: {}, inserts: [], updates: [], rpcs: [], froms: [], hangPlans: false };
jest.mock("../supabaseClient", () => {
  function query(table) {
    mockDb.froms.push(table);
    const filters = [];
    let insert = null;
    let update = null;
    const rows = () => (mockDb.tables[table] || []).filter((r) => filters.every((f) => f(r)));
    const api = new Proxy({}, {
      get(_, prop) {
        if (prop === "then") {
          return (resolve, reject) => {
            if (insert) mockDb.inserts.push({ table, row: insert });
            if (update) mockDb.updates.push({ table, row: update });
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
              // A plan that has not loaded yet: the request never answers.
              if (table === "sam_practice_plans" && mockDb.hangPlans) return new Promise(() => {});
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
  mockDb.updates = [];
  mockDb.hangPlans = false;
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
  fireEvent.click(await screen.findByRole("button", { name: /Today's plan · / }));
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

// One finished playthrough, as ScrollEngine actually signals it: the music
// ends (onContentEnd, which banks the pass) and then the loop restarts
// (onLoopCount, which rotates the counters). With no rest bars the engine
// fires both at the teleport; with rest bars onContentEnd comes a bar earlier.
async function completePass(n) {
  mockScrollProps.onContentEnd(n);
  mockScrollProps.onLoopCount(n);
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
  await openItem("m.1–1 · RH · Opening bar");
  expect(mockFetchSongById).toHaveBeenCalledWith(SONG_ID, expect.anything());
  expect(screen.getByLabelText(/BPM:/)).toHaveValue(60);
  // Song defaults loaded first (65), then the plan tempo on top — for this
  // sitting only: nothing was written to the song.
  expect(SONG.defaultBpm).toBe(65);
  expect(mockDb.inserts.filter((i) => i.table === "sam_songs")).toEqual([]);
  expect(mockDb.updates.filter((u) => u.table === "sam_songs")).toEqual([]);

  await pressPlay();
  expect(sessionInserts()[0].row).toMatchObject({
    song_id: SONG_ID, snippet_id: "snip-1", plan_id: "plan-1", plan_item_id: "item-snip",
  });
  expect(sessionInserts()[0].row.settings).toMatchObject({ bpm: 60, handMode: "rh" });

  // One completed loop: a pass, linked the same way, then a progress-only refetch.
  const plansBefore = mockDb.froms.filter((t) => t === "sam_practice_plans").length;
  const progressBefore = mockDb.rpcs.filter((r) => r.fn === "sam_plan_item_progress").length;
  await act(async () => { completePass(1); });
  await waitFor(() => expect(passInserts()).toHaveLength(1));
  expect(passInserts()[0].row).toMatchObject({
    snippet_id: "snip-1", bpm: 60, plan_id: "plan-1", plan_item_id: "item-snip",
  });
  await waitFor(() =>
    expect(mockDb.rpcs.filter((r) => r.fn === "sam_plan_item_progress").length).toBe(progressBefore + 1));
  expect(mockDb.froms.filter((t) => t === "sam_practice_plans").length).toBe(plansBefore);
});

test("a whole-song item opens without a snippet and links to the whole-song item", async () => {
  await openItem("Whole song");
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

test("the library has a SAM header in the library's centered column", async () => {
  renderHome();
  const heading = await screen.findByRole("heading", { name: "SAM" });
  const back = screen.getByRole("button", { name: "Back to Alfred" });
  // Back arrow and title share one row, inside the same max-w-lg column as the
  // library, with the title in its own centered cell.
  const row = back.parentElement; // eslint-disable-line testing-library/no-node-access
  expect(row).toHaveClass("max-w-lg", "mx-auto", "grid");
  expect(row).toContainElement(heading);
  expect(heading.parentElement).toHaveClass("justify-center"); // eslint-disable-line testing-library/no-node-access
});

test("archiving the planned snippet in the player shows on the strip when you return home", async () => {
  await openItem("m.1–1 · RH · Opening bar");
  // What SnippetPanel's archive button writes, as the database would then hold it.
  mockDb.tables.sam_snippets[0].archived = true;
  fireEvent.click(screen.getByRole("button", { name: "Back to song library" }));
  // The strip was left expanded, and remembers it.
  expect(await screen.findByText("m.1–1 · RH · Opening bar · (snippet archived)")).toBeInTheDocument();
});

test("a pass completed before the plan has loaded is still written, with null links", async () => {
  mockDb.hangPlans = true;
  render(
    <MemoryRouter initialEntries={[`/sam/songs/${SONG_ID}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SamPlayer onBack={() => {}} />
    </MemoryRouter>
  );
  await screen.findByLabelText(/BPM:/);
  await pressPlay();
  expect(sessionInserts()[0].row).toMatchObject({ plan_id: null, plan_item_id: null });
  await act(async () => { completePass(1); });
  await waitFor(() => expect(passInserts()).toHaveLength(1));
  expect(passInserts()[0].row).toMatchObject({ song_id: SONG_ID, plan_id: null, plan_item_id: null });
});

// --- Milestone 5: the player display (§7.4) ---------------------------------

function renderSong() {
  return render(
    <MemoryRouter initialEntries={[`/sam/songs/${SONG_ID}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SamPlayer onBack={() => {}} />
    </MemoryRouter>
  );
}

test("plan line for the whole-song item; Set tempo applies the item tempo without saving", async () => {
  renderSong();
  // Song default 65; the whole-song item is done today (2 of 2 qualifying).
  const line = await screen.findByText("Plan · Whole song · 55 BPM · 80% · Done 2/2 today");
  expect(line).toHaveClass("text-foreground");
  expect(screen.getByLabelText(/BPM:/)).toHaveValue(65);
  fireEvent.click(screen.getByRole("button", { name: "Set tempo" }));
  expect(screen.getByLabelText(/BPM:/)).toHaveValue(55);
  expect(screen.queryByRole("button", { name: "Set tempo" })).not.toBeInTheDocument();
  expect(mockDb.updates.filter((u) => u.table === "sam_songs")).toEqual([]);
});

test("a song outside the plan shows nothing new", async () => {
  mockDb.tables.sam_practice_plan_songs = [];
  mockDb.tables.sam_practice_plan_items = [];
  renderSong();
  await screen.findByLabelText(/BPM:/);
  await waitFor(() => expect(mockDb.froms).toContain("sam_practice_plan_items"));
  expect(screen.queryByText(/^Plan ·/)).not.toBeInTheDocument();
  expect(screen.queryByText(/^Song goal:/)).not.toBeInTheDocument();
});

test("song note under the plan line, and alone when the loaded range has no item", async () => {
  mockDb.tables.sam_practice_plan_songs[0].song_note = "Keep it steady.";
  const { unmount } = renderSong();
  expect(await screen.findByRole("button", { name: "Song goal: Keep it steady." })).toBeInTheDocument();
  expect(screen.getByText(/^Plan · Whole song · 55 BPM/)).toBeInTheDocument();
  unmount();

  seed();
  mockDb.tables.sam_practice_plan_songs[0].song_note = "Keep it steady.";
  mockDb.tables.sam_practice_plan_items = mockDb.tables.sam_practice_plan_items.filter((i) => i.snippet_id);
  renderSong();
  expect(await screen.findByRole("button", { name: "Song goal: Keep it steady." })).toBeInTheDocument();
  expect(screen.queryByText(/^Plan ·/)).not.toBeInTheDocument();
});

test("while playing: a compact plan count next to Completed Passes, amber, then ✓ after the pass that finishes it", async () => {
  mockDb.progressRows = [{ plan_item_id: "item-snip", day: "2026-09-16", attempts: 2, qualifying: 3 }];
  await openItem("m.1–1 · RH · Opening bar");
  expect(screen.getByText("Plan · m.1–1 · RH · 60 BPM · 90% · 3/4 today · Count out loud.")).toHaveClass("text-amber-800");
  await pressPlay();
  const badge = await screen.findByText("Plan 3/4");
  expect(badge).toHaveAttribute("data-state", "amber");
  expect(screen.getByText(/Completed Passes:/)).toBeInTheDocument();

  // The pass that makes it four: the progress refetch turns the badge into ✓.
  mockDb.progressRows = [{ plan_item_id: "item-snip", day: "2026-09-16", attempts: 3, qualifying: 4 }];
  await act(async () => { completePass(1); });
  const done = await screen.findByText("Plan ✓");
  expect(done).toHaveAttribute("data-state", "done");
});

test("no plan badge while playing a range outside the plan", async () => {
  mockDb.tables.sam_practice_plan_items = [];
  renderSong();
  await screen.findByLabelText(/BPM:/);
  await pressPlay();
  expect(screen.getByText(/Completed Passes:/)).toBeInTheDocument();
  expect(screen.queryByText(/^Plan /)).not.toBeInTheDocument();
});

test("the planned snippet's row in the Snippet panel carries a plan tag", async () => {
  renderSong();
  await screen.findByLabelText(/BPM:/);
  fireEvent.click(screen.getByRole("button", { name: /Snippet/ }));
  const tag = await screen.findByText("Plan · 60 BPM · 0/4");
  expect(tag).toHaveAttribute("data-state", "open");
  // Legible on a plain row and on the selected (filled) row: the row's own
  // figures size, its own card background, and full contrast.
  expect(tag).toHaveClass("text-sm", "text-foreground", "bg-card", "border");
  expect(tag).not.toHaveClass("text-xs");
});

test("a finished snippet's tag reads Plan ✓", async () => {
  mockDb.progressRows = [{ plan_item_id: "item-snip", day: "2026-09-16", attempts: 5, qualifying: 5 }];
  renderSong();
  await screen.findByLabelText(/BPM:/);
  fireEvent.click(screen.getByRole("button", { name: /Snippet/ }));
  expect(await screen.findByText("Plan ✓")).toHaveAttribute("data-state", "done");
});

// --- Next, from the player (2026-09-19) --------------------------------------

test("Next on the plan line opens the next item at its target tempo, writing nothing to the song", async () => {
  // The snippet item is finished today; the whole-song item is not.
  mockDb.progressRows = [{ plan_item_id: "item-snip", day: "2026-09-16", attempts: 5, qualifying: 4 }];
  await openItem("m.1–1 · RH · Opening bar");
  expect(screen.getByLabelText(/BPM:/)).toHaveValue(60);

  // Done, so the way on to the next item is right here at the keyboard.
  const next = await screen.findByRole("button", { name: "Next: Throwaway Whole song" });
  const fetches = mockFetchSongById.mock.calls.length;
  await act(async () => { fireEvent.click(next); });

  // It went through the same open-plan-item path a checklist tap uses...
  expect(mockFetchSongById.mock.calls.length).toBe(fetches + 1);
  // ...and applied THAT item's tempo (55), not the one just finished (60).
  await waitFor(() => expect(screen.getByLabelText(/BPM:/)).toHaveValue(55));
  // The snippet is gone: the next item is the whole song.
  expect(screen.queryByText("m.1–1 · RH · Opening bar")).not.toBeInTheDocument();
  // For this sitting only — the song row is untouched.
  expect(mockDb.inserts.filter((i) => i.table === "sam_songs")).toEqual([]);
  expect(mockDb.updates.filter((u) => u.table === "sam_songs")).toEqual([]);
});

test("no Next on the plan line while the item is unfinished", async () => {
  mockDb.progressRows = [{ plan_item_id: "item-snip", day: "2026-09-16", attempts: 2, qualifying: 1 }];
  await openItem("m.1–1 · RH · Opening bar");
  // The range is named on the line, so two items on one song are told apart.
  expect(screen.getByText(/Plan · m\.1–1 · RH · 60 BPM · 90% · 1\/4 today/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Next:/ })).not.toBeInTheDocument();
});

// --- Crediting a pass when the music ends, not a bar later (2026-09-20) ------
//
// A snippet with rest bars used to bank its pass only at the loop restart, so
// the pass counter and the plan line sat still while Alex was already resting.

// A second snippet, identical but with one appended rest bar.
function withRestSnippet() {
  mockDb.tables.sam_snippets = [{
    id: "snip-1", song_id: SONG_ID, title: "Opening bar", start_measure: 1, end_measure: 1,
    rest_measures: 1, settings: { handMode: "rh" }, archived: false,
  }];
}

test("the engine is told how many rest bars follow the music", async () => {
  withRestSnippet();
  await openItem("m.1–1 · RH · Opening bar");
  await pressPlay();
  expect(mockScrollProps.restMeasureCount).toBe(1);
});

test("no rest bars: the engine is told so, and the pass still lands", async () => {
  await openItem("m.1–1 · RH · Opening bar");
  await pressPlay();
  expect(mockScrollProps.restMeasureCount).toBe(0);
  // The engine fires both signals at the teleport in this case.
  await act(async () => { completePass(1); });
  await waitFor(() => expect(passInserts()).toHaveLength(1));
});

test("the pass is banked when the music ends, before the loop restarts", async () => {
  withRestSnippet();
  await openItem("m.1–1 · RH · Opening bar");
  await pressPlay();
  const progressBefore = mockDb.rpcs.filter((r) => r.fn === "sam_plan_item_progress").length;

  // The scroll reaches the rest bar: the music is over.
  await act(async () => { mockScrollProps.onContentEnd(1); });
  await waitFor(() => expect(passInserts()).toHaveLength(1));
  // ...and the plan progress is refetched now, not a bar later — this is what
  // makes the count and the plan line move while he is still resting.
  await waitFor(() =>
    expect(mockDb.rpcs.filter((r) => r.fn === "sam_plan_item_progress").length).toBe(progressBefore + 1));

  // The restart that follows adds nothing.
  await act(async () => { mockScrollProps.onLoopCount(1); });
  expect(passInserts()).toHaveLength(1);
});

test("the row is identical to the one the restart used to write", async () => {
  withRestSnippet();
  await openItem("m.1–1 · RH · Opening bar");
  await pressPlay();
  await act(async () => { mockScrollProps.onContentEnd(1); });
  await waitFor(() => expect(passInserts()).toHaveLength(1));
  const early = passInserts()[0].row;

  // Rest bars carry whole-note rests, so nothing in them is scoreable and the
  // counters cannot move between the two instants. Crediting at the restart
  // instead must therefore produce the same row.
  await act(async () => { mockScrollProps.onLoopCount(1); });
  expect(passInserts()).toHaveLength(1);
  expect(early).toMatchObject({
    song_id: SONG_ID, snippet_id: "snip-1", bpm: 60,
    plan_id: "plan-1", plan_item_id: "item-snip",
  });
  expect(early.hits).toBe(0);
  expect(early.misses).toBe(0);
  expect(early.notes_played).toBe(0);
});

test("one pass per playthrough across several restarts", async () => {
  withRestSnippet();
  await openItem("m.1–1 · RH · Opening bar");
  await pressPlay();

  for (const n of [1, 2, 3]) {
    await act(async () => { mockScrollProps.onContentEnd(n); });
    await waitFor(() => expect(passInserts()).toHaveLength(n));
    // A repeat of the same signal, and the restart, must both be ignored.
    await act(async () => { mockScrollProps.onContentEnd(n); });
    await act(async () => { mockScrollProps.onLoopCount(n); });
    expect(passInserts()).toHaveLength(n);
  }
  expect(passInserts()).toHaveLength(3);
});

test("stopping during the rest KEEPS the pass: he played the music", async () => {
  withRestSnippet();
  await openItem("m.1–1 · RH · Opening bar");
  await pressPlay();

  // The music finishes and the pass is banked...
  await act(async () => { mockScrollProps.onContentEnd(1); });
  await waitFor(() => expect(passInserts()).toHaveLength(1));

  // ...then he stops partway through the rest bar, before any restart. The
  // pass stays: it was earned. Before this change it was lost.
  fireEvent.click(await screen.findByRole("button", { name: /^Pause$/ }));
  await act(async () => { await Promise.resolve(); });
  expect(passInserts()).toHaveLength(1);
});

test("a fresh run after a mid-play setting change can bank its first pass again", async () => {
  withRestSnippet();
  await openItem("m.1–1 · RH · Opening bar");
  await pressPlay();
  await act(async () => { mockScrollProps.onContentEnd(1); });
  await waitFor(() => expect(passInserts()).toHaveLength(1));
  await act(async () => { mockScrollProps.onLoopCount(1); });

  // A setting change re-runs the scroll effect: it re-emits 0 and the pass
  // numbering restarts. The next playthrough is a real one, not a repeat.
  await act(async () => { mockScrollProps.onLoopCount(0); });
  await act(async () => { mockScrollProps.onContentEnd(1); });
  await waitFor(() => expect(passInserts()).toHaveLength(2));
});
