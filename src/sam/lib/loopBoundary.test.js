import { isNextCycleBeat, snapshotIncoming, applyCarryOver, activeEls } from "./loopBoundary";
import { sweepUnplayedTail } from "./passTail";

// Three copies of a two-beat range: [c0b0, c0b1, c1b0, c1b1, c2b0, c2b1].
function copies() {
  const out = [];
  for (let c = 0; c < 3; c++) {
    for (let b = 0; b < 2; b++) out.push({ copy: c, meas: 1, beat: b + 1, allMidi: [60], rhMidi: [60], lhMidi: [], state: "pending" });
  }
  return out;
}

// What the wrap does: snapshot copy 1, reset everything, carry over.
function wrap(events) {
  const snap = snapshotIncoming(events, 2);
  for (const e of events) e.state = "pending";
  return applyCarryOver(events, snap);
}

test("only copies past 0 are the next pass", () => {
  expect(isNextCycleBeat({ copy: 0 })).toBe(false);
  expect(isNextCycleBeat({ copy: 1 })).toBe(true);
  expect(isNextCycleBeat({})).toBe(false);
});

test("an early hit on copy 1 survives the wrap as copy 0", () => {
  const ev = copies();
  ev[2].state = "hit";
  const carried = wrap(ev);
  expect(carried).toEqual([ev[0]]);
  expect(ev[0].state).toBe("hit");
  expect(ev[1].state).toBe("pending");
  expect(ev.slice(2).every((e) => e.state === "pending")).toBe(true);
});

test("the carried beat raises no false miss at the next wrap", () => {
  const ev = copies();
  ev[2].state = "hit";
  wrap(ev);
  const misses = [];
  sweepUnplayedTail(ev, 2, "both", (e) => misses.push(e));
  expect(misses).toEqual([ev[1]]);
});

test("nothing played early: the wrap resets as before", () => {
  const ev = copies();
  ev[0].state = "hit";
  ev[1].state = "missed";
  expect(wrap(ev)).toEqual([]);
  expect(ev.every((e) => e.state === "pending")).toBe(true);
});

test("active elements follow the scored hand", () => {
  const evt = { svgEls: ["t", "b"], trebleSvgEl: "t", bassSvgEl: "b" };
  expect(activeEls(evt, "rh")).toEqual(["t"]);
  expect(activeEls(evt, "lh")).toEqual(["b"]);
  expect(activeEls(evt, "both")).toEqual(["t", "b"]);
});
