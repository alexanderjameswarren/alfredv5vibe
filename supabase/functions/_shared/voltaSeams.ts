// The volta-seam rule for tie STARTS — Deno/TS port of
// tools/sam-tools/lib/voltaSeams.js. A faithful port: function bodies mirror
// the original statement for statement, and
// tools/sam-tools/test/analyzerParity.test.js fails if the two disagree.
//
// A tie start that is never closed is not automatically a defect. In a score
// with first and second endings, the last note of the bar before the endings is
// often tied into the first ending; when playback is flattened, the SECOND pass
// through that bar continues into the second ending instead, which does not
// close the tie. That is a source-authoring choice, not corruption.
//
// A start is a volta-seam start iff:
//   (1) its printed measure (`sourceMeasure`) is played more than once, AND
//   (2) the next-played printed measure differs across those plays, AND
//   (3) the start is the FINAL event of its hand in that measure.
//
// `findSeams` cannot answer this: it parses printed numbers, and MuseScore
// labels ending brackets X1–X4, so `parseInt("X2")` is NaN. This rule never
// parses the label.
//
// A measure with no printed number is never a seam: there is nothing to have
// been played twice.

interface Labelled {
  sourceMeasure?: string | number | null;
}

type HandEvents = { rh?: unknown[]; lh?: unknown[] };

const hasLabel = (m: Labelled | undefined): boolean => m?.sourceMeasure != null;
const labelOf = (m: Labelled): string => String(m.sourceMeasure);

/**
 * The printed measure labels that sit before a volta seam — conditions (1)
 * and (2) above.
 *
 * @param measures - playback order
 * @returns labels, as strings
 */
export function voltaSeamSources(measures: Labelled[]): Set<string> {
  const nextsByLabel = new Map<string, (string | null)[]>(); // label -> next label per play
  for (let i = 0; i < measures.length; i++) {
    const m = measures[i];
    if (!hasLabel(m)) continue;
    const next = measures[i + 1];
    const nextLabel = next === undefined ? null : hasLabel(next) ? labelOf(next) : null;
    const label = labelOf(m);
    if (!nextsByLabel.has(label)) nextsByLabel.set(label, []);
    nextsByLabel.get(label)!.push(nextLabel);
  }
  const out = new Set<string>();
  for (const [label, nexts] of nextsByLabel) {
    if (nexts.length >= 2 && new Set(nexts).size > 1) out.add(label);
  }
  return out;
}

/**
 * Is the tie start at `measure[hand][eventIndex]` a volta-seam start? Adds
 * condition (3) to the precomputed `seamSources`.
 */
export function isVoltaSeamStart(
  seamSources: Set<string>,
  measure: Labelled & HandEvents,
  hand: "rh" | "lh",
  eventIndex: number,
): boolean {
  if (!hasLabel(measure)) return false;
  const events = measure[hand] || [];
  return eventIndex === events.length - 1 && seamSources.has(labelOf(measure));
}
