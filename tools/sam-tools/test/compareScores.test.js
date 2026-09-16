// bin/compare-scores.js — the tool the M4 exit criteria are judged with, so it
// has to be shown to fail as well as pass.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const S = await import("../../../supabase/functions/_shared/samScores.ts");
const CLI = await import("../lib/analyze.js");

const TOOL = new URL("../bin/compare-scores.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const EXPORT = JSON.parse(fs.readFileSync(new URL("../scientist.json", import.meta.url), "utf8"));
const STAMP = "2026-09-16 19:23:39.000643+00";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compare-scores-"));
const write = (name, value) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
};
const run = (...args) =>
  spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });

/** A dump shaped like the SQL query's output, built from the CLI's own facts. */
function dumpFor(doc, mutate = (rows) => rows) {
  const rows = CLI.analyzeSongFacts(doc).measures.map((f, i) => ({
    song_id: "s1",
    ...S.toScoreRow(f),
    scores_version: 1,
    computed_from_edited_at: STAMP,
    computed_at: `2026-09-16 20:00:0${i % 10}+00`,
  }));
  return { [doc.title]: { song_id: "s1", measures_edited_at: STAMP, rows: mutate(rows) } };
}

test("cli: stored rows equal to the CLI match", () => {
  const r = run("cli", write("ok.json", dumpFor(EXPORT)), write("export.json", EXPORT));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^MATCH {4}The Scientist - Coldplay: 73 measures × 12 columns = 876 values compared, 0 mismatch/m);
});

test("cli: a single differing value fails, naming measure and column", () => {
  const bad = dumpFor(EXPORT, (rows) => { rows[9].rh_jump += 1; return rows; });
  const r = run("cli", write("bad.json", bad), write("export.json", EXPORT));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /MISMATCH/);
  assert.match(r.stdout, /m10 rh_jump: stored \d+, CLI \d+/);
});

test("cli: a float that differs only in the last bit fails", () => {
  const bad = dumpFor(EXPORT, (rows) => { rows[0].beats = rows[0].beats + 4 * Number.EPSILON; return rows; });
  const r = run("cli", write("float.json", bad), write("export.json", EXPORT));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /m1 beats/);
});

test("cli: a stamp that differs from the song's fails; a missing song fails", () => {
  const stale = dumpFor(EXPORT, (rows) => { rows[3].computed_from_edited_at = "2026-01-01 00:00:00+00"; return rows; });
  assert.equal(run("cli", write("stale.json", stale), write("export.json", EXPORT)).status, 1);
  const other = { "Someone Else": dumpFor(EXPORT)[EXPORT.title] };
  const r = run("cli", write("other.json", other), write("export.json", EXPORT));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^MISSING/m);
});

test("cli: accepts a cell pasted with surrounding quotes", () => {
  const quoted = JSON.stringify(JSON.stringify(dumpFor(EXPORT)));
  assert.equal(run("cli", write("quoted.json", quoted), write("export.json", EXPORT)).status, 0);
});

test("diff: one edited measure is the only change; volatile columns are ignored", () => {
  const before = dumpFor(EXPORT);
  const after = dumpFor(EXPORT, (rows) =>
    rows.map((r) => ({ ...r, computed_at: "2026-09-17 00:00:00+00", ...(r.measure_number === 10 ? { rh_stack: r.rh_stack + 1 } : {}) }))
  );
  const r = run("diff", write("before.json", before), write("after.json", after));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /73 measures — 1 changed, 72 identical/);
  assert.match(r.stdout, /m10: rh_stack \d+→\d+/);
});

test("diff --all-columns: a recompute that rewrote rows is not a no-op", () => {
  const before = dumpFor(EXPORT);
  const after = dumpFor(EXPORT, (rows) => rows.map((r) => ({ ...r, computed_at: "2026-09-17 00:00:00+00" })));
  const r = run("diff", write("b.json", before), write("a.json", after), "--all-columns");
  assert.match(r.stdout, /73 measures — 73 changed, 0 identical \(all columns compared\)/);
  const same = run("diff", write("b2.json", before), write("a2.json", before), "--all-columns");
  assert.match(same.stdout, /73 measures — 0 changed, 73 identical/);
});
