// The output invariants: the eight of spec §5, plus a ninth (repeated pitch)
// that makes this harness agree with the app's import validator.
//
// Built BEFORE any transform exists, and proved against an identity run and
// four deliberate mutations. A check that has never failed has not been tested.
//
// `verify` returns a list of violations rather than throwing, so a caller can
// report all of them at once; `assertVerified` is the throwing wrapper. Every
// violation is an ERROR — none of these is advisory.
//
// Duration math goes through durations.js, tie/seam analysis through
// analyze.js, and the repeated-pitch rule through the app's own module.
// Nothing here re-implements any of them.

import { sumEvents } from "./durations.js";
import { analyzeTies, findSeams } from "./analyze.js";
// The app's duplicate-pitch predicate, imported rather than restated.
// vendor/noteDuplicates.js is a verbatim copy of src/sam/lib/noteDuplicates.js
// (`npm run sync`), the same module the app's import validator, the parser and
// the Edge Function port all use — so this check and the import cannot
// disagree about what counts as a repeated pitch.
import { duplicatePitches, duplicatePitchMessage } from "../vendor/noteDuplicates.js";

const num = (m, i) => m?.number ?? i + 1;
const isRest = (e) => !e || !Array.isArray(e.notes) || e.notes.length === 0;
const topMidi = (e) => (isRest(e) ? null : Math.max(...e.notes.map((n) => n.midi)));
const j = (v) => JSON.stringify(v ?? null);

// Measure-level fields that must survive verbatim (invariant 8). Compared
// through `?? null` so "absent" and "null" are the same thing — that is the
// blob convention the export format documents, and a transform that rebuilds a
// measure object should not fail for dropping a key that was never set.
const PASSTHROUGH_FIELDS = ["chord", "section", "sourceMeasure", "carriedTags"];

export const INVARIANTS = [
  "measure count",
  "time signature",
  "audioOffsetMs",
  "per-hand duration sum",
  "RH melody note",
  "RH event count",
  "tie integrity",
  "passthrough fields",
  "no repeated pitch",
];

function violation(list, n, measure, detail) {
  list.push({ invariant: n, name: INVARIANTS[n - 1], measure, detail });
}

/**
 * @param {object} input  - the source song document
 * @param {object} output - the transformed song document
 * @returns {Array<{invariant:number,name:string,measure:?number,detail:string}>}
 */
export function verify(input, output) {
  const v = [];
  const a = input?.measures ?? [];
  const b = output?.measures ?? [];

  // 1 — measure count
  if (a.length !== b.length) {
    violation(v, 1, null, `input has ${a.length} measures, output has ${b.length}`);
  }

  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const mi = a[i];
    const mo = b[i];
    const label = num(mi, i);

    // 2 — time signature, symbol included
    if (j(mi.timeSignature) !== j(mo.timeSignature)) {
      violation(v, 2, label, `${j(mi.timeSignature)} became ${j(mo.timeSignature)}`);
    }

    // 3 — audioOffsetMs, nulls preserved as nulls
    const oi = mi.audioOffsetMs ?? null;
    const oo = mo.audioOffsetMs ?? null;
    if (oi !== oo) {
      violation(v, 3, label, `audioOffsetMs ${j(oi)} became ${j(oo)}`);
    }

    // 4 — per-hand summed duration, tuplet-scaled
    for (const hand of ["rh", "lh"]) {
      const si = sumEvents(mi[hand] || []);
      const so = sumEvents(mo[hand] || []);
      if (si === null || so === null) {
        violation(v, 4, label, `${hand}: unparseable duration token (input ${j(si)}, output ${j(so)})`);
      } else if (Math.abs(si - so) > 1e-9) {
        violation(v, 4, label, `${hand}: ${si} beats became ${so} beats`);
      }
    }

    // 6 — RH event count (checked before 5, which indexes into it)
    const ri = mi.rh || [];
    const ro = mo.rh || [];
    if (ri.length !== ro.length) {
      violation(v, 6, label, `RH had ${ri.length} events, output has ${ro.length}`);
    }

    // 5 — the melody rule: every RH event's highest note is retained
    for (let e = 0; e < Math.min(ri.length, ro.length); e++) {
      const ti = topMidi(ri[e]);
      const to = topMidi(ro[e]);
      if (ti !== to) {
        violation(v, 5, label, `rh[${e}] top note ${j(ti)} became ${j(to)}`);
      }
    }

    // 8 — passthrough fields
    for (const f of PASSTHROUGH_FIELDS) {
      if (j(mi[f]) !== j(mo[f])) {
        violation(v, 8, label, `${f}: ${j(mi[f])} became ${j(mo[f])}`);
      }
    }
  }

  // 7 — tie integrity, seam-aware.
  //
  // Judged RELATIVE TO THE INPUT: only a tie problem the transform introduced
  // is a violation. A song that arrives with a pre-existing orphan is not the
  // transform's fault, and failing identity on it would be wrong.
  //
  // `analyzeTies` already labels an unmatched end at a sourceMeasure
  // discontinuity as `seam` rather than `orphan` — at a seam the note it
  // continued from is in a measure the flattening skipped, which is legitimate.
  const tiesIn = analyzeTies(a, findSeams(a));
  const tiesOut = analyzeTies(b, findSeams(b));

  const key = (t) => `${t.hand}:${t.measure}:${t.midi}`;
  const priorOrphans = new Set(tiesIn.unmatchedEnds.filter((t) => t.kind === "orphan").map(key));
  for (const t of tiesOut.unmatchedEnds) {
    if (t.kind !== "orphan") continue; // seam ends are legitimate
    if (priorOrphans.has(key(t))) continue; // already present in the input
    violation(v, 7, t.measure, `${t.hand} tie end with no start (midi ${t.midi}) — not at a seam`);
  }

  // Unclosed STARTS. analyzeTies now labels these `seam` / `orphan` too, but
  // the label is deliberately NOT consulted here: any unclosed start the input
  // did not already have is a violation, seam or not. A transform cannot
  // legitimately create one — §5.1 requires a tie chain to be removed whole or
  // not at all — so the stricter check stays until a transform needs otherwise.
  const priorStarts = new Set(tiesIn.unclosedStarts.map(key));
  for (const t of tiesOut.unclosedStarts) {
    if (priorStarts.has(key(t))) continue;
    violation(v, 7, t.measure, `${t.hand} tie start with no end (midi ${t.midi})`);
  }

  // 9 — no repeated pitch within one event, unless one copy is a tie
  // continuation. The app's import rejects any such event, so an output that
  // carries one cannot be imported. Checked ABSOLUTELY, not relative to the
  // input like invariant 7: a repeat the source already had still makes the
  // output unimportable, so the run must stop either way. The detail says
  // which case it is, because the fix differs — a transform bug, or a source
  // song that needs repairing (scripts/sam-repair-duplicates.js).
  b.forEach((mo, i) => {
    for (const hand of ["rh", "lh"]) {
      (mo?.[hand] || []).forEach((e, ei) => {
        for (const midi of duplicatePitches(e?.notes)) {
          const src = a[i]?.[hand]?.[ei];
          const inherited = duplicatePitches(src?.notes).includes(midi);
          violation(
            v, 9, num(mo, i),
            `${hand}[${ei}]: ${duplicatePitchMessage(e.notes, midi)}` +
              (inherited ? " Already present in the input — repair the source song." : "")
          );
        }
      });
    }
  });

  return v;
}

/** Human-readable violation report. */
export function formatViolations(violations, { limit = 20 } = {}) {
  if (violations.length === 0) return `all ${INVARIANTS.length} invariants hold`;
  const shown = violations.slice(0, limit);
  const lines = shown.map(
    (x) => `  • [${x.invariant}: ${x.name}]${x.measure != null ? ` m${x.measure}` : ""} — ${x.detail}`
  );
  if (violations.length > shown.length) {
    lines.push(`  • …and ${violations.length - shown.length} more`);
  }
  return `${violations.length} invariant violation(s):\n${lines.join("\n")}`;
}

export class InvariantError extends Error {
  constructor(violations) {
    super(formatViolations(violations));
    this.name = "InvariantError";
    this.violations = violations;
  }
}

/** Throws InvariantError when anything is violated. */
export function assertVerified(input, output) {
  const v = verify(input, output);
  if (v.length) throw new InvariantError(v);
  return true;
}
