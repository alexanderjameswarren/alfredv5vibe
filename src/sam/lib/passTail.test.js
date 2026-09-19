// The unplayed tail of a pass (2026-09-19).
//
// A beat of the outgoing pass that was never played, and whose grace window
// had not expired when the loop teleported, used to be reset to "pending" and
// never recorded. The last note of a pass could escape the miss count.

import { sweepUnplayedTail } from "./passTail";

const beat = (over = {}) => ({
  state: "pending", allMidi: [60], rhMidi: [60], lhMidi: [48], ...over,
});
const rest = (over = {}) => beat({ allMidi: [], rhMidi: [], lhMidi: [], ...over });

// Three copies of a two-beat range — the shape ScrollEngine keeps while looping.
const threeCopies = (copy) => [...copy, ...copy.map((b) => ({ ...b })), ...copy.map((b) => ({ ...b }))];

test("a beat still pending when the pass ends is a miss", () => {
  const events = threeCopies([beat({ meas: 1 }), beat({ meas: 2 })]);
  events[0].state = "hit";                 // played
  const missed = [];
  const n = sweepUnplayedTail(events, 2, "both", (e) => missed.push(e.meas));

  expect(n).toBe(1);
  expect(missed).toEqual([2]);             // the tail beat, which would have escaped
  expect(events[1].state).toBe("missed");
  expect(events[0].state).toBe("hit");     // a played beat is left alone
});

test("only the outgoing copy is swept; the copies ahead stay pending", () => {
  const events = threeCopies([beat(), beat()]);
  sweepUnplayedTail(events, 2, "both", () => {});
  expect(events.slice(0, 2).map((e) => e.state)).toEqual(["missed", "missed"]);
  // Copies 1 and 2 are the passes still to come.
  expect(events.slice(2).every((e) => e.state === "pending")).toBe(true);
});

test("a rest is skipped, never missed", () => {
  const events = threeCopies([rest(), beat()]);
  const missed = [];
  const n = sweepUnplayedTail(events, 2, "both", (e) => missed.push(e));

  expect(n).toBe(1);
  expect(missed).toHaveLength(1);
  expect(events[0].state).toBe("skipped");
  expect(events[1].state).toBe("missed");
});

test("hand mode decides what counts as a note", () => {
  // Right hand silent, left hand playing. Fresh events each time: the sweep
  // mutates state, so a shared object would arrive already resolved.
  const rhSilent = () => beat({ allMidi: [48], rhMidi: [], lhMidi: [48] });
  const events = threeCopies([rhSilent(), rhSilent()]);
  expect(sweepUnplayedTail(events, 2, "rh", () => {})).toBe(0);
  expect(events.slice(0, 2).every((e) => e.state === "skipped")).toBe(true);

  const again = threeCopies([rhSilent(), rhSilent()]);
  expect(sweepUnplayedTail(again, 2, "lh", () => {})).toBe(2);
});

test("beats already resolved are untouched, whatever they resolved to", () => {
  const events = threeCopies([
    beat({ state: "missed" }), beat({ state: "partial" }),
  ]);
  const n = sweepUnplayedTail(events, 2, "both", () => { throw new Error("must not fire"); });
  expect(n).toBe(0);
  expect(events[0].state).toBe("missed");
  expect(events[1].state).toBe("partial");
});

test("it is not time-based: recency never spares a beat", () => {
  // The scanner waits out the window because the note might still arrive.
  // Here the pass is over, so it cannot, however recently the beat passed.
  const events = threeCopies([beat({ targetTimeMs: 999999 })]);
  expect(sweepUnplayedTail(events, 1, "both", () => {})).toBe(1);
});

test("nothing to sweep is not an error", () => {
  expect(sweepUnplayedTail([], 0, "both", () => {})).toBe(0);
  expect(sweepUnplayedTail(null, 2, "both", () => {})).toBe(0);
  expect(sweepUnplayedTail([beat()], 5, "both", () => {})).toBe(1);   // copy longer than the array
  expect(sweepUnplayedTail([beat()], 1, "both", undefined)).toBe(1);  // no callback
});
