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
 * Find the closest pending beat within the timing window.
 * Uses targetTimeMs (musical timing) instead of SVG x-positions.
 * Returns { beat, timingDeltaMs } or null if no candidate.
 *
 * scrollState: { scrollStartT }
 * windowMs: how far ahead/behind (in ms) to search
 */
export function findClosestBeat(beatEvents, scrollState, windowMs = 500) {
  if (!scrollState || !beatEvents.length) return null;

  const now = performance.now();
  const elapsed = now - scrollState.scrollStartT;

  let closest = null;
  let closestDist = Infinity;

  for (let i = 0; i < beatEvents.length; i++) {
    const evt = beatEvents[i];
    if (evt.state !== "pending") continue;
    if (evt.allMidi.length === 0) continue; // skip rests

    // Positive timingDelta = beat is in the future (player is early)
    // Negative timingDelta = beat is in the past (player is late)
    const timingDeltaMs = evt.targetTimeMs - elapsed;
    const dist = Math.abs(timingDeltaMs);

    // Only consider beats within the timing window
    if (dist > windowMs) {
      // If this beat is far in the future, stop scanning
      if (timingDeltaMs > windowMs) break;
      continue;
    }

    if (dist < closestDist) {
      closestDist = dist;
      closest = { beat: evt, timingDeltaMs };
    }
  }

  return closest;
}
