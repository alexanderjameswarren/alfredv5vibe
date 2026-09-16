#!/usr/bin/env node
//
// Compare stored sam_song_scores rows with the CLI analyzer, or with each other.
// Analyzer port M4. Reads files only; touches no database.
//
// Dumps come from docs/sql/verify-analyzer-port-m4.sql: a JSON object keyed by
// song title, each value { song_id, measures_edited_at, rows: [...] }. Copy the
// `result` cell from the SQL editor into a file.
//
//   node bin/compare-scores.js cli <dump.json> <export.json> [<export.json> ...]
//       For each exported song, run the CLI analyzer (analyzeSongFacts) and
//       compare every stored column of every measure with it — exact
//       equality, no tolerance. Songs are matched by title. Exit 1 on any
//       mismatch or missing song.
//
//   node bin/compare-scores.js diff <before.json> <after.json> [--all-columns]
//       For each song in both dumps, list the measures whose rows differ.
//       By default computed_at and computed_from_edited_at are ignored (a
//       recompute always changes them); --all-columns compares those too,
//       which is how a no-op is proved: nothing at all may change.

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { analyzeSongFacts } from "../lib/analyze.js";

// Stored column -> analyzer fact. The only columns the CLI can vouch for.
const FACT_COLUMNS = {
  measure_number: "number",
  beats: "beats",
  rh_onsets: "rhOnsets",
  lh_onsets: "lhOnsets",
  rh_stack: "rhStack",
  lh_stack: "lhStack",
  rh_stretch: "rhStretch",
  lh_stretch: "lhStretch",
  rh_jump: "rhJump",
  lh_jump: "lhJump",
  rhythm_variety: "rhythmVariety",
  accidentals: "accidentals",
};
const VOLATILE = ["computed_at", "computed_from_edited_at"];

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    "usage:\n" +
      "  node bin/compare-scores.js cli  <dump.json> <export.json> [...]\n" +
      "  node bin/compare-scores.js diff <before.json> <after.json> [--all-columns]"
  );
  process.exit(2);
}

/**
 * Read a saved file, peeling off whatever the Supabase SQL editor wrapped the
 * `result` cell in. All of these are accepted and mean the same dump:
 *   { ...dump }                      the cell's value, pasted as-is
 *   "{ ...dump }"                    the cell copied as a quoted string
 *   [{ "result": { ...dump } }]      the editor's "copy as JSON" of the row
 *   { "result": { ...dump } }        a single row object
 *   [{ "result": "{ ...dump }" }]    either of the above with a text cell
 * An export document never has `result` as its only key, so exports pass
 * through untouched.
 */
export function unwrapResult(value) {
  for (;;) {
    if (typeof value === "string") {
      value = JSON.parse(value);
    } else if (Array.isArray(value) && value.length === 1 && isResultRow(value[0])) {
      value = value[0].result;
    } else if (isResultRow(value)) {
      value = value.result;
    } else {
      return value;
    }
  }
}

function isResultRow(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) &&
    Object.keys(v).length === 1 && "result" in v;
}

function readJson(file) {
  if (!fs.existsSync(file)) usage(`no such file: ${file}`);
  return unwrapResult(fs.readFileSync(file, "utf8").trim());
}

function cli(dumpFile, exportFiles) {
  const dump = readJson(dumpFile);
  let failures = 0;
  for (const file of exportFiles) {
    const doc = readJson(file);
    const entry = dump[doc.title];
    if (!entry) {
      console.log(`MISSING  ${doc.title} — not in the dump (have: ${Object.keys(dump).join(", ")})`);
      failures++;
      continue;
    }
    const facts = analyzeSongFacts(doc).measures;
    const rows = entry.rows ?? [];
    const mismatches = [];
    if (rows.length !== facts.length) {
      mismatches.push(`row count: stored ${rows.length}, CLI ${facts.length}`);
    }
    let compared = 0;
    for (let i = 0; i < Math.min(rows.length, facts.length); i++) {
      for (const [col, key] of Object.entries(FACT_COLUMNS)) {
        compared++;
        if (!Object.is(rows[i][col], facts[i][key])) {
          mismatches.push(`m${facts[i].number} ${col}: stored ${rows[i][col]}, CLI ${facts[i][key]}`);
        }
      }
    }
    const versions = [...new Set(rows.map((r) => r.scores_version))];
    const stamps = [...new Set(rows.map((r) => r.computed_from_edited_at))];
    if (stamps.length !== 1 || stamps[0] !== entry.measures_edited_at) {
      // Compared as the strings Postgres printed for both, from one query.
      mismatches.push(
        `computed_from_edited_at ${JSON.stringify(stamps)} vs song measures_edited_at ${JSON.stringify(entry.measures_edited_at)}`
      );
    }
    const ok = mismatches.length === 0;
    if (!ok) failures++;
    console.log(
      `${ok ? "MATCH   " : "MISMATCH"} ${doc.title}: ${facts.length} measures × ` +
        `${Object.keys(FACT_COLUMNS).length} columns = ${compared} values compared, ` +
        `${mismatches.length} mismatch(es); scores_version ${versions.join(",")}`
    );
    for (const m of mismatches.slice(0, 20)) console.log(`    ${m}`);
    if (mismatches.length > 20) console.log(`    …and ${mismatches.length - 20} more`);
  }
  process.exit(failures ? 1 : 0);
}

function diff(beforeFile, afterFile, allColumns) {
  const before = readJson(beforeFile);
  const after = readJson(afterFile);
  const titles = Object.keys(before).filter((t) => t in after);
  if (titles.length === 0) usage("the two dumps share no song titles");
  const skip = allColumns ? [] : VOLATILE;
  const strip = (row) => JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k]) => !skip.includes(k))));
  for (const title of titles) {
    const a = new Map((before[title].rows ?? []).map((r) => [r.measure_number, r]));
    const b = new Map((after[title].rows ?? []).map((r) => [r.measure_number, r]));
    const numbers = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x - y);
    const changed = [];
    let identical = 0;
    for (const n of numbers) {
      const ra = a.get(n);
      const rb = b.get(n);
      if (!ra || !rb) { changed.push(`m${n} (${ra ? "removed" : "added"})`); continue; }
      if (strip(ra) === strip(rb)) { identical++; continue; }
      const cols = Object.keys({ ...ra, ...rb })
        .filter((k) => !skip.includes(k) && JSON.stringify(ra[k]) !== JSON.stringify(rb[k]))
        .map((k) => `${k} ${JSON.stringify(ra[k])}→${JSON.stringify(rb[k])}`);
      changed.push(`m${n}: ${cols.join(", ")}`);
    }
    console.log(
      `${title}: ${numbers.length} measures — ${changed.length} changed, ${identical} identical` +
        (allColumns ? " (all columns compared)" : " (computed_at / computed_from_edited_at ignored)")
    );
    for (const c of changed) console.log(`    ${c}`);
    console.log(
      `    measures_edited_at: ${JSON.stringify(before[title].measures_edited_at)} → ${JSON.stringify(after[title].measures_edited_at)}`
    );
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
const [mode, ...rest] = isMain ? process.argv.slice(2) : [null];
if (!isMain) {
  // imported (tests)
} else if (mode === "cli") {
  if (rest.length < 2) usage("cli needs a dump and at least one export");
  cli(rest[0], rest.slice(1));
} else if (mode === "diff") {
  const files = rest.filter((a) => !a.startsWith("--"));
  if (files.length !== 2) usage("diff needs exactly two dumps");
  diff(files[0], files[1], rest.includes("--all-columns"));
} else {
  usage();
}
