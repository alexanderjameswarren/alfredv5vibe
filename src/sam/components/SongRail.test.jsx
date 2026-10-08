import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

jest.mock("../../supabaseClient", () => ({ supabase: {} }));

const SongRail = require("./SongRail").default;

function numeric(value) {
  return {
    value, input: String(value), set: jest.fn(), setInput: jest.fn(),
    commit: jest.fn(() => value), preview: jest.fn(() => value),
  };
}

const SONG = { title: "Pastorale", defaultBpm: 70, playbackSpeed: 100, audioFilePath: null };

function mount(props = {}) {
  const fns = {
    onPlay: jest.fn(), onPractice: jest.fn(), onResume: jest.fn(),
    onRestart: jest.fn(), onStop: jest.fn(), onBack: jest.fn(),
  };
  render(
    <SongRail
      playbackState="stopped" songDbId="s1" snippet={null} song={SONG}
      bpm={numeric(70)} timingWindowMs={numeric(300)} chordMs={numeric(80)}
      measureWidth={numeric(150)} playbackSpeed={numeric(100)}
      {...fns} {...props}
    />
  );
  return fns;
}

const button = (name) => screen.queryByRole("button", { name });

test("stopped: Play, Practice, BPM, Back", () => {
  const fns = mount();
  fireEvent.click(button(/Play/));
  fireEvent.click(button(/Practice/));
  fireEvent.click(button("Back to song library"));
  expect(fns.onPlay).toHaveBeenCalled();
  expect(fns.onPractice).toHaveBeenCalled();
  expect(fns.onBack).toHaveBeenCalled();
  expect(screen.getByText(/^BPM:/)).toBeInTheDocument();
  expect(button(/Resume/)).not.toBeInTheDocument();
});

test("paused: Resume, Restart, Stop in order; no Play or Practice", () => {
  mount({ playbackState: "paused" });
  const names = screen.getAllByRole("button").map((b) => b.textContent.trim());
  expect(names.slice(0, 3)).toEqual(["Resume", "Restart", "Stop"]);
  expect(button(/Practice/)).not.toBeInTheDocument();
});

test("warm up sits under Practice", () => {
  mount({ onWarmUp: jest.fn(), warmUpVisible: true, warmUpPrimary: true });
  const names = screen.getAllByRole("button").map((b) => b.textContent.trim());
  expect(names.indexOf("Warm up")).toBe(names.indexOf("Practice") + 1);
});

test("audio song: the tempo slot is Speed %", () => {
  mount({ song: { ...SONG, audioFilePath: "u/x.mp3" } });
  expect(screen.getByText(/^Speed %:/)).toBeInTheDocument();
  expect(screen.queryByText(/^BPM:/)).not.toBeInTheDocument();
});

test("Snippets and More are disabled until wired", () => {
  mount();
  expect(button(/Snippets/)).toBeDisabled();
  expect(button(/More/)).toBeDisabled();
});
