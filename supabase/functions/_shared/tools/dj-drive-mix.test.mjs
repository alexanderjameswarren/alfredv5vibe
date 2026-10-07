// Handler tests for dj-drive-mix.ts.
//
// Run:
//   node --experimental-strip-types --test supabase/functions/_shared/tools/dj-drive-mix.test.mjs
//
// platform.ts is stubbed: defineTool returns its options, so handlers and
// propose are called directly with a fake ctx.db.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "drive-mix-"));
writeFileSync(join(dir, "platform.ts"), `
export const defineTool = (o) => o;
export const clampLimit = (n) => Math.min(n ?? 20, 50);
export const envelope = (data, meta = {}) => ({ data, meta });
export const describeDbError = (name, e) => name + " failed: " + e.message;
`);
const IMPORT = 'from "../platform.ts";';
const src = readFileSync(join(HERE, "dj-drive-mix.ts"), "utf-8");
if (!src.includes(IMPORT)) throw new Error("dj-drive-mix.ts import line changed — update this test.");
writeFileSync(join(dir, "dj-drive-mix.ts"), src.replace(IMPORT, 'from "./platform.ts";'));
const m = await import(pathToFileURL(join(dir, "dj-drive-mix.ts")).href);

const VID = (n) => `vid${String(n).padStart(8, "0")}`; // 11 chars
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * Fake ctx.db. `answer(table, ops)` returns the {data, error, count} for a
 * chain once it is awaited; ops is the list of [method, ...args] on that chain.
 * Every chain is logged in `chains`, every rpc in `rpcs`.
 */
function fakeDb(answer = () => ({ data: [], error: null }), rpcAnswer = () => ({ data: [], error: null })) {
  const chains = [];
  const rpcs = [];
  const from = (table) => {
    const ops = [];
    chains.push({ table, ops });
    const b = new Proxy({}, {
      get: (_t, k) => {
        if (k === "then") return (res, rej) => Promise.resolve(answer(table, ops)).then(res, rej);
        return (...a) => { ops.push([k, ...a]); return b; };
      },
    });
    return b;
  };
  return {
    chains, rpcs, from,
    rpc: (name, params) => { rpcs.push([name, params]); return Promise.resolve(rpcAnswer(name, params)); },
  };
}
const has = (ops, method) => ops.find((o) => o[0] === method);
const writes = (db) => db.chains.filter((c) => c.ops.some((o) => ["insert", "update", "delete", "upsert"].includes(o[0])));

test("sliceOf follows the picker's rules", () => {
  assert.equal(m.sliceOf(1990, "country"), "country_rap");
  assert.equal(m.sliceOf(1970, "rock"), "1960s-1980s");
  assert.equal(m.sliceOf(2000, "pop"), "1990s-2000s");
  assert.equal(m.sliceOf(2020, "pop"), "2010s-2020s");
  assert.equal(m.sliceOf(1950, "pop"), null);
});

test("parsers reject junk", () => {
  assert.throws(() => m.parseVideoId("t", "MPREb_abc"), /not a YouTube video id/);
  assert.throws(() => m.parseDecade("t", 1985), /ending in 0/);
  assert.throws(() => m.parseGenre("t", "jazz"), /genre must be/);
  assert.throws(() => m.parseDate("t", "date", "2026-02-30"), /YYYY-MM-DD/);
  assert.equal(m.parseDate("t", "date", "2026-10-07"), "2026-10-07");
});

test("create_drive_mix_songs: active only when tagged; skips repeats and pooled songs", async () => {
  const db = fakeDb((table, ops) =>
    has(ops, "insert") ? { data: has(ops, "insert")[1], error: null }
      : { data: [{ video_id: VID(2), status: "retired" }], error: null });
  const out = await m.createDriveMixSongsTool.handler({
    source: "artist_top",
    songs: [
      { video_id: VID(1), title: "Summer of '69", artist: "Bryan Adams", decade: 1980, genre: "rock" },
      { video_id: VID(2), title: "Run to You", artist: "Bryan Adams" },
      { video_id: VID(3), title: "Heaven", artist: "Bryan Adams", decade: 1980 },
      { video_id: VID(1), title: "Summer of '69", artist: "Bryan Adams" },
    ],
  }, { db });
  const inserted = has(writes(db)[0].ops, "insert")[1];
  assert.deepEqual(inserted.map((r) => [r.video_id, r.status, r.source]),
    [[VID(1), "active", "artist_top"], [VID(3), "pending", "artist_top"]]);
  assert.deepEqual(out.skipped, [
    { video_id: VID(1), reason: "repeated in this call" },
    { video_id: VID(2), reason: "already in the pool (retired)" },
  ]);
});

test("create_drive_mix_songs writes nothing on a bad song", async () => {
  const db = fakeDb();
  await assert.rejects(m.createDriveMixSongsTool.handler({ songs: [{ video_id: "x", title: "a", artist: "b" }] }, { db }), /video id/);
  await assert.rejects(m.createDriveMixSongsTool.handler({ songs: [] }, { db }), /1 to 50/);
  assert.equal(db.chains.length, 0);
});

test("update_drive_mix_songs: refusals", async () => {
  const db = fakeDb(() => ({ data: [{ id: ID(1), title: "A", decade: null, genre: "pop", status: "pending" }], error: null }));
  await assert.rejects(m.updateDriveMixSongsTool.handler({ ids: [ID(1)], retired_reason: "calm" }, { db }), /needs status 'retired'/);
  await assert.rejects(m.updateDriveMixSongsTool.handler({ ids: [ID(1)], status: "active" }, { db }), /without both decade and genre/);
  await assert.rejects(m.updateDriveMixSongsTool.handler({ ids: [ID(1), ID(2)], genre: "rock" }, { db }), /no pool song with id .*0002/);
  await assert.rejects(m.updateDriveMixSongsTool.handler({ ids: [ID(1)] }, { db }), /nothing to change/);
  assert.equal(writes(db).length, 0);
});

test("update_drive_mix_songs: activating with the missing tag clears retired_reason", async () => {
  const db = fakeDb(() => ({ data: [{ id: ID(1), title: "A", decade: null, genre: "pop", status: "retired" }], error: null }));
  await m.updateDriveMixSongsTool.handler({ ids: [ID(1)], decade: 1990, status: "active" }, { db });
  assert.deepEqual(has(writes(db)[0].ops, "update")[1], { decade: 1990, status: "active", retired_reason: null });
});

const ARTIST_SONGS = [
  { id: ID(1), title: "A", artist: "Bryan Adams", decade: 1980, genre: "rock", status: "active" },
  { id: ID(2), title: "B", artist: "Bryan Adams", decade: null, genre: null, status: "retired" },
  { id: ID(3), title: "C", artist: "Bryan Adams", decade: 1990, genre: "pop", status: "retired" },
];

test("update_drive_mix_artist propose lists the affected songs and writes nothing", async () => {
  const db = fakeDb(() => ({ data: ARTIST_SONGS, error: null }));
  const p = await m.updateDriveMixArtistTool.propose({ artist_key: " Bryan Adams ", action: "reactivate" }, { db });
  assert.match(p.text, /Reactivate 2 song\(s\) by 'bryan adams': 1 to active, 1 to pending/);
  assert.deepEqual(p.songs.map((s) => s.id), [ID(2), ID(3)]);
  assert.equal(writes(db).length, 0);
  await assert.rejects(m.updateDriveMixArtistTool.propose({ artist_key: "x", action: "retire" }, { db }), /retired_reason/);
});

test("update_drive_mix_artist retire skips songs already retired", async () => {
  const db = fakeDb((t, ops) => ({ data: has(ops, "update") ? [] : ARTIST_SONGS, error: null }));
  await m.updateDriveMixArtistTool.handler({ artist_key: "bryan adams", action: "retire", retired_reason: "test" }, { db });
  const w = writes(db);
  assert.equal(w.length, 1);
  assert.deepEqual(has(w[0].ops, "update")[1], { status: "retired", retired_reason: "test" });
  assert.deepEqual(has(w[0].ops, "in")[2], [ID(1)]);
});

test("get_drive_mix_pick passes the date and only the params given, and reports shortfalls", async () => {
  const rows = [{ slice: "country_rap", video_id: VID(1) }, { slice: "fill", video_id: VID(2) }];
  const db = fakeDb(undefined, () => ({ data: rows, error: null }));
  const out = await m.getDriveMixPickTool.handler({ date: "2026-10-08", artist_cap: 3 }, { db });
  assert.deepEqual(db.rpcs[0], ["drive_mix_pick", { p_date: "2026-10-08", p_artist_cap: 3 }]);
  assert.equal(out.short_by, 48);
  assert.deepEqual(out.video_ids, [VID(1), VID(2)]);
  assert.deepEqual(out.slice_shortfalls.find((s) => s.slice === "country_rap"), { slice: "country_rap", quota: 5, filled: 1 });
});

test("get_drive_mix_pick on an empty pool returns an empty list", async () => {
  const out = await m.getDriveMixPickTool.handler({}, { db: fakeDb() });
  assert.equal(out.returned, 0);
  assert.equal(out.short_by, 50);
});

test("get_drive_mix_simulation caps the lists and flags it", async () => {
  const songs = Array.from({ length: 30 }, (_, i) => ({ song_id: ID(i), served: 1 }));
  const db = fakeDb(undefined, () => ({ data: { days: 60, songs, artists: [] }, error: null }));
  const out = await m.getDriveMixSimulationTool.handler({ days: 60, limit: 10 }, { db });
  assert.deepEqual(db.rpcs[0], ["drive_mix_simulate", { p_days: 60 }]);
  assert.equal(out.data.songs.length, 10);
  assert.equal(out.data.songs_total, 30);
  assert.deepEqual(out.meta, { limit_applied: 10, truncated: true, total: 30 });
  await assert.rejects(m.getDriveMixSimulationTool.handler({ days: 121 }, { db }), /1 to 120/);
});

test("create_drive_mix_serving records the ids as given, in order", async () => {
  const db = fakeDb((table, ops) => {
    if (table === "drive_mix_servings" && !has(ops, "insert")) return { data: [], error: null };
    if (table === "drive_mix_songs") return { data: [
      { id: ID(1), video_id: VID(1), status: "active" }, { id: ID(2), video_id: VID(2), status: "active" }], error: null };
    return { data: null, error: null };
  });
  const out = await m.createDriveMixServingTool.handler({ date: "2026-10-08", video_ids: [VID(2), VID(1)] }, { db });
  const rows = has(writes(db)[0].ops, "insert")[1];
  assert.deepEqual(rows, [
    { served_on: "2026-10-08", position: 1, song_id: ID(2), video_id: VID(2) },
    { served_on: "2026-10-08", position: 2, song_id: ID(1), video_id: VID(1) },
  ]);
  assert.equal(out.recorded, 2);
});

test("create_drive_mix_serving refuses a second serving, a non-active song, and repeats", async () => {
  const taken = fakeDb((table) => ({ data: table === "drive_mix_servings" ? [{ id: "s" }] : [], error: null }));
  await assert.rejects(m.createDriveMixServingTool.handler({ date: "2026-10-08", video_ids: [VID(1)] }, { db: taken }), /already has a serving/);
  const retired = fakeDb((table) => ({ data: table === "drive_mix_songs" ? [{ id: ID(1), video_id: VID(1), status: "retired" }] : [], error: null }));
  await assert.rejects(m.createDriveMixServingTool.handler({ video_ids: [VID(1), VID(9)] }, { db: retired }),
    /Not: vid00000001 \(retired\), vid00000009 \(not in the pool\)/);
  await assert.rejects(m.createDriveMixServingTool.handler({ video_ids: [VID(1), VID(1)] }, { db: fakeDb() }), /repeats/);
  assert.equal(writes(taken).length + writes(retired).length, 0);
});

test("create_drive_mix_sweep reports the full count and flags a cut list", async () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: ID(i) }));
  const out = await m.createDriveMixSweepTool.handler({}, { db: fakeDb(undefined, () => ({ data: rows, error: null })) });
  assert.equal(out.data.added, 25);
  assert.equal(out.data.songs.length, 20);
  assert.deepEqual(out.meta, { limit_applied: 20, truncated: true, total: 25 });
});

test("get_drive_mix_songs filters by normalised artist_key and returns pool counts", async () => {
  const db = fakeDb((table, ops) => has(ops, "limit")
    ? { data: [{ id: ID(1) }], error: null, count: 3 }
    : { data: null, error: null, count: 2 });
  const out = await m.getDriveMixSongsTool.handler({ artist: "Bryan Adams", untagged: true, limit: 1 }, { db });
  const ops = db.chains[0].ops;
  assert.deepEqual(ops.filter((o) => o[0] === "eq"), [["eq", "artist_key", "bryan adams"]]);
  assert.deepEqual(has(ops, "or"), ["or", "decade.is.null,genre.is.null"]);
  assert.deepEqual(out.meta, { count: 1, limit_applied: 1, truncated: true, total: 3 });
  assert.deepEqual(out.data.pool.by_status, { pending: 2, active: 2, retired: 2 });
  assert.deepEqual(Object.keys(out.data.pool.active_eligible_by_slice),
    ["country_rap", "1960s-1980s", "1990s-2000s", "2010s-2020s", "fill_only"]);
});
