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
export function findClosestBeat(beatEvents, scrollState, windowMs = 300, handMode = "both") {
  if (!scrollState || !beatEvents.length) return null;

  const now = performance.now();
  const elapsed = now - scrollState.scrollStartT;

  for (let i = 0; i < beatEvents.length; i++) {
    const evt = beatEvents[i];
    if (evt.state !== "pending") continue;
    // Use hand-filtered midi when in LH/RH mode
    const activeMidi = handMode === "lh" ? (evt.lhMidi || evt.allMidi) : handMode === "rh" ? (evt.rhMidi || evt.allMidi) : evt.allMidi;
    if (activeMidi.length === 0) continue;

    // Positive timingDelta = beat is in the future (player is early)
    // Negative timingDelta = beat is in the past (player is late)
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
