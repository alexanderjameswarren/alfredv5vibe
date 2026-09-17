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

test("done is struck through with a check; attempts short of target are amber; untouched is neither", () => {
  render(<PlanChecklist plan={PLAN} progress={PROGRESS} />);
  fireEvent.click(screen.getByRole("button", { name: /Today's plan/ }));

  const done = rowFor("Bars 5-12");
  expect(done).toHaveAttribute("data-state", "done");
  expect(within(done).getByText("Pastorale")).toHaveClass("line-through");
  expect(within(done).getByText("60 BPM · 90% · 4 passes")).toHaveClass("line-through");
  expect(within(done).getByRole("img", { name: "Done" })).toBeInTheDocument();

  const amber = rowFor("50 BPM · 80% · 2 passes");
  expect(amber).toHaveAttribute("data-state", "amber");
  expect(within(amber).getByText("1/2")).toHaveClass("text-amber-700");
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
