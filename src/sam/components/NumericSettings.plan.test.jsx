// The plan tempo warning and Set tempo under the rail's tempo box (sam_tempo spec).

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import useNumericInput from "../lib/useNumericInput";

jest.mock("../../supabaseClient", () => ({ supabase: {} }));

const { TempoControls } = require("./NumericSettings");

const SONG = { title: "Great Balls of Fire", defaultBpm: 60, playbackSpeed: 100, audioFilePath: null };
const AUDIO = { ...SONG, audioFilePath: "u/gbof.mp3" };
const ITEM = { id: "i", target_bpm: 60, target_playback_speed: 100, target_effective_bpm: 60 };

function Harness({ song = SONG, bpm = 60, speed = 100, item = ITEM, warmup, onSet = () => {} }) {
  const hooks = {
    bpm: useNumericInput(bpm),
    playbackSpeed: useNumericInput(speed),
    timingWindowMs: useNumericInput(300),
    chordMs: useNumericInput(80),
    measureWidth: useNumericInput(150),
  };
  return (
    <TempoControls song={song} songDbId="s" {...hooks}
      planItem={item} planWarmup={warmup} onSetPlanTempo={onSet} />
  );
}

const warning = () => screen.queryByTestId("plan-tempo");
const setTempo = () => screen.queryByRole("button", { name: "Set tempo" });

test("on plan: no warning, no Set tempo", () => {
  render(<Harness bpm={60} />);
  expect(warning()).not.toBeInTheDocument();
  expect(setTempo()).not.toBeInTheDocument();
});

test("slower: red, below plan goal, Set tempo above Save", () => {
  render(<Harness bpm={55} />);
  expect(warning()).toHaveTextContent("Below plan goal: 60");
  expect(warning()).toHaveClass("text-red-700");
  expect(screen.getByRole("spinbutton")).toHaveClass("!border-red-700");
  const names = screen.getAllByRole("button").map((b) => b.textContent);
  expect(names.slice(-2)).toEqual(["Set tempo", "Save"]);
});

test("faster: blue, still counts", () => {
  render(<Harness bpm={66} />);
  expect(warning()).toHaveTextContent("Faster than plan (60)");
  expect(warning()).toHaveClass("text-blue-700");
  expect(setTempo()).toBeInTheDocument();
});

test("updates live while typing, before blur", () => {
  render(<Harness bpm={60} />);
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "50" } });
  expect(warning()).toHaveAttribute("data-state", "slower");
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "60" } });
  expect(warning()).not.toBeInTheDocument();
});

test("audio song: the heard tempo uses the speed", () => {
  render(<Harness song={AUDIO} bpm={60} speed={90} />);
  expect(warning()).toHaveTextContent("Below plan goal: 60");
});

test("no plan item, or a warm-up state: looks as today", () => {
  const { unmount } = render(<Harness bpm={40} item={null} />);
  expect(warning()).not.toBeInTheDocument();
  expect(setTempo()).not.toBeInTheDocument();
  unmount();
  render(<Harness bpm={42} warmup={{ pausedMidLadder: true }} />);
  expect(warning()).not.toBeInTheDocument();
  expect(setTempo()).not.toBeInTheDocument();
});

test("Set tempo calls back", () => {
  const onSet = jest.fn();
  render(<Harness bpm={50} onSet={onSet} />);
  fireEvent.click(setTempo());
  expect(onSet).toHaveBeenCalledTimes(1);
});
