#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { readScoreXml } from "../lib/mxl.js";
import { validate } from "../lib/validate.js";

const SEVERITY = {
  parse_error: 0,
  voice_collision: 1,
  tuplet_scaling: 1,
  content_divergence: 1,
  hand_assignment_mismatch: 1,
  measure_overflow: 1,
  incomplete_measure: 1,
  anacrusis: 5,
  unresolved_navigation: 2,
  unflattened_repeat: 2,
  gap_fill_inexact: 3,
  unknown_duration: 3,
  orphan_tie: 3,
  // Narrowed volta-seam sibling of orphan_tie. Informational
  // (severity 5) — the source composer's second-ending choice, not a
  // parser defect. See validate.js's tie-integrity walk for the
  // triangulation criteria.
  volta_seam_tie: 5,
  // cross_staff is INFORMATIONAL under spec §3.6 (cross-staff engraving is
  // expected input, not a defect). Actual routing mistakes on a cross-staff
  // measure surface as content_divergence, tuplet_scaling, or a sum-side
  // measure_overflow / incomplete_measure. Severity 5 keeps it visible
  // alongside grace_dropped without contributing to BLOCKED status.
  cross_staff: 5,
  notes_unsorted: 5,
  grace_dropped: 5,
  // key_mode_wrong: demoted to 5 (informational) 2026-08-05 (M6 audit).
  // Source-quality signal — parser uses fifths and correctly ignores
  // <mode>, so no parser change clears this. Dropped from M7 exit
  // criteria; kept in the report so score-quality issues remain visible.
  key_mode_wrong: 5,
  unhandled_notation_pitch: 1,
  tempo_changes_lost: 2,
  unhandled_notation_timing: 3,
  unhandled_notation_tone: 4,
  discarded_metadata: 4,
};

const LABEL = {
  parse_error: "PARSE ERROR",
  voice_collision: "voice collision",
  tuplet_scaling: "tuplet scaling",
  content_divergence: "content divergence",
  hand_assignment_mismatch: "hand assignment mismatch",
  measure_overflow: "measure overflow",
  incomplete_measure: "incomplete measure",
  anacrusis: "anacrusis (expected)",
  unresolved_navigation: "unresolved navigation",
  unflattened_repeat: "unflattened repeat",
  gap_fill_inexact: "inexact rest gap-fill",
  unknown_duration: "unknown duration token",
  orphan_tie: "orphan tie",
  volta_seam_tie: "volta-seam tie (informational)",
  cross_staff: "cross-staff voice",
  notes_unsorted: "notes[] not pitch-sorted",
  grace_dropped: "grace note dropped",
  key_mode_wrong: "key mode mislabelled",
  unhandled_notation_pitch: "UNHANDLED · alters pitch",
  tempo_changes_lost: "tempo changes discarded",
  unhandled_notation_timing: "unhandled · alters timing",
  unhandled_notation_tone: "unhandled · alters tone",
  discarded_metadata: "metadata discarded",
};

function collectFiles(target) {
  const st = fs.statSync(target);
  if (st.isDirectory()) {
    return fs
      .readdirSync(target)
      .filter((f) => /\.(mxl|xml|musicxml)$/i.test(f))
      .map((f) => path.join(target, f))
      .sort();
  }
  return [target];
}

function fmtMeasures(list, cap = 14) {
  if (list.length === 0) return "";
  const shown = list.slice(0, cap).join(", ");
  return list.length > cap ? `${shown}, +${list.length - cap} more` : shown;
}

function report(result, verbose) {
  const { label, truth, summary, findings } = result;
  const blocking = Object.keys(summary).filter((d) => SEVERITY[d] <= 1);
  const status = findings.length === 0 ? "CLEAN" : blocking.length ? "BLOCKED" : "WARN";

  const played = truth.playback.order.length;
  const written = truth.measureCount;
  const bars = played === written ? `${written} bars` : `${written} written → ${played} played`;

  console.log(`\n${"─".repeat(78)}`);
  console.log(`${status.padEnd(8)} ${label}`);
  console.log(`         ${bars}  ·  fifths ${truth.fifths}  ·  "${truth.title}"`);
  if (truth.handAssignment && truth.handAssignment.size > 0) {
    // Print the truth's independent §3.6 assignment. If parser and truth
    // agree, this is also what the parser did. If they don't,
    // HAND_ASSIGNMENT_MISMATCH fires below with the specific voice.
    const parts = [...truth.handAssignment.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([voice, info]) => `${voice}→${info.hand.toUpperCase()}(${Math.round(info.majority * 100)}%)`);
    console.log(`         voices: ${parts.join("  ")}`);
  }

  if (findings.length === 0) {
    console.log("         no defects");
    return status;
  }

  const order = Object.keys(summary).sort((a, b) => SEVERITY[a] - SEVERITY[b]);
  for (const d of order) {
    const { count, measures } = summary[d];
    const sev = SEVERITY[d] <= 1 ? "!!" : SEVERITY[d] <= 3 ? " *" : "  ";
    const where = measures.length ? `  m${fmtMeasures(measures)}` : "";
    console.log(`  ${sev} ${LABEL[d].padEnd(24)} ${String(count).padStart(4)}${where}`);
    if (verbose) {
      for (const f of findings.filter((x) => x.defect === d).slice(0, 8)) {
        const loc = f.measure ? `m${f.measure}${f.hand ? " " + f.hand : ""}` : "song";
        console.log(`        ${loc.padEnd(10)} ${f.detail}`);
      }
    }
  }
  return status;
}

// ---- main -------------------------------------------------------------------
const [, , cmd, target, ...rest] = process.argv;
const verbose = rest.includes("-v") || rest.includes("--verbose");
const json = rest.includes("--json");

if (cmd !== "validate" || !target) {
  console.log("usage: sam validate <file.mxl|dir> [-v] [--json]");
  process.exit(1);
}

const files = collectFiles(target);
const results = [];
const statuses = [];

for (const f of files) {
  const label = path.basename(f).replace(/\.(mxl|xml|musicxml)$/i, "");
  try {
    const r = validate(readScoreXml(f), label);
    results.push(r);
    if (!json) statuses.push(report(r, verbose));
  } catch (err) {
    if (!json) {
      console.log(`\n${"─".repeat(78)}`);
      console.log(`ERROR    ${label}\n         ${err.message}`);
    }
    statuses.push("ERROR");
  }
}

if (json) {
  console.log(JSON.stringify(
    results.map((r) => ({ label: r.label, summary: r.summary, findings: r.findings })),
    null, 2
  ));
} else {
  console.log(`\n${"═".repeat(78)}`);
  const tally = statuses.reduce((a, s) => ((a[s] = (a[s] || 0) + 1), a), {});
  console.log(
    "TOTAL   " +
      Object.entries(tally).map(([k, v]) => `${v} ${k}`).join("  ·  ")
  );

  const agg = {};
  for (const r of results) {
    for (const [d, s] of Object.entries(r.summary)) {
      agg[d] = (agg[d] || 0) + s.count;
    }
  }
  console.log("\nDefects across corpus, worst first:");
  for (const [d, c] of Object.entries(agg).sort((a, b) => SEVERITY[a[0]] - SEVERITY[b[0]] || b[1] - a[1])) {
    const songs = results.filter((r) => r.summary[d]).map((r) => r.label.slice(0, 18));
    console.log(`  ${LABEL[d].padEnd(24)} ${String(c).padStart(4)}   ${songs.join(", ")}`);
  }
  console.log();
}
