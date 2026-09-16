// get_sam_song_scores (supabase/functions/_shared/samScoresRead.ts), driven
// with a fake database client that records every call, in order. What must
// hold:
//
//   - flags and rollup equal the CLI's analyzeSong at the same tempo
//   - the tempo is the bpm argument or goal_effective_bpm, and says which;
//     goal_bpm and default_bpm are never even selected
//   - no goal and no bpm is an error raised before anything is written
//   - range filters reach the query before the limit
//   - a cut range is reported as truncated, and the rollup is labelled with
//     the measures it actually covers
//   - flagged_only filters rows, never the rollup
//
// Node loads the .ts files through type stripping, as the parity tests do.

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.DOMParser = new JSDOM("", { contentType: "text/html" }).window.DOMParser;

const { parseMusicXML } = await import("../vendor/songParser.js");
const { readScoreXml } = await import("../lib/mxl.js");
const CLI = await import("../lib/analyze.js");
const S = await import("../../../supabase/functions/_shared/samScores.ts");
const R = await import("../../../supabase/functions/_shared/samScoresRead.ts");

const SONG_ID = "030333d9-1b9f-4f74-80fb-7fbed587fda6";
const EDITED_AT = "2026-09-16T19:23:39.000643+00:00";
const SLY = JSON.parse(JSON.stringify(parseMusicXML(readScoreXml("fixtures/someone-like-you-easy-piano.mxl"))));

/** sam_song_scores rows as PostgREST would return them, from the CLI's own facts. */
const STORED = CLI.analyzeSongFacts(SLY).measures.map((f) => ({
  measure_number: f.number,
  ...Object.fromEntries(Object.entries(S.toScoreRow(f)).filter(([k]) => k !== "measure_number")),
}));

/**
 * A fake client. Scores are fresh unless `fresh: false`, in which case the
 * compute path reads `measures` and "replaces" the rows.
 */
function fakeDb({ song = { id: SONG_ID, title: "Someone Like You", goal_effective_bpm: 67 }, fresh = true, rows = STORED, measures = [] } = {}) {
  const calls = [];
  const db = {
    calls,
    rpc(fn, args) {
      calls.push({ kind: "rpc", name: fn, args });
      if (fn === "sam_song_scores_freshness") {
        return Promise.resolve({ data: [{ fresh, measures_edited_at: EDITED_AT, stored_rows: rows.length }], error: null });
      }
      if (fn === "replace_sam_song_scores") return Promise.resolve({ data: args.p_rows.length, error: null });
      return Promise.resolve({ data: null, error: { message: `unknown rpc ${fn}` } });
    },
    from(table) {
      const call = { kind: "from", name: table, ops: [] };
      calls.push(call);
      const api = {};
      for (const op of ["select", "eq", "gte", "lte", "order", "limit", "range"]) {
        api[op] = (...a) => { call.ops.push([op, ...a]); return api; };
      }
      api.maybeSingle = () => {
        call.ops.push(["maybeSingle"]);
        const data = table === "sam_songs"
          ? (song && { ...song, key_signature: "A major" })
          : null;
        return Promise.resolve({ data, error: null });
      };
      api.then = (resolve, reject) => {
        let data = [];
        let count = null;
        if (table === "sam_song_measures") {
          const [, a, b] = call.ops.find((o) => o[0] === "range") ?? [null, 0, measures.length - 1];
          data = measures.slice(a, b + 1);
        }
        if (table === "sam_song_scores") {
          const op = (name) => call.ops.find((o) => o[0] === name);
          let inRange = rows;
          if (op("gte")) inRange = inRange.filter((r) => r.measure_number >= op("gte")[2]);
          if (op("lte")) inRange = inRange.filter((r) => r.measure_number <= op("lte")[2]);
          count = op("select")?.[2]?.count === "exact" ? inRange.length : null;
          data = inRange.slice(0, op("limit")?.[1] ?? inRange.length);
        }
        return Promise.resolve({ data, count, error: null }).then(resolve, reject);
      };
      return api;
    },
  };
  return db;
}

const names = (db) => db.calls.map((c) => c.name);
const writes = (db) => db.calls.filter((c) => c.name === "replace_sam_song_scores");
const r2 = (x) => (x === null ? null : Math.round(x * 100) / 100);
const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

// --- agreement with the CLI --------------------------------------------------

test("flags and rollup match the CLI on Someone Like You at its goal tempo", async () => {
  const { data, meta } = await R.readSongScores(fakeDb(), { song_id: SONG_ID });
  const cli = CLI.analyzeSong(SLY, { bpm: 67 });

  assert.equal(data.rows.count, 82);
  assert.deepEqual(
    data.rows.measures.map((m) => [m.measure, m.flags]),
    cli.measures.map((m) => [m.number, m.flags]),
  );
  assert.deepEqual(data.rollup.flagged_measures, cli.flagged);
  assert.ok(cli.flagged.length > 0, "the reference song should flag something");
  for (const [key, stat] of Object.entries(cli.summary)) {
    assert.deepEqual(
      data.rollup.metrics[snake(key)],
      { median: r2(stat.median), p90: r2(stat.p90), max: r2(stat.max) },
      key,
    );
  }
  // Every value in a row is the CLI's, rounded only where it is fractional.
  data.rows.measures.forEach((row, i) => {
    const m = cli.measures[i];
    assert.equal(row.notes_per_second, r2(m.notesPerSecond));
    assert.equal(row.lh_notes_per_beat, r2(m.lhNotesPerBeat));
    assert.equal(row.rh_stretch, m.rhStretch);
    assert.equal(row.accidentals, m.accidentals);
  });
  assert.deepEqual(meta, { truncated: false, total: 82, limit_applied: R.MAX_MEASURES });
  assert.equal(data.range.truncated, false);
  assert.match(data.rollup.covers, /^all 82 measures/);
});

test("rows are lean: no beats, no onset counts", async () => {
  const { data } = await R.readSongScores(fakeDb(), { song_id: SONG_ID });
  assert.deepEqual(Object.keys(data.rows.measures[0]), [
    "measure", "notes_per_second", "rh_notes_per_beat", "lh_notes_per_beat",
    "rh_stack", "lh_stack", "rh_stretch", "lh_stretch", "rh_jump", "lh_jump",
    "rhythm_variety", "accidentals", "flags",
  ]);
});

// --- tempo -----------------------------------------------------------------------

test("omitting bpm uses goal_effective_bpm and says so", async () => {
  const { data } = await R.readSongScores(fakeDb(), { song_id: SONG_ID });
  assert.equal(data.tempo.bpm, 67);
  assert.equal(data.tempo.source, "goal");
});

test("an explicit bpm wins, and says so", async () => {
  const { data } = await R.readSongScores(fakeDb(), { song_id: SONG_ID, bpm: 120 });
  assert.deepEqual([data.tempo.bpm, data.tempo.source], [120, "argument"]);
  const cli = CLI.analyzeSong(SLY, { bpm: 120 });
  assert.deepEqual(data.rollup.flagged_measures, cli.flagged);
});

test("the song read never selects goal_bpm or default_bpm", async () => {
  const db = fakeDb();
  await R.readSongScores(db, { song_id: SONG_ID });
  const select = db.calls.find((c) => c.name === "sam_songs").ops.find((o) => o[0] === "select")[1];
  assert.equal(select, "id, title, goal_effective_bpm");
  assert.doesNotMatch(select, /goal_bpm|default_bpm/);
});

// This path guards a state the database currently prevents (goal_bpm is NOT
// NULL and filled on insert), so it can only be reached here.
test("no goal and no bpm: an error, before any freshness check, read or write", async () => {
  for (const goal of [null, undefined, 0]) {
    const db = fakeDb({ song: { id: SONG_ID, title: "T", goal_effective_bpm: goal } });
    await assert.rejects(R.readSongScores(db, { song_id: SONG_ID }), /no goal tempo and no bpm was given/);
    assert.deepEqual(names(db), ["sam_songs"]);
  }
  // …and a bpm rescues it.
  const db = fakeDb({ song: { id: SONG_ID, title: "T", goal_effective_bpm: null } });
  const { data } = await R.readSongScores(db, { song_id: SONG_ID, bpm: 80 });
  assert.equal(data.tempo.source, "argument");
});

test("bad arguments are rejected before any call", async () => {
  const bad = [
    { song_id: "nope" },
    { song_id: SONG_ID, bpm: 0 },
    { song_id: SONG_ID, bpm: -5 },
    { song_id: SONG_ID, bpm: "fast" },
    { song_id: SONG_ID, start_measure: 0 },
    { song_id: SONG_ID, start_measure: 1.5 },
    { song_id: SONG_ID, start_measure: 10, end_measure: 5 },
    { song_id: SONG_ID, limit: 0 },
    { song_id: SONG_ID, flagged_only: "yes" },
  ];
  for (const args of bad) {
    const db = fakeDb();
    await assert.rejects(R.readSongScores(db, args), R.SongScoresError, JSON.stringify(args));
    assert.deepEqual(names(db), [], JSON.stringify(args));
  }
});

test("an unknown song is an error, and nothing is written", async () => {
  const db = fakeDb({ song: null });
  await assert.rejects(R.readSongScores(db, { song_id: SONG_ID }), /not found/);
  assert.deepEqual(names(db), ["sam_songs"]);
});

// --- freshness -------------------------------------------------------------------

test("fresh scores: one freshness call, no write, status fresh", async () => {
  const db = fakeDb();
  const { data } = await R.readSongScores(db, { song_id: SONG_ID });
  assert.deepEqual(names(db), ["sam_songs", "sam_song_scores_freshness", "sam_song_scores"]);
  assert.equal(data.scores.status, "fresh");
  assert.equal(data.scores.computed_from_edited_at, EDITED_AT);
  assert.equal(writes(db).length, 0);
});

test("stale scores are recomputed before the read, and the response says so", async () => {
  const measures = SLY.measures.map((m, i) => ({
    number: m.number ?? i + 1, rh: m.rh, lh: m.lh, time_signature: m.timeSignature, source_measure: null,
  }));
  const db = fakeDb({ fresh: false, measures });
  const { data } = await R.readSongScores(db, { song_id: SONG_ID });
  assert.deepEqual(names(db), [
    "sam_songs", "sam_song_scores_freshness", "sam_songs", "sam_song_measures",
    "replace_sam_song_scores", "sam_song_scores",
  ]);
  assert.equal(writes(db)[0].args.p_rows.length, 82);
  assert.equal(data.scores.status, "recomputed");
});

// --- range and limit ---------------------------------------------------------------

test("a range returns only that range, filtered before the limit, rollup over it", async () => {
  const db = fakeDb();
  const { data, meta } = await R.readSongScores(db, { song_id: SONG_ID, start_measure: 20, end_measure: 30 });
  const ops = db.calls.find((c) => c.name === "sam_song_scores").ops.map((o) => o[0]);
  assert.deepEqual(ops, ["select", "eq", "gte", "lte", "order", "limit"]);
  assert.deepEqual(data.rows.measures.map((m) => m.measure), [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
  assert.deepEqual(data.range.analyzed, { first_measure: 20, last_measure: 30, count: 11 });
  assert.equal(meta.truncated, false);
  assert.equal(meta.total, 11);

  const slice = CLI.analyzeSong(SLY, { bpm: 67 }).measures.filter((m) => m.number >= 20 && m.number <= 30);
  const nps = slice.map((m) => m.notesPerSecond);
  assert.equal(data.rollup.metrics.notes_per_second.max, r2(Math.max(...nps)));
  assert.equal(data.rollup.metrics.notes_per_second.median, r2(CLI.quantile(nps, 0.5)));
  assert.deepEqual(data.rollup.flagged_measures, slice.filter((m) => m.flags.length).map((m) => m.number));
});

test("the default limit is the cap, never clampLimit's 50", async () => {
  const db = fakeDb();
  await R.readSongScores(db, { song_id: SONG_ID });
  const limit = db.calls.find((c) => c.name === "sam_song_scores").ops.find((o) => o[0] === "limit");
  assert.deepEqual(limit, ["limit", 200]);
  const capped = fakeDb();
  const { meta } = await R.readSongScores(capped, { song_id: SONG_ID, limit: 5000 });
  assert.equal(meta.limit_applied, 200);
});

test("a whole-song read over 160 measures is not truncated", async () => {
  const long = Array.from({ length: 160 }, (_, i) => ({ ...STORED[i % STORED.length], measure_number: i + 1 }));
  const { data, meta } = await R.readSongScores(fakeDb({ rows: long }), { song_id: SONG_ID });
  assert.equal(data.rows.count, 160);
  assert.equal(meta.truncated, false);
});

test("a cut range says so: meta, the analyzed range, the rollup label, the next start", async () => {
  const { data, meta } = await R.readSongScores(fakeDb(), { song_id: SONG_ID, start_measure: 11, limit: 30 });
  assert.deepEqual(meta, { truncated: true, total: 72, limit_applied: 30 });
  assert.equal(data.range.truncated, true);
  assert.equal(data.range.measures_in_range, 72);
  assert.deepEqual(data.range.analyzed, { first_measure: 11, last_measure: 40, count: 30 });
  assert.match(data.range.note, /start_measure=41/);
  assert.match(data.rollup.covers, /30 analyzed measures \(11–40\) — NOT the whole requested range/);
  const cli = CLI.analyzeSong(SLY, { bpm: 67 }).measures.filter((m) => m.number >= 11 && m.number <= 40);
  assert.deepEqual(data.rollup.flagged_measures, cli.filter((m) => m.flags.length).map((m) => m.number));
});

test("exactly `limit` rows in range is complete, not truncated", async () => {
  const { meta, data } = await R.readSongScores(fakeDb(), { song_id: SONG_ID, start_measure: 1, end_measure: 10, limit: 10 });
  assert.equal(meta.truncated, false);
  assert.equal(data.range.note, undefined);
});

// --- flagged_only ------------------------------------------------------------------

test("flagged_only filters the rows, never the rollup, and labels both", async () => {
  const all = await R.readSongScores(fakeDb(), { song_id: SONG_ID });
  const some = await R.readSongScores(fakeDb(), { song_id: SONG_ID, flagged_only: true });
  assert.deepEqual(some.data.rollup, all.data.rollup);
  assert.deepEqual(some.meta, all.meta);
  assert.equal(some.data.rows.filter, "flagged_only");
  assert.equal(all.data.rows.filter, "all");
  assert.deepEqual(some.data.rows.measures.map((m) => m.measure), all.data.rollup.flagged_measures);
  assert.ok(some.data.rows.measures.every((m) => m.flags.length > 0));
  assert.ok(some.data.rows.count < all.data.rows.count);
  assert.match(some.data.rows.note, /rollup above still covers all 82 analyzed measures/);
});

// --- the tool wrapper ----------------------------------------------------------------

test("the tool file reaches the database only through ctx.db", async () => {
  const fs = await import("node:fs");
  for (const f of ["tools/sam-song-scores.ts", "samScoresRead.ts"]) {
    const src = fs.readFileSync(new URL(`../../../supabase/functions/_shared/${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /supabase-js|createClient/, f);
  }
});
