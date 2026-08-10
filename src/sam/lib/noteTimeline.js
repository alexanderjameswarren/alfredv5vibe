// Note timeline builder — spec §"New files" of docs/technical-spec-full-playback.md
//
// Pure module: no React, no audio, no imports from ScrollEngine. Converts a
// measure array into a flat, onset-sorted list of sounding notes with their
// durations. The scheduler joins this to the EXISTING beat events on beat
// position (spec D2) instead of computing onsets from msPerBeat, so the synth
// and the scroll cannot drift apart — every onset is, by construction, a
// position the scroll already knows about.
//
// All duration math routes through measureUtils.getEventBeats, never
// durations.tokenToBeats. getEventBeats is the tuplet-aware wrapper: a triplet
// eighth stores duration "8" with tuplet {actual:3, normal:2} and sounds
// 0.3333 beats, not 0.5. Triplets are live in the corpus (Bach Invention,
// Moonlight), so the raw token function would stretch every one by 50%.
//
// Tie handling here is deliberately NOT the renderer's. drawStaveTies
// (scoreRender.js:151-170) does pairwise adjacency matching to draw arcs and
// never models total sounding duration; the `every(n => n.tie === "end")`
// predicate at scoreRender.js:541-545 collapses a chord in which one voice
// ties and another re-articulates. This module decides per NOTE, not per
// event, which is what makes that chord come out right.

import { getEventBeats, getMeasDurationQ } from "./measureUtils";

// Articulation gap in quarter-note beats, shaved off every sounding duration
// so a repeated pitch re-attacks instead of fusing into one continuous tone.
// Clamped so it can never remove more than half the note (spec: `max(dur -
// gap, dur * 0.5)`) — a 16th at 0.25 beats keeps 0.2 rather than collapsing.
// 0.05 beats is 50ms at 60 BPM: audible separation, well short of staccato.
export const ARTICULATION_GAP_BEATS = 0.05;

// Per-measure overflow tolerance. Deliberately far looser than float noise
// (tuplet accumulation drifts ~1e-15 across a measure) because this guards
// against authoring errors, not arithmetic.
const OVERFLOW_EPS = 1e-3;

const HANDS = ["rh", "lh"];

/**
 * A note is a continuation link — already sounded by the head of its tie
 * chain — when it is the tail ("end") or a middle link ("both").
 */
function isContinuation(note) {
  return note?.tie === "end" || note?.tie === "both";
}

/** Shave the articulation gap, never taking more than half the note. */
function applyArticulationGap(durationBeats) {
  return Math.max(durationBeats - ARTICULATION_GAP_BEATS, durationBeats * 0.5);
}

/**
 * Flatten one hand across every measure into
 *   [{ evt, onsetBeats, beats, measureNumber }]
 * with onsets in beats from measures[0].
 *
 * The cursor is re-anchored to the running measure start on every measure
 * rather than carried across the boundary, so a measure whose events don't sum
 * to its time signature cannot drift the rest of the piece — the damage stops
 * at that barline (spec: "Do not let a malformed measure drift the whole
 * timeline").
 *
 * Spanning measures in ONE list is what lets a tie chain resolve across a
 * barline: the continuation is simply the next entry carrying that midi.
 */
function flattenHand(measures, hand, warnings) {
  const flat = [];
  let measureStart = 0;

  for (let mi = 0; mi < measures.length; mi++) {
    const measure = measures[mi];
    const measLen = getMeasDurationQ(measure);
    const label = `measure ${measure?.number ?? mi + 1}`;
    const events = measure?.[hand];

    if (!Array.isArray(events)) {
      // Legacy `beats[]` measures carry no rh/lh, so they contribute nothing.
      // Warn once per hand per measure rather than emitting silence — a song
      // that produces an empty timeline should say why. (The current schema
      // rejects beats[]; only pre-migration documents reach this branch.)
      // Guarded to the first hand so a legacy measure warns once, not per hand.
      if (hand === HANDS[0] && !Array.isArray(measure?.rh) && !Array.isArray(measure?.lh)) {
        warnings.push(
          `${label}: no rh/lh voice arrays (legacy beats[] format?) — contributes no notes`
        );
      }
      measureStart += measLen;
      continue;
    }

    let cursor = measureStart;
    for (const evt of events) {
      const beats = getEventBeats(evt);
      if (!(beats > 0)) {
        // getEventBeats returns 0 for a token outside the vocabulary. We can't
        // advance by an unknown amount, so the rest of this measure lands
        // early — the measure-end snap keeps it from propagating further.
        warnings.push(
          `${label} ${hand}: unusable duration "${evt?.duration}" — event skipped, ` +
          `later onsets in this measure may be early`
        );
        continue;
      }
      flat.push({ evt, onsetBeats: cursor, beats, measureNumber: measure?.number ?? mi + 1 });
      cursor += beats;
    }

    // Only overflow is worth reporting. A SHORT hand is normal — the renderer
    // pads it with rests (scoreRender.padVoice), and an empty hand is a
    // legitimate whole-measure rest, so warning on short would fire constantly.
    if (cursor > measureStart + measLen + OVERFLOW_EPS) {
      warnings.push(
        `${label} ${hand}: events sum to ${(cursor - measureStart).toFixed(4)} beats but the ` +
        `time signature allows ${measLen} — truncating to the barline`
      );
    }

    measureStart += measLen; // snap, regardless of where the cursor landed
  }

  return flat;
}

/**
 * Total sounding duration of the tie chain headed at flat[startIdx] for `midi`.
 *
 * Walks forward in the same hand looking for the next entry containing that
 * pitch. A matching note that is NOT a continuation means the chain was broken
 * by a fresh strike of the same pitch — stop there rather than swallowing it,
 * which would fuse two separate notes into one long tone.
 *
 * Never throws: an unresolved chain returns what it accumulated plus a warning.
 */
function resolveTieChain(flat, startIdx, midi, hand, warnings) {
  const head = flat[startIdx];
  let total = head.beats;

  for (let j = startIdx + 1; j < flat.length; j++) {
    const candidates = flat[j].evt.notes || [];

    // A single event can legitimately carry the SAME pitch twice: one voice
    // holding a tied note while another strikes that pitch fresh. Real in the
    // corpus — Moonlight m60 `C#4+C#4:end`, Someone Like You m27
    // `F#4+F#4:end`. Look for the continuation FIRST; taking whichever note
    // comes first in the array would see the untied sibling and wrongly
    // declare the chain broken.
    const cont = candidates.find((n) => n?.midi === midi && isContinuation(n));
    if (cont) {
      total += flat[j].beats;
      if (cont.tie === "end") return total; // "both" is a middle link: keep walking
      continue;
    }

    // Matching pitch with no continuation marker anywhere in the event: the
    // chain was broken by a genuine restrike. Stop rather than swallowing it,
    // which would fuse two separate notes into one long tone.
    if (candidates.some((n) => n?.midi === midi)) {
      warnings.push(
        `${hand} m${head.measureNumber}: tie chain on midi ${midi} broken by an untied ` +
        `restrike at m${flat[j].measureNumber} — held ${total.toFixed(4)} beats`
      );
      return total;
    }
    // No match at all — the tie may span rests or other pitches. Keep walking.
  }

  warnings.push(
    `${hand} m${head.measureNumber}: tie chain on midi ${midi} never resolved ` +
    `(no "end" link) — held ${total.toFixed(4)} beats`
  );
  return total;
}

/**
 * Build the sounding-note timeline for a measure array.
 *
 * @param {Array} measures - `activeMeasures` shape: per-measure `rh` / `lh`
 *   voice event arrays, each event `{ duration, notes: [{ midi, name, tie? }],
 *   tuplet? }`. An event with `notes: []` is a rest.
 * @returns {{ notes: Array<{onsetBeats:number, durationBeats:number,
 *   midi:number, hand:"rh"|"lh"}>, warnings: string[] }}
 *   `notes` is sorted by onset; onsets are in quarter-note beats from
 *   measures[0], the same coordinate system as the beat events' beat position.
 */
export function buildNoteTimeline(measures) {
  const warnings = [];
  const notes = [];

  if (!Array.isArray(measures) || measures.length === 0) {
    return { notes, warnings };
  }

  for (const hand of HANDS) {
    const flat = flattenHand(measures, hand, warnings);

    for (let i = 0; i < flat.length; i++) {
      const entry = flat[i];

      // A rest is `notes: []` — the cursor already advanced in flattenHand,
      // so there is simply nothing to emit here.
      for (const note of entry.evt.notes || []) {
        if (typeof note?.midi !== "number") {
          warnings.push(
            `${hand} m${entry.measureNumber}: note without a numeric midi — skipped`
          );
          continue;
        }

        // Continuations were already sounded by their chain head.
        if (isContinuation(note)) continue;

        const durationBeats =
          note.tie === "start"
            ? resolveTieChain(flat, i, note.midi, hand, warnings)
            : entry.beats;

        notes.push({
          onsetBeats: entry.onsetBeats,
          durationBeats: applyArticulationGap(durationBeats),
          midi: note.midi,
          hand,
        });
      }
    }
  }

  // Onset-sorted so the scheduler can walk it with a single forward cursor
  // (mirroring nextMetroBeatIdx). midi as a tiebreak keeps the order stable
  // across the two independent per-hand walks.
  notes.sort((a, b) => a.onsetBeats - b.onsetBeats || a.midi - b.midi);

  return { notes, warnings };
}
