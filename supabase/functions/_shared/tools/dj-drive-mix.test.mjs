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
  assert.equal(m.sliceOf(1970, "rock"), "1980s-and-earlier");
  assert.equal(m.sliceOf(1950, "rock"), "1980s-and-earlier");
  assert.equal(m.sliceOf(2000, "pop"), "1990s-2000s");
  assert.equal(m.sliceOf(2020, "pop"), "2010s-2020s");
  assert.equal(m.sliceOf(null, "pop"), null);
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
  const rows = [{ slice: "country_rap", video_id: VID(1), carried: true }, { slice: "fill", video_id: VID(2), carried: false }];
  const db = fakeDb(undefined, () => ({ data: rows, error: null }));
  const out = await m.getDriveMixPickTool.handler({ date: "2026-10-08", artist_cap: 3, cooldown_days: 0 }, { db });
  assert.deepEqual(db.rpcs[0], ["drive_mix_pick", { p_date: "2026-10-08", p_artist_cap: 3, p_cooldown_days: 0 }]);
  assert.equal(out.short_by, 48);
  assert.equal(out.carried_over, 1);
  assert.deepEqual(out.video_ids, [VID(1), VID(2)]);
  assert.deepEqual(out.slice_shortfalls.find((s) => s.slice === "country_rap"), { slice: "country_rap", quota: 6, filled: 1 });
});

test("cooldown_days is validated and the default quotas sum to 50", async () => {
  await assert.rejects(m.getDriveMixPickTool.handler({ cooldown_days: 31 }, { db: fakeDb() }), /0 to 30/);
  await assert.rejects(m.getDriveMixSimulationTool.handler({ cooldown_days: -1 }, { db: fakeDb() }), /0 to 30/);
  assert.equal(Object.values(m.DEFAULT_QUOTAS).reduce((a, b) => a + b, 0), 50);
});

test("quotas scale to any count by largest remainder", () => {
  const q50 = m.scaleQuotas(m.DEFAULT_QUOTAS, 50);
  assert.deepEqual(q50, m.DEFAULT_QUOTAS, "counts that sum to count are unchanged");
  const q170 = m.scaleQuotas(m.DEFAULT_QUOTAS, 170);
  // 20.4 / 34 / 40.8 / 74.8: the two .8s win the spare songs, earlier slice first.
  assert.deepEqual(q170, { country_rap: 20, "1980s-and-earlier": 34, "2010s-2020s": 41, "1990s-2000s": 75 });
  for (const n of [1, 7, 33, 199, 200]) {
    assert.equal(Object.values(m.scaleQuotas(m.DEFAULT_QUOTAS, n)).reduce((a, b) => a + b, 0), n, `count ${n}`);
  }
  assert.deepEqual(m.scaleQuotas({ country_rap: 1, "1990s-2000s": 1 }, 3), {
    country_rap: 2, "1980s-and-earlier": 0, "2010s-2020s": 0, "1990s-2000s": 1 });
});

test("simulation refuses more than 6,000 song-days before calling the database", async () => {
  const db = fakeDb(undefined, () => ({ data: { songs: [], artists: [] }, error: null }));
  await assert.rejects(m.getDriveMixSimulationTool.handler({ days: 120, count: 200 }, { db }), /24000 song-days.*Nothing was run/);
  await assert.rejects(m.getDriveMixSimulationTool.handler({ count: 101 }, { db }), /60 days x 101/);
  assert.equal(db.rpcs.length, 0);
  await m.getDriveMixSimulationTool.handler({ days: 60, count: 100 }, { db });
  await m.getDriveMixSimulationTool.handler({ days: 30, count: 200 }, { db });
  assert.equal(db.rpcs.length, 2);
});

test("artist cap defaults to ceil(count / 25)", () => {
  assert.deepEqual([1, 25, 26, 50, 170, 200].map(m.defaultArtistCap), [1, 1, 2, 2, 7, 8]);
});

test("a 170-song pick reports scaled quotas, the default cap and cooling fills", async () => {
  const rows = [{ slice: "fill", video_id: VID(1), carried: false, cooling: true }];
  const db = fakeDb(undefined, () => ({ data: rows, error: null }));
  const out = await m.getDriveMixPickTool.handler({ date: "2026-10-08", count: 170 }, { db });
  assert.deepEqual(db.rpcs[0], ["drive_mix_pick", { p_date: "2026-10-08", p_count: 170 }]);
  assert.equal(out.artist_cap_used, 7);
  assert.equal(out.quotas_used["1990s-2000s"], 75);
  assert.equal(out.cooling_used, 1);
  await assert.rejects(m.getDriveMixPickTool.handler({ count: 201 }, { db }), /1 to 200/);
  await assert.rejects(m.getDriveMixPickTool.handler({ quotas: { country_rap: 0 } }, { db }), /not all be zero/);
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

test("familiar params are validated and passed; the pick reports the new-song cap", async () => {
  const rows = [
    { slice: "country_rap", video_id: VID(1), familiar: true },
    { slice: "fill", video_id: VID(2), familiar: false, new_over_cap: true },
  ];
  const db = fakeDb(undefined, () => ({ data: rows, error: null }));
  const out = await m.getDriveMixPickTool.handler(
    { date: "2026-10-09", new_share: 0.3, familiar_days: 4, familiar_gap_days: 0 }, { db });
  assert.deepEqual(db.rpcs[0], ["drive_mix_pick",
    { p_date: "2026-10-09", p_new_share: 0.3, p_familiar_days: 4, p_familiar_gap_days: 0 }]);
  assert.equal(out.new_cap, 15);
  assert.equal(out.new_songs, 1);
  assert.equal(out.new_over_cap, 1);
  assert.equal(out.familiar_gap_days_used, 0);
  await assert.rejects(m.getDriveMixPickTool.handler({ new_share: 1.5 }, { db }), /0 to 1/);
  await assert.rejects(m.getDriveMixPickTool.handler({ familiar_days: 0 }, { db }), /1 to 365/);
  await assert.rejects(m.getDriveMixSimulationTool.handler({ familiar_gap_days: 61 }, { db }), /0 to 60/);
});

test("exempt slices and cooldown breaks are validated, passed and reported", async () => {
  const rows = [
    { slice: "1990s-2000s", video_id: VID(1), familiar: true, cooling: true },
    { slice: "fill", video_id: VID(2), familiar: false, cooling: true },
  ];
  const db = fakeDb(undefined, () => ({ data: rows, error: null }));
  const out = await m.getDriveMixPickTool.handler({
    date: "2026-10-09", familiar_slices_exempt: ["country_rap", "country_rap"], familiar_breaks_cooldown: false,
  }, { db });
  assert.deepEqual(db.rpcs[0], ["drive_mix_pick",
    { p_date: "2026-10-09", p_familiar_slices_exempt: ["country_rap"], p_familiar_breaks_cooldown: false }]);
  assert.equal(out.cooling_breaks, 1);
  assert.equal(out.familiar_breaks_cooldown_used, false);
  const dflt = await m.getDriveMixPickTool.handler({ date: "2026-10-09" }, { db });
  assert.deepEqual(dflt.familiar_slices_exempt_used, ["1980s-and-earlier"]);
  assert.equal(dflt.familiar_breaks_cooldown_used, true);
  await m.getDriveMixPickTool.handler({ familiar_slices_exempt: [] }, { db });
  assert.deepEqual(db.rpcs.at(-1)[1].p_familiar_slices_exempt, []);
  await assert.rejects(m.getDriveMixPickTool.handler({ familiar_slices_exempt: ["1970s"] }, { db }), /must be one of/);
  await assert.rejects(m.getDriveMixSimulationTool.handler({ familiar_slices_exempt: "1980s-and-earlier" }, { db }), /list of slices/);
  await assert.rejects(m.getDriveMixPickTool.handler({ familiar_breaks_cooldown: "yes" }, { db }), /true or false/);
});

test("new-song cap is floor(share x count), as the SQL computes it", () => {
  assert.deepEqual([[0.25, 50], [0.25, 170], [0.29, 100], [0, 50], [1, 7]].map(([s, n]) => m.newSongCap(s, n)),
    [12, 42, 29, 0, 7]);
});

test("parseThumbs keeps the latest thumb per song and refuses junk", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  const t = m.parseThumbs("t", [
    { video_id: VID(1), thumbs: "down", at: "2026-10-08T10:00:00Z" },
    { video_id: VID(1), thumbs: "up", at: "2026-10-09T09:00:00Z" },
    { video_id: VID(2), thumbs: "clear" },
  ], now);
  assert.deepEqual(t, [
    { video_id: VID(1), thumbs: "up", at: "2026-10-09T09:00:00.000Z" },
    { video_id: VID(2), thumbs: null, at: "2026-10-09T12:00:00.000Z" },
  ]);
  assert.throws(() => m.parseThumbs("t", [{ video_id: VID(1), thumbs: "meh" }], now), /thumbs must be one of/);
  assert.throws(() => m.parseThumbs("t", [{ video_id: VID(1), thumbs: "up", at: "2026-12-01" }], now), /not in the future/);
  assert.throws(() => m.parseThumbs("t", [], now), /1 to 200/);
});

test("update_drive_mix_thumbs: latest wins, up revives only Alex's cuts", async () => {
  const pool = [
    { id: ID(1), video_id: VID(1), title: "Honesty", status: "retired", retired_reason: "cut by Alex (not known)",
      decade: 1970, genre: "pop", thumbs: null, thumbs_at: null },
    { id: ID(2), video_id: VID(2), title: "Misty", status: "retired", retired_reason: "jazz",
      decade: null, genre: null, thumbs: null, thumbs_at: null },
    { id: ID(3), video_id: VID(3), title: "Vogue", status: "active", retired_reason: null,
      decade: 1990, genre: "pop", thumbs: "down", thumbs_at: "2026-10-09T08:00:00Z" },
  ];
  const db = fakeDb((t, ops) => has(ops, "update") ? { data: [{ id: "x" }], error: null } : { data: pool, error: null });
  const at = "2026-10-09T07:00:00Z";
  const out = await m.updateDriveMixThumbsTool.handler({ thumbs: [
    { video_id: VID(1), thumbs: "up", at }, { video_id: VID(2), thumbs: "up", at },
    { video_id: VID(3), thumbs: "up", at }, { video_id: VID(4), thumbs: "down", at },
  ] }, { db });
  const w = writes(db);
  assert.equal(w.length, 2);
  assert.deepEqual(has(w[0].ops, "update")[1],
    { thumbs: "up", thumbs_at: "2026-10-09T07:00:00.000Z", status: "active", retired_reason: null });
  assert.deepEqual(has(w[0].ops, "in")[2], [ID(1)]);
  assert.deepEqual(has(w[1].ops, "update")[1], { thumbs: "up", thumbs_at: "2026-10-09T07:00:00.000Z" });
  assert.deepEqual(has(w[1].ops, "in")[2], [ID(2)]);
  assert.match(has(w[1].ops, "or")[1], /thumbs_at\.lte\."2026-10-09T07:00:00\.000Z"/);
  assert.deepEqual(out.revived, [{ video_id: VID(1), title: "Honesty", status: "active" }]);
  assert.deepEqual(out.skipped.map((s) => s.video_id), [VID(3), VID(4)]);
  assert.match(out.skipped[0].reason, /older than/);
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
  assert.deepEqual(out.data.pool.by_thumbs, { up: 2, down: 2 });
  assert.deepEqual(Object.keys(out.data.pool.active_eligible_by_slice),
    ["country_rap", "1980s-and-earlier", "1990s-2000s", "2010s-2020s"]);
});
