// Auto-Match: one syllable per right-hand note, in order, skipping rests and —
// with skipTiedNotes — tied continuations. Shared by the drawer's Auto-Match
// button and the Lyrics sheet's save.
//
// Returns placements for the syllables that fit, and how many did not.
export function matchSyllablesToNotes(measures, lyrics, { skipTiedNotes = true } = {}) {
  const placements = [];
  let syllableIdx = 0;

  for (const measure of measures || []) {
    if (syllableIdx >= lyrics.length) break;
    const rh = measure.rh || [];
    for (let rhIdx = 0; rhIdx < rh.length; rhIdx++) {
      if (syllableIdx >= lyrics.length) break;
      const evt = rh[rhIdx];
      if (!evt.notes || evt.notes.length === 0) continue;
      if (skipTiedNotes && evt.notes.every((n) => n.tie === "end" || n.tie === "both")) continue;
      placements.push({
        word_order: lyrics[syllableIdx].word_order,
        measure_num: measure.number,
        rh_index: rhIdx,
      });
      syllableIdx++;
    }
  }

  return { placements, unplaced: lyrics.length - syllableIdx };
}
