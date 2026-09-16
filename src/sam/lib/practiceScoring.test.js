import { accuracyOf, bestAccuracy, formatAccuracy, onScreenTally } from "./practiceScoring";

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
