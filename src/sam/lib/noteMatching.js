/**
 * Compare played MIDI numbers against expected.
 * Both arrays should be sorted ascending and deduplicated.
 */
export function matchChord(played, expected) {
  const playedSet = new Set(played);
  const expectedSet = new Set(expected);

  const missingNotes = expected.filter((n) => !playedSet.has(n));
  const extraNotes = played.filter((n) => !expectedSet.has(n));

  // All expected notes present → hit (extra notes are tolerated)
  if (missingNotes.length === 0) {
    return { result: "hit", missingNotes, extraNotes };
  }

  // All played notes are in expected, but some expected notes are missing
  if (extraNotes.length === 0 && missingNotes.length > 0) {
    return { result: "partial", missingNotes, extraNotes };
  }

  // Wrong notes played
  return { result: "miss", missingNotes, extraNotes };
}

/**
 * Find the first pending beat within the timing window.
 * Returns the earliest chronological pending beat that falls within
 * ±windowMs of the current elapsed time.
 *
 * "First pending" prevents cascade mismatches when a player is
 * systematically late — their keypress always matches the beat
 * they're actually trying to hit, not the next one.
 *
 * scrollState: { scrollStartT }
 * windowMs: how far ahead/behind (in ms) to search
 */
/**
 * Elapsed score time at the instant a key was actually pressed.
 *
 * WHY THIS IS NOT JUST `scrollState.elapsed` (2026-09-19). ScrollEngine writes
 * `state.elapsed` ONCE PER ANIMATION FRAME. Reading it at keystroke time
 * therefore quantised every offset to the frame interval — about 17 ms at
 * 60 Hz — and made it stale by up to a whole frame, which biased offsets
 * POSITIVE (early), since a stale `elapsed` is too small. Worse, the frame is
 * exactly what stalls under load, so the error grew precisely when the main
 * thread was busy.
 *
 * `atMs` is a `performance.now()` reading taken when the MIDI event ARRIVED,
 * carried through the chord buffer. The frame-published `elapsed` is still the
 * anchor — it is the only thing that knows about audio sync, playback rate and
 * the rest pause — and we simply add the time that has passed since the frame
 * that wrote it. `state.elapsedAtMs` is the `performance.now()` of that frame.
 *
 * Falls back cleanly: to the raw wall clock before the first frame, and to the
 * published `elapsed` when no press time was given or the engine is not
 * recording frame times.
 */
export function elapsedAt(scrollState, atMs) {
  const published = scrollState.elapsed;
  if (published == null) return performance.now() - scrollState.scrollStartT;
  const frameAt = scrollState.elapsedAtMs;
  if (atMs == null || frameAt == null) return published;
  // Never run the clock backwards: a press recorded before the current frame
  // belongs to that frame as far as the score is concerned.
  return published + Math.max(0, atMs - frameAt);
}

/**
 * The pending beat nearest to now, IGNORING the matching window, with its
 * signed offset (same sign rule as findClosestBeat: positive = early).
 *
 * This is not a matcher and must never be used to score: it exists so a
 * keystroke that matched nothing can still be recorded against the measure
 * that was playing, as an `extra` event. Returns null when nothing is pending.
 */
export function nearestBeat(beatEvents, scrollState, handMode = "both", atMs) {
  if (!scrollState || !beatEvents.length) return null;
  const elapsed = elapsedAt(scrollState, atMs);

  let best = null;
  for (const evt of beatEvents) {
    if (evt.state !== "pending") continue;
    const activeMidi = handMode === "lh" ? (evt.lhMidi || evt.allMidi) : handMode === "rh" ? (evt.rhMidi || evt.allMidi) : evt.allMidi;
    if (activeMidi.length === 0) continue;
    const timingDeltaMs = evt.targetTimeMs - elapsed;
    if (!best || Math.abs(timingDeltaMs) < Math.abs(best.timingDeltaMs)) {
      best = { beat: evt, timingDeltaMs };
    }
  }
  return best;
}

export function findClosestBeat(beatEvents, scrollState, windowMs = 300, handMode = "both", atMs) {
  if (!scrollState || !beatEvents.length) return null;

  const elapsed = elapsedAt(scrollState, atMs);

  for (let i = 0; i < beatEvents.length; i++) {
    const evt = beatEvents[i];
    if (evt.state !== "pending") continue;
    // Use hand-filtered midi when in LH/RH mode
    const activeMidi = handMode === "lh" ? (evt.lhMidi || evt.allMidi) : handMode === "rh" ? (evt.rhMidi || evt.allMidi) : evt.allMidi;
    if (activeMidi.length === 0) continue;

    // 🛑 THE SIGN, STATED ONCE AND RELIED ON EVERYWHERE:
    //   POSITIVE = EARLY (the beat is still in the future — the player rushed)
    //   NEGATIVE = LATE  (the beat is already past — the player dragged)
    // This is the source of `sam_session_events.timing_delta_ms` and of
    // `sam_sessions.summary.avgTimingDeltaMs`, so a negative average means
    // dragging. The database column comment said the opposite until migration
    // 029 (2026-09-18) corrected it to match this line; the sign itself has
    // never changed.
    //
    // Two things bound what the number can say. A keypress further out than
    // `windowMs` matches no beat at all and is never recorded, so the
    // magnitude is truncated and any average is pulled toward zero; and a
    // fixed MIDI or audio latency rides along as a constant offset.
    const timingDeltaMs = evt.targetTimeMs - elapsed;
    const dist = Math.abs(timingDeltaMs);

    // If this beat is beyond the window in the future, stop scanning
    if (timingDeltaMs > windowMs) break;

    // First pending beat within the window — return it
    if (dist <= windowMs) {
      return { beat: evt, timingDeltaMs };
    }
  }

  return null;
}
