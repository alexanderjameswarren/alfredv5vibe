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

// ⚠️ THIS FAKE ENFORCES A SERVER ROW CAP, AND THAT IS THE POINT.
//
// PostgREST caps every response at `db-max-rows` and reports the cut NOWHERE —
// no error, no flag, no short-count field. A fake without that cap cannot fail
// on the defect it is meant to catch, and this one could not: on 2026-09-02
// get_dj_managed_playlists mode=list reported 0 tracks for playlists holding 15,
// with every test in this file green. The suite was measuring a database that
// does not exist (spec §11.16 — a negative control must reproduce the ACTUAL
// defect, not a plausible neighbour).
//
// `maxRows` defaults to the real cap. Pass a smaller one to make a test cross it
// without building thousands of fixture rows.
const DEFAULT_MAX_ROWS = 1000;

function makeDb(tables, { maxRows = DEFAULT_MAX_ROWS } = {}) {
  function builder(table) {
    const filters = [];
    let head = false, wantCount = false, limit = null, single = false;
    let orderCol = null, orderAsc = true, rangeFrom = null, rangeTo = null;
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
      // Ordering is applied for real. Paging over an unordered result is a
      // different wrong answer, so a fake that ignored order could not tell a
      // sound implementation from an unsound one.
      order(c, opts = {}) {
        orderCol = c;
        orderAsc = opts.ascending !== false;
        return api;
      },
      range(from, to) { rangeFrom = from; rangeTo = to; return api; },
      limit(n) { limit = n; return api; },
      single() { single = true; return api; },
      maybeSingle() { single = true; return api; },
      then(resolve) {
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        const count = rows.length;
        if (orderCol != null) {
          rows = rows.slice().sort((a, b) => {
            const x = a[orderCol], y = b[orderCol];
            if (x === y) return 0;
            if (x === undefined || x === null) return 1;
            if (y === undefined || y === null) return -1;
            return (x < y ? -1 : 1) * (orderAsc ? 1 : -1);
          });
        }
        if (rangeFrom != null) rows = rows.slice(rangeFrom, rangeTo + 1);
        if (limit != null) rows = rows.slice(0, limit);
        // The server cap, applied LAST and silently — exactly as PostgREST does.
        if (maxRows != null) rows = rows.slice(0, maxRows);
        if (single) return resolve({ data: rows[0] ?? null, error: null, count: null });
        return resolve({ data: head ? null : rows, error: null, count: wantCount ? count : null });
      },
    };
    return api;
  }
  return {
    from: (t) => builder(t),
    // Postgres functions the handler calls through PostgREST. A test supplies
    // `rpcs` keyed by function name; anything unregistered fails the way a
    // missing migration does, which is the case worth being able to assert.
    rpc: async (name, params) => {
      const fn = (tables.__rpcs ?? {})[name];
      if (!fn) {
        return { data: null,
                 error: { message: `function public.${name} does not exist` } };
      }
      return { data: fn(params), error: null };
    },
  };
}

const run = (tables, args, opts) =>
  tool.get_dj_plays.handler(args, { db: makeDb(tables, opts), userId: "u1" });
const runMp = (tables, args, opts) =>
  tool.get_dj_managed_playlists.handler(args, { db: makeDb(tables, opts), userId: "u1" });

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
    /must be 'plays', 'familiarity' or 'artists'/,
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

// ---------------------------------------------------------------------------
// The server row cap — the 2026-09-02 wrong answer
// ---------------------------------------------------------------------------
//
// 🛑 THESE FAIL AGAINST THE UNPAGED READ AND PASS AGAINST THE PAGED ONE. That is
// the whole requirement: the old code returned a plausible number, not an error,
// so a test that only asserted "counts look sane" stayed green while mode=list
// reported 0 tracks for a playlist holding 15.
//
// The cap is set low here rather than building 1,000 fixture rows. The defect
// does not care about the absolute number — it is "the read stopped and nothing
// said so", and it reproduces identically at 3 rows or 1,000.

test("membership counts survive a server row cap — the mode=list wrong answer", async () => {
  // Three playlists, 6 membership rows, cap of 4. The playlist list itself is
  // bounded by clampLimit and is not at risk; the MEMBERSHIP read is. Unpaged it
  // returns the first 4 rows, so p3 comes back as ZERO tracks and p2 as a
  // partial — which is exactly what "Smashing Pumpkins 0" and "Weezer 4" were.
  const tables = {
    dj_playlists: [pl("p1", "One"), pl("p2", "Two"), pl("p3", "Three")],
    dj_playlist_tracks: [
      cmem("p1", "t1", "body", 0), cmem("p1", "t2", "body", 1),
      cmem("p2", "t3", "body", 0), cmem("p2", "t4", "body", 1),
      cmem("p3", "t5", "body", 0), cmem("p3", "t6", "body", 1),
    ],
    dj_tracks: [track("t1", "v1", "A"), track("t2", "v2", "B"), track("t3", "v3", "C"),
                track("t4", "v4", "D"), track("t5", "v5", "E"), track("t6", "v6", "F")],
    dj_plays: [],
  };
  const r = await runMp(tables, { mode: "list" }, { maxRows: 4 });
  const byName = Object.fromEntries(r.data.playlists.map((p) => [p.name, p]));
  assert.equal(r.data.playlists.length, 3);
  for (const name of ["One", "Two", "Three"]) {
    assert.equal(byName[name].track_counts.body, 2,
      `${name} lost rows to the row cap — an empty playlist is not a short answer, ` +
      `it is a different claim`);
    assert.equal(byName[name].distinct_tracks, 2);
  }
});

test("the counts sum to the real total, not to the cap", async () => {
  // ⚠️ THE SHAPE OF THE LIVE SYMPTOM. The tell on 2026-09-02 was that every
  // reported body count summed to EXACTLY 1000 — the cap itself, showing through
  // as data. A test that only checked one playlist would have missed it.
  const tables = {
    dj_playlists: [pl("p1", "One"), pl("p2", "Two")],
    dj_playlist_tracks: [
      cmem("p1", "t1", "body", 0), cmem("p1", "t2", "body", 1), cmem("p1", "t3", "body", 2),
      cmem("p2", "t4", "body", 0), cmem("p2", "t5", "body", 1),
    ],
    dj_tracks: [track("t1", "v1", "A"), track("t2", "v2", "B"), track("t3", "v3", "C"),
                track("t4", "v4", "D"), track("t5", "v5", "E")],
    dj_plays: [],
  };
  const r = await runMp(tables, { mode: "list" }, { maxRows: 3 });
  const total = r.data.playlists.reduce((n, p) => n + p.track_counts.body, 0);
  assert.equal(total, 5, "the sum equalling the cap is the signature of a truncated read");
});

test("one playlist's membership survives the cap too — mode=tracks", async () => {
  // mode=tracks was RIGHT on 2026-09-02 only because no single playlist exceeded
  // the cap. That is a property of today's data, not of the code, and it is the
  // reason the two modes disagreed rather than both being wrong.
  const tables = {
    dj_playlists: [PL],
    dj_playlist_tracks: [mem("t1", "body", 1), mem("t2", "body", 2), mem("t3", "body", 3)],
    dj_tracks: [track("t1", "v1", "A"), track("t2", "v2", "B"), track("t3", "v3", "C")],
    dj_plays: [],
  };
  const r = await runMp(tables, { mode: "tracks", yt_playlist_id: "PLxyz" }, { maxRows: 2 });
  assert.equal(r.data.counts.body, 3);
  assert.equal(r.data.tracks.length, 3);
});

test("a capped plays read would corrupt cram order, so it is paged", async () => {
  // ⚠️ THE HIGHEST-STAKES INSTANCE. distinct_days comes out WRONG rather than
  // short, and §12.10 sorts the cram list by it: a song played on four days
  // reads as never played and takes a slot from one that is genuinely unlearned.
  const tables = {
    dj_playlists: [pl("p1", "Concert")],
    dj_playlist_tracks: [cmem("p1", "t1", "body", 0), cmem("p1", "t2", "body", 1)],
    dj_tracks: [track("t1", "v1", "Known"), track("t2", "v2", "Unknown")],
    dj_plays: [
      play("t1", "2026-08-01"), play("t1", "2026-08-02"),
      play("t1", "2026-08-03"), play("t1", "2026-08-04"),
    ],
  };
  const r = await runMp(tables, { mode: "cram", playlist_id: "p1", as_of: "2026-08-10" },
    { maxRows: 2 });
  const byTitle = Object.fromEntries(r.data.proposed_cram.map((c) => [c.title, c]));
  assert.equal(byTitle.Known.distinct_days, 4, "two of four play rows were dropped");
  assert.equal(byTitle.Unknown.distinct_days, 0);
  assert.equal(r.data.proposed_cram[0].title, "Unknown",
    "never-played must still sort first — a capped read inverts this silently");
});

test("familiarity honours its own scan cap instead of PostgREST's", async () => {
  // The count guard measured the right thing and the read did not honour it:
  // `.limit(SCAN_CAP)` asked for 5,000 and the server returned 1,000, so a scan
  // that passed the guard was already truncated (spec §11.15).
  const tables = {
    dj_tracks: [track("t1", "v1", "A")],
    dj_plays: [play("t1", "2026-08-01"), play("t1", "2026-08-02"), play("t1", "2026-08-03")],
  };
  const r = await run(tables, { mode: "familiarity", from_date: "2026-01-01", to_date: "2026-12-31" },
    { maxRows: 2 });
  assert.equal(r.data.rows_scanned, 3);
  assert.equal(r.data.groups[0].distinct_days, 3);
});

// ---------------------------------------------------------------------------
// §12.10 D — a variant cut never takes a slot from its own studio recording
// ---------------------------------------------------------------------------

const days = (n) => Array.from({ length: n }, (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`);

test("Marigold takes ONE slot, not two — the 2026-09-02 cram outcome", async () => {
  // 🛑 THE RULE WORKED AND THE OUTCOME WAS WRONG. Two genuinely different
  // recordings, so the canonical-group dedupe correctly declined to merge them —
  // and eight slots taught seven songs. Nine candidates here against a cap of
  // eight, so the suppressed variant must be REPLACED by a real ninth song
  // rather than simply dropped.
  const titles = [
    ["t0", "Marigold", "Nirvana"],
    ["t1", "Marigold (Live at the Pantages Theatre, Los Angeles, CA - August 2006)", "Foo Fighters"],
    ["t2", "Wheels", "Foo Fighters"], ["t3", "Window", "Foo Fighters"],
    ["t4", "Run", "Foo Fighters"], ["t5", "The Teacher", "Foo Fighters"],
    ["t6", "Stacked Actors", "Foo Fighters"], ["t7", "Aurora", "Foo Fighters"],
    ["t8", "La Dee Da", "Foo Fighters"],
  ];
  const tables = {
    dj_playlists: [pl("p1", "Foo Fighters Concert")],
    dj_playlist_tracks: titles.map(([id], i) => cmem("p1", id, "body", i)),
    dj_tracks: titles.map(([id, title, artist]) => track(id, `v-${id}`, title, null, null, artist)),
    dj_plays: [],
  };
  const r = await runMp(tables, { mode: "cram", playlist_id: "p1", as_of: "2026-09-02" });

  const names = r.data.proposed_cram.map((c) => c.title);
  assert.equal(names.filter((t) => t.startsWith("Marigold")).length, 1,
    "eight slots must teach eight songs");
  assert.equal(names[0], "Marigold", "the STUDIO cut is the one that stays");
  assert.equal(r.data.proposed_cram.length, 8);
  assert.ok(names.includes("La Dee Da"),
    "the freed slot goes to a real ninth song, or the fix only hides the problem");

  assert.equal(r.data.variants_suppressed.length, 1);
  assert.match(r.data.variants_suppressed[0].title, /^Marigold \(Live/);
  assert.equal(r.data.variants_suppressed[0].kept_instead[0].artist, "Nirvana",
    "the report must name what stood in for it — Alex put that row there deliberately");
});

test("a playlist holding ONLY a live cut still crams it", async () => {
  // ⚠️ NEGATIVE CONTROL. The rule fires only when a NON-VARIANT sibling shares
  // the title. Without this, "prefer the studio cut" silently becomes "never
  // cram a live recording", and a song would drop out of cram entirely.
  const tables = {
    dj_playlists: [pl("p1", "Concert")],
    dj_playlist_tracks: [cmem("p1", "t1", "body", 0)],
    dj_tracks: [track("t1", "v1", "Marigold (Live at the Pantages Theatre)", null, null, "Foo Fighters")],
    dj_plays: [],
  };
  const r = await runMp(tables, { mode: "cram", playlist_id: "p1" });
  assert.equal(r.data.proposed_cram.length, 1);
  assert.equal(r.data.variants_suppressed.length, 0);
});

test("two STUDIO recordings sharing a title are reported, never merged", async () => {
  // 🛑 THE C FALLTHROUGH, AND THE REASON D IS SAFE. Deduping on title alone would
  // collapse Weezer's Happy Together onto The Turtles' — a cover and its original
  // are two songs to learn, and one would then never be crammed. Neither is
  // marked a variant, so nothing stands down and the duplication is reported as
  // the judgement it is.
  const tables = {
    dj_playlists: [pl("p1", "Concert")],
    dj_playlist_tracks: [cmem("p1", "t1", "body", 0), cmem("p1", "t2", "body", 1)],
    dj_tracks: [track("t1", "v1", "Happy Together", null, null, "Weezer"),
                track("t2", "v2", "Happy Together", null, null, "The Turtles")],
    dj_plays: [],
  };
  const r = await runMp(tables, { mode: "cram", playlist_id: "p1" });
  assert.equal(r.data.variants_suppressed.length, 0, "neither is a variant cut");
  assert.equal(r.data.proposed_cram.length, 2, "both stay — they are two songs");
  assert.equal(r.data.duplicate_titles_in_cram.length, 1);
  const artists = r.data.duplicate_titles_in_cram[0].entries.map((e) => e.artist).sort();
  assert.deepEqual(artists, ["The Turtles", "Weezer"],
    "the entries must carry what distinguishes them, or it is not settleable");
});

// ---------------------------------------------------------------------------
// COMPLETE — the state §12.10 did not have
// ---------------------------------------------------------------------------

test("a playlist whose every song is learned is COMPLETE, not stale and not fresh", async () => {
  // The live Weezer case: thirteen songs, least familiar at eight distinct days.
  // The ordering was real and its purpose had evaporated.
  const ids = ["t1", "t2", "t3"];
  const tables = {
    dj_playlists: [pl("p1", "Weezer Concert 2026")],
    dj_playlist_tracks: ids.map((id, i) => cmem("p1", id, "body", i)),
    dj_tracks: ids.map((id, i) => track(id, `v${i}`, `Song ${i}`)),
    dj_plays: ids.flatMap((id) => days(6).map((d) => play(id, d))),
  };
  const r = await runMp(tables, { mode: "cram", playlist_id: "p1", as_of: "2026-09-02" });
  assert.equal(r.data.cram_complete, true);
  assert.equal(r.data.cram_state, "complete");
  assert.deepEqual(r.data.proposed_cram, [], "nothing to cram when everything is learned");
  assert.equal(r.data.learned_threshold, 5, "reuses §12.10(b)'s definition, not a second one");
  // ⚠️ The claim has to be CHECKABLE, not asserted (§11.12).
  assert.equal(r.data.least_familiar.length, 3);
  assert.ok(r.data.least_familiar.every((g) => g.distinct_days >= 5));
});

test("COMPLETE self-heals — one accepted song and it is gone", async () => {
  // 🛑 THE PROPERTY THAT MAKES A FLOOR SAFE HERE. Accept one song from a §12.2
  // diff and the playlist stops being complete, because the new song sits at
  // distinct_days 0. The state cannot latch.
  const learned = ["t1", "t2", "t3"];
  const tables = {
    dj_playlists: [pl("p1", "Weezer Concert 2026")],
    dj_playlist_tracks: [...learned.map((id, i) => cmem("p1", id, "body", i)),
                         cmem("p1", "t_new", "body", 3)],
    dj_tracks: [...learned.map((id, i) => track(id, `v${i}`, `Song ${i}`)),
                track("t_new", "v_new", "C.E.O.")],
    dj_plays: learned.flatMap((id) => days(6).map((d) => play(id, d))),
  };
  const r = await runMp(tables, { mode: "cram", playlist_id: "p1", as_of: "2026-09-02" });
  assert.equal(r.data.cram_complete, false);
  assert.equal(r.data.cram_state, "stale", "an unlearned song holding no cram row IS stale");
  assert.equal(r.data.proposed_cram[0].title, "C.E.O.", "the new song is what to cram");
});

test("one song just under the threshold keeps a playlist off COMPLETE", async () => {
  // NEGATIVE CONTROL on the boundary. 4 distinct days is not learned; 5 is.
  const tables = {
    dj_playlists: [pl("p1", "Concert")],
    dj_playlist_tracks: [cmem("p1", "t1", "body", 0), cmem("p1", "t2", "body", 1)],
    dj_tracks: [track("t1", "v1", "Known"), track("t2", "v2", "Nearly")],
    dj_plays: [...days(6).map((d) => play("t1", d)), ...days(4).map((d) => play("t2", d))],
  };
  const r = await runMp(tables, { mode: "cram", playlist_id: "p1", as_of: "2026-09-02" });
  assert.equal(r.data.cram_complete, false);
  assert.equal(r.data.proposed_cram[0].title, "Nearly");

  // And the same playlist with that song at 5 days IS complete.
  const bumped = {
    ...r && {},
    dj_playlists: [pl("p1", "Concert")],
    dj_playlist_tracks: [cmem("p1", "t1", "body", 0), cmem("p1", "t2", "body", 1)],
    dj_tracks: [track("t1", "v1", "Known"), track("t2", "v2", "Nearly")],
    dj_plays: [...days(6).map((d) => play("t1", d)), ...days(5).map((d) => play("t2", d))],
  };
  const r2 = await runMp(bumped, { mode: "cram", playlist_id: "p1", as_of: "2026-09-02" });
  assert.equal(r2.data.cram_complete, true);
});

test("COMPLETE never implies readiness — the tool says so itself", async () => {
  // 🛑 THE CAVEAT IS THE IMPORTANT HALF. Weezer's thirteen learned songs cover 12
  // of 34 distinct setlist songs. "You know this one" would wrong-foot him on the
  // night. This tool cannot compute coverage, so it must not imply it — and the
  // requirement travels with the flag rather than living only in the spec.
  const tables = {
    dj_playlists: [pl("p1", "Concert")],
    dj_playlist_tracks: [cmem("p1", "t1", "body", 0)],
    dj_tracks: [track("t1", "v1", "Known")],
    dj_plays: days(6).map((d) => play("t1", d)),
  };
  const r = await runMp(tables, { mode: "cram", playlist_id: "p1", as_of: "2026-09-02" });
  assert.equal(r.data.cram_complete, true);
  assert.match(r.data.reading, /NEVER REPORT `cram_complete` WITHOUT SETLIST COVERAGE/);
  assert.match(r.data.reading, /distinct_setlist_songs/);
});


// ---------------------------------------------------------------------------
// mode=artists — Section 4's headline (migration 015)
// ---------------------------------------------------------------------------

test("artists mode returns the rollup and states what it is NOT", async () => {
  // ⚠️ THE GAPS TEXT IS PART OF THE ANSWER, NOT DECORATION. This groups
  // dj_tracks.artist as an exact string: it can say "you played a lot of Wes
  // Montgomery" and it cannot be treated as an identity (§14.1, §4.1.4). A
  // consumer that prints the numbers without the limitation invites the reader
  // to assume a model that does not exist — the same failure §14.3 forced the
  // jazz definition to avoid.
  const tables = {
    __rpcs: {
      dj_artist_activity: ({ p_window_days, p_limit }) => [
        { artist: "Wes Montgomery", distinct_days: 13, play_rows: 55,
          distinct_groups: 33, first_played_on: "2026-06-04",
          last_played_on: "2026-09-01", in_any_playlist: false, _w: p_window_days,
          _l: p_limit },
        { artist: "Oscar Peterson", distinct_days: 12, play_rows: 17,
          distinct_groups: 13, first_played_on: "2026-06-06",
          last_played_on: "2026-08-31", in_any_playlist: false },
      ],
    },
  };
  const r = await run(tables, { mode: "artists", window_days: 90, limit: 20 });
  assert.equal(r.data.mode, "artists");
  assert.equal(r.data.returned, 2);
  assert.equal(r.data.artists[0].artist, "Wes Montgomery");
  assert.equal(r.data.window_days, 90);
  assert.match(r.data.gaps, /NOT AN ARTIST IDENTITY/);
  assert.match(r.data.gaps, /Oscar Peterson Trio/, "the real split must be named");
  assert.match(r.data.gaps, /1\.7M views/, "the scraped byline is in the population");
  assert.match(r.data.definition, /DISTINCT DAYS PLAYED, not a play count/);
});

test("artists mode names the migration when the function is absent", async () => {
  // ⚠️ AN OPERATIONAL FAILURE, SO IT CARRIES NO DO-NOT-RETRY WORDING — it becomes
  // retryable the moment 015 is applied, and stamping "do not retry" on it would
  // suppress the retry that should happen (platform error contract).
  await assert.rejects(
    () => run({}, { mode: "artists" }),
    (e) => {
      assert.match(e.message, /migration 015 has not been applied/);
      assert.ok(!/[Dd]o NOT retry/.test(e.message));
      return true;
    },
  );
});

test("artists mode clamps its limit like every other bounded read", async () => {
  let seen = null;
  const tables = {
    __rpcs: { dj_artist_activity: (params) => { seen = params; return []; } },
  };
  await run(tables, { mode: "artists", limit: 500 });
  assert.equal(seen.p_limit, 50, "hard cap, server-side");
  assert.equal(seen.p_window_days, 90, "default window");
});

// --- the tag arm (added 016) ------------------------------------------------

test("artists mode passes the tag filter through, and defaults to null", async () => {
  let seen = null;
  const tables = {
    __rpcs: {
      dj_artist_activity: (params) => { seen = params; return []; },
      dj_tag_coverage: () => [{ untagged_total: 0 }],
      dj_tag_candidates: () => [],
    },
  };
  await run(tables, { mode: "artists" });
  assert.equal(seen.p_tag, null, "unfiltered is the default — every artist");

  await run(tables, { mode: "artists", tag: "jazz" });
  assert.equal(seen.p_tag, "jazz");
});

test("artists mode counts the UNTAGGED rows, which is how a thin tag set shows", async () => {
  // ⚠️ WITHOUT THIS THE TWO FAILURE MODES ARE INDISTINGUISHABLE. A short jazz
  // section can mean "he barely listens to jazz" or "almost nothing is tagged",
  // and on 2026-09-02 it meant the second: Thelonious Monk was the fourth-most
  // played artist in the library and invisible to the jazz report.
  const tables = {
    __rpcs: {
      dj_artist_activity: () => [
        { artist: "Thelonious Monk", distinct_days: 20, tags: [] },
        { artist: "Wes Montgomery", distinct_days: 13, tags: ["jazz"] },
        { artist: "Green Day", distinct_days: 16 },   // no tags key at all
      ],
    },
  };
  const r = await run(tables, { mode: "artists" });
  assert.equal(r.data.untagged_in_result, 2, "an absent tags key counts as untagged");
  assert.equal(r.data.tag_filter, null);
});

test("there is no second field for in_any_playlist to contradict", async () => {
  // 🛑 §14.19 IS FIXED BY REMOVAL, NOT BY WORDING. 016 renamed the jazz tool's
  // field to `in_jazz_playlist` and warned about the pair; 018 deleted the
  // second tool, so the pair cannot exist. This test replaced one asserting the
  // warning text — a warning about a trap is worse than no trap.
  const tables = { __rpcs: { dj_artist_activity: () => [] } };
  const r = await run(tables, { mode: "artists" });
  assert.equal(tool.get_dj_jazz_activity, undefined);
  assert.ok(
    !/in_jazz_playlist/.test(r.data.definition),
    "nothing should still be steering readers around a field that is gone",
  );
  assert.match(r.data.definition, /in_any_playlist/);
});

// ---------------------------------------------------------------------------
// Section 3 is now Section 4 with a filter (merged 2026-09-02)
// ---------------------------------------------------------------------------
//
// 🛑 get_dj_jazz_activity IS GONE. One artist-level definition, because two
// overlapping ones produced §14.19 — `in_playlist` and `in_any_playlist`
// reading opposite ways for Wes Montgomery in a single report, both correct.
//
// ⚠️ THE COST OF MERGING IS THAT A FILTERED SECTION IS BLIND TO WHAT IS NOT
// TAGGED, and that blindness is the exact shape of the bug being fixed: the old
// definition reported its own coverage as if it reported the world, and Monk sat
// outside it for a quarter with nothing saying so. So `coverage` is not optional.

test("the jazz tool is REMOVED, not renamed", () => {
  assert.equal(
    tool.get_dj_jazz_activity, undefined,
    "a wrapper would restore a second name for one idea",
  );
});

test("a tag-filtered read ALWAYS fetches coverage — it cannot be skipped", async () => {
  // 🛑 THE POINT OF THE WHOLE MERGE. An optional second call is a call somebody
  // skips on the week it matters, and then the section reports "3 jazz artists"
  // where the truth is "3 tagged, 40 played, nobody has tagged the rest".
  const calls = [];
  const tables = {
    __rpcs: {
      dj_artist_activity: () => [{ artist: "Thelonious Monk", distinct_days: 20,
                                   tags: ["jazz"] }],
      dj_tag_coverage: (p) => {
        calls.push(p);
        return [{ tag: "jazz", window_days: 90, played_artists: 43,
                  tagged_active: 13, tagged_rejected: 1, uncategorised_artists: 30,
                  uncategorised_derivable: 0, categorised_rows: 300 }];
      },
      dj_tag_candidates: () => [
        { artist: "Ahmad Jamal", distinct_days: 5, derivable: false },
      ],
    },
  };
  const r = await run(tables, { mode: "artists", tag: "jazz" });
  assert.equal(calls.length, 1, "coverage must be fetched with the rows");
  assert.equal(calls[0].p_tag, "jazz");
  assert.equal(r.data.coverage.uncategorised_artists, 30);
  assert.equal(r.data.tag_candidates.length, 1);
});

test("an UNFILTERED read does not pay for coverage it does not need", async () => {
  // Section 4 sees every artist, so there is nothing it cannot see. Fetching
  // coverage there would be two round-trips to answer a question nobody asked.
  let covCalled = false;
  const tables = {
    __rpcs: {
      dj_artist_activity: () => [],
      dj_tag_coverage: () => { covCalled = true; return []; },
      dj_tag_candidates: () => [],
    },
  };
  const r = await run(tables, { mode: "artists" });
  assert.equal(covCalled, false);
  assert.ok(!("coverage" in r.data), "no coverage key when unfiltered");
  assert.ok(!("tag_candidates" in r.data));
});

test("the reading separates FACTS from JUDGEMENTS in the candidate list", async () => {
  // ⚠️ THEY ARE NOT THE SAME ASK AND MUST NOT BE PRESENTED AS ONE. `derivable`
  // means the artist is on a track in a matching-kind playlist — the old
  // playlist arm, which was never a judgement — so it is written without asking.
  // The rest are judgements, and §14.9 means some of those strings are scraped
  // channel bylines rather than artists.
  const tables = {
    __rpcs: {
      dj_artist_activity: () => [],
      dj_tag_coverage: () => [{ uncategorised_artists: 2, uncategorised_derivable: 1 }],
      dj_tag_candidates: () => [],
    },
  };
  const r = await run(tables, { mode: "artists", tag: "jazz" });
  assert.match(r.data.reading, /derivable_as` NON-NULL is a FACT/);
  assert.match(r.data.reading, /WITHOUT asking/);
  assert.match(r.data.reading, /null `derivable_as` is a JUDGEMENT/);
});

test("the reading says a NO is a write, or the proposal repeats forever", async () => {
  // 🛑 §11.7. Without a recorded rejection, 'Harrison' is proposed every week
  // for the rest of time and the section trains him to skip it.
  const tables = {
    __rpcs: {
      dj_artist_activity: () => [],
      dj_tag_coverage: () => [{ uncategorised_artists: 0, tagged_rejected: 1 }],
      dj_tag_candidates: () => [],
    },
  };
  const r = await run(tables, { mode: "artists", tag: "jazz" });
  assert.match(r.data.reading, /A 'NO' IS A WRITE TOO/);
  assert.match(r.data.reading, /status='rejected'/);
});

test("a missing 018 is named as operational, and stays retryable", async () => {
  // The platform error contract: an operational failure must NOT carry
  // do-not-retry wording, because it becomes retryable the moment 018 lands.
  const tables = { __rpcs: { dj_artist_activity: () => [] } };
  await assert.rejects(
    () => run(tables, { mode: "artists", tag: "jazz" }),
    (e) => {
      assert.match(e.message, /migration 018 has not been applied/);
      assert.ok(!/[Dd]o NOT retry/.test(e.message));
      return true;
    },
  );
});

test("the definition names the removal, so the merge is discoverable", async () => {
  const tables = { __rpcs: { dj_artist_activity: () => [] } };
  const r = await run(tables, { mode: "artists" });
  assert.match(r.data.definition, /ONLY ARTIST-LEVEL DEFINITION/);
  assert.match(r.data.definition, /get_dj_jazz_activity was REMOVED/);
});
// ---------------------------------------------------------------------------
// The proposal cap and the coverage projection (019)
// ---------------------------------------------------------------------------
//
// 🛑 THE BACKLOG IS 368 AND A COUNT IS THE WRONG WAY TO REPORT IT. At eight a
// week that is eighteen months, and the count will never reach zero anyway: the
// pool is "played in the trailing window", the window slides, and new one-offs
// arrive every week. Reporting "368 to go" promises a finish that does not
// exist. The share of PLAY ROWS does close, because every play row has exactly
// one artist.

test("the proposal cap is 8, and FACTS do not consume a slot", async () => {
  let sentTag = "unset";
  // ⚠️ A derivable candidate is written without asking, so it costs no
  // attention. Asking for cap + derivable returns a full-length proposal list
  // AND every fact, because the SQL orders facts first.
  let askedFor = null;
  const tables = {
    __rpcs: {
      dj_artist_activity: () => [],
      dj_tag_coverage: () => [{ played_rows: 100, categorised_rows: 40, tagged_rows: 25,
                                uncategorised_derivable: 3, uncategorised_artists: 50 }],
      dj_tag_candidates: (p) => { askedFor = p.p_limit; sentTag = p.p_tag; return []; },
    },
  };
  const r = await run(tables, { mode: "artists", tag: "jazz" });
  assert.equal(r.data.tag_proposal_cap, 8);
  assert.equal(askedFor, 11, "8 judgements + 3 facts");
  // 🛑 NO p_tag (020). The candidate list means UNCATEGORISED — an artist with
  // no tag of ANY kind. Scoping it to one tag is what proposed Weezer as jazz.
  assert.equal(sentTag, undefined, "the candidate query must not be tag-scoped");
});

test("with no facts pending, the ask is exactly the cap", async () => {
  let sentTag = "unset";
  // The live 2026-09-02 case: untagged_derivable is 0, so all eight slots are
  // judgements.
  let askedFor = null;
  const tables = {
    __rpcs: {
      dj_artist_activity: () => [],
      dj_tag_coverage: () => [{ played_rows: 100, categorised_rows: 40, tagged_rows: 25,
                                uncategorised_derivable: 0 }],
      dj_tag_candidates: (p) => { askedFor = p.p_limit; sentTag = p.p_tag; return []; },
    },
  };
  await run(tables, { mode: "artists", tag: "jazz" });
  assert.equal(askedFor, 8);
});

test("the projection is COMPUTED against the play-row denominator", async () => {
  // 🛑 "These eight take you from 43% to 71%" is only honest if the arithmetic
  // uses the same denominator the share does. Done here once, rather than in a
  // prompt where a model re-derives it weekly and drifts.
  const tables = {
    __rpcs: {
      dj_artist_activity: () => [],
      dj_tag_coverage: () => [{ played_rows: 1000, categorised_rows: 400, tagged_rows: 250,
                                uncategorised_derivable: 0 }],
      dj_tag_candidates: () => [
        { artist: "Weezer", play_rows: 200 },
        { artist: "Foo Fighters", play_rows: 100 },
      ],
    },
  };
  const r = await run(tables, { mode: "artists", tag: "jazz" });
  assert.equal(r.data.projection.categorised_now_pct, 40);
  assert.equal(r.data.projection.categorised_after_pct, 70);
  assert.equal(r.data.projection.tag_share_pct, 25,
    "the tag share is a listening fact and must NOT be the progress number");
  assert.equal(r.data.projection.play_rows_on_the_table, 300);
});

test("a zero denominator yields null rather than a division artefact", async () => {
  // NEGATIVE CONTROL. An empty window must not print "NaN%" or "0% → 0%", both
  // of which read as facts about listening rather than absence of data.
  const tables = {
    __rpcs: {
      dj_artist_activity: () => [],
      dj_tag_coverage: () => [{ played_rows: 0, categorised_rows: 0, tagged_rows: 0,
                                uncategorised_derivable: 0 }],
      dj_tag_candidates: () => [],
    },
  };
  const r = await run(tables, { mode: "artists", tag: "jazz" });
  assert.equal(r.data.projection, null);
});

test("the reading says report the SHARE and warns the count never reaches zero", async () => {
  const tables = {
    __rpcs: {
      dj_artist_activity: () => [],
      dj_tag_coverage: () => [{ played_rows: 10, categorised_rows: 1, tagged_rows: 1,
                                uncategorised_derivable: 0 }],
      dj_tag_candidates: () => [],
    },
  };
  const r = await run(tables, { mode: "artists", tag: "jazz" });
  assert.match(r.data.reading, /REPORT A SHARE, NOT THE COUNT/);
  assert.match(r.data.reading, /WILL NEVER REACH ZERO/);
});
