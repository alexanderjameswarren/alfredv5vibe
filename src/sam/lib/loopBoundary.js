// The loop boundary (sam_play_tweaks-h3n, step 2).
//
// When looping, ScrollEngine renders three copies; copy 0 is always the pass in
// progress and copy 1 the next. A press can reach a copy-1 beat just BEFORE the
// wrap — an early first note. These helpers keep that result across the wrap,
// and SamPlayer holds its record back until the pass counters have rotated.

// The colour each graded state is painted, matching SamPlayer's grader.
export const STATE_COLORS = {
  hit: "#16a34a",
  partial: "#d97706",
  wrong: "#dc2626",
  missed: "#dc2626",
};

/** True when the beat belongs to a pass that has not started yet. */
export function isNextCycleBeat(evt) {
  return (evt?.copy ?? 0) > 0;
}

/** Copy 1's states, by index within the copy, taken before the wrap resets them. */
export function snapshotIncoming(events, beatsPerCopy) {
  const out = [];
  for (let i = 0; i < beatsPerCopy; i++) out.push(events[beatsPerCopy + i]?.state ?? "pending");
  return out;
}

/**
 * After the wrap's reset, give copy 0 — now the new pass — the states its beats
 * already had as copy 1. Returns the beats that were carried, for recolouring.
 */
export function applyCarryOver(events, snapshot) {
  const carried = [];
  for (let i = 0; i < snapshot.length; i++) {
    const evt = events[i];
    if (!evt || snapshot[i] === "pending") continue;
    evt.state = snapshot[i];
    carried.push(evt);
  }
  return carried;
}

/** The SVG elements a result paints: the scored hand only. */
export function activeEls(evt, handMode) {
  if (handMode === "lh") return [evt.bassSvgEl].filter(Boolean);
  if (handMode === "rh") return [evt.trebleSvgEl].filter(Boolean);
  return evt.svgEls || [];
}
