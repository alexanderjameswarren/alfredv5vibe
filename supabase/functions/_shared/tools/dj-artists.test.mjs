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
    let updates = null, inserts = null, single = false, lim = null;
    const api = {
      select() { return api; },
      ilike(col, v) { filters.push((r) => String(r[col]).toLowerCase() === String(v).toLowerCase()); return api; },
      is(col, v) { filters.push((r) => r[col] === v); return api; },
      eq(col, v) { filters.push((r) => r[col] === v); return api; },
      order() { return api; },
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
        if (lim != null) out = out.slice(0, lim);
        return resolve({ data: single ? (out[0] ?? null) : out, error: null });
      },
    };
    return api;
  }
  return { from: () => builder(), _rows: rows };
}

const get = (db, args) => mod.getDjArtistsTool.handler(args, { db, userId: USER });
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
