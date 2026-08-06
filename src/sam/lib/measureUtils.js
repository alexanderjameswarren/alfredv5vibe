// Voice format ↔ beats format conversion utilities

import { tokenToBeats } from "./durations";

/**
 * Calculate measure duration in quarter-note equivalents.
 * e.g., 4/4 → 4, 3/4 → 3, 6/8 → 3, 7/8 → 3.5, 5/4 → 5
 */
export function measureDurationQ(timeSig) {
  if (!timeSig) return 4;
  return (timeSig.beats / timeSig.beatType) * 4;
}

/**
 * Convenience: extract durationQ from a measure object.
 */
export function getMeasDurationQ(measure) {
  return measureDurationQ(measure?.timeSignature);
}

/**
 * Format a timeSignature object for VexFlow's `Stave.addTimeSignature`.
 * Honors an optional `symbol` field that the MusicXML importer populates
 * from `<time symbol="cut|common">`. Beat math (which uses `beats` and
 * `beatType` numerically) is unaffected — the symbol is purely visual.
 *
 * - `symbol: "cut"`   → "C|"  (cut time / alla breve)
 * - `symbol: "common"`→ "C"   (common time)
 * - otherwise         → "${beats}/${beatType}"
 */
export function formatTimeSignature(timeSig) {
  if (!timeSig) return "4/4";
  if (timeSig.symbol === "cut") return "C|";
  if (timeSig.symbol === "common") return "C";
  return `${timeSig.beats}/${timeSig.beatType}`;
}

/**
 * Effective beat value of an event, accounting for an optional tuplet
 * time-modification. Tuplet shape mirrors MusicXML: `{ actual, normal,
 * position }` where `actual` notes are played in the time of `normal`
 * notes at the base duration. E.g. a triplet eighth is `{ actual: 3,
 * normal: 2 }`, so each eighth member contributes 0.5 * (2/3) = 0.333
 * beats; a triplet group of three sums to 1.0 beats.
 *
 * Use this helper at every site that sums event durations. Delegates
 * to `durations.tokenToBeats` (spec §M9 — single source of truth for
 * the token → beats mapping; the pre-M9 hardcoded map here was
 * missing qdd/hdd/8dd/64 and returned 0 for Someone Like You m70's
 * qdd, misaligning voiceToBeats, padVoice, and scroll ticks).
 */
export function getEventBeats(evt) {
  const beats = tokenToBeats(evt?.duration);
  if (beats === null) return 0;
  return evt.tuplet ? (beats * evt.tuplet.normal) / evt.tuplet.actual : beats;
}

/**
 * Convert a voice-format measure ({ lh[], rh[] }) to beats format ({ beats[] }).
 * Each voice event: { duration, notes: [{ midi, name }] }
 * Output beat: { beat, duration, rh: [{ midi, name, duration }], lh: [{ midi, name, duration }] }
 */
function voiceToBeats(measure) {
  const posMap = new Map();

  function walkVoice(events, hand) {
    let pos = 0;
    for (const evt of events || []) {
      const dur = evt.duration || "q";
      const beatVal = getEventBeats(evt) || 1;
      // Round to avoid floating-point drift
      const roundedPos = Math.round(pos * 1000) / 1000;

      if (!posMap.has(roundedPos)) {
        posMap.set(roundedPos, { duration: dur, rh: [], lh: [], lyric: undefined });
      }

      const entry = posMap.get(roundedPos);
      const notes = (evt.notes || []).map((n) => ({
        midi: n.midi,
        name: n.name,
        duration: dur,
      }));

      if (hand === "rh") {
        entry.rh.push(...notes);
        if (evt.lyric !== undefined) entry.lyric = evt.lyric;
      } else {
        entry.lh.push(...notes);
      }

      // Use the shortest duration at this position for display. Compare
      // by effective beats (tuplet-aware) so a triplet eighth correctly
      // beats a regular eighth. Uses tokenToBeats (spec §M9) — pre-M9
      // DURATION_BEATS lookup returned undefined for qdd, causing
      // dotted-dotted-durations to lose the shortest-wins comparison.
      const entryTokBeats = tokenToBeats(entry.duration);
      const entryBeats = entryTokBeats == null ? 1 : entryTokBeats;
      if (beatVal < entryBeats) {
        entry.duration = dur;
      }

      pos += beatVal;
    }
  }

  walkVoice(measure.rh, "rh");
  walkVoice(measure.lh, "lh");

  const sortedPositions = [...posMap.keys()].sort((a, b) => a - b);

  const beats = sortedPositions.map((pos) => {
    const entry = posMap.get(pos);
    const beat = {
      beat: pos + 1, // 1-indexed quarter-note beats
      duration: entry.duration,
      rh: entry.rh,
      lh: entry.lh,
    };
    if (entry.lyric !== undefined) beat.lyric = entry.lyric;
    return beat;
  });

  // Ensure at least one beat (whole-measure rest)
  if (beats.length === 0) {
    beats.push({ beat: 1, duration: "w", rh: [], lh: [] });
  }

  return beats;
}

/**
 * Normalize a measure to always have beats[].
 * - If measure already has beats[] → return as-is (legacy format)
 * - If measure has lh[]/rh[] → convert to beats format
 */
export function normalizeMeasure(measure) {
  if (measure.beats) return measure;
  return { ...measure, beats: voiceToBeats(measure) };
}
