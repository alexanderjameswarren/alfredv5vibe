// LH grid quantization (spec §4.1–4.3).
//
// Grid quantization, NOT event merging. The duration vocabulary is not closed
// under addition — merging a 16th and an 8th gives a value with no token — so
// instead the hand's span is divided into cells and one event is emitted per
// cell. Cells always sum correctly by construction.
//
// All duration math goes through durations.js. Beat position is implied, never
// stored: onsets come from walking the array and accumulating tuplet-scaled
// durations.

import {
  measureBeats, sumEvents, beatsToToken, beatsToTokens,
} from "./durations.js";

const EPS = 1e-9;

/** Cell size in quarter-note beats. `none` means do nothing. */
export const GRID_BEATS = Object.freeze({
  none: null, whole: 4, half: 2, quarter: 1, eighth: 0.5,
});

const isRest = (e) => !e || !Array.isArray(e.notes) || e.notes.length === 0;

/** Sounded beats for one event — tuplet-scaled via durations.js. */
const eventBeats = (e) => sumEvents([e]) ?? 0;

/** Walk a hand, accumulating onsets. */
function withOnsets(events) {
  let beat = 0;
  return (events || []).map((event, index) => {
    const dur = eventBeats(event);
    const w = { event, index, onset: beat, dur, rest: isRest(event) };
    beat += dur;
    return w;
  });
}

/** Runs of consecutive tuplet events, as spans in beats. */
function tupletSpans(walked) {
  const spans = [];
  let run = null;
  for (const w of walked) {
    if (w.event?.tuplet) {
      if (!run) run = { start: w.onset, end: w.onset + w.dur, from: w.index, to: w.index };
      else { run.end = w.onset + w.dur; run.to = w.index; }
    } else if (run) {
      spans.push(run);
      run = null;
    }
  }
  if (run) spans.push(run);
  return spans;
}

/**
 * `onset` fill — the pitches sounding at the START of the cell.
 *
 * Spec §4.2's fallback ("if nothing sounds at the cell start, use the nearest
 * preceding onset that is still sounding; if none, emit a rest") falls out of
 * a single rule: take the latest non-rest event that CONTAINS the cell start.
 * An event beginning exactly there wins because its onset is largest; a cell
 * landing mid-note picks up the note holding through it; a cell landing inside
 * a rest finds nothing, because a rest is not a sounding event.
 */
function fillOnset(walked, cellStart) {
  let best = null;
  for (const w of walked) {
    if (w.rest) continue;
    if (w.onset <= cellStart + EPS && cellStart < w.onset + w.dur - EPS) {
      if (!best || w.onset > best.onset) best = w;
    }
  }
  return best ? best.event.notes : [];
}

/** `union` fill — every distinct pitch sounding anywhere in the cell. */
function fillUnion(walked, cellStart, cellEnd) {
  const byMidi = new Map();
  for (const w of walked) {
    if (w.rest) continue;
    const overlaps = w.onset < cellEnd - EPS && w.onset + w.dur > cellStart + EPS;
    if (!overlaps) continue;
    for (const n of w.event.notes) if (!byMidi.has(n.midi)) byMidi.set(n.midi, n);
  }
  return [...byMidi.values()];
}

/**
 * Drop notes until the event fits `cap` (spec §4.3).
 *
 * `root-third` keeps the lowest `cap` notes. `root-fifth` keeps the lowest and
 * the highest, then fills inward from the bottom — at cap 2 that is the outer
 * pair, which is the case the setting exists for.
 */
export function applyCap(notes, cap, keep) {
  const sorted = [...notes].sort((a, b) => a.midi - b.midi);
  if (sorted.length <= cap) return sorted;
  if (keep === "root-fifth") {
    const picked = [sorted[0], sorted[sorted.length - 1]];
    for (let i = 1; picked.length < cap && i < sorted.length - 1; i++) picked.push(sorted[i]);
    return picked.sort((a, b) => a.midi - b.midi);
  }
  return sorted.slice(0, cap);
}

/**
 * Quantize one hand of one measure.
 *
 * @returns {{events: object[], changed: boolean, reason: ?string, kind: ?string}}
 *   `changed: false` means the hand is returned untouched. `kind` says which
 *   sort of refusal it was (spec §7):
 *     "unable"   — the transform could not run; the measure stays too hard
 *     "unneeded" — a guard declined because the measure did not need it
 *   Only "unable" gates the confirmation threshold.
 */
export function quantizeHand(events, settings, timeSignature) {
  const cell = GRID_BEATS[settings.lhGrid];
  if (cell == null) return { events, changed: false, reason: null, kind: null };

  const walked = withOnsets(events);

  // The hand's own extent, NOT the time signature's. Someone Like You has
  // measures whose LH runs 7 beats in a 4/4 bar (old-parser damage). Gridding
  // to the signature would silently rewrite the sum and trip invariant 4;
  // gridding to what is actually there preserves it and still quantizes.
  const span = sumEvents(events);
  if (span == null) {
    return {
      events, changed: false, kind: "unable",
      reason: "unparseable duration token in LH",
    };
  }
  if (span <= EPS) return { events, changed: false, reason: null, kind: null };

  const nominal = measureBeats(timeSignature);
  const overrun = nominal != null && Math.abs(span - nominal) > EPS;

  // Grid boundaries, then the tuplet guard: a group with a boundary strictly
  // inside it is left alone and gridded around (§4.1). Its span becomes a
  // protected region and the cuts snap to its edges.
  const boundaries = [];
  for (let b = cell; b < span - EPS; b += cell) boundaries.push(b);

  const protectedSpans = tupletSpans(walked).filter((s) =>
    boundaries.some((b) => b > s.start + EPS && b < s.end - EPS)
  );

  const cuts = new Set([0, span]);
  for (const b of boundaries) cuts.add(b);
  for (const s of protectedSpans) {
    if (s.start > EPS && s.start < span - EPS) cuts.add(s.start);
    if (s.end > EPS && s.end < span - EPS) cuts.add(s.end);
  }
  const points = [...cuts].sort((a, b) => a - b);

  const out = [];
  let skipUntil = -1;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a < skipUntil - EPS) continue;

    const inProtected = protectedSpans.find((s) => Math.abs(s.start - a) < EPS);
    if (inProtected) {
      // Verbatim, tuplet markers and all.
      for (const w of walked) {
        if (w.index >= inProtected.from && w.index <= inProtected.to) out.push(w.event);
      }
      skipUntil = inProtected.end;
      continue;
    }

    const len = b - a;
    if (len <= EPS) continue;

    const notes = settings.lhFill === "union"
      ? fillUnion(walked, a, b)
      : fillOnset(walked, a);
    const capped = applyCap(notes, settings.lhCap, settings.lhKeep);
    // Ties are dropped: cell fill discards the old events entirely, so a chain
    // cannot survive half-removed (spec §5.1).
    const payload = capped.map((n) => ({ midi: n.midi, name: n.name }));

    // One token where the cell is representable, which is the normal case; a
    // ragged final cell decomposes rather than being rounded away.
    const single = beatsToToken(len);
    const tokens = single ? [single] : beatsToTokens(len);
    if (!tokens) {
      return {
        events, changed: false, kind: "unable",
        reason: `cell of ${len} beats has no duration token`,
      };
    }
    for (const duration of tokens) out.push({ duration, notes: payload.map((n) => ({ ...n })) });
  }

  // DENSITY FLOOR (§4.1, non-negotiable). The grid may only ever REDUCE the
  // event count. A sustained whole-note bar must not become four repeated
  // quarter chords — which is also what makes `lhGrid: quarter` safe as a
  // global default rather than something that has to be scoped by hand.
  if (out.length >= events.length) {
    return {
      events, changed: false, kind: "unneeded",
      reason: "density floor: grid would not reduce LH event count",
    };
  }

  return {
    events: out,
    changed: true,
    reason: null,
    kind: null,
    ...(overrun ? { note: `LH spans ${span} beats against a ${nominal}-beat signature; gridded to the span` } : {}),
  };
}
