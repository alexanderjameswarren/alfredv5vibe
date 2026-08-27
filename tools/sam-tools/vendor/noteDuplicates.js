// Duplicate-pitch rule for a single notation event — the shared predicate.
//
// One event's notes[] is a set of pitches sounding together. Two entries for
// the same `midi` are the same sounding pitch, and storing both smears the
// notehead in VexFlow and shifts the note_index that fingerings, lyric
// placement and the simplification pipeline address notes by.
//
// EXCEPT when one entry is a CONTINUATION — tie "end" or "both", the tail of a
// note struck earlier. Then one voice is holding the pitch while another
// strikes it fresh: two distinct sounding events that legitimately share an
// onset. Real in the corpus (Moonlight m60 C#4 + C#4:end, Someone Like You m27
// F#4 + F#4:end) and noteTimeline.js's resolveTieChain depends on both copies
// being present. Collapsing them changes what is heard.
//
// So the rule everything here is built on:
//
//     a pitch is duplicated iff it has more than one FRESH (non-continuation)
//     entry in the same event.
//
// M1 uses it to merge at parse time; M2 uses it to reject at every write path.
// Both go through `duplicatePitches` so the fixer and the checker cannot
// disagree about what counts as a duplicate.
//
// Deliberately dependency-free and DOM-free: this module is imported by the
// parser, by the app's validators, and (as a hand-kept port, see
// supabase/functions/_shared/noteDuplicates.ts) by the Edge Function.

/** The tail of a note struck earlier — a hold, not a strike. */
export function isContinuation(note) {
  return note?.tie === "end" || note?.tie === "both";
}

/**
 * MIDI values that appear more than once as a fresh strike in this event, in
 * order of first appearance. Empty array means the event is clean.
 *
 * This is THE predicate. Everything else in this module and every caller in
 * the three write paths is phrased in terms of it.
 */
export function duplicatePitches(notes) {
  if (!Array.isArray(notes) || notes.length < 2) return [];

  const freshPerMidi = new Map();
  for (const n of notes) {
    if (!n || typeof n.midi !== "number") continue;
    if (isContinuation(n)) continue;
    freshPerMidi.set(n.midi, (freshPerMidi.get(n.midi) || 0) + 1);
  }

  const out = [];
  for (const [midi, count] of freshPerMidi) {
    if (count > 1) out.push(midi);
  }
  return out;
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

// Fold `src` into `target` in place. A property present on one entry and absent
// on the other is carried across; the same property with two different values
// is a genuine conflict — keep the first, report it, continue. Never throws: an
// import that hits a conflict is still worth having.
function unionNoteInto(target, src, warn) {
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v === undefined) continue;
    if (target[k] === undefined) {
      target[k] = v;
      continue;
    }
    if (sameValue(target[k], v)) continue;
    if (!warn) continue;
    // `midi` is the merge key and can never land here. `name` gets its own
    // wording because the expected cause is a real enharmonic disagreement
    // (A#4 vs Bb4), not a parser bug.
    if (k === "name") {
      warn(
        `midi ${target.midi}: duplicate entries disagree on spelling ` +
        `("${target[k]}" vs "${v}") — kept "${target[k]}"`
      );
    } else {
      warn(
        `midi ${target.midi} (${target.name}): duplicate entries disagree on ` +
        `"${k}" (${JSON.stringify(target[k])} vs ${JSON.stringify(v)}) — ` +
        `kept ${JSON.stringify(target[k])}`
      );
    }
  }
}

/**
 * Collapse duplicate pitches in one event's notes array (the M1 parse-time
 * fix). Keyed on `midi` alone — whole-object comparison would miss the
 * reference case, where two F4 entries differ by a tie. Continuations are
 * never merged and never merged into.
 *
 * `warn` is optional and receives a single formatted message. Only conflicts
 * are reported; a clean merge is the fix working, and reporting every one
 * would flood the import gate on a piece like the Moonlight Sonata.
 *
 * Returns the original array (same reference) when nothing merged, so callers
 * and tests can tell "left alone" from "rewritten".
 *
 * Because a merged pair can never contain "end" or "both", the union of their
 * tie values is always "start" or absent. There is deliberately no "both"
 * branch — it is unreachable on this path.
 */
export function mergeDuplicatePitches(notes, warn) {
  if (!notes || notes.length < 2) return notes || [];

  const duplicated = new Set(duplicatePitches(notes));
  if (duplicated.size === 0) return notes;

  const out = [];
  const foldedAt = new Map();
  for (const n of notes) {
    if (!duplicated.has(n.midi) || isContinuation(n)) {
      out.push(n);
      continue;
    }
    const at = foldedAt.get(n.midi);
    if (at === undefined) {
      foldedAt.set(n.midi, out.length);
      out.push({ ...n });
      continue;
    }
    unionNoteInto(out[at], n, warn);
  }
  return out;
}

/**
 * The sentence, worded identically wherever the rule is enforced. The three
 * write paths address events differently, but what they say about them is
 * shared.
 */
export function duplicatePitchMessage(notes, midi) {
  const named = (notes || []).find((n) => n && n.midi === midi && n.name);
  const label = named ? `${named.name} (midi ${midi})` : `midi ${midi}`;
  return (
    `duplicate pitch ${label} — two notes in one event must not share a ` +
    `pitch unless one is a tie continuation.`
  );
}

/** The sentence, prefixed with whatever the caller uses to name the event. */
export function formatDuplicatePitchError(location, notes, midi) {
  return `${location}: ${duplicatePitchMessage(notes, midi)}`;
}

/** Error lines for one event, or [] when it is clean. */
export function duplicatePitchErrors(notes, location) {
  return duplicatePitches(notes).map((midi) =>
    formatDuplicatePitchError(location, notes, midi)
  );
}

/**
 * Scan a whole measures[] array. Used by the paths that do not already walk
 * every event themselves. `measure ${n}` numbering matches the wording the
 * app's other validators use (1-based position, not `m.number`, so the message
 * points at the document the human is looking at).
 */
export function scanMeasuresForDuplicatePitches(measures) {
  const errors = [];
  const list = Array.isArray(measures) ? measures : [];
  for (let mi = 0; mi < list.length; mi++) {
    for (const hand of ["rh", "lh"]) {
      const events = list[mi]?.[hand] || [];
      for (let ei = 0; ei < events.length; ei++) {
        errors.push(
          ...duplicatePitchErrors(events[ei]?.notes, `measure ${mi + 1} ${hand}[${ei}]`)
        );
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Schema layer.
//
// JSON Schema draft-07 cannot express "no two items of this array share a
// property value" — there is no way to compare sibling items, and `uniqueItems`
// does not help because the two entries are genuinely different objects (in the
// reference case they differ by a tie). So the rule rides in the schema
// document as a custom Ajv keyword instead of a plain constraint.
//
// This is the SECOND layer. The primary guarantee is the explicit predicate
// call in each of the three write paths; the keyword is what makes any other
// Ajv-based validation of a SAM document reject a duplicate too. A validator
// that does not know the keyword ignores it (both current Ajv instances run
// `strict: false`), so the schema still degrades safely rather than erroring
// on an unrecognised word.
// ---------------------------------------------------------------------------

export const DUPLICATE_PITCH_KEYWORD = "noDuplicatePitches";

/** Teach an Ajv instance the keyword. Call before compiling the schema. */
export function registerDuplicatePitchKeyword(ajv) {
  ajv.addKeyword({
    keyword: DUPLICATE_PITCH_KEYWORD,
    type: "array",
    schemaType: "boolean",
    errors: true,
    validate: function check(schemaValue, data) {
      if (schemaValue !== true) return true;
      const dupes = duplicatePitches(data);
      if (dupes.length === 0) return true;
      check.errors = dupes.map((midi) => ({
        keyword: DUPLICATE_PITCH_KEYWORD,
        message: duplicatePitchMessage(data, midi),
        params: {},   // the midi is already named in the message
      }));
      return false;
    },
  });
}
