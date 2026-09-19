/**
 * The unplayed tail of a pass, at the moment the loop teleports.
 *
 * THE BUG THIS FIXES (2026-09-19). At a loop restart ScrollEngine resets every
 * beat of every copy back to "pending" with a fresh `targetTimeMs`. The miss
 * scanner runs later in that same frame, so a beat of the OUTGOING pass that
 * was never played, and whose grace window had not yet expired, was recycled
 * without ever being recorded. The last note of a pass could escape the miss
 * count entirely — the scanner had nothing left to find.
 *
 * So the outgoing copy is swept BEFORE anything is reset. Anything still
 * pending there will never be played: that pass is over.
 *
 * Deliberately not time-based. The scanner waits out `timingWindowMs` because
 * the note might still arrive; here it cannot, so every pending beat is
 * resolved regardless of how recently its target passed.
 *
 * Rests follow the scanner's rule — "skipped", never "missed" — so a bar of
 * silence at the end of a range does not manufacture misses.
 *
 * @param beatEvents the full array (all copies)
 * @param beatsInCopy how many beats one copy holds; only the first copy is swept
 * @param handMode "lh" | "rh" | "both" — which hand is being scored
 * @param onBeatMiss called for each beat that is now a miss
 * @returns how many misses were raised
 */
export function sweepUnplayedTail(beatEvents, beatsInCopy, handMode, onBeatMiss) {
  if (!Array.isArray(beatEvents) || !(beatsInCopy > 0)) return 0;
  let missed = 0;
  const upTo = Math.min(beatsInCopy, beatEvents.length);
  for (let i = 0; i < upTo; i++) {
    const evt = beatEvents[i];
    if (!evt || evt.state !== "pending") continue;
    const active = handMode === "lh" ? evt.lhMidi : handMode === "rh" ? evt.rhMidi : evt.allMidi;
    if (!active || active.length === 0) {
      evt.state = "skipped";
      continue;
    }
    evt.state = "missed";
    missed++;
    if (onBeatMiss) onBeatMiss(evt);
  }
  return missed;
}
