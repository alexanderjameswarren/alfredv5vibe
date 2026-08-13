// The transform engine (spec §4).
//
// Two passes with different scopes, and the difference matters:
//
//   LH quantization is per measure — a cell never reaches outside its bar.
//   RH thinning is song-level, because tie links cross barlines and a decision
//   about one endpoint constrains the other.
//
// Every setting in the vocabulary is now implemented. While one was not, an
// active-but-unbuilt setting threw rather than silently returning an unchanged
// song; the lasting form of that guard is the "no silent no-op" test, which
// asserts every non-OFF value either changes something or records a reason.
//
// Every output measure is a deep clone. The input document is never mutated,
// and output measures never alias each other — the parser shares event arrays
// between flattened repeats, so returning them directly would let an edit to
// one measure reach into a different one.

import { lhActive } from "./plan.js";
import { quantizeHand } from "./lhGrid.js";
import { thinRightHand } from "./rhThin.js";
import { analyzeMelodyBlips } from "./analyze.js";

/**
 * Apply a plan to a song document's measures.
 *
 * @param {object} doc - source song document (never mutated)
 * @param {object} plan - a plan from loadPlan()
 * @returns {{measures: object[], untouched: number[], unable: object[],
 *            unneeded: object[], notes: object[], melodyBlips: object[],
 *            strippedTies: object[], retainedForTies: object[]}}
 */
export function simplifyMeasures(doc, plan) {
  const measures = [];
  const untouched = [];
  // Spec §7: two counters, deliberately separate. Only `unable` gates the
  // confirmation threshold — a density-floor refusal is the tool working, not
  // something for a human to approve.
  const unable = [];
  const unneeded = [];
  const notes = [];

  doc.measures.forEach((m, i) => {
    const number = m.number ?? i + 1;
    const settings = plan.settingsFor(number);
    const out = structuredClone(m);

    // `settings: null` means leave this measure at original difficulty.
    if (settings === null) {
      measures.push(out);
      untouched.push(number);
      return;
    }

    if (lhActive(settings)) {
      const r = quantizeHand(out.lh || [], settings, out.timeSignature);
      if (r.changed) {
        out.lh = r.events;
      } else if (r.reason) {
        // Skip-and-flag (§7): the measure stays at original difficulty and the
        // reason is recorded. Never a silent skip, never a failed run.
        const bucket = r.kind === "unneeded" ? unneeded : unable;
        bucket.push({ measure: number, hand: "lh", code: r.code, reason: r.reason });
      }
      if (r.note) notes.push({ measure: number, hand: "lh", ...r.note });
    }

    measures.push(out);
  });

  // RH thinning, song-level, writing into the clones built above.
  const rh = thinRightHand(measures, (n) => plan.settingsFor(n));

  return {
    measures,
    untouched,
    unable,
    unneeded,
    notes,
    strippedTies: rh.strippedTies,
    retainedForTies: rh.retainedForTies,
    // Reported, never corrected (§4.4, §8.1). Measured on the INPUT, because
    // that is where they can be heard and checked against the printed score.
    melodyBlips: analyzeMelodyBlips(doc.measures),
  };
}
