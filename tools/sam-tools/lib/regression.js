// Regression check (spec §6).
//
// After transforming, analyse input and output at the SAME tempo and compare
// per measure. If any metric is worse in the output than in the input for any
// measure, that is reported — a transform that fixes three metrics while
// degrading a fourth is not acceptable silently.
//
// This is not theoretical. It was written because `union` fill was observed to
// raise LH jump above the original during prototyping, and the first run of the
// real engine turned up two more: a pooled-token rhythmVariety that punished
// the transform for simplifying (since fixed in analyze.js), and a genuine LH
// jump regression at Someone Like You m32.
//
// The DETECTION here is unchanged and deliberately absolute. What changed is
// the consequence: bin/simplify.js now confirms rather than refuses, because
// this check is per-measure and cannot see the song. On The Entertainer it
// fired on fifteen bars for LH jump while the song's MEDIAN worst leap fell
// from 12 to 5 — a result worth hearing, not a result worth blocking.
// `formatRegressionContext` exists to put that second number in front of
// whoever is answering the prompt.

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

/** The distinct metrics a regression list touches, in SUMMARY_METRICS order. */
export function affectedMetrics(worse) {
  const hit = new Set(worse.map((w) => w.metric));
  return REGRESSION_METRICS.filter((m) => hit.has(m.key));
}

/**
 * Song-level before/after for every metric the regressions touch (§6).
 *
 * The per-measure list says what got worse; this says what happened to the
 * song. Both are needed to answer the prompt honestly — fifteen bars worse on
 * LH jump reads very differently next to a median that halved.
 *
 * Reads the summaries the run report already computed rather than analysing
 * the document a third and fourth time.
 *
 * @param {Array} worse - from `regressionCheck`
 * @param {{before:{summary:object}, after:{summary:object}}} metrics - report.metrics
 * @returns {string} empty when there is nothing to add
 */
export function formatRegressionContext(worse, metrics) {
  const n = (x) => (x == null ? "-" : Number.isInteger(x) ? String(x) : x.toFixed(2));
  const rows = [];
  for (const { key, label } of affectedMetrics(worse)) {
    const b = metrics?.before?.summary?.[key];
    const a = metrics?.after?.summary?.[key];
    if (!b || !a) continue;
    const count = worse.filter((w) => w.metric === key).length;
    rows.push(
      `  ${label.padEnd(14)} median ${n(b.median)} → ${n(a.median)}` +
        `   p90 ${n(b.p90)} → ${n(a.p90)}` +
        `   max ${n(b.max)} → ${n(a.max)}` +
        `   (worse on ${count} measure${count === 1 ? "" : "s"})`
    );
  }
  if (!rows.length) return "";
  return `song-level, the same metrics:\n${rows.join("\n")}`;
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
