// Handler tests for the DJ courier tools, against a simulated PostgREST client.
// Models the two unique constraints that actually matter:
//   dj_tracks (user_id, video_id)
//   dj_plays  (user_id, track_id, played_on, occurrence, source)
//
// Run (Node 24+, no Deno toolchain needed):
//   node --experimental-strip-types --test supabase/functions/_shared/tools/dj-courier.test.mjs
//
// The tools import `../platform.ts`, which pulls in the Supabase client from
// jsr: and cannot resolve under Node. Rather than check in a duplicate that
// would drift, this test READS the real dj-courier.ts, swaps that one import
// line for local stubs, and imports the result from a temp file. The logic
// under test is always the shipped source.
//
// ⚠️ NOT wired into `npm test` — that runs react-scripts/jest over src/ only.
// Run it by hand when touching dj-courier.ts or dj-normalise.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUBS = [
  "const clampLimit = (n: number | undefined) => Math.min(n ?? 20, 50);",
  "const defineTool = (o: any) => {",
  "  (globalThis as any).__tools ??= [];",
  "  (globalThis as any).__tools.push(o);",
  "  return o;",
  "};",
].join("\n");

const dir = mkdtempSync(join(tmpdir(), "dj-courier-"));
// Copy every sibling dj-*.ts, not a hand-listed subset — dj-courier gained an
// import of dj-tracks.ts and a fixed list silently broke the whole file.
for (const f of readdirSync(HERE)) {
  if (f.startsWith("dj-") && f.endsWith(".ts")) copyFileSync(join(HERE, f), join(dir, f));
}
const src = readFileSync(join(HERE, "dj-courier.ts"), "utf-8").replace(
  'import { clampLimit, defineTool } from "../platform.ts";',
  STUBS,
);
if (src.includes("../platform.ts")) {
  throw new Error("dj-courier.ts import line changed — update the stub in this test.");
}
writeFileSync(join(dir, "dj-courier.probe.ts"), src);

globalThis.__tools = [];
await import(pathToFileURL(join(dir, "dj-courier.probe.ts")).href);
const toolByName = Object.fromEntries(globalThis.__tools.map((t) => [t.name, t]));

const USER = "user-1";

function makeDb() {
  const tables = { dj_tracks: [], dj_plays: [], platform_runs: [] };
  let seq = 0;
  const uniq = {
    dj_tracks: (r) => `${r.user_id}|${r.video_id}`,
    dj_plays: (r) => `${r.user_id}|${r.track_id}|${r.played_on}|${r.occurrence}|${r.source}`,
    // No unique constraint beyond the PK — it is an append-only run log.
    platform_runs: (r) => r.id,
  };

  function builder(table) {
    let rows = null;          // set by upsert/insert
    const filters = [];
    let order = null, limit = null, single = false, wantSelect = false;

    const api = {
      select() { wantSelect = true; return api; },
      in(col, vals) { filters.push((r) => vals.includes(r[col])); return api; },
      eq(col, v) { filters.push((r) => r[col] === v); return api; },
      is(col, v) { filters.push((r) => r[col] === v); return api; },
      order(col, o) { order = { col, asc: o?.ascending !== false }; return api; },
      limit(n) { limit = n; return api; },
      single() { single = true; return api; },
      upsert(newRows, opts = {}) {
        rows = { newRows, opts };
        return api;
      },
      insert(newRow) {
        rows = { newRows: Array.isArray(newRow) ? newRow : [newRow], opts: {} };
        return api;
      },
      then(resolve) {
        if (rows) {
          const inserted = [];
          for (const r of rows.newRows) {
            const full = {
              id: `id-${++seq}`,
              user_id: USER,
              created_at: new Date(1700000000000 + seq * 1000).toISOString(),
              ...r,
            };
            const key = uniq[table](full);
            const clash = tables[table].some((e) => uniq[table](e) === key);
            if (clash) {
              if (rows.opts.ignoreDuplicates) continue;      // ON CONFLICT DO NOTHING
              return resolve({ data: null, error: { message: `duplicate key ${key}` } });
            }
            tables[table].push(full);
            inserted.push(full);
          }
          const data = single ? (inserted[0] ?? null) : inserted;
          return resolve({ data, error: null });
        }
        let out = tables[table].filter((r) => filters.every((f) => f(r)));
        if (order) {
          out = [...out].sort((a, b) =>
            order.asc
              ? String(a[order.col]).localeCompare(String(b[order.col]))
              : String(b[order.col]).localeCompare(String(a[order.col])));
        }
        if (limit != null) out = out.slice(0, limit);
        return resolve({ data: single ? (out[0] ?? null) : out, error: null });
      },
    };
    return api;
  }
  return { from: (t) => builder(t), _tables: tables };
}

const run = (db, args) => toolByName.record_dj_plays.handler(args, { db, userId: USER });

const play = (o) => ({
  video_id: o.v, title: o.t, artists: o.a ?? ["Weezer"],
  played_bucket: o.b ?? "Today", occurrence: o.o ?? 1,
  duration_seconds: 200, album: "Album",
});

// ---------------------------------------------------------------------------

test("by_bucket reports UNSUBMITTED buckets as explicit zeros", async () => {
  // The whole point. A run that skips a bucket must not look identical to a run
  // where the bucket was empty — so an absent bucket appears as submitted: 0
  // rather than not appearing. Counts come from the write, not the caller.
  const db = makeDb();
  const r = await run(db, {
    poll_date: "2026-08-27",
    plays: [play({ v: "v1", t: "A", b: "Today" }), play({ v: "v2", t: "B", b: "Today" })],
  });
  assert.deepEqual(r.by_bucket, {
    Today: { submitted: 2, inserted: 2, already_held: 0 },
    Yesterday: { submitted: 0, inserted: 0, already_held: 0 },
  });
});

test("by_bucket attributes already-held rows to the right bucket", async () => {
  const db = makeDb();
  const args = {
    poll_date: "2026-08-27",
    plays: [play({ v: "v1", t: "A", b: "Today" }), play({ v: "v2", t: "B", b: "Yesterday" })],
  };
  await run(db, args);
  const second = await run(db, args);
  assert.deepEqual(second.by_bucket, {
    Today: { submitted: 1, inserted: 0, already_held: 1 },
    Yesterday: { submitted: 1, inserted: 0, already_held: 1 },
  });
});

test("fresh import creates tracks and plays", async () => {
  const db = makeDb();
  const r = await run(db, {
    poll_date: "2026-08-27",
    plays: [play({ v: "v1", t: "Buddy Holly" }), play({ v: "v2", t: "Hash Pipe" })],
  });
  assert.equal(r.tracks_created, 2);
  assert.equal(r.plays_inserted, 2);
  assert.equal(r.plays_already_held, 0);
  assert.equal(r.covered_from, "2026-08-27");
});

test("HARD GATE: re-running the identical sync inserts zero rows", async () => {
  const db = makeDb();
  const args = {
    poll_date: "2026-08-27",
    plays: [
      play({ v: "v1", t: "Buddy Holly" }),
      play({ v: "v2", t: "Hash Pipe", b: "Yesterday" }),
      play({ v: "v3", t: "Beverly Hills", b: "Today" }),
    ],
  };
  const first = await run(db, args);
  assert.equal(first.plays_inserted, 3);

  const second = await run(db, args);
  assert.equal(second.tracks_created, 0, "re-run must create no tracks");
  assert.equal(second.plays_inserted, 0, "re-run must insert no plays");
  assert.equal(second.plays_already_held, 3);
  assert.equal(db._tables.dj_plays.length, 3, "table must still hold exactly 3 rows");
});

test("repeat plays on one day become distinct rows, and re-run adds none", async () => {
  // Written against the TAKEOUT path deliberately. Phase 2b established that
  // YouTube's history feed carries one entry per track per bucket, so the poll
  // can never produce occurrence > 1 — not rarely, never. Takeout has real
  // per-play rows and is the only source that will ever exercise this.
  const db = makeDb();
  const plays = [1, 2, 3].map((o) => ({
    video_id: "v1", title: "Island in the Sun", artists: ["Weezer"],
    played_on: "2026-08-27", precision: "exact", occurrence: o,
  }));
  const first = await run(db, { plays, source: "takeout" });
  assert.equal(first.plays_inserted, 3);
  assert.equal(first.tracks_created, 1, "same video is one track");

  const second = await run(db, { plays, source: "takeout" });
  assert.equal(second.plays_inserted, 0);

  // A fourth listen arrives; only the new occurrence lands.
  const third = await run(db, {
    source: "takeout",
    plays: [...plays, {
      video_id: "v1", title: "Island in the Sun", artists: ["Weezer"],
      played_on: "2026-08-27", precision: "exact", occurrence: 4,
    }],
  });
  assert.equal(third.plays_inserted, 1);
  assert.equal(db._tables.dj_plays.length, 4);
});

test("the poll never stores album, and says how many it discarded", async () => {
  // The feed reports what was listened THROUGH, not what the track is FROM —
  // a mix stamps its own name on every track in it. Nulled rather than flagged
  // because dj_tracks is insert-only: a detection rule would have to be right
  // at insert time from one batch, and the cross-artist signal is retrospective.
  const db = makeDb();
  const r = await run(db, {
    poll_date: "2026-08-27",
    plays: [
      play({ v: "v1", t: "Hackensack", a: ["Thelonious Monk"] }),
      play({ v: "v2", t: "Footprints", a: ["Wayne Shorter"] }),
    ],
  });
  assert.equal(r.albums_discarded, 2, "discards must be visible, not silent");
  assert.deepEqual(db._tables.dj_tracks.map((t) => t.album), [null, null]);
});

test("non-poll sources keep their album", async () => {
  const db = makeDb();
  const r = await run(db, {
    source: "takeout",
    plays: [{
      video_id: "v1", title: "Hackensack", artists: ["Thelonious Monk"],
      album: "Criss-Cross", played_on: "2026-08-27", precision: "exact",
    }],
  });
  assert.equal(r.albums_discarded, 0);
  assert.equal(db._tables.dj_tracks[0].album, "Criss-Cross");
});

test("canonical grouping links a remaster to the clean version in one batch", async () => {
  const db = makeDb();
  const r = await run(db, {
    poll_date: "2026-08-27",
    plays: [
      play({ v: "clean", t: "The Pleasure Is Mine", a: ["Herbie Hancock"] }),
      play({ v: "remaster", t: "The Pleasure Is Mine (Remastered 1999)", a: ["Herbie Hancock"] }),
    ],
  });
  assert.equal(r.tracks_created, 2);
  assert.equal(r.canonical_links_made, 1);

  const tracks = db._tables.dj_tracks;
  const clean = tracks.find((t) => t.video_id === "clean");
  const remaster = tracks.find((t) => t.video_id === "remaster");
  assert.equal(clean.canonical_track_id, null, "first seen is the group leader");
  assert.equal(remaster.canonical_track_id, clean.id, "variant points at the leader");
  assert.equal(clean.match_key, remaster.match_key);
});

test("a variant arriving in a LATER call links to the existing leader", async () => {
  const db = makeDb();
  await run(db, {
    poll_date: "2026-08-27",
    plays: [play({ v: "clean", t: "Say It Ain't So" })],
  });
  const r = await run(db, {
    poll_date: "2026-08-28",
    plays: [play({ v: "live", t: "Say It Ain't So - Live" })],
  });
  assert.equal(r.canonical_links_made, 1);
  const tracks = db._tables.dj_tracks;
  assert.equal(
    tracks.find((t) => t.video_id === "live").canonical_track_id,
    tracks.find((t) => t.video_id === "clean").id,
  );
});

test("three variants all point at ONE leader, not at each other", async () => {
  const db = makeDb();
  await run(db, {
    poll_date: "2026-08-27",
    plays: [
      play({ v: "a", t: "Song" }),
      play({ v: "b", t: "Song (Remastered)" }),
      play({ v: "c", t: "Song - Live" }),
    ],
  });
  const tracks = db._tables.dj_tracks;
  const leader = tracks.find((t) => t.video_id === "a");
  for (const v of ["b", "c"]) {
    assert.equal(tracks.find((t) => t.video_id === v).canonical_track_id, leader.id);
  }
});

test("insert-only: a re-poll never overwrites a hand-curated track row", async () => {
  const db = makeDb();
  await run(db, { poll_date: "2026-08-27", plays: [play({ v: "v1", t: "Song" })] });
  // Simulate hand curation: point it somewhere and retitle it.
  const row = db._tables.dj_tracks[0];
  row.canonical_track_id = "hand-picked-id";
  row.title = "Hand Corrected Title";

  await run(db, { poll_date: "2026-08-28", plays: [play({ v: "v1", t: "Song" })] });
  assert.equal(row.canonical_track_id, "hand-picked-id", "curation must survive a re-poll");
  assert.equal(row.title, "Hand Corrected Title");
  assert.equal(db._tables.dj_tracks.length, 1);
});

test("unrelated songs do NOT group", async () => {
  const db = makeDb();
  const r = await run(db, {
    poll_date: "2026-08-27",
    plays: [
      play({ v: "a", t: "Undone - The Sweater Song" }),
      play({ v: "b", t: "Undone" }),
    ],
  });
  assert.equal(r.canonical_links_made, 0, "the dashed half is part of the title");
});

test("bucket ladder is applied to the two ingestible buckets", async () => {
  const db = makeDb();
  await run(db, {
    poll_date: "2026-08-27",
    plays: [play({ v: "a", t: "A", b: "Today" }), play({ v: "b", t: "B", b: "Yesterday" })],
  });
  const byBucket = Object.fromEntries(db._tables.dj_plays.map((p) => [p.played_bucket, p]));
  assert.deepEqual(
    [byBucket["Today"].played_on, byBucket["Today"].precision], ["2026-08-27", "day"]);
  assert.deepEqual(
    [byBucket["Yesterday"].played_on, byBucket["Yesterday"].precision], ["2026-08-26", "day"]);
});

test("coarse buckets are REJECTED, and the message says why", async () => {
  // spec §4.3 — they resolve relative to poll_date, so the date moves daily and
  // the same play re-inserts under a new one. Enforced here, not in a runbook,
  // because phase 5's scheduled task would otherwise have to remember it.
  const db = makeDb();
  for (const b of ["This week", "Last week"]) {
    await assert.rejects(
      () => run(db, { poll_date: "2026-08-27", plays: [play({ v: "a", t: "A", b })] }),
      /cannot be written.*precise buckets only/s,
      `bucket ${b} should be rejected`,
    );
  }
  assert.equal(db._tables.dj_plays.length, 0);
});

test("a play crossing Today -> Yesterday does NOT duplicate", async () => {
  // THE case the new key exists for. Same real play, seen on two consecutive
  // days under two different labels, resolves to the same played_on both times.
  const db = makeDb();
  const tue = await run(db, {
    poll_date: "2026-08-27",
    plays: [play({ v: "v1", t: "Song", b: "Today" })],
  });
  assert.equal(tue.plays_inserted, 1);

  const wed = await run(db, {
    poll_date: "2026-08-28",
    plays: [play({ v: "v1", t: "Song", b: "Yesterday" })],
  });
  assert.equal(wed.plays_inserted, 0, "the same play under a new label must not re-insert");
  assert.equal(db._tables.dj_plays.length, 1);
  assert.equal(db._tables.dj_plays[0].played_on, "2026-08-27");
});

test("the SAME track played on two different days yields TWO rows", async () => {
  // The other half of the old key's failure: both days arrive labelled "Today",
  // which collided and silently dropped the second. Keyed on played_on they are
  // correctly distinct.
  const db = makeDb();
  await run(db, { poll_date: "2026-08-27", plays: [play({ v: "v1", t: "Song", b: "Today" })] });
  const day2 = await run(db, { poll_date: "2026-08-28", plays: [play({ v: "v1", t: "Song", b: "Today" })] });
  assert.equal(day2.plays_inserted, 1, "a genuinely different day must insert");
  assert.equal(db._tables.dj_plays.length, 2);
  assert.deepEqual(
    db._tables.dj_plays.map((r) => r.played_on).sort(),
    ["2026-08-27", "2026-08-28"]);
});

test("explicit-date rows keep a null bucket and still dedupe", async () => {
  // played_bucket is diagnostic only now, so a null is honest rather than
  // dangerous — the key is played_on.
  const db = makeDb();
  const plays = [{
    video_id: "v1", title: "Song", artists: ["A"],
    played_on: "2025-04-02", precision: "exact",
  }];
  const first = await run(db, { plays, source: "takeout" });
  assert.equal(first.plays_inserted, 1);
  assert.equal(db._tables.dj_plays[0].played_bucket, null);

  const second = await run(db, { plays, source: "takeout" });
  assert.equal(second.plays_inserted, 0, "takeout re-import must not duplicate");
});

test("source is part of the dedupe key, so poll and takeout coexist", async () => {
  const db = makeDb();
  await run(db, { poll_date: "2026-08-27", plays: [play({ v: "v1", t: "Song" })] });
  const r = await run(db, {
    source: "takeout",
    plays: [{ video_id: "v1", title: "Song", artists: ["Weezer"], played_on: "2026-08-27", precision: "exact" }],
  });
  assert.equal(r.plays_inserted, 1);
  assert.equal(db._tables.dj_plays.length, 2);
});

// --- rejection paths ---

test("over the cap the call is REJECTED, not truncated", async () => {
  const db = makeDb();
  const many = Array.from({ length: 501 }, (_, i) => play({ v: `v${i}`, t: `T${i}` }));
  await assert.rejects(
    () => run(db, { poll_date: "2026-08-27", plays: many }),
    /exceeds the per-call cap of 500.*Nothing was written/s,
  );
  assert.equal(db._tables.dj_plays.length, 0);
});

test("validation errors are batched and nothing is written", async () => {
  const db = makeDb();
  await assert.rejects(
    () => run(db, {
      poll_date: "2026-08-27",
      plays: [
        { title: "no video id", played_bucket: "Today" },
        { video_id: "v2", played_bucket: "Today" },
        { video_id: "v3", title: "bad bucket", played_bucket: "Fortnight ago" },
      ],
    }),
    /3 validation error\(s\). No rows written/,
  );
  assert.equal(db._tables.dj_tracks.length, 0);
  assert.equal(db._tables.dj_plays.length, 0);
});

test("a bucket without poll_date is rejected", async () => {
  const db = makeDb();
  await assert.rejects(
    () => run(db, { plays: [play({ v: "v1", t: "T" })] }),
    /poll_date` is missing/,
  );
});

test("create_platform_run and get_platform_runs round-trip", async () => {
  const db = makeDb();
  const ctx = { db, userId: USER };
  await toolByName.create_platform_run.handler({
    app: "dj", job: "daily_history_sync", executor: "claude", host: "desktop",
    status: "ok", covered_from: "2026-08-18", covered_to: "2026-08-27",
    details: { plays_inserted: 31 },
  }, ctx);
  await toolByName.create_platform_run.handler({
    app: "dj", job: "daily_history_sync", executor: "claude",
    status: "auth_expired", error_message: "auth_expired: rejected",
  }, ctx);

  const all = await toolByName.get_platform_runs.handler({ app: "dj" }, ctx);
  assert.equal(all.length, 2);
  const ok = await toolByName.get_platform_runs.handler(
    { app: "dj", job: "daily_history_sync", status: "ok", limit: 1 }, ctx);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].covered_to, "2026-08-27");
});

test("timestamps never invert when both are defaulted", async () => {
  // The 2a smoke test caught this live: started_at came from the DB AFTER the
  // round trip while finished_at came from the Edge runtime BEFORE it, so the
  // run ended ~278ms before it began. Anything computing a duration from the
  // pair would get a negative number.
  const db = makeDb();
  const row = await toolByName.create_platform_run.handler(
    { app: "dj", job: "j", executor: "claude", status: "ok" },
    { db, userId: USER },
  );
  assert.ok(row.started_at, "started_at must be written explicitly, not left to the DB default");
  assert.ok(row.finished_at);
  assert.ok(
    new Date(row.finished_at) >= new Date(row.started_at),
    `finished_at ${row.finished_at} precedes started_at ${row.started_at}`,
  );
  assert.equal(row.started_at, row.finished_at, "one clock, one instant");
});

test("a caller-supplied started_at yields a real positive duration", async () => {
  const db = makeDb();
  const row = await toolByName.create_platform_run.handler(
    { app: "dj", job: "j", executor: "claude", status: "ok", started_at: "2026-08-27T21:00:00.000Z" },
    { db, userId: USER },
  );
  assert.ok(new Date(row.finished_at) > new Date(row.started_at));
});

test("an inverted pair is rejected rather than written", async () => {
  const db = makeDb();
  await assert.rejects(
    () => toolByName.create_platform_run.handler({
      app: "dj", job: "j", executor: "claude", status: "ok",
      started_at: "2026-08-27T21:00:00.000Z",
      finished_at: "2026-08-27T20:00:00.000Z",
    }, { db, userId: USER }),
    /cannot end before it begins/,
  );
  assert.equal(db._tables.platform_runs.length, 0);
});
