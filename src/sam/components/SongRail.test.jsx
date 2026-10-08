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

test("More reads Close, pressed, while the drawer is open", () => {
  const onToggleMore = jest.fn();
  mount({ onToggleMore, moreOpen: false });
  fireEvent.click(button("More"));
  expect(onToggleMore).toHaveBeenCalled();
});

test("open drawer: the button is Close and pressed", () => {
  mount({ onToggleMore: jest.fn(), moreOpen: true });
  expect(button("Close")).toHaveAttribute("aria-pressed", "true");
  expect(button("More")).not.toBeInTheDocument();
});

test("Snippets is a pressed-state toggle", () => {
  const onToggleSnippets = jest.fn();
  mount({ onToggleSnippets, snippetsOpen: true });
  expect(button("Snippets")).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(button("Snippets"));
  expect(onToggleSnippets).toHaveBeenCalled();
});
