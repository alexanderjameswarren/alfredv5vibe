// Handler tests for create_sam_snippet (sam-snippets.ts).
//
// Run:
//   node --test supabase/functions/_shared/tools/sam-snippets.test.mjs
//
// Same harness as sam-plans.test.mjs: platform.ts is loaded REAL with only its
// Deno imports stubbed, so calls go through defineTool and ctx.db is the fake
// database below.
//
// The title test runs the APP's formatSnippetTitle (lifted out of
// src/sam/lib/snippetsApi.js, which cannot be imported here because it pulls in
// the browser Supabase client) against the Edge Function's port.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "sam-snippets-"));

writeFileSync(join(dir, "stub_supabase.ts"), "export const createClient = () => globalThis.__fakeDb;\n");
writeFileSync(join(dir, "stub_crypto.ts"),
  "export const crypto = { subtle: { digest: async () => new Uint8Array(16).buffer } };\n");
let platformSrc = readFileSync(join(HERE, "..", "platform.ts"), "utf-8");
for (const [from, to] of [
  ['import { createClient } from "jsr:@supabase/supabase-js@2";', 'import { createClient } from "./stub_supabase.ts";'],
  ['import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";', "type SupabaseClient = any;"],
  ['import { crypto as stdCrypto } from "jsr:@std/crypto";', 'import { crypto as stdCrypto } from "./stub_crypto.ts";'],
]) {
  if (!platformSrc.includes(from)) throw new Error(`platform.ts import changed — update this test: ${from}`);
  platformSrc = platformSrc.replace(from, to);
}
writeFileSync(join(dir, "platform.ts"), platformSrc);

const IMPORT = 'import { defineTool } from "../platform.ts";';
const toolSrc = readFileSync(join(HERE, "sam-snippets.ts"), "utf-8");
if (!toolSrc.includes(IMPORT)) throw new Error("sam-snippets.ts import line changed — update this test.");
writeFileSync(join(dir, "sam-snippets.ts"), toolSrc.replace(IMPORT, 'import { defineTool } from "./platform.ts";'));

globalThis.Deno = { env: { get: () => "stub" } };
const mod = await import(pathToFileURL(join(dir, "sam-snippets.ts")).href);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const REQ = new Request("http://localhost/", {
  headers: { Authorization: `Bearer ${b64({ alg: "none" })}.${b64({ sub: "user-1" })}.sig` },
});

// --- fake database ------------------------------------------------------------
const SONG = "00000000-0000-4000-8000-000000000001";
const ARCHIVED_SONG = "00000000-0000-4000-8000-000000000002";
const EMPTY_SONG = "00000000-0000-4000-8000-000000000003";

function baseTables() {
  return {
    sam_songs: [
      { id: SONG, title: "Pastorale", archived: false },
      { id: ARCHIVED_SONG, title: "Old Song", archived: true },
      { id: EMPTY_SONG, title: "Blank", archived: false },
    ],
    sam_song_measures: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ song_id: SONG, number: n })),
    sam_snippets: [],
  };
}

function makeDb(tables = baseTables()) {
  const calls = [];
  let seq = 0;
  return {
    calls,
    tables,
    rpc(fn) {
      calls.push({ kind: "rpc", name: fn });
      return Promise.resolve({ data: [{ allowed: true, message: "" }], error: null });
    },
    from(table) {
      const st = { kind: "from", name: table, op: "select", payload: null, filters: [], order: null, limit: null };
      calls.push(st);
      const rows = () => (tables[table] ??= []);
      const api = {
        select() { return api; },
        eq(c, v) { st.filters.push((r) => r[c] === v); return api; },
        order(c, o = {}) { st.order = [c, o.ascending !== false]; return api; },
        limit(n) { st.limit = n; return api; },
        insert(p) { st.op = "insert"; st.payload = p; return api; },
        update(p) { st.op = "update"; st.payload = p; return api; },
        maybeSingle() { return run().then((r) => ({ ...r, data: r.data[0] ?? null })); },
        single() {
          return run().then((r) => r.data.length === 1 ? { ...r, data: r.data[0] } : { data: null, error: { message: "not one row" } });
        },
        then(res, rej) { return run().then(res, rej); },
      };
      function run() {
        if (st.op === "insert") {
          // Column defaults, as the database would apply them.
          const rec = {
            id: `00000000-0000-4000-8000-9${String(++seq).padStart(11, "0")}`,
            user_id: "user-1", archived: false, tags: [], notes: null,
            created_at: "2026-09-17T10:00:00Z", updated_at: "2026-09-17T10:00:00Z",
            ...st.payload,
          };
          rows().push(rec);
          return Promise.resolve({ data: [rec], error: null });
        }
        let matched = rows().filter((r) => st.filters.every((f) => f(r)));
        if (st.op === "update") {
          matched.forEach((r) => Object.assign(r, st.payload));
          return Promise.resolve({ data: matched, error: null });
        }
        if (st.order) {
          const [c, asc] = st.order;
          matched = [...matched].sort((a, b) => (a[c] - b[c]) * (asc ? 1 : -1));
        }
        if (st.limit != null) matched = matched.slice(0, st.limit);
        return Promise.resolve({ data: matched, error: null });
      }
      return api;
    },
  };
}

async function call(args, db) {
  globalThis.__fakeDb = db;
  return (await mod.createSamSnippetTool(args, REQ)).data;
}
const writes = (db) => db.calls.filter((c) => c.op === "insert" || c.op === "update");

const snippetRow = (over) => ({
  id: over.id, song_id: SONG, title: "t", start_measure: 3, end_measure: 4, rest_measures: 0,
  settings: { handMode: "both" }, archived: false, tags: [], notes: null,
  created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", ...over,
});

// --- title parity with the app ---------------------------------------------------

test("the title is exactly the app's formatSnippetTitle, across hand modes and rests", () => {
  const appSrc = readFileSync(join(HERE, "..", "..", "..", "..", "src", "sam", "lib", "snippetsApi.js"), "utf-8")
    .replace(/\r\n/g, "\n");
  const m = /export function formatSnippetTitle\([\s\S]*?\n\}\n/.exec(appSrc);
  assert.ok(m, "formatSnippetTitle not found in src/sam/lib/snippetsApi.js");
  const appFormat = new Function(`${m[0].replace("export function", "function")}; return formatSnippetTitle;`)();
  let checked = 0;
  for (const handMode of ["both", "lh", "rh", undefined, null]) {
    for (const restMeasures of [0, 1, 2, 10, undefined, null]) {
      for (const [startMeasure, endMeasure] of [[1, 1], [17, 17], [5, 12], [30, 160]]) {
        const input = { startMeasure, endMeasure, handMode, restMeasures };
        assert.equal(mod.formatSnippetTitle(input), appFormat(input), JSON.stringify(input));
        checked++;
      }
    }
  }
  assert.equal(checked, 120);
  assert.equal(mod.formatSnippetTitle({ startMeasure: 17, endMeasure: 17, handMode: "rh", restMeasures: 0 }),
    "Measures 17-17 RH No Rest");
});

// --- behaviour --------------------------------------------------------------------

test("no match: inserts exactly what the app writes and returns the id first", async () => {
  const db = makeDb();
  const out = await call({ song_id: SONG, start_measure: 5, end_measure: 8, hand_mode: "rh", rest_measures: 1 }, db);
  const ins = writes(db);
  assert.equal(ins.length, 1);
  assert.equal(ins[0].name, "sam_snippets");
  assert.deepEqual(ins[0].payload, {
    song_id: SONG,
    title: "Measures 5-8 RH Rest: 1",
    start_measure: 5,
    end_measure: 8,
    rest_measures: 1,
    settings: { handMode: "rh" },
  });
  assert.deepEqual(Object.keys(ins[0].payload.settings), ["handMode"]);
  assert.equal(Object.keys(out)[0], "id");
  assert.deepEqual(out, {
    id: db.tables.sam_snippets[0].id,
    song_id: SONG,
    title: "Measures 5-8 RH Rest: 1",
    start_measure: 5,
    end_measure: 8,
    rest_measures: 1,
    hand_mode: "rh",
    archived: false,
    created_at: "2026-09-17T10:00:00Z",
    created: true,
    restored: false,
  });
});

test("defaults: hand_mode both and rest_measures 0", async () => {
  const db = makeDb();
  const out = await call({ song_id: SONG, start_measure: 1, end_measure: 10 }, db);
  assert.deepEqual(writes(db)[0].payload.settings, { handMode: "both" });
  assert.equal(writes(db)[0].payload.rest_measures, 0);
  assert.equal(out.title, "Measures 1-10 Both No Rest");
});

test("a live match is returned as it is, with nothing written", async () => {
  const tables = baseTables();
  tables.sam_snippets.push(snippetRow({ id: "live-1", title: "Measures 3-4 Both No Rest" }));
  const db = makeDb(tables);
  const out = await call({ song_id: SONG, start_measure: 3, end_measure: 4 }, db);
  assert.deepEqual(writes(db), []);
  assert.equal(out.id, "live-1");
  assert.equal(out.created, false);
  assert.equal(out.restored, false);
  // Repeating the call is safe.
  const again = await call({ song_id: SONG, start_measure: 3, end_measure: 4 }, db);
  assert.equal(again.id, "live-1");
  assert.equal(tables.sam_snippets.length, 1);
});

test("an archived match is restored with its id and created_at, not duplicated", async () => {
  const tables = baseTables();
  tables.sam_snippets.push(snippetRow({ id: "old-1", archived: true, created_at: "2026-07-01T00:00:00Z" }));
  const db = makeDb(tables);
  const out = await call({ song_id: SONG, start_measure: 3, end_measure: 4, hand_mode: "both" }, db);
  const w = writes(db);
  assert.equal(w.length, 1);
  assert.equal(w[0].op, "update");
  assert.deepEqual(w[0].payload, { archived: false });
  assert.equal(tables.sam_snippets.length, 1);
  assert.equal(out.id, "old-1");
  assert.equal(out.archived, false);
  assert.equal(out.created_at, "2026-07-01T00:00:00Z");
  assert.equal(out.created, false);
  assert.equal(out.restored, true);
});

test("a live match wins over an archived twin", async () => {
  const tables = baseTables();
  tables.sam_snippets.push(snippetRow({ id: "old-1", archived: true }), snippetRow({ id: "live-1" }));
  const db = makeDb(tables);
  const out = await call({ song_id: SONG, start_measure: 3, end_measure: 4 }, db);
  assert.equal(out.id, "live-1");
  assert.deepEqual(writes(db), []);
});

test("settings without handMode is 'both', and matches a request for both", async () => {
  const tables = baseTables();
  tables.sam_snippets.push(snippetRow({ id: "legacy", title: "Measures 3–4", settings: { bpm: 68, chordGroupMs: 80 } }));
  const db = makeDb(tables);
  const out = await call({ song_id: SONG, start_measure: 3, end_measure: 4, hand_mode: "both" }, db);
  assert.equal(out.id, "legacy");
  assert.equal(out.hand_mode, "both");
  assert.deepEqual(writes(db), []);
  // A null settings object is "both" too.
  tables.sam_snippets[0].settings = null;
  assert.equal((await call({ song_id: SONG, start_measure: 3, end_measure: 4 }, db)).id, "legacy");
});

test("a different hand mode is a different snippet", async () => {
  const tables = baseTables();
  tables.sam_snippets.push(snippetRow({ id: "both-1" }));
  const db = makeDb(tables);
  const out = await call({ song_id: SONG, start_measure: 3, end_measure: 4, hand_mode: "lh" }, db);
  assert.equal(out.created, true);
  assert.notEqual(out.id, "both-1");
  assert.equal(out.hand_mode, "lh");
  assert.equal(tables.sam_snippets.length, 2);
});

test("a different rest count is a different snippet; null rest in the database matches 0", async () => {
  const tables = baseTables();
  tables.sam_snippets.push(snippetRow({ id: "null-rest", rest_measures: null }));
  const db = makeDb(tables);
  const zero = await call({ song_id: SONG, start_measure: 3, end_measure: 4, rest_measures: 0 }, db);
  assert.equal(zero.id, "null-rest");
  assert.equal(zero.rest_measures, 0);
  assert.deepEqual(writes(db), []);
  const one = await call({ song_id: SONG, start_measure: 3, end_measure: 4, rest_measures: 1 }, db);
  assert.equal(one.created, true);
  assert.equal(one.title, "Measures 3-4 Both Rest: 1");
});

test("snippets of another song never match", async () => {
  const tables = baseTables();
  tables.sam_snippets.push(snippetRow({ id: "elsewhere", song_id: EMPTY_SONG }));
  const db = makeDb(tables);
  const out = await call({ song_id: SONG, start_measure: 3, end_measure: 4 }, db);
  assert.equal(out.created, true);
});

// --- validation: an error, and nothing written ---------------------------------

const INVALID = [
  [{ song_id: "nope", start_measure: 1, end_measure: 2 }, /`song_id` must be a UUID/],
  [{ song_id: "00000000-0000-4000-8000-000000000099", start_measure: 1, end_measure: 2 }, /song .* not found/],
  [{ song_id: ARCHIVED_SONG, start_measure: 1, end_measure: 2 }, /"Old Song" is archived/],
  [{ song_id: EMPTY_SONG, start_measure: 1, end_measure: 1 }, /"Blank" has no measures/],
  [{ song_id: SONG, start_measure: 0, end_measure: 2 }, /`start_measure` must be a whole number of 1 or more, got 0/],
  [{ song_id: SONG, start_measure: 1.5, end_measure: 2 }, /`start_measure` must be a whole number/],
  [{ song_id: SONG, end_measure: 2 }, /`start_measure` must be a whole number/],
  [{ song_id: SONG, start_measure: 1 }, /`end_measure` must be a whole number/],
  [{ song_id: SONG, start_measure: 5, end_measure: 4 }, /`end_measure` \(4\) must not be before `start_measure` \(5\)/],
  [{ song_id: SONG, start_measure: 9, end_measure: 11 }, /`end_measure` \(11\) is past the last measure of "Pastorale" \(10\)/],
  [{ song_id: SONG, start_measure: 1, end_measure: 2, hand_mode: "left" }, /`hand_mode` must be one of both \| lh \| rh/],
  [{ song_id: SONG, start_measure: 1, end_measure: 2, rest_measures: -1 }, /`rest_measures` must be a whole number of 0 or more/],
  [{ song_id: SONG, start_measure: 1, end_measure: 2, rest_measures: 0.5 }, /`rest_measures` must be a whole number/],
];

for (const [args, message] of INVALID) {
  test(`refused, nothing written: ${JSON.stringify(args)}`, async () => {
    const db = makeDb();
    await assert.rejects(call(args, db), (e) => {
      assert.match(e.message, /^create_sam_snippet: /);
      assert.match(e.message, message);
      return true;
    });
    assert.deepEqual(writes(db), []);
    assert.equal(db.tables.sam_snippets.length, 0);
  });
}

test("end_measure equal to the last measure is allowed", async () => {
  const out = await call({ song_id: SONG, start_measure: 10, end_measure: 10 }, makeDb());
  assert.equal(out.title, "Measures 10-10 Both No Rest");
});

test("a database error is reported as operational, without do-not-retry wording", async () => {
  const db = makeDb();
  const from = db.from.bind(db);
  db.from = (table) => {
    const api = from(table);
    if (table !== "sam_snippets") return api;
    return { ...api, select: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: null, error: { message: "timeout", code: "57014" } }) }) }) }) };
  };
  await assert.rejects(call({ song_id: SONG, start_measure: 1, end_measure: 2 }, db), (e) => {
    assert.equal(e.message, "create_sam_snippet: snippet lookup failed: timeout [57014]");
    assert.doesNotMatch(e.message, /retry/i);
    return true;
  });
});
