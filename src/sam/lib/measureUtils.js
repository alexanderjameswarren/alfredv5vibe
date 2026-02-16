// Voice format ↔ beats format conversion utilities

// Beat values in quarter-note units
const DURATION_BEATS = {
  w: 4, hd: 3, h: 2, qd: 1.5, q: 1, "8d": 0.75, "8": 0.5, "16": 0.25, "32": 0.125,
};

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
      const beatVal = DURATION_BEATS[dur] || 1;
      // Round to avoid floating-point drift
      const roundedPos = Math.round(pos * 1000) / 1000;

      if (!posMap.has(roundedPos)) {
        posMap.set(roundedPos, { duration: dur, rh: [], lh: [] });
      }

      const entry = posMap.get(roundedPos);
      const notes = (evt.notes || []).map((n) => ({
        midi: n.midi,
        name: n.name,
        duration: dur,
      }));

      if (hand === "rh") entry.rh.push(...notes);
      else entry.lh.push(...notes);

      // Use the shortest duration at this position for display
      if ((DURATION_BEATS[dur] || 1) < (DURATION_BEATS[entry.duration] || 1)) {
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
    return {
      beat: pos + 1, // 1-indexed quarter-note beats
      duration: entry.duration,
      rh: entry.rh,
      lh: entry.lh,
    };
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
