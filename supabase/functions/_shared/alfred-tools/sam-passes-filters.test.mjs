// getSamPasses' filters, each asserted to CHANGE the rows returned.
//
// Run:
//   node --test supabase/functions/_shared/alfred-tools/sam-passes-filters.test.mjs
//
// WHY THIS FILE EXISTS. The three warm-up filters shipped dead: they were added to
// getSamSessions by mistake (an identical plan_item_id block a few hundred lines
// earlier matched first), so every one of them was permanently undefined and
// get_sam_passes returned the same 23 rows whichever was passed. Nothing caught it
// because nothing asserted that a filter narrows anything.
//
// So every test here compares against the UNFILTERED count. A filter that does
// nothing is exactly as green as a filter that works, unless the test says the
// number must move.
//
// tool-handlers.ts takes a Supabase client as its first argument, so the tests
// below hand it a fake one and read what it actually filtered.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// LOADING IT. tool-handlers.ts imports SupabaseClient from jsr:, which Node cannot
// resolve, and two RELATIVE siblings (./types.ts, ../tags.ts) which it must still
// be able to find. So the patched copy is written NEXT TO the original under a
// temporary name — a temp directory would break the relative imports — and removed
// again once it is loaded.
const src0 = readFileSync(join(HERE, "tool-handlers.ts"), "utf-8");
const JSR_IMPORT = /^import (?:type )?\{ SupabaseClient \} from "jsr:[^"]*";$/m;
if (!JSR_IMPORT.test(src0)) {
  throw new Error("tool-handlers.ts no longer imports SupabaseClient from jsr: — update this test.");
}
const src = src0.replace(JSR_IMPORT, "type SupabaseClient = any;");
const leftover = /^import[^\n]*jsr:[^\n]*$/m.exec(src);
if (leftover) throw new Error(`another jsr import appeared: ${leftover[0]}`);
const probe = join(HERE, "tool-handlers.__probe.ts");
writeFileSync(probe, src);
let mod;
try {
  mod = await import(pathToFileURL(probe).href);
} finally {
  rmSync(probe, { force: true });
}
// --- a fake client that records the filters it was given ----------------------
//
// It applies them for real, so a filter that is never called cannot pass.
function fakeClient(rows) {
  const applied = [];
  const client = {
    applied,
    from(table) {
      let list = [...(rows[table] ?? [])];
      const api = {
        select() { return api; },
        order() { return api; },
        limit() { return api; },
        eq(c, v) { applied.push(["eq", c, v]); list = list.filter((r) => r[c] === v); return api; },
        gt(c, v) { applied.push(["gt", c, v]); list = list.filter((r) => typeof r[c] === "number" && r[c] > v); return api; },
        gte() { return api; },
        lte() { return api; },
        is(c, v) { applied.push(["is", c, v]); list = list.filter((r) => (r[c] ?? null) === v); return api; },
        not(c, op, v) {
          applied.push(["not", c, op, v]);
          if (op === "is" && v === null) list = list.filter((r) => (r[c] ?? null) !== null);
          return api;
        },
        // Only the one shape this tool builds: a comma-separated OR of
        // `col.is.null` and `col.eq.value`.
        or(expr) {
          applied.push(["or", expr]);
          const tests = expr.split(",").map((part) => {
            const [col, op, val] = part.split(".");
            if (op === "is" && val === "null") return (r) => (r[col] ?? null) === null;
            if (op === "eq") return (r) => String(r[col]) === val;
            throw new Error(`fake client cannot parse or() term: ${part}`);
          });
          list = list.filter((r) => tests.some((t) => t(r)));
          return api;
        },
        in() { return api; },
        then(res, rej) { return Promise.resolve({ data: list, error: null }).then(res, rej); },
      };
      return api;
    },
  };
  return client;
}

// 6 ordinary passes, 11 top-rung warm-up passes, 6 below-the-top warm-up passes:
// 23 in all, which is the shape of the live data the bug was found on.
const pass = (i, over = {}) => ({
  id: `p${i}`, song_id: "song-1", snippet_id: null, session_id: "s1",
  plan_id: null, plan_item_id: null, bpm: 60, playback_speed: 100, effective_bpm: 60,
  hits: 10, misses: 0, notes_played: 10, accuracy_percent: 100, hand_mode: "both",
  warmup_rung: null, warmup_target_percent: null, completed_at: `2026-09-27T1${i % 10}:00:00Z`,
  ...over,
});
const ROWS = {
  sam_passes: [
    ...Array.from({ length: 6 }, (_, i) => pass(i)),
    ...Array.from({ length: 11 }, (_, i) => pass(10 + i, { warmup_rung: 3, warmup_target_percent: 100 })),
    ...Array.from({ length: 6 }, (_, i) => pass(30 + i, { warmup_rung: 1, warmup_target_percent: 70, effective_bpm: 42 })),
  ],
  sam_songs: [{ id: "song-1", title: "Pastorale", artist: null }],
  sam_snippets: [],
};

const count = async (params) => {
  const client = fakeClient(ROWS);
  const out = await mod.getSamPasses(client, { song_id: "song-1", ...params });
  assert.equal(out.error, undefined, `getSamPasses errored: ${out.error}`);
  return { n: out.data.length, applied: client.applied };
};

test("no filter: every pass", async () => {
  assert.equal((await count({})).n, 23);
});

test("warmup_only NARROWS to the ladder passes", async () => {
  const { n, applied } = await count({ warmup_only: true });
  assert.equal(n, 17);
  assert.notEqual(n, 23, "warmup_only returned everything — the filter is not being applied");
  assert.deepEqual(applied.find((a) => a[0] === "not"), ["not", "warmup_rung", "is", null]);
});

test("no_warmup NARROWS to the ordinary passes", async () => {
  const { n, applied } = await count({ no_warmup: true });
  assert.equal(n, 6);
  assert.notEqual(n, 23, "no_warmup returned everything — the filter is not being applied");
  assert.deepEqual(applied.find((a) => a[0] === "is" && a[1] === "warmup_rung"), ["is", "warmup_rung", null]);
});

test("top_rung_only keeps ordinary passes AND the top rung, dropping the slow ones", async () => {
  const { n, applied } = await count({ top_rung_only: true });
  // 6 ordinary + 11 at 100% = 17; the 6 at 70% are gone.
  assert.equal(n, 17);
  assert.notEqual(n, 23, "top_rung_only returned everything — the filter is not being applied");
  assert.deepEqual(applied.find((a) => a[0] === "or"),
    ["or", "warmup_rung.is.null,warmup_target_percent.eq.100"]);
});

test("the three filters are genuinely different from each other", async () => {
  const warmup = (await count({ warmup_only: true })).n;
  const plain = (await count({ no_warmup: true })).n;
  const top = (await count({ top_rung_only: true })).n;
  // The bug was that all three were equal. warmup_only and top_rung_only happen to
  // agree on this data, so the partition is what the assertion has to be about.
  assert.equal(warmup + plain, 23, "warmup_only and no_warmup must partition the table");
  assert.notEqual(plain, warmup);
  assert.notEqual(plain, top);
});

test("top_rung_only and warmup_only are NOT the same filter, even where the counts agree", async () => {
  // One ordinary pass and one slow warm-up pass: now they differ in count too.
  const client = fakeClient({
    ...ROWS,
    sam_passes: [pass(1), pass(2, { warmup_rung: 1, warmup_target_percent: 70 })],
  });
  const top = await mod.getSamPasses(client, { song_id: "song-1", top_rung_only: true });
  assert.equal(top.data.length, 1);
  assert.equal(top.data[0].id, "p1");

  const client2 = fakeClient({
    ...ROWS,
    sam_passes: [pass(1), pass(2, { warmup_rung: 1, warmup_target_percent: 70 })],
  });
  const warm = await mod.getSamPasses(client2, { song_id: "song-1", warmup_only: true });
  assert.equal(warm.data.length, 1);
  assert.equal(warm.data[0].id, "p2");
});

test("the rung columns are returned at all", async () => {
  const client = fakeClient(ROWS);
  const out = await mod.getSamPasses(client, { song_id: "song-1" });
  const slow = out.data.find((r) => r.id === "p30");
  assert.equal(slow.warmup_rung, 1);
  assert.equal(slow.warmup_target_percent, 70);
});

// --- and the one that proves the filters are on the right query ---------------

test("getSamSessions does NOT carry the warm-up filters: sam_sessions has no rung", async () => {
  const src2 = readFileSync(join(HERE, "tool-handlers.ts"), "utf-8");
  const sessionsBody = src2.slice(
    src2.indexOf("export async function getSamSessions"),
    src2.indexOf("export async function", src2.indexOf("export async function getSamSessions") + 10),
  );
  assert.equal(/warmup_rung|warmup_only|no_warmup|top_rung_only/.test(sessionsBody), false,
    "the warm-up filters are back in getSamSessions, where they can never work");
});
