// The home page checklist (practice plans spec §7.3).

import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import PlanChecklist from "./PlanChecklist";

const item = (over) => ({
  id: over.id,
  song_id: "s1",
  song_title: "Pastorale",
  snippet_id: null,
  snippet: null,
  snippet_unavailable: false,
  position: 1,
  is_free_play: false,
  target_bpm: 60,
  target_playback_speed: 100,
  target_effective_bpm: 60,
  target_passes: 4,
  accuracy_target: 90,
  instruction: null,
  ...over,
});

const PLAN = {
  id: "p1",
  day_note: "Work on speed first, then keep the chorus steady without rushing it at the end of the day.",
  items: [
    item({ id: "a", position: 1, snippet_id: "sn1", snippet: { id: "sn1", title: "Bars 5-12", start_measure: 5, end_measure: 12, hand_mode: "rh" }, instruction: "Count out loud." }),
    item({ id: "free", position: 2, is_free_play: true, song_title: "Someone Like You", accuracy_target: null,
      target_bpm: 67, target_playback_speed: 90, target_effective_bpm: 60, target_passes: 2 }),
    item({ id: "b", position: 3, target_passes: 2, accuracy_target: 80, target_effective_bpm: 50 }),
    item({ id: "c", position: 4, snippet_id: "gone", snippet: { id: "gone", title: "Measures 1-2 Both No Rest", start_measure: 1, end_measure: 2, hand_mode: "both", archived: true },
      snippet_unavailable: true, target_passes: 1 }),
  ],
};

const PROGRESS = new Map([
  ["a", { attempts: 7, qualifying: 6 }], // done, shown capped at 4
  ["b", { attempts: 3, qualifying: 1 }], // amber
]);

function storage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    data,
  };
}

let store;
beforeEach(() => {
  store = storage();
  Object.defineProperty(window, "localStorage", { value: store, configurable: true });
});

// A checklist row is a button whose accessible name includes its text.
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rowFor = (text) => screen.getByRole("button", { name: new RegExp(esc(text)) });

test("renders nothing without an active plan", () => {
  const { container } = render(<PlanChecklist plan={null} progress={new Map()} />);
  expect(container).toBeEmptyDOMElement();
});

test("collapsed by default: the summary line and the day note, truncated", () => {
  render(<PlanChecklist plan={PLAN} progress={PROGRESS} />);
  expect(screen.getByText("Today's plan · 1 of 3 done · Free play 0 of 1")).toBeInTheDocument();
  const note = screen.getByText(PLAN.day_note);
  expect(note).toHaveClass("truncate");
  expect(screen.queryByText("Optional Free Play")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Today's plan/ })).toHaveAttribute("aria-expanded", "false");
});

test("no free play suffix when the plan has no free play items", () => {
  const plan = { ...PLAN, day_note: null, items: PLAN.items.filter((i) => !i.is_free_play) };
  render(<PlanChecklist plan={plan} progress={PROGRESS} />);
  expect(screen.getByText("Today's plan · 1 of 3 done")).toBeInTheDocument();
});

test("expanded: full note, planned items in order, then Optional Free Play", () => {
  render(<PlanChecklist plan={PLAN} progress={PROGRESS} />);
  fireEvent.click(screen.getByRole("button", { name: /Today's plan/ }));
  expect(screen.getByText(PLAN.day_note)).not.toHaveClass("truncate");

  const text = screen.getByRole("region", { name: "Today's practice plan" }).textContent;
  const order = ["Bars 5-12", "50 BPM · 80% · 2 passes", "(snippet archived)", "Optional Free Play", "Someone Like You"]
    .map((t) => text.indexOf(t));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect([...order].sort((x, y) => x - y)).toEqual(order);
});

test("each row: title with snippet, target, instruction, capped progress", () => {
  render(<PlanChecklist plan={PLAN} progress={PROGRESS} />);
  fireEvent.click(screen.getByRole("button", { name: /Today's plan/ }));
  const a = within(rowFor("Bars 5-12"));
  expect(a.getByText("Pastorale")).toHaveClass("truncate");
  expect(a.getByText("m.5–12 · RH · Bars 5-12")).toHaveClass("text-muted-foreground");
  expect(a.getByText("60 BPM · 90% · 4 passes")).toBeInTheDocument();
  expect(a.getByText("Count out loud.")).toBeInTheDocument();
  expect(a.getByText("4/4")).toBeInTheDocument();

  const free = within(rowFor("Someone Like You"));
  expect(free.getByText("Whole song")).toBeInTheDocument();
  expect(free.getByText("60 BPM · 2 passes")).toBeInTheDocument();
  expect(free.getByText("0/2")).toBeInTheDocument();
});

test("readability: detail lines are body size, target and instruction at full contrast", () => {
  render(<PlanChecklist plan={PLAN} progress={PROGRESS} />);
  fireEvent.click(screen.getByRole("button", { name: /Today's plan/ }));
  const a = within(rowFor("Bars 5-12"));
  // Nothing in the row is smaller than the body size.
  for (const t of ["m.5–12 · RH · Bars 5-12", "60 BPM · 90% · 4 passes", "Count out loud."]) {
    expect(a.getByText(t)).toHaveClass("text-sm");
    expect(a.getByText(t)).not.toHaveClass("text-xs");
  }
  expect(a.getByText("60 BPM · 90% · 4 passes")).toHaveClass("text-foreground");
  expect(a.getByText("Count out loud.")).toHaveClass("text-foreground");
  // The range line stays muted, at the darkest muted token.
  expect(a.getByText("m.5–12 · RH · Bars 5-12")).toHaveClass("text-muted-foreground");
  // The count is a step larger than the title, which is body size.
  expect(a.getByText("4/4")).toHaveClass("text-base");
  expect(a.getByText("Pastorale")).toHaveClass("text-sm");
});

test("done is struck through with a check; attempts short of target are amber; untouched is neither", () => {
  render(<PlanChecklist plan={PLAN} progress={PROGRESS} />);
  fireEvent.click(screen.getByRole("button", { name: /Today's plan/ }));

  const done = rowFor("Bars 5-12");
  expect(done).toHaveAttribute("data-state", "done");
  expect(within(done).getByText("Pastorale")).toHaveClass("line-through");
  // Struck through, but NOT dimmed: still readable at a glance.
  expect(within(done).getByText("Pastorale")).toHaveClass("text-foreground");
  expect(within(done).getByText("4/4")).toHaveClass("text-foreground");
  expect(within(done).getByText("60 BPM · 90% · 4 passes")).toHaveClass("line-through");
  expect(within(done).getByRole("img", { name: "Done" })).toBeInTheDocument();

  const amber = rowFor("50 BPM · 80% · 2 passes");
  expect(amber).toHaveAttribute("data-state", "amber");
  expect(within(amber).getByText("1/2")).toHaveClass("text-amber-800");
  expect(within(amber).getByText("50 BPM · 80% · 2 passes")).not.toHaveClass("line-through");
  expect(within(amber).queryByRole("img", { name: "Done" })).not.toBeInTheDocument();

  const open = rowFor("Someone Like You");
  expect(open).toHaveAttribute("data-state", "open");
  expect(within(open).queryByRole("img", { name: "Done" })).not.toBeInTheDocument();
});

test("an archived or missing snippet says so on the range line, muted", () => {
  const missing = item({ id: "m", position: 5, snippet_id: "x", snippet: null, snippet_unavailable: true });
  render(<PlanChecklist plan={{ ...PLAN, items: [...PLAN.items, missing] }} progress={PROGRESS} />);
  fireEvent.click(screen.getByRole("button", { name: /Today's plan/ }));
  // Range still known (archived), and a generated title adds nothing.
  expect(screen.getByText("m.1–2 · (snippet archived)")).toHaveClass("text-muted-foreground");
  // Not readable at all.
  expect(screen.getByText("(snippet archived)")).toHaveClass("text-muted-foreground");
});

test("a long song title is cut on its own line; the range, archived label and progress stay visible", () => {
  const LONG = "Pastorale No. 3 in G Major, Op. 100 No. 3 — Burgmüller Études Faciles et Progressives";
  const plan = {
    id: "p2",
    day_note: null,
    items: [
      item({ id: "l1", song_title: LONG, snippet_id: "s1",
        snippet: { id: "s1", title: "Measures 1-2 RH No Rest", start_measure: 1, end_measure: 2, hand_mode: "rh" } }),
      item({ id: "l2", position: 2, song_title: LONG, snippet_id: "s2",
        snippet: { id: "s2", title: "Measures 1-2 RH No Rest", start_measure: 1, end_measure: 2, hand_mode: "rh", archived: true },
        snippet_unavailable: true }),
    ],
  };
  render(<PlanChecklist plan={plan} progress={new Map()} />);
  fireEvent.click(screen.getByRole("button", { name: /Today's plan/ }));
  const titles = screen.getAllByText(LONG);
  expect(titles).toHaveLength(2);
  for (const t of titles) expect(t).toHaveClass("truncate");
  // The two rows differ below the title, where nothing truncates.
  const liveRange = screen.getByText("m.1–2 · RH");
  expect(liveRange).not.toHaveClass("truncate");
  expect(screen.getAllByText("0/4")).toHaveLength(2);
  for (const p of screen.getAllByText("0/4")) expect(p).toHaveClass("flex-shrink-0");
  expect(screen.getByText("m.1–2 · RH · (snippet archived)")).not.toHaveClass("truncate");
});

test("every row looks tappable: its own surface, a pressed state and a chevron", () => {
  render(<PlanChecklist plan={PLAN} progress={PROGRESS} />);
  fireEvent.click(screen.getByRole("button", { name: /Today's plan/ }));
  const rows = [rowFor("Bars 5-12"), rowFor("Someone Like You"), rowFor("(snippet archived)")];
  for (const row of rows) {
    // A tablet has no hover to discover the target with, so the row carries a
    // visible edge and a pressed state of its own.
    expect(row).toHaveClass("border", "border-border", "active:bg-secondary");
    expect(row).toHaveClass("min-h-[52px]");
    // ...and the trailing "this opens" chevron.
    // eslint-disable-next-line testing-library/no-node-access
    expect(row.querySelectorAll("svg[aria-hidden='true']")).toHaveLength(1);
  }
});

test("tapping a row opens that item", () => {
  const onOpenItem = jest.fn();
  render(<PlanChecklist plan={PLAN} progress={PROGRESS} onOpenItem={onOpenItem} />);
  fireEvent.click(screen.getByRole("button", { name: /Today's plan/ }));
  fireEvent.click(rowFor("(snippet archived)"));
  expect(onOpenItem).toHaveBeenCalledWith(PLAN.items[3]);
});

test("the expanded state is remembered", () => {
  const { unmount } = render(<PlanChecklist plan={PLAN} progress={PROGRESS} />);
  fireEvent.click(screen.getByRole("button", { name: /Today's plan/ }));
  expect(store.data["sam.planChecklist.expanded"]).toBe("1");
  unmount();
  render(<PlanChecklist plan={PLAN} progress={PROGRESS} />);
  expect(screen.getByText("Optional Free Play")).toBeInTheDocument();
});

test("storage that throws is ignored", () => {
  const blocked = () => { throw new Error("blocked"); };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: { getItem: blocked, setItem: blocked },
  });
  render(<PlanChecklist plan={PLAN} progress={PROGRESS} />);
  fireEvent.click(screen.getByRole("button", { name: /Today's plan/ }));
  expect(screen.getByText("Optional Free Play")).toBeInTheDocument();
});

// --- On load: scroll to what's left, or collapse a finished plan (2026-09-19)

describe("on load", () => {
  let scrolled;
  beforeEach(() => {
    scrolled = [];
    // jsdom has no scrollIntoView; record the calls instead.
    Element.prototype.scrollIntoView = function (opts) {
      scrolled.push({ el: this, opts });
    };
    window.matchMedia = jest.fn().mockReturnValue({ matches: false });
  });

  // Free play sits between two pieces of main work, so "the first incomplete
  // item" and "the first incomplete MAIN item" are different rows.
  const P = {
    id: "p",
    day_note: null,
    items: [
      item({ id: "m1", position: 1, song_title: "Pastorale", target_passes: 2 }),
      item({ id: "fp", position: 2, song_title: "Someone Like You", is_free_play: true, target_passes: 2 }),
      item({ id: "m2", position: 3, song_title: "Autumn Leaves", target_passes: 2 }),
    ],
  };
  const done = (...ids) => new Map(ids.map((id) => [id, { attempts: 2, qualifying: 2 }]));
  const expanded = () => { store.data["sam.planChecklist.expanded"] = "1"; };
  const scrolledRow = () => scrolled[0] && scrolled[0].el.textContent;

  test("scrolls the first incomplete item into view, near the top", () => {
    expanded();
    render(<PlanChecklist plan={P} progress={done("m1")} progressReady />);
    expect(scrolled).toHaveLength(1);
    expect(scrolledRow()).toMatch(/Autumn Leaves/);
    // Near the top of the viewport, not hard against the bottom edge.
    expect(scrolled[0].opts).toMatchObject({ block: "start", behavior: "smooth" });
  });

  test("main work comes before Free Play, even when Free Play is earlier in the plan", () => {
    expanded();
    // Free play untouched, but m2 is main work: m2 wins.
    render(<PlanChecklist plan={P} progress={done("m1")} progressReady />);
    expect(scrolledRow()).toMatch(/Autumn Leaves/);
    expect(scrolledRow()).not.toMatch(/Someone Like You/);
  });

  test("Free Play is the target once all main work is done", () => {
    expanded();
    render(<PlanChecklist plan={P} progress={done("m1", "m2")} progressReady />);
    expect(scrolledRow()).toMatch(/Someone Like You/);
  });

  test("everything done: collapsed, showing just the summary, preference untouched", () => {
    expanded();
    render(<PlanChecklist plan={P} progress={done("m1", "m2", "fp")} progressReady />);
    expect(screen.getByRole("button", { name: /Today's plan/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Optional Free Play")).not.toBeInTheDocument();
    expect(scrolled).toHaveLength(0);
    // The stored preference is his, not ours: tomorrow's plan opens expanded.
    expect(store.data["sam.planChecklist.expanded"]).toBe("1");
  });

  test("a finished plan still opens when he taps it, and that does not rewrite the preference", () => {
    expanded();
    render(<PlanChecklist plan={P} progress={done("m1", "m2", "fp")} progressReady />);
    fireEvent.click(screen.getByRole("button", { name: /Today's plan/ }));
    expect(screen.getByText("Optional Free Play")).toBeInTheDocument();
    expect(store.data["sam.planChecklist.expanded"]).toBe("1");
  });

  test("nothing happens before progress has been fetched, and only once after", () => {
    expanded();
    const { rerender } = render(<PlanChecklist plan={P} progress={new Map()} progressReady={false} />);
    expect(scrolled).toHaveLength(0);
    rerender(<PlanChecklist plan={P} progress={done("m1")} progressReady />);
    expect(scrolled).toHaveLength(1);
    // A later refresh must never yank the page while he is reading it.
    rerender(<PlanChecklist plan={P} progress={done("m1", "m2")} progressReady />);
    expect(scrolled).toHaveLength(1);
  });

  test("never scrolls a collapsed strip", () => {
    render(<PlanChecklist plan={P} progress={done("m1")} progressReady />);
    expect(scrolled).toHaveLength(0);
  });

  test("reduced motion jumps instead of gliding", () => {
    expanded();
    window.matchMedia = jest.fn().mockReturnValue({ matches: true });
    render(<PlanChecklist plan={P} progress={done("m1")} progressReady />);
    expect(scrolled[0].opts).toMatchObject({ behavior: "auto" });
  });

  test("no plan and no items: nothing happens", () => {
    expanded();
    const { rerender } = render(<PlanChecklist plan={null} progress={new Map()} progressReady />);
    expect(scrolled).toHaveLength(0);
    rerender(<PlanChecklist plan={{ id: "e", day_note: null, items: [] }} progress={new Map()} progressReady />);
    expect(scrolled).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Today's plan/ })).toHaveAttribute("aria-expanded", "true");
  });
});

// --- The Next control on a completed row -------------------------------------

describe("Next on a completed item", () => {
  const P = {
    id: "p",
    day_note: null,
    items: [
      item({ id: "m1", position: 1, song_title: "Pastorale", target_passes: 2 }),
      item({ id: "fp", position: 2, song_title: "Someone Like You", is_free_play: true, target_passes: 2 }),
      item({ id: "m2", position: 3, song_title: "Autumn Leaves", target_passes: 2, snippet_id: "s1",
        snippet: { id: "s1", title: "Measures 1-16 Both No Rest", start_measure: 1, end_measure: 16, hand_mode: "both" } }),
    ],
  };
  const done = (...ids) => new Map(ids.map((id) => [id, { attempts: 2, qualifying: 2 }]));

  function open(progress) {
    const onOpenItem = jest.fn();
    render(<PlanChecklist plan={P} progress={progress} onOpenItem={onOpenItem} />);
    fireEvent.click(screen.getByRole("button", { name: /Today's plan/ }));
    return onOpenItem;
  }

  test("a completed item offers the next incomplete one, by song and range", () => {
    open(done("m1"));
    expect(screen.getByRole("button", { name: "Next: Autumn Leaves m.1–16" })).toBeInTheDocument();
    // Only the completed row carries one.
    expect(screen.getAllByRole("button", { name: /^Next:/ })).toHaveLength(1);
  });

  test("tapping Next opens that item through the same handler a row tap uses", () => {
    const onOpenItem = open(done("m1"));
    fireEvent.click(screen.getByRole("button", { name: "Next: Autumn Leaves m.1–16" }));
    expect(onOpenItem).toHaveBeenCalledWith(P.items[2]);
  });

  test("Free Play is offered as next once main work is done, labelled the same way", () => {
    open(done("m1", "m2"));
    // Both completed rows point at the only thing left.
    expect(screen.getAllByRole("button", { name: "Next: Someone Like You Whole song" })).toHaveLength(2);
  });

  test("Next falls back to the first incomplete item when everything later is done", () => {
    // m2 (last in working order) and Free Play are done, m1 is not: with
    // nothing after them, both point back up at the one bar he skipped.
    open(done("m2", "fp"));
    expect(screen.getAllByRole("button", { name: "Next: Pastorale Whole song" })).toHaveLength(2);
  });

  test("no Next anywhere when the plan is complete", () => {
    const onOpenItem = jest.fn();
    // progressReady is not set, so the auto-collapse is out of the way here.
    render(<PlanChecklist plan={P} progress={done("m1", "m2", "fp")} onOpenItem={onOpenItem} />);
    fireEvent.click(screen.getByRole("button", { name: /Today's plan/ }));
    expect(screen.getByText("Optional Free Play")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Next:/ })).not.toBeInTheDocument();
  });

  test("the button is a real button: full contrast, body size, 44px, title truncated not the range", () => {
    open(done("m1"));
    const btn = screen.getByRole("button", { name: "Next: Autumn Leaves m.1–16" });
    expect(btn).toHaveClass("bg-primary", "text-primary-foreground", "text-sm", "min-h-[44px]");
    expect(btn).not.toHaveClass("text-xs");
    // The song title gives way first; the range always survives.
    expect(within(btn).getByText("Autumn Leaves")).toHaveClass("truncate");
    expect(within(btn).getByText("m.1–16")).toHaveClass("shrink-0");
  });
});
