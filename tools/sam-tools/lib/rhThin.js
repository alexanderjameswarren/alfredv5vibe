// RH thinning (spec §4.4).
//
// Removes notes from WITHIN an event and never removes an event. That is what
// keeps `rh_index` stable, which is what keeps lyrics and fingerings pointing
// at the right notes — both are keyed on it (§5.2).
//
// THE MELODY RULE. The highest-pitched note of every RH event is always
// retained, determined by max(midi) and never by array position. The array is
// asserted pitch-ascending and a violation is a hard error rather than a
// silent mis-pick.
//
// MELODY BLIPS ARE NOT CORRECTED. Where a merged inner voice briefly sits
// above the tune, the top note is not the melody and thinning to it produces
// an audible hiccup. That is intended: a hiccup can be heard and reported,
// whereas a silent guess about which note was "really" the melody cannot.
// Blips are detected and reported (§4.4, §8.1) and never repaired.

import { rhActive } from "./plan.js";

const isRest = (e) => !e || !Array.isArray(e.notes) || e.notes.length === 0;

export class PitchOrderError extends Error {
  constructor(measure, eventIndex, midis) {
    super(
      `m${measure} rh[${eventIndex}]: notes are not pitch-ascending ([${midis.join(", ")}]). ` +
        `The melody rule depends on ordering being meaningful; refusing to guess which note is the melody.`
    );
    this.name = "PitchOrderError";
  }
}

/** Note indices to keep in one event. Rests keep nothing and stay rests. */
export function keepIndices(event, rhStack, { measure, eventIndex }) {
  if (isRest(event)) return new Set();
  const midis = event.notes.map((n) => n.midi);
  for (let i = 1; i < midis.length; i++) {
    if (midis[i] < midis[i - 1]) throw new PitchOrderError(measure, eventIndex, midis);
  }
  const last = midis.length - 1;
  if (rhStack === "melody-only") return new Set([last]);
  if (rhStack === "melody-plus-one") {
    return new Set(last > 0 ? [last - 1, last] : [last]);
  }
  return new Set(midis.map((_, i) => i)); // "all"
}

// Tie bookkeeping. A note tagged "both" is the end of one link and the start of
// the next, so links are handled pairwise: break one and only that side's
// marker is stripped. Handling links rather than whole chains is what makes it
// impossible to leave a dangling marker, which is the property §5.1 is really
// asking for.
const roles = (tie) => ({
  start: tie === "start" || tie === "both",
  end: tie === "end" || tie === "both",
});
const composeTie = (start, end) =>
  start && end ? "both" : start ? "start" : end ? "end" : undefined;

/**
 * Thin the right hand across a whole song.
 *
 * Song-level rather than per-measure because tie links cross barlines and a
 * decision about one endpoint constrains the other.
 *
 * @param {object[]} measures - measures to thin IN PLACE (already clones)
 * @param {(n:number)=>object|null} settingsFor
 * @returns {{changed:number[], strippedTies:object[], retainedForTies:object[]}}
 */
export function thinRightHand(measures, settingsFor) {
  const num = (m, i) => m.number ?? i + 1;

  // Pass 1 — what survives on its own merits.
  const keep = measures.map((m, mi) => {
    const s = settingsFor(num(m, mi));
    if (!s || !rhActive(s)) return null; // untouched, or thinning is off
    return (m.rh || []).map((e, ei) =>
      keepIndices(e, s.rhStack, { measure: num(m, mi), eventIndex: ei })
    );
  });

  const removed = (mi, ei, ni) => keep[mi] !== null && !keep[mi][ei].has(ni);
  const untouchedMeasure = (mi) => keep[mi] === null;

  // Pass 2 — walk tie links and reconcile them with pass 1.
  const stripStart = new Set();
  const stripEnd = new Set();
  const key = (mi, ei, ni) => `${mi}:${ei}:${ni}`;
  const strippedTies = [];
  const retainedForTies = [];

  const open = new Map(); // midi -> {mi, ei, ni}
  measures.forEach((m, mi) => {
    (m.rh || []).forEach((e, ei) => {
      if (isRest(e)) return;
      e.notes.forEach((n, ni) => {
        const r = roles(n.tie);
        if (r.end) {
          const from = open.get(n.midi);
          open.delete(n.midi);
          if (from) {
            const aGone = removed(from.mi, from.ei, from.ni);
            const bGone = removed(mi, ei, ni);
            if (aGone || bGone) {
              // One end of the link is going. If EITHER end sits in an
              // untouched measure we cannot edit that side, so the removable
              // side is retained instead and the link survives intact —
              // slightly less thinning, never a broken tie.
              if (untouchedMeasure(from.mi) || untouchedMeasure(mi)) {
                if (aGone) keep[from.mi][from.ei].add(from.ni);
                if (bGone) keep[mi][ei].add(ni);
                retainedForTies.push({
                  measure: num(measures[mi], mi), midi: n.midi,
                  reason: "tie link reaches an untouched measure; note retained to keep the chain whole",
                });
              } else {
                // Both sides editable: drop the link. A survivor keeps its
                // note (the melody rule may require it) but loses the marker.
                if (!aGone) {
                  stripStart.add(key(from.mi, from.ei, from.ni));
                  strippedTies.push({
                    measure: num(measures[from.mi], from.mi), eventIndex: from.ei,
                    midi: n.midi, side: "start",
                  });
                }
                if (!bGone) {
                  stripEnd.add(key(mi, ei, ni));
                  strippedTies.push({
                    measure: num(measures[mi], mi), eventIndex: ei,
                    midi: n.midi, side: "end",
                  });
                }
              }
            }
          }
        }
        if (r.start) open.set(n.midi, { mi, ei, ni });
      });
    });
  });

  // Pass 3 — build the thinned events.
  const changed = [];
  measures.forEach((m, mi) => {
    if (keep[mi] === null) return;
    let touched = false;
    m.rh = (m.rh || []).map((e, ei) => {
      if (isRest(e)) return e;
      const notes = e.notes
        .map((n, ni) => ({ n, ni }))
        .filter(({ ni }) => keep[mi][ei].has(ni))
        .map(({ n, ni }) => {
          const r = roles(n.tie);
          const tie = composeTie(
            r.start && !stripStart.has(key(mi, ei, ni)),
            r.end && !stripEnd.has(key(mi, ei, ni))
          );
          const out = { ...n };
          if (tie === undefined) delete out.tie;
          else out.tie = tie;
          return out;
        });
      if (notes.length !== e.notes.length) touched = true;
      // The event survives either way — only its contents change.
      return { ...e, notes };
    });
    if (touched) changed.push(num(m, mi));
  });

  return { changed, strippedTies, retainedForTies };
}
