// Handler tests for record_dj_playlist and create_dj_concert, against a
// simulated PostgREST client.
//
// Run (Node 24+, no Deno toolchain needed):
//   node --experimental-strip-types --test supabase/functions/_shared/tools/dj-playlists.test.mjs
//
// Same approach as dj-courier.test.mjs: read the real source, stub only its
// ../platform.ts import, import from a temp copy. No checked-in duplicate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, copyFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = "const defineTool = (o: any) => { (globalThis as any).__tools ??= []; (globalThis as any).__tools.push(o); return o; };";

const dir = mkdtempSync(join(tmpdir(), "dj-playlists-"));
for (const f of readdirSync(HERE)) {
  if (f.startsWith("dj-") && f.endsWith(".ts")) copyFileSync(join(HERE, f), join(dir, f));
}
const src = readFileSync(join(HERE, "dj-playlists.ts"), "utf-8").replace(
  'import { defineTool } from "../platform.ts";',
  STUB,
);
if (src.includes("../platform.ts")) {
  throw new Error("dj-playlists.ts import line changed — update the stub in this test.");
}
writeFileSync(join(dir, "dj-playlists.probe.ts"), src);

globalThis.__tools = [];
await import(pathToFileURL(join(dir, "dj-playlists.probe.ts")).href);
const tool = Object.fromEntries(globalThis.__tools.map((t) => [t.name, t]));

const USER = "user-1";

function makeDb() {
  const tables = {
    dj_tracks: [], dj_playlists: [], dj_playlist_tracks: [],
    dj_artists: [], dj_concerts: [],
  };
  let seq = 0;
  const uniq = {
    dj_tracks: (r) => `${r.user_id}|${r.video_id}`,
    dj_playlists: (r) => `${r.user_id}|${r.yt_playlist_id}`,
    // Both real constraints. The (role, position) one is DEFERRABLE in
    // Postgres — checked at commit — so it is NOT enforced per-row here.
    dj_playlist_tracks: (r) => `${r.playlist_id}|${r.role}|${r.track_id}`,
    dj_artists: (r) => `${r.user_id}|${r.name}`,
    dj_concerts: (r) => r.id,
  };

  function builder(table) {
    let rows = null, updates = null;
    const filters = [];
    let single = false, maybe = false;
    const api = {
      select() { return api; },
      in(c, v) { filters.push((r) => v.includes(r[c])); return api; },
      eq(c, v) { filters.push((r) => r[c] === v); return api; },
      order() { return api; },
      limit() { return api; },
      single() { single = true; return api; },
      maybeSingle() { maybe = true; return api; },
      upsert(newRows, opts = {}) { rows = { newRows, opts }; return api; },
      insert(r) { rows = { newRows: Array.isArray(r) ? r : [r], opts: {} }; return api; },
      update(vals) { updates = vals; return api; },
      then(resolve) {
        if (updates) {
          const hit = tables[table].filter((r) => filters.every((f) => f(r)));
          for (const r of hit) Object.assign(r, updates);
          return resolve({ data: hit, error: null });
        }
        if (rows) {
          const out = [];
          for (const r of rows.newRows) {
            const full = {
              id: `id-${++seq}`, user_id: USER,
              created_at: new Date(1700000000000 + seq * 1000).toISOString(), ...r,
            };
            const key = uniq[table](full);
            const clash = tables[table].find((e) => uniq[table](e) === key);
            if (clash) {
              if (rows.opts.ignoreDuplicates) continue;
              if (rows.opts.onConflict) { Object.assign(clash, r); out.push(clash); continue; }
              return resolve({ data: null, error: { message: `duplicate key ${key}` } });
            }
            tables[table].push(full);
            out.push(full);
          }
          return resolve({ data: single ? (out[0] ?? null) : out, error: null });
        }
        const hit = tables[table].filter((r) => filters.every((f) => f(r)));
        if (single || maybe) return resolve({ data: hit[0] ?? null, error: null });
        return resolve({ data: hit, error: null });
      },
    };
    return api;
  }
  return { from: (t) => builder(t), _tables: tables };
}

const ctxFor = (db) => ({ db, userId: USER });
const rec = (db, a) => tool.record_dj_playlist.handler(a, ctxFor(db));
const con = (db, a) => tool.create_dj_concert.handler(a, ctxFor(db));

const trk = (o) => ({
  video_id: o.v, title: o.t, artists: o.a ?? ["Weezer"],
  album: o.alb ?? null, duration_seconds: 200,
  role: o.role ?? "body", position: o.p, added_reason: o.reason ?? "import",
  yt_set_video_id: o.svid ?? null,
});

// ---------------------------------------------------------------------------

test("creates playlist, tracks and membership in one call", async () => {
  const db = makeDb();
  const r = await rec(db, {
    yt_playlist_id: "PL_new", name: "Weezer Concert", kind: "concert",
    tracks: [
      trk({ v: "v1", t: "My Name Is Jonas", p: 1 }),
      trk({ v: "v2", t: "Undone - The Sweater Song", p: 2 }),
      trk({ v: "v3", t: "Buddy Holly", p: 3 }),
    ],
  });
  assert.equal(r.playlist_created, true);
  assert.equal(r.tracks_created, 3);
  assert.equal(r.membership_rows_written, 3);
  assert.deepEqual(r.by_role, { body: 3, cram: 0 });
  assert.equal(db._tables.dj_playlist_tracks.length, 3);
});

test("re-recording updates in place and refreshes the set_video_id cache", async () => {
  // yt_set_video_id must be refreshed on every read; re-recording is how that
  // reaches the database. It must not duplicate membership.
  const db = makeDb();
  const first = await rec(db, {
    yt_playlist_id: "PL_x", name: "Weezer Concert", kind: "concert",
    tracks: [trk({ v: "v1", t: "Buddy Holly", p: 1, svid: "SV_OLD" })],
  });
  const second = await rec(db, {
    yt_playlist_id: "PL_x", name: "Weezer Concert", kind: "concert",
    tracks: [trk({ v: "v1", t: "Buddy Holly", p: 1, svid: "SV_NEW" })],
  });
  assert.equal(second.playlist_created, false);
  assert.equal(second.playlist_id, first.playlist_id);
  assert.equal(second.tracks_created, 0, "insert-only: the track already existed");
  assert.equal(db._tables.dj_playlist_tracks.length, 1, "no duplicate membership row");
  assert.equal(db._tables.dj_playlist_tracks[0].yt_set_video_id, "SV_NEW");
});

test("the same track in BOTH zones is legitimate", async () => {
  // spec §5 — duplication across zones is what makes "clear the cram list" a
  // delete of cram rows that leaves the concert order intact.
  const db = makeDb();
  const r = await rec(db, {
    yt_playlist_id: "PL_z", name: "Weezer Concert", kind: "concert",
    tracks: [
      trk({ v: "v1", t: "Shine Again", p: 1, role: "body" }),
      trk({ v: "v1", t: "Shine Again", p: 1, role: "cram", reason: "new_setlist" }),
    ],
  });
  assert.deepEqual(r.by_role, { body: 1, cram: 1 });
  assert.equal(r.tracks_created, 1, "one video is one dj_tracks row");
  assert.equal(db._tables.dj_playlist_tracks.length, 2);
});

test("the same track TWICE in one zone is rejected", async () => {
  const db = makeDb();
  await assert.rejects(
    () => rec(db, {
      yt_playlist_id: "PL_z", name: "x", kind: "concert",
      tracks: [
        trk({ v: "v1", t: "Song", p: 1, role: "body" }),
        trk({ v: "v1", t: "Song", p: 2, role: "body" }),
      ],
    }),
    /duplicate \(role, video_id\)/,
  );
  assert.equal(db._tables.dj_playlist_tracks.length, 0);
});

test("duplicate (role, position) is rejected before writing", async () => {
  const db = makeDb();
  await assert.rejects(
    () => rec(db, {
      yt_playlist_id: "PL_z", name: "x", kind: "concert",
      tracks: [
        trk({ v: "v1", t: "A", p: 1, role: "body" }),
        trk({ v: "v2", t: "B", p: 1, role: "body" }),
      ],
    }),
    /duplicate \(role, position\)/,
  );
  assert.equal(db._tables.dj_playlists.length, 0, "nothing written on validation failure");
});

test("canonical grouping runs on playlist tracks too, via the shared resolver", async () => {
  const db = makeDb();
  const r = await rec(db, {
    yt_playlist_id: "PL_c", name: "Jazz", kind: "jazz",
    tracks: [
      trk({ v: "clean", t: "The Pleasure Is Mine", a: ["Herbie Hancock"], p: 1 }),
      trk({ v: "rem", t: "The Pleasure Is Mine (Remastered 1999)", a: ["Herbie Hancock"], p: 2 }),
    ],
  });
  assert.equal(r.canonical_links_made, 1);
  assert.equal(r.canonical_links[0].canonical_title, "The Pleasure Is Mine");
});

test("concert_id is refused on a non-concert playlist", async () => {
  const db = makeDb();
  await assert.rejects(
    () => rec(db, { yt_playlist_id: "PL_a", name: "x", kind: "artist", concert_id: "c1", tracks: [] }),
    /only be set when kind is 'concert'/,
  );
});

test("bad role and bad added_reason are both caught", async () => {
  const db = makeDb();
  await assert.rejects(
    () => rec(db, {
      yt_playlist_id: "PL_b", name: "x", kind: "concert",
      tracks: [{ video_id: "v", title: "t", role: "middle", position: 1, added_reason: "vibes" }],
    }),
    /role.*cram.*body|added_reason/s,
  );
});

// --- create_dj_concert ------------------------------------------------------

test("creates the artist when unknown, then the concert", async () => {
  const db = makeDb();
  const r = await con(db, {
    artist_name: "Weezer", artist_tags: ["90s", "alt-rock"],
    tour_name: "WEEZER: The Gathering",
    starts_on: "2026-10-15", status: "committed",
    notes: "Las Vegas",
  });
  assert.equal(r.artist_created, true);
  assert.equal(r.artist_name, "Weezer");
  assert.equal(r.status, "committed");
  assert.equal(db._tables.dj_artists.length, 1);
  assert.deepEqual(db._tables.dj_artists[0].tags, ["90s", "alt-rock"]);
});

test("reuses an existing artist rather than duplicating", async () => {
  const db = makeDb();
  await con(db, { artist_name: "Weezer", starts_on: "2026-10-15", status: "committed" });
  const second = await con(db, { artist_name: "Weezer", starts_on: "2026-11-02", status: "interested" });
  assert.equal(second.artist_created, false);
  assert.equal(db._tables.dj_artists.length, 1);
  assert.equal(db._tables.dj_concerts.length, 2, "two shows, one artist");
});

test("a residency keeps its date range; an inverted one is rejected", async () => {
  const db = makeDb();
  const r = await con(db, {
    artist_name: "Metallica", starts_on: "2026-10-15", ends_on: "2026-11-11",
    status: "screening",
  });
  assert.equal(r.ends_on, "2026-11-11");

  await assert.rejects(
    () => con(db, {
      artist_name: "Metallica", starts_on: "2026-11-11", ends_on: "2026-10-15",
      status: "screening",
    }),
    /before starts_on/,
  );
});

test("invalid status is rejected with the vocabulary", async () => {
  const db = makeDb();
  await assert.rejects(
    () => con(db, { artist_name: "X", starts_on: "2026-10-15", status: "maybe" }),
    /screening.*interested.*committed/s,
  );
});
