// The transform engine (spec §4).
//
// M2 stage: the measure loop, settings resolution and the identity path. The
// two transforms themselves land in M3 (LH grid) and M4 (RH thinning); until
// then, asking for one is a loud error rather than a silent no-op — a plan
// that says `lhGrid: quarter` must never quietly produce an unchanged song.
//
// Every output measure is a deep clone. The input document is never mutated.

import { lhActive, rhActive } from "./plan.js";

class NotImplementedYet extends Error {
  constructor(what, milestone) {
    super(`${what} is not implemented yet (${milestone}). Remove it from the plan or wait for that milestone.`);
    this.name = "NotImplementedYet";
  }
}

/**
 * Apply a plan to a song document's measures.
 *
 * @param {object} doc - source song document (never mutated)
 * @param {object} plan - a plan from loadPlan()
 * @returns {{measures: object[], untouched: number[], skipped: object[]}}
 */
export function simplifyMeasures(doc, plan) {
  const measures = [];
  const untouched = [];
  const skipped = [];

  doc.measures.forEach((m, i) => {
    const number = m.number ?? i + 1;
    const settings = plan.settingsFor(number);

    // `settings: null` means leave this measure at original difficulty. Cloned
    // so callers can never write through into the source document.
    if (settings === null) {
      measures.push(structuredClone(m));
      untouched.push(number);
      return;
    }

    const out = structuredClone(m);

    if (lhActive(settings)) {
      throw new NotImplementedYet(`lhGrid: "${settings.lhGrid}"`, "M3");
    }
    if (rhActive(settings)) {
      throw new NotImplementedYet(`rhStack: "${settings.rhStack}"`, "M4");
    }

    measures.push(out);
  });

  return { measures, untouched, skipped };
}

export { NotImplementedYet };
