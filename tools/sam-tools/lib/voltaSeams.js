// The volta-seam rule for tie STARTS — one definition, shared.
//
// A tie start that is never closed is not automatically a defect. In a score
// with first and second endings, the last note of the bar before the endings is
// often tied into the first ending; when playback is flattened, the SECOND pass
// through that bar continues into the second ending instead, which does not
// close the tie. That is a source-authoring choice, not corruption.
//
// The rule (Alex, 2026-08-05, originally inline in validate.js as
// `volta_seam_tie`). A start is a volta-seam start iff:
//   (1) its printed measure (`sourceMeasure`) is played more than once, AND
//   (2) the next-played printed measure differs across those plays, AND
//   (3) the start is the FINAL event of its hand in that measure.
//
// Used by validate.js (which reports per pitch: a pitch whose every open
// start is a seam is `volta_seam_tie`, otherwise `orphan_tie`) and by
// analyze.js (which labels each unclosed start `seam` or `orphan`). Same rule,
// different reporting granularity — the two cannot drift because neither
// restates it. The Edge Function port is supabase/functions/_shared/voltaSeams.ts,
// held to this file by tools/sam-tools/test/analyzerParity.test.js.
//
// Why not `findSeams`? It compares printed numbers with parseInt, and MuseScore
// labels ending brackets X1–X4, so `parseInt("X2")` is NaN and exactly these
// seams are skipped. This rule never parses the label; it only asks whether
// the same label is followed by different labels on different plays.
//
// A measure with no printed number (null / absent sourceMeasure — hand-authored
// drills, MCP-created songs) is never a seam: there is nothing to have been
// played twice. Without that guard, every unlabelled measure would share one
// "label" and look like a single bar played many times.

const hasLabel = (m) => m?.sourceMeasure != null;
const labelOf = (m) => String(m.sourceMeasure);

/**
 * The printed measure labels that sit before a volta seam — conditions (1)
 * and (2) above.
 *
 * @param {Array<{sourceMeasure?: string|number|null}>} measures - playback order
 * @returns {Set<string>} labels, as strings
 */
export function voltaSeamSources(measures) {
  const nextsByLabel = new Map(); // label -> [next label per play, null at the end]
  for (let i = 0; i < measures.length; i++) {
    const m = measures[i];
    if (!hasLabel(m)) continue;
    const next = measures[i + 1];
    const nextLabel = next === undefined ? null : hasLabel(next) ? labelOf(next) : null;
    const label = labelOf(m);
    if (!nextsByLabel.has(label)) nextsByLabel.set(label, []);
    nextsByLabel.get(label).push(nextLabel);
  }
  const out = new Set();
  for (const [label, nexts] of nextsByLabel) {
    if (nexts.length >= 2 && new Set(nexts).size > 1) out.add(label);
  }
  return out;
}

/**
 * Is the tie start at `measure[hand][eventIndex]` a volta-seam start? Adds
 * condition (3) to the precomputed `seamSources`.
 *
 * @param {Set<string>} seamSources - from voltaSeamSources(measures)
 * @param {object} measure
 * @param {"rh"|"lh"} hand
 * @param {number} eventIndex
 * @returns {boolean}
 */
export function isVoltaSeamStart(seamSources, measure, hand, eventIndex) {
  if (!hasLabel(measure)) return false;
  const events = measure[hand] || [];
  return eventIndex === events.length - 1 && seamSources.has(labelOf(measure));
}
