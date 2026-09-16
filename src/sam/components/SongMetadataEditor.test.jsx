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
