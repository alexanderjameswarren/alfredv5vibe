// record_dj_album / get_dj_albums — the Jazz thread's memory.
//
//   node --test supabase/functions/_shared/tools/dj-albums.test.mjs
//
// ===========================================================================
// 🛑 THE WRITE IS THE PRODUCT, NOT A SIDE EFFECT.
// ===========================================================================
// The canon is knowledge the MODEL holds, not something the listening history
// contains. A session can suggest Mingus Ah Um with no idea it suggested it
// last week. These rows ARE the memory — so a suggestion that is not written is
// a suggestion a later session repeats, and the thread quietly stops working.
// ===========================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "dj-albums-"));

// Stub platform.ts and the shared resolver. The resolver has its own suite;
// what matters here is that this tool CALLS it rather than rolling a local one.
let resolverCalls = [];
const STUBS = [
  "const clampLimit = (n) => Math.min(n ?? 20, 50);",
  "const defineTool = (o) => o;",
].join("\n");
const RESOLVER_STUB = `
export const toTrackInput = (video_id, title, artists, album, duration_seconds) =>
  ({ video_id, title, artist: artists.join(", ") || null, album, duration_seconds,
     match_key: title.toLowerCase() });
export const resolveTrackIds = async (prepared) => {
  globalThis.__resolverCalls.push(prepared);
  return { idByVideoId: new Map(prepared.map((p) => [p.video_id, "t_" + p.video_id])) };
};
`;

let src = readFileSync(join(HERE, "dj-albums.ts"), "utf-8")
  .replace('import { clampLimit, defineTool } from "../platform.ts";', STUBS)
  .replace('import { resolveTrackIds, toTrackInput } from "./dj-tracks.ts";',
           'import { resolveTrackIds, toTrackInput } from "./resolver-stub.ts";');
if (src.includes("../platform.ts") || src.includes("./dj-tracks.ts")) {
  throw new Error("an import line changed — update the stubs in this test");
}
writeFileSync(join(dir, "resolver-stub.ts"), RESOLVER_STUB);
writeFileSync(join(dir, "probe.ts"), src);
globalThis.__resolverCalls = resolverCalls;
const mod = await import(pathToFileURL(join(dir, "probe.ts")).href);

const USER = "user-1";

function makeDb({ albums = [], albumTracks = [], rpc = null } = {}) {
  const tables = { dj_albums: albums, dj_album_tracks: albumTracks };
  let seq = 0;
  function builder(table) {
    const filters = [];
    let updates = null, inserts = null, deleting = false, single = false, maybe = false;
    const api = {
      select() { return api; },
      eq(c, v) { filters.push((r) => r[c] === v); return api; },
      delete() { deleting = true; return api; },
      update(v) { updates = v; return api; },
      insert(v) { inserts = Array.isArray(v) ? v : [v]; return api; },
      single() { single = true; return api; },
      maybeSingle() { maybe = true; return api; },
      then(resolve) {
        if (deleting) {
          const keep = tables[table].filter((r) => !filters.every((f) => f(r)));
          tables[table].length = 0;
          tables[table].push(...keep);
          return resolve({ data: null, error: null });
        }
        if (updates) {
          for (const r of tables[table].filter((r) => filters.every((f) => f(r)))) {
            Object.assign(r, updates);
          }
          return resolve({ data: null, error: null });
        }
        if (inserts) {
          const out = [];
          for (const r of inserts) {
            const full = { id: `alb-${++seq}`, user_id: USER, tags: [], ...r };
            tables[table].push(full);
            out.push(full);
          }
          return resolve({ data: single ? out[0] : out, error: null });
        }
        const hit = tables[table].filter((r) => filters.every((f) => f(r)));
        if (single || maybe) return resolve({ data: hit[0] ?? null, error: null });
        return resolve({ data: hit, error: null });
      },
    };
    return api;
  }
  return {
    from: (t) => builder(t),
    rpc: async (name, params) =>
      rpc ? { data: rpc(params), error: null }
          : { data: null, error: { message: `function public.${name} does not exist` } },
    _tables: tables,
  };
}

const ctx = (db) => ({ db, userId: USER });
const rec = (db, a) => mod.recordDjAlbumTool.handler(a, ctx(db));
const get = (db, a = {}) => mod.getDjAlbumsTool.handler(a, ctx(db));

const MINGUS = {
  title: "Mingus Ah Um",
  artist: "Charles Mingus",
  yt_album_id: "MPREb_mingus",
  tracks: [
    { video_id: "v1", title: "Better Git It in Your Soul", position: 1 },
    { video_id: "v2", title: "Goodbye Pork Pie Hat", position: 2 },
  ],
};

// --- the memory ------------------------------------------------------------

test("recording an album creates the row", async () => {
  const db = makeDb({ rpc: () => [{ tracks_total: 2, tracks_playable: 2, tracks_heard: 0 }] });
  const r = await rec(db, MINGUS);
  assert.equal(r.created, true);
});

test("an explicit 'proposed' stamps suggested_on server-side", async () => {
  const db = makeDb();
  await rec(db, { ...MINGUS, status: "proposed" });
  assert.equal(db._tables.dj_albums[0].suggested_on,
    new Date().toISOString().slice(0, 10));
});

test("a suggestion date cannot be back-dated by the caller", async () => {
  // ⚠️ The whole value of this column is that it records when the thread
  // ACTUALLY asked. A caller supplying it could back-date one and re-propose
  // an album it had just put forward.
  const db = makeDb();
  await rec(db, { ...MINGUS, status: "proposed", suggested_on: "2020-01-01" });
  assert.equal(db._tables.dj_albums[0].suggested_on,
    new Date().toISOString().slice(0, 10));
});

// --- status derivation: 'proposed' is an act, not a default ----------------

test("🛑 OMITTING status DERIVES 'known' FROM FULL COVERAGE", async () => {
  // Bewitched came back 13 of 13 heard and landed as 'proposed'. An album
  // finished in August is not an unanswered suggestion.
  const db = makeDb({
    rpc: () => [{ tracks_total: 13, tracks_playable: 13, tracks_heard: 13,
                  last_heard_on: "2026-08-28" }],
  });
  const r = await rec(db, MINGUS);
  assert.equal(r.status, "known");
  assert.equal(r.status_derived, true);
  assert.equal(db._tables.dj_albums[0].status, "known", "persisted, not just reported");
});

test("partial coverage derives 'queued' — a bookmark IS the acceptance", async () => {
  const db = makeDb({
    rpc: () => [{ tracks_total: 13, tracks_playable: 13, tracks_heard: 5 }],
  });
  const r = await rec(db, MINGUS);
  assert.equal(r.status, "queued");
});

test("🛑 'proposed' IS NEVER DERIVED — it asserts a conversation happened", async () => {
  // A BOOKMARK WAS NEVER PROPOSED. Seeding 21 bookmarks as 'proposed' would
  // claim the thread had asked about records it has never mentioned, and it
  // would then suggest him albums he already knows.
  for (const cov of [
    { tracks_total: 9, tracks_playable: 9, tracks_heard: 0 },
    { tracks_total: 9, tracks_playable: 9, tracks_heard: 9 },
    { tracks_total: 0, tracks_playable: 0, tracks_heard: 0 },
  ]) {
    const db = makeDb({ rpc: () => [cov] });
    const r = await rec(db, MINGUS);
    assert.notEqual(r.status, "proposed", JSON.stringify(cov));
  }
});

test("an EXPLICIT status is honoured and nothing is derived", async () => {
  let rpcCalled = false;
  const db = makeDb({ rpc: () => { rpcCalled = true; return []; } });
  const r = await rec(db, { ...MINGUS, status: "proposed" });
  assert.equal(r.status, "proposed");
  assert.equal(r.status_derived, false);
  assert.equal(rpcCalled, false, "no coverage lookup when the caller stated one");
});

test("coverage of zero playable tracks does not derive 'known'", async () => {
  // NEGATIVE CONTROL: 0 >= 0 is true, and an album with nothing measurable
  // would otherwise be marked finished on the strength of no evidence.
  const db = makeDb({ rpc: () => [{ tracks_total: 3, tracks_playable: 0, tracks_heard: 0 }] });
  const r = await rec(db, MINGUS);
  assert.equal(r.status, "queued");
});

test("re-recording the same yt_album_id UPDATES rather than duplicating", async () => {
  const db = makeDb({ rpc: () => [{ tracks_playable: 2, tracks_heard: 0 }] });
  await rec(db, MINGUS);
  const r = await rec(db, { ...MINGUS, status: "queued" });
  assert.equal(r.created, false);
  assert.equal(db._tables.dj_albums.length, 1);
  assert.equal(db._tables.dj_albums[0].status, "queued");
});

test("🛑 'dismissed' IS ACCEPTED — it is what stops an album returning", async () => {
  // Without it a declined album is indistinguishable from one never mentioned,
  // so the thread proposes it every week (§11.7, and §14.24 paid for this once
  // already with artist tags).
  const db = makeDb();
  const r = await rec(db, { ...MINGUS, status: "dismissed" });
  assert.equal(r.status, "dismissed");
});

test("an invented status is refused, and the message explains dismissed", async () => {
  const db = makeDb();
  await assert.rejects(
    () => rec(db, { ...MINGUS, status: "maybe" }),
    /must be one of proposed, queued, listening, known, dismissed/);
  await assert.rejects(
    () => rec(db, { ...MINGUS, status: "maybe" }),
    /comes back every week/);
});

// --- the coverage-honesty rule ---------------------------------------------

test("🛑 A TRACK WITH NO video_id IS STORED, NOT DROPPED", async () => {
  // (status omitted -> coverage lookup stubbed below)
  // THE ONE THAT CORRUPTS COVERAGE SILENTLY. YouTube omits videoId for
  // region-blocked tracks. Dropping them SHORTENS the album, so "3 of 9"
  // becomes "3 of 7" and it looks better covered than it is — a wrong answer
  // that reads as a right one, with no error anywhere.
  const db = makeDb({ rpc: () => [{ tracks_total: 3, tracks_playable: 2, tracks_heard: 0 }] });
  const r = await rec(db, {
    ...MINGUS,
    tracks: [...MINGUS.tracks, { video_id: null, title: "Blocked", position: 3 }],
  });
  assert.equal(r.tracks_recorded, 3, "the album is 3 tracks long");
  assert.equal(r.tracks_without_video_id, 1);
  assert.equal(db._tables.dj_album_tracks.length, 3);
  const blocked = db._tables.dj_album_tracks.find((t) => t.position === 3);
  assert.equal(blocked.video_id, null, "stored with a null id, not omitted");
});

test("only tracks WITH a video_id reach the resolver", async () => {
  resolverCalls.length = 0;
  const db = makeDb({ rpc: () => [{ tracks_playable: 2, tracks_heard: 0 }] });
  await rec(db, {
    ...MINGUS,
    tracks: [...MINGUS.tracks, { video_id: null, title: "Blocked", position: 3 }],
  });
  assert.equal(resolverCalls.length, 1);
  assert.deepEqual(resolverCalls[0].map((p) => p.video_id), ["v1", "v2"]);
});

test("it uses the SHARED resolver rather than a local one", async () => {
  // ⚠️ A second implementation would agree with record_dj_playlist until one of
  // them changed — §14.6, a rule living in two runtimes and drifting.
  resolverCalls.length = 0;
  await rec(makeDb({ rpc: () => [{ tracks_playable: 2, tracks_heard: 0 }] }), MINGUS);
  assert.equal(resolverCalls.length, 1, "resolveTrackIds must be called");
});

test("re-recording REPLACES the track list rather than appending", async () => {
  // An album's running order is a fact about the album, not an accumulation. A
  // corrected re-read must not leave the old rows behind.
  const db = makeDb({ rpc: () => [{ tracks_playable: 1, tracks_heard: 0 }] });
  await rec(db, MINGUS);
  await rec(db, { ...MINGUS, tracks: [{ video_id: "v9", title: "Only", position: 1 }] });
  assert.equal(db._tables.dj_album_tracks.length, 1);
  assert.equal(db._tables.dj_album_tracks[0].video_id, "v9");
});

// --- the read --------------------------------------------------------------

test("get_dj_albums counts albums whose totals are partly unmeasurable", async () => {
  // ⚠️ An album reading 7/7 with tracks_total 9 has two tracks nobody can
  // check. A reader told only "7 of 7" would believe it finished.
  const db = makeDb({
    rpc: () => [
      { title: "Full", tracks_total: 5, tracks_playable: 5, tracks_heard: 5 },
      { title: "Blocked", tracks_total: 9, tracks_playable: 7, tracks_heard: 7 },
    ],
  });
  const r = await get(db);
  assert.equal(r.data.albums_partly_unmeasurable, 1);
  assert.match(r.data.reading, /WHEN `tracks_total` EXCEEDS `tracks_playable`, SAY SO/);
});

test("the reading forbids a boolean and names the canonical-group caveat", async () => {
  const db = makeDb({ rpc: () => [] });
  const r = await get(db);
  assert.match(r.data.reading, /A FRACTION,\s+NEVER A BOOLEAN/);
  assert.match(r.data.reading, /measures the MUSIC rather than the RECORD/);
  assert.match(r.data.reading, /sat through this album as an album/);
});

test("a missing 024 is named, and stays retryable", async () => {
  await assert.rejects(
    () => get(makeDb()),
    (e) => {
      assert.match(e.message, /migration 024 has not been applied/);
      assert.ok(!/[Dd]o NOT retry/.test(e.message));
      return true;
    });
});

test("an invented status filter is refused", async () => {
  await assert.rejects(() => get(makeDb({ rpc: () => [] }), { status: "maybe" }),
    /must be one of/);
});
