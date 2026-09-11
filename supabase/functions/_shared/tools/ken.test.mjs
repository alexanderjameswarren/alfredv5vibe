// Handler tests for the two Ken reads that see misconceptions.
//
// Run:
//   node --experimental-strip-types --test supabase/functions/_shared/tools/ken.test.mjs
//
// Same approach as the sibling suites: read the real source, stub only its
// ../platform.ts import, import from a temp copy.
//
// ⚠️ THE FAKE PARSES .or() FOR REAL, nested and() and quoted in() values
// included. Both fixes live entirely inside an or() string, so a fake that
// ignored it would pass a handler that never applied the filter — and a subtopic
// holding a comma is exactly the value a naive split would mangle.

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

function makeDb({ items = [], misconceptions = [], attempts = [] } = {}) {
  const tables = { ken_items: items, ken_misconceptions: misconceptions, ken_attempts: attempts };
  const orCalls = [];
  function builder(rows) {
    const filters = [];
    let lim = null;
    const api = {
      select() { return api; },
      eq(c, v) { filters.push((r) => r[c] === v); return api; },
      in(c, v) { filters.push((r) => v.includes(r[c])); return api; },
      or(expr) {
        orCalls.push(expr);
        const terms = splitTop(expr).map(term);
        filters.push((r) => terms.some((f) => f(r)));
        return api;
      },
      order() { return api; },
      limit(n) { lim = n; return api; },
      then(resolve) {
        let hit = rows.filter((r) => filters.every((f) => f(r)));
        if (lim !== null) hit = hit.slice(0, lim);
        return resolve({ data: hit, error: null });
      },
    };
    return api;
  }
  return {
    orCalls,
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
