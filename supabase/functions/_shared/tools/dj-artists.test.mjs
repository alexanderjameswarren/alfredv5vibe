// Unit tests for dj-artists.ts — the Phase 7 gate.
//
//   node --experimental-strip-types --test supabase/functions/_shared/tools/dj-artists.test.mjs
//
// The table existed since Block A with NO TOOLS, so mbid could be neither read
// nor written. Everything in Phase 7 keys on it.

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

const dir = mkdtempSync(join(tmpdir(), "dj-artists-"));
const src = readFileSync(join(HERE, "dj-artists.ts"), "utf-8").replace(
  'import { clampLimit, defineTool } from "../platform.ts";', STUBS);
if (src.includes("../platform.ts")) throw new Error("import line changed — update this stub");
writeFileSync(join(dir, "probe.ts"), src);
const mod = await import(pathToFileURL(join(dir, "probe.ts")).href);

const USER = "user-1";
const VALID = "bd6893a0-1111-2222-3333-444455556666";   // 8-4-4-4-12

function makeDb(seed = []) {
  const rows = seed.map((r, i) => ({
    id: `a-${i + 1}`, user_id: USER, mbid: null, yt_channel_id: null,
    tags: [], notes: null, last_explored_at: null, ...r,
  }));
  let seq = rows.length;
  function builder() {
    const filters = [];
    let updates = null, inserts = null, single = false, lim = null, wantCount = false;
    let orderBy = null;
    const api = {
      select(_cols, opts = {}) { wantCount = opts.count === "exact"; return api; },
      ilike(col, v) { filters.push((r) => String(r[col]).toLowerCase() === String(v).toLowerCase()); return api; },
      is(col, v) { filters.push((r) => r[col] === v); return api; },
      eq(col, v) { filters.push((r) => r[col] === v); return api; },
      order(col, opts = {}) { orderBy = { col, asc: opts.ascending !== false }; return api; },
      limit(n) { lim = n; return api; },
      single() { single = true; return api; },
      maybeSingle() { single = true; return api; },
      update(v) { updates = v; return api; },
      insert(v) { inserts = v; return api; },
      then(resolve) {
        if (updates) {
          const hit = rows.filter((r) => filters.every((f) => f(r)));
          for (const r of hit) Object.assign(r, updates);
          return resolve({ data: single ? { ...hit[0] } : hit.map((r) => ({ ...r })), error: null });
        }
        if (inserts) {
          const full = { id: `a-${++seq}`, user_id: USER, mbid: null, yt_channel_id: null,
                         tags: [], notes: null, last_explored_at: null, ...inserts };
          rows.push(full);
          return resolve({ data: single ? { ...full } : [{ ...full }], error: null });
        }
        let out = rows.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }));
        // The count is of the MATCH, before the limit — that is what makes a
        // truncated read distinguishable from a complete one.
        const matched = out.length;
        if (orderBy) {
          out.sort((a, b) => {
            const x = a[orderBy.col], y = b[orderBy.col];
            if (x === y) return 0;
            return (x < y ? -1 : 1) * (orderBy.asc ? 1 : -1);
          });
        }
        if (lim != null) out = out.slice(0, lim);
        return resolve({ data: single ? (out[0] ?? null) : out, error: null,
                         count: wantCount ? matched : null });
      },
    };
    return api;
  }
  return { from: () => builder(), _rows: rows };
}

// The handler returns the house envelope; these assertions are about the payload.
const getEnvelope = (db, args) => mod.getDjArtistsTool.handler(args, { db, userId: USER });
const get = async (db, args) => (await getEnvelope(db, args)).data;
const put = (db, args) => mod.upsertDjArtistTool.handler(args, { db, userId: USER });

// ---------------------------------------------------------------------------

test("upsert CREATES an artist that does not exist", async () => {
  // Weezer's row was created as a side effect of create_dj_concert in phase 3a.
  // Nothing guarantees any other artist has one.
  const db = makeDb();
  const r = await put(db, { name: "Foo Fighters", mbid: VALID });
  assert.equal(r.created, true);
  assert.equal(r.artist.name, "Foo Fighters");
  assert.equal(r.artist.mbid, VALID);
});

test("upsert UPDATES an existing artist rather than duplicating", async () => {
  const db = makeDb([{ name: "Foo Fighters" }]);
  const r = await put(db, { name: "foo fighters", mbid: VALID });   // case-insensitive
  assert.equal(r.created, false);
  assert.equal(db._rows.length, 1, "must not create a second row");
  assert.deepEqual(r.changed.mbid, { from: null, to: VALID });
});

test("SETTING a missing mbid needs no flag; CHANGING one is REFUSED", async () => {
  // The asymmetry is the point. Filling a gap is routine. Replacing a value that
  // was already there means one of the two is wrong, and taking the newer
  // silently would repoint every future setlist read at a different band.
  const db = makeDb([{ name: "Foo Fighters", mbid: VALID }]);
  const other = "ffffffff-1111-2222-3333-444455556666";
  await assert.rejects(
    () => put(db, { name: "Foo Fighters", mbid: other }),
    /REFUSED/);
  assert.equal(db._rows[0].mbid, VALID, "nothing may be written on a refusal");

  const r = await put(db, { name: "Foo Fighters", mbid: other, replace_mbid: true });
  assert.equal(r.artist.mbid, other);
});

test("re-passing the SAME mbid is not a change and is allowed", async () => {
  const db = makeDb([{ name: "Foo Fighters", mbid: VALID }]);
  const r = await put(db, { name: "Foo Fighters", mbid: VALID, notes: "stadium tour" });
  assert.equal(r.artist.notes, "stadium tour");
  assert.equal(r.changed.mbid, undefined, "an unchanged field must not appear in changed");
});

test("a MALFORMED mbid is rejected here, not at setlist.fm", async () => {
  // A truncated id 404s upstream and reads as "this artist has no setlists" -
  // a different and much more misleading answer than "your id is wrong".
  const db = makeDb();
  for (const bad of ["bd6893a", "not-a-uuid", "bd6893a0-1111-2222-3333-44445555666"]) {
    await assert.rejects(
      () => put(db, { name: "Foo Fighters", mbid: bad }),
      /is not a MusicBrainz id/);
  }
  assert.equal(db._rows.length, 0, "nothing may be created on a rejected mbid");
});

test("missing_mbid finds exactly the artists setlist reads cannot reach", async () => {
  const db = makeDb([
    { name: "Foo Fighters", mbid: VALID },
    { name: "Weezer" },
    { name: "Oasis" },
  ]);
  const r = await get(db, { missing_mbid: true });
  assert.deepEqual(r.artists.map((a) => a.name).sort(), ["Oasis", "Weezer"]);
  assert.equal(r.without_mbid, 2);
});

test("NOT FOUND and NO MBID are different answers", async () => {
  // The distinction the `reading` text exists to force: an empty result means
  // the row does not exist, which needs a create - not an mbid lookup.
  const db = makeDb([{ name: "Weezer" }]);
  const absent = await get(db, { name: "Foo Fighters" });
  assert.equal(absent.returned, 0);
  assert.equal(absent.without_mbid, 0, "no rows means no rows lacking an mbid");

  const present = await get(db, { name: "Weezer" });
  assert.equal(present.returned, 1);
  assert.equal(present.without_mbid, 1);
});

test("name matching is exact, not fuzzy", async () => {
  // "Live" is a band. A LIKE '%name%' search would match it from half a dozen
  // unrelated rows - the same wrong-match class the mbid rule exists to stop.
  const db = makeDb([{ name: "Live" }, { name: "Live at Leeds" }]);
  const r = await get(db, { name: "Live" });
  assert.equal(r.returned, 1);
  assert.equal(r.artists[0].name, "Live");
});

// --- rename_to: an in-place rename, which is the only safe kind -------------
//
// Five artists need respelling before MusicBrainz resolves them (Killers ->
// The Killers, Motley Crue -> Mötley Crüe, and similar). Renaming by INSERTING
// the correct spelling would orphan every concert link, because
// dj_concerts.artist_id points at the id and not the name.

test("rename_to renames IN PLACE, keeping the id every concert points at", async () => {
  const db = makeDb([{ name: "Killers", mbid: null }]);
  const before = db._rows[0].id;
  const out = await put(db, { name: "Killers", rename_to: "The Killers" });
  assert.equal(out.artist.name, "The Killers");
  assert.equal(out.artist.id, before, "the id MUST survive — links hang off it");
  assert.equal(db._rows.length, 1, "a rename must not create a second row");
});

test("a rename can set the mbid in the same call", async () => {
  // The actual workflow: respell, then the MusicBrainz lookup resolves.
  const db = makeDb([{ name: "Motley Crue" }]);
  const out = await put(db, { name: "Motley Crue", rename_to: "Mötley Crüe", mbid: VALID });
  assert.equal(out.artist.name, "Mötley Crüe");
  assert.equal(out.artist.mbid, VALID);
});

test("renaming onto an EXISTING name is refused as a merge", async () => {
  // ⚠️ The unique index on (user_id, name) would refuse this anyway. Refusing it
  // here says WHY: two rows with their own concerts, mbid and feedback would
  // have to become one, and which survives is a decision nothing here can make.
  const db = makeDb([{ name: "Killers" }, { name: "The Killers" }]);
  await assert.rejects(
    () => put(db, { name: "Killers", rename_to: "The Killers" }),
    /MERGE, not a rename/,
  );
  assert.equal(db._rows.length, 2, "nothing written");
});

test("renaming an artist that does not exist is refused, not created", async () => {
  // Creating under the NEW name would look like a successful rename and leave
  // any concerts still pointing at the row that was meant to be fixed.
  const db = makeDb([]);
  await assert.rejects(
    () => put(db, { name: "Nobody", rename_to: "The Nobodies" }),
    /no artist by that name exists/,
  );
  assert.equal(db._rows.length, 0);
});

test("a case-only rename is allowed and does not self-collide", async () => {
  // The lookup is ilike, so "killers" already finds "Killers". A rename that
  // differs only in case must not see ITSELF as the occupying row.
  const db = makeDb([{ name: "the killers" }]);
  const out = await put(db, { name: "the killers", rename_to: "The Killers" });
  assert.equal(out.artist.name, "The Killers");
});

test("without rename_to the name is untouched — the path is opt-in", async () => {
  const db = makeDb([{ name: "Killers" }]);
  const out = await put(db, { name: "Killers", mbid: VALID });
  assert.equal(out.artist.name, "Killers");
});

// ---------------------------------------------------------------------------
// Silent truncation — the 2026-09-02 near-miss
// ---------------------------------------------------------------------------

test("a truncated artist list SAYS it was truncated", async () => {
  // 🛑 22 rows, default limit 20, and the old handler returned exactly 20 with
  // nothing in the payload to distinguish that from a complete answer. The
  // truncation note the house style defines (platform.ts) is raised from
  // meta.truncated, and this tool never set it.
  const names = Array.from({ length: 22 }, (_, i) => ({ name: `Artist ${String(i).padStart(2, "0")}` }));
  const env = await getEnvelope(makeDb(names), {});
  assert.equal(env.data.returned, 20);
  assert.equal(env.data.total, 22, "the caller must be able to see what it did not get");
  assert.equal(env.meta.truncated, true);
});

test("a complete artist list is NOT flagged truncated", async () => {
  // NEGATIVE CONTROL. A flag that fires on the normal case gets ignored, and
  // then it is worse than none (spec §11.7).
  const env = await getEnvelope(makeDb([{ name: "Weezer" }, { name: "Oasis" }]), {});
  assert.equal(env.data.returned, 2);
  assert.equal(env.data.total, 2);
  assert.equal(env.meta.truncated, undefined);
});

test("truncation drops the END OF THE ALPHABET, which is why it hid", async () => {
  // ⚠️ NOT A RANDOM SAMPLE. The list is ordered by name, so the rows lost are
  // the last ones alphabetically — on 2026-09-02 that was Weezer, whose mbid the
  // setlist diff needs, sitting one place past the cut after Styx.
  const names = [...Array.from({ length: 20 }, (_, i) => ({ name: `A${String(i).padStart(2, "0")}` })),
                 { name: "Styx" }, { name: "Weezer" }];
  const r = await get(makeDb(names), {});
  assert.equal(r.returned, 20);
  assert.ok(!r.artists.some((a) => a.name === "Weezer"),
    "fixture must reproduce the real cut, or the assertion below proves nothing");
  // And the escape hatch that does work, so the fix is not merely a warning.
  const byName = await get(makeDb(names), { name: "Weezer" });
  assert.equal(byName.returned, 1);
});

// ---------------------------------------------------------------------------
// record_dj_artist_tag — the write that turns twelve seeded rows into a system
// ---------------------------------------------------------------------------
//
// 🛑 THIS TOOL WRITES A DIFFERENT TABLE FROM EVERYTHING ELSE IN THIS FILE.
// `dj_artists.name` is an mbid-keyed IDENTITY; `dj_artist_tags.artist` is a
// MATCH KEY — the exact dj_tracks.artist string, scraped bylines and all. They
// share a file and nothing else, and the tests below exist partly to keep that
// true.

function makeTagDb({ tracks = [], playlists = [], members = [], tags = [] } = {}) {
  const tables = {
    dj_tracks: tracks,
    dj_playlists: playlists,
    dj_playlist_tracks: members,
    dj_artist_tags: tags,
  };
  function builder(table) {
    const filters = [];
    let upserts = null, wantCount = false, head = false, lim = null;
    const orders = [];
    const api = {
      select(_cols, opts = {}) {
        wantCount = opts.count === "exact";
        head = Boolean(opts.head);
        return api;
      },
      eq(c, v) { filters.push((r) => r[c] === v); return api; },
      in(c, v) { filters.push((r) => v.includes(r[c])); return api; },
      // Multiple .order() calls compose, as PostgREST does — the read tool
      // relies on rejections sorting before active rows.
      order(c, opts = {}) { orders.push({ c, asc: opts.ascending !== false }); return api; },
      limit(n) { lim = n; return api; },
      upsert(v) { upserts = Array.isArray(v) ? v : [v]; return api; },
      then(resolve) {
        if (upserts) {
          const out = [];
          for (const raw of upserts) {
            // ⚠️ THE FAKE APPLIES THE COLUMN DEFAULT, BECAUSE THE REAL TABLE
            // DOES. dj_artist_tags.user_id defaults to auth.uid() (018), so the
            // tool deliberately does NOT send one. A fake that let the row
            // through without an owner would pass a tool that had forgotten it.
            assert.ok(
              !("user_id" in raw),
              "the tool must not send user_id — the DB default owns that",
            );
            const row = { user_id: USER, ...raw };
            // Real upsert semantics on (user_id, artist, tag) — the tool relies
            // on a second call REPLACING the first, which is how a rejection
            // reverses an approval without a hard delete.
            const i = tables[table].findIndex(
              (r) => r.user_id === row.user_id && r.artist === row.artist &&
                     r.tag === row.tag);
            if (i >= 0) tables[table][i] = { ...tables[table][i], ...row };
            else tables[table].push({ ...row });
            out.push({ ...row });
          }
          return resolve({ data: out, error: null });
        }
        let out = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        // ⚠️ COUNT IS OF THE MATCH, BEFORE THE LIMIT. That is what makes a
        // truncated read distinguishable from a complete one.
        const matched = out.length;
        for (const o of [...orders].reverse()) {
          out = out.slice().sort((a, b) => {
            const x = a[o.c], y = b[o.c];
            if (x === y) return 0;
            return (x < y ? -1 : 1) * (o.asc ? 1 : -1);
          });
        }
        if (lim !== null) out = out.slice(0, lim);
        return resolve({
          data: head ? null : out,
          error: null,
          count: wantCount ? matched : null,
        });
      },
    };
    return api;
  }
  return { from: (t) => builder(t), _tables: tables };
}

const tagCtx = (db) => ({ db, userId: USER });
const tagIt = (db, a) => mod.recordDjArtistTagTool.handler(a, tagCtx(db));

const JAZZ_DB = () => makeTagDb({
  tracks: [
    { id: "t1", artist: "Thelonious Monk" },
    { id: "t2", artist: "Eddie Higgins Trio" },
    { id: "t3", artist: "Harrison" },
    { id: "t4", artist: "Art Blakey" },     // in the jazz playlist
    { id: "t5", artist: "Weezer" },
  ],
  playlists: [{ id: "pl-jazz", kind: "jazz" }, { id: "pl-rock", kind: "concert" }],
  members: [{ playlist_id: "pl-jazz", track_id: "t4" },
            { playlist_id: "pl-rock", track_id: "t5" }],
});

test("it is tier 2 — it updates existing rows and never hard-deletes", () => {
  // Tier 1 is for appends to append-only tables. Flipping a tag to 'rejected'
  // is an UPDATE, so tier 2 with the audit log and rollback behind it. And an
  // append-only version would be the wrong tool anyway: a curated allowlist
  // that cannot be un-curated is not curated (§14.7, §14.9).
  assert.equal(mod.recordDjArtistTagTool.tier, 2);
});

test("tags several artists in one call — one approval, one write", async () => {
  const db = JAZZ_DB();
  const r = await tagIt(db, { artists: ["Thelonious Monk", "Eddie Higgins Trio"] });
  assert.equal(r.written, 2);
  assert.equal(r.tag, "jazz");
  assert.equal(db._tables.dj_artist_tags.length, 2);
  assert.ok(db._tables.dj_artist_tags.every((t) => t.status === "active"));
});

test("🛑 AN UNKNOWN ARTIST STRING IS REFUSED AND NOTHING IS WRITTEN", async () => {
  // THE TYPO GUARD. Every tag arm is an exact string match on dj_tracks.artist,
  // so "Eddie Higgins" against data saying "Eddie Higgins Trio" inserts
  // cleanly, matches nothing, and leaves the report wrong in exactly the
  // direction §14.13 was about — while the write reports success.
  const db = JAZZ_DB();
  await assert.rejects(
    () => tagIt(db, { artists: ["Thelonious Monk", "Eddie Higgins"] }),
    (e) => {
      assert.match(e.message, /"Eddie Higgins"/);
      assert.match(e.message, /NOTHING WAS WRITTEN/);
      return true;
    },
  );
  // ⚠️ NOT EVEN THE VALID ONE. A partial write would look like a decision not
  // to tag the rest, which is a worse answer than the refusal.
  assert.equal(db._tables.dj_artist_tags.length, 0);
});

test("source is DERIVED, never taken from the caller", async () => {
  // ⚠️ A caller asserting provenance could launder a guess into a fact, which
  // is the one thing `source` exists to prevent. Art Blakey is on a track in a
  // kind='jazz' playlist, so tagging him is migration 013's arm — a fact.
  // Thelonious Monk is in no playlist, so he is a judgement.
  const db = JAZZ_DB();
  const r = await tagIt(db, {
    artists: ["Art Blakey", "Thelonious Monk"],
    source: "manual",          // ignored on purpose
  });
  const by = Object.fromEntries(r.tags.map((t) => [t.artist, t]));
  assert.equal(by["Art Blakey"].source, "playlist", "a fact, not a judgement");
  assert.equal(by["Thelonious Monk"].source, "manual");
  assert.equal(r.facts, 1);
  assert.equal(r.judgements, 1);
});

test("a kind that does not match the tag does NOT make an artist derivable", async () => {
  // NEGATIVE CONTROL for the rule above. Weezer is in a kind='concert'
  // playlist; tagging him jazz would be a judgement (a wrong one), never a fact.
  const db = JAZZ_DB();
  const r = await tagIt(db, { artists: ["Weezer"] });
  assert.equal(r.tags[0].source, "manual");
});

test("🛑 A REJECTION IS A DECISION, AND IT IS RECORDED RATHER THAN DELETED", async () => {
  // Without this state, saying no to a proposed artist leaves no trace and the
  // report proposes him again next week and every week after — §11.7, a signal
  // that fires on the normal case gets ignored. 'Harrison' is the live case:
  // 4 distinct days, possibly a scraped byline (§14.9).
  const db = JAZZ_DB();
  const r = await tagIt(db, {
    artists: ["Harrison"], status: "rejected",
    note: "Scraped byline, not an artist.",
  });
  assert.equal(r.tags[0].status, "rejected");
  assert.equal(db._tables.dj_artist_tags.length, 1, "the row EXISTS — that is the point");
  assert.match(db._tables.dj_artist_tags[0].note, /Scraped byline/);
});

test("a decision reverses in place, so nothing is ever hard-deleted", async () => {
  const db = JAZZ_DB();
  await tagIt(db, { artists: ["Harrison"], status: "rejected" });
  await tagIt(db, { artists: ["Harrison"], status: "active", note: "It is a band." });
  assert.equal(db._tables.dj_artist_tags.length, 1, "upserted, not duplicated");
  assert.equal(db._tables.dj_artist_tags[0].status, "active");
});

test("an invented status is refused, and the message explains what rejected MEANS", async () => {
  const db = JAZZ_DB();
  await assert.rejects(
    () => tagIt(db, { artists: ["Harrison"], status: "maybe" }),
    /must be 'active' or 'rejected'/,
  );
  await assert.rejects(
    () => tagIt(db, { artists: ["Harrison"], status: "maybe" }),
    /decision, not a deletion/,
  );
});

test("no artists at all is refused rather than silently writing nothing", async () => {
  await assert.rejects(() => tagIt(JAZZ_DB(), {}), /pass `artists`/);
  await assert.rejects(() => tagIt(JAZZ_DB(), { artists: [] }), /pass `artists`/);
});

test("a single `artist` string works, and the batch is capped", async () => {
  const db = JAZZ_DB();
  const r = await tagIt(db, { artist: "Thelonious Monk" });
  assert.equal(r.written, 1);
  await assert.rejects(
    () => tagIt(db, { artists: Array(51).fill("Thelonious Monk") }),
    /the cap is 50/,
  );
});

// ---------------------------------------------------------------------------
// get_dj_artist_tags — the review surface (added 019)
// ---------------------------------------------------------------------------
//
// 🛑 A CURATED LIST YOU CANNOT READ IS A WRITE-ONLY LIST. Before this, tags were
// visible only THROUGH dj_artist_activity, which shows artists PLAYED IN THE
// WINDOW — 25 of the 87 tagged. Rejections, the one state whose entire purpose
// is to be remembered, had no reader at all.

const readTags = (db, a = {}) =>
  mod.getDjArtistTagsTool.handler(a, tagCtx(db));

const TAGGED_DB = () => makeTagDb({
  tags: [
    { user_id: USER, artist: "Thelonious Monk", tag: "jazz", status: "active",
      source: "manual", note: null },
    { user_id: USER, artist: "Art Blakey", tag: "jazz", status: "active",
      source: "playlist", note: null },
    { user_id: USER, artist: "Harrison", tag: "jazz", status: "rejected",
      source: "manual", note: "Scraped byline, not an artist." },
    { user_id: USER, artist: "Weezer", tag: "jazz", status: "rejected",
      source: "manual", note: "Not jazz." },
  ],
});

test("it is tier 1 — a read cannot change anything", () => {
  assert.equal(mod.getDjArtistTagsTool.tier, 1);
});

test("REJECTIONS SORT FIRST — they are the rows nothing else can show", async () => {
  // ⚠️ Burying them under 87 active tags would leave them as invisible as they
  // were before the tool existed, which is the entire problem it solves.
  const r = await readTags(TAGGED_DB());
  assert.equal(r.data.tags[0].status, "rejected");
  assert.equal(r.data.tags[1].status, "rejected");
  assert.equal(r.data.total, 4);
});

test("a rejection carries its REASON, which is the whole point of keeping it", async () => {
  const r = await readTags(TAGGED_DB(), { status: "rejected" });
  const harrison = r.data.tags.find((t) => t.artist === "Harrison");
  assert.match(harrison.note, /Scraped byline/);
  assert.equal(r.data.returned, 2);
});

test("filters by status and source, and reports which were applied", async () => {
  const active = await readTags(TAGGED_DB(), { status: "active" });
  assert.equal(active.data.returned, 2);
  assert.equal(active.data.filters.status, "active");

  const derived = await readTags(TAGGED_DB(), { source: "playlist" });
  assert.deepEqual(derived.data.tags.map((t) => t.artist), ["Art Blakey"]);
  assert.equal(derived.data.filters.source, "playlist");
});

test("the count is of the MATCH, so a short read announces itself", async () => {
  // §14.5's shape arriving through a different door: "I have tagged 2 artists"
  // when the answer is 4 is a wrong answer, not a short one.
  const r = await readTags(TAGGED_DB(), { limit: 2 });
  assert.equal(r.data.returned, 2);
  assert.equal(r.data.total, 4);
  assert.equal(r.data.truncated, true);
  assert.equal(r.meta.truncated, true);
});

test("an invented status is refused, and the message explains why BOTH is the default", async () => {
  await assert.rejects(
    () => readTags(TAGGED_DB(), { status: "maybe" }),
    /must be 'active' or 'rejected'/,
  );
  await assert.rejects(
    () => readTags(TAGGED_DB(), { status: "maybe" }),
    /Omit it to see both/,
  );
});

test("the reading keeps this apart from the listening report", async () => {
  // 🛑 §14.19 HAPPENED BECAUSE TWO SURFACES ANSWERED OVERLAPPING QUESTIONS. This
  // one answers "what is on the list"; get_dj_plays mode=artists answers "what
  // am I playing". Saying so is cheaper than discovering it again.
  const r = await readTags(TAGGED_DB());
  assert.match(r.data.reading, /REVIEW SURFACE/);
  assert.match(r.data.reading, /get_dj_plays mode=artists/);
  assert.match(r.data.reading, /DECISIONS, NOT DELETIONS/);
});

// ---------------------------------------------------------------------------
// mode=review — the derived arm's pollution, surfaced without a verdict (021)
// ---------------------------------------------------------------------------
//
// 🛑 THE SEEDS TAGGED "Dec 29, 2023" AND "Cavendish Music" AS JAZZ. Both are TRUE
// as membership statements — the string really is on a track in a jazz playlist —
// and both are FALSE as the claim the tag makes, which is that this is an act
// (§14.9). The derivation knows membership and writes an assertion about music.
//
// ⚠️ NO RULE DECIDES WHICH ARE REAL. A regex catching a date also catches a band
// with a number in its name, and §14.7 records what text rules cost here.

const reviewDb = (rows) => ({
  from: () => { throw new Error("review mode must go through the RPC"); },
  rpc: async (name, params) => {
    if (name !== "dj_tag_review") {
      return { data: null, error: { message: `function public.${name} does not exist` } };
    }
    return { data: rows.map((r) => ({ ...r, _params: params })), error: null };
  },
});

test("mode=review goes to the RPC and passes its filters through", async () => {
  let seen = null;
  const db = {
    from: () => { throw new Error("must not read the table directly"); },
    rpc: async (_n, p) => { seen = p; return { data: [], error: null }; },
  };
  await mod.getDjArtistTagsTool.handler(
    { mode: "review", tag: "jazz", source: "playlist", limit: 5 }, tagCtx(db));
  assert.equal(seen.p_tag, "jazz");
  assert.equal(seen.p_source, "playlist");
  assert.equal(seen.p_limit, 5);
  assert.equal(seen.p_window_days, 90, "default window");
});

test("it returns the EVIDENCE and passes no verdict", async () => {
  // The four columns are facts already in the database. If a `suspect` or
  // `looks_fake` field ever appears here, a guess about text has been promoted
  // to a ruling and this test is where it should stop.
  const db = reviewDb([
    { artist: "Dec 29, 2023", tag: "jazz", status: "active", source: "playlist",
      distinct_tracks: 1, distinct_playlists: 1, play_rows: 0, distinct_days: 0 },
    { artist: "Thelonious Monk", tag: "jazz", status: "active", source: "manual",
      distinct_tracks: 94, distinct_playlists: 0, play_rows: 226, distinct_days: 21 },
  ]);
  const r = await mod.getDjArtistTagsTool.handler({ mode: "review" }, tagCtx(db));
  assert.equal(r.data.mode, "review");
  assert.equal(r.data.returned, 2);
  for (const t of r.data.tags) {
    for (const f of ["distinct_tracks", "distinct_playlists", "play_rows",
                     "distinct_days"]) {
      assert.ok(f in t, `${f} must travel with the row`);
    }
    assert.ok(!("suspect" in t), "no verdict field may appear");
    assert.ok(!("looks_fake" in t), "no verdict field may appear");
  }
});

test("the reading forbids cleaning up from inside a weekly review", async () => {
  // 🛑 An irreversible judgement about a hundred rows does not belong in a
  // conversation about concerts. The cleanup is its own hand-reviewed pass.
  const r = await mod.getDjArtistTagsTool.handler({ mode: "review" }, tagCtx(reviewDb([])));
  assert.match(r.data.reading, /NEVER A VERDICT/);
  assert.match(r.data.reading, /NOTHING HERE INSPECTS THE STRING/);
  assert.match(r.data.reading, /DO NOT REJECT ROWS FROM INSIDE A WEEKLY REVIEW/);
});

test("a missing 021 is named, and stays retryable", async () => {
  const db = {
    from: () => { throw new Error("no"); },
    rpc: async () => ({ data: null,
                        error: { message: "function public.dj_tag_review does not exist" } }),
  };
  await assert.rejects(
    () => mod.getDjArtistTagsTool.handler({ mode: "review" }, tagCtx(db)),
    (e) => {
      assert.match(e.message, /migration 021 has not been applied/);
      assert.ok(!/[Dd]o NOT retry/.test(e.message));
      return true;
    },
  );
});

test("the default mode still reads the table, not the RPC", async () => {
  // NEGATIVE CONTROL: adding a mode must not reroute the existing behaviour.
  const r = await readTags(TAGGED_DB());
  assert.equal(r.data.total, 4);
  assert.equal(r.data.mode, undefined, "list mode carries no mode field");
});
