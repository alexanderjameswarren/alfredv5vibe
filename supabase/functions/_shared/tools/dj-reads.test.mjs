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
    let head = false, wantCount = false, limit = null, single = false;
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
      single() { single = true; return api; },
      maybeSingle() { single = true; return api; },
      then(resolve) {
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        const count = rows.length;
        if (limit != null) rows = rows.slice(0, limit);
        if (single) return resolve({ data: rows[0] ?? null, error: null, count: null });
        return resolve({ data: head ? null : rows, error: null, count: wantCount ? count : null });
      },
    };
    return api;
  }
  return { from: (t) => builder(t) };
}

const run = (tables, args) =>
  tool.get_dj_plays.handler(args, { db: makeDb(tables), userId: "u1" });
const runMp = (tables, args) =>
  tool.get_dj_managed_playlists.handler(args, { db: makeDb(tables), userId: "u1" });

const track = (id, video_id, title, canonical = null, album = null, artist = "Weezer") =>
  ({ id, video_id, title, artist, album, canonical_track_id: canonical });
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


// ---------------------------------------------------------------------------
// get_dj_managed_playlists — rendered_position
// ---------------------------------------------------------------------------

const PL = {
  id: "pl1", yt_playlist_id: "PLxyz", name: "Weezer Concert 2026", kind: "concert",
  concert_id: "c1", description: null, cram_cap: 8,
  last_synced_at: null, created_at: "2026-08-28T00:00:00Z",
};
const mem = (track_id, role, position, svid = "SV" + track_id) =>
  ({ id: `m-${role}-${position}`, playlist_id: "pl1", track_id, role, position,
     yt_set_video_id: svid, added_reason: "import", added_at: "2026-08-28T00:00:00Z" });

test("rendered_position is cram-then-body, and WRONG implementations fail here", async () => {
  // Designed so the three plausible-but-wrong implementations each produce a
  // different, detectably incorrect sequence:
  //   using `position` directly      -> collisions (cram 1 and body 1 both -> 1)
  //   sorting by position across all -> interleaved b1,c1,b2,c2,b3
  //   body-then-cram                 -> b1,b2,b3,c1,c2
  // Only cram-by-position-then-body-by-position gives c1,c2,b1,b2,b3.
  const tables = {
    dj_playlists: [PL],
    dj_playlist_tracks: [
      mem("tb1", "body", 1), mem("tb2", "body", 2), mem("tb3", "body", 3),
      mem("tc1", "cram", 1), mem("tc2", "cram", 2),
    ],
    dj_tracks: [
      track("tb1", "vb1", "Body One"), track("tb2", "vb2", "Body Two"),
      track("tb3", "vb3", "Body Three"),
      track("tc1", "vc1", "Cram One"), track("tc2", "vc2", "Cram Two"),
    ],
  };
  const r = await runMp(tables, { mode: "tracks", yt_playlist_id: "PLxyz" });
  assert.deepEqual(
    r.data.tracks.map((t) => t.video_id),
    ["vc1", "vc2", "vb1", "vb2", "vb3"],
  );
  assert.deepEqual(r.data.tracks.map((t) => t.rendered_position), [0, 1, 2, 3, 4]);
  // Per-zone positions are UNCHANGED — rendered_position is additional, not a
  // replacement, or a caller could not map back to the row it must update.
  assert.deepEqual(r.data.tracks.map((t) => t.position), [1, 2, 1, 2, 3]);
  assert.deepEqual(r.data.tracks.map((t) => t.role),
    ["cram", "cram", "body", "body", "body"]);
});

test("membership rows are NOT deduplicated by track", async () => {
  // §5: a track holding one row per zone is load-bearing — it is what makes
  // "clear the cram list" leave the concert order intact. Dedup would silently
  // destroy that.
  const tables = {
    dj_playlists: [PL],
    dj_playlist_tracks: [mem("t1", "body", 1, "SVbody"), mem("t1", "cram", 1, "SVcram")],
    dj_tracks: [track("t1", "v1", "Shine Again")],
  };
  const r = await runMp(tables, { mode: "tracks", yt_playlist_id: "PLxyz" });
  assert.equal(r.data.counts.total, 2);
  assert.deepEqual(r.data.tracks.map((t) => t.role), ["cram", "body"]);
  assert.deepEqual(r.data.tracks.map((t) => t.video_id), ["v1", "v1"]);
  assert.deepEqual(r.data.tracks.map((t) => t.yt_set_video_id), ["SVcram", "SVbody"]);
});

test("out-of-order rows still render by position, not by storage order", async () => {
  const tables = {
    dj_playlists: [PL],
    dj_playlist_tracks: [
      mem("tb3", "body", 3), mem("tc2", "cram", 2),
      mem("tb1", "body", 1), mem("tc1", "cram", 1), mem("tb2", "body", 2),
    ],
    dj_tracks: [
      track("tb1", "vb1", "B1"), track("tb2", "vb2", "B2"), track("tb3", "vb3", "B3"),
      track("tc1", "vc1", "C1"), track("tc2", "vc2", "C2"),
    ],
  };
  const r = await runMp(tables, { mode: "tracks", yt_playlist_id: "PLxyz" });
  assert.deepEqual(r.data.tracks.map((t) => t.video_id),
    ["vc1", "vc2", "vb1", "vb2", "vb3"]);
});

test("missing set_video_id is counted so a rebuild finds out before moving", async () => {
  const tables = {
    dj_playlists: [PL],
    dj_playlist_tracks: [mem("t1", "body", 1, null), mem("t2", "body", 2, "SV2")],
    dj_tracks: [track("t1", "v1", "A"), track("t2", "v2", "B")],
  };
  const r = await runMp(tables, { mode: "tracks", yt_playlist_id: "PLxyz" });
  assert.equal(r.data.counts.missing_set_video_id, 1);
});

test("tracks mode resolves by EITHER id form", async () => {
  const tables = {
    dj_playlists: [PL],
    dj_playlist_tracks: [mem("t1", "body", 1)],
    dj_tracks: [track("t1", "v1", "A")],
  };
  const byYt = await runMp(tables, { mode: "tracks", yt_playlist_id: "PLxyz" });
  const byId = await runMp(tables, { mode: "tracks", playlist_id: "pl1" });
  assert.deepEqual(byYt.data.tracks, byId.data.tracks);
});

test("an unrecorded playlist errors and says why", async () => {
  await assert.rejects(
    () => runMp({ dj_playlists: [], dj_playlist_tracks: [], dj_tracks: [] },
      { mode: "tracks", yt_playlist_id: "PLnope" }),
    /record_dj_playlist writes this side/,
  );
});

test("list mode reports per-role counts and cram headroom", async () => {
  const tables = {
    dj_playlists: [PL],
    dj_playlist_tracks: [
      mem("t1", "body", 1), mem("t2", "body", 2), mem("t3", "cram", 1),
    ],
    dj_tracks: [track("t1", "v1", "A"), track("t2", "v2", "B"), track("t3", "v3", "C")],
  };
  const r = await runMp(tables, { mode: "list" });
  assert.deepEqual(r.data.playlists[0].track_counts, { body: 2, cram: 1, total: 3 });
  assert.equal(r.data.playlists[0].cram_headroom, 7, "cram_cap 8 minus 1 cram row");
});

test("mode must be a known one, and tracks needs an id", async () => {
  // The vocabulary grew: 'engagement' (§12.9) and 'cram' (§12.10) joined it.
  // Updated rather than loosened — the assertion still names every valid mode,
  // so adding one silently is still a test failure.
  const empty = { dj_playlists: [], dj_playlist_tracks: [], dj_tracks: [] };
  await assert.rejects(() => runMp(empty, { mode: "everything" }),
    /must be 'list', 'tracks', 'engagement' or 'cram'/);
  await assert.rejects(() => runMp(empty, { mode: "tracks" }),
    /requires `yt_playlist_id` or `playlist_id`/);
});

test("album is readable — the poll's null and a playlist's real value both visible", async () => {
  // A field nobody can read is a field nobody can check. The poll never stores
  // album (spec §9); confirming that previously required the SQL editor.
  const tables = {
    dj_playlists: [PL],
    dj_playlist_tracks: [mem("t1", "body", 1), mem("t2", "body", 2)],
    dj_tracks: [
      track("t1", "v1", "Hackensack", null, null),
      track("t2", "v2", "Buddy Holly", null, "Weezer (Blue Album)"),
    ],
  };
  const r = await runMp(tables, { mode: "tracks", yt_playlist_id: "PLxyz" });
  assert.deepEqual(r.data.tracks.map((t) => t.album), [null, "Weezer (Blue Album)"]);
});

test("plays mode exposes album on the inlined track", async () => {
  const tables = {
    dj_tracks: [track("t1", "v1", "A", null, "Some Album")],
    dj_plays: [play("t1", "2026-08-28")],
  };
  const r = await run(tables, { mode: "plays", limit: 10 });
  assert.equal(r.data.plays[0].track.album, "Some Album");
});

test("familiarity exposes canonical_artist — the field a spelling split hides behind", async () => {
  // "Eddie Higgins Trio" (poll) vs "Eddie Higgins" (Takeout channel) produce
  // different match_keys and therefore different groups. Without the artist on
  // the group, two entries for one act look like two different songs.
  const tables = {
    dj_tracks: [
      track("t1", "v1", "Detour Ahead", null, null, "Eddie Higgins Trio"),
      track("t2", "v2", "Detour Ahead", null, null, "Eddie Higgins"),
    ],
    dj_plays: [play("t1", "2026-08-27"), play("t2", "2026-08-28")],
  };
  const r = await run(tables, { mode: "familiarity", video_ids: ["v1", "v2"] });
  assert.equal(r.data.returned, 2, "different primary artist = different group");
  const arts = r.data.groups.map((g) => g.canonical_artist).sort();
  assert.deepEqual(arts, ["Eddie Higgins", "Eddie Higgins Trio"]);
});

test("an unknown id carries canonical_artist null, not undefined", async () => {
  const r = await run({ dj_tracks: [], dj_plays: [] },
    { mode: "familiarity", video_ids: ["ghost"] });
  assert.equal(r.data.groups[0].canonical_artist, null);
});

// --- mode=cram (§12.10) -----------------------------------------------------

const pl = (id, name, kind = "concert", cram_cap = 8) =>
  ({ id, yt_playlist_id: `YT_${id}`, name, kind, concert_id: null,
     description: null, cram_cap, last_synced_at: null, created_at: "2026-01-01" });
const cmem = (playlist_id, track_id, role, position) =>
  ({ id: `m-${track_id}-${role}`, playlist_id, track_id, role, position,
     yt_set_video_id: null, added_reason: "import", added_at: "2026-01-01" });

test("cram order is least-familiar-first, never-played at the top", async () => {
  const tables = {
    dj_playlists: [pl("p1", "Foo Fighters Concert")],
    dj_playlist_tracks: [
      cmem("p1", "t1", "body", 0), cmem("p1", "t2", "body", 1), cmem("p1", "t3", "body", 2),
    ],
    dj_tracks: [track("t1", "v1", "Played lots"), track("t2", "v2", "Played once"),
                track("t3", "v3", "Never played")],
    dj_plays: [play("t1", "2026-08-01"), play("t1", "2026-08-02"),
               play("t1", "2026-08-03"), play("t2", "2026-08-05")],
  };
  const r = await runMp(tables, { mode: "cram", playlist_id: "p1", as_of: "2026-08-10" });
  assert.deepEqual(r.data.proposed_cram.map((c) => c.title),
    ["Never played", "Played once", "Played lots"]);
  assert.equal(r.data.proposed_cram[0].distinct_days, 0);
});

test("a song appearing TWICE in the body takes ONE cram slot", async () => {
  // §12.10's dedupe. Since 012 a body may repeat a track; without grouping,
  // identical familiarity would let one song occupy several of the eight slots
  // — a cram list that looks full and is teaching fewer songs than it says.
  const tables = {
    dj_playlists: [pl("p1", "X")],
    dj_playlist_tracks: [
      cmem("p1", "t1", "body", 0), { ...cmem("p1", "t1", "body", 5), id: "m-dup" },
      cmem("p1", "t2", "body", 1),
    ],
    dj_tracks: [track("t1", "v1", "Repeated"), track("t2", "v2", "Other")],
    dj_plays: [],
  };
  const r = await runMp(tables, { mode: "cram", playlist_id: "p1" });
  const titles = r.data.proposed_cram.map((c) => c.title);
  assert.equal(new Set(titles).size, titles.length, "no title may appear twice");
  assert.equal(titles.length, 2);
});

test("cram_stale fires when an UNPLAYED song holds no cram row", async () => {
  const tables = {
    dj_playlists: [pl("p1", "X")],
    dj_playlist_tracks: [cmem("p1", "t1", "body", 0)],
    dj_tracks: [track("t1", "v1", "Never heard")],
    dj_plays: [],
  };
  const r = await runMp(tables, { mode: "cram", playlist_id: "p1" });
  assert.equal(r.data.cram_stale, true);
  assert.equal(r.data.stale_reasons.unlearned_not_crammed.length, 1);
});

test("cram_stale fires when a LEARNED song is still holding a slot", async () => {
  const tables = {
    dj_playlists: [pl("p1", "X")],
    dj_playlist_tracks: [cmem("p1", "t1", "cram", 0)],
    dj_tracks: [track("t1", "v1", "Known now")],
    dj_plays: ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"]
      .map((d) => play("t1", d)),
  };
  const r = await runMp(tables, { mode: "cram", playlist_id: "p1" });
  assert.equal(r.data.cram_stale, true);
  assert.equal(r.data.stale_reasons.learned_still_crammed.length, 1);
});

test("cram_stale is FALSE when neither state holds — it is not a sort comparison", async () => {
  // The negative control, and the point of §11.7: a flag that fires every week
  // is ignored by the third week. A settled playlist must read false even though
  // the computed order differs from the stored cram block.
  const tables = {
    dj_playlists: [pl("p1", "X")],
    dj_playlist_tracks: [cmem("p1", "t1", "cram", 0), cmem("p1", "t2", "body", 0)],
    dj_tracks: [track("t1", "v1", "Learning"), track("t2", "v2", "Known")],
    dj_plays: [play("t1", "2026-08-01"),
               ...["2026-08-01", "2026-08-02"].map((d) => play("t2", d))],
  };
  const r = await runMp(tables, { mode: "cram", playlist_id: "p1" });
  assert.equal(r.data.cram_stale, false);
});

test("cram refuses a non-concert playlist", async () => {
  const tables = {
    dj_playlists: [pl("p2", "Jazz songs Mix", "jazz")],
    dj_playlist_tracks: [], dj_tracks: [], dj_plays: [],
  };
  await assert.rejects(() => runMp(tables, { mode: "cram", playlist_id: "p2" }),
    /cram applies to kind 'concert' only/);
});
