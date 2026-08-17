// Run report and output-document assembly (spec §8, §8.1, §9).
//
// The report is what a future UI reads, so every field is structured. No prose
// anywhere: `reason` strings exist because §8's shape names them, but each is
// paired with a machine-readable `code`, and nothing else is free text.

import { analyzeSong, SUMMARY_METRICS } from "./analyze.js";
import { effectiveSettings } from "./plan.js";

/** Contiguous runs in an ascending list of measure numbers. */
function runsOf(numbers) {
  const runs = [];
  for (const n of [...numbers].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && n === last[last.length - 1] + 1) last.push(n);
    else runs.push([n]);
  }
  return runs;
}

const runLabel = (run) => (run.length > 1 ? `${run[0]}-${run[run.length - 1]}` : `${run[0]}`);

/**
 * Untouched stretches shorter than `minLength` (§8.1).
 *
 * A one- or two-measure island of original difficulty inside simplified
 * material is a texture jump the player will hear. Reported, never acted on —
 * whether it matters is a musical judgement, not a mechanical one.
 */
export function shortUntouchedRuns(untouched, minLength = 3) {
  return runsOf(untouched)
    .filter((r) => r.length < minLength)
    .map((r) => ({ measures: r, length: r.length }));
}

/**
 * Other places the same printed measures appear (§8.1).
 *
 * Playback order is flattened, so a repeated section is written out twice with
 * the same `sourceMeasure` values. A plan range is applied LITERALLY — this is
 * information so the user can decide whether to cover the other copies too,
 * never an automatic expansion.
 */
export function repeatedRanges(measures, ranges) {
  const printedOf = (i) => measures[i]?.sourceMeasure ?? null;
  const numberOf = (i) => measures[i]?.number ?? i + 1;

  const out = [];
  for (const range of ranges) {
    const covered = new Set(range.measures);
    const printed = new Set(
      range.measures.map((n) => printedOf(n - 1)).filter((p) => p != null)
    );
    if (printed.size === 0) continue;

    const elsewhere = [];
    measures.forEach((_, i) => {
      const n = numberOf(i);
      if (covered.has(n)) return;
      const p = printedOf(i);
      if (p != null && printed.has(p)) elsewhere.push(n);
    });
    if (elsewhere.length === 0) continue;

    out.push({
      range: range.spec,
      alsoAppearsAt: runsOf(elsewhere).map(runLabel),
      measures: elsewhere,
    });
  }
  return out;
}

/**
 * Per-measure effective settings and outcome — one entry for every measure.
 *
 * The report already carries the plan, but its ranges are STRINGS
 * (`"37,57-61,68"`). Resolving those needs `parseMeasureList`, which lives here
 * and is not in the app bundle, so a client wanting to know "what ran on m32?"
 * would have to re-implement range parsing. This resolves it once, at write
 * time, where the plan object is already in hand.
 *
 * `status` is derived from what actually happened, not from what was asked:
 *
 *   untouched   — the plan said `settings: null`
 *   unable      — a transform could not run (§7); the measure stays too hard
 *   transformed — the output measure differs from the input
 *   unneeded    — nothing was refused and nothing changed
 *
 * A measure can be `unneeded` in one hand and transformed in the other — m18 of
 * Someone Like You hits the LH density floor while its RH is still thinned — so
 * the comparison is against the actual output rather than against the counters.
 * The per-hand detail stays available in `unable` / `unneeded`.
 *
 * `nonDefault` means the measure was covered by a range, so its settings differ
 * from the plan default. That is the flag a UI wants when highlighting "this
 * measure ran something unusual"; untouched measures are non-default too.
 */
export function resolvedSettings({ plan, result, input, output }) {
  const base = effectiveSettings(plan.defaultSettings);
  const baseJson = JSON.stringify(base);

  const unableAt = new Set(result.unable.map((u) => u.measure));

  return input.measures.map((m, i) => {
    const measure = m.number ?? i + 1;
    const settings = plan.settingsFor(measure);

    let status;
    if (settings === null) status = "untouched";
    else if (unableAt.has(measure)) status = "unable";
    else if (JSON.stringify(output.measures[i]) !== JSON.stringify(m)) status = "transformed";
    else status = "unneeded";

    return {
      measure,
      status,
      settings,
      nonDefault: settings === null || JSON.stringify(settings) !== baseJson,
    };
  });
}

/**
 * Measure-level tally of `resolvedSettings` statuses.
 *
 * THE ONLY ACCOUNTING PATH. The terminal summary used to derive its
 * `transformed` count arithmetically, as `total − untouched − unable −
 * unneeded`, reading arrays that `simplifyMeasures` only populates when a
 * transform actually declined. A plan with an empty default never reaches
 * either branch, so a 73-measure run in which 68 measures did not change
 * printed "transformed 73 · untouched 0 · unneeded 0" while
 * `resolvedSettings` — which compares the real output — correctly said 68
 * unneeded. Two accounting paths, and the wrong one was on screen.
 *
 * These four buckets are mutually exclusive and always sum to the measure
 * count, because every measure gets exactly one status. The per-hand detail
 * lives in `unable` / `unneeded`, where one measure may appear under one hand
 * while the other hand transformed.
 *
 * @param {Array<{status:string}>} resolved - from `resolvedSettings`
 * @returns {{transformed:number, untouched:number, unneeded:number, unable:number, total:number}}
 */
export function statusCounts(resolved = []) {
  const counts = { transformed: 0, untouched: 0, unneeded: 0, unable: 0, total: resolved.length };
  for (const r of resolved) {
    if (r.status in counts) counts[r.status]++;
  }
  return counts;
}

/** Compact metric block — summary plus which measures flag. */
export function metricsBlock(doc, bpm) {
  const a = analyzeSong(doc, { bpm });
  const summary = {};
  for (const [, key] of SUMMARY_METRICS) summary[key] = a.summary[key];
  return {
    measureCount: a.measureCount,
    flaggedCount: a.flagged.length,
    flagged: a.flagged,
    summary,
  };
}

/**
 * The structured run report written into `generationNotes` (§8).
 *
 * @returns {object} JSON-serialisable, no prose fields
 */
export function buildRunReport({ plan, analyzerTempo, result, input, output }) {
  return {
    reportVersion: 1,
    plan: plan.raw,
    analyzerTempo,
    // §7's two counters. Only `unable` gates confirmation; `unneeded` records a
    // guard that correctly declined and is never a reason to stop.
    unable: result.unable,
    unneeded: result.unneeded,
    untouched: result.untouched,
    // One entry per measure: effective settings + what actually happened.
    // Saves a client re-implementing range parsing to answer "what ran here?".
    resolvedSettings: resolvedSettings({ plan, result, input, output }),
    // §5.1: a mixed tie chain keeps the note and loses the marker. Every one
    // is listed so the re-articulations can be listened for.
    strippedTies: result.strippedTies,
    retainedForTies: result.retainedForTies,
    transformNotes: result.notes,
    // §8.1 advisories — reported, never acted on.
    melodyBlips: result.melodyBlips,
    shortUntouchedRuns: shortUntouchedRuns(result.untouched),
    repeatedRanges: repeatedRanges(input.measures, plan.ranges),
    metrics: {
      before: metricsBlock(input, analyzerTempo),
      after: metricsBlock(output, analyzerTempo),
    },
  };
}

/** Fraction of measures that may be `unable` before a run needs confirming. */
export const CONFIRM_THRESHOLD = 0.25;

/**
 * Does this run need confirming before it is written (§7)?
 *
 * Gated on `unable` ONLY. `unneeded` is a guard that correctly declined —
 * asking the user to confirm that would be asking them to approve a success.
 */
export function confirmationNeeded({ unableCount, measureCount, threshold = CONFIRM_THRESHOLD }) {
  if (!measureCount) return false;
  return unableCount / measureCount > threshold;
}

export class OutputDocError extends Error {
  constructor(message) {
    super(message);
    this.name = "OutputDocError";
  }
}

/**
 * Assemble the output song document (§9).
 *
 * A valid export document per docs/song-export-format.md, importable through
 * the SAM UI unmodified.
 */
export function buildOutputDoc({ input, measures, plan, report }) {
  // `songType: "simplified"` requires a parent, both in §9 and in the database
  // (sam_songs_lineage_check). Emitting one without a parent would produce a
  // document that cannot be imported, so refuse rather than write it.
  if (!plan.sourceSongId) {
    throw new OutputDocError(
      "plan has no `sourceSongId`, so the output cannot name a parent. " +
        "A simplified song requires one (spec §9; the database enforces it via " +
        "sam_songs_lineage_check). Add the source song's id to the plan."
    );
  }

  const title = plan.label ? `${input.title} (${plan.label})` : input.title;

  return {
    // Inherited verbatim (§9).
    ...input,
    formatVersion: input.formatVersion ?? 2,
    title,
    songType: "simplified",
    parentSongId: plan.sourceSongId,
    generationNotes: report,
    measures,
  };
}
