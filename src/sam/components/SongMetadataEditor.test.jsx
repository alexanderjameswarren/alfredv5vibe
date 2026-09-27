// Goal tempo in the Edit Song modal: prefill, live heard tempo, required-field
// validation, and exactly what Save writes for songs with and without audio.

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockUpdates = [];
let mockGoalRow = null;

jest.mock("../../supabaseClient", () => ({
  supabase: {
    from: () => ({
      update: (payload) => ({
        eq: async () => {
          mockUpdates.push(payload);
          return { error: null };
        },
      }),
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: mockGoalRow, error: null }),
        }),
      }),
    }),
  },
}));

// Imported after the mock.
const SongMetadataEditor = require("./SongMetadataEditor").default;

const hook = (value) => ({ value, set: jest.fn() });

function setup(songOver = {}) {
  const song = {
    title: "Pastorale",
    artist: "Burgmuller",
    defaultBpm: 65,
    playbackSpeed: 100,
    goalBpm: 72,
    goalPlaybackSpeed: 100,
    audioFilePath: null,
    measures: [],
    ...songOver,
  };
  const hooks = {
    bpm: hook(song.defaultBpm),
    timingWindowMs: hook(300),
    chordMs: hook(80),
    measureWidth: hook(500),
    playbackSpeed: hook(song.playbackSpeed),
  };
  const onSongUpdate = jest.fn();
  render(
    <SongMetadataEditor song={song} songDbId="song-1" onSongUpdate={onSongUpdate} {...hooks} />
  );
  fireEvent.click(screen.getByTitle("Edit song"));
  return { onSongUpdate, hooks };
}

const saveButton = () => screen.getByRole("button", { name: "Save" });

beforeEach(() => {
  mockUpdates.length = 0;
  mockGoalRow = null;
});

describe("without audio", () => {
  test("prefills Goal BPM and shows the heard tempo", () => {
    setup();
    expect(screen.getByLabelText("Goal BPM")).toHaveValue(72);
    expect(screen.getByText(/^Goal: 72 BPM\./)).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  test("a blank or invalid goal shows an error and disables Save", () => {
    setup();
    const input = screen.getByLabelText("Goal BPM");
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByText(/required/i)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(screen.getByText(/^Goal: — BPM\./)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "0" } });
    expect(saveButton()).toBeDisabled();

    fireEvent.change(input, { target: { value: "80" } });
    expect(screen.queryByText(/whole number/i)).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
    expect(screen.getByText(/^Goal: 80 BPM\./)).toBeInTheDocument();
  });

  test("Save writes goal_bpm with speed 100, leaves the tempo alone, and updates the song", async () => {
    const { onSongUpdate, hooks } = setup();
    fireEvent.change(screen.getByLabelText("Goal BPM"), { target: { value: "80" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSongUpdate).toHaveBeenCalled());
    expect(mockUpdates).toHaveLength(1);
    expect(mockUpdates[0]).toMatchObject({
      default_bpm: 65, goal_bpm: 80, goal_playback_speed: 100,
    });
    expect(onSongUpdate.mock.calls[0][0]).toMatchObject({
      defaultBpm: 65, goalBpm: 80, goalPlaybackSpeed: 100,
    });
    // The goal is a target, not a setting: the live tempo gets the default.
    expect(hooks.bpm.set).toHaveBeenCalledWith(65);
  });

  test("a song whose goal is not in memory reads it from the database", async () => {
    mockGoalRow = { goal_bpm: 70, goal_playback_speed: 100 };
    setup({ goalBpm: null, goalPlaybackSpeed: null });
    await waitFor(() => expect(screen.getByLabelText("Goal BPM")).toHaveValue(70));
  });
});

describe("with audio", () => {
  const audio = { audioFilePath: "song-1/track.mp3", defaultBpm: 60, goalBpm: 60, goalPlaybackSpeed: 80 };

  test("shows Goal Speed % instead, with heard tempo from the default BPM", () => {
    setup(audio);
    expect(screen.queryByLabelText("Goal BPM")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Goal Speed %")).toHaveValue(80);
    expect(screen.getByText(/^Goal: 48 BPM\./)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Goal Speed %"), { target: { value: "90" } });
    expect(screen.getByText(/^Goal: 54 BPM\./)).toBeInTheDocument();
  });

  test("Save writes the speed, and goal_bpm = the Default BPM being saved", async () => {
    const { onSongUpdate } = setup(audio);
    fireEvent.change(screen.getByLabelText("Goal Speed %"), { target: { value: "90" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSongUpdate).toHaveBeenCalled());
    expect(mockUpdates[0]).toMatchObject({
      default_bpm: 60, goal_bpm: 60, goal_playback_speed: 90,
    });
    expect(onSongUpdate.mock.calls[0][0]).toMatchObject({ goalBpm: 60, goalPlaybackSpeed: 90 });
  });

  test("a blank goal speed disables Save", () => {
    setup(audio);
    fireEvent.change(screen.getByLabelText("Goal Speed %"), { target: { value: "" } });
    expect(saveButton()).toBeDisabled();
  });
});

// --- The warm-up ladder, under the goal tempo (warm-up spec §7.4) ------------
//
// It saves on its own rather than with this dialog's Save, because the column has
// three meaningful states and one Save button cannot tell "clear to inherit" from
// "no warm-up here".

describe("the warm-up ladder editor", () => {
  const RESOLVED_DEFAULT = {
    ladder: [
      { target_percent: 85, accuracy_target: null, target_passes: 2, consecutive: true },
      { target_percent: 100, accuracy_target: null, target_passes: 2, consecutive: true },
    ],
    source: "default",
  };

  // The section is folded by default in this dialog (it is one part of a tall
  // one), so a test that wants the table has to open it, exactly as he would.
  const openLadder = () => fireEvent.click(screen.getByRole("button", { expanded: false }));

  function setupLadder(songOver = {}, resolvedWarmup = RESOLVED_DEFAULT) {
    const song = {
      title: "Pastorale", artist: null, defaultBpm: 65, playbackSpeed: 100,
      goalBpm: 72, goalPlaybackSpeed: 100, audioFilePath: null, measures: [],
      ...songOver,
    };
    const onSongUpdate = jest.fn();
    render(
      <SongMetadataEditor
        song={song} songDbId="song-1" onSongUpdate={onSongUpdate}
        resolvedWarmup={resolvedWarmup}
        bpm={hook(65)} timingWindowMs={hook(300)} chordMs={hook(80)}
        measureWidth={hook(500)} playbackSpeed={hook(100)}
      />
    );
    fireEvent.click(screen.getByTitle("Edit song"));
    return { onSongUpdate };
  }

  test("it is folded away by default, with its state in the header", () => {
    setupLadder();
    expect(screen.getByLabelText("Warm-up ladder editor")).toBeInTheDocument();
    expect(screen.getByTestId("ladder-collapsed-summary")).toHaveTextContent("inherited");
    expect(screen.queryByTestId("ladder-stored")).not.toBeInTheDocument();
  });

  test("opened, it says what the song will actually run", () => {
    setupLadder();
    openLadder();
    expect(screen.getByRole("radio", { name: "Inherit" })).toBeChecked();
    expect(screen.getByTestId("ladder-consequence"))
      .toHaveTextContent("Pressing Warm up will run 85% → 100% · default.");
  });

  test("it has no Save of its own — this dialog's Save is the only one", () => {
    setupLadder();
    openLadder();
    expect(screen.queryByText(/Saves on its own/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save ladder" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Clear \(inherit\)/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(1);
  });

  test("a rung edit is written by the dialog's Save, with everything else", async () => {
    const { onSongUpdate } = setupLadder({
      warmupLadder: [
        { target_percent: 70, accuracy_target: null, target_passes: 2, consecutive: true },
        { target_percent: 100, accuracy_target: null, target_passes: 2, consecutive: true },
      ],
    });
    openLadder();
    fireEvent.change(screen.getByLabelText("Rung 1 percent of target tempo"), { target: { value: "60" } });
    // Nothing yet: the edit is a draft until Save.
    expect(mockUpdates).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockUpdates).toHaveLength(1));
    expect(mockUpdates[0].warmup_ladder[0].target_percent).toBe(60);
    // One write, carrying the song's other columns as well.
    expect(mockUpdates[0]).toHaveProperty("title");
    await waitFor(() => expect(onSongUpdate).toHaveBeenCalled());
    expect(onSongUpdate.mock.calls[0][0].warmupLadder[0].target_percent).toBe(60);
  });

  test("Cancel discards a rung edit and a state change", async () => {
    setupLadder({
      warmupLadder: [
        { target_percent: 70, accuracy_target: null, target_passes: 2, consecutive: true },
        { target_percent: 100, accuracy_target: null, target_passes: 2, consecutive: true },
      ],
    });
    openLadder();
    fireEvent.change(screen.getByLabelText("Rung 1 percent of target tempo"), { target: { value: "55" } });
    fireEvent.click(screen.getByRole("radio", { name: "No warm-up here" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockUpdates).toHaveLength(0);
  });

  test("an invalid ladder stops the whole save and opens the section to say why", async () => {
    setupLadder({
      warmupLadder: [
        { target_percent: 70, accuracy_target: null, target_passes: 2, consecutive: true },
        { target_percent: 100, accuracy_target: null, target_passes: 2, consecutive: true },
      ],
    });
    openLadder();
    fireEvent.change(screen.getByLabelText("Rung 1 percent of target tempo"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mockUpdates).toHaveLength(0);
    expect(screen.getByRole("alert")).toHaveTextContent("higher than the rung above (100%)");
  });

  // Inherit and No warm-up here are still two different writes — the distinction
  // §7.4 insists on — now carried by the one Save rather than by two buttons.
  const STORED = [
    { target_percent: 70, accuracy_target: null, target_passes: 2, consecutive: true },
    { target_percent: 100, accuracy_target: null, target_passes: 2, consecutive: true },
  ];

  test("choosing Inherit and saving writes null", async () => {
    setupLadder({ warmupLadder: STORED });
    openLadder();
    fireEvent.click(screen.getByRole("radio", { name: "Inherit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockUpdates).toHaveLength(1));
    expect(mockUpdates[0].warmup_ladder).toBeNull();
  });

  test("choosing No warm-up here and saving writes an empty array", async () => {
    setupLadder({ warmupLadder: STORED });
    openLadder();
    fireEvent.click(screen.getByRole("radio", { name: "No warm-up here" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockUpdates).toHaveLength(1));
    expect(mockUpdates[0].warmup_ladder).toEqual([]);
  });

  test("saving without touching the ladder writes what was already stored", async () => {
    setupLadder();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockUpdates).toHaveLength(1));
    // Inherited before, inherited after: the column is carried, not dropped.
    expect(mockUpdates[0].warmup_ladder).toBeNull();
  });
});
