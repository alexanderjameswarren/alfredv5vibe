// Song difficulty analysis — Deno/TS port of tools/sam-tools/lib/analyze.js.
//
// A FAITHFUL PORT, not a rewrite. Every function body mirrors the CLI
// statement for statement; only type annotations were added. The CLI is the
// calibrated original (Phase 1.5), and this copy exists because the Edge
// Function deploy bundles only supabase/functions/**, so the CLI file cannot
// be imported from here.
//
// Parity is enforced, not hoped for: tools/sam-tools/test/analyzerParity.test.js
// runs both copies on the four reference songs and requires identical output,
// per measure, per metric. If you change the CLI analyzer, change this file in
// the same commit — the test fails until you do.
//
// Pure and read-only: no I/O, no database, no mutation of the input.
//
// Two rules this file exists to respect (unchanged from the CLI):
//
//   1. Beat position is IMPLIED, never stored. A voice event knows its
//      duration, not its onset; onsets come from walking the array and
//      accumulating. Every accumulation goes through durations.ts so tuplets
//      scale correctly — `duration` is the DISPLAY token, and a triplet eighth
//      stored as "8" sounds for a third of a beat, not half.
//
//   2. Key comes from `fifths`, never from the `key` label. The label is
//      derived through a major-only table, so a piece in A minor reports
//      "C major". See docs/history/song-export-format.md §6.
//
// TEMPO. analyzeSong takes one number, in quarter notes per minute, and does
// not choose it. Callers resolve it as: explicit argument -> the song's
// goal_effective_bpm -> error. Never goal_bpm, never default_bpm — see
// docs/technical-spec-analyzer-port.md §3 for why goal_bpm is a trap on
// audio-backed songs.
//
// Deliberately NOT implemented: hand independence. The old spec called for it;
// it scored a known-easy piece at 75% and a known-hard one at 15% — backwards
// from how they actually play. Do not re-add it without a metric that survives
// that test.

import { measureBeats, sumEvents } from "./durations.ts";

// --- document shapes (docs/history/song-export-format.md) -------------------

export interface Note {
  midi: number;
  name?: string;
  tie?: "start" | "end" | "both";
}

export interface Tuplet {
  actual: number;
  normal: number;
  position?: string;
}

export interface VoiceEvent {
  duration: string;
  notes: Note[];
  tuplet?: Tuplet;
}

export interface TimeSignature {
  beats: number;
  beatType: number;
  symbol?: string;
}

export interface Measure {
  number?: number | null;
  sourceMeasure?: string | null;
  timeSignature?: TimeSignature | null;
  rh?: VoiceEvent[];
  lh?: VoiceEvent[];
}

export interface SongDocument {
  title?: string | null;
  artist?: string | null;
  key?: string | null;
  fifths?: number | null;
  measures: Measure[];
}

type Hand = "rh" | "lh";

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
//
// notesPerSecond is the ONE tempo-dependent metric, so a flag is only valid at
// the tempo it was computed at. Flags are derived on read; never store them.
export const THRESHOLDS = {
  notesPerSecond: 5,
  lhNotesPerBeat: 3,
  rhStack: 2,
  rhStretch: 9,
  rhythmVariety: 3,
} as const;

type FlagMetric = keyof typeof THRESHOLDS;

// Short codes used in the flags column, paired with the metric they gate.
const FLAG_SPECS: { code: string; metric: FlagMetric; limit: number }[] = [
  { code: "NS", metric: "notesPerSecond", limit: THRESHOLDS.notesPerSecond },
  { code: "LH", metric: "lhNotesPerBeat", limit: THRESHOLDS.lhNotesPerBeat },
  { code: "STK", metric: "rhStack", limit: THRESHOLDS.rhStack },
  { code: "STR", metric: "rhStretch", limit: THRESHOLDS.rhStretch },
  { code: "VAR", metric: "rhythmVariety", limit: THRESHOLDS.rhythmVariety },
];

const isRest = (e: VoiceEvent | null | undefined): boolean =>
  !e || !Array.isArray(e.notes) || e.notes.length === 0;
const midis = (e: VoiceEvent): number[] => e.notes.map((n) => n.midi);
const topOf = (e: VoiceEvent): number => Math.max(...midis(e));
const bottomOf = (e: VoiceEvent): number => Math.min(...midis(e));

/** Sounded beats for one event — tuplet-scaled. Never reads `duration` raw. */
const eventBeats = (e: VoiceEvent): number => sumEvents([e]) ?? 0;

interface Walked {
  event: VoiceEvent;
  index: number;
  onset: number;
  rest: boolean;
}

/**
 * Walk one hand, accumulating onsets. Returns every sounding event with the
 * beat it starts on, plus the rests skipped along the way.
 */
function withOnsets(events: VoiceEvent[] | null | undefined): Walked[] {
  const out: Walked[] = [];
  let beat = 0;
  (events || []).forEach((e, index) => {
    out.push({ event: e, index, onset: beat, rest: isRest(e) });
    beat += eventBeats(e);
  });
  return out;
}

/** Diatonic pitch classes for a key signature, or null when unknown. */
export function scalePitchClasses(fifths: unknown): Set<number> | null {
  if (!Number.isInteger(fifths)) return null;
  const f = fifths as number;
  // A key and its relative minor share a collection, so the (unreliable) mode
  // is irrelevant — derive from the major tonic and be done.
  const tonic = (((7 * f) % 12) + 12) % 12;
  return new Set([0, 2, 4, 5, 7, 9, 11].map((i) => (tonic + i) % 12));
}

function handMetrics(events: VoiceEvent[] | null | undefined, hand: Hand) {
  const walked = withOnsets(events).filter((w) => !w.rest);
  let stack = 0;
  let stretch = 0;
  let jump = 0;
  let prev: number | null = null;

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

export interface MeasureAnalysis {
  number: number;
  sourceMeasure: string | null;
  beats: number;
  seconds: number;
  notesPerSecond: number;
  rhNotesPerBeat: number;
  lhNotesPerBeat: number;
  rhStack: number;
  lhStack: number;
  rhStretch: number;
  lhStretch: number;
  rhJump: number;
  lhJump: number;
  rhythmVariety: number;
  accidentals: number | null;
  flags: string[];
}

function analyzeMeasure(
  measure: Measure,
  index: number,
  { bpm, scale }: { bpm: number; scale: Set<number> | null },
): MeasureAnalysis {
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
  const varietyOf = (events: VoiceEvent[] | null | undefined): number => {
    const t = new Set<string>();
    for (const e of events || []) if (e?.duration) t.add(e.duration);
    return t.size;
  };

  // Accidentals: note occurrences outside the key, not distinct classes — six
  // chromatic notes are harder than one repeated six times.
  let accidentals: number | null = null;
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
  } as MeasureAnalysis;
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
export function findSeams(measures: Measure[]): Set<number> {
  const seams = new Set<number>();
  const num = (m: Measure | undefined): number | null => {
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

export interface TieCrossing { hand: Hand; midi: number; from: number; to: number }
export interface UnmatchedEnd {
  hand: Hand;
  measure: number;
  eventIndex: number;
  midi: number;
  kind: "seam" | "orphan";
}
export interface UnclosedStart { hand: Hand; midi: number; measure: number; eventIndex: number }

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
export function analyzeTies(measures: Measure[], seams: Set<number>) {
  const crossings: TieCrossing[] = [];
  const unmatchedEnds: UnmatchedEnd[] = [];
  const unclosedStarts: UnclosedStart[] = [];
  const numberOf = (mi: number): number => measures[mi].number ?? mi + 1;

  for (const hand of ["rh", "lh"] as const) {
    // midi -> stack of {measureIndex, eventIndex}, newest last
    const open = new Map<number, { measureIndex: number; eventIndex: number }[]>();
    const unclosedForHand: (UnclosedStart & { _order: number })[] = [];

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
          open.get(n.midi)!.push({ measureIndex: mi, eventIndex: ei });
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

export interface TupletGroup {
  hand: Hand;
  measure: number;
  startBeat: number;
  actual: number;
  normal: number;
  length: number;
}

/** Runs of consecutive tuplet events within one hand of one measure. */
function analyzeTuplets(measures: Measure[]): TupletGroup[] {
  const groups: TupletGroup[] = [];
  measures.forEach((measure, mi) => {
    for (const hand of ["rh", "lh"] as const) {
      const walked = withOnsets(measure[hand]);
      let run: TupletGroup | null = null;
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

export interface MelodyBlip { measure: number; eventIndex: number; top: number; drop: number }

export function analyzeMelodyBlips(measures: Measure[]): MelodyBlip[] {
  // One continuous RH stream — a blip can straddle a barline.
  const stream: { top: number; measure: number; eventIndex: number }[] = [];
  measures.forEach((measure, mi) => {
    (measure.rh || []).forEach((e, ei) => {
      if (isRest(e)) return;
      stream.push({ top: topOf(e), measure: measure.number ?? mi + 1, eventIndex: ei });
    });
  });

  const blips: MelodyBlip[] = [];
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
export function quantile(values: unknown[], p: number): number | null {
  const v = (values.filter((x) => typeof x === "number" && !Number.isNaN(x)) as number[])
    .sort((a, b) => a - b);
  if (v.length === 0) return null;
  if (v.length === 1) return v[0];
  const pos = (v.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

type SummaryKey =
  | "notesPerSecond" | "lhNotesPerBeat" | "rhNotesPerBeat"
  | "rhStack" | "lhStack" | "rhStretch" | "lhStretch"
  | "rhJump" | "lhJump" | "rhythmVariety" | "accidentals";

export const SUMMARY_METRICS: [string, SummaryKey][] = [
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

export interface SummaryStat { median: number | null; p90: number | null; max: number | null }

/**
 * @param doc - parsed export document
 * @param opts.bpm - target tempo in quarter notes per minute, already
 *   resolved by the caller (see the TEMPO note at the top of this file)
 */
export function analyzeSong(doc: SongDocument, { bpm }: { bpm: number }) {
  if (!doc || !Array.isArray(doc.measures)) {
    throw new Error("Not a SAM export document: no `measures` array.");
  }
  if (!(bpm > 0)) throw new Error("A positive --bpm is required.");

  const scale = scalePitchClasses(doc.fifths);
  const measures = doc.measures.map((m, i) => analyzeMeasure(m, i, { bpm, scale }));
  const seams = findSeams(doc.measures);

  const summary = {} as Record<SummaryKey, SummaryStat>;
  for (const [, key] of SUMMARY_METRICS) {
    const values = measures.map((m) => m[key]).filter((x) => x != null) as number[];
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
    fifths: Number.isInteger(doc.fifths) ? (doc.fifths as number) : null,
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
