import {
  accuracyOf, bestAccuracy, bestAchievableAccuracy, formatAccuracy, goalState, onScreenTally,
  scoreableBeatsPerPass, targetUnreachable,
} from "./practiceScoring";

describe("accuracyOf — the sam_passes.accuracy_percent rule", () => {
  test("null when no MIDI note arrived, however many misses were raised", () => {
    expect(accuracyOf({ hits: 0, misses: 12, notesPlayed: 0 })).toBeNull();
    expect(accuracyOf({ hits: 3, misses: 1, notesPlayed: 0 })).toBeNull();
    expect(accuracyOf({ hits: 0, misses: 5 })).toBeNull(); // notesPlayed missing
  });

  test("null when notes were played but no beat was scored (hits + misses = 0)", () => {
    expect(accuracyOf({ hits: 0, misses: 0, notesPlayed: 4 })).toBeNull();
    expect(accuracyOf({})).toBeNull();
  });

  test("a real value otherwise, including a measured 0", () => {
    expect(accuracyOf({ hits: 3, misses: 1, notesPlayed: 3 })).toBe(75);
    expect(accuracyOf({ hits: 0, misses: 4, notesPlayed: 2 })).toBe(0);
    expect(accuracyOf({ hits: 5, misses: 0, notesPlayed: 5 })).toBe(100);
  });

  test("partials are outside the ratio", () => {
    expect(accuracyOf({ hits: 1, misses: 1, partials: 8, notesPlayed: 10 })).toBe(50);
  });

  test("rounds as Postgres does: 23 of 40 is 58, not 57", () => {
    // (23 / 40) * 100 is 57.49999999999999 in floating point.
    expect(accuracyOf({ hits: 23, misses: 17, notesPlayed: 23 })).toBe(58);
    expect(accuracyOf({ hits: 1, misses: 7, notesPlayed: 1 })).toBe(13); // 12.5 rounds up
  });
});

describe("bestAccuracy", () => {
  test("ignores nulls", () => {
    expect(bestAccuracy([null, 40, null, 65, 50])).toBe(65);
  });
  test("a measured 0 still counts", () => {
    expect(bestAccuracy([null, 0])).toBe(0);
  });
  test("null when nothing is measured", () => {
    expect(bestAccuracy([null, null])).toBeNull();
    expect(bestAccuracy([])).toBeNull();
    expect(bestAccuracy(undefined)).toBeNull();
  });
});

describe("formatAccuracy", () => {
  test("a dash for unmeasured, never 0%, NaN or null%", () => {
    expect(formatAccuracy(null)).toBe("—");
    expect(formatAccuracy(undefined)).toBe("—");
    expect(formatAccuracy(NaN)).toBe("—");
  });
  test("a percentage otherwise", () => {
    expect(formatAccuracy(0)).toBe("0%");
    expect(formatAccuracy(87)).toBe("87%");
  });
});

describe("onScreenTally", () => {
  test("only a full hit is a Hit; a partial is neither", () => {
    expect(onScreenTally("hit")).toBe("hit");
    expect(onScreenTally("partial")).toBeNull();
    expect(onScreenTally("wrong")).toBe("miss");
    expect(onScreenTally("miss")).toBe("miss");
  });
});

describe("goalState — how a pass stands against its target", () => {
  test("met at or above, short below, nothing to say without both numbers", () => {
    expect(goalState(95, 95)).toBe("met");
    expect(goalState(100, 90)).toBe("met");
    expect(goalState(89, 90)).toBe("short");
    expect(goalState(null, 90)).toBeNull();
    expect(goalState(95, null)).toBeNull();
  });
});

describe("scoreableBeatsPerPass — one pass's worth, per hand", () => {
  const beat = (meas, b, rh, lh) => ({
    meas, beat: b, rhMidi: rh, lhMidi: lh, allMidi: [...rh, ...lh],
  });

  test("three rendered copies of a range are still one pass", () => {
    const one = [beat(1, 1, [60], []), beat(1, 2, [62], [])];
    expect(scoreableBeatsPerPass([...one, ...one, ...one])).toEqual({ both: 2, rh: 2, lh: 0 });
  });

  test("a beat with nothing in the active hand is not scoreable there", () => {
    const events = [beat(1, 1, [60], [48]), beat(1, 2, [], [50]), beat(1, 3, [64], [])];
    expect(scoreableBeatsPerPass(events)).toEqual({ both: 3, rh: 2, lh: 2 });
  });

  test("rests, and nothing at all, count as nothing", () => {
    expect(scoreableBeatsPerPass([beat(2, 1, [], [])])).toEqual({ both: 0, rh: 0, lh: 0 });
    expect(scoreableBeatsPerPass(null)).toEqual({ both: 0, rh: 0, lh: 0 });
  });
});

describe("bestAchievableAccuracy — the ceiling, with partials handled", () => {
  test("every remaining beat a hit", () => {
    // 1 hit, 1 miss, 8 to come: 9 of 10.
    expect(bestAchievableAccuracy({ hits: 1, misses: 1 }, 10)).toBe(90);
    expect(bestAchievableAccuracy({ hits: 0, misses: 0 }, 10)).toBe(100);
  });

  test("a PARTIAL leaves the ratio, so it lowers the ceiling without being a miss", () => {
    // Ten beats, one missed and one partial: eight can still be hits, and the
    // partial is in neither half of the ratio — 8 of 9, not 8 of 10.
    expect(bestAchievableAccuracy({ hits: 0, misses: 1, partials: 1 }, 10)).toBe(89);
    // Ignoring the partials would leave nine beats "still to come" and read 90.
    // A partial is a beat that has been PLAYED: it can no longer become a hit.
    expect(bestAchievableAccuracy({ hits: 0, misses: 1, partials: 4 }, 10)).toBe(83);
  });

  test("nothing to say when the count is missing or disagrees with what was played", () => {
    expect(bestAchievableAccuracy({ hits: 1, misses: 0 }, 0)).toBeNull();
    expect(bestAchievableAccuracy({ hits: 1, misses: 0 }, null)).toBeNull();
    // More beats played than the range holds: the count is wrong, so say nothing.
    expect(bestAchievableAccuracy({ hits: 8, misses: 5 }, 10)).toBeNull();
  });
});

describe("targetUnreachable — and everything that keeps it quiet", () => {
  const pass = (o) => ({ notesPlayed: 4, hits: 0, misses: 0, partials: 0, ...o });

  test("says so once the ceiling is below the target", () => {
    // 4 beats, one missed: 75% at best, under a 90% bar.
    expect(targetUnreachable(pass({ misses: 1 }), { target: 90, scoreable: 4 })).toBe(true);
  });

  test("silent while the target is still reachable, and on the rounding edge", () => {
    expect(targetUnreachable(pass({ misses: 1 }), { target: 90, scoreable: 40 })).toBe(false);
    // 19 of 20 is 95: exactly the bar, so not out of reach.
    expect(targetUnreachable(pass({ misses: 1 }), { target: 95, scoreable: 20 })).toBe(false);
    // 18 of 20 is exactly 90 — still reachable, and it stays quiet.
    expect(targetUnreachable(pass({ misses: 2 }), { target: 90, scoreable: 20 })).toBe(false);
    // 17 of 20 is 85, and that is past saving.
    expect(targetUnreachable(pass({ misses: 3 }), { target: 90, scoreable: 20 })).toBe(true);
  });

  test("silent whenever anything is unknown — a false give-up is the worse failure", () => {
    expect(targetUnreachable(pass({ misses: 4 }), { target: 90, scoreable: 0 })).toBe(false);
    expect(targetUnreachable(pass({ misses: 4 }), { target: null, scoreable: 4 })).toBe(false);
    // No keyboard: every beat times out as a miss, and none of it is a verdict.
    expect(targetUnreachable(pass({ misses: 4, notesPlayed: 0 }), { target: 90, scoreable: 4 })).toBe(false);
    // Nothing missed yet: 100% is still on the table.
    expect(targetUnreachable(pass({ hits: 3 }), { target: 90, scoreable: 4 })).toBe(false);
    expect(targetUnreachable(null, { target: 90, scoreable: 4 })).toBe(false);
  });

  test("partials alone never make a target impossible", () => {
    // Every beat a partial: nothing has been missed, so the ratio is untouched
    // and there is nothing to warn about.
    expect(targetUnreachable(pass({ partials: 4 }), { target: 90, scoreable: 4 })).toBe(false);
  });
});
