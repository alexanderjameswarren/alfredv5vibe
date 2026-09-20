/**
 * Where the music of one playthrough ends, when rest bars follow it.
 *
 * THE PROBLEM (2026-09-20). A looped snippet with rest measures banked its
 * pass only at the loop teleport — a whole bar after the last note — so the
 * pass counter and the plan line sat still while he was already resting. The
 * pass is musically over when the scroll reaches the first rest bar, and that
 * is when it should be credited.
 *
 * Rest bars are appended with numbers past the snippet's end (SamPlayer's
 * `activeMeasures`), carry whole-note rests and so produce beat events with no
 * MIDI at all. Nothing in them is scoreable — the matcher skips a beat with no
 * notes and the miss scanner marks it "skipped" without reporting it — so
 * crediting before them changes no hit, miss or note count. That is what makes
 * this safe rather than merely earlier.
 */

/**
 * Index, within ONE copy, of the first beat of the first appended rest bar.
 * Null when nothing was appended, or the boundary cannot be identified — in
 * which case the caller keeps crediting at the teleport, as before.
 */
export function restStartIndex(events, measures, restMeasureCount, beatsPerCopy) {
  if (!Array.isArray(events) || !Array.isArray(measures)) return null;
  if (!(restMeasureCount > 0)) return null;
  if (measures.length <= restMeasureCount) return null;   // all rest, no music
  const firstRest = measures[measures.length - restMeasureCount];
  if (!firstRest || firstRest.number == null) return null;
  const upTo = Math.min(beatsPerCopy || events.length, events.length);
  for (let i = 0; i < upTo; i++) {
    if (events[i] && events[i].meas === firstRest.number) {
      // A boundary at the very first beat would mean no music at all.
      return i > 0 ? i : null;
    }
  }
  return null;
}

/**
 * The elapsed time at which the pass may be banked: the LATER of the first
 * rest beat's own target, and the last musical beat's target plus the matching
 * window.
 *
 * The second term is what keeps the counters identical. When the final note is
 * short — an eighth at a fast tempo — its grace period outlasts the barline,
 * and crediting at the barline could miss a hit the player was still allowed
 * to land. Waiting for the grace to expire means every beat of the pass has
 * been resolved, one way or the other, before the row is written.
 */
export function contentEndTime(events, restStartIdx, timingWindowMs) {
  const restBeat = events?.[restStartIdx];
  if (!restBeat) return null;
  const lastContent = events[restStartIdx - 1];
  const graceEnd = lastContent
    ? lastContent.targetTimeMs + (timingWindowMs || 0)
    : restBeat.targetTimeMs;
  return Math.max(restBeat.targetTimeMs, graceEnd);
}
