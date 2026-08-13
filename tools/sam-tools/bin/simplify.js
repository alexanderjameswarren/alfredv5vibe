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
  buildRunReport, buildOutputDoc, OutputDocError, confirmationNeeded,
} from "../lib/report.js";
import { regressionCheck, formatRegressions } from "../lib/regression.js";

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
// a fourth is not acceptable silently, so this refuses to write rather than
// warning. The fix is a plan change — a one-measure range with a different
// setting — not a code change.
const regressions = regressionCheck(song, output, { bpm });

const report = buildRunReport({ plan, analyzerTempo: bpm, result, input: song, output });
report.regressions = regressions;

// --- human-readable summary ----------------------------------------------

const list = (ns, cap = 12) =>
  ns.length <= cap ? ns.join(", ") : `${ns.slice(0, cap).join(", ")}, +${ns.length - cap} more`;

const total = song.measures.length;
const unablePct = Math.round((result.unable.length / total) * 100);

console.log(`simplify — "${song.title}" · ${total} measures · analyzer tempo ${bpm} BPM`);
if (plan.label) console.log(`  plan: ${plan.label}`);
console.log(
  `  transformed ${total - result.untouched.length - result.unable.length - result.unneeded.length}` +
    ` · untouched ${result.untouched.length} · unneeded ${result.unneeded.length} · unable ${result.unable.length} (${unablePct}%)`
);

for (const [label, rows] of [["unable", result.unable], ["unneeded", result.unneeded]]) {
  if (!rows.length) continue;
  const byCode = {};
  for (const r of rows) (byCode[r.code || "?"] ||= []).push(r.measure);
  for (const [code, ms] of Object.entries(byCode)) {
    console.log(`  ${label} [${code}] ${ms.length}: m${list(ms)}`);
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

if (regressions.length) {
  console.error(
    `
REFUSING TO WRITE — the transform made measures HARDER (§6):
` +
      `${formatRegressions(regressions)}

` +
      `Every one of these is a plan problem, not a code problem. Narrow the
` +
      `setting for the affected measures with a one-measure range, or leave
` +
      `them untouched with "settings": null.`
  );
  process.exit(1);
}

// --- confirmation (§7) ----------------------------------------------------
//
// Gated on `unable` only. A density-floor refusal is the tool working; asking
// the user to confirm that would be asking them to approve a success.

async function confirm(question) {
  if (!process.stdin.isTTY) return null; // cannot ask
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question(question, res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

if (!yes && confirmationNeeded({ unableCount: result.unable.length, measureCount: total })) {
  console.log(
    `\n${result.unable.length} of ${total} measures (${unablePct}%) could not be transformed:`
  );
  for (const u of result.unable) console.log(`  m${u.measure} ${u.hand}: ${u.reason}`);

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
