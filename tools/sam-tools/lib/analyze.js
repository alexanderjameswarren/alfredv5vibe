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

function analyzeMeasure(measure, index, { bpm, scale }) {
  const beats = measureBeats(measure.timeSignature) ?? 0;
  const seconds = beats > 0 ? (beats * 60) / bpm : 0;

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

  const m = {
    number: measure.number ?? index + 1,
    sourceMeasure: measure.sourceMeasure ?? null,
    beats,
    seconds,
    notesPerSecond: seconds > 0 ? (rh.onsets + lh.onsets) / seconds : 0,
    rhNotesPerBeat: beats > 0 ? rh.onsets / beats : 0,
    lhNotesPerBeat: beats > 0 ? lh.onsets / beats : 0,
    rhStack: rh.stack,
    lhStack: lh.stack,
    rhStretch: rh.stretch,
    lhStretch: lh.stretch,
    rhJump: rh.jump,
    lhJump: lh.jump,
    rhythmVariety: Math.max(varietyOf(measure.rh), varietyOf(measure.lh)),
    accidentals,
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
 */
export function analyzeTies(measures, seams) {
  const crossings = [];
  const unmatchedEnds = [];
  const unclosedStarts = [];

  for (const hand of ["rh", "lh"]) {
    const open = new Map(); // midi -> {measureIndex}
    measures.forEach((measure, mi) => {
      (measure[hand] || []).forEach((e, ei) => {
        if (isRest(e)) return;
        for (const n of e.notes) {
          const tie = n.tie;
          if (tie === "end" || tie === "both") {
            const started = open.get(n.midi);
            if (started === undefined) {
              const atSeam = seams.has(mi);
              unmatchedEnds.push({
                hand, measure: measure.number ?? mi + 1, eventIndex: ei,
                midi: n.midi, kind: atSeam ? "seam" : "orphan",
              });
            } else {
              if (started.measureIndex !== mi) {
                crossings.push({
                  hand, midi: n.midi,
                  from: measures[started.measureIndex].number ?? started.measureIndex + 1,
                  to: measure.number ?? mi + 1,
                });
              }
              open.delete(n.midi);
            }
          }
          if (tie === "start" || tie === "both") {
            open.set(n.midi, { measureIndex: mi });
          }
        }
      });
    });
    for (const [midi, started] of open) {
      unclosedStarts.push({
        hand, midi,
        measure: measures[started.measureIndex].number ?? started.measureIndex + 1,
      });
    }
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
 * @param {object} doc - parsed export document
 * @param {{bpm: number}} opts - target tempo in quarter notes per minute
 */
export function analyzeSong(doc, { bpm }) {
  if (!doc || !Array.isArray(doc.measures)) {
    throw new Error("Not a SAM export document: no `measures` array.");
  }
  if (!(bpm > 0)) throw new Error("A positive --bpm is required.");

  const scale = scalePitchClasses(doc.fifths);
  const measures = doc.measures.map((m, i) => analyzeMeasure(m, i, { bpm, scale }));
  const seams = findSeams(doc.measures);

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
    title: doc.title ?? "(untitled)",
    artist: doc.artist ?? null,
    key: doc.key ?? null,
    fifths: Number.isInteger(doc.fifths) ? doc.fifths : null,
    bpm,
    measureCount: measures.length,
    measures,
    summary,
    flagged: measures.filter((m) => m.flags.length > 0).map((m) => m.number),
    seams: [...seams].map((i) => doc.measures[i]?.number ?? i + 1),
    ties: analyzeTies(doc.measures, seams),
    tuplets: analyzeTuplets(doc.measures),
    blips: analyzeMelodyBlips(doc.measures),
  };
}
