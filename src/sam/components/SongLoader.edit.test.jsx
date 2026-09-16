// The library's pencil opens the SAME Edit Song dialog the player uses
// (SongEditDialog), loaded with the clicked song's own values — including the
// goal pair, audio detection and the imported-fingerings checkbox — and a save
// writes the player's columns and updates the row in place.

import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";

// --- a tiny table-aware Supabase stand-in ---------------------------------
//
// Every query builder method returns the builder; awaiting it resolves from
// `mockDb`. Updates are recorded, not applied, so the test can prove the row
// changed WITHOUT a refetch.
const mockDb = {
  songs: [],
  fingeringCounts: {},
  updates: [],
  songListFetches: 0,
  songReads: [],
};

jest.mock("../../supabaseClient", () => {
  function respond(q) {
    if (q.update) {
      mockDb.updates.push({ table: q.table, id: q.filters.id, payload: q.update });
      return { data: null, error: null };
    }
    if (q.table === "sam_sessions") return { data: [], error: null };
    if (q.table === "sam_song_fingerings") {
      return { data: null, count: mockDb.fingeringCounts[q.filters.song_id] || 0, error: null };
    }
    if (q.table === "sam_songs") {
      if (q.single) {
        mockDb.songReads.push({ id: q.filters.id, cols: q.cols });
        const row = mockDb.songs.find((s) => s.id === q.filters.id) || null;
        return { data: row, error: row ? null : { message: "not found" } };
      }
      mockDb.songListFetches += 1;
      return { data: mockDb.songs, error: null };
    }
    return { data: [], error: null };
  }
  function query(table) {
    const q = { table, filters: {}, single: false, update: null, cols: null };
    const api = {
      select(cols) { q.cols = cols; return api; },
      eq(k, v) { q.filters[k] = v; return api; },
      not() { return api; },
      order() { return api; },
      in() { return api; },
      update(payload) { q.update = payload; return api; },
      single() { q.single = true; return api; },
      maybeSingle() { q.single = true; return api; },
      then(resolve, reject) {
        return Promise.resolve(respond(q)).then(resolve, reject);
      },
    };
    return api;
  }
  return {
    supabase: {
      from: (table) => query(table),
      storage: { from: () => ({ upload: async () => ({ error: null }) }) },
    },
  };
});

const SongLoader = require("./SongLoader").default;

// Full sam_songs rows — the list query and the edit fetch both read from here.
const row = (over) => ({
  song_type: "original",
  parent_song_id: null,
  difficulty_tier: null,
  created_at: "2026-08-06T16:53:36Z",
  archived: false,
  artist: null,
  default_bpm: 68,
  playback_speed: 100,
  goal_bpm: 68,
  goal_playback_speed: 100,
  default_timing_window_ms: null,
  default_chord_ms: null,
  default_measure_width: null,
  audio_file_path: null,
  show_imported_fingerings: true,
  ...over,
});

const PASTORALE = row({
  id: "song-no-audio",
  title: "Pastorale",
  artist: "Burgmuller",
  default_bpm: 65,
  goal_bpm: 72,
  default_timing_window_ms: 250,
});
const AUTUMN = row({
  id: "song-audio",
  title: "Autumn Leaves",
  artist: "Bill Evans",
  default_bpm: 60,
  playback_speed: 90,
  goal_bpm: 60,
  goal_playback_speed: 80,
  audio_file_path: "u/song-audio.mp3",
});

// The columns the player's dialog writes (SongEditDialog.handleSaveEdit).
const PLAYER_SAVE_COLUMNS = [
  "title", "artist", "default_bpm", "playback_speed",
  "default_timing_window_ms", "default_chord_ms", "default_measure_width",
  "show_imported_fingerings", "goal_bpm", "goal_playback_speed",
].sort();

function renderLibrary() {
  return render(
    <MemoryRouter
      initialEntries={["/sam"]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <SongLoader onSongLoaded={() => {}} onSongSaved={() => {}} onImportError={() => {}} />
    </MemoryRouter>
  );
}

async function openEditFor(title) {
  const [pencil] = await screen.findAllByRole("button", { name: `Edit ${title}` });
  fireEvent.click(pencil);
  const heading = await screen.findByRole("heading", { name: "Edit Song" });
  return heading.closest("div.bg-card");
}

beforeEach(() => {
  mockDb.songs = [PASTORALE, AUTUMN];
  mockDb.fingeringCounts = { "song-audio": 3 };
  mockDb.updates = [];
  mockDb.songListFetches = 0;
  mockDb.songReads = [];
});

test("a song without audio opens the player's dialog with its own values", async () => {
  renderLibrary();
  const dialog = await openEditFor("Pastorale");

  expect(mockDb.songReads).toEqual([
    expect.objectContaining({ id: "song-no-audio" }),
  ]);
  // Never the heavy blob.
  expect(mockDb.songReads[0].cols).not.toMatch(/\bmeasures\b/);

  const d = within(dialog);
  expect(d.getByDisplayValue("Pastorale")).toBeInTheDocument();
  expect(d.getByDisplayValue("Burgmuller")).toBeInTheDocument();
  // The player's no-audio layout: Default BPM + Goal BPM, no speed fields.
  expect(d.getByText("Default BPM")).toBeInTheDocument();
  expect(d.getByLabelText("Goal BPM")).toHaveValue(72);
  expect(d.queryByText("Playback Speed %")).not.toBeInTheDocument();
  expect(d.queryByLabelText("Goal Speed %")).not.toBeInTheDocument();
  expect(d.getByText(/^Goal: 72 BPM\./)).toBeInTheDocument();
  expect(d.getByDisplayValue("250")).toBeInTheDocument();
  // No imported fingerings on this song, so no checkbox — same rule as the player.
  expect(d.queryByText("Show imported fingerings")).not.toBeInTheDocument();
  // The old library dialog's help text is gone.
  expect(d.queryByText(/BPM = no-audio practice tempo/)).not.toBeInTheDocument();
});

test("a song with audio opens with the audio layout and its goal speed", async () => {
  renderLibrary();
  const d = within(await openEditFor("Autumn Leaves"));

  expect(d.getByText("Playback Speed %")).toBeInTheDocument();
  expect(d.getByDisplayValue("90")).toBeInTheDocument();
  expect(d.getByLabelText("Goal Speed %")).toHaveValue(80);
  expect(d.queryByLabelText("Goal BPM")).not.toBeInTheDocument();
  expect(d.getByText(/^Goal: 48 BPM\./)).toBeInTheDocument();
  expect(d.getByText("Show imported fingerings")).toBeInTheDocument();
});

test("saving writes the player's columns and updates the row in place", async () => {
  renderLibrary();
  const d = within(await openEditFor("Pastorale"));

  fireEvent.change(d.getByDisplayValue("Pastorale"), { target: { value: "Pastorale No. 3" } });
  fireEvent.change(d.getByLabelText("Goal BPM"), { target: { value: "70" } });
  fireEvent.click(d.getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "Edit Song" })).not.toBeInTheDocument()
  );

  expect(mockDb.updates).toHaveLength(1);
  const { table, id, payload } = mockDb.updates[0];
  expect(table).toBe("sam_songs");
  expect(id).toBe("song-no-audio");
  expect(Object.keys(payload).sort()).toEqual(PLAYER_SAVE_COLUMNS);
  expect(payload).toMatchObject({
    title: "Pastorale No. 3",
    default_bpm: 65,
    goal_bpm: 70,
    goal_playback_speed: 100,
  });

  // The row shows the new title without a reload or a list refetch.
  expect((await screen.findAllByText("Pastorale No. 3")).length).toBeGreaterThan(0);
  expect(mockDb.songListFetches).toBe(1);
});

test("Cancel closes the dialog without writing", async () => {
  renderLibrary();
  const d = within(await openEditFor("Autumn Leaves"));
  fireEvent.click(d.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("heading", { name: "Edit Song" })).not.toBeInTheDocument();
  expect(mockDb.updates).toEqual([]);
});
