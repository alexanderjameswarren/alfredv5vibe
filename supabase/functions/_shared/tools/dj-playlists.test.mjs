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
// The module itself too, for the exports that are not tools — classifyRead is a
// pure function and is tested directly rather than only over HTTP, which is
// exactly what it lacked when it shipped wrong.
const mod = await import(pathToFileURL(join(dir, "dj-playlists.probe.ts")).href);
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
    // ⚠️ (playlist_id, role, position) — the identity since migration 012, and
    // the ON CONFLICT arbiter record_dj_playlist now uses. It was
    // `|${r.track_id}` here, modelling the constraint 012 DROPPED, which made
    // "the same song twice is accepted" pass for the wrong reason: the second
    // row collided, took the onConflict branch, and was counted as written
    // without ever existing. A stale fake is a test that agrees with the old
    // schema forever.
    dj_playlist_tracks: (r) => `${r.playlist_id}|${r.role}|${r.position}`,
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

test("the same track twice in one zone is ACCEPTED — reversed by 012", async () => {
  // ⚠️ THIS TEST USED TO ASSERT THE OPPOSITE, and it was right when written:
  // for a CONCERT playlist a repeated song is meaningless. Phase 6b recorded the
  // whole library and the assumption stopped holding — five real playlists
  // repeat songs. Inverted rather than deleted, so the reversal is visible in
  // the history instead of looking like coverage that quietly went missing.
  const db = makeDb();
  await rec(db, {
    yt_playlist_id: "PL_z", name: "x", kind: "concert",
    tracks: [
      trk({ v: "v1", t: "Song", p: 1, role: "body" }),
      trk({ v: "v1", t: "Song", p: 2, role: "body" }),
    ],
  });
  assert.equal(db._tables.dj_playlist_tracks.length, 2,
    "two slots, one song — each slot is its own row");
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

// --- migration 010/011: undated concerts and the utility kind ---------------
//
// ⚠️ THESE LIVE HERE BECAUSE THE MCP-LEVEL TEST STRUCTURALLY CANNOT COVER THEM.
// index.test.mjs stubs zod with a chainable Proxy, so every `z.enum([...])` is
// an opaque object there — a typo'd or un-widened enum registers perfectly and
// the suite stays green. Registration is not validation. The handler is where
// the refusal actually happens, so the refusal is asserted here.

test("kind 'utility' is accepted (migration 011)", async () => {
  const db = makeDb();
  const out = await rec(db, {
    yt_playlist_id: "PL_util", name: "General Running", kind: "utility", tracks: [],
  });
  assert.equal(out.playlist_created, true);
});

test("a nonsense kind is still rejected — the enum was widened, not removed", async () => {
  // The negative control. Widening a list is exactly where the list stops
  // being a list; without this, `VALID_KIND` could accept anything and every
  // other test would still pass.
  const db = makeDb();
  await assert.rejects(
    () => rec(db, { yt_playlist_id: "PL_bad", name: "x", kind: "running", tracks: [] }),
    /utility/,
    "a bad kind must be refused, and the message should name the valid set",
  );
});

test("a utility playlist still cannot carry a concert_id", async () => {
  const db = makeDb();
  await assert.rejects(
    () => rec(db, {
      yt_playlist_id: "PL_ul", name: "x", kind: "utility",
      concert_id: "c1", tracks: [],
    }),
    /only be set when kind is 'concert'/,
  );
});

test("a concert can be created with NO starts_on (migration 010)", async () => {
  // The library import's whole point: history whose date is lost, and the
  // undated 'screening' watchlist.
  const db = makeDb();
  const out = await con(db, { artist_name: "Adele", status: "attended" });
  assert.equal(out.starts_on, null, "undated concert must store starts_on as null");
});

test("undated 'screening' is allowed — it is the standing watchlist", async () => {
  const db = makeDb();
  const out = await con(db, { artist_name: "Oasis", status: "screening" });
  assert.equal(out.starts_on, null);
  assert.equal(out.status, "screening");
});

for (const status of ["interested", "committed"]) {
  test(`undated '${status}' is refused, and the message offers the fix`, async () => {
    // ⚠️ The DB's dj_concerts_undated_status would refuse this anyway. What is
    // asserted here is the MESSAGE — because the raw constraint error names a
    // constraint and explains nothing, and the natural next move on reading it
    // is to invent a date, which is the exact failure the nullable column was
    // added to prevent.
    const db = makeDb();
    await assert.rejects(
      () => con(db, { artist_name: "X", status }),
      (e) => {
        assert.match(e.message, /screening/,
          "the refusal must point at the status that IS valid undated");
        assert.match(e.message, /specific show/i,
          "the refusal must say WHY those two statuses need a date");
        assert.doesNotMatch(e.message, /dj_concerts_undated_status/,
          "the raw constraint name must not be what the caller sees");
        return true;
      },
    );
  });
}

test("ends_on without starts_on is refused — the DB CHECK would NOT catch it", async () => {
  // dj_concerts_date_range is `ends_on IS NULL OR ends_on >= starts_on`. With a
  // NULL starts_on that evaluates to NULL, which PASSES. So a residency with an
  // end and no beginning would be stored happily and read as nonsense. This is
  // the one guard here that the database genuinely cannot make for us.
  const db = makeDb();
  await assert.rejects(
    () => con(db, { artist_name: "X", ends_on: "2026-10-15", status: "attended" }),
    /not a range|without `starts_on`/,
  );
});

test("a malformed starts_on is still rejected — optional is not unvalidated", async () => {
  const db = makeDb();
  await assert.rejects(
    () => con(db, { artist_name: "X", starts_on: "15-10-2026", status: "attended" }),
    /YYYY-MM-DD/,
  );
});

// --- step 0: absent vs explicitly null on re-record --------------------------
//
// 🛑 THE BUG THIS PINS. `concert_id: args.concert_id ?? null` collapsed "not
// mentioned" into "set to null". Re-recording runs an UPDATE, so a bulk
// importer that never mentions concert_id would have unlinked every concert
// playlist in one pass — silently, because the FK is ON DELETE SET NULL and
// nothing raises.
//
// ⚠️ "THE FIELD IS STILL SET" IS NOT ENOUGH ON ITS OWN. Against a fake db it
// would also pass if the UPDATE never reached the row at all — a test that
// cannot fail (spec §11.1). So the FIRST test below is the control: it proves
// this harness DOES observe a clearing, by asking for one and seeing it happen.
// Only then does "it was preserved" mean the fix works rather than the
// mechanism being inert.

async function seedLinkedPlaylist(db) {
  await rec(db, {
    yt_playlist_id: "PL_link", name: "Coldplay Concert", kind: "concert",
    concert_id: "concert-abc", description: "seeded", tracks: [],
  });
  return db._tables.dj_playlists.find((p) => p.yt_playlist_id === "PL_link");
}

test("CONTROL: an explicit null DOES clear concert_id — the harness can see a clearing", async () => {
  const db = makeDb();
  const before = await seedLinkedPlaylist(db);
  assert.equal(before.concert_id, "concert-abc", "seed did not link");

  await rec(db, {
    yt_playlist_id: "PL_link", name: "Coldplay Concert", kind: "artist",
    concert_id: null, tracks: [],
  });

  const after = db._tables.dj_playlists.find((p) => p.yt_playlist_id === "PL_link");
  assert.equal(after.concert_id, null,
    "an explicit null must clear the link — if this fails, the preservation " +
    "tests below prove nothing, because this harness cannot observe a clearing");
});

test("re-recording WITHOUT concert_id preserves the existing link", async () => {
  const db = makeDb();
  await seedLinkedPlaylist(db);

  // Exactly what the bulk importer does: read contents, write membership,
  // never mention concert_id.
  await rec(db, {
    yt_playlist_id: "PL_link", name: "Coldplay Concert", kind: "concert",
    tracks: [trk({ v: "v1", t: "Yellow", r: "body", p: 0 })],
  });

  const after = db._tables.dj_playlists.find((p) => p.yt_playlist_id === "PL_link");
  assert.equal(after.concert_id, "concert-abc",
    "the importer would have unlinked this playlist");
});

test("re-recording WITHOUT description preserves it", async () => {
  // Same bug, same line. The Foo Fighters seed note would have been blanked.
  const db = makeDb();
  await seedLinkedPlaylist(db);

  await rec(db, {
    yt_playlist_id: "PL_link", name: "Coldplay Concert", kind: "concert", tracks: [],
  });

  const after = db._tables.dj_playlists.find((p) => p.yt_playlist_id === "PL_link");
  assert.equal(after.description, "seeded");
});

test("an explicit null description clears it — still expressible", async () => {
  const db = makeDb();
  await seedLinkedPlaylist(db);
  await rec(db, {
    yt_playlist_id: "PL_link", name: "Coldplay Concert", kind: "concert",
    description: null, tracks: [],
  });
  const after = db._tables.dj_playlists.find((p) => p.yt_playlist_id === "PL_link");
  assert.equal(after.description, null);
});

test("changing kind away from concert while a link survives is refused in a sentence", async () => {
  // A case the fix itself creates: an unmentioned concert_id now survives, so
  // it can outlive the kind that justified it. The DB CHECK would refuse this
  // with a constraint name; the handler refuses it with the remedy.
  const db = makeDb();
  await seedLinkedPlaylist(db);

  await assert.rejects(
    () => rec(db, {
      yt_playlist_id: "PL_link", name: "Coldplay Concert", kind: "artist", tracks: [],
    }),
    (e) => {
      assert.match(e.message, /concert-abc/, "name the link that is in the way");
      assert.match(e.message, /concert_id: null/, "name the remedy");
      assert.doesNotMatch(e.message, /dj_playlists_concert_link/,
        "the raw constraint name must not be what the caller sees");
      return true;
    },
  );
});

test("a first record with no concert_id is unaffected — insert, not update", async () => {
  const db = makeDb();
  await rec(db, {
    yt_playlist_id: "PL_fresh", name: "Yoga", kind: "utility", tracks: [],
  });
  const row = db._tables.dj_playlists.find((p) => p.yt_playlist_id === "PL_fresh");
  assert.equal(row.concert_id ?? null, null);
});

// --- step 0: the `tracks` ambiguity, resolved and pinned ---------------------
//
// The Claude thread hit this: the contract did not say whether omitting
// `tracks` leaves membership alone or clears it, so a full re-record was done
// defensively. The answer is "leaves it alone" — membership is UPSERT-ONLY and
// nothing in this tool deletes. These tests pin that, and pin the consequence:
// the recorded body can grow but never shrink, so drift is reported.

test("omitting `tracks` leaves membership untouched, and SAYS so", async () => {
  const db = makeDb();
  await rec(db, {
    yt_playlist_id: "PL_m", name: "Coldplay Concert", kind: "concert",
    tracks: [trk({ v: "v1", t: "Yellow", r: "body", p: 0 }),
             trk({ v: "v2", t: "Clocks", r: "body", p: 1 })],
  });

  const out = await rec(db, {
    yt_playlist_id: "PL_m", name: "Coldplay Concert", kind: "concert",
  });

  assert.equal(out.membership_mode, "untouched");
  assert.equal(
    db._tables.dj_playlist_tracks.length, 2,
    "omitting tracks must not remove membership",
  );
});

test("`tracks: []` is also untouched, not a clear", async () => {
  const db = makeDb();
  await rec(db, {
    yt_playlist_id: "PL_e", name: "x", kind: "concert",
    tracks: [trk({ v: "v1", t: "Yellow", r: "body", p: 0 })],
  });
  const out = await rec(db, {
    yt_playlist_id: "PL_e", name: "x", kind: "concert", tracks: [],
  });
  assert.equal(out.membership_mode, "untouched");
  assert.equal(db._tables.dj_playlist_tracks.length, 1);
});

test("a shrunk playlist reports stale_rows and deletes NOTHING", async () => {
  // The drift case: two tracks recorded, then one removed on YouTube. A
  // re-record must not silently drop the row, and must not silently keep it
  // either — it reports.
  const db = makeDb();
  await rec(db, {
    yt_playlist_id: "PL_s", name: "x", kind: "concert",
    tracks: [trk({ v: "v1", t: "Yellow", r: "body", p: 0 }),
             trk({ v: "v2", t: "Clocks", r: "body", p: 1 })],
  });

  const out = await rec(db, {
    yt_playlist_id: "PL_s", name: "x", kind: "concert",
    tracks: [trk({ v: "v1", t: "Yellow", r: "body", p: 0 })],
  });

  assert.equal(out.stale_rows, 1, "the dropped track must be reported");
  assert.equal(out.stale_sample.length, 1);
  assert.equal(
    db._tables.dj_playlist_tracks.length, 2,
    "tier 2 must not delete membership as a side effect of a re-record",
  );
});

test("a faithful re-record reports zero drift", async () => {
  // The negative control for stale_rows: it must be able to read 0, or a
  // non-zero reading proves nothing. Every import in Phase 6b will hit this
  // path, and a detector that always fires would be ignored by the third
  // playlist (spec §11.7).
  const db = makeDb();
  const tracks = [trk({ v: "v1", t: "Yellow", r: "body", p: 0 }),
                  trk({ v: "v2", t: "Clocks", r: "body", p: 1 })];
  await rec(db, { yt_playlist_id: "PL_f", name: "x", kind: "concert", tracks });
  const out = await rec(db, { yt_playlist_id: "PL_f", name: "x", kind: "concert", tracks });
  assert.equal(out.stale_rows, 0);
  assert.equal(out.membership_mode, "upserted");
});

// --- 012: a playlist may hold the same song twice ---------------------------
//
// The Phase 6b dry run failed on five real playlists — Family party (5),
// Awesome (3), 5K (4), Yoga (50), Archived Weezer (110) — because the handler
// rejected a repeated video_id within a zone. That rule was written for CONCERT
// playlists, where a repeat is meaningless, and it does not hold for a library.

test("the same song twice in a body is ACCEPTED (012)", async () => {
  const db = makeDb();
  const out = await rec(db, {
    yt_playlist_id: "PL_dup", name: "Family party", kind: "utility",
    tracks: [trk({ v: "v1", t: "Song", role: "body", p: 0 }),
             trk({ v: "v2", t: "Other", role: "body", p: 1 }),
             trk({ v: "v1", t: "Song", role: "body", p: 2 })],
  });
  assert.equal(out.membership_rows_written, 3,
    "a repeated song must occupy its own slot, not collapse into one row");
});

test("two rows claiming the SAME slot are still rejected", async () => {
  // The negative control for 012. Position is now the whole identity, so if it
  // stopped being enforced the table would accept anything and every other
  // assertion here would still pass.
  const db = makeDb();
  await assert.rejects(
    () => rec(db, {
      yt_playlist_id: "PL_slot", name: "x", kind: "utility",
      tracks: [trk({ v: "v1", t: "A", role: "body", p: 0 }),
               trk({ v: "v2", t: "B", role: "body", p: 0 })],
    }),
    /duplicate \(role, position\)/,
  );
});

test("a repeated song across zones is still fine", async () => {
  // §5's original case, which 012 must not disturb: one row in cram and one in
  // body is what makes "clear the cram list" leave the body intact.
  const db = makeDb();
  const out = await rec(db, {
    yt_playlist_id: "PL_z", name: "Coldplay Concert", kind: "concert",
    tracks: [trk({ v: "v1", t: "Yellow", role: "body", p: 0 }),
             trk({ v: "v1", t: "Yellow", role: "cram", p: 0 })],
  });
  assert.equal(out.by_role.body, 1);
  assert.equal(out.by_role.cram, 1);
});

test("stale detection keys on POSITION, so a dropped duplicate is seen", async () => {
  // ⚠️ The case a track-keyed comparison would MISS. v1 sits at positions 0 and
  // 2; the re-record drops the copy at 2. Keyed on track_id, v1 is still
  // present so nothing looks stale — and a real dropped slot goes unreported.
  const db = makeDb();
  await rec(db, {
    yt_playlist_id: "PL_sd", name: "x", kind: "utility",
    tracks: [trk({ v: "v1", t: "Song", role: "body", p: 0 }),
             trk({ v: "v2", t: "Other", role: "body", p: 1 }),
             trk({ v: "v1", t: "Song", role: "body", p: 2 })],
  });

  const out = await rec(db, {
    yt_playlist_id: "PL_sd", name: "x", kind: "utility",
    tracks: [trk({ v: "v1", t: "Song", role: "body", p: 0 }),
             trk({ v: "v2", t: "Other", role: "body", p: 1 })],
  });

  assert.equal(out.stale_rows, 1,
    "the dropped duplicate at position 2 must be reported as stale");
});

// --- create_dj_concert duplicate guard --------------------------------------

test("a second concert for the same act on the same date is REFUSED", async () => {
  // ⚠️ This is how a wrong date gets DUPLICATED instead of corrected. Weezer's
  // row said 2026-10-15 when the show is 2026-10-23; before update_dj_concert
  // existed, the only way to "fix" it was to create another row — leaving two
  // records of one night and nothing saying which is real.
  const db = makeDb();
  await con(db, { artist_name: "Weezer", starts_on: "2026-10-23", status: "committed" });
  await assert.rejects(
    () => con(db, { artist_name: "Weezer", starts_on: "2026-10-23", status: "attended" }),
    (e) => {
      assert.match(e.message, /already has a concert on 2026-10-23/);
      assert.match(e.message, /update_dj_concert/, "must name the tool that fixes it");
      return true;
    },
  );
  assert.equal(db._tables.dj_concerts.length, 1, "nothing written");
});

test("the same act on a DIFFERENT date is fine", async () => {
  // The negative control: a guard that refused every second concert for an
  // artist would block a residency, a tour, and simply seeing a band twice.
  const db = makeDb();
  await con(db, { artist_name: "Weezer", starts_on: "2026-10-23", status: "committed" });
  await con(db, { artist_name: "Weezer", starts_on: "2026-11-02", status: "interested" });
  assert.equal(db._tables.dj_concerts.length, 2);
});

test("two UNDATED concerts for one act are allowed", async () => {
  // A lost historical show and a standing watchlist entry are different facts
  // about the same artist, and there is no date for them to collide on.
  const db = makeDb();
  await con(db, { artist_name: "Oasis", status: "screening" });
  await con(db, { artist_name: "Oasis", status: "missed" });
  assert.equal(db._tables.dj_concerts.length, 2);
});

// --- two ceilings on one operation ------------------------------------------
//
// 🛑 THE SECOND CAP IS THE ONE THAT WOULD HAVE BEEN MISSED. Raising only the
// READ ceiling would have let a 379-track playlist be fetched and then refused
// HERE with "exceeds the cap of 300" — the failure moving from read to write,
// where it looks like a different problem with a different cause.

const bulk = (db, a) => tool.record_dj_playlist_bulk.handler(a, ctxFor(db));
const many = (n) => Array.from({ length: n }, (_, i) =>
  trk({ v: `v${i}`, t: `Song ${i}`, role: "body", p: i }));

test("the MCP tool still refuses more than 300 tracks", async () => {
  await assert.rejects(
    () => rec(makeDb(), {
      yt_playlist_id: "PL_big", name: "x", kind: "utility", tracks: many(379),
    }),
    /379 tracks exceeds the cap of 300/,
  );
});

test("the BULK tool accepts 379 — Elise's fun list", async () => {
  const db = makeDb();
  const out = await bulk(db, {
    yt_playlist_id: "PL_big", name: "Elise's fun list", kind: "utility",
    tracks: many(379),
  });
  assert.equal(out.membership_rows_written, 379);
});

test("the bulk ceiling is a ceiling, not an absence of one", async () => {
  // The negative control. "Raise the cap for the script" must not become "the
  // script has no cap" — an unbounded payload is how a runaway caller writes
  // something nobody meant.
  await assert.rejects(
    () => bulk(makeDb(), {
      yt_playlist_id: "PL_huge", name: "x", kind: "utility", tracks: many(501),
    }),
    /501 tracks exceeds the cap of 500/,
  );
});

test("both tools share ONE handler, so behaviour cannot diverge", async () => {
  // Same payload through both paths must produce the same rows. A second copy
  // of the handler would agree today and drift on the next change to either.
  const a = makeDb(), b = makeDb();
  const payload = (id) => ({
    yt_playlist_id: id, name: "x", kind: "utility",
    tracks: [trk({ v: "v1", t: "A", role: "body", p: 0 }),
             trk({ v: "v1", t: "A", role: "body", p: 1 })],
  });
  const viaMcp = await rec(a, payload("PL_1"));
  const viaBulk = await bulk(b, payload("PL_1"));
  assert.equal(viaMcp.membership_rows_written, viaBulk.membership_rows_written);
  assert.equal(viaMcp.membership_mode, viaBulk.membership_mode);
  assert.deepEqual(viaMcp.by_role, viaBulk.by_role);
});

// --- classifyRead: the guard that shipped wrong because nothing tested it ----

const cls = (lib, read, cap) => mod.classifyRead(lib, read, cap);

test("REGRESSION: a complete read at ANY size is complete, cap irrelevant", async () => {
  // 🛑 THE BUG. Elise's fun list read 379 of 379 — complete — and was reported
  // as clipped, because the cap branch ran BEFORE the completeness check and
  // compared against a stale 200. The message contradicted its own numbers in
  // the same sentence and then ordered a skip.
  assert.equal(cls(379, 379, 200).kind, "complete", "379 of 379 is complete");
  assert.equal(cls(223, 223, 200).kind, "complete", "223 of 223 is complete");
  assert.equal(cls(379, 379, 400).kind, "complete");
});

test("a complete read landing EXACTLY on the ceiling is still complete", async () => {
  // The case that fixing only the stale constant would have left broken: a
  // 400-track playlist read completely at a 400 ceiling. lib == read is the
  // definition of complete and must never consult the cap.
  assert.equal(cls(400, 400, 400).kind, "complete");
});

test("a genuinely clipped read is caught", async () => {
  const v = cls(500, 400, 400);
  assert.equal(v.kind, "clipped_by_cap");
  assert.match(v.message, /400-track ceiling/);
});

test("the clipped message does not claim unreachability it has not established", async () => {
  // §11.20. The old text asserted "the rest is unreachable", which was false —
  // the remainder was reachable with a higher ceiling, and on a complete read
  // there was no remainder at all.
  const v = cls(500, 400, 400);
  assert.doesNotMatch(v.message, /unreachable/);
  assert.match(v.message, /higher ceiling/, "must name the remedy that works");
});

test("a shortfall below the ceiling is recorded, not refused", async () => {
  const v = cls(108, 107, 400);   // Jazz songs Mix
  assert.equal(v.kind, "shortfall");
  assert.equal(v.shortfall, 1);
  assert.match(v.note, /everything obtainable/);
});

test("reading MORE than the library reports stops", async () => {
  assert.equal(cls(100, 101, 400).kind, "over_read");
});

test("the ceiling is only consulted when the read is SHORT", async () => {
  // The ordering, asserted directly: same read count, same cap, different
  // library totals — and only the short one is allowed to be a cap hit.
  assert.equal(cls(200, 200, 200).kind, "complete");
  assert.equal(cls(201, 200, 200).kind, "clipped_by_cap");
});
