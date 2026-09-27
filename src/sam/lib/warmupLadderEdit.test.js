// Editing a ladder: the draft round-trip and the rules the editor checks before
// the write. Every rule here mirrors sam_warmup_ladder_is_valid (migrations 078
// and 080) — the constraint is the invariant, this is the readable error.

import {
  blankRung, draftSummary, fromDraft, toDraft, validateDraft, withAddedRung, withRungAt,
} from "./warmupLadderEdit";

const row = (percent, over = {}) => ({ percent, accuracy: "", passes: "2", consecutive: true, ...over });
const TWO = [row("70"), row("100")];

describe("the draft round-trip", () => {
  test("a stored ladder becomes rows and back again unchanged", () => {
    const stored = [
      { target_percent: 50, accuracy_target: 100, target_passes: 2, consecutive: true },
      { target_percent: 100, accuracy_target: null, target_passes: 3, consecutive: false },
    ];
    expect(fromDraft(toDraft(stored))).toEqual(stored);
  });

  test("null and [] both become no rows", () => {
    expect(toDraft(null)).toEqual([]);
    expect(toDraft([])).toEqual([]);
  });

  test("a blank accuracy stores null, not zero — it means inherit the item's", () => {
    expect(fromDraft([row("70", { accuracy: "" })])[0].accuracy_target).toBeNull();
    expect(fromDraft([row("70", { accuracy: "0" })])[0].accuracy_target).toBe(0);
  });

  test("a new rung defaults to two passes in a row", () => {
    expect(blankRung()).toMatchObject({ passes: "2", consecutive: true });
  });
});

describe("validation, matching migration 080", () => {
  const errs = (rows) => validateDraft(rows);

  test("the smallest real ladder is accepted", () => {
    expect(errs(TWO).ok).toBe(true);
  });

  test("one rung is not a ladder", () => {
    const { ok, errors } = errs([row("100")]);
    expect(ok).toBe(false);
    expect(errors.ladder.join(" ")).toMatch(/at least 2 rungs/);
  });

  test("seven rungs is too many", () => {
    const seven = ["40", "50", "60", "70", "80", "90", "100"].map((p) => row(p));
    expect(errs(seven).errors.ladder.join(" ")).toMatch(/at most 6/);
  });

  test("the last rung must be 100", () => {
    expect(errs([row("70"), row("90")]).errors.ladder.join(" ")).toMatch(/last rung must be 100/);
  });

  test("percents must ascend strictly, and the failing rung is the one flagged", () => {
    const { ok, errors } = errs([row("70"), row("70"), row("100")]);
    expect(ok).toBe(false);
    expect(errors.rungs[0]).toEqual([]);
    expect(errors.rungs[1].join(" ")).toMatch(/higher than the rung above \(70%\)/);
  });

  test("a percent out of range, or not whole", () => {
    expect(errs([row("5"), row("100")]).errors.rungs[0].join(" ")).toMatch(/between 10 and 100/);
    expect(errs([row("70.5"), row("100")]).errors.rungs[0].join(" ")).toMatch(/whole number/);
    expect(errs([row(""), row("100")]).errors.rungs[0].join(" ")).toMatch(/whole number/);
  });

  test("passes must be a whole number of at least one", () => {
    expect(errs([row("70", { passes: "0" }), row("100")]).errors.rungs[0].join(" ")).toMatch(/1 or more/);
    expect(errs([row("70", { passes: "" }), row("100")]).errors.rungs[0].join(" ")).toMatch(/1 or more/);
  });

  test("accuracy is blank or 1-100", () => {
    expect(errs([row("70", { accuracy: "" }), row("100")]).ok).toBe(true);
    expect(errs([row("70", { accuracy: "95" }), row("100")]).ok).toBe(true);
    expect(errs([row("70", { accuracy: "0" }), row("100")]).errors.rungs[0].join(" ")).toMatch(/blank, or a whole number/);
    expect(errs([row("70", { accuracy: "101" }), row("100")]).errors.rungs[0].join(" ")).toMatch(/blank, or a whole number/);
  });

  test("every problem is reported at once, not just the first", () => {
    const { errors } = errs([row("200", { passes: "0" }), row("90")]);
    expect(errors.rungs[0]).toHaveLength(2);
    expect(errors.ladder).toHaveLength(1);
  });

  test("no rows is not valid — there is nothing to save", () => {
    expect(errs([]).ok).toBe(false);
  });
});

test("the draft summary reads as a ramp, with a gap for what is not typed yet", () => {
  expect(draftSummary(TWO)).toBe("70% → 100%");
  expect(draftSummary([row(""), row("100")])).toBe("?% → 100%");
});

// --- Inserting a rung at a position (2026-09-27) ------------------------------
//
// The inline plus controls insert AT a position, so the "never after the target"
// rule lives here rather than at each call site.

describe("withRungAt", () => {
  const percents = (rows) => rows.map((r) => r.percent);

  test("at the top", () => {
    expect(percents(withRungAt(TWO, 0))).toEqual(["", "70", "100"]);
  });

  test("between two rungs", () => {
    const three = [row("50"), row("70"), row("100")];
    expect(percents(withRungAt(three, 1))).toEqual(["50", "", "70", "100"]);
  });

  test("directly above the target rung", () => {
    expect(percents(withRungAt(TWO, 1))).toEqual(["70", "", "100"]);
  });

  test("never after the target rung, however high the position asked for", () => {
    expect(percents(withRungAt(TWO, 2))).toEqual(["70", "", "100"]);
    expect(percents(withRungAt(TWO, 99))).toEqual(["70", "", "100"]);
  });

  test("a negative position is the top", () => {
    expect(percents(withRungAt(TWO, -3))).toEqual(["", "70", "100"]);
  });

  test("an empty ladder becomes the smallest real one, not a lone blank rung", () => {
    expect(percents(withRungAt([], 0))).toEqual(["70", "100"]);
  });

  test("a new rung carries the defaults, so only its percent needs typing", () => {
    expect(withRungAt(TWO, 0)[0]).toMatchObject({ passes: "2", consecutive: true, accuracy: "" });
  });

  test("withAddedRung is the plus above the target", () => {
    expect(percents(withAddedRung(TWO))).toEqual(["70", "", "100"]);
  });
});
