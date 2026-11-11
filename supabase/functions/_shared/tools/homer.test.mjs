// Handler tests for homer.ts.
//
// Run:
//   node --experimental-strip-types --test supabase/functions/_shared/tools/homer.test.mjs
//
// The real platform.ts and shared read run (test-platform.mjs); only defineTool is replaced. Invented data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTool, settingsFor, withSettings } from "./test-platform.mjs";

const m = await loadTool("homer.ts");

const SETTINGS = [
  settingsFor("homer_plans", ["id", "user_id", "version", "status", "instructions", "settings", "change_summary",
    "written_by", "supersedes_plan_id", "created_at", "ended_at"]),
  settingsFor("homer_readers", ["id", "user_id", "key", "name", "notes", "created_at"]),
  settingsFor("homer_devices", ["id", "user_id", "device_id", "family", "friendly_name", "reader_id", "proposed_reader_id",
    "owner_status", "owner_reason", "first_session", "last_session", "sessions", "hours", "created_at"]),
  settingsFor("homer_series", ["id", "user_id", "name", "series_asin", "author", "notes", "created_at"]),
  settingsFor("homer_books", ["id", "user_id", "asin", "title", "author", "series_id", "series_position", "created_at"]),
  settingsFor("homer_reads", ["id", "user_id", "book_id", "device_id", "reader_id", "started_on", "finished_on", "hours",
    "completion", "source", "import_key", "created_at"]),
  settingsFor("homer_taste_profiles", ["id", "user_id", "reader_id", "series_id", "description", "scores", "plan_id",
    "created_at", "updated_at"]),
  settingsFor("homer_genres", ["id", "user_id", "name", "description", "status", "sort_order", "archived_at", "created_at"]),
  settingsFor("homer_queue_items", ["id", "user_id", "genre_id", "reader_id", "kind", "title", "author", "asin", "why",
    "status", "position", "verified_on", "archived_at", "created_at"]),
];

const ALEX = "00000000-0000-4000-8000-0000000000a1";
const ELISE = "00000000-0000-4000-8000-0000000000e1";
const S1 = "00000000-0000-4000-8000-000000000051";
const S2 = "00000000-0000-4000-8000-000000000052";
const READERS = [{ id: ALEX, key: "alex" }, { id: ELISE, key: "elise" }];

/**
 * Fake db: tables[name] is what a chain on that table resolves to: rows, or a function of the chain's ops
 * ([[method, ...args]]) returning rows or { error }. rpcs[name] answers db.rpc. Every call is logged.
 */
function fakeDb({ tables = {}, rpcs = {} } = {}) {
  const calls = [];
  const db = {
    calls,
    from(table) {
      let single = false;
      const ops = [];
      const b = new Proxy({}, {
        get: (_t, k) => {
          if (k === "then") {
            const t = tables[table] ?? [];
            const got = typeof t === "function" ? t(ops) : t;
            if (got && !Array.isArray(got) && got.error) return (res) => res({ data: null, error: got.error });
            const rows = got ?? [];
            return (res) => res(single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null, count: rows.length });
          }
          return (...args) => {
            calls.push([table, k, ...args]);
            ops.push([k, ...args]);
            if (k === "maybeSingle" || k === "single") single = true;
            return b;
          };
        },
      });
      return b;
    },
    rpc(name, params) {
      calls.push(["rpc", name, params]);
      const r = rpcs[name];
      return Promise.resolve(typeof r === "function" ? r(params) : (r ?? { data: null, error: null }));
    },
  };
  return withSettings(db, SETTINGS);
}
const saw = (db, table, ...op) => db.calls.some((c) => c[0] === table && JSON.stringify(c.slice(1)) === JSON.stringify(op));

const READ_TOOLS = ["getHomerPlanTool", "getHomerReadersTool", "getHomerDevicesTool", "getHomerBooksTool",
  "searchHomerBooksTool", "getHomerSeriesTool", "getHomerReadsTool", "getHomerTasteProfilesTool", "getHomerGenresTool",
  "getHomerQueueTool", "getHomerQuietSeriesTool"];

test("all 11 read tools are tier 1 and declare tables", () => {
  for (const name of READ_TOOLS) {
    assert.equal(m[name].tier, 1, name);
    assert.equal(m[name].tables.writes.length, 0, name);
  }
});

test("get_homer_plan: the active plan, null before calibration, history newest version first", async () => {
  const plan = { id: "p1", status: "active", version: 2, settings: { scales: [] } };
  let db = fakeDb({ tables: { homer_plans: [plan] } });
  assert.deepEqual(await m.getHomerPlanTool.handler({}, { db }), { plan });
  assert.ok(saw(db, "homer_plans", "eq", "status", "active"));
  db = fakeDb();
  assert.deepEqual(await m.getHomerPlanTool.handler({}, { db }), { plan: null });
  db = fakeDb({ tables: { homer_plans: [plan] } });
  await m.getHomerPlanTool.handler({ history: true }, { db });
  assert.ok(saw(db, "homer_plans", "order", "version", { ascending: false }));
});

test("an unknown reader names the readers there are", async () => {
  const db = fakeDb({ tables: { homer_readers: READERS } });
  await assert.rejects(m.getHomerQueueTool.handler({ reader: "bob" }, { db }), /reader "bob" not found\. Readers: alex, elise/);
});

test("get_homer_series: verdict filter, paging, author always, books and taste profile on include", async () => {
  const rows = [
    { series_id: S1, series_name: "TEST Saga", verdict: "liked", is_default: true, books_finished: 3 },
    { series_id: S2, series_name: "TEST Other", verdict: "didnt_click", is_default: true, books_finished: 1 },
  ];
  const db = fakeDb({
    tables: {
      homer_readers: READERS,
      homer_series: [{ id: S1, author: "Jane Doe", notes: null }],
      homer_books: [{ id: "b1", asin: "BTEST00001", title: "One", author: "Jane Doe", series_id: S1, series_position: 1 }],
      homer_taste_profiles: [{ id: "t1", series_id: S1, description: "Light, funny.", scores: { tone: 1 } }],
    },
    rpcs: { homer_series_verdicts: { data: rows, error: null } },
  });
  const out = await m.getHomerSeriesTool.handler({ verdict: ["liked", "loved"], include: ["books", "taste_profile"] }, { db });
  assert.equal(out.data.length, 1);
  assert.equal(out.data[0].author, "Jane Doe");
  assert.equal(out.data[0].books[0].asin, "BTEST00001");
  assert.equal(out.data[0].taste_profile.description, "Light, funny.");
  assert.ok(db.calls.some((c) => c[0] === "rpc" && c[1] === "homer_series_verdicts" && c[2].p_reader_key === "alex"));
  assert.ok(saw(db, "homer_taste_profiles", "eq", "reader_id", ALEX));
  await assert.rejects(m.getHomerSeriesTool.handler({ include: ["shelf"] }, { db }), /include: unknown value "shelf"/);
});

test("get_homer_series: ids are series ids", async () => {
  const db = fakeDb({
    tables: { homer_readers: READERS, homer_series: [] },
    rpcs: { homer_series_verdicts: { data: [{ series_id: S1 }, { series_id: S2 }], error: null } },
  });
  const out = await m.getHomerSeriesTool.handler({ ids: [S2] }, { db });
  assert.deepEqual(out.data.map((r) => r.series_id), [S2]);
});

test("get_homer_reads: reader none, finished, and one or() for a date range", async () => {
  const db = fakeDb({ tables: { homer_readers: READERS, homer_reads: [{ id: "r1", book_id: "b1", reader_id: null }],
    homer_books: [{ id: "b1", asin: "BTEST00001", title: "One", series_id: S1 }], homer_series: [{ id: S1, name: "TEST Saga" }] } });
  const out = await m.getHomerReadsTool.handler({ reader: "none", finished: true, date_from: "2026-01-01" }, { db });
  assert.ok(saw(db, "homer_reads", "is", "reader_id", null));
  assert.ok(saw(db, "homer_reads", "not", "finished_on", "is", null));
  assert.ok(saw(db, "homer_reads", "or", "and(finished_on.gte.2026-01-01),and(finished_on.is.null,started_on.gte.2026-01-01)"));
  assert.equal(out.data[0].series_name, "TEST Saga");
  assert.equal(m.readRange("2026-01-01", "2026-02-01"),
    "and(finished_on.gte.2026-01-01,finished_on.lte.2026-02-01),and(finished_on.is.null,started_on.gte.2026-01-01,started_on.lte.2026-02-01)");
});

test("get_homer_reads: defaults to alex", async () => {
  const db = fakeDb({ tables: { homer_readers: READERS } });
  await m.getHomerReadsTool.handler({}, { db });
  assert.ok(saw(db, "homer_reads", "eq", "reader_id", ALEX));
});

test("get_homer_queue: live items by default, unsorted, and genre names", async () => {
  const db = fakeDb({ tables: { homer_readers: READERS,
    homer_queue_items: [{ id: "q1", genre_id: "g1", title: "TEST", position: 1 }], homer_genres: [{ id: "g1", name: "Urban" }] } });
  const out = await m.getHomerQueueTool.handler({}, { db });
  assert.ok(saw(db, "homer_queue_items", "is", "archived_at", null));
  assert.equal(out.data[0].genre_name, "Urban");
  await m.getHomerQueueTool.handler({ unsorted: true }, { db });
  assert.ok(saw(db, "homer_queue_items", "is", "genre_id", null));
  await assert.rejects(m.getHomerQueueTool.handler({ unsorted: true, genre_id: S1 }, { db }), /not both/);
});

test("get_homer_quiet_series: only_quiet keeps quiet liked series and tired ones past the gap", async () => {
  const rows = [
    { series_id: "a", verdict: "liked", is_quiet: true }, { series_id: "b", verdict: "loved", is_quiet: false },
    { series_id: "c", verdict: "tired", is_quiet: true, tired_gap_passed: false },
    { series_id: "d", verdict: "tired", is_quiet: true, tired_gap_passed: true },
  ];
  const db = fakeDb({ tables: { homer_readers: READERS }, rpcs: { homer_quiet_series: { data: rows, error: null } } });
  const all = await m.getHomerQuietSeriesTool.handler({}, { db });
  assert.equal(all.data.length, 4);
  const quiet = await m.getHomerQuietSeriesTool.handler({ only_quiet: true }, { db });
  assert.deepEqual(quiet.data.map((r) => r.series_id), ["a", "d"]);
});

test("search_homer_books: needs text or author; wildcards are matched literally", async () => {
  const db = fakeDb({ tables: { homer_books: [] } });
  await assert.rejects(m.searchHomerBooksTool.handler({}, { db }), /pass `text`/);
  await m.searchHomerBooksTool.handler({ text: "100%_done" }, { db });
  assert.ok(saw(db, "homer_books", "ilike", "title", "%100\\%\\_done%"));
});

test("get_homer_devices: owner status filter, reader keys attached", async () => {
  const db = fakeDb({ tables: { homer_readers: READERS,
    homer_devices: [{ id: "d1", device_id: "X", reader_id: null, proposed_reader_id: ELISE, owner_status: "proposed" }] } });
  const out = await m.getHomerDevicesTool.handler({ owner_status: "proposed" }, { db });
  assert.ok(saw(db, "homer_devices", "in", "owner_status", ["proposed"]));
  assert.equal(out.data[0].proposed_reader, "elise");
  assert.equal(out.data[0].reader, null);
  await assert.rejects(m.getHomerDevicesTool.handler({ owner_status: "maybe" }, { db }), /owner_status/);
});

test("get_homer_genres: live genres in sort order with their series", async () => {
  const db = fakeDb({ tables: { homer_genres: [{ id: "g1", name: "Urban", sort_order: 1 }],
    homer_genre_series: [{ genre_id: "g1", series_id: S1, is_example: true }], homer_series: [{ id: S1, name: "TEST Saga" }] } });
  const out = await m.getHomerGenresTool.handler({}, { db });
  assert.ok(saw(db, "homer_genres", "is", "archived_at", null));
  assert.deepEqual(out.data[0].series, [{ series_id: S1, name: "TEST Saga", is_example: true }]);
});

test("get_homer_taste_profiles: the reader's, with series names", async () => {
  const db = fakeDb({ tables: { homer_readers: READERS, homer_taste_profiles: [{ id: "t1", series_id: S1, reader_id: ELISE }],
    homer_series: [{ id: S1, name: "TEST Saga" }] } });
  const out = await m.getHomerTasteProfilesTool.handler({ reader: "elise" }, { db });
  assert.ok(saw(db, "homer_taste_profiles", "eq", "reader_id", ELISE));
  assert.equal(out.data[0].series_name, "TEST Saga");
});

// ===========================================================================
// Writes (s15b)
// ===========================================================================

const has = (ops, k) => ops.some((o) => o[0] === k);
const arg = (ops, k) => ops.find((o) => o[0] === k)?.[1];
const BOOK = "00000000-0000-4000-8000-0000000000b1";

test("write tiers: 3 at tier 1, 7 at tier 2, 2 at tier 3 with a propose", () => {
  for (const n of ["createHomerReadTool", "createHomerBookTool", "createHomerQueueItemsTool"]) assert.equal(m[n].tier, 1, n);
  for (const n of ["updateHomerDeviceTool", "updateHomerSeriesTool", "updateHomerReadTool", "updateHomerVerdictTool",
    "updateHomerTasteProfileTool", "updateHomerGenreTool", "updateHomerQueueItemTool"]) assert.equal(m[n].tier, 2, n);
  for (const n of ["createHomerPlanTool", "createHomerNeverTool"]) {
    assert.equal(m[n].tier, 3, n);
    assert.equal(typeof m[n].propose, "function", n);
  }
});

test("create_homer_read: unknown ASIN points to create_homer_book; an open read to update_homer_read", async () => {
  let db = fakeDb({ tables: { homer_readers: READERS, homer_books: [] } });
  await assert.rejects(m.createHomerReadTool.handler({ asin: "BTEST00001", started_on: "2026-11-01" }, { db }), /create_homer_book first/);
  db = fakeDb({ tables: { homer_readers: READERS, homer_books: [{ id: BOOK, title: "One" }],
    homer_reads: (ops) => (has(ops, "insert") ? [] : [{ id: "r9", source: "clip", started_on: "2026-10-01" }]) } });
  await assert.rejects(m.createHomerReadTool.handler({ asin: "BTEST00001", finished_on: "2026-11-01" }, { db }), /update_homer_read/);
  await assert.rejects(m.createHomerReadTool.handler({ asin: "BTEST00001" }, { db }), /started_on/);
  await assert.rejects(m.createHomerReadTool.handler({ asin: "B", started_on: "2026-11-02", finished_on: "2026-11-01" }, { db }), /before/);
});

test("create_homer_read: a chat finish is inserted with its key and reader", async () => {
  let inserted = null;
  const db = fakeDb({ tables: { homer_readers: READERS, homer_books: [{ id: BOOK, title: "One" }],
    homer_reads: (ops) => { if (has(ops, "insert")) { inserted = arg(ops, "insert"); return [inserted]; } return []; } } });
  await m.createHomerReadTool.handler({ asin: "BTEST00001", finished_on: "2026-11-01" }, { db });
  assert.deepEqual(inserted, { book_id: BOOK, reader_id: ALEX, started_on: null, finished_on: "2026-11-01", hours: null,
    source: "chat", import_key: "chat:2026-11-01:BTEST00001" });
});

test("create_homer_book: existing ASIN unchanged; new series needs a name; written through homer_import_batch", async () => {
  let db = fakeDb({ tables: { homer_books: [{ id: BOOK, asin: "BTEST00001" }] } });
  const same = await m.createHomerBookTool.handler({ asin: "BTEST00001", title: "One" }, { db });
  assert.equal(same.created, false);
  db = fakeDb({ tables: { homer_books: [], homer_series: [] } });
  await assert.rejects(m.createHomerBookTool.handler({ asin: "BTEST00002", title: "Two", series_asin: "BTESTS0009" }, { db }),
    /pass `series_name` too/);
  let batch = null;
  let n = 0;
  db = fakeDb({ tables: { homer_series: [], homer_books: () => (n++ === 0 ? [] : [{ id: BOOK, asin: "BTEST00002" }]) },
    rpcs: { homer_import_batch: (p) => { batch = p; return { data: { refused: [] }, error: null }; } } });
  const out = await m.createHomerBookTool.handler({ asin: "BTEST00002", title: "Two", author: "Jane Doe",
    series_asin: "BTESTS0009", series_name: "TEST Saga", series_position: 2 }, { db });
  assert.equal(out.created, true);
  assert.equal(batch.p_dry_run, false);
  assert.deepEqual(batch.p_batch.series, [{ name: "TEST Saga", series_asin: "BTESTS0009", author: "Jane Doe" }]);
  assert.equal(batch.p_batch.books[0].series_position, 2);
  db = fakeDb({ tables: { homer_series: [{ id: S1 }], homer_books: [] },
    rpcs: { homer_import_batch: { data: { refused: [{ kind: "books", key: "BTEST00003", reason: "a book needs asin and title" }] }, error: null } } });
  await assert.rejects(m.createHomerBookTool.handler({ asin: "BTEST00003", title: "Three", series_asin: "BTESTS0009" }, { db }),
    /refused: books BTEST00003/);
});

test("create_homer_queue_items: verified_on required, KU needs its date, positions appended per genre", async () => {
  let inserted = null;
  const db = fakeDb({ tables: { homer_readers: READERS,
    homer_queue_items: (ops) => { if (has(ops, "insert")) { inserted = arg(ops, "insert"); return inserted; } return [{ position: 7 }]; } } });
  await assert.rejects(m.createHomerQueueItemsTool.handler({ items: [{ title: "X" }] }, { db }), /verified_on/);
  await assert.rejects(m.createHomerQueueItemsTool.handler({ items: [{ title: "X", verified_on: "2026-11-10", on_kindle_unlimited: true }] },
    { db }), /ku_checked_on/);
  await m.createHomerQueueItemsTool.handler({ items: [
    { title: "A", verified_on: "2026-11-10", genre_id: S1 }, { title: "B", verified_on: "2026-11-10", genre_id: S1,
      on_kindle_unlimited: false, ku_checked_on: "2026-11-10" }] }, { db });
  assert.deepEqual(inserted.map((r) => r.position), [8, 9]);
  assert.equal(inserted[0].created_by, "claude");
  assert.equal(inserted[1].on_kindle_unlimited, false);
});

test("update_homer_device: one of propose/confirm; a confirmed device isn't re-proposed; confirm clears the proposal", async () => {
  let patch = null;
  const db = fakeDb({ tables: { homer_readers: READERS,
    homer_devices: (ops) => { if (has(ops, "update")) { patch = arg(ops, "update"); return [{ id: "d1", ...patch }]; }
      return [{ id: "d1", reader_id: ALEX, proposed_reader_id: null }]; } } });
  await assert.rejects(m.updateHomerDeviceTool.handler({ device_id: "X" }, { db }), /exactly one/);
  await assert.rejects(m.updateHomerDeviceTool.handler({ device_id: "X", propose_owner: "elise" }, { db }), /already confirmed as alex/);
  const out = await m.updateHomerDeviceTool.handler({ device_id: "X", confirm_owner: "elise", owner_reason: "Series continuity" }, { db });
  assert.deepEqual(patch, { reader_id: ELISE, proposed_reader_id: null, owner_reason: "Series continuity" });
  assert.equal(out.reader, "elise");
});

test("update_homer_series: availability checks, dated today when not given", async () => {
  let patch = null;
  const db = fakeDb({ tables: { homer_series: (ops) => { patch = arg(ops, "update"); return [{ id: S1, ...patch }]; } } });
  await assert.rejects(m.updateHomerSeriesTool.handler({ series_id: S1 }, { db }), /nothing to change/);
  await assert.rejects(m.updateHomerSeriesTool.handler({ series_id: S1, available_position: 8, upcoming_position: 8 }, { db }),
    /never already out/);
  await assert.rejects(m.updateHomerSeriesTool.handler({ series_id: S1, available_position: 0 }, { db }), /above 0/);
  await m.updateHomerSeriesTool.handler({ series_id: S1, available_position: 7, upcoming_position: 8,
    upcoming_release_date: "2026-12-30", availability_source: "Amazon series page" }, { db });
  assert.equal(patch.upcoming_release_date, "2026-12-30");
  assert.match(patch.availability_checked_on, /^\d{4}-\d{2}-\d{2}$/);
  await m.updateHomerSeriesTool.handler({ series_id: S1, notes: "Book 8 is a pre-order." }, { db });
  assert.equal(patch.availability_checked_on, undefined);
});

test("update_homer_read: the finish can't precede the start; export reads say the import resets them", async () => {
  const db = fakeDb({ tables: { homer_readers: READERS,
    homer_reads: (ops) => (has(ops, "update") ? [{ id: "r1", ...arg(ops, "update") }]
      : [{ id: "r1", source: "export", started_on: "2026-05-01", finished_on: null }]) } });
  const R = "00000000-0000-4000-8000-0000000000c1";
  await assert.rejects(m.updateHomerReadTool.handler({ read_id: R, finished_on: "2026-04-01" }, { db }), /before the start/);
  const out = await m.updateHomerReadTool.handler({ read_id: R, finished_on: "2026-06-01", completion: "manual" }, { db });
  assert.match(out.note, /next import re-run resets/);
  const reader = await m.updateHomerReadTool.handler({ read_id: R, reader: "elise" }, { db });
  assert.equal(reader.note, undefined);
});

test("update_homer_verdict: never refused, a stored never refused, otherwise set_by claude", async () => {
  let db = fakeDb({ tables: { homer_readers: READERS, homer_verdicts: [{ id: "v1", verdict: "never" }] } });
  await assert.rejects(m.updateHomerVerdictTool.handler({ series_id: S1, verdict: "never" }, { db }), /create_homer_never/);
  await assert.rejects(m.updateHomerVerdictTool.handler({ series_id: S1, verdict: "liked" }, { db }), /lift: true/);
  await assert.rejects(m.updateHomerVerdictTool.handler({ verdict: "liked" }, { db }), /exactly one/);
  let inserted = null;
  db = fakeDb({ tables: { homer_readers: READERS,
    homer_verdicts: (ops) => { if (has(ops, "insert")) { inserted = arg(ops, "insert"); return [inserted]; } return []; } } });
  await m.updateHomerVerdictTool.handler({ series_id: S1, verdict: "tired", note: "Burned out at book 10." }, { db });
  assert.deepEqual(inserted, { reader_id: ALEX, subject_kind: "series", series_id: S1, verdict: "tired", set_by: "claude",
    note: "Burned out at book 10." });
});

test("update_homer_taste_profile: scores need a plan and pass homer_scores_problem", async () => {
  let db = fakeDb({ tables: { homer_readers: READERS, homer_plans: [] } });
  await assert.rejects(m.updateHomerTasteProfileTool.handler({ series_id: S1, scores: { tone: 2 } }, { db }), /no Homer plan yet/);
  const plan = [{ settings: { scales: [{ key: "tone" }] } }];
  db = fakeDb({ tables: { homer_readers: READERS, homer_plans: plan },
    rpcs: { homer_scores_problem: { data: "tone must be between 1 and 5", error: null } } });
  await assert.rejects(m.updateHomerTasteProfileTool.handler({ series_id: S1, scores: { tone: 9 } }, { db }), /tone must be between 1 and 5/);
  let patch = null;
  db = fakeDb({ tables: { homer_readers: READERS, homer_plans: plan,
    homer_taste_profiles: (ops) => { if (has(ops, "update")) { patch = arg(ops, "update"); return [patch]; } return [{ id: "t1" }]; } },
    rpcs: { homer_scores_problem: { data: null, error: null } } });
  await m.updateHomerTasteProfileTool.handler({ series_id: S1, description: "Light.", scores: { tone: 1 } }, { db });
  assert.deepEqual(patch, { description: "Light.", scores: { tone: 1 } });
});

test("update_homer_genre: a new genre is proposed; a part-way failure says what was saved", async () => {
  let inserted = null;
  const ok = fakeDb({ tables: {
    homer_genres: (ops) => { if (has(ops, "insert")) { inserted = arg(ops, "insert"); return [{ id: "g1", ...inserted }]; } return []; },
    homer_genre_series: [{ series_id: S1, is_example: true }] } });
  const out = await m.updateHomerGenreTool.handler({ name: "Urban magic", series: [{ series_id: S1, is_example: true }] }, { db: ok });
  assert.equal(inserted.status, "proposed");
  assert.equal(out.series.length, 1);
  const bad = fakeDb({ tables: { homer_genres: [{ id: "g1", name: "Urban magic" }],
    homer_genre_series: (ops) => (has(ops, "upsert") ? { error: { code: "23503", message: "series not found" } } : []) } });
  await assert.rejects(m.updateHomerGenreTool.handler({ genre_id: S2, series: [{ series_id: S1 }] }, { db: bad }),
    /genre was saved \(id g1, "Urban magic"\), but its series were NOT/);
});

test("update_homer_queue_item: moves to a midpoint, refuses after and before together, drop archives", async () => {
  const others = [{ id: "a", position: 1 }, { id: "b", position: 2 }, { id: "c", position: 4 }];
  assert.equal(m.movePosition(others, "a", null), 1.5);
  assert.equal(m.movePosition(others, "c", null), 5);
  assert.equal(m.movePosition(others, null, "a"), 0);
  assert.equal(m.movePosition(others, null, "c"), 3);
  assert.throws(() => m.movePosition(others, "z", null), /not a live item/);
  let patch = null;
  const Q = "00000000-0000-4000-8000-0000000000d1";
  const db = fakeDb({ tables: { homer_queue_items: (ops) => {
    if (has(ops, "update")) { patch = arg(ops, "update"); return [patch]; }
    return has(ops, "neq") ? others : [{ id: Q, reader_id: ALEX, genre_id: "g1", position: 9 }]; } } });
  await assert.rejects(m.updateHomerQueueItemTool.handler({ item_id: Q, after_id: S1, before_id: S2 }, { db }), /not both/);
  await m.updateHomerQueueItemTool.handler({ item_id: Q, drop: true }, { db });
  assert.ok(patch.archived_at);
});

test("create_homer_plan: early refusal, change_summary when replacing, a readable diff, then the RPC", async () => {
  const active = { id: "p1", version: 1, instructions: "Old rules.", settings: { scales: [{ key: "tone", min: 1, max: 5 }],
    tired_gap_days: 180 } };
  const draft = { instructions: "New rules.", settings: { scales: [{ key: "tone", min: 1, max: 5 }, { key: "romance" }],
    tired_gap_days: 365 } };
  let db = fakeDb({ tables: { homer_plans: [active] }, rpcs: { homer_plan_settings_problem: { data: "scales must be an array", error: null } } });
  await assert.rejects(m.createHomerPlanTool.propose(draft, { db }), /settings refused: scales must be an array/);
  db = fakeDb({ tables: { homer_plans: [active] }, rpcs: { homer_plan_settings_problem: { data: null, error: null } } });
  await assert.rejects(m.createHomerPlanTool.propose(draft, { db }), /change_summary/);
  const p = await m.createHomerPlanTool.propose({ ...draft, change_summary: "Added romance; tired gap a year." }, { db });
  assert.equal(p.diff.replaces_version, 1);
  assert.deepEqual(p.diff.scales.added.map((s) => s.key), ["romance"]);
  assert.deepEqual(p.diff.settings, [{ key: "tired_gap_days", was: 180, now: 365 }]);
  assert.equal(p.diff.instructions_changed, true);
  db = fakeDb({ tables: { homer_plans: [active] },
    rpcs: { homer_plan_settings_problem: { data: null, error: null }, create_homer_plan: { data: { id: "p2", version: 2 }, error: null } } });
  const out = await m.createHomerPlanTool.handler({ ...draft, change_summary: "Added romance.", confirmed: true }, { db });
  assert.equal(out.plan.version, 2);
  assert.ok(db.calls.some((c) => c[1] === "create_homer_plan" && c[2].p_written_by === "claude" && c[2].p_change_summary === "Added romance."));
  assert.equal(m.planDiff(null, draft).first_plan, true);
});

test("create_homer_never: sets a never as alex; lifts one only with a replacing verdict", async () => {
  const series = [{ id: S1, name: "TEST Saga" }];
  let written = null;
  const verdicts = (existing) => (ops) => {
    if (has(ops, "insert") || has(ops, "update")) { written = arg(ops, "insert") ?? arg(ops, "update"); return [written]; }
    return existing ? [existing] : [];
  };
  let db = fakeDb({ tables: { homer_readers: READERS, homer_series: series, homer_verdicts: verdicts({ id: "v1", verdict: "tired" }) } });
  const p = await m.createHomerNeverTool.propose({ series_id: S1, note: "Never again." }, { db });
  assert.match(p.text, /Never suggest series "TEST Saga" to alex again \(was: tired\)/);
  await m.createHomerNeverTool.handler({ series_id: S1, note: "Never again.", confirmed: true }, { db });
  assert.deepEqual(written, { verdict: "never", set_by: "alex", note: "Never again." });
  await assert.rejects(m.createHomerNeverTool.handler({ series_id: S1, lift: true, verdict: "liked" }, { db }), /no never to lift/);

  db = fakeDb({ tables: { homer_readers: READERS, homer_series: series, homer_verdicts: verdicts({ id: "v1", verdict: "never" }) } });
  await assert.rejects(m.createHomerNeverTool.handler({ series_id: S1 }, { db }), /already a never/);
  await assert.rejects(m.createHomerNeverTool.handler({ series_id: S1, lift: true }, { db }), /replacing `verdict`/);
  await assert.rejects(m.createHomerNeverTool.handler({ series_id: S1, lift: true, verdict: "never" }, { db }), /replacing `verdict`/);
  const lp = await m.createHomerNeverTool.propose({ series_id: S1, lift: true, verdict: "tired" }, { db });
  assert.match(lp.text, /Lift the never on series "TEST Saga" for alex: it becomes "tired"/);
  await m.createHomerNeverTool.handler({ series_id: S1, lift: true, verdict: "tired", confirmed: true }, { db });
  assert.deepEqual(written, { verdict: "tired", set_by: "alex" });
});
