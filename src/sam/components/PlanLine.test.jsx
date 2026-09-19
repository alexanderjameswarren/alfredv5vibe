// The player's plan line and song note (practice plans spec §7.4).

import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import PlanLine from "./PlanLine";
import { itemState } from "../lib/activePlan";

const ITEM = {
  id: "i", target_bpm: 60, target_playback_speed: 100, target_effective_bpm: 60,
  accuracy_target: 90, target_passes: 4, instruction: "Count out loud", is_free_play: false,
};
const FREE = {
  id: "f", target_bpm: 67, target_playback_speed: 90, target_effective_bpm: 60,
  accuracy_target: null, target_passes: 1, instruction: null, is_free_play: true,
};
const stateOf = (item, attempts, qualifying) =>
  itemState(item, new Map([[item.id, { attempts, qualifying }]]));

test("nothing when neither an item nor a song note applies", () => {
  const { container } = render(<PlanLine item={null} state={null} songNote={null} heardTempo={60} />);
  expect(container).toBeEmptyDOMElement();
});

test("an item: the plan line, no Set tempo while the heard tempo matches", () => {
  render(<PlanLine item={ITEM} state={stateOf(ITEM, 3, 2)} heardTempo={60} onSetTempo={() => {}} />);
  const line = screen.getByText("Plan · 60 BPM · 90% · 2/4 today · Count out loud");
  // 3 attempts, 2 qualifying, target 4: in progress today, so amber.
  expect(line).toHaveClass("text-amber-800");
  expect(screen.queryByRole("button", { name: "Set tempo" })).not.toBeInTheDocument();
  expect(screen.queryByRole("img", { name: "Done" })).not.toBeInTheDocument();
});

test("a free play item", () => {
  render(<PlanLine item={FREE} state={stateOf(FREE, 0, 0)} heardTempo={60} />);
  expect(screen.getByText("Free play · 60 BPM · 0/1 today")).toBeInTheDocument();
});

test("done: a check mark and 'Done 4/4 today', at full contrast and body size", () => {
  render(<PlanLine item={ITEM} state={stateOf(ITEM, 6, 6)} heardTempo={60} />);
  expect(screen.getByRole("img", { name: "Done" })).toBeInTheDocument();
  // Done keeps its check mark and full contrast — it is read from the keyboard.
  const doneLine = screen.getByText("Plan · 60 BPM · 90% · Done 4/4 today · Count out loud");
  expect(doneLine).toHaveClass("text-foreground");
  expect(doneLine).not.toHaveClass("text-muted-foreground");
  // Body size comes from the block, which nothing inside reduces.
  expect(screen.getByLabelText("Practice plan")).toHaveClass("text-sm");
});

test("amber: attempts today, not done; no attempts is plain", () => {
  const { rerender } = render(<PlanLine item={ITEM} state={stateOf(ITEM, 2, 1)} heardTempo={60} />);
  expect(screen.getByText(/1\/4 today/)).toHaveClass("text-amber-800");
  rerender(<PlanLine item={ITEM} state={stateOf(ITEM, 0, 0)} heardTempo={60} />);
  expect(screen.getByText(/0\/4 today/)).toHaveClass("text-foreground");
});

test("Set tempo appears only when the heard tempo differs, and calls back", () => {
  const onSetTempo = jest.fn();
  const { rerender } = render(<PlanLine item={ITEM} state={stateOf(ITEM, 0, 0)} heardTempo={55} onSetTempo={onSetTempo} />);
  fireEvent.click(screen.getByRole("button", { name: "Set tempo" }));
  expect(onSetTempo).toHaveBeenCalledTimes(1);
  rerender(<PlanLine item={ITEM} state={stateOf(ITEM, 0, 0)} heardTempo={65} onSetTempo={onSetTempo} />);
  expect(screen.getByRole("button", { name: "Set tempo" })).toBeInTheDocument();
  rerender(<PlanLine item={ITEM} state={stateOf(ITEM, 0, 0)} heardTempo={60} onSetTempo={onSetTempo} />);
  expect(screen.queryByRole("button", { name: "Set tempo" })).not.toBeInTheDocument();
});

test("song note under the plan line, truncated until tapped", () => {
  const note = "Master m.16–17 hands separately, then put them together slowly before moving on to m.18.";
  render(<PlanLine item={ITEM} state={stateOf(ITEM, 0, 0)} songNote={note} heardTempo={60} />);
  const btn = screen.getByRole("button", { name: `Song goal: ${note}` });
  expect(btn).toHaveClass("truncate", "text-foreground");
  expect(btn).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(btn);
  expect(btn).not.toHaveClass("truncate");
  expect(btn).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText(/Plan · 60 BPM/)).toBeInTheDocument();
});

test("song note alone when the loaded range has no item", () => {
  render(<PlanLine item={null} state={null} songNote="Keep it steady." heardTempo={60} />);
  expect(screen.getByRole("button", { name: "Song goal: Keep it steady." })).toBeInTheDocument();
  expect(screen.queryByText(/^Plan ·/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Set tempo" })).not.toBeInTheDocument();
});

// --- Next, at the keyboard (2026-09-19) --------------------------------------
//
// The important one: finishing an item at the piano should not mean walking
// back to the home page to start the next.

describe("Next on the plan line", () => {
  // The visible box inside the 44px hit area.
  // eslint-disable-next-line testing-library/no-node-access
  const nextBox = (btn) => btn.querySelector("[data-next-box]");

  const NEXT = {
    id: "n", song_title: "Autumn Leaves", snippet_id: "s1",
    snippet: { start_measure: 1, end_measure: 16, hand_mode: "both" },
  };

  test("a done item offers the next one, by song and range", () => {
    render(<PlanLine item={ITEM} state={stateOf(ITEM, 6, 6)} heardTempo={60} nextItem={NEXT} onOpenNext={() => {}} />);
    expect(screen.getByRole("button", { name: "Next: Autumn Leaves m.1–16" })).toBeInTheDocument();
  });

  test("quieter than the plan line: the outline of Save and Tuning, a size down", () => {
    render(
      <PlanLine item={ITEM} state={stateOf(ITEM, 6, 6)} heardTempo={55} nextItem={NEXT}
        onSetTempo={() => {}} onOpenNext={() => {}} />
    );
    const btn = screen.getByRole("button", { name: "Next: Autumn Leaves m.1–16" });
    const box = nextBox(btn);
    // Same outline as its neighbour Save: border, radius, background, muted
    // text, body size. Nothing filled, nothing shouting.
    const save = screen.getByRole("button", { name: "Set tempo" });
    for (const c of ["border", "border-border", "rounded", "text-sm", "text-muted-foreground"]) {
      expect(save).toHaveClass(c);
      expect(box).toHaveClass(c);
    }
    expect(box).not.toHaveClass("bg-primary", "text-primary-foreground", "font-medium");
    // ...but a size down from them: shorter box, tighter sides.
    expect(box).toHaveClass("min-h-[33px]", "px-2.5");
    expect(box).not.toHaveClass("min-h-[44px]", "px-3");
    // The SHRINKING IS VISUAL ONLY — the thing a finger lands on is still full
    // size, padding the smaller box inside itself.
    expect(btn).toHaveClass("min-h-[44px]", "py-1.5");
    expect(btn).not.toHaveClass("border", "bg-primary");
  });

  test("tapping it opens that item through the caller's own handler", () => {
    const onOpenNext = jest.fn();
    render(<PlanLine item={ITEM} state={stateOf(ITEM, 6, 6)} heardTempo={60} nextItem={NEXT} onOpenNext={onOpenNext} />);
    fireEvent.click(screen.getByRole("button", { name: "Next: Autumn Leaves m.1–16" }));
    expect(onOpenNext).toHaveBeenCalledWith(NEXT);
  });

  test("nothing until the item is done, and nothing when the plan is complete", () => {
    const { rerender } = render(
      <PlanLine item={ITEM} state={stateOf(ITEM, 3, 2)} heardTempo={60} nextItem={NEXT} onOpenNext={() => {}} />
    );
    expect(screen.queryByRole("button", { name: /^Next:/ })).not.toBeInTheDocument();
    // Done, but nothing left anywhere in the plan.
    rerender(<PlanLine item={ITEM} state={stateOf(ITEM, 6, 6)} heardTempo={60} nextItem={null} onOpenNext={() => {}} />);
    expect(screen.queryByRole("button", { name: /^Next:/ })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Done" })).toBeInTheDocument();
  });

  test("Free Play is offered like any other item", () => {
    const free = { id: "f2", song_title: "Someone Like You", snippet_id: null, is_free_play: true };
    render(<PlanLine item={ITEM} state={stateOf(ITEM, 6, 6)} heardTempo={60} nextItem={free} onOpenNext={() => {}} />);
    expect(screen.getByRole("button", { name: "Next: Someone Like You Whole song" })).toBeInTheDocument();
  });

  test("the song title gives way first; the range and the arrow always survive", () => {
    const long = { ...NEXT, song_title: "Autumn Leaves (Les Feuilles Mortes), arr. for solo piano" };
    render(<PlanLine item={ITEM} state={stateOf(ITEM, 6, 6)} heardTempo={60} nextItem={long} onOpenNext={() => {}} />);
    const btn = screen.getByRole("button", { name: `Next: ${long.song_title} m.1–16` });
    expect(within(btn).getByText(long.song_title)).toHaveClass("truncate", "min-w-0");
    expect(within(btn).getByText("m.1–16")).toHaveClass("shrink-0");
    // eslint-disable-next-line testing-library/no-node-access
    expect(btn.querySelector("svg[aria-hidden='true']")).toBeInTheDocument();
  });

  test("Next sits beside Set tempo, not in place of it", () => {
    render(<PlanLine item={ITEM} state={stateOf(ITEM, 6, 6)} heardTempo={55} nextItem={NEXT} onSetTempo={() => {}} onOpenNext={() => {}} />);
    expect(screen.getByRole("button", { name: "Set tempo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next: Autumn Leaves m.1–16" })).toBeInTheDocument();
  });
});
