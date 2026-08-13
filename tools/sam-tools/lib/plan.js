// Simplifier plan loading, validation and measure resolution (spec §3).
//
// A plan is a COMPLETE description of a desired output, not a patch. Every
// version is generated from the original song, so plans compose and nothing
// degrades cumulatively.
//
// Everything here is a hard error. An unknown setting key, an unknown enum
// value, an overlapping range, a measure outside the song, a malformed range
// string — all throw. That strictness is the point: the settings vocabulary is
// the boundary between "a model chose from a list" and "a model wrote music",
// and a typo that silently degrades to a default would erode it.
//
// OPEN QUESTION, deliberately not decided here — see the progress file Notes.
// Spec §4 gives a default per setting, but progress M2 expects `default: {}` to
// produce an identity transform. Those disagree: filling omissions from the §4
// table would make `{}` mean quarter-grid + melody-only, which is not identity.
// This loader therefore merges PARTIALS ONLY (range settings over plan default,
// key by key) and never invents a value. What an absent key means at transform
// time is M3's decision, not the loader's.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  fs.readFileSync(path.join(here, "plan.schema.json"), "utf8")
);

const ajv = new Ajv({ allErrors: true, strict: false, verbose: true });
const validatePlanStructure = ajv.compile(schema);

/** The settings vocabulary, in spec order. */
export const SETTING_KEYS = ["lhGrid", "lhFill", "lhCap", "lhKeep", "rhStack"];

/**
 * The per-setting defaults from spec §4, recorded for reference.
 *
 * NOT APPLIED by this loader — see the header note. Resolve the §4-vs-M2
 * conflict before wiring these into the transform.
 */
export const SPEC_SETTING_DEFAULTS = Object.freeze({
  lhGrid: "quarter",
  lhFill: "onset",
  lhCap: 2,
  lhKeep: "root-third",
  rhStack: "melody-only",
});

/** Thrown for any plan problem. `errors` holds every message, not just the first. */
export class PlanError extends Error {
  constructor(errors, context) {
    const list = Array.isArray(errors) ? errors : [errors];
    super(
      `Plan invalid${context ? ` (${context})` : ""}:\n` +
        list.map((e) => `  • ${e}`).join("\n")
    );
    this.name = "PlanError";
    this.errors = list;
  }
}

// --- range strings --------------------------------------------------------

/**
 * Parse a measure-list string into ascending measure numbers.
 *
 *   "37,57-61, 68"  ->  [37, 57, 58, 59, 60, 61, 68]
 *
 * Whitespace anywhere is tolerated. Everything else is a hard error, including
 * a duplicate WITHIN one string ("37,37"): the effect is identical to an
 * overlap between two ranges, and silently de-duplicating a typo would hide a
 * mistake the author wants to hear about.
 *
 * @param {string} spec
 * @returns {number[]} ascending, no duplicates
 */
export function parseMeasureList(spec) {
  if (typeof spec !== "string") {
    throw new PlanError(`measure list must be a string, got ${typeof spec}`);
  }
  const errors = [];
  const seen = new Map(); // measure -> the token that produced it
  const out = [];

  const tokens = spec.split(",");
  for (const raw of tokens) {
    const token = raw.trim();
    if (token === "") {
      errors.push(`empty entry in measure list "${spec}" (stray or trailing comma?)`);
      continue;
    }

    const range = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    const single = /^(\d+)$/.exec(token);
    let from;
    let to;

    if (single) {
      from = to = Number(single[1]);
    } else if (range) {
      from = Number(range[1]);
      to = Number(range[2]);
      if (from > to) {
        errors.push(`descending range "${token}" — write it as "${to}-${from}"`);
        continue;
      }
    } else {
      errors.push(
        `malformed entry "${token}" in measure list "${spec}" — expected a number like "37" or a range like "57-61"`
      );
      continue;
    }

    if (from < 1) {
      errors.push(`measure numbers start at 1, got "${token}"`);
      continue;
    }

    for (let m = from; m <= to; m++) {
      if (seen.has(m)) {
        errors.push(
          `measure ${m} appears more than once in "${spec}" (in "${seen.get(m)}" and "${token}")`
        );
        continue;
      }
      seen.set(m, token);
      out.push(m);
    }
  }

  if (errors.length) throw new PlanError(errors);
  return out.sort((a, b) => a - b);
}

// --- structural validation ------------------------------------------------

/**
 * Turn one Ajv error into a message that names the offending key. Vocabulary
 * drift is the thing this guards against, so "which key, which value, what was
 * allowed" has to survive into the message.
 */
function formatAjvError(e) {
  const at = e.instancePath || "(root)";
  if (e.keyword === "additionalProperties") {
    return `unknown key "${e.params.additionalProperty}" at ${at} — not part of the settings vocabulary`;
  }
  if (e.keyword === "enum") {
    const allowed = (e.params.allowedValues || []).map((v) => JSON.stringify(v)).join(", ");
    return `${at}: ${JSON.stringify(e.data)} is not a valid value — allowed: ${allowed}`;
  }
  if (e.keyword === "required") {
    return `${at}: missing required key "${e.params.missingProperty}"`;
  }
  if (e.keyword === "type") {
    return `${at}: expected ${e.params.type}, got ${JSON.stringify(e.data)}`;
  }
  if (e.keyword === "oneOf") {
    return `${at}: must be null (untouched) or a settings object`;
  }
  return `${at}: ${e.message}`;
}

// --- loading --------------------------------------------------------------

/**
 * Load, validate and resolve a plan.
 *
 * @param {string|object} planOrPath - a path to read, or an already-parsed plan
 * @param {{measureCount: number}} opts - the source song's measure count, used
 *   to reject out-of-range measure numbers. PLAYED numbers (`number`), which
 *   run 1..measureCount.
 * @returns {{
 *   planVersion: number,
 *   label: string|null,
 *   sourceSongId: string|null,
 *   defaultSettings: object,
 *   ranges: Array<{spec: string, measures: number[], settings: object|null}>,
 *   settingsFor: (measure: number) => object|null,
 *   untouchedMeasures: number[],
 *   raw: object
 * }}
 */
export function loadPlan(planOrPath, { measureCount } = {}) {
  if (!Number.isInteger(measureCount) || measureCount < 1) {
    throw new PlanError(
      `measureCount must be a positive integer to range-check a plan, got ${JSON.stringify(measureCount)}`
    );
  }

  let plan;
  let context = null;
  if (typeof planOrPath === "string") {
    context = path.basename(planOrPath);
    let text;
    try {
      text = fs.readFileSync(planOrPath, "utf8");
    } catch (e) {
      throw new PlanError(`could not read ${planOrPath}: ${e.message}`);
    }
    try {
      plan = JSON.parse(text);
    } catch (e) {
      throw new PlanError(`could not parse JSON: ${e.message}`, context);
    }
  } else {
    plan = planOrPath;
  }

  if (!validatePlanStructure(plan)) {
    throw new PlanError(
      (validatePlanStructure.errors || []).map(formatAjvError),
      context
    );
  }

  // Ranges: parse, range-check, then check for overlap ACROSS ranges. Each
  // stage collects everything it finds rather than stopping at the first
  // problem — fixing a plan one error per run is miserable.
  const errors = [];
  const ranges = [];
  const owner = new Map(); // measure -> index of the range that claimed it

  (plan.ranges || []).forEach((r, i) => {
    let measures;
    try {
      measures = parseMeasureList(r.measures);
    } catch (e) {
      errors.push(...e.errors.map((m) => `ranges[${i}]: ${m}`));
      return;
    }

    const outOfRange = measures.filter((m) => m > measureCount);
    if (outOfRange.length) {
      errors.push(
        `ranges[${i}] ("${r.measures}"): measure ${outOfRange.join(", ")} ` +
          `outside the song, which has ${measureCount} measures`
      );
    }

    for (const m of measures) {
      if (owner.has(m)) {
        errors.push(
          `measure ${m} appears in more than one range ` +
            `(ranges[${owner.get(m)}] "${plan.ranges[owner.get(m)].measures}" and ` +
            `ranges[${i}] "${r.measures}") — overlaps are rejected, not resolved by order`
        );
      } else {
        owner.set(m, i);
      }
    }

    ranges.push({ spec: r.measures, measures, settings: r.settings ?? null });
  });

  if (errors.length) throw new PlanError(errors, context);

  const defaultSettings = { ...plan.default };

  // Per-measure resolution. `null` means untouched; otherwise the range's
  // partial settings override the plan default key by key. No key is invented.
  const perMeasure = new Array(measureCount + 1).fill(undefined);
  for (let m = 1; m <= measureCount; m++) perMeasure[m] = { ...defaultSettings };
  for (const r of ranges) {
    for (const m of r.measures) {
      perMeasure[m] = r.settings === null ? null : { ...defaultSettings, ...r.settings };
    }
  }

  const untouchedMeasures = [];
  for (let m = 1; m <= measureCount; m++) {
    if (perMeasure[m] === null) untouchedMeasures.push(m);
  }

  return {
    planVersion: plan.planVersion,
    label: plan.label ?? null,
    sourceSongId: plan.sourceSongId ?? null,
    defaultSettings,
    ranges,
    untouchedMeasures,
    settingsFor(measure) {
      if (!Number.isInteger(measure) || measure < 1 || measure > measureCount) {
        throw new PlanError(
          `measure ${measure} is outside the song (1..${measureCount})`
        );
      }
      return perMeasure[measure];
    },
    raw: plan,
  };
}
