#!/usr/bin/env node
//
// Read-only difficulty digest for an exported SAM song.
//
//   npm run analyze -- path/to/song.json --bpm 60
//   node bin/analyze.js path/to/song.json --bpm 60
//
// Reads one file, prints plain text to stdout, writes nothing and touches no
// network or database. Output is sized to be pasted into a conversation: one
// line per measure, ~100 lines for an 82-measure song.

import fs from "node:fs";
import path from "node:path";
import { analyzeSong, THRESHOLDS } from "../lib/analyze.js";

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    "usage: node bin/analyze.js <song.json> --bpm <n>\n\n" +
      "  --bpm is REQUIRED and is quarter notes per minute. It is deliberately\n" +
      "  not read from the document: stored tempos are unreliable (see\n" +
      "  docs/song-export-format.md §7)."
  );
  process.exit(1);
}

const args = process.argv.slice(2);
let file = null;
let bpm = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--bpm") bpm = Number(args[++i]);
  else if (args[i].startsWith("--")) usage(`unknown option ${args[i]}`);
  else if (file === null) file = args[i];
  else usage("more than one input file");
}
if (!file) usage("no input file");
if (!(bpm > 0)) usage("--bpm <n> is required");
if (!fs.existsSync(file)) usage(`no such file: ${file}`);

let doc;
try {
  doc = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (e) {
  usage(`could not parse JSON: ${e.message}`);
}

let r;
try {
  r = analyzeSong(doc, { bpm });
} catch (e) {
  usage(e.message);
}

// --- formatting -----------------------------------------------------------

const n1 = (x) => (x == null ? "-" : x.toFixed(1));
const n2 = (x) => (x == null ? "-" : x.toFixed(2));
const int = (x) => (x == null ? "-" : String(x));
const pad = (s, w) => String(s).padStart(w);

const keyLabel = r.fifths == null
  ? `${r.key ?? "unknown key"} (fifths unknown)`
  : `${r.key ?? "?"} (fifths ${r.fifths})`;

console.log(`SAM difficulty digest — "${r.title}"${r.artist ? ` — ${r.artist}` : ""}`);
console.log(`  ${path.basename(file)} · ${r.measureCount} measures · ${keyLabel}`);
console.log(`  target tempo ${r.bpm} BPM (quarter = ${r.bpm}); document defaultBpm ignored by design`);
console.log(
  `  flag if  n/s>${THRESHOLDS.notesPerSecond}  LH/b>${THRESHOLDS.lhNotesPerBeat}  ` +
    `RHstk>${THRESHOLDS.rhStack}  RHstr>${THRESHOLDS.rhStretch}  var>${THRESHOLDS.rhythmVariety}`
);
// One width table drives the header, the measure rows and the summary rows, so
// the three can never drift out of alignment.
const COLS = [
  ["meas", 4], ["n/s", 6], ["LH/b", 6], ["RH/b", 6],
  ["stkRL", 7], ["strRL", 9], ["jmpRL", 9], ["var", 5], ["acc", 5],
];
const row = (cells) =>
  cells.map((c, i) => pad(c, COLS[i][1])).join("").trimEnd();

console.log("");
console.log(row(COLS.map(([label]) => label)) + "  flags");

for (const m of r.measures) {
  const line =
    row([
      m.number,
      n1(m.notesPerSecond),
      n2(m.lhNotesPerBeat),
      n2(m.rhNotesPerBeat),
      `${m.rhStack}/${m.lhStack}`,
      `${m.rhStretch}/${m.lhStretch}`,
      `${m.rhJump}/${m.lhJump}`,
      m.rhythmVariety,
      int(m.accidentals),
    ]) + (m.flags.length ? "  " + m.flags.join(",") : "");
  console.log(line.trimEnd());
}

// Summary mirrors the measure columns so the eye can compare a row above with
// a row below without re-reading a second layout.
console.log("");
console.log(row(COLS.map(([label]) => label)));
// Drop a trailing .0 so the paired columns stay narrow enough to align.
const cmp = (x) => (x == null ? "-" : Number.isInteger(x) ? String(x) : x.toFixed(1));
for (const [label, stat] of [["med", "median"], ["p90", "p90"], ["max", "max"]]) {
  const v = (key) => r.summary[key][stat];
  const pair = (a, b) => `${cmp(v(a))}/${cmp(v(b))}`;
  console.log(
    row([
      label,
      n1(v("notesPerSecond")),
      n2(v("lhNotesPerBeat")),
      n2(v("rhNotesPerBeat")),
      pair("rhStack", "lhStack"),
      pair("rhStretch", "lhStretch"),
      pair("rhJump", "lhJump"),
      cmp(v("rhythmVariety")),
      cmp(v("accidentals")),
    ])
  );
}

console.log("");
const pct = r.measureCount ? Math.round((r.flagged.length / r.measureCount) * 100) : 0;
const shown = r.flagged.slice(0, 24);
console.log(
  `flagged ${r.flagged.length}/${r.measureCount} (${pct}%)` +
    (r.flagged.length
      ? ` — m${shown.join(", m")}${r.flagged.length > shown.length ? `, +${r.flagged.length - shown.length} more` : ""}`
      : "")
);

const { crossings, unmatchedEnds, unclosedStarts } = r.ties;
const seamEnds = unmatchedEnds.filter((t) => t.kind === "seam");
const orphanEnds = unmatchedEnds.filter((t) => t.kind === "orphan");
console.log(
  `ties crossing barline: ${crossings.length} · unmatched ends: ${unmatchedEnds.length} ` +
    `(${seamEnds.length} at seam, ${orphanEnds.length} orphan) · unclosed starts: ${unclosedStarts.length}`
);
if (orphanEnds.length) {
  const o = orphanEnds.slice(0, 8).map((t) => `${t.hand} m${t.measure}`);
  console.log(`  orphan ends: ${o.join(", ")}${orphanEnds.length > 8 ? ", …" : ""}`);
}

const tupletMeasures = [...new Set(r.tuplets.map((t) => t.measure))];
console.log(
  `tuplet groups: ${r.tuplets.length} across ${tupletMeasures.length} measure(s)` +
    (r.tuplets.length
      ? ` — ${r.tuplets.slice(0, 6).map((t) => `${t.hand} m${t.measure}@b${t.startBeat.toFixed(2)} ×${t.length} (${t.actual}:${t.normal})`).join(", ")}${r.tuplets.length > 6 ? ", …" : ""}`
      : "")
);
console.log(
  `melody blips: ${r.blips.length}` +
    (r.blips.length
      ? ` — ${r.blips.slice(0, 8).map((b) => `m${b.measure}[${b.eventIndex}] -${b.drop}st`).join(", ")}${r.blips.length > 8 ? ", …" : ""}`
      : "")
);
console.log(`seams (printed-number jumps): ${r.seams.length ? "m" + r.seams.join(", m") : "none"}`);
