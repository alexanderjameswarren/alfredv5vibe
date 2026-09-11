// Handler tests for the Ken reads that see misconceptions, and update_ken_area.
//
// Run:
//   node --experimental-strip-types --test supabase/functions/_shared/tools/ken.test.mjs
//
// Same approach as the sibling suites: read the real source, stub only its
// ../platform.ts import, import from a temp copy.
//
// ⚠️ THE FAKE PARSES .or() FOR REAL, nested and() and quoted in() values
// included. Both misconception fixes live entirely inside an or() string, so a
// fake that ignored it would pass a handler that never applied the filter — and
// a subtopic holding a comma is exactly the value a naive split would mangle.
// It also honours order() and { count: "exact" }, because the truncation
// signal depends on both.

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
  "const envelope = (data: any, meta: any = {}) => ({ data, meta });",
].join("\n");

const dir = mkdtempSync(join(tmpdir(), "ken-"));
const src = readFileSync(join(HERE, "ken.ts"), "utf-8").replace(
  'import { defineTool, clampLimit, envelope } from "../platform.ts";', STUBS);
if (src.includes("../platform.ts")) {
  throw new Error("ken.ts import line changed — update the stub in this test.");
}
writeFileSync(join(dir, "probe.ts"), src);
const mod = await import(pathToFileURL(join(dir, "probe.ts")).href);

// --- a PostgREST filter-string parser, just enough for eq / is / in / and() ---

function splitTop(s) {
  const out = [];
  let depth = 0, quoted = false, cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      cur += c;
      if (c === "\\") { cur += s[++i]; continue; }
      if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; cur += c; continue; }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

const unquote = (v) => v.startsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v;

function term(t) {
  if (t.startsWith("and(")) {
    const parts = splitTop(t.slice(4, -1)).map(term);
    return (r) => parts.every((f) => f(r));
  }
  const m = /^(\w+)\.(eq|is|in)\.(.*)$/s.exec(t);
  if (!m) throw new Error(`fake .or() cannot parse '${t}' — add it`);
  const [, col, op, val] = m;
  if (op === "eq") return (r) => r[col] === unquote(val);
  if (op === "is") return (r) => (val === "null" ? r[col] == null : r[col] === val);
  const vals = splitTop(val.slice(1, -1)).map(unquote);
  return (r) => r[col] != null && vals.includes(String(r[col]));
}

function makeDb({ items = [], misconceptions = [], attempts = [], areas = [], failWith = null } = {}) {
  const tables = {
    ken_items: items, ken_misconceptions: misconceptions,
    ken_attempts: attempts, ken_areas: areas,
  };
  const orCalls = [];
  const updates = [];
  function builder(rows) {
    const filters = [];
    let lim = null, sortBy = null, wantCount = false, patch = null, one = false;
    const api = {
      select(_cols, opts) { if (opts?.count === "exact") wantCount = true; return api; },
      eq(c, v) { filters.push((r) => r[c] === v); return api; },
      in(c, v) { filters.push((r) => v.includes(r[c])); return api; },
      or(expr) {
        orCalls.push(expr);
        const terms = splitTop(expr).map(term);
        filters.push((r) => terms.some((f) => f(r)));
        return api;
      },
      order(col, { ascending = true } = {}) { sortBy = { col, ascending }; return api; },
      limit(n) { lim = n; return api; },
      update(p) { patch = p; return api; },
      maybeSingle() { one = true; return api; },
      single() { one = true; return api; },
      then(resolve) {
        if (failWith) return resolve({ data: null, error: failWith });
        let hit = rows.filter((r) => filters.every((f) => f(r)));
        if (patch) {
          updates.push(patch);
          for (const r of hit) Object.assign(r, patch);
          return resolve({ data: one ? hit[0] ?? null : hit, error: null });
        }
        if (sortBy) {
          const { col, ascending } = sortBy;
          hit = [...hit].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (ascending ? 1 : -1));
        }
        const count = wantCount ? hit.length : null;
        if (lim !== null) hit = hit.slice(0, lim);
        if (one) return resolve({ data: hit[0] ?? null, error: null, count });
        return resolve({ data: hit, error: null, count });
      },
    };
    return api;
  }
  return {
    orCalls,
    updates,
    from: (t) => builder(tables[t]),
    // ken_select_batch: the batch is simply every item handed in.
    rpc: () => builder(items),
  };
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

// --- get_ken_misconceptions --------------------------------------------------

test("get_ken_misconceptions item_id matches BOTH sides of a confusion pair", async () => {
  const db = makeDb({ misconceptions: [
    { id: "m-anchor", item_id: A, related_item_id: B, subtopic: null, status: "active" },
    { id: "m-related", item_id: B, related_item_id: A, subtopic: null, status: "active" },
    { id: "m-other", item_id: C, related_item_id: null, subtopic: null, status: "active" },
    { id: "m-resolved", item_id: A, related_item_id: null, subtopic: null, status: "resolved" },
  ] });
  const out = await mod.getKenMisconceptionsTool.handler({ item_id: A }, { db });
  assert.deepEqual(out.data.map((r) => r.id).sort(), ["m-anchor", "m-related"]);
});

test("get_ken_misconceptions refuses a non-uuid item_id before it reaches the filter", async () => {
  const db = makeDb();
  await assert.rejects(
    mod.getKenMisconceptionsTool.handler({ item_id: `${A},subtopic.is.null` }, { db }),
    /item_id must be a uuid/,
  );
  assert.equal(db.orCalls.length, 0);
});

// --- get_ken_quiz_batch ------------------------------------------------------

test("get_ken_quiz_batch pulls subtopic-only misconceptions for subtopics in the batch", async () => {
  const db = makeDb({
    items: [
      { id: A, subtopic: "wave mechanics" },
      { id: B, subtopic: null },
    ],
    misconceptions: [
      { id: "m-pair", item_id: C, related_item_id: B, subtopic: null, status: "active" },
      { id: "m-sub", item_id: null, related_item_id: null, subtopic: "wave mechanics", status: "active" },
      { id: "m-sub-elsewhere", item_id: null, related_item_id: null, subtopic: "optics", status: "active" },
      // Item-anchored on an item OUTSIDE the batch that happens to share the
      // subtopic — only subtopic-scoped rows come in by subtopic.
      { id: "m-sibling", item_id: C, related_item_id: null, subtopic: "wave mechanics", status: "active" },
      { id: "m-sub-resolved", item_id: null, related_item_id: null, subtopic: "wave mechanics", status: "resolved" },
    ],
  });
  const out = await mod.getKenQuizBatchTool.handler({}, { db });
  assert.deepEqual(out.data.misconceptions.map((r) => r.id).sort(), ["m-pair", "m-sub"]);
});

test("get_ken_quiz_batch quotes a subtopic holding filter-grammar characters", async () => {
  const nasty = 'keys, "modes" (and scales)';
  const db = makeDb({
    items: [{ id: A, subtopic: nasty }],
    misconceptions: [
      { id: "m-nasty", item_id: null, related_item_id: null, subtopic: nasty, status: "active" },
      { id: "m-keys", item_id: null, related_item_id: null, subtopic: "keys", status: "active" },
    ],
  });
  const out = await mod.getKenQuizBatchTool.handler({}, { db });
  assert.deepEqual(out.data.misconceptions.map((r) => r.id), ["m-nasty"]);
});

test("get_ken_quiz_batch with no subtopics in the batch adds no subtopic clause", async () => {
  const db = makeDb({ items: [{ id: A, subtopic: null }] });
  await mod.getKenQuizBatchTool.handler({}, { db });
  assert.equal(db.orCalls.length, 1);
  assert.ok(!db.orCalls[0].includes("subtopic"), db.orCalls[0]);
});

test("get_ken_quiz_batch past 50 misconceptions: newest kept, truncation flagged with the true total", async () => {
  // 55 matching rows; updated_at rises with n, so the newest are m-54 … m-5.
  const misconceptions = Array.from({ length: 55 }, (_, n) => ({
    id: `m-${n}`, item_id: A, related_item_id: null, subtopic: null, status: "active",
    updated_at: `2026-09-01T00:00:${String(n).padStart(2, "0")}Z`,
  }));
  const db = makeDb({ items: [{ id: A, subtopic: null }], misconceptions });
  const out = await mod.getKenQuizBatchTool.handler({ limit: 10 }, { db });
  assert.equal(out.data.misconceptions.length, 50);
  assert.equal(out.data.misconceptions[0].id, "m-54");
  assert.ok(!out.data.misconceptions.some((r) => ["m-0", "m-4"].includes(r.id)));
  // limit_applied is the misconceptions cap, not the item limit (10): the MCP
  // wrapper prints it as the "shown" count for an object payload.
  assert.deepEqual(out.meta, { limit_applied: 50, truncated: true, total: 55 });
});

test("get_ken_quiz_batch at or under 50 misconceptions is not flagged", async () => {
  const misconceptions = Array.from({ length: 50 }, (_, n) => ({
    id: `m-${n}`, item_id: A, related_item_id: null, subtopic: null, status: "active",
    updated_at: `2026-09-01T00:00:${String(n).padStart(2, "0")}Z`,
  }));
  const db = makeDb({ items: [{ id: A, subtopic: null }], misconceptions });
  const out = await mod.getKenQuizBatchTool.handler({ limit: 10 }, { db });
  assert.equal(out.data.misconceptions.length, 50);
  assert.deepEqual(out.meta, { limit_applied: 10, truncated: false });
});

// --- get_ken_areas -----------------------------------------------------------

const areas = (n) => Array.from({ length: n }, (_, i) => ({
  id: `a-${String(i).padStart(2, "0")}`, name: `Area ${String(i).padStart(2, "0")}`,
  source_ref: `seed-${i}`,
}));

test("get_ken_areas honours limit, clamps it at 50, and defaults to 20", async () => {
  const db = makeDb({ areas: areas(60) });
  const dflt = await mod.getKenAreasTool.handler({}, { db });
  assert.equal(dflt.data.length, 20);
  assert.deepEqual(dflt.meta, { limit_applied: 20, truncated: true, total: 60 });
  const fifty = await mod.getKenAreasTool.handler({ limit: 50 }, { db });
  assert.equal(fifty.data.length, 50);
  const over = await mod.getKenAreasTool.handler({ limit: 500 }, { db });
  assert.equal(over.meta.limit_applied, 50);
});

test("get_ken_areas is not flagged truncated when everything fits", async () => {
  const db = makeDb({ areas: areas(21) });
  const out = await mod.getKenAreasTool.handler({ limit: 50 }, { db });
  assert.equal(out.data.length, 21);
  assert.equal(out.meta.truncated, false);
});

test("get_ken_areas with EXACTLY limit areas is not a truncation", async () => {
  // rows.length >= LIMIT would call this cut, and the seed check would treat a
  // complete read as unusable.
  const db = makeDb({ areas: areas(50) });
  const out = await mod.getKenAreasTool.handler({ limit: 50 }, { db });
  assert.equal(out.data.length, 50);
  assert.deepEqual(out.meta, { limit_applied: 50, truncated: false });
});

test("get_ken_areas source_refs returns only the areas linked to those seeds", async () => {
  const db = makeDb({ areas: areas(60) });
  const out = await mod.getKenAreasTool.handler(
    { source_refs: ["seed-3", "seed-41", "not-an-area"] }, { db });
  assert.deepEqual(out.data.map((a) => a.source_ref).sort(), ["seed-3", "seed-41"]);
  // The limit defaults to the ids passed, so 60 areas in the table is no cut.
  assert.deepEqual(out.meta, { limit_applied: 3, truncated: false });
});

test("get_ken_areas source_refs cannot truncate even when every id has an area", async () => {
  const db = makeDb({ areas: areas(60) });
  const refs = Array.from({ length: 50 }, (_, i) => `seed-${i}`);
  const out = await mod.getKenAreasTool.handler({ source_refs: refs }, { db });
  assert.equal(out.data.length, 50);
  assert.equal(out.meta.truncated, false);
});

test("get_ken_areas refuses more than 50 source_refs rather than clipping them", async () => {
  const db = makeDb({ areas: areas(5) });
  const refs = Array.from({ length: 51 }, (_, i) => `seed-${i}`);
  await assert.rejects(mod.getKenAreasTool.handler({ source_refs: refs }, { db }), /at most 50/);
});

test("get_ken_areas with an empty source_refs is the same as omitting it", async () => {
  const db = makeDb({ areas: areas(30) });
  const out = await mod.getKenAreasTool.handler({ source_refs: [] }, { db });
  assert.equal(out.data.length, 20);
  assert.deepEqual(out.meta, { limit_applied: 20, truncated: true, total: 30 });
});

// --- exact-count truncation on the other two list reads ----------------------

const stamp = (i) => `2026-09-01T00:00:${String(i).padStart(2, "0")}Z`;

test("get_ken_items: exactly limit rows is complete; one more is a truncation with the total", async () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `i-${i}`, status: "active", created_at: stamp(i) }));
  const exact = await mod.getKenItemsTool.handler({}, { db: makeDb({ items: rows(20) }) });
  assert.deepEqual(exact.meta, { limit_applied: 20, truncated: false });
  const over = await mod.getKenItemsTool.handler({}, { db: makeDb({ items: rows(21) }) });
  assert.deepEqual(over.meta, { limit_applied: 20, truncated: true, total: 21 });
});

test("get_ken_misconceptions: exactly limit rows is complete; one more is a truncation with the total", async () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({
    id: `m-${i}`, item_id: A, related_item_id: null, subtopic: null, status: "active", updated_at: stamp(i),
  }));
  const exact = await mod.getKenMisconceptionsTool.handler({}, { db: makeDb({ misconceptions: rows(20) }) });
  assert.deepEqual(exact.meta, { limit_applied: 20, truncated: false });
  const over = await mod.getKenMisconceptionsTool.handler({}, { db: makeDb({ misconceptions: rows(21) }) });
  assert.deepEqual(over.meta, { limit_applied: 20, truncated: true, total: 21 });
});

// --- update_ken_area ---------------------------------------------------------

const AREA = () => ({ id: A, name: "Physics", description: "old", source_ref: null, priority: 1 });

test("update_ken_area sets source_ref and leaves omitted fields alone", async () => {
  const db = makeDb({ areas: [AREA()] });
  const out = await mod.updateKenAreaTool.handler({ id: A, source_ref: "mtw2hc4joechy2juiim" }, { db });
  assert.equal(out.data.source_ref, "mtw2hc4joechy2juiim");
  assert.equal(out.data.name, "Physics");
  assert.equal(out.data.description, "old");
  assert.deepEqual(Object.keys(db.updates[0]).sort(), ["source_ref", "updated_at"]);
});

test("update_ken_area: explicit null clears, and is not the same as omitting", async () => {
  const db = makeDb({ areas: [{ ...AREA(), source_ref: "x" }] });
  const out = await mod.updateKenAreaTool.handler({ id: A, source_ref: null }, { db });
  assert.equal(out.data.source_ref, null);
  assert.equal(out.data.description, "old");
});

test("update_ken_area with nothing to change writes nothing", async () => {
  const db = makeDb({ areas: [AREA()] });
  await assert.rejects(mod.updateKenAreaTool.handler({ id: A }, { db }), /nothing to change/);
  assert.equal(db.updates.length, 0);
});

test("update_ken_area on an unknown id is an error, not a silent no-op", async () => {
  const db = makeDb({ areas: [AREA()] });
  await assert.rejects(mod.updateKenAreaTool.handler({ id: B, name: "X" }, { db }), /no area with id/);
});

test("update_ken_area names the duplicate source_ref instead of passing on a raw 23505", async () => {
  const db = makeDb({ areas: [AREA()], failWith: { code: "23505", message: "duplicate key value" } });
  await assert.rejects(
    mod.updateKenAreaTool.handler({ id: A, source_ref: "mtw2hc4joechy2juiim" }, { db }),
    /already set on another area/,
  );
});
