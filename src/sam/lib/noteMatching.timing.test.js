// When a keystroke is timed (2026-09-19).
//
// Until this date the matcher read `scrollState.elapsed`, which ScrollEngine
// writes ONCE PER ANIMATION FRAME. That quantised every offset to ~17 ms at
// 60 Hz, made it stale by up to a frame, and — because a stale `elapsed` is too
// small — biased offsets POSITIVE (early). The press time now comes from the
// MIDI event itself and the matcher adds the time since that frame.

import { elapsedAt, findClosestBeat, nearestBeat } from "./noteMatching";

const beat = (targetTimeMs, over = {}) => ({
  targetTimeMs, state: "pending", allMidi: [60], rhMidi: [60], lhMidi: [60], ...over,
});

// A frame that computed elapsed=1000 at performance.now()=5000.
const state = (over = {}) => ({ scrollStartT: 0, elapsed: 1000, elapsedAtMs: 5000, ...over });

describe("elapsedAt", () => {
  test("adds the time since the frame that published elapsed", () => {
    // Pressed 12 ms after that frame: 1012, not the frame's own 1000.
    expect(elapsedAt(state(), 5012)).toBe(1012);
    expect(elapsedAt(state(), 5000)).toBe(1000);
  });

  test("never runs backwards", () => {
    // A press stamped before the current frame belongs to that frame.
    expect(elapsedAt(state(), 4990)).toBe(1000);
  });

  test("falls back to the published value when there is no press time", () => {
    expect(elapsedAt(state(), undefined)).toBe(1000);
    expect(elapsedAt(state(), null)).toBe(1000);
    // ...or when the engine is not recording frame times (an older state).
    expect(elapsedAt(state({ elapsedAtMs: undefined }), 5012)).toBe(1000);
  });

  test("before the first frame, the raw wall clock", () => {
    const now = performance.now();
    const got = elapsedAt({ scrollStartT: now - 250, elapsed: undefined }, now);
    expect(got).toBeGreaterThanOrEqual(249);
    expect(got).toBeLessThan(400);
  });
});

describe("the matcher times the press, not the frame", () => {
  test("a key pressed mid-frame is not credited to the frame boundary", () => {
    // The beat is at 1050. The frame said elapsed=1000, so reading the frame
    // would call this 50 ms EARLY. He actually pressed 40 ms into the frame.
    const events = [beat(1050)];
    const atFrame = findClosestBeat(events, state(), 300, "both");
    expect(atFrame.timingDeltaMs).toBe(50);

    const atPress = findClosestBeat(events, state(), 300, "both", 5040);
    expect(atPress.timingDeltaMs).toBe(10);
  });

  test("the frame-quantised reading is the more EARLY of the two", () => {
    // Staleness makes elapsed too small, so it always biases positive. This is
    // why a render stall could never manufacture apparent lateness.
    const events = [beat(1200)];
    const frame = findClosestBeat(events, state(), 300, "both").timingDeltaMs;
    const press = findClosestBeat(events, state(), 300, "both", 5016).timingDeltaMs;
    expect(frame).toBeGreaterThan(press);
    expect(frame - press).toBe(16);
  });

  test("the press time decides whether a beat is in the window at all", () => {
    // 290 ms late at the frame; 310 ms late by the time he actually pressed.
    const events = [beat(710)];
    expect(findClosestBeat(events, state(), 300, "both")).not.toBeNull();
    expect(findClosestBeat(events, state(), 300, "both", 5020)).toBeNull();
  });

  test("nearestBeat uses the press time too, so an extra's offset agrees", () => {
    const events = [beat(1050)];
    expect(nearestBeat(events, state(), "both").timingDeltaMs).toBe(50);
    expect(nearestBeat(events, state(), "both", 5040).timingDeltaMs).toBe(10);
  });

  test("with no press time the old behaviour is unchanged", () => {
    const events = [beat(1050)];
    expect(findClosestBeat(events, state(), 300, "both").timingDeltaMs).toBe(50);
    expect(nearestBeat(events, state(), "both").timingDeltaMs).toBe(50);
  });
});
