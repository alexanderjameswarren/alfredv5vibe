/**
 * Compare played MIDI numbers against expected.
 * Both arrays should be sorted ascending and deduplicated.
 */
export function matchChord(played, expected) {
  const playedSet = new Set(played);
  const expectedSet = new Set(expected);

  const missingNotes = expected.filter((n) => !playedSet.has(n));
  const extraNotes = played.filter((n) => !expectedSet.has(n));

  if (missingNotes.length === 0 && extraNotes.length === 0) {
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
 * Find the closest pending beat to the target line within the timing window.
 * Returns { beat, timingDeltaMs } or null if no candidate.
 *
 * scrollState: { originPx, pxPerMs, scrollStartT, targetX }
 * windowMs: how far ahead/behind (in ms) to search
 */
export function findClosestBeat(beatEvents, scrollState, windowMs = 500) {
  if (!scrollState || !beatEvents.length) return null;

  const now = performance.now();
  const elapsed = now - scrollState.scrollStartT;
  const scrollOffset = scrollState.originPx + elapsed * scrollState.pxPerMs;
  const targetX = scrollState.targetX;
  const windowPx = windowMs * scrollState.pxPerMs;

  let closest = null;
  let closestDist = Infinity;

  for (let i = 0; i < beatEvents.length; i++) {
    const evt = beatEvents[i];
    if (evt.state !== "pending") continue;
    if (evt.allMidi.length === 0) continue; // skip rests

    const screenX = evt.xPx - scrollOffset;
    const dist = Math.abs(screenX - targetX);

    // Only consider beats within the timing window
    if (dist > windowPx) {
      // If we've passed the window to the right, stop scanning
      if (screenX > targetX + windowPx) break;
      continue;
    }

    if (dist < closestDist) {
      closestDist = dist;
      // Positive delta = beat is to the right of target (player is early)
      // Negative delta = beat is to the left of target (player is late)
      const timingDeltaMs = (screenX - targetX) / scrollState.pxPerMs;
      closest = { beat: evt, timingDeltaMs };
    }
  }

  return closest;
}
