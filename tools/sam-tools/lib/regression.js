// Regression check (spec §6).
//
// After transforming, analyse input and output at the SAME tempo and compare
// per measure. If any metric is worse in the output than in the input for any
// measure, that is an ERROR — a transform that fixes three metrics while
// degrading a fourth is not acceptable silently.
//
// This is not theoretical. It was written because `union` fill was observed to
// raise LH jump above the original during prototyping, and the first run of the
// real engine turned up two more: a pooled-token rhythmVariety that punished
// the transform for simplifying (since fixed in analyze.js), and a genuine LH
// jump regression at Someone Like You m32.

import { analyzeSong, SUMMARY_METRICS } from "./analyze.js";

/**
 * Metrics where a HIGHER value means harder to play, so an increase is a
 * regression. Every metric the analyzer reports is of this kind — there is no
 * metric here where more is better, which is why the comparison is a simple
 * greater-than.
 */
export const REGRESSION_METRICS = SUMMARY_METRICS.map(([label, key]) => ({ label, key }));

const EPS = 1e-9;

/**
 * @param {object} input - source document
 * @param {object} output - transformed document
 * @param {{bpm:number}} opts - the same tempo for both, per §6
 * @returns {Array<{measure:number, metric:string, label:string, before:number, after:number}>}
 */
export function regressionCheck(input, output, { bpm }) {
  const a = analyzeSong(input, { bpm });
  const b = analyzeSong(output, { bpm });

  const worse = [];
  const n = Math.min(a.measures.length, b.measures.length);
  for (let i = 0; i < n; i++) {
    for (const { key, label } of REGRESSION_METRICS) {
      const before = a.measures[i][key];
      const after = b.measures[i][key];
      if (before == null || after == null) continue; // accidentals with no key
      if (after > before + EPS) {
        worse.push({ measure: a.measures[i].number, metric: key, label, before, after });
      }
    }
  }
  return worse;
}

/** Human-readable report naming the measure, the metric and both values (§6). */
export function formatRegressions(worse, { limit = 30 } = {}) {
  if (worse.length === 0) return "no metric got worse in any measure";
  const shown = worse.slice(0, limit);
  const lines = shown.map(
    (w) => `  • m${w.measure} ${w.label}: ${w.before} → ${w.after}`
  );
  if (worse.length > shown.length) lines.push(`  • …and ${worse.length - shown.length} more`);
  return `${worse.length} metric regression(s):\n${lines.join("\n")}`;
}

export class RegressionError extends Error {
  constructor(worse) {
    super(formatRegressions(worse));
    this.name = "RegressionError";
    this.regressions = worse;
  }
}

/** Throws when any measure got worse on any metric. */
export function assertNoRegression(input, output, opts) {
  const worse = regressionCheck(input, output, opts);
  if (worse.length) throw new RegressionError(worse);
  return true;
}
