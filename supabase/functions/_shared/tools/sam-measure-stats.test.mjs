// Handler tests for get_sam_measure_stats (sam-measure-stats.ts).
//
// Run:
//   node --test supabase/functions/_shared/tools/sam-measure-stats.test.mjs
//
// Same harness as the other SAM tool suites: platform.ts is loaded REAL with
// only its Deno imports stubbed, so calls go through defineTool and ctx.db is
// the fake database below.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "sam-measure-stats-"));

writeFileSync(join(dir, "stub_supabase.ts"), "export const createClient = () => globalThis.__fakeDb;\n");
writeFileSync(join(dir, "stub_crypto.ts"),
  "export const crypto = { subtle: { digest: async () => new Uint8Array(16).buffer } };\n");
let platformSrc = readFileSync(join(HERE, "..", "platform.ts"), "utf-8");
for (const [from, to] of [
  ['import { createClient } from "jsr:@supabase/supabase-js@2";', 'import { createClient } from "./stub_supabase.ts";'],
  ['import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";', "type SupabaseClient = any;"],
  ['import { crypto as stdCrypto } from "jsr:@std/crypto";', 'import { crypto as stdCrypto } from "./stub_crypto.ts";'],
]) {
  if (!platformSrc.includes(from)) throw new Error(`platform.ts import changed — update this test: ${from}`);
  platformSrc = platformSrc.replace(from, to);
}
writeFileSync(join(dir, "platform.ts"), platformSrc);

const IMPORT = 'import { defineTool, clampLimit, envelope } from "../platform.ts";';
const toolSrc = readFileSync(join(HERE, "sam-measure-stats.ts"), "utf-8");
if (!toolSrc.includes(IMPORT)) throw new Error("sam-measure-stats.ts import line changed — update this test.");
writeFileSync(join(dir, "sam-measure-stats.ts"), toolSrc.replace(IMPORT, IMPORT.replace("../platform.ts", "./platform.ts")));

globalThis.Deno = { env: { get: () => "stub" } };
const mod = await import(pathToFileURL(join(dir, "sam-measure-stats.ts")).href);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const REQ = new Request("http://localhost/", {
  headers: { Authorization: `Bearer ${b64({ alg: "none" })}.${b64({ sub: "user-1" })}.sig` },
});

// --- fake database --------------------------------------------------------------
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SONG = U(1);
const SNIP = U(2);      // m.15-16
const S1 = U(11), S2 = U(12), S3 = U(13);

// 2026-09-17T19:00Z is 12:00 on the 17th in Pacific time.
const session = (id, over = {}) => ({
  id, song_id: SONG, snippet_id: null,
  started_at: "2026-09-17T19:00:00Z", ended_at: "2026-09-17T19:30:00Z",
  settings: { bpm: 60, playbackSpeed: 100, windowMs: 300 },
  summary: { midi: { everConnected: true }, notesPlayed: 40, tempo: { start: 60, end: 60, min: 60, max: 60 } },
  ...over,
});

// One beat row. `beat` is a quarter-note position within the measure.
const ev = (session_id, measure_number, beat, result, over = {}) => ({
  session_id, song_id: SONG, measure_number, beat, result,
  played_notes: [], expected_notes: [60], timing_delta_ms: null, loop_iteration: 0, ...over,
});

function baseTables() {
  return {
    sam_songs: [{ id: SONG, title: "Pastorale" }],
    sam_snippets: [{ id: SNIP, song_id: SONG, title: "Bars 15-16", start_measure: 15, end_measure: 16 }],
    sam_song_measures: [
      { song_id: SONG, number: 15, source_measure: "15" },
      { song_id: SONG, number: 16, source_measure: "16" },
      { song_id: SONG, number: 37, source_measure: "22" },   // a repeat: printed differs
      { song_id: SONG, number: 17, source_measure: null },
    ],
    sam_sessions: [session(S1), session(S2, { started_at: "2026-09-16T19:00:00Z", ended_at: "2026-09-16T19:20:00Z" })],
    sam_session_events: [],
  };
}

function makeDb(tables = baseTables()) {
  const calls = [];
  const db = {
    calls, tables,
    rpc(fn) {
      calls.push({ kind: "rpc", name: fn });
      return Promise.resolve({ data: [{ allowed: true, message: "" }], error: null });
    },
    from(table) {
      const st = { kind: "from", name: table, filters: [], order: [], range: null, limit: null };
      calls.push(st);
      const rows = () => tables[table] || [];
      const api = {
        // `select(cols, { count, head })` marks the query as a COUNT: it
        // resolves to a row count and no data. Filters still chain AFTER it,
        // exactly as in PostgREST, so the count cannot be taken here.
        select(_cols, opts) { if (opts?.head) st.head = true; return api; },
        eq(c, v) { st.filters.push((r) => r[c] === v); return api; },
        in(c, vs) { st.filters.push((r) => vs.includes(r[c])); return api; },
        gte(c, v) { st.filters.push((r) => r[c] >= v); return api; },
        lte(c, v) { st.filters.push((r) => r[c] <= v); return api; },
        not(c, op, v) { st.filters.push((r) => (op === "is" && v === null ? r[c] != null : true)); return api; },
        order(c, o = {}) { st.order.push([c, o.ascending !== false]); return api; },
        limit(n) { st.limit = n; return api; },
        range(a, b) { st.range = [a, b]; return run().then((r) => ({ ...r, data: r.data.slice(a, b + 1) })); },
        maybeSingle() { return run().then((r) => ({ ...r, data: r.data[0] ?? null })); },
        then(res, rej) {
          return run()
            .then((r) => (st.head ? { data: null, count: r.data.length, error: null } : r))
            .then(res, rej);
        },
      };
      function run() {
        let matched = rows().filter((r) => st.filters.every((f) => f(r)));
        for (const [c, asc] of [...st.order].reverse()) {
          matched = [...matched].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
        }
        if (st.limit != null) matched = matched.slice(0, st.limit);
        return Promise.resolve({ data: matched, error: null });
      }
      return api;
    },
  };
  return db;
}

async function call(args, db) {
  globalThis.__fakeDb = db;
  return (await mod.getSamMeasureStatsTool(args, REQ)).data;
}
const measure = (out, n) => out.measures.find((m) => m.measure === n);

// --- per measure across sessions -----------------------------------------------

test("a measure practised across several sessions: counts, hit rate, sessions and days", async () => {
  const tables = baseTables();
  tables.sam_session_events = [
    // Session 1, measure 15: 3 hits, 1 miss.
    ev(S1, 15, 1, "hit", { timing_delta_ms: -40 }),
    ev(S1, 15, 2, "hit", { timing_delta_ms: -60 }),
    ev(S1, 15, 3, "miss"),
    ev(S1, 15, 4, "hit", { timing_delta_ms: -50 }),
    // Session 2, same measure, another day: 1 hit, 1 partial.
    ev(S2, 15, 1, "hit", { timing_delta_ms: -20 }),
    ev(S2, 15, 2, "partial", { timing_delta_ms: -30 }),
  ];
  const out = await call({ song_id: SONG }, makeDb(tables));
  const m = measure(out, 15);
  assert.equal(m.attempts, 6);                       // hits + misses + partials
  assert.deepEqual(m.results, { hit: 4, miss: 1, partial: 1, extra: 0 });
  assert.equal(m.hit_rate_all, 80);                  // 4 / (4+1); the partial is outside
  assert.equal(m.hit_rate_attempted, 80);            // nothing was sat out
  assert.equal(m.sessions, 2);
  assert.equal(m.days, 2);
  assert.equal(m.timing.timed_beats, 5);
  assert.equal(m.timing.mean_offset_ms, -40);
  assert.equal(m.timing.median_offset_ms, -40);
  assert.equal(out.sessions.used, 2);
});

test("printed measure numbers ride along, and differ where a bar repeats", async () => {
  const tables = baseTables();
  tables.sam_session_events = [ev(S1, 37, 1, "hit", { timing_delta_ms: -10 }), ev(S1, 15, 1, "hit", { timing_delta_ms: -10 })];
  const out = await call({ song_id: SONG }, makeDb(tables));
  assert.equal(measure(out, 37).printed_measure, "22");
  assert.equal(measure(out, 15).printed_measure, "15");
});

test("loop iterations are reported, so drilling one bar is visible", async () => {
  const tables = baseTables();
  tables.sam_session_events = [
    ev(S1, 15, 1, "hit", { loop_iteration: 0, timing_delta_ms: -10 }),
    ev(S1, 15, 1, "hit", { loop_iteration: 1, timing_delta_ms: -10 }),
    ev(S1, 15, 1, "miss", { loop_iteration: 2 }),
    ev(S1, 16, 1, "hit", { loop_iteration: 0, timing_delta_ms: -10 }),
  ];
  const out = await call({ song_id: SONG }, makeDb(tables));
  assert.equal(measure(out, 15).loop_iterations, 3);
  assert.equal(measure(out, 15).attempts, 3);
  assert.equal(measure(out, 16).loop_iterations, 1);
});

// --- filters ----------------------------------------------------------------------

test("a snippet filter keeps its own range and drops appended rest measures", async () => {
  const tables = baseTables();
  tables.sam_sessions = [session(S1, { snippet_id: SNIP }), session(S3, { snippet_id: null })];
  tables.sam_session_events = [
    ev(S1, 15, 1, "hit", { timing_delta_ms: -10 }),
    ev(S1, 16, 1, "hit", { timing_delta_ms: -10 }),
    ev(S1, 17, 1, "hit", { timing_delta_ms: -10 }),   // the appended rest bar's number
    ev(S3, 15, 1, "miss"),                            // a whole-song session
  ];
  const out = await call({ song_id: SONG, snippet_id: SNIP }, makeDb(tables));
  assert.deepEqual(out.measures.map((m) => m.measure), [15, 16]);
  assert.equal(out.sessions.used, 1);                 // only the snippet's session
  assert.equal(measure(out, 15).results.miss, 0);     // the whole-song row is not here
  assert.equal(out.range.start_measure, 15);
  assert.equal(out.range.end_measure, 16);
});

test("a measure range wider than the snippet is clamped to the snippet's own bars", async () => {
  const tables = baseTables();
  tables.sam_sessions = [session(S1, { snippet_id: SNIP })];
  tables.sam_song_measures.push({ song_id: SONG, number: 10, source_measure: "10" });
  tables.sam_session_events = [
    ev(S1, 10, 1, "hit", { timing_delta_ms: -10 }),   // before the snippet
    ev(S1, 15, 1, "hit", { timing_delta_ms: -10 }),
    ev(S1, 17, 1, "hit", { timing_delta_ms: -10 }),   // after it: the appended rest bar
  ];
  const out = await call({ song_id: SONG, snippet_id: SNIP, start_measure: 10, end_measure: 30 }, makeDb(tables));
  assert.deepEqual(out.range, { ...out.range, start_measure: 15, end_measure: 16 });
  assert.deepEqual(out.measures.map((m) => m.measure), [15]);

  // A range entirely outside the snippet is refused rather than silently empty.
  await assert.rejects(
    call({ song_id: SONG, snippet_id: SNIP, start_measure: 1, end_measure: 5 }, makeDb(tables)),
    /lies outside snippet "Bars 15-16" \(m\.15–16\)/);
});

test("Pacific days decide the date filter", async () => {
  const tables = baseTables();
  // 2026-09-18T05:00Z is still 22:00 on the 17th in Pacific time.
  tables.sam_sessions = [session(S1, { started_at: "2026-09-18T05:00:00Z" })];
  tables.sam_session_events = [ev(S1, 15, 1, "hit", { timing_delta_ms: -10 })];
  const inRange = await call({ song_id: SONG, date_from: "2026-09-17", date_to: "2026-09-17" }, makeDb(tables));
  assert.equal(inRange.sessions.used, 1);
  const out = await call({ song_id: SONG, date_from: "2026-09-18" }, makeDb(tables));
  assert.equal(out.sessions.used, 0);
  assert.equal(out.sessions.excluded.outside_dates, 1);
});

test("sessions with no MIDI or no notes are excluded", async () => {
  const tables = baseTables();
  tables.sam_sessions = [
    session(S1, { summary: { midi: { everConnected: false }, notesPlayed: 50, tempo: { min: 60, max: 60, end: 60 } } }),
    session(S2, { summary: { midi: { everConnected: true }, notesPlayed: 0, tempo: { min: 60, max: 60, end: 60 } } }),
  ];
  tables.sam_session_events = [ev(S1, 15, 1, "hit"), ev(S2, 15, 1, "hit")];
  const out = await call({ song_id: SONG }, makeDb(tables));
  assert.equal(out.sessions.used, 0);
  assert.equal(out.sessions.excluded.no_midi_or_no_notes, 2);
  assert.deepEqual(out.measures, []);
  assert.match(out.sessions.note, /nothing to measure/);
});

test("mixed matching windows are reported and flagged", async () => {
  const tables = baseTables();
  tables.sam_sessions = [session(S1), session(S2, { settings: { bpm: 60, playbackSpeed: 100, windowMs: 120 } })];
  tables.sam_session_events = [ev(S1, 15, 1, "hit", { timing_delta_ms: -10 }), ev(S2, 15, 1, "miss")];
  const out = await call({ song_id: SONG }, makeDb(tables));
  assert.deepEqual(out.sessions.window_ms_values.sort(), [120, 300]);
  assert.equal(out.sessions.windows_differ, true);
  assert.match(out.sessions.window_warning, /not comparable/);

  const same = await call({ song_id: SONG }, makeDb(baseTables()));
  assert.equal(same.sessions.windows_differ, false);
  assert.equal(same.sessions.window_warning, undefined);
});

// --- results, extras and wrong notes -------------------------------------------

test("extras never count toward attempts or hit rate", async () => {
  const tables = baseTables();
  tables.sam_session_events = [
    ev(S1, 15, 1, "hit", { timing_delta_ms: -10 }),
    ev(S1, 15, 1, "extra", { played_notes: [61], timing_delta_ms: -500 }),
    ev(S1, 15, 1, "extra", { played_notes: [61], timing_delta_ms: null }),
  ];
  const out = await call({ song_id: SONG }, makeDb(tables));
  const m = measure(out, 15);
  assert.equal(m.attempts, 1);
  assert.equal(m.hit_rate_all, 100);
  assert.equal(m.results.extra, 2);
  assert.equal(m.timing.timed_beats, 1);             // the extra's offset is not a beat timing
  assert.equal(m.timing.mean_offset_ms, -10);
});

test("recurring wrong notes surface; one-offs and repeats within a pass do not", async () => {
  const tables = baseTables();
  tables.sam_sessions = [session(S1), session(S2), session(S3, { started_at: "2026-09-15T19:00:00Z" })];
  tables.sam_session_events = [
    // 61 struck at m.15 in three different passes — a pattern.
    ev(S1, 15, 1, "extra", { played_notes: [61] }),
    ev(S2, 15, 1, "extra", { played_notes: [61] }),
    ev(S3, 15, 1, "miss", { played_notes: [61, 63] }),   // wrong keys carried on a miss
    // ...and hammered four more times in ONE pass: still one occurrence there.
    ev(S1, 15, 2, "extra", { played_notes: [61] }),
    ev(S1, 15, 3, "extra", { played_notes: [61] }),
    // 70 appears once: noise.
    ev(S1, 15, 4, "extra", { played_notes: [70] }),
  ];
  const out = await call({ song_id: SONG }, makeDb(tables));
  const wrong = measure(out, 15).recurring_wrong_notes;
  assert.deepEqual(wrong, [{ midi: 61, passes: 3 }]);
  assert.deepEqual(out.rollup.most_wrong_notes[0].wrong_notes, [{ midi: 61, passes: 3 }]);
});

// --- timing: calibration vs error ------------------------------------------------

test("a constant offset leaves the interval ratio at 1: calibration, not error", async () => {
  const tables = baseTables();
  // Every beat 100ms late, evenly: the gaps are exactly right.
  tables.sam_session_events = Array.from({ length: 16 }, (_, i) =>
    ev(S1, 15 + (i > 7 ? 1 : 0), (i % 8) + 1, "hit", { timing_delta_ms: -100 }));
  const out = await call({ song_id: SONG }, makeDb(tables));
  const s = out.timing.per_session[0];
  assert.equal(s.mean_offset_ms, -100);
  assert.equal(s.interval_ratio_median, 1);
  assert.equal(s.interval_ratio_spread, 0);
  assert.ok(s.usable_intervals >= mod.MIN_INTERVALS_PER_SESSION);
  assert.equal(out.timing.overall.interval_ratio_median, 1);
  assert.match(out.timing.how_to_read, /CALIBRATION PLUS ERROR/);
});

test("genuinely rushing shows as a ratio below 1", async () => {
  const tables = baseTables();
  // 60 bpm, one quarter = 1000ms. Each beat is 100ms earlier than the last, so
  // each gap is 900ms against the 1000 the score asks for.
  tables.sam_session_events = Array.from({ length: 16 }, (_, i) =>
    ev(S1, 15, i + 1, "hit", { timing_delta_ms: i * 100 }));
  const out = await call({ song_id: SONG }, makeDb(tables));
  const s = out.timing.per_session[0];
  assert.equal(s.interval_ratio_median, 0.9);
  assert.ok(s.mean_offset_ms > 0);                  // "early" on average, and truly rushing
  // Thirds of 16 beats: the last five average 1,100ms earlier than the first five.
  assert.equal(s.drift_ms_per_pass, 1100);
});

test("intervals skip holes, cross-measure gaps and other loops", async () => {
  const msBeat = 1000;
  const rows = [
    ev(S1, 15, 1, "hit", { timing_delta_ms: 0 }),
    ev(S1, 15, 2, "miss"),                           // a hole: no interval spans it
    ev(S1, 15, 3, "hit", { timing_delta_ms: 0 }),
    ev(S1, 15, 4, "hit", { timing_delta_ms: 0 }),    // the only usable pair here
    // A different measure, with a LARGER beat number — the arithmetic would
    // happily produce a gap here, so only the measure check stops it.
    ev(S1, 16, 7, "hit", { timing_delta_ms: 0 }),
    ev(S1, 16, 8, "hit", { timing_delta_ms: 0, loop_iteration: 1 }), // a different pass
  ];
  const intervals = mod.intervalsFor(rows, msBeat);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].expectedMs, 1000);
  assert.equal(intervals[0].ratio, 1);
});

test("a session whose tempo moved mid-sitting is left out of the interval figures", async () => {
  const tables = baseTables();
  tables.sam_sessions = [session(S1, {
    summary: { midi: { everConnected: true }, notesPlayed: 40, tempo: { start: 60, end: 75, min: 60, max: 75 } },
  })];
  tables.sam_session_events = Array.from({ length: 16 }, (_, i) =>
    ev(S1, 15, i + 1, "hit", { timing_delta_ms: -100 }));
  const out = await call({ song_id: SONG }, makeDb(tables));
  const s = out.timing.per_session[0];
  assert.equal(s.tempo_steady, false);
  assert.equal(s.interval_ratio_median, null);
  assert.equal(s.mean_offset_ms, -100);             // the mean is still reported
  assert.equal(out.timing.skipped.tempo_unknown_or_varied, 1);
  assert.equal(mod.msPerQuarter({ settings: { bpm: 60 }, summary: { tempo: { min: 60, max: 75, end: 75 } } }), null);
});

test("too few gaps: the ratio is withheld rather than guessed", async () => {
  const tables = baseTables();
  tables.sam_session_events = Array.from({ length: 4 }, (_, i) =>
    ev(S1, 15, i + 1, "hit", { timing_delta_ms: -100 }));
  const out = await call({ song_id: SONG }, makeDb(tables));
  assert.equal(out.timing.per_session[0].interval_ratio_median, null);
  assert.equal(out.timing.per_session[0].usable_intervals, 3);
  assert.equal(out.timing.skipped.too_few_intervals, 1);
});

test("playback speed scales the expected gap", async () => {
  // 60 bpm at 50% speed: a quarter takes 2000ms, not 1000.
  assert.equal(mod.msPerQuarter({ settings: { bpm: 60, playbackSpeed: 50 }, summary: { tempo: { min: 60, max: 60, end: 60 } } }), 2000);
  assert.equal(mod.msPerQuarter({ settings: { bpm: 60, playbackSpeed: 100 }, summary: { tempo: { min: 60, max: 60, end: 60 } } }), 1000);
});

// --- rollup and validation ---------------------------------------------------------

test("the rollup names the weakest measures and the latest ones", async () => {
  const tables = baseTables();
  tables.sam_song_measures.push({ song_id: SONG, number: 20, source_measure: null });
  tables.sam_session_events = [
    ...Array.from({ length: 10 }, (_, i) => ev(S1, 15, i + 1, i < 2 ? "miss" : "hit", { timing_delta_ms: i < 2 ? null : -10 })),
    ...Array.from({ length: 16 }, (_, i) => ev(S1, 16, i + 1, i < 6 ? "miss" : "hit", { timing_delta_ms: i < 6 ? null : -200 })),
    ev(S1, 20, 1, "miss"),   // too few attempts to rank
  ];
  const out = await call({ song_id: SONG }, makeDb(tables));
  assert.deepEqual(out.rollup.weakest_measures.map((m) => m.measure), [16, 15]);
  assert.equal(out.rollup.weakest_measures[0].hit_rate_attempted, 63);   // 10 of 16
  assert.equal(out.rollup.most_late[0].measure, 16);
  assert.ok(!out.rollup.weakest_measures.some((m) => m.measure === 20));
  assert.match(out.rollup.ranking_note, /at least 8 scored beats/);
});

test("bad arguments are refused before any read", async () => {
  for (const [args, message] of [
    [{ song_id: "nope" }, /`song_id` must be a UUID/],
    [{ song_id: SONG, start_measure: 0 }, /`start_measure` must be a whole number/],
    [{ song_id: SONG, start_measure: 9, end_measure: 4 }, /`start_measure` \(9\) is after `end_measure` \(4\)/],
    [{ song_id: SONG, date_from: "17-09-2026" }, /must be a Pacific date/],
    [{ song_id: SONG, date_from: "2026-09-18", date_to: "2026-09-17" }, /is after `date_to`/],
    [{ song_id: SONG, snippet_id: "x" }, /`snippet_id` must be a UUID/],
  ]) {
    const db = makeDb();
    await assert.rejects(call(args, db), (e) => {
      assert.match(e.message, /^get_sam_measure_stats: /);
      assert.match(e.message, message);
      return true;
    });
    assert.deepEqual(db.calls.filter((c) => c.kind === "from"), []);
  }
  await assert.rejects(call({ song_id: U(99) }, makeDb()), /song .* not found/);
});

// --- wrong notes are only the notes that were WRONG (2026-09-19) ---------------

test("a failed chord lists only the pitches the beat did not expect", async () => {
  const tables = baseTables();
  // Pastorale m34: the chord is 55/60/62/67. He struck 55, 62, 60 and 71 —
  // three of them correct. Only 71 is a wrong note.
  tables.sam_session_events = Array.from({ length: 4 }, (_, i) =>
    ev(S1, 15, 1, "miss", {
      loop_iteration: i,
      expected_notes: [55, 60, 62, 67],
      played_notes: [55, 62, 60, 71],
    })
  );
  const out = await call({ song_id: SONG }, makeDb(tables));
  const wrong = measure(out, 15).recurring_wrong_notes;
  assert.deepEqual(wrong.map((w) => w.midi), [71]);
  assert.equal(wrong[0].passes, 4);
});

test("every pitch of an extra is wrong: it belonged to no beat", async () => {
  const tables = baseTables();
  tables.sam_session_events = Array.from({ length: 3 }, (_, i) =>
    ev(S1, 15, 1, "extra", { loop_iteration: i, expected_notes: [], played_notes: [61] })
  );
  const out = await call({ song_id: SONG }, makeDb(tables));
  assert.deepEqual(measure(out, 15).recurring_wrong_notes.map((w) => w.midi), [61]);
});

test("a miss with nothing struck contributes no wrong notes", async () => {
  const tables = baseTables();
  tables.sam_session_events = Array.from({ length: 5 }, (_, i) =>
    ev(S1, 15, 1, "miss", { loop_iteration: i, expected_notes: [60], played_notes: [] })
  );
  const out = await call({ song_id: SONG }, makeDb(tables));
  assert.deepEqual(measure(out, 15).recurring_wrong_notes, []);
});

// --- loop cycles he sat out ----------------------------------------------------

const satOutPass = (loop) => [
  ev(S1, 15, 1, "miss", { loop_iteration: loop }),
  ev(S1, 15, 2, "miss", { loop_iteration: loop }),
];
const playedPass = (loop, second = "hit") => [
  ev(S1, 15, 1, "hit", { loop_iteration: loop, timing_delta_ms: -10 }),
  ev(S1, 15, 2, second, { loop_iteration: loop, timing_delta_ms: second === "hit" ? -12 : null }),
];

test("two hit rates: cycles he sat out sink one and not the other", async () => {
  const tables = baseTables();
  tables.sam_session_events = [
    ...playedPass(0), ...playedPass(1), ...playedPass(2, "miss"),
    // Six cycles of the loop running on with nothing struck at all.
    ...[3, 4, 5, 6, 7, 8].flatMap(satOutPass),
  ];
  const out = await call({ song_id: SONG }, makeDb(tables));
  const m = measure(out, 15);
  assert.equal(m.sat_out_iterations, 6);
  assert.equal(m.attempted_iterations, 3);
  assert.equal(m.loop_iterations, 9);
  // All cycles: 5 hits of 18 scored beats = 28%.
  assert.equal(m.hit_rate_all, 28);
  // The cycles he played in: 5 hits of 6 = 83%.
  assert.equal(m.hit_rate_attempted, 83);
  assert.equal(m.attempted_scored_beats, 6);
});

test("one key struck anywhere makes the cycle an attempt, however badly it went", async () => {
  const tables = baseTables();
  tables.sam_session_events = [
    // Every beat a miss, but he DID strike something at the first.
    ev(S1, 15, 1, "miss", { loop_iteration: 0, played_notes: [61] }),
    ev(S1, 15, 2, "miss", { loop_iteration: 0 }),
    // ...and a cycle with a stray key and nothing else.
    ev(S1, 15, 1, "miss", { loop_iteration: 1 }),
    ev(S1, 15, 2, "extra", { loop_iteration: 1, expected_notes: [], played_notes: [61] }),
    // ...against one genuinely sat out.
    ...satOutPass(2),
  ];
  const out = await call({ song_id: SONG }, makeDb(tables));
  const m = measure(out, 15);
  assert.equal(m.sat_out_iterations, 1);
  assert.equal(m.attempted_iterations, 2);
  assert.equal(m.hit_rate_attempted, 0);   // bad playing is still playing
});

test("weakest_measures ranks on the attempted rate, and shows both", async () => {
  const tables = baseTables();
  tables.sam_song_measures.push({ song_id: SONG, number: 20, source_measure: null });
  // m15: played every time, genuinely weak — 4 of 12 beats hit.
  const m15 = Array.from({ length: 6 }, (_, p) => [
    ev(S1, 15, 1, p < 2 ? "hit" : "miss", { loop_iteration: p, timing_delta_ms: p < 2 ? -10 : null, played_notes: p < 2 ? [] : [61] }),
    ev(S1, 15, 2, p < 2 ? "hit" : "miss", { loop_iteration: p, timing_delta_ms: p < 2 ? -10 : null, played_notes: p < 2 ? [] : [61] }),
  ]).flat();
  // m20: played perfectly 5 times, then the loop ran on 20 times without him.
  const m20 = [
    ...Array.from({ length: 5 }, (_, p) => [
      ev(S1, 20, 1, "hit", { loop_iteration: p, timing_delta_ms: -10 }),
      ev(S1, 20, 2, "hit", { loop_iteration: p, timing_delta_ms: -10 }),
    ]).flat(),
    ...Array.from({ length: 20 }, (_, i) => [
      ev(S1, 20, 1, "miss", { loop_iteration: 5 + i }),
      ev(S1, 20, 2, "miss", { loop_iteration: 5 + i }),
    ]).flat(),
  ];
  tables.sam_session_events = [...m15, ...m20];
  const out = await call({ song_id: SONG }, makeDb(tables));

  // m20 reads far worse on every cycle, but he never actually missed it.
  assert.equal(measure(out, 20).hit_rate_all, 20);
  assert.equal(measure(out, 20).hit_rate_attempted, 100);
  // So the weakest measure is m15, which he really did miss.
  assert.equal(out.rollup.weakest_measures[0].measure, 15);
  assert.equal(out.rollup.weakest_measures[0].hit_rate_attempted, 33);
  assert.equal(out.rollup.weakest_measures[0].hit_rate_all, 33);
  assert.equal(out.rollup.weakest_measures[0].sat_out_iterations, 0);
  // m20 is still listed — it has enough attempted beats to rank — but BELOW
  // m15, which is the whole point. On the all-cycles rate it would have led.
  assert.deepEqual(out.rollup.weakest_measures.map((m) => m.measure), [15, 20]);
  assert.equal(out.rollup.weakest_measures[1].sat_out_iterations, 20);
});

// --- most_early only lists measures that were early ----------------------------

test("when every measure dragged, the early list is empty and says so", async () => {
  const tables = baseTables();
  tables.sam_song_measures.push({ song_id: SONG, number: 20, source_measure: null });
  // Both measures late; m20 merely LESS late. Mid-phrase beats only, so
  // nothing here is an entry beyond the first of each pass.
  tables.sam_session_events = [
    ...Array.from({ length: 10 }, (_, i) => ev(S1, 15, i + 1, "hit", { timing_delta_ms: -200 })),
    ...Array.from({ length: 10 }, (_, i) => ev(S1, 20, i + 1, "hit", { timing_delta_ms: -20 })),
  ];
  const out = await call({ song_id: SONG }, makeDb(tables));
  assert.deepEqual(out.rollup.most_early, []);
  assert.match(out.rollup.most_early_note, /No measure was early/);
  // Late still ranks, and m15 is the worst of them.
  assert.equal(out.rollup.most_late[0].measure, 15);
});

test("a genuinely early measure is listed, a late one is not", async () => {
  const tables = baseTables();
  tables.sam_song_measures.push({ song_id: SONG, number: 20, source_measure: null });
  tables.sam_session_events = [
    ...Array.from({ length: 10 }, (_, i) => ev(S1, 15, i + 1, "hit", { timing_delta_ms: -200 })),
    ...Array.from({ length: 10 }, (_, i) => ev(S1, 20, i + 1, "hit", { timing_delta_ms: +45 })),
  ];
  const out = await call({ song_id: SONG }, makeDb(tables));
  assert.deepEqual(out.rollup.most_early.map((m) => m.measure), [20]);
  assert.equal(out.rollup.most_early_note, undefined);
});

// --- entries versus mid-phrase -------------------------------------------------

test("entries are kept apart from notes inside a phrase", async () => {
  const tables = baseTables();
  tables.sam_song_measures.push({ song_id: SONG, number: 20, source_measure: null });
  // Two passes of m15 and m16, contiguous, so only beat 1 of each pass is an
  // entry. He is 200 ms late coming in and 10 ms late thereafter.
  tables.sam_session_events = [0, 1].flatMap((loop) => [
    ev(S1, 15, 1, "hit", { loop_iteration: loop, timing_delta_ms: -200 }),
    ev(S1, 15, 2, "hit", { loop_iteration: loop, timing_delta_ms: -10 }),
    ev(S1, 16, 1, "hit", { loop_iteration: loop, timing_delta_ms: -12 }),
    ev(S1, 16, 2, "hit", { loop_iteration: loop, timing_delta_ms: -8 }),
  ]);
  const out = await call({ song_id: SONG }, makeDb(tables));

  const e = out.timing.entries;
  assert.equal(e.entry.timed_beats, 2);          // one per pass
  assert.equal(e.entry.mean_offset_ms, -200);
  assert.equal(e.mid_phrase.timed_beats, 6);
  assert.equal(e.mid_phrase.mean_offset_ms, -10);
  assert.equal(e.difference_ms, -190);

  // Per measure, too: m15's overall mean is dragged down by its entry.
  const m15 = measure(out, 15);
  assert.equal(m15.timing.entry.timed_beats, 2);
  assert.equal(m15.timing.entry.mean_offset_ms, -200);
  assert.equal(m15.timing.mid_phrase.mean_offset_ms, -10);
  assert.equal(m15.timing.mean_offset_ms, -105);   // the two mixed together
  // m16 is never entered on: every beat of it is mid-phrase.
  assert.equal(measure(out, 16).timing.entry.timed_beats, 0);
});

test("a note after a bar or more of rest counts as an entry", async () => {
  const tables = baseTables();
  for (const n of [16, 18, 19]) tables.sam_song_measures.push({ song_id: SONG, number: n, source_measure: null });
  tables.sam_session_events = [
    ev(S1, 15, 1, "hit", { timing_delta_ms: -180 }),   // start of the pass
    ev(S1, 16, 1, "hit", { timing_delta_ms: -10 }),    // next bar: mid-phrase
    // m17 is silent entirely, so m18 is entered from a full bar of rest.
    ev(S1, 18, 1, "hit", { timing_delta_ms: -170 }),
    ev(S1, 19, 1, "hit", { timing_delta_ms: -12 }),
  ];
  const out = await call({ song_id: SONG }, makeDb(tables));
  assert.equal(measure(out, 15).timing.entry.timed_beats, 1);
  assert.equal(measure(out, 16).timing.entry.timed_beats, 0);
  assert.equal(measure(out, 18).timing.entry.timed_beats, 1);   // the rest
  assert.equal(measure(out, 19).timing.entry.timed_beats, 0);
  assert.equal(out.timing.entries.entry.mean_offset_ms, -175);
});

test("late and early rank on mid-phrase beats, not on the bars he enters on", async () => {
  const tables = baseTables();
  tables.sam_song_measures.push({ song_id: SONG, number: 20, source_measure: null });
  // m15 is only ever entered on and looks terrible; m20 is played inside the
  // phrase and is the genuinely late one.
  tables.sam_session_events = [
    ...Array.from({ length: 10 }, (_, p) => [
      ev(S1, 15, 1, "hit", { loop_iteration: p, timing_delta_ms: -300 }),
      ...Array.from({ length: 9 }, (_, i) => ev(S1, 20, i + 1, "hit", { loop_iteration: p, timing_delta_ms: -50 })),
    ]).flat(),
  ];
  const out = await call({ song_id: SONG }, makeDb(tables));
  // m15 has no mid-phrase beats at all, so it cannot be ranked.
  assert.equal(measure(out, 15).timing.mid_phrase.timed_beats, 0);
  assert.deepEqual(out.rollup.most_late.map((m) => m.measure), [20]);
  assert.equal(out.rollup.most_late[0].mean_offset_ms, -50);
  assert.match(out.rollup.timing_ranking_note, /MID-PHRASE/);
});

// --- how much a range threw away -----------------------------------------------

test("a snippet says how many rows its range excluded", async () => {
  const tables = baseTables();
  tables.sam_sessions = [session(S1, { snippet_id: SNIP })];
  tables.sam_session_events = [
    ev(S1, 15, 1, "hit", { timing_delta_ms: -10 }),
    ev(S1, 16, 1, "hit", { timing_delta_ms: -10 }),
    // The rest measures a snippet's loop appends, outside m.15-16.
    ev(S1, 17, 1, "miss"),
    ev(S1, 18, 1, "miss"),
    ev(S1, 19, 1, "miss"),
  ];
  const out = await call({ song_id: SONG, snippet_id: SNIP }, makeDb(tables));
  assert.equal(out.range.rows_read, 2);
  assert.equal(out.range.rows_outside_range, 3);
  assert.match(out.range.rows_outside_range_note, /3 rows/);
  assert.match(out.range.rows_outside_range_note, /Bars 15-16/);
  assert.equal(measure(out, 17), undefined);
});

test("no range, no exclusion count to report", async () => {
  const tables = baseTables();
  tables.sam_session_events = [ev(S1, 15, 1, "hit", { timing_delta_ms: -10 })];
  const out = await call({ song_id: SONG }, makeDb(tables));
  assert.equal(out.range.rows_outside_range, null);
  assert.equal(out.range.rows_outside_range_note, undefined);
});
