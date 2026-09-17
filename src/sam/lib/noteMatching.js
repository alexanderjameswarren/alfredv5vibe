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
 * The pending beat nearest to now, IGNORING the matching window, with its
 * signed offset (same sign rule as findClosestBeat: positive = early).
 *
 * This is not a matcher and must never be used to score: it exists so a
 * keystroke that matched nothing can still be recorded against the measure
 * that was playing, as an `extra` event. Returns null when nothing is pending.
 */
export function nearestBeat(beatEvents, scrollState, handMode = "both") {
  if (!scrollState || !beatEvents.length) return null;
  const elapsed = scrollState.elapsed ?? (performance.now() - scrollState.scrollStartT);

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

export function findClosestBeat(beatEvents, scrollState, windowMs = 300, handMode = "both") {
  if (!scrollState || !beatEvents.length) return null;

  // Use ScrollEngine's audio-synced elapsed (updated every frame) when available,
  // falling back to raw wall clock for the first frame before elapsed is set.
  const elapsed = scrollState.elapsed ?? (performance.now() - scrollState.scrollStartT);

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
