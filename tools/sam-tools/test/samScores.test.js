// The sam-song-scores compute path (supabase/functions/_shared/samScores.ts),
// driven with a fake database client that records every table and function it
// touches. What must hold:
//
//   - a fresh song costs ONE call and reads no measure row, writes nothing
//   - a stale song stores exactly what the CLI analyzer produces from the same
//     measures, with the song's measures_edited_at passed back verbatim
//   - the rows sent match the column list the SQL function unpacks
//
// Node loads the .ts file through type stripping, as the parity tests do.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";

globalThis.DOMParser = new JSDOM("", { contentType: "text/html" }).window.DOMParser;

const { parseMusicXML } = await import("../vendor/songParser.js");
const { readScoreXml } = await import("../lib/mxl.js");
const CLI = await import("../lib/analyze.js");
const S = await import("../../../supabase/functions/_shared/samScores.ts");
const { fifthsFromKeyLabel } = await import("../../../src/sam/lib/keySignature.js");

const SONG_ID = "11111111-1111-1111-1111-111111111111";
const EDITED_AT = "2026-09-16T19:23:39.000643+00:00"; // microseconds on purpose

/** sam_song_measures rows as PostgREST would return them. */
function measureRowsFrom(doc) {
  return doc.measures.map((m, i) => ({
    number: m.number ?? i + 1,
    rh: m.rh,
    lh: m.lh,
    time_signature: m.timeSignature,
    source_measure: m.sourceMeasure ?? null,
  }));
}

/**
 * A fake supabase client. `state` is what sam_song_scores_freshness returns
 * (one row, or null for a song the caller cannot see).
 */
function fakeDb({ state, song = { title: "T", key_signature: "C major" }, measures = [], written } = {}) {
  const calls = [];
  const db = {
    calls,
    rpc(fn, args) {
      calls.push({ kind: "rpc", fn, args });
      if (fn === "sam_song_scores_freshness") {
        return Promise.resolve({ data: state ? [state] : [], error: null });
      }
      if (fn === "replace_sam_song_scores") {
        return Promise.resolve({ data: written ?? args.p_rows.length, error: null });
      }
      return Promise.resolve({ data: null, error: { message: `unknown rpc ${fn}` } });
    },
    from(table) {
      const q = { table, filters: {}, range: null };
      calls.push({ kind: "from", table, q });
      const api = {
        select() { return api; },
        eq(k, v) { q.filters[k] = v; return api; },
        order() { return api; },
        range(a, b) { q.range = [a, b]; return api; },
        maybeSingle() {
          return Promise.resolve({ data: table === "sam_songs" ? song : null, error: null });
        },
        then(resolve, reject) {
          let data = [];
          if (table === "sam_song_measures") {
            const [a, b] = q.range ?? [0, measures.length - 1];
            data = measures.slice(a, b + 1);
          }
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return api;
    },
  };
  return db;
}

const tablesRead = (db) => db.calls.filter((c) => c.kind === "from").map((c) => c.table);
const rpcs = (db) => db.calls.filter((c) => c.kind === "rpc").map((c) => c.fn);

// --- the fresh path ------------------------------------------------------------

test("a fresh song costs one call: no measure read, nothing written", async () => {
  const db = fakeDb({
    state: { fresh: true, measures_edited_at: EDITED_AT, stored_rows: 82 },
    measures: [{ number: 1 }],
  });
  const r = await S.computeSongScores(db, SONG_ID);
  assert.deepEqual(r, {
    song_id: SONG_ID, status: "fresh", scores_version: S.SCORES_VERSION,
    computed_from_edited_at: EDITED_AT, measures_read: 0, rows_written: 0,
  });
  assert.deepEqual(db.calls.map((c) => c.fn ?? c.table), ["sam_song_scores_freshness"]);
  assert.deepEqual(tablesRead(db), []);
});

test("the freshness check is asked about the current SCORES_VERSION", async () => {
  const db = fakeDb({ state: { fresh: true, measures_edited_at: null, stored_rows: 1 } });
  await S.computeSongScores(db, SONG_ID);
  assert.deepEqual(db.calls[0].args, { p_song_id: SONG_ID, p_scores_version: S.SCORES_VERSION });
  assert.equal(S.SCORES_VERSION, 1);
});

test("a song the caller cannot see is an error, raised before any read", async () => {
  const db = fakeDb({ state: null });
  await assert.rejects(S.computeSongScores(db, SONG_ID), S.SongNotFoundError);
  assert.deepEqual(tablesRead(db), []);
});

test("a failed freshness check is an error, not a recompute", async () => {
  const db = fakeDb();
  db.rpc = (fn) => {
    db.calls.push({ kind: "rpc", fn });
    return Promise.resolve({ data: null, error: { message: "boom" } });
  };
  await assert.rejects(S.computeSongScores(db, SONG_ID), /sam_song_scores_freshness: boom/);
  assert.deepEqual(tablesRead(db), []);
});

// --- the stale path --------------------------------------------------------------

const SLY = JSON.parse(JSON.stringify(parseMusicXML(readScoreXml("fixtures/someone-like-you-easy-piano.mxl"))));

test("a stale song stores exactly what the CLI computes from the same measures", async () => {
  const measures = measureRowsFrom(SLY);
  const db = fakeDb({
    state: { fresh: false, measures_edited_at: EDITED_AT, stored_rows: 0 },
    song: { title: "Someone Like You", key_signature: "A major" },
    measures,
  });
  const r = await S.computeSongScores(db, SONG_ID);
  assert.equal(r.status, "computed");
  assert.equal(r.measures_read, 82);
  assert.equal(r.rows_written, 82);

  // Order: freshness first, then the song, then measures, then one write.
  assert.deepEqual(db.calls.map((c) => c.fn ?? c.table), [
    "sam_song_scores_freshness", "sam_songs", "sam_song_measures", "replace_sam_song_scores",
  ]);

  const write = db.calls.at(-1).args;
  assert.equal(write.p_song_id, SONG_ID);
  assert.equal(write.p_scores_version, S.SCORES_VERSION);
  assert.equal(write.p_computed_from, EDITED_AT, "the stamp goes back verbatim, microseconds and all");

  // The CLI on the equivalent export document: the fixture's own fifths (3)
  // is what the label inversion gives, so an export and the DB agree.
  assert.equal(fifthsFromKeyLabel("A major"), SLY.fifths);
  const cli = CLI.analyzeSongFacts(SLY).measures;
  assert.equal(write.p_rows.length, cli.length);
  write.p_rows.forEach((row, i) => {
    const f = cli[i];
    const expected = {
      measure_number: f.number, beats: f.beats, rh_onsets: f.rhOnsets, lh_onsets: f.lhOnsets,
      rh_stack: f.rhStack, lh_stack: f.lhStack, rh_stretch: f.rhStretch, lh_stretch: f.lhStretch,
      rh_jump: f.rhJump, lh_jump: f.lhJump, rhythm_variety: f.rhythmVariety, accidentals: f.accidentals,
    };
    for (const [k, v] of Object.entries(expected)) {
      assert.ok(Object.is(row[k], v), `m${f.number} ${k}: stored ${row[k]}, CLI ${v}`);
    }
  });
});

test("an unknown key label stores accidentals as null, never 0", async () => {
  const db = fakeDb({
    state: { fresh: false, measures_edited_at: null, stored_rows: 0 },
    song: { title: "Drill", key_signature: "D dorian" },
    measures: measureRowsFrom(SLY).slice(0, 3),
  });
  await S.computeSongScores(db, SONG_ID);
  const rows = db.calls.at(-1).args.p_rows;
  assert.deepEqual(rows.map((r) => r.accidentals), [null, null, null]);
  assert.equal(db.calls.at(-1).args.p_computed_from, null);
});

test("measures are read in pages until a short page, and all of them are scored", async () => {
  const base = measureRowsFrom(SLY);
  const measures = Array.from({ length: 2500 }, (_, i) => ({ ...base[i % base.length], number: i + 1 }));
  const db = fakeDb({ state: { fresh: false, measures_edited_at: EDITED_AT, stored_rows: 0 }, measures });
  const r = await S.computeSongScores(db, SONG_ID, { pageSize: 1000 });
  const pages = db.calls.filter((c) => c.table === "sam_song_measures").map((c) => c.q.range);
  assert.deepEqual(pages, [[0, 999], [1000, 1999], [2000, 2999]]);
  assert.equal(r.measures_read, 2500);
  assert.deepEqual(db.calls.at(-1).args.p_rows.map((x) => x.measure_number),
    Array.from({ length: 2500 }, (_, i) => i + 1));
});

test("a song with no measures and no stored rows writes nothing", async () => {
  const db = fakeDb({ state: { fresh: false, measures_edited_at: null, stored_rows: 0 }, measures: [] });
  const r = await S.computeSongScores(db, SONG_ID);
  assert.equal(r.status, "no-measures");
  assert.ok(!rpcs(db).includes("replace_sam_song_scores"));
});

test("a song whose measures are gone has its old rows cleared", async () => {
  const db = fakeDb({ state: { fresh: false, measures_edited_at: EDITED_AT, stored_rows: 40 }, measures: [] });
  const r = await S.computeSongScores(db, SONG_ID);
  assert.equal(r.status, "cleared");
  assert.deepEqual(db.calls.at(-1).args.p_rows, []);
});

// --- the row shape matches the SQL ------------------------------------------------

test("toScoreRow emits exactly the columns replace_sam_song_scores unpacks", () => {
  const sql = fs.readFileSync(new URL("../../../supabase/migrations/027_sam_song_scores_functions.sql", import.meta.url), "utf8");
  const block = sql.match(/jsonb_to_recordset\(p_rows\) as r\(([\s\S]*?)\);/)[1];
  const sqlColumns = block.split(",").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);

  const row = S.toScoreRow(CLI.analyzeSongFacts(SLY).measures[0]);
  assert.deepEqual(Object.keys(row), sqlColumns);

  // …and each of those is a real sam_song_scores column in 026.
  const table = fs.readFileSync(new URL("../../../supabase/migrations/026_sam_song_scores.sql", import.meta.url), "utf8");
  for (const c of sqlColumns) assert.match(table, new RegExp(`^\\s+${c}\\s`, "m"), c);
});

test("the facts-to-row mapping covers every fact except the printed label", () => {
  const facts = CLI.analyzeSongFacts(SLY).measures[0];
  const row = S.toScoreRow(facts);
  const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const mapped = new Set(Object.keys(row).map((k) => (k === "measure_number" ? "number" : camel(k))));
  assert.deepEqual(Object.keys(facts).filter((k) => !mapped.has(k)), ["sourceMeasure"]);
});
