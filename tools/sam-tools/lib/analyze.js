// Song difficulty analysis — pure, read-only.
//
// Reads an exported song document (docs/song-export-format.md) and produces a
// per-measure digest plus whole-song structure findings. No I/O, no database,
// no mutation of the input.
//
// Two rules this file exists to respect:
//
//   1. Beat position is IMPLIED, never stored. A voice event knows its
//      duration, not its onset; onsets come from walking the array and
//      accumulating. Every accumulation goes through durations.js so tuplets
//      scale correctly — `duration` is the DISPLAY token, and a triplet eighth
//      stored as "8" sounds for a third of a beat, not half.
//
//   2. Key comes from `fifths`, never from the `key` label. The label is
//      derived through a major-only table, so a piece in A minor reports
//      "C major". See the format spec §6.
//
// Deliberately NOT implemented: hand independence. The old spec called for it;
// it scored a known-easy piece at 75% and a known-hard one at 15% — backwards
// from how they actually play. Do not re-add it without a metric that survives
// that test.

import { measureBeats, sumEvents } from "./durations.js";

// A measure is flagged when it EXCEEDS any threshold. Single source so nothing
// drifts into a scattered literal.
//
// CALIBRATED (Phase 1.5) against four real pieces at the player's working
// tempos, not against a general notion of difficulty:
//
//   La Candeur @60, Arabesque @60, Pastorale @60 — each learned in about a
//   week. These define the comfortable band.
//   Someone Like You @67 — six months to get through 20 measures.
//
// The lines sit just above the hardest thing in the comfortable band, so a
// flag means "at or past the edge of what I can currently sight-learn", NOT
// "hard in general". Re-tune only against real pieces with a known learning
// cost; a threshold justified by theory rather than by a piece someone
// actually sat down and learned is worthless here.
//
// A SMALL NUMBER OF FLAGS ON THE EASY PIECES IS CORRECT. Zero flags would mean
// the line sits above everything the player has ever played, which makes the
// tool useless for pointing at individual measures. Do not tune toward zero.
//
// rhStretch is a deliberate BACKSTOP, not a working rule — rhStack is what
// discriminates. On the calibration corpus the two fired on identical
// measures, i.e. they were one rule counted twice; rhStretch is now parked
// high enough to catch only a genuinely unreasonable reach.
export const THRESHOLDS = {
  notesPerSecond: 5,
  lhNotesPerBeat: 3,
  rhStack: 2,
  rhStretch: 9,
  rhythmVariety: 3,
};

// Short codes used in the flags column, paired with the metric they gate.
const FLAG_SPECS = [
  { code: "NS", metric: "notesPerSecond", limit: THRESHOLDS.notesPerSecond },
  { code: "LH", metric: "lhNotesPerBeat", limit: THRESHOLDS.lhNotesPerBeat },
  { code: "STK", metric: "rhStack", limit: THRESHOLDS.rhStack },
  { code: "STR", metric: "rhStretch", limit: THRESHOLDS.rhStretch },
  { code: "VAR", metric: "rhythmVariety", limit: THRESHOLDS.rhythmVariety },
];

const isRest = (e) => !e || !Array.isArray(e.notes) || e.notes.length === 0;
const midis = (e) => e.notes.map((n) => n.midi);
const topOf = (e) => Math.max(...midis(e));
const bottomOf = (e) => Math.min(...midis(e));

/** Sounded beats for one event — tuplet-scaled. Never reads `duration` raw. */
const eventBeats = (e) => sumEvents([e]) ?? 0;

/**
 * Walk one hand, accumulating onsets. Returns every sounding event with the
 * beat it starts on, plus the rests skipped along the way.
 */
function withOnsets(events) {
  const out = [];
  let beat = 0;
  (events || []).forEach((e, index) => {
    out.push({ event: e, index, onset: beat, rest: isRest(e) });
    beat += eventBeats(e);
  });
  return out;
}

/** Diatonic pitch classes for a key signature, or null when unknown. */
export function scalePitchClasses(fifths) {
  if (!Number.isInteger(fifths)) return null;
  // A key and its relative minor share a collection, so the (unreliable) mode
  // is irrelevant — derive from the major tonic and be done.
  const tonic = (((7 * fifths) % 12) + 12) % 12;
  return new Set([0, 2, 4, 5, 7, 9, 11].map((i) => (tonic + i) % 12));
}

function handMetrics(events, hand) {
  const walked = withOnsets(events).filter((w) => !w.rest);
  let stack = 0;
  let stretch = 0;
  let jump = 0;
  let prev = null;

  for (const { event } of walked) {
    stack = Math.max(stack, event.notes.length);
    stretch = Math.max(stretch, topOf(event) - bottomOf(event));
    // Melodic motion is tracked on the voice a listener follows: the top of
    // the RH, the bottom of the LH. Rests do not break the chain.
    const line = hand === "rh" ? topOf(event) : bottomOf(event);
    if (prev !== null) jump = Math.max(jump, Math.abs(line - prev));
    prev = line;
  }

  return { onsets: walked.length, stack, stretch, jump };
}

// --- per-measure facts, and the tempo derivation on top of them ------------
//
// A measure's difficulty splits in two. Almost everything — onsets, stack,
// stretch, jump, rhythm variety, accidentals, beats — is a pure function of
// the notes. Exactly one metric, notesPerSecond, depends on tempo (and the NS
// flag with it).
//
// measureFacts returns the first kind, and it stores COUNTS. The stored
// column is meant to be the tempo-independent fact; rhNotesPerBeat is that
// fact already divided by beats, and multiplying back is a floating-point
// round trip on a value that should never have been divided. Store the count,
// derive the rate.
//
// It takes NO tempo, on purpose. Requiring a bpm to compute tempo-free facts
// invites a caller to pass default_bpm "because it needs something" — exactly
// the trap the tempo rule exists to prevent (explicit argument ->
// goal_effective_bpm -> error; never goal_bpm, never default_bpm). If the
// output does not depend on tempo, the input must not demand one.
//
// measureAtTempo derives the tempo-dependent view from those facts. It is the
// only place that happens, so analyzeSong and any reader of stored facts
// compute notesPerSecond and flags identically.

/** Tempo-independent facts for one measure. `scale` from scalePitchClasses. */
export function measureFacts(measure, index, scale) {
  const beats = measureBeats(measure.timeSignature) ?? 0;

  const rh = handMetrics(measure.rh, "rh");
  const lh = handMetrics(measure.lh, "lh");

  // Distinct duration tokens PER HAND, reported as the max of the two.
  //
  // Pooling both hands was wrong. Quantizing an LH of sixteen 16ths down to
  // four quarters genuinely reduces rhythmic complexity, but the pooled count
  // RISES if `q` is a token that bar did not already contain — so the metric
  // punished the transform for simplifying. What a player actually deals with
  // is the vocabulary in one hand at a time: four LH quarters against eight RH
  // eighths is two values per hand, not two pooled.
  const varietyOf = (events) => {
    const t = new Set();
    for (const e of events || []) if (e?.duration) t.add(e.duration);
    return t.size;
  };

  // Accidentals: note occurrences outside the key, not distinct classes — six
  // chromatic notes are harder than one repeated six times.
  let accidentals = null;
  if (scale) {
    accidentals = 0;
    for (const e of [...(measure.rh || []), ...(measure.lh || [])]) {
      if (isRest(e)) continue;
      for (const n of e.notes) {
        if (!scale.has(((n.midi % 12) + 12) % 12)) accidentals++;
      }
    }
  }

  return {
    number: measure.number ?? index + 1,
    sourceMeasure: measure.sourceMeasure ?? null,
    beats,
    rhOnsets: rh.onsets,
    lhOnsets: lh.onsets,
    rhStack: rh.stack,
    lhStack: lh.stack,
    rhStretch: rh.stretch,
    lhStretch: lh.stretch,
    rhJump: rh.jump,
    lhJump: lh.jump,
    rhythmVariety: Math.max(varietyOf(measure.rh), varietyOf(measure.lh)),
    accidentals,
  };
}

/**
 * One measure's facts viewed at `bpm` quarter notes per minute: the facts,
 * plus seconds, notesPerSecond, the per-beat rates, and the flags. The caller
 * resolves `bpm`; this never chooses one.
 */
export function measureAtTempo(facts, bpm) {
  if (!(bpm > 0)) throw new Error("A positive --bpm is required.");
  const { beats, rhOnsets, lhOnsets } = facts;
  const seconds = beats > 0 ? (beats * 60) / bpm : 0;
  const m = {
    ...facts,
    seconds,
    notesPerSecond: seconds > 0 ? (rhOnsets + lhOnsets) / seconds : 0,
    rhNotesPerBeat: beats > 0 ? rhOnsets / beats : 0,
    lhNotesPerBeat: beats > 0 ? lhOnsets / beats : 0,
  };
  m.flags = FLAG_SPECS.filter((f) => m[f.metric] > f.limit).map((f) => f.code);
  return m;
}

// --- whole-song structure -------------------------------------------------

/**
 * Printed-number discontinuity marks a seam. Playback order is flattened, so a
 * repeat is written out; when `sourceMeasure` jumps, the score went somewhere
 * else (repeat, volta, D.S., coda). Returns a Set of measure indices that START
 * a seam. Empty when the document carries no printed numbers to compare.
 */
export function findSeams(measures) {
  const seams = new Set();
  const num = (m) => {
    const raw = m?.sourceMeasure;
    if (raw == null) return null;
    const parsed = parseInt(String(raw), 10);
    return Number.isNaN(parsed) ? null : parsed;
  };
  for (let i = 1; i < measures.length; i++) {
    const prev = num(measures[i - 1]);
    const cur = num(measures[i]);
    if (prev == null || cur == null) continue;
    if (cur !== prev + 1) seams.add(i);
  }
  return seams;
}

/**
 * Tie chains per hand. A chain opens on `start`/`both` and closes on
 * `end`/`both`, matched by pitch within the same hand.
 *
 * An unmatched END is not automatically corruption: at a seam the note it
 * continued from lives in a measure the flattening skipped. Those are labelled
 * `seam`; the rest are `orphan`.
 *
 * KEYING — READ THIS BEFORE CHASING A "CORRUPT" TIE. A note carries only its
 * pitch and a tie marker; there is no voice or chain id to say which start an
 * end belongs to. So chains are matched by (hand, midi), and that key is NOT
 * unique: two voices in unison hold two chains on the same pitch at once
 * (Say It Ain't So rh m70, F4 in both voices). Two rules make that come out
 * right, and both are required:
 *
 *   1. Each (hand, midi) holds a STACK of open chains, not one slot. An end
 *      closes the most recent; whatever is left when the song ends is
 *      reported, every entry of it. With a single slot, a start on an
 *      already-open pitch silently replaced the older chain, so unclosed
 *      starts were under-reported (The Entertainer's printed m35 -> X2 volta
 *      chains vanished this way).
 *   2. Within one event, every END is processed before any START. An event
 *      can close one voice's chain and open the other's on the same pitch —
 *      m70 event 1 is [F4 start, F4 end]. Taken in array order, the start
 *      clobbered the chain the end was about to close, and the next event's
 *      `both` was reported as a false orphan.
 *
 * Matching by pitch is still a heuristic: with two chains open on one pitch,
 * LIFO may pair an end with the other voice's start. The counts are right
 * either way; `crossings` endpoints can be swapped between the two voices.
 * A report on a unison passage is therefore an analyzer limitation to rule
 * out before it is treated as data corruption.
 */
export function analyzeTies(measures, seams) {
  const crossings = [];
  const unmatchedEnds = [];
  const unclosedStarts = [];
  const numberOf = (mi) => measures[mi].number ?? mi + 1;

  for (const hand of ["rh", "lh"]) {
    const open = new Map(); // midi -> stack of {measureIndex, eventIndex}, newest last
    const unclosedForHand = [];

    measures.forEach((measure, mi) => {
      (measure[hand] || []).forEach((e, ei) => {
        if (isRest(e)) return;

        // Rule 2, first half: close.
        for (const n of e.notes) {
          if (n.tie !== "end" && n.tie !== "both") continue;
          const started = open.get(n.midi)?.pop();
          if (started === undefined) {
            unmatchedEnds.push({
              hand, measure: numberOf(mi), eventIndex: ei,
              midi: n.midi, kind: seams.has(mi) ? "seam" : "orphan",
            });
          } else if (started.measureIndex !== mi) {
            crossings.push({
              hand, midi: n.midi,
              from: numberOf(started.measureIndex),
              to: numberOf(mi),
            });
          }
        }

        // Rule 2, second half: open.
        for (const n of e.notes) {
          if (n.tie !== "start" && n.tie !== "both") continue;
          if (!open.has(n.midi)) open.set(n.midi, []);
          open.get(n.midi).push({ measureIndex: mi, eventIndex: ei });
        }
      });
    });

    // Rule 1: every chain still open is reported, not just the newest.
    for (const [midi, stack] of open) {
      for (const started of stack) {
        unclosedForHand.push({
          hand, midi,
          measure: numberOf(started.measureIndex),
          eventIndex: started.eventIndex,
          _order: started.measureIndex,
        });
      }
    }
    unclosedForHand
      .sort((x, y) => x._order - y._order || x.eventIndex - y.eventIndex || x.midi - y.midi)
      .forEach(({ _order, ...t }) => unclosedStarts.push(t));
  }
  return { crossings, unmatchedEnds, unclosedStarts };
}

/** Runs of consecutive tuplet events within one hand of one measure. */
function analyzeTuplets(measures) {
  const groups = [];
  measures.forEach((measure, mi) => {
    for (const hand of ["rh", "lh"]) {
      const walked = withOnsets(measure[hand]);
      let run = null;
      for (const w of walked) {
        const t = w.event?.tuplet;
        if (t) {
          if (!run) {
            run = {
              hand, measure: measure.number ?? mi + 1, startBeat: w.onset,
              actual: t.actual, normal: t.normal, length: 0,
            };
          }
          run.length++;
        } else if (run) {
          groups.push(run);
          run = null;
        }
      }
      if (run) groups.push(run);
    }
  });
  return groups;
}

/**
 * Melody blips — voice-merge artefacts. The RH top note is normally the tune;
 * where a merged inner voice briefly sits above it, the top line dips sharply
 * and returns. Flag them so a simplifier can avoid treating the dip as melody.
 * Detection only; never repaired.
 */
const BLIP_DROP_SEMITONES = 5;

export function analyzeMelodyBlips(measures) {
  // One continuous RH stream — a blip can straddle a barline.
  const stream = [];
  measures.forEach((measure, mi) => {
    (measure.rh || []).forEach((e, ei) => {
      if (isRest(e)) return;
      stream.push({ top: topOf(e), measure: measure.number ?? mi + 1, eventIndex: ei });
    });
  });

  const blips = [];
  for (let i = 1; i < stream.length - 1; i++) {
    const drop = Math.min(stream[i - 1].top, stream[i + 1].top) - stream[i].top;
    if (drop >= BLIP_DROP_SEMITONES) {
      blips.push({
        measure: stream[i].measure, eventIndex: stream[i].eventIndex,
        top: stream[i].top, drop,
      });
    }
  }
  return blips;
}

// --- summary --------------------------------------------------------------

/** Linear-interpolated quantile over an unsorted numeric array. */
export function quantile(values, p) {
  const v = values.filter((x) => typeof x === "number" && !Number.isNaN(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  if (v.length === 1) return v[0];
  const pos = (v.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export const SUMMARY_METRICS = [
  ["notes/sec", "notesPerSecond"],
  ["LH notes/beat", "lhNotesPerBeat"],
  ["RH notes/beat", "rhNotesPerBeat"],
  ["RH stack", "rhStack"],
  ["LH stack", "lhStack"],
  ["RH stretch", "rhStretch"],
  ["LH stretch", "lhStretch"],
  ["RH jump", "rhJump"],
  ["LH jump", "lhJump"],
  ["rhythm variety", "rhythmVariety"],
  ["accidentals", "accidentals"],
];

/**
 * Everything the analyzer knows about a song that does NOT depend on tempo:
 * per-measure facts plus the whole-song structure (seams, ties, tuplets,
 * melody blips). Takes no bpm — see the note above measureFacts.
 *
 * @param {object} doc - parsed export document
 */
export function analyzeSongFacts(doc) {
  if (!doc || !Array.isArray(doc.measures)) {
    throw new Error("Not a SAM export document: no `measures` array.");
  }

  const scale = scalePitchClasses(doc.fifths);
  const seams = findSeams(doc.measures);

  return {
    title: doc.title ?? "(untitled)",
    artist: doc.artist ?? null,
    key: doc.key ?? null,
    fifths: Number.isInteger(doc.fifths) ? doc.fifths : null,
    measureCount: doc.measures.length,
    measures: doc.measures.map((m, i) => measureFacts(m, i, scale)),
    seams: [...seams].map((i) => doc.measures[i]?.number ?? i + 1),
    ties: analyzeTies(doc.measures, seams),
    tuplets: analyzeTuplets(doc.measures),
    blips: analyzeMelodyBlips(doc.measures),
  };
}

/**
 * The full digest at one tempo: the facts, each measure viewed at `bpm`, a
 * summary, and the flagged measures.
 *
 * @param {object} doc - parsed export document
 * @param {{bpm: number}} opts - target tempo in quarter notes per minute,
 *   already resolved by the caller
 */
export function analyzeSong(doc, { bpm }) {
  if (!doc || !Array.isArray(doc.measures)) {
    throw new Error("Not a SAM export document: no `measures` array.");
  }
  if (!(bpm > 0)) throw new Error("A positive --bpm is required.");

  const facts = analyzeSongFacts(doc);
  const measures = facts.measures.map((f) => measureAtTempo(f, bpm));

  const summary = {};
  for (const [, key] of SUMMARY_METRICS) {
    const values = measures.map((m) => m[key]).filter((x) => x != null);
    summary[key] = {
      median: quantile(values, 0.5),
      p90: quantile(values, 0.9),
      max: values.length ? Math.max(...values) : null,
    };
  }

  return {
    title: facts.title,
    artist: facts.artist,
    key: facts.key,
    fifths: facts.fifths,
    bpm,
    measureCount: facts.measureCount,
    measures,
    summary,
    flagged: measures.filter((m) => m.flags.length > 0).map((m) => m.number),
    seams: facts.seams,
    ties: facts.ties,
    tuplets: facts.tuplets,
    blips: facts.blips,
  };
}
