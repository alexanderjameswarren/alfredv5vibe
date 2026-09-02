// Handler tests for get_dj_concerts, update_dj_concert and record_dj_feedback.
//
// Run:
//   node --test supabase/functions/_shared/tools/dj-concerts.test.mjs
//
// Same approach as the sibling suites: read the real source, stub only its
// ../platform.ts import, import from a temp copy. No checked-in duplicate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUBS = [
  "const clampLimit = (n: number | undefined) => Math.min(n ?? 20, 50);",
  "const defineTool = (o: any) => o;",
].join("\n");

const dir = mkdtempSync(join(tmpdir(), "dj-concerts-"));
const src = readFileSync(join(HERE, "dj-concerts.ts"), "utf-8").replace(
  'import { defineTool, clampLimit } from "../platform.ts";', STUBS);
if (src.includes("../platform.ts")) {
  throw new Error("dj-concerts.ts import line changed — update the stub in this test.");
}
writeFileSync(join(dir, "probe.ts"), src);
const mod = await import(pathToFileURL(join(dir, "probe.ts")).href);

const TODAY = new Date().toISOString().slice(0, 10);
const PAST = "2024-01-01";
const FUTURE = "2099-01-01";

function makeDb(concerts = [], artists = [{ id: "art-1", name: "Weezer" }],
                opts = {}) {
  const tables = {
    dj_concerts: concerts.map((c, i) => ({
      id: c.id ?? `con-${i + 1}`, artist_id: "art-1", venue_id: null,
      tour_name: null, starts_on: null, ends_on: null, status: "screening",
      notes: null, created_at: "2026-01-01T00:00:00Z", ...c,
    })),
    dj_artists: artists,
    dj_feedback: [],
    // mode=undecided joins these. Empty by default so every existing test is
    // unaffected.
    dj_playlists: opts.playlists ?? [],
  };
  // dj_playlist_engagement, keyed by playlist id. Only the fields the handler
  // reads are stubbed; a missing key returns no row, which is the real
  // behaviour for a playlist with no members.
  const engagement = opts.engagement ?? {};
  let seq = 0;
  function builder(table) {
    const filters = [];
    let updates = null, inserts = null, single = false, maybe = false, lim = null;
    const api = {
      select() { return api; },
      eq(c, v) { filters.push((r) => r[c] === v); return api; },
      lt(c, v) { filters.push((r) => r[c] !== null && r[c] < v); return api; },
      gte(c, v) { filters.push((r) => r[c] !== null && r[c] >= v); return api; },
      lte(c, v) { filters.push((r) => r[c] !== null && r[c] <= v); return api; },
      is(c, v) { filters.push((r) => r[c] === v); return api; },
      in(c, v) { filters.push((r) => v.includes(r[c])); return api; },
      // PostgREST `.or("a.is.null,a.lt.X")`. Implemented for real, because a
      // fake that ignored it would pass a tool that never applied the filter —
      // and the whole point of 022 is a filter that must NOT drop nulls.
      or(expr) {
        const terms = expr.split(",").map((t) => {
          const [col, op, ...rest] = t.split(".");
          const val = rest.join(".");
          if (op === "is") return (r) => (val === "null" ? r[col] == null : r[col] === val);
          if (op === "lt") return (r) => r[col] != null && r[col] < val;
          if (op === "gte") return (r) => r[col] != null && r[col] >= val;
          throw new Error(`fake .or() does not implement op '${op}' — add it`);
        });
        filters.push((r) => terms.some((f) => f(r)));
        return api;
      },
      order() { return api; },
      limit(n) { lim = n; return api; },
      single() { single = true; return api; },
      maybeSingle() { maybe = true; return api; },
      update(v) { updates = v; return api; },
      insert(r) { inserts = Array.isArray(r) ? r : [r]; return api; },
      then(resolve) {
        if (updates) {
          const hit = tables[table].filter((r) => filters.every((f) => f(r)));
          for (const r of hit) Object.assign(r, updates);
          return resolve({ data: single ? hit[0] ?? null : hit, error: null });
        }
        if (inserts) {
          const out = [];
          for (const r of inserts) {
            const full = { id: `new-${++seq}`, user_id: "user-1",
                           occurred_on: TODAY, created_at: "now", ...r };
            tables[table].push(full);
            out.push(full);
          }
          return resolve({ data: single ? out[0] : out, error: null });
        }
        let hit = tables[table].filter((r) => filters.every((f) => f(r)));
        if (lim !== null) hit = hit.slice(0, lim);
        if (single || maybe) return resolve({ data: hit[0] ?? null, error: null });
        return resolve({ data: hit, error: null });
      },
    };
    return api;
  }
  return {
    from: (t) => builder(t),
    rpc: async (name, params) => {
      if (name !== "dj_playlist_engagement") {
        return { data: null, error: { message: `unstubbed rpc ${name}` } };
      }
      const ids = params.p_playlist_ids ?? [];
      return {
        data: ids.filter((id) => id in engagement)
                 .map((id) => ({ playlist_id: id, ...engagement[id] })),
        error: null,
      };
    },
    _tables: tables,
  };
}

const ctx = (db) => ({ db, userId: "user-1" });
const get = (db, a = {}) => mod.getDjConcertsTool.handler(a, ctx(db));
const upd = (db, a) => mod.updateDjConcertTool.handler(a, ctx(db));
const fb = (db, a) => mod.recordDjFeedbackTool.handler(a, ctx(db));

// --- get_dj_concerts --------------------------------------------------------

test("needs_status returns past shows still marked undecided", async () => {
  const db = makeDb([
    { id: "c1", starts_on: PAST, status: "screening" },
    { id: "c2", starts_on: PAST, status: "attended" },   // already answered
    { id: "c3", starts_on: FUTURE, status: "committed" }, // hasn't happened
  ]);
  const out = await get(db, { mode: "needs_status" });
  assert.deepEqual(out.concerts.map((c) => c.id), ["c1"]);
});

test("an UNDATED screening row is NOT a 'did you go?' — the watchlist is excluded", async () => {
  // ⚠️ The case that would break if the date filter ever coalesced starts_on to
  // a sentinel. Oasis and Black Eyed Peas are undated screening rows meaning
  // "worth seeing whenever they tour"; sweeping them into Section 1 would ask
  // whether Alex attended a show that was never scheduled.
  const db = makeDb([
    { id: "watch", starts_on: null, status: "screening" },
    { id: "past", starts_on: PAST, status: "screening" },
  ]);
  const out = await get(db, { mode: "needs_status" });
  assert.deepEqual(out.concerts.map((c) => c.id), ["past"]);
});

// --- mode=undecided, and decision_pending (added 016) ------------------------
//
// 🛑 THE 2026-09-02 RUN HAD NO FIELD FOR EITHER QUESTION AND ANSWERED BOTH BY
// HAND. That is what these tests pin.

test("undecided returns undated screening rows — the ones no other mode can see", async () => {
  const db = makeDb([
    { id: "oasis", starts_on: null, status: "screening" },
    { id: "bep", starts_on: null, status: "screening" },
    { id: "alanis", starts_on: null, status: "missed" },     // decided
    { id: "goo", starts_on: null, status: "rejected" },      // decided
    { id: "sp", starts_on: FUTURE, status: "screening" },    // dated — Section 2
    { id: "gone", starts_on: PAST, status: "screening" },    // needs_status
  ]);
  const out = await get(db, { mode: "undecided" });
  assert.deepEqual(out.concerts.map((c) => c.id).sort(), ["bep", "oasis"]);
});

test("undecided applies NO threshold — a warm watchlist row still appears", async () => {
  // 🛑 THE OASIS CASE, AND THE REASON THIS MODE EXISTS AT ALL.
  //
  // Oasis is one of the two rows §12.8 names, and it does NOT fire went_quiet:
  // two touch days inside the recent window keep it warm. The first run reached
  // for went_quiet anyway, found it false, and fell back to "runs low and
  // last_run_on old" with cutoffs chosen by eye that exist in no file.
  //
  // If anyone ever adds a filter here, this test is what fails.
  const db = makeDb(
    [{ id: "oasis", starts_on: null, status: "screening" }],
    undefined,
    {
      playlists: [{ id: "pl-oasis", name: "Oasis Concert", concert_id: "oasis" }],
      engagement: {
        "pl-oasis": {
          runs: 1, last_run_on: "2026-08-04", touch_days: 9,
          touch_days_recent: 2, last_touched_on: "2026-08-22", went_quiet: false,
        },
      },
    },
  );
  const out = await get(db, { mode: "undecided" });
  assert.equal(out.concerts.length, 1);
  assert.equal(out.concerts[0].went_quiet, false, "warm, and still surfaced");
  assert.equal(out.concerts[0].playlist_name, "Oasis Concert");
  assert.equal(out.concerts[0].runs, 1);
});

test("undecided sorts by quiet_for_days, so the coldest asks first", async () => {
  const db = makeDb(
    [
      { id: "oasis", starts_on: null, status: "screening" },
      { id: "bep", starts_on: null, status: "screening" },
    ],
    undefined,
    {
      playlists: [
        { id: "pl-oasis", name: "Oasis Concert", concert_id: "oasis" },
        { id: "pl-bep", name: "Black Eyed Peas Concert", concert_id: "bep" },
      ],
      engagement: {
        "pl-oasis": { runs: 1, last_touched_on: "2026-08-22", went_quiet: false },
        "pl-bep": { runs: 1, last_touched_on: "2026-07-11", went_quiet: true },
      },
    },
  );
  const out = await get(db, { mode: "undecided" });
  assert.deepEqual(out.concerts.map((c) => c.id), ["bep", "oasis"]);
});

test("a NEVER-touched playlist falls back to the row's age, not to a null", async () => {
  // ⚠️ NEGATIVE CONTROL FOR THE SORT KEY. A watchlist entry created long ago and
  // never played is the strongest case for asking. A null last_touched_on would
  // sort to whichever end the comparator happens to put NaN, which is silently
  // either "most urgent" or "invisible" depending on the engine.
  const db = makeDb(
    [
      { id: "never", starts_on: null, status: "screening",
        created_at: "2020-01-01T00:00:00Z" },
      { id: "recent", starts_on: null, status: "screening",
        created_at: "2026-01-01T00:00:00Z" },
    ],
    undefined,
    {
      playlists: [
        { id: "pl-never", name: "Never Concert", concert_id: "never" },
        { id: "pl-recent", name: "Recent Concert", concert_id: "recent" },
      ],
      engagement: {
        "pl-never": { runs: 0, last_touched_on: null, went_quiet: false },
        "pl-recent": { runs: 0, last_touched_on: null, went_quiet: false },
      },
    },
  );
  const out = await get(db, { mode: "undecided" });
  assert.deepEqual(out.concerts.map((c) => c.id), ["never", "recent"]);
  assert.equal(out.concerts[0].never_touched, true);
  assert.ok(out.concerts[0].quiet_for_days > out.concerts[1].quiet_for_days);
});

test("decision_pending fires on a DATED screening row that is still ahead", async () => {
  // 🛑 THE SMASHING PUMPKINS CASE. 2026-10-30, status screening, 58 days out on
  // 2026-09-02 — and nothing asked about it, because needs_status fires only
  // once the date has PASSED. The question surfaces on the first day it can no
  // longer be answered.
  const db = makeDb([{ id: "sp", starts_on: FUTURE, status: "screening" }]);
  const out = await get(db, { mode: "list" });
  assert.equal(out.concerts[0].decision_pending, true);
  assert.ok(out.concerts[0].days_until > 0);
});

test("decision_pending does NOT fire where the decision is already made", async () => {
  // The §11.7 control: a flag that fires on the normal case is worse than none.
  // Committed and past-screening rows must both stay quiet — the second is
  // needs_status's job and double-reporting it merges two questions.
  const db = makeDb([
    { id: "committed", starts_on: FUTURE, status: "committed" },
    { id: "past", starts_on: PAST, status: "screening" },
    { id: "watch", starts_on: null, status: "screening" },
  ]);
  const out = await get(db, { mode: "list" });
  const by = Object.fromEntries(out.concerts.map((c) => [c.id, c]));
  assert.equal(by.committed.decision_pending, false, "already committed");
  assert.equal(by.past.decision_pending, false, "that is needs_status's row");
  assert.equal(by.watch.decision_pending, false, "that is undecided's row");
});

test("the three screening questions never select the same row", async () => {
  // 🛑 §12.8 RECORDS THE FIRST RUN MERGING TWO OF THESE. The shared status word
  // is what does it, so the partition is asserted rather than described.
  const rows = [
    { id: "watch", starts_on: null, status: "screening" },
    { id: "ahead", starts_on: FUTURE, status: "screening" },
    { id: "gone", starts_on: PAST, status: "screening" },
  ];
  const undecided = await get(makeDb(rows), { mode: "undecided" });
  const needs = await get(makeDb(rows), { mode: "needs_status" });
  const listed = await get(makeDb(rows), { mode: "list" });
  const pending = listed.concerts.filter((c) => c.decision_pending).map((c) => c.id);

  assert.deepEqual(undecided.concerts.map((c) => c.id), ["watch"]);
  assert.deepEqual(needs.concerts.map((c) => c.id), ["gone"]);
  assert.deepEqual(pending, ["ahead"]);
});

test("an unknown mode is refused by name", async () => {
  await assert.rejects(
    () => get(makeDb([]), { mode: "quiet" }),
    /must be 'list', 'needs_status' or 'undecided'/,
  );
});

test("undated: true returns the watchlist, and `when` says undated", async () => {
  const db = makeDb([
    { id: "watch", starts_on: null, status: "screening" },
    { id: "past", starts_on: PAST, status: "attended" },
  ]);
  const out = await get(db, { undated: true });
  assert.deepEqual(out.concerts.map((c) => c.id), ["watch"]);
  assert.equal(out.concerts[0].when, "undated");
});

test("artist_name is joined in, so a row is legible without a second call", async () => {
  const db = makeDb([{ id: "c1", starts_on: PAST, status: "attended" }]);
  const out = await get(db, {});
  assert.equal(out.concerts[0].artist_name, "Weezer");
});

test("a bad status is refused with the vocabulary", async () => {
  await assert.rejects(() => get(makeDb(), { status: "maybe" }), /screening.*rejected/s);
});

// --- update_dj_concert ------------------------------------------------------

test("a status can be changed — the write that did not exist", async () => {
  const db = makeDb([{ id: "c1", starts_on: PAST, status: "screening" }]);
  const out = await upd(db, { concert_id: "c1", status: "attended" });
  assert.equal(out.concert.status, "attended");
  assert.deepEqual(out.changed.status, { from: "screening", to: "attended" });
});

test("a wrong date is CORRECTED, not duplicated", async () => {
  // Weezer's real case: 2026-10-15 was wrong, 2026-10-23 is right.
  const db = makeDb([{ id: "c1", starts_on: "2026-10-15", status: "committed" }]);
  const out = await upd(db, { concert_id: "c1", starts_on: "2026-10-23" });
  assert.equal(out.concert.starts_on, "2026-10-23");
  assert.equal(db._tables.dj_concerts.length, 1, "correcting must not add a row");
});

test("an unknown concert_id is refused and creates nothing", async () => {
  const db = makeDb([{ id: "c1" }]);
  await assert.rejects(
    () => upd(db, { concert_id: "nope", status: "attended" }),
    /will not create a row/,
  );
  assert.equal(db._tables.dj_concerts.length, 1);
});

test("omitting a field leaves it alone", async () => {
  const db = makeDb([
    { id: "c1", starts_on: PAST, status: "screening", tour_name: "Tour A" },
  ]);
  const out = await upd(db, { concert_id: "c1", status: "attended" });
  assert.equal(out.concert.tour_name, "Tour A", "a status-only update must not blank the rest");
  assert.equal(out.concert.starts_on, PAST);
});

test("validity is judged on the RESULTING row, not the patch", async () => {
  // ⚠️ The subtle one. The row is undated; the patch sets only a status. Judging
  // the patch alone would see no starts_on being written and allow it, leaving
  // an undated 'committed' row that migration 010's CHECK then rejects — with a
  // constraint name instead of an explanation.
  const db = makeDb([{ id: "c1", starts_on: null, status: "screening" }]);
  await assert.rejects(
    () => upd(db, { concert_id: "c1", status: "committed" }),
    (e) => {
      assert.match(e.message, /needs a `starts_on`/);
      assert.match(e.message, /screening/, "must name the status that IS valid undated");
      assert.doesNotMatch(e.message, /dj_concerts_undated_status/);
      return true;
    },
  );
});

test("undated screening stays allowed", async () => {
  const db = makeDb([{ id: "c1", starts_on: null, status: "interested" }]);
  // Can't be 'interested' undated in reality, but the row is a fixture; the
  // point is that moving TO screening while undated is fine.
  const out = await upd(db, { concert_id: "c1", status: "screening" });
  assert.equal(out.concert.status, "screening");
});

test("clearing starts_on under a dated-only status is refused", async () => {
  const db = makeDb([{ id: "c1", starts_on: FUTURE, status: "committed" }]);
  await assert.rejects(
    () => upd(db, { concert_id: "c1", starts_on: null }),
    /needs a `starts_on`/,
  );
});

test("ends_on with no starts_on is refused — the DB CHECK cannot catch it", async () => {
  const db = makeDb([{ id: "c1", starts_on: null, status: "attended" }]);
  await assert.rejects(
    () => upd(db, { concert_id: "c1", ends_on: "2026-10-20" }),
    /not a range/,
  );
});

test("an empty patch is refused rather than silently doing nothing", async () => {
  const db = makeDb([{ id: "c1" }]);
  await assert.rejects(() => upd(db, { concert_id: "c1" }), /nothing to change/);
});

test("'missed' surfaces feedback_owed and does NOT write it", async () => {
  // §13.3: the lingering want is a fact about the ARTIST. Surfaced so it is not
  // dropped, not written so a second write is never smuggled into a status
  // change.
  const db = makeDb([{ id: "c1", starts_on: PAST, status: "screening" }]);
  const out = await upd(db, { concert_id: "c1", status: "missed" });
  assert.ok(out.feedback_owed, "missed must flag the artist-level feedback");
  assert.equal(out.feedback_owed.suggested_call.sentiment, "curious");
  assert.equal(out.feedback_owed.suggested_call.artist_id, "art-1");
  assert.equal(db._tables.dj_feedback.length, 0, "it must NOT write the feedback row");
});

test("any other status does not flag feedback — a flag that always fires is ignored", async () => {
  const db = makeDb([{ id: "c1", starts_on: PAST, status: "screening" }]);
  const out = await upd(db, { concert_id: "c1", status: "attended" });
  assert.equal(out.feedback_owed, null);
});

// --- record_dj_feedback -----------------------------------------------------

test("records the Alanis case: curious against an artist", async () => {
  const db = makeDb();
  const out = await fb(db, {
    artist_id: "art-1", sentiment: "curious",
    note: "Missed them live; still want to see them.",
  });
  assert.equal(out.feedback.sentiment, "curious");
  assert.equal(out.subject, "artist_id");
  assert.equal(db._tables.dj_feedback.length, 1);
});

test("exactly one subject — zero is refused", async () => {
  await assert.rejects(() => fb(makeDb(), { sentiment: "like" }), /exactly ONE subject/);
});

test("exactly one subject — two is refused, and both are named", async () => {
  await assert.rejects(
    () => fb(makeDb(), { artist_id: "art-1", track_id: "t-1", sentiment: "like" }),
    /artist_id, track_id/,
  );
});

test("sentiment or note, but not neither", async () => {
  await assert.rejects(() => fb(makeDb(), { artist_id: "art-1" }), /sentiment.*note/s);
});

test("a note alone is enough", async () => {
  const db = makeDb();
  const out = await fb(db, { artist_id: "art-1", note: "Saw them at the Forum." });
  assert.equal(out.feedback.note, "Saw them at the Forum.");
});

test("an invented sentiment is refused, with 'curious' explained", async () => {
  // ⚠️ The negative control for NOT inventing a vocabulary. dj_feedback.sentiment
  // has carried love|like|neutral|dislike|curious since Block A, and the column
  // comment already described the missed-live case. A second vocabulary beside
  // a correct one would have been the mistake.
  await assert.rejects(
    () => fb(makeDb(), { artist_id: "art-1", sentiment: "wanting" }),
    /curious.*wanting more rather than having judged/s,
  );
});

test("source defaults to chat and is validated", async () => {
  const db = makeDb();
  const out = await fb(db, { artist_id: "art-1", sentiment: "love" });
  assert.equal(out.feedback.source, "chat");
  await assert.rejects(
    () => fb(db, { artist_id: "art-1", sentiment: "love", source: "telepathy" }),
    /weekly_review/,
  );
});

// --- reviewed_on: confirming makes a watchlist row go quiet (022) ---------
//
// 🛑 OASIS AND BLACK EYED PEAS FIRED TWICE WITH THE SAME ANSWER. A QUESTION that
// fires on the normal case is skipped exactly like a flag that does (§11.7), and
// Section 1b is the only place an undated screening row is ever seen.

const daysAgo = (n) =>
  new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

test("a row confirmed recently goes quiet; one confirmed long ago comes back", async () => {
  const db = makeDb([
    { id: "fresh", starts_on: null, status: "screening", reviewed_on: daysAgo(10) },
    { id: "stale", starts_on: null, status: "screening", reviewed_on: daysAgo(200) },
  ]);
  const out = await get(db, { mode: "undecided" });
  assert.deepEqual(out.concerts.map((c) => c.id), ["stale"]);
});

test("🛑 A NEVER-REVIEWED ROW ALWAYS SURFACES — null is not 'recently confirmed'", async () => {
  // ⚠️ THE BUG THIS GUARDS: `reviewed_on < cutoff` is NULL for an unreviewed row,
  // so a bare comparison DROPS it — silencing precisely the entries nobody has
  // ever been asked about. The same null-vs-zero distinction as everywhere else.
  const db = makeDb([
    { id: "never", starts_on: null, status: "screening", reviewed_on: null },
    { id: "fresh", starts_on: null, status: "screening", reviewed_on: daysAgo(3) },
  ]);
  const out = await get(db, { mode: "undecided" });
  assert.deepEqual(out.concerts.map((c) => c.id), ["never"]);
});

test("the quiet period is a parameter, not a literal", async () => {
  const db = makeDb([
    { id: "c1", starts_on: null, status: "screening", reviewed_on: daysAgo(40) },
  ]);
  assert.equal((await get(db, { mode: "undecided" })).returned, 0, "90 by default");
  assert.equal(
    (await get(db, { mode: "undecided", reviewed_within_days: 30 })).returned, 1,
    "a shorter window brings it back");
});

test("🛑 IT IS NOT A THRESHOLD ON INTEREST — a warm unreviewed row still surfaces", async () => {
  // §14.17: filtering mode=undecided on went_quiet is what made Oasis invisible.
  // 022 filters on whether the QUESTION WAS ANSWERED, which is a record of a
  // conversation rather than a guess about how much Alex cares. If anyone ever
  // reintroduces an engagement filter here, this is what fails.
  const db = makeDb(
    [{ id: "oasis", starts_on: null, status: "screening", reviewed_on: null }],
    undefined,
    {
      playlists: [{ id: "pl", name: "Oasis Concert", concert_id: "oasis" }],
      engagement: { pl: { runs: 1, touch_days: 9, touch_days_recent: 2,
                          last_touched_on: "2026-08-22", went_quiet: false } },
    },
  );
  const out = await get(db, { mode: "undecided" });
  assert.equal(out.returned, 1);
  assert.equal(out.concerts[0].went_quiet, false);
});

test("`reviewed: true` stamps today and changes NOTHING else", async () => {
  // Confirming is not a status change — "still interested" leaves the row
  // exactly as it was. So it must count as a patch on its own, or the only way
  // to record an answer would be to alter something the answer did not alter.
  const db = makeDb([{ id: "c1", starts_on: null, status: "screening" }]);
  const r = await upd(db, { concert_id: "c1", reviewed: true });
  const row = db._tables.dj_concerts[0];
  assert.equal(row.reviewed_on, new Date().toISOString().slice(0, 10));
  assert.equal(row.status, "screening", "status untouched");
  assert.equal(row.starts_on, null, "still undated");
  assert.ok(r.changed.reviewed_on, "the write is reported");
});

test("a review date cannot be back-dated by the caller", async () => {
  // ⚠️ A review happened when it happened. A caller supplying the date could
  // back-date one to silence a row it did not want to be asked about.
  const db = makeDb([{ id: "c1", starts_on: null, status: "screening" }]);
  await upd(db, { concert_id: "c1", reviewed: true, reviewed_on: "2020-01-01" });
  assert.equal(db._tables.dj_concerts[0].reviewed_on,
    new Date().toISOString().slice(0, 10));
});

test("an empty patch is still refused, and the message names `reviewed`", async () => {
  const db = makeDb([{ id: "c1", starts_on: null, status: "screening" }]);
  await assert.rejects(
    () => upd(db, { concert_id: "c1" }),
    /reviewed: true/);
});
