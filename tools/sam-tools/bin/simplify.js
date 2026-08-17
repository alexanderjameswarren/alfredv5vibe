#!/usr/bin/env node
//
// Produce a simplified version of a song (spec §2).
//
//   npm run simplify -- <song.json> --plan <plan.json> -o <out.json> --bpm 67
//
// Reads two files, writes one. Never touches the network or the database — the
// output is imported through the SAM UI by hand.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { loadPlan, PlanError, inertSettings } from "../lib/plan.js";
import { simplifyMeasures } from "../lib/simplify.js";
import { assertVerified, InvariantError } from "../lib/verify.js";
import {
  buildRunReport, buildOutputDoc, OutputDocError, confirmationNeeded, statusCounts,
} from "../lib/report.js";
import {
  regressionCheck, formatRegressions, formatRegressionContext,
} from "../lib/regression.js";

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    "usage: node bin/simplify.js <song.json> --plan <plan.json> -o <out.json> --bpm <n>\n\n" +
      "  --plan <file>    required. See lib/plan.schema.json.\n" +
      "  -o <file>        required. Output song document.\n" +
      "  --bpm <n>        required. Quarter notes per minute, for the before/after\n" +
      "                   metrics. Deliberately not read from the document —\n" +
      "                   stored tempos are unreliable (song-export-format §7).\n" +
      "  --report <file>  optional. Write the run report separately as well.\n" +
      "  --yes            optional. Skip the confirmation prompt.\n"
  );
  process.exit(1);
}

const args = process.argv.slice(2);
let songPath = null;
let planPath = null;
let outPath = null;
let reportPath = null;
let bpm = null;
let yes = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--plan") planPath = args[++i];
  else if (a === "-o" || a === "--out") outPath = args[++i];
  else if (a === "--report") reportPath = args[++i];
  else if (a === "--bpm") bpm = Number(args[++i]);
  else if (a === "--yes") yes = true;
  else if (a.startsWith("-")) usage(`unknown option ${a}`);
  else if (songPath === null) songPath = a;
  else usage("more than one input song");
}

if (!songPath) usage("no input song");
if (!planPath) usage("--plan is required");
if (!outPath) usage("-o is required");
if (!(bpm > 0)) usage("--bpm <n> is required");

const readJson = (p, what) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    usage(`could not read ${what} ${p}: ${e.message}`);
  }
};

const song = readJson(songPath, "song");
if (!Array.isArray(song.measures) || song.measures.length === 0) {
  usage(`${songPath} is not a SAM export document (no measures)`);
}

let plan;
try {
  plan = loadPlan(planPath, { measureCount: song.measures.length });
} catch (e) {
  if (e instanceof PlanError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}

// --- transform ------------------------------------------------------------

let result;
try {
  result = simplifyMeasures(song, plan);
} catch (e) {
  console.error(`transform failed: ${e.message}`);
  process.exit(1);
}

const output = { ...song, measures: result.measures };

// Invariants are hard errors (§5), not warnings. Nothing is written if any
// one of the eight fails.
try {
  assertVerified(song, output);
} catch (e) {
  if (e instanceof InvariantError) {
    console.error(`REFUSING TO WRITE — the output violates the invariants:\n${e.message}`);
    process.exit(1);
  }
  throw e;
}

// Regression check (§6). A transform that fixes three metrics while degrading
// a fourth is not acceptable SILENTLY — so every regression is printed in full
// below and recorded in the run report. It is not, however, a refusal: see the
// confirmation block at the bottom for why.
const regressions = regressionCheck(song, output, { bpm });

const report = buildRunReport({ plan, analyzerTempo: bpm, result, input: song, output });
report.regressions = regressions;

// --- human-readable summary ----------------------------------------------

const list = (ns, cap = 12) =>
  ns.length <= cap ? ns.join(", ") : `${ns.slice(0, cap).join(", ")}, +${ns.length - cap} more`;

const total = song.measures.length;

// One accounting path (§7). These four counts come from `resolvedSettings`,
// which decides each measure's status by comparing the actual output, so they
// are mutually exclusive and sum to `total`. Deriving `transformed` by
// subtraction instead reported 73 transformed measures on a run where 68 were
// untouched, because a plan with an empty default populates neither counter
// array. Every number on screen and in the prompt below now comes from here.
const counts = statusCounts(report.resolvedSettings);
const unablePct = Math.round((counts.unable / total) * 100);

console.log(`simplify — "${song.title}" · ${total} measures · analyzer tempo ${bpm} BPM`);
if (plan.label) console.log(`  plan: ${plan.label}`);
console.log(
  `  transformed ${counts.transformed} · untouched ${counts.untouched}` +
    ` · unneeded ${counts.unneeded} · unable ${counts.unable} (${unablePct}%)`
);

// Per-hand detail, which is a different question from the measure-level tally
// above: a measure whose LH hit the density floor is `unneeded` here and still
// `transformed` there if its RH was thinned. Named by hand so the two counts
// are not read as the same number.
for (const [label, rows] of [["unable", result.unable], ["unneeded", result.unneeded]]) {
  if (!rows.length) continue;
  const byGroup = {};
  for (const r of rows) (byGroup[`${r.hand} ${label} [${r.code || "?"}]`] ||= []).push(r.measure);
  for (const [group, ms] of Object.entries(byGroup)) {
    console.log(`  ${group} ${ms.length}: m${list(ms)}`);
  }
}

const inert = inertSettings(plan.defaultSettings);
if (inert.length) {
  console.log(`  note: ${inert.join(", ")} set but inert — their parent transform is off`);
}
if (report.strippedTies.length) {
  console.log(
    `  ties re-articulated (mixed chains, §5.1): ${report.strippedTies.length}` +
      ` at m${list([...new Set(report.strippedTies.map((t) => t.measure))])}`
  );
}
if (report.retainedForTies.length) {
  console.log(`  notes retained to keep a tie whole: ${report.retainedForTies.length}`);
}
for (const r of report.shortUntouchedRuns) {
  console.log(`  advisory: untouched run of ${r.length} at m${r.measures.join(", m")} — texture jump`);
}
for (const r of report.repeatedRanges) {
  console.log(`  advisory: range "${r.range}" also appears at m${r.alsoAppearsAt.join(", m")}`);
}
if (report.melodyBlips.length) {
  console.log(`  advisory: ${report.melodyBlips.length} melody blips — reported, not corrected`);
}
console.log(
  `  flagged ${report.metrics.before.flaggedCount}/${total} -> ${report.metrics.after.flaggedCount}/${total}`
);

// --- confirmation (§6 + §7) -----------------------------------------------
//
// TWO independent reasons a run needs a human, sharing ONE prompt. Being asked
// twice about a single run is worse than being asked once about two things.
//
// §7 — too many measures the transform could not touch. Gated on `unable`
// only: a density-floor decline is the tool working, and asking someone to
// confirm that would be asking them to approve a success.
//
// §6 — a measure got harder on some metric. This USED to refuse outright. It
// no longer does, for the reason that settled §7: a bad result you can hear
// and archive beats a result you are blocked from producing. The argument is
// stronger here, because the check is per-measure and absolute and therefore
// cannot see the song. On The Entertainer it fired on fifteen bars for LH jump
// while the song's median worst leap fell from 12 to 5; it also fires on m1
// going 4 → 5, which is noise on a metric that has no flag threshold at all.
// So the check still runs unchanged and still reports every regression, into
// the run report as well as onto the terminal — only the consequence is now a
// question rather than an exit.

async function confirm(question) {
  if (!process.stdin.isTTY) return null; // cannot ask
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question(question, res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// §7's threshold is "more than 25% of MEASURES are unable", so it counts
// measures, from the same tally the summary printed. `result.unable` is the
// per-hand list; feeding it here would let one measure count twice once a
// second hand can refuse.
const unableNeedsConfirm = confirmationNeeded({
  unableCount: counts.unable,
  measureCount: total,
});

if (!yes && (regressions.length || unableNeedsConfirm)) {
  if (regressions.length) {
    console.log(`\nSOME MEASURES GOT HARDER (§6) — ${formatRegressions(regressions)}`);
    // The list above is per-measure; this is what happened to the song. Both
    // are needed to answer the question below honestly.
    const context = formatRegressionContext(regressions, report.metrics);
    if (context) console.log(`\n${context}`);
    console.log(
      "\nNarrowing the setting for those measures with a one-measure range, or\n" +
        'leaving them untouched with "settings": null, is usually the fix. Weigh\n' +
        "that against the song-level figures before deciding."
    );
  }

  if (unableNeedsConfirm) {
    console.log(
      `\n${counts.unable} of ${total} measures (${unablePct}%) could not be transformed:`
    );
    for (const u of result.unable) console.log(`  m${u.measure} ${u.hand}: ${u.reason}`);
  }

  const ok = await confirm("\nWrite the output anyway? [y/N] ");
  if (ok === null) {
    console.error(
      "\nNot a terminal, so this cannot be confirmed interactively. " +
        "Re-run with --yes to write it regardless. Nothing was written."
    );
    process.exit(2);
  }
  if (!ok) {
    console.log("Aborted. Nothing was written.");
    process.exit(0);
  }
}

// --- write ----------------------------------------------------------------

let doc;
try {
  doc = buildOutputDoc({ input: song, measures: result.measures, plan, report });
} catch (e) {
  if (e instanceof OutputDocError) {
    console.error(`cannot assemble the output document: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(doc, null, 2));
console.log(`\nwrote ${outPath} — "${doc.title}"`);

if (reportPath) {
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`wrote ${reportPath}`);
}
