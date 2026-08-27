// M4 — the per-run refinement to §3.6, tested in isolation.
//
// computeStaffOverrides takes only plain data, so the rule can be exercised
// without a parser or a fixture. The corpus-level expectations that pin the
// threshold against real scores live in tools/sam-tools/test/handAssignment.test.js.

import { computeStaffOverrides, AWAY_RUN_MIN } from "./songParser";

// Build the per-measure input from a compact spec: one string per measure,
// "1" / "2" / "12" / "" meaning which staves the voice sounded on.
const staves = (spec) =>
  spec.map((s) => {
    const m = new Map();
    if (s) m.set("v", new Set(s.split("")));
    return m;
  });

const assigned = new Map([["v", "1"]]);

const flipped = (spec, assignment = assigned, minRun = AWAY_RUN_MIN) =>
  computeStaffOverrides(staves(spec), assignment, minRun)
    .map((m, i) => (m.get("v") ? i + 1 : null))
    .filter(Boolean);

describe("computeStaffOverrides — the run rule", () => {
  test("a run of two or more away measures flips", () => {
    expect(flipped(["1", "2", "2", "1"])).toEqual([2, 3]);
  });

  test("an isolated away measure does not flip", () => {
    expect(flipped(["1", "2", "1"])).toEqual([]);
  });

  test("the threshold is exactly AWAY_RUN_MIN", () => {
    expect(AWAY_RUN_MIN).toBe(2);
    expect(flipped(["2"])).toEqual([]);
    expect(flipped(["2", "2"])).toEqual([1, 2]);
  });

  test("several runs in one song are handled independently", () => {
    expect(flipped(["2", "2", "1", "2", "1", "2", "2", "2"]))
      .toEqual([1, 2, 6, 7, 8]);
  });

  test("a split measure is never flipped and breaks the run", () => {
    // The cross-staff case §3.6 protects: the voice is on both staves at once,
    // so the engraving cannot say which hand plays it.
    expect(flipped(["2", "12", "2"])).toEqual([]);
    expect(flipped(["2", "2", "12", "2", "2"])).toEqual([1, 2, 4, 5]);
  });

  test("a measure the voice does not sound in breaks the run", () => {
    // A run is consecutive measures where the voice is present AND wholly away.
    // Silence is not evidence of anything.
    expect(flipped(["2", "", "2"])).toEqual([]);
    expect(flipped(["2", "2", "", "2", "2"])).toEqual([1, 2, 4, 5]);
  });

  test("measures on the assigned staff are left alone", () => {
    expect(flipped(["1", "1", "1"])).toEqual([]);
  });

  test("the override names the staff to move to", () => {
    const out = computeStaffOverrides(staves(["1", "2", "2"]), assigned);
    expect(out[0].size).toBe(0);
    expect(out[1].get("v")).toBe("2");
    expect(out[2].get("v")).toBe("2");
  });

  test("works in the other direction too — the rule is symmetric", () => {
    // Nothing in the corpus needs it, but the rule is not written as
    // "downward only", and a future score could sit a left-hand voice on the
    // treble staff for a sustained passage.
    const lh = new Map([["v", "2"]]);
    expect(flipped(["2", "1", "1", "2"], lh)).toEqual([2, 3]);
    expect(flipped(["2", "1", "2"], lh)).toEqual([]);
  });

  test("a raised threshold suppresses shorter runs", () => {
    expect(flipped(["2", "2", "1", "2", "2", "2"], assigned, 3)).toEqual([4, 5, 6]);
  });

  test("voices with no assignment are ignored", () => {
    const out = computeStaffOverrides(staves(["2", "2"]), new Map());
    expect(out.every((m) => m.size === 0)).toBe(true);
  });

  test("several voices are resolved independently", () => {
    const perMeasure = [
      new Map([["a", new Set(["2"])], ["b", new Set(["1"])]]),
      new Map([["a", new Set(["2"])], ["b", new Set(["2"])]]),
      new Map([["a", new Set(["1"])], ["b", new Set(["1"])]]),
    ];
    const out = computeStaffOverrides(perMeasure, new Map([["a", "1"], ["b", "1"]]));
    expect(out[0].get("a")).toBe("2");
    expect(out[1].get("a")).toBe("2");
    expect(out[0].get("b")).toBeUndefined();   // b is away for one measure only
    expect(out[1].get("b")).toBeUndefined();
  });

  test("an empty song produces no overrides", () => {
    expect(computeStaffOverrides([], assigned)).toEqual([]);
  });
});
