// SAM song / drill document validator.
//
// Two layers of checking:
//   1. Structural — Ajv over `sam-drill-format.schema.json` at the repo root.
//      Enforces required fields, type constraints, enum values, the duration
//      regex, the `beats[]` rejection, the inline-`lyric` rejection.
//   2. Semantic — three things the schema cannot express declaratively:
//        (a) `midi` and `name` on a Note must agree
//        (b) durations in a measure must sum to `(beats/beatType)*4` beats
//            (skipped when the measure contains a tuplet, per spec §4)
//        (c) no two notes in one event may share a `midi` unless one is a tie
//            continuation (M2 — see noteDuplicates.js for the rule). Draft-07
//            cannot compare sibling array items, so the schema carries this as
//            a custom Ajv keyword registered below rather than as a plain
//            constraint.
//
// ERRORS vs WARNINGS. Structural failures and midi/name disagreement are
// ERRORS: they describe a document that cannot be stored, or whose notes mean
// two different things at once. A duration-sum mismatch is a WARNING — the
// measure is storable and playable, it just does not fill its bar.
//
// That split exists because a hard reject made "export a song, re-import it"
// impossible for any song the parser had already mangled. OLD Someone Like You
// has 15 measures whose hands run 4.25–7 beats long in 4/4; the export
// reproduces them faithfully, and refusing the import meant the round trip
// could never be verified on the one row that carries real lyrics and audio
// offsets. Callers surface warnings through the M8 import gate instead, which
// already exists for exactly this class of "playback will differ from the
// score, approve before committing" finding.
//
// Note: the MCP `append_sam_measures` tool keeps its own strict duration check
// (supabase/functions/_shared/tools/sam-authoring.ts). Authored measures
// arriving over the wire SHOULD be well-formed; this relaxation is about
// re-admitting documents the app itself produced.
//
// The schema JSON is the single source of truth for structure — the Edge
// Function will load the same file for `append_sam_measures` in Step 4.
// Duplicating the shape as JS constants is prohibited.

import Ajv from "ajv";
// Master schema lives at the repo root; scripts/prebuild.js copies it here
// on every build/start so CRA (which blocks imports outside src/) can pick
// it up. Regenerated file — do not edit this copy.
import schema from "./sam-drill-format.schema.json";
import { tokenToBeats } from "./durations";
// M2 — the duplicate-pitch rule. Same predicate the parser merges with, so
// the fixer and the checker cannot disagree about what counts as a duplicate.
import { duplicatePitchErrors, registerDuplicatePitchKeyword } from "./noteDuplicates";

// `verbose: true` populates `error.schema` on each error object — required
// for `formatStructuralError` to detect and reword the `not: { required:
// [...] }` clauses (beats[] and lyric rejections). Without it Ajv ships a
// generic "must NOT be valid" that reveals nothing about which not-clause
// tripped.
const ajv = new Ajv({ allErrors: true, strict: false, verbose: true });
// M2 — the schema's `noDuplicatePitches` keyword. Must be taught to the
// instance before compile, or Ajv (strict:false) silently ignores it.
registerDuplicatePitchKeyword(ajv);
const validateStructure = ajv.compile(schema);

// ---------------------------------------------------------------------------
// Semantic helpers
// ---------------------------------------------------------------------------

const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACCIDENTAL_ALTER = { "": 0, "#": 1, "b": -1, "##": 2, "bb": -2 };

const NAME_RE = /^([A-G])(##|bb|#|b)?(-)?(\d)$/;
// DURATION_RE and BASE_BEATS removed 2026-08-06 (spec §M9). Duration
// parsing routes through durations.tokenToBeats so the vocabulary
// (including 64th notes) doesn't have to be re-declared here.

/**
 * Convert a name like "Bb4" / "F#3" / "C-1" to its canonical MIDI number.
 * Returns `null` if the name doesn't parse.
 */
function nameToMidi(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const step = STEP_SEMITONES[m[1]];
  const alter = ACCIDENTAL_ALTER[m[2] || ""];
  const octave = (m[3] ? -1 : 1) * parseInt(m[4], 10);
  return (octave + 1) * 12 + step + alter;
}

/**
 * Effective quarter-note beats for a voice event, accounting for augmentation
 * dots and (if present) a tuplet time-modification. Returns `null` if the
 * duration token doesn't parse.
 */
function eventBeats(evt) {
  const base = tokenToBeats(evt?.duration);
  if (base === null) return null;
  return evt.tuplet ? (base * evt.tuplet.normal) / evt.tuplet.actual : base;
}

/**
 * Format an Ajv error into a single readable line pinpointing the location
 * in the document. Ajv paths look like `/measures/2/rh/0/notes/1` — we keep
 * them as-is; they're unambiguous and copy-paste-search-friendly.
 */
function formatStructuralError(e) {
  const loc = e.instancePath || "/";
  // Reword the two intentional-not clauses so the message reads like an
  // explanation rather than a schema-internal complaint.
  if (e.keyword === "not" && e.schema && typeof e.schema === "object") {
    if (Array.isArray(e.schema.required) && e.schema.required.includes("beats")) {
      return `${loc}: measure must not include \`beats[]\` — use rh[]/lh[] instead (legacy format, unsupported).`;
    }
    if (Array.isArray(e.schema.required) && e.schema.required.includes("lyric")) {
      return `${loc}: voice event must not include \`lyric\` — authored documents cannot carry inline lyrics (they would vanish on recompile). Lyrics live in sam_song_lyrics.`;
    }
  }
  return `${loc}: ${e.message}${e.params && Object.keys(e.params).length ? ` (${JSON.stringify(e.params)})` : ""}`;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Validate a SAM song / drill document.
 * @param {unknown} doc - Parsed JSON document (top level {title, measures, ...}).
 * @returns {{valid: boolean, errors: string[], warnings: object[]}} —
 *   `errors` are human-readable strings and block the import; order is
 *   structural first, then semantic. Callers typically show only the first few
 *   (SongLoader shows 5). `warnings` are machine-readable duration-sum
 *   findings, `[]` when the document fills every bar:
 *     { kind: "overflow"|"truncated", measureIndex, measureNumber, hand,
 *       beats, expected, message }
 *   `valid` reflects errors only — a document can be valid AND carry warnings.
 */
export function validateSongDocument(doc) {
  const errors = [];
  const warnings = [];

  // Layer 1 — structure
  const ok = validateStructure(doc);
  if (!ok) {
    for (const e of validateStructure.errors || []) {
      errors.push(formatStructuralError(e));
    }
    // If structural checks failed, semantic checks may throw on malformed
    // inputs — bail early with the structural errors, which are actionable
    // and usually the root cause.
    return { valid: false, errors, warnings };
  }

  // Layer 2 — semantics
  const measures = doc.measures || [];
  for (let mi = 0; mi < measures.length; mi++) {
    const m = measures[mi];

    // A tuplet in EITHER hand exempts BOTH hands from the duration-sum
    // check on this measure — under-checking is safer than false-positives
    // under fractional-beat tuplet arithmetic. Spec §4 exempts tuplet
    // measures explicitly.
    const measureHasTuplet = ["rh", "lh"].some((h) =>
      (m[h] || []).some((e) => e.tuplet)
    );

    for (const hand of ["rh", "lh"]) {
      const events = m[hand] || [];
      let handBeats = 0;

      for (let ei = 0; ei < events.length; ei++) {
        const evt = events[ei];

        // 2a — midi/name agreement per note
        for (let ni = 0; ni < (evt.notes || []).length; ni++) {
          const note = evt.notes[ni];
          const expected = nameToMidi(note.name);
          if (expected == null) {
            // NAME_RE mismatch — the schema regex should have caught it, but
            // keep the guard so this path never crashes on malformed data.
            errors.push(
              `measure ${mi + 1} ${hand}[${ei}].notes[${ni}]: unparseable name "${note.name}"`
            );
          } else if (expected !== note.midi) {
            errors.push(
              `measure ${mi + 1} ${hand}[${ei}].notes[${ni}]: midi=${note.midi} does not agree with name="${note.name}" (expected midi=${expected}).`
            );
          }
        }

        // 2c — no two notes in one event may share a pitch (M2). An ERROR,
        // not a warning: unlike a short bar, this document cannot be rendered
        // or indexed correctly, and there is nothing for a human to weigh up
        // at the M8 gate. Continuations are exempt — see noteDuplicates.js.
        errors.push(
          ...duplicatePitchErrors(evt.notes, `measure ${mi + 1} ${hand}[${ei}]`)
        );

        // Accumulate beats for the per-hand sum below.
        const b = eventBeats(evt);
        if (b != null) handBeats += b;
      }

      // 2b — duration sum per hand per measure. A WARNING, not an error: the
      // measure stores and plays, it just doesn't fill its bar. See the header
      // note for why this stopped being a hard reject.
      if (!measureHasTuplet) {
        const ts = m.timeSignature;
        const expected = (ts.beats / ts.beatType) * 4;
        // 0.001 tolerance absorbs any legit floating-point drift from
        // dotted-note math (q + qd = 1 + 0.5 = 1.5, exact in IEEE 754).
        if (Math.abs(handBeats - expected) > 0.001) {
          warnings.push({
            kind: handBeats > expected ? "overflow" : "truncated",
            measureIndex: mi,
            measureNumber: m.number ?? mi + 1,
            hand,
            beats: handBeats,
            expected,
            message:
              `measure ${mi + 1} ${hand}: durations sum to ${handBeats} beats but time signature ${ts.beats}/${ts.beatType} expects ${expected} beats.`,
          });
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
