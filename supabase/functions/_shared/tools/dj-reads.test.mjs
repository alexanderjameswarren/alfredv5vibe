// Handler tests for get_dj_plays, against a simulated PostgREST client.
//
// Run (Node 24+, no Deno toolchain needed):
//   node --experimental-strip-types --test supabase/functions/_shared/tools/dj-reads.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, copyFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = [
  "const clampLimit = (n: number | undefined) => Math.min(n ?? 20, 50);",
  "const defineTool = (o: any) => { (globalThis as any).__tools ??= []; (globalThis as any).__tools.push(o); return o; };",
].join("\n");

const dir = mkdtempSync(join(tmpdir(), "dj-reads-"));
for (const f of readdirSync(HERE)) {
  if (f.startsWith("dj-") && f.endsWith(".ts")) copyFileSync(join(HERE, f), join(dir, f));
}
const src = readFileSync(join(HERE, "dj-reads.ts"), "utf-8").replace(
  'import { clampLimit, defineTool } from "../platform.ts";',
  STUB,
);
if (src.includes("../platform.ts")) {
  throw new Error("dj-reads.ts import line changed — update the stub in this test.");
}
writeFileSync(join(dir, "dj-reads.probe.ts"), src);

globalThis.__tools = [];
await import(pathToFileURL(join(dir, "dj-reads.probe.ts")).href);
const tool = Object.fromEntries(globalThis.__tools.map((t) => [t.name, t]));

// --- a small PostgREST fake ------------------------------------------------

function makeDb(tables) {
  function builder(table) {
    const filters = [];
    let head = false, wantCount = false, limit = null;
    const api = {
      select(_cols, opts = {}) {
        wantCount = opts.count === "exact";
        head = Boolean(opts.head);
        return api;
      },
      in(c, v) { filters.push((r) => v.includes(r[c])); return api; },
      eq(c, v) { filters.push((r) => r[c] === v); return api; },
      gte(c, v) { filters.push((r) => r[c] >= v); return api; },
      lte(c, v) { filters.push((r) => r[c] <= v); return api; },
      order() { return api; },
      limit(n) { limit = n; return api; },
      then(resolve) {
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        const count = rows.length;
        if (limit != null) rows = rows.slice(0, limit);
        return resolve({ data: head ? null : rows, error: null, count: wantCount ? count : null });
      },
    };
    return api;
  }
  return { from: (t) => builder(t) };
}

const run = (tables, args) =>
  tool.get_dj_plays.handler(args, { db: makeDb(tables), userId: "u1" });

const track = (id, video_id, title, canonical = null) =>
  ({ id, video_id, title, artist: "Weezer", canonical_track_id: canonical });
const play = (track_id, played_on, precision = "day", source = "poll") =>
  ({ id: `p-${track_id}-${played_on}-${Math.random()}`, track_id, played_on,
     precision, played_bucket: "Today", occurrence: 1, source,
     observed_at: `${played_on}T12:00:00Z` });

// ---------------------------------------------------------------------------
// The zero-play rule — the reason this shape exists
// ---------------------------------------------------------------------------

test("a known track with NO plays comes back with distinct_days 0", async () => {
  const tables = {
    dj_tracks: [track("t1", "v1", "Buddy Holly"), track("t2", "v2", "Hash Pipe")],
    dj_plays: [play("t1", "2026-08-28")],
  };
  const r = await run(tables, { mode: "familiarity", video_ids: ["v1", "v2"] });
  assert.equal(r.data.returned, 2, "both requested ids must appear");
  const byVid = Object.fromEntries(r.data.groups.map((g) => [g.canonical_video_id, g]));
  assert.equal(byVid.v2.distinct_days, 0);
  assert.equal(byVid.v2.play_rows, 0);
  assert.equal(byVid.v2.first_played_on, null);
  assert.equal(byVid.v2.days_since_last, null, "null means NEVER, distinct from 0");
  assert.equal(byVid.v2.known_track, true);
});

test("a video_id unknown to dj_tracks ENTIRELY still comes back", async () => {
  // A newly discovered setlist song. §5 says it floats to the top of cram;
  // it must not be invisible just because nothing has been recorded for it.
  const tables = { dj_tracks: [track("t1", "v1", "Buddy Holly")], dj_plays: [] };
  const r = await run(tables, { mode: "familiarity", video_ids: ["v1", "v_new"] });
  assert.equal(r.data.returned, 2);
  const unknown = r.data.groups.find((g) => g.canonical_video_id === "v_new");
  assert.equal(unknown.known_track, false);
  assert.equal(unknown.distinct_days, 0);
  // Annotation, not exclusion: the id is in BOTH the results and this list.
  assert.deepEqual(r.data.unknown_ids_returned_as_zeros, ["v_new"]);
  assert.equal(r.data.all_requested_returned, true);
  assert.equal(r.data.unknown_video_ids, undefined, "old misleading name is gone");
});

test("all_requested_returned is the single assertion a caller can make", async () => {
  // The old field name read as a bucket these ids went into INSTEAD of the
  // results, and misled a reader into thinking unknowns were dropped. One
  // boolean removes the need to count.
  const tables = {
    dj_tracks: [track("t1", "v1", "A"), track("t2", "v2", "B")],
    dj_plays: [play("t1", "2026-08-28")],
  };
  const r = await run(tables, { mode: "familiarity", video_ids: ["v1", "v2", "v_ghost"] });
  assert.equal(r.data.returned, 3);
  assert.equal(r.data.all_requested_returned, true);
  assert.deepEqual(r.data.unknown_ids_returned_as_zeros, ["v_ghost"]);
  const ids = r.data.groups.map((g) => g.canonical_video_id).sort();
  assert.deepEqual(ids, ["v1", "v2", "v_ghost"], "every requested id is present");
});

test("all-unknown ids short-circuit to all zeros without scanning", async () => {
  const r = await run({ dj_tracks: [], dj_plays: [] },
    { mode: "familiarity", video_ids: ["a", "b", "c"] });
  assert.equal(r.data.returned, 3);
  assert.equal(r.data.rows_scanned, 0);
  assert.ok(r.data.groups.every((g) => g.distinct_days === 0 && !g.known_track));
});

test("least familiar first — never-played sorts above everything", async () => {
  const tables = {
    dj_tracks: [track("t1", "v1", "A"), track("t2", "v2", "B"), track("t3", "v3", "C")],
    dj_plays: [
      play("t1", "2026-08-01"), play("t1", "2026-08-02"), play("t1", "2026-08-03"),
      play("t2", "2026-08-05"),
    ],
  };
  const r = await run(tables, { mode: "familiarity", video_ids: ["v1", "v2", "v3"], as_of: "2026-08-10" });
  assert.deepEqual(
    r.data.groups.map((g) => g.canonical_video_id),
    ["v3", "v2", "v1"],
    "0 days, then 1 day, then 3 days",
  );
  assert.deepEqual(r.data.groups.map((g) => g.distinct_days), [0, 1, 3]);
});

// ---------------------------------------------------------------------------
// Distinct days, not play count
// ---------------------------------------------------------------------------

test("two plays on ONE day is one distinct day but two play_rows", async () => {
  const tables = {
    dj_tracks: [track("t1", "v1", "A")],
    dj_plays: [play("t1", "2026-08-28"), play("t1", "2026-08-28")],
  };
  const r = await run(tables, { mode: "familiarity", video_ids: ["v1"] });
  const g = r.data.groups[0];
  assert.equal(g.distinct_days, 1, "distinct_days is DAYS, not rows");
  assert.equal(g.play_rows, 2, "play_rows keeps the difference visible");
});

test("canonical variants count toward ONE group", async () => {
  // The whole point of §4.1: a song heard across two uploads is one song.
  const tables = {
    dj_tracks: [
      track("t1", "v_clean", "All My Favorite Songs"),
      track("t2", "v_ajr", "All My Favorite Songs (feat. AJR)", "t1"),
    ],
    dj_plays: [play("t1", "2026-08-01"), play("t2", "2026-08-02")],
  };
  const r = await run(tables, { mode: "familiarity", video_ids: ["v_clean"] });
  assert.equal(r.data.returned, 1);
  const g = r.data.groups[0];
  assert.equal(g.distinct_days, 2, "a play by either variant counts");
  assert.deepEqual(g.member_video_ids, ["v_ajr", "v_clean"]);
  assert.equal(g.canonical_video_id, "v_clean");
});

test("asking by the VARIANT id resolves to the same group", async () => {
  const tables = {
    dj_tracks: [
      track("t1", "v_clean", "All My Favorite Songs"),
      track("t2", "v_ajr", "All My Favorite Songs (feat. AJR)", "t1"),
    ],
    dj_plays: [play("t1", "2026-08-01"), play("t2", "2026-08-02")],
  };
  const r = await run(tables, { mode: "familiarity", video_ids: ["v_ajr"] });
  assert.equal(r.data.groups[0].distinct_days, 2);
  assert.deepEqual(r.data.groups[0].requested_video_ids, ["v_ajr"]);
});

test("estimated_days flags days made only of coarse-bucket guesses", async () => {
  const tables = {
    dj_tracks: [track("t1", "v1", "A")],
    dj_plays: [
      play("t1", "2026-08-01", "day"),
      play("t1", "2026-08-02", "week"),
      play("t1", "2026-08-03", "fortnight"),
    ],
  };
  const r = await run(tables, { mode: "familiarity", video_ids: ["v1"] });
  assert.equal(r.data.groups[0].distinct_days, 3);
  assert.equal(r.data.groups[0].estimated_days, 2);
});

test("days_since_last is measured against as_of", async () => {
  const tables = {
    dj_tracks: [track("t1", "v1", "A")],
    dj_plays: [play("t1", "2026-08-20")],
  };
  const r = await run(tables, { mode: "familiarity", video_ids: ["v1"], as_of: "2026-08-29" });
  assert.equal(r.data.groups[0].days_since_last, 9);
  assert.equal(r.data.as_of, "2026-08-29");
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test("familiarity refuses to run unbounded", async () => {
  await assert.rejects(
    () => run({ dj_tracks: [], dj_plays: [] }, { mode: "familiarity" }),
    /requires either `video_ids` or a date range/,
  );
});

test("an enumerated subject is NEVER truncated by limit", async () => {
  // Clamping here would recreate the reconstruction problem the zero-play rule
  // exists to remove.
  const tracks = Array.from({ length: 30 }, (_, i) => track(`t${i}`, `v${i}`, `S${i}`));
  const r = await run({ dj_tracks: tracks, dj_plays: [] },
    { mode: "familiarity", video_ids: tracks.map((t) => t.video_id), limit: 5 });
  assert.equal(r.data.returned, 30);
  assert.deepEqual(r.meta, {});
});

test("an oversized aggregate ERRORS rather than returning a wrong number", async () => {
  const tables = {
    dj_tracks: [track("t1", "v1", "A")],
    dj_plays: Array.from({ length: 5001 }, (_, i) =>
      play("t1", `2026-0${(i % 9) + 1}-01`)),
  };
  await assert.rejects(
    () => run(tables, { mode: "familiarity", video_ids: ["v1"] }),
    /over the cap of 5000[\s\S]*wrong rather than short/,
  );
});

test("bad dates and an inverted range are rejected", async () => {
  const t = { dj_tracks: [], dj_plays: [] };
  await assert.rejects(() => run(t, { from_date: "28-08-2026" }), /must be YYYY-MM-DD/);
  await assert.rejects(
    () => run(t, { from_date: "2026-08-29", to_date: "2026-08-01" }),
    /is after to_date/,
  );
});

test("too many video_ids is rejected", async () => {
  const ids = Array.from({ length: 51 }, (_, i) => `v${i}`);
  await assert.rejects(
    () => run({ dj_tracks: [], dj_plays: [] }, { video_ids: ids }),
    /exceeds the cap of 50/,
  );
});

// ---------------------------------------------------------------------------
// plays mode
// ---------------------------------------------------------------------------

test("plays mode inlines the track and reports a real total", async () => {
  const tables = {
    dj_tracks: [track("t1", "v1", "Buddy Holly")],
    dj_plays: [play("t1", "2026-08-28"), play("t1", "2026-08-27")],
  };
  const r = await run(tables, { mode: "plays", limit: 1 });
  assert.equal(r.data.returned, 1);
  assert.equal(r.data.total, 2);
  assert.equal(r.data.plays[0].track.title, "Buddy Holly");
  assert.equal(r.meta.truncated, true);
  assert.equal(r.meta.total, 2);
});

test("plays mode filters by date range and source", async () => {
  const tables = {
    dj_tracks: [track("t1", "v1", "A")],
    dj_plays: [
      play("t1", "2026-08-01", "day", "poll"),
      play("t1", "2026-08-28", "day", "poll"),
      play("t1", "2026-08-28", "exact", "takeout"),
    ],
  };
  const inRange = await run(tables, { mode: "plays", from_date: "2026-08-15", limit: 50 });
  assert.equal(inRange.data.total, 2);
  const takeout = await run(tables, { mode: "plays", source: "takeout", limit: 50 });
  assert.equal(takeout.data.total, 1);
});

test("plays mode for an unknown video_id returns empty with a reason", async () => {
  const r = await run({ dj_tracks: [], dj_plays: [] }, { mode: "plays", video_ids: ["nope"] });
  assert.equal(r.data.returned, 0);
  assert.match(r.data.note, /None of the supplied video_ids are known to dj_tracks/);
});

test("an invalid mode is rejected", async () => {
  await assert.rejects(
    () => run({ dj_tracks: [], dj_plays: [] }, { mode: "summary" }),
    /must be 'plays' or 'familiarity'/,
  );
});
