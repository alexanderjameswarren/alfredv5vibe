// The "Goal 75" label beside the tempo box (practice plans spec §7.4).

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockWrites = [];
jest.mock("../../supabaseClient", () => ({
  supabase: {
    from: (table) => ({
      update: (row) => {
        mockWrites.push({ table, row });
        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  },
}));

const NumericSettings = require("./NumericSettings").default;
const { mapSongRow, SONG_EDIT_COLUMNS } = require("../lib/songLoad");

// A stand-in for useNumericInput: a fixed value, with set() recorded.
function numeric(value) {
  return {
    value,
    input: String(value),
    set: jest.fn(),
    setInput: jest.fn(),
    commit: jest.fn(() => value),
    preview: jest.fn(() => value),
  };
}

const NO_AUDIO = {
  title: "Pastorale", defaultBpm: 70, playbackSpeed: 100, audioFilePath: null,
  goalBpm: 75, goalPlaybackSpeed: 100, goalEffectiveBpm: 75, goalSetAt: "2026-09-16T20:00:00Z",
};
const AUDIO = {
  title: "Someone Like You", defaultBpm: 67, playbackSpeed: 100, audioFilePath: "u/sly.mp3",
  goalBpm: 67, goalPlaybackSpeed: 90, goalEffectiveBpm: 60, goalSetAt: "2026-09-16T20:00:00Z",
};

function mountSettings(song, { bpm = 70, speed = 100 } = {}) {
  const hooks = {
    bpm: numeric(bpm),
    playbackSpeed: numeric(speed),
    timingWindowMs: numeric(300),
    chordMs: numeric(80),
    measureWidth: numeric(500),
  };
  render(
    <NumericSettings
      song={song} snippet={null} songDbId="song-1" playbackState="stopped"
      {...hooks}
      songRepeat={false} onSongRepeatChange={() => {}}
      songRestMeasures={0} onSongRestMeasuresChange={() => {}}
      metronome="off" setMetronome={() => {}}
      scorePlayback="off" setScorePlayback={() => {}}
    />
  );
  return hooks;
}

beforeEach(() => { mockWrites.length = 0; });

const goal = () => screen.queryByRole("button", { name: "Set tempo to goal (this session only)" });

test("hidden while the goal is a placeholder (goal_set_at null)", () => {
  mountSettings({ ...NO_AUDIO, goalSetAt: null });
  expect(goal()).not.toBeInTheDocument();
});

test("a real button styled like Save: label, tooltip, border and height", () => {
  mountSettings(NO_AUDIO, { bpm: 70 });
  expect(goal()).toHaveTextContent(/^Goal 75$/);
  expect(goal()).toHaveAttribute("title", "Set tempo to goal (this session only)");
  expect(goal()).toHaveClass("border", "rounded", "text-sm", "px-3", "py-1.5", "min-h-[44px]");
});

test("no audio: below the goal it is amber (text and border) and enabled", () => {
  mountSettings(NO_AUDIO, { bpm: 70 });
  expect(goal()).toHaveClass("text-amber-700", "border-amber-600");
  expect(goal()).toBeEnabled();
});

test("no audio: at the goal it is muted and disabled; above it muted and enabled", () => {
  mountSettings(NO_AUDIO, { bpm: 75 });
  expect(goal()).toBeDisabled();
  expect(goal()).toHaveClass("text-muted-foreground", "border-border");
  expect(goal()).not.toHaveClass("text-amber-700");
});

test("no audio: above the goal it is muted and enabled", () => {
  mountSettings(NO_AUDIO, { bpm: 80 });
  expect(goal()).toBeEnabled();
  expect(goal()).toHaveClass("text-muted-foreground");
  expect(goal()).not.toHaveClass("border-amber-600");
});

test("no audio: tapping sets the BPM to goal_bpm, leaves speed, writes nothing", () => {
  const hooks = mountSettings(NO_AUDIO, { bpm: 70 });
  fireEvent.click(goal());
  expect(hooks.bpm.set).toHaveBeenCalledWith(75);
  expect(hooks.playbackSpeed.set).not.toHaveBeenCalled();
  expect(mockWrites).toEqual([]);
});

test("audio: the heard tempo uses the speed; tapping sets the speed and leaves the BPM", () => {
  // 67 at 85% = 57 heard, below the 60 goal.
  const hooks = mountSettings(AUDIO, { bpm: 67, speed: 85 });
  expect(goal()).toHaveTextContent("Goal 60");
  expect(goal()).toHaveClass("text-amber-700");
  fireEvent.click(goal());
  expect(hooks.playbackSpeed.set).toHaveBeenCalledWith(90);
  expect(hooks.bpm.set).not.toHaveBeenCalled();
  expect(mockWrites).toEqual([]);
});

test("audio at 100%: above the goal, muted and enabled; at the goal speed, disabled", () => {
  mountSettings(AUDIO, { bpm: 67, speed: 100 });
  expect(goal()).toHaveClass("text-muted-foreground");
  expect(goal()).toBeEnabled();
});

test("audio at the goal speed: 67 at 90% is 60, so disabled", () => {
  const hooks = mountSettings(AUDIO, { bpm: 67, speed: 90 });
  expect(goal()).toBeDisabled();
  fireEvent.click(goal());
  expect(hooks.playbackSpeed.set).not.toHaveBeenCalled();
});

test("the song mapping and the edit dialog's columns carry the goal fields", () => {
  const song = mapSongRow({ title: "x", goal_bpm: 67, goal_playback_speed: 90, goal_effective_bpm: 60, goal_set_at: "t" }, []);
  expect(song).toMatchObject({ goalEffectiveBpm: 60, goalSetAt: "t" });
  expect(mapSongRow({ title: "y" }, [])).toMatchObject({ goalEffectiveBpm: null, goalSetAt: null });
  expect(SONG_EDIT_COLUMNS).toMatch(/\bgoal_set_at\b/);
  expect(SONG_EDIT_COLUMNS).toMatch(/\bgoal_effective_bpm\b/);
});
