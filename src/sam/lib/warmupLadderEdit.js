// Editing a warm-up ladder: the draft shape the editor works in, and the rules
// it is checked against before it reaches the database.
// Spec: docs/technical-spec-sam-warmup-ladder.md §5.1, §7.4.
//
// THE CONSTRAINT IS THE INVARIANT, NOT THIS FILE. Every rule here is a copy of
// `sam_warmup_ladder_is_valid` (migrations 078 and 080), and the only reason for
// the copy is a readable error before the write rather than a Postgres constraint
// message after it. If the two ever disagree the database wins, and a write that
// slips past here is still refused — which is the point of putting the rule in a
// CHECK constraint in the first place.
//
// A DRAFT IS NOT A LADDER. The table has to hold half-typed values — an empty
// percent box, "8" on the way to "80" — so a draft rung keeps its fields as
// strings and is only converted at the end. That is why validation and conversion
// are separate functions here.

export const MIN_RUNGS = 2;
export const MAX_RUNGS = 6;
// The last rung is always the target, and the target is always 100% of it.
export const TARGET_PERCENT = 100;

/** A new rung for the "add row" button, as strings. */
export function blankRung() {
  return { percent: "", accuracy: "", passes: "2", consecutive: true };
}

/** The target rung, which every ladder ends with and which is never anything else. */
export function targetRung() {
  return { percent: String(TARGET_PERCENT), accuracy: "", passes: "2", consecutive: true };
}

/**
 * A blank rung inserted AT `at`, where `at` is the index it will occupy.
 *
 * The target rung must stay last, so the highest legal position is the target's own
 * index — inserting "above the 100 row" — and never after it. That is clamped here
 * rather than left to each caller to remember, which is the whole reason this is a
 * function and not a spread at the call site.
 *
 * An empty ladder becomes the smallest real one, because a lone blank rung would be
 * a ladder with no target.
 */
export function withRungAt(rows, at) {
  if (rows.length === 0) return [{ ...blankRung(), percent: "70" }, targetRung()];
  const where = Math.max(0, Math.min(at, rows.length - 1));
  return [...rows.slice(0, where), blankRung(), ...rows.slice(where)];
}

/** A blank rung directly above the target rung. */
export function withAddedRung(rows) {
  return withRungAt(rows, rows.length - 1);
}

/**
 * Whether the rung at `i` may be deleted.
 *
 * The LAST rung never can: it is the target, it is what "the ladder is finished"
 * means, and a ladder without it would leave him looping below tempo with nothing
 * to finish. Shortening a ladder is done by deleting one of the rungs above it.
 *
 * And at exactly two rungs nothing may be deleted, because one rung is not a
 * ladder (migration 080).
 */
export function canRemoveRung(rows, i) {
  if (i === rows.length - 1) return { ok: false, reason: "The last rung is the target and cannot be removed." };
  if (rows.length <= MIN_RUNGS) return { ok: false, reason: `A ladder needs at least ${MIN_RUNGS} rungs` };
  return { ok: true, reason: null };
}

// THE THREE STATES ARE A CHOICE IN THE FORM, NOT THREE BUTTONS (2026-09-27).
//
// The column means three different things — rungs, null (inherit the next level
// down) and [] (no warm-up here, inheriting nothing) — and for a while the editor
// expressed that as three action buttons that each wrote immediately. That gave
// every dialog two saves, which made its own Save and Cancel meaningless.
//
// So a draft is a MODE plus the rows, the mode is picked in the form, and nothing
// is written until the dialog's Save. `valueFromDraft` is the only place that
// turns a mode back into a column value.
/** The stored column → the draft the form edits. */
export function draftFromValue(value) {
  if (value == null) return { mode: "inherit", rows: [] };
  if (Array.isArray(value) && value.length === 0) return { mode: "none", rows: [] };
  return { mode: "own", rows: toDraft(value) };
}

/** The draft → the column value to write. Call only on a draft `validateMode` accepted. */
export function valueFromDraft(draft) {
  if (!draft || draft.mode === "inherit") return null;
  if (draft.mode === "none") return [];
  return fromDraft(draft.rows);
}

/**
 * Validate a whole draft. Only "own" has rungs to check — "inherit" and "none"
 * are always valid, because they say nothing about rungs.
 */
export function validateMode(draft) {
  if (!draft || draft.mode !== "own") return { ok: true, errors: { ladder: [], rungs: [] } };
  return validateDraft(draft.rows);
}


/** The stored jsonb array → the draft rows the table edits. */
export function toDraft(ladder) {
  if (!Array.isArray(ladder) || ladder.length === 0) return [];
  return ladder.map((r) => ({
    percent: r.target_percent == null ? "" : String(r.target_percent),
    accuracy: r.accuracy_target == null ? "" : String(r.accuracy_target),
    passes: r.target_passes == null ? "" : String(r.target_passes),
    consecutive: !!r.consecutive,
  }));
}

/**
 * The draft rows → the jsonb array to store. Call only on a draft that
 * `validateDraft` accepted.
 *
 * An empty accuracy box means null, which means "use the plan item's accuracy
 * target" (§3) — NOT zero, and not 85 baked in here.
 */
export function fromDraft(rows) {
  return rows.map((r) => ({
    target_percent: Number(r.percent),
    accuracy_target: String(r.accuracy).trim() === "" ? null : Number(r.accuracy),
    target_passes: Number(r.passes),
    consecutive: !!r.consecutive,
  }));
}

function wholeNumber(text) {
  const t = String(text ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

/**
 * Every problem with a draft, as one message per rung plus whole-ladder
 * messages. Returns `{ ok, errors: { ladder: [], rungs: [[] per row] } }`.
 *
 * Reporting every problem at once, rather than the first: retyping a rung to be
 * told about the next one is how a six-row table becomes six round trips.
 */
export function validateDraft(rows) {
  const rungs = rows.map(() => []);
  const ladder = [];

  if (rows.length < MIN_RUNGS) {
    // Why two and not one: a single rung would have to be the 100% one, so it is
    // a pass count at target tempo rather than a ramp — and the progress function
    // cannot tell a restart from continued looping without a rung that drops.
    ladder.push(`A ladder needs at least ${MIN_RUNGS} rungs — one below target, then target.`);
  }
  if (rows.length > MAX_RUNGS) {
    ladder.push(`A ladder can have at most ${MAX_RUNGS} rungs.`);
  }

  let previous = null;
  rows.forEach((row, i) => {
    const percent = wholeNumber(row.percent);
    if (percent === null) {
      rungs[i].push("Percent must be a whole number.");
    } else if (percent < 10 || percent > 100) {
      rungs[i].push("Percent must be between 10 and 100.");
    } else {
      if (previous !== null && percent <= previous) {
        rungs[i].push(`Percent must be higher than the rung above (${previous}%).`);
      }
      previous = percent;
    }

    const passes = wholeNumber(row.passes);
    if (passes === null || passes < 1) {
      rungs[i].push("Passes must be a whole number, 1 or more.");
    }

    // Blank is legitimate and means "inherit the item's accuracy target".
    if (String(row.accuracy ?? "").trim() !== "") {
      const accuracy = wholeNumber(row.accuracy);
      if (accuracy === null || accuracy < 1 || accuracy > 100) {
        rungs[i].push("Accuracy must be blank, or a whole number from 1 to 100.");
      }
    }
  });

  // The last rung is the target; a ladder that stopped short would leave him
  // looping below tempo with nothing to finish. The editor makes this percent
  // read-only, so reaching this message means the value came from somewhere else.
  if (rows.length > 0) {
    const last = wholeNumber(rows[rows.length - 1].percent);
    if (last !== null && last !== TARGET_PERCENT) {
      ladder.push(`The last rung must be ${TARGET_PERCENT}% — that is the target tempo.`);
    }
  }

  const ok = ladder.length === 0 && rungs.every((r) => r.length === 0);
  return { ok, errors: { ladder, rungs } };
}

/** "70% → 100%", for a one-line preview of a draft. */
export function draftSummary(rows) {
  return rows.map((r) => `${String(r.percent).trim() || "?"}%`).join(" → ");
}
