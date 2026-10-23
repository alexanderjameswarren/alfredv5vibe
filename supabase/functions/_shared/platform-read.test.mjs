// Shared read helper.
//
//   node --test supabase/functions/_shared/platform-read.test.mjs
//
// platform-read.ts has no imports, so Node loads it directly (type stripping).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseReadOptions,
  selectColumns,
  applyReadOptions,
  shapeRows,
  capResponse,
  pageMeta,
  truncationNote,
  MAX_RESPONSE_CHARS,
} from "./platform-read.ts";

const ITEMS = {
  table: "items",
  columns: [
    { name: "id", type: "text" },
    { name: "name", type: "text" },
    { name: "description", type: "text" },
    { name: "elements", type: "jsonb" },
    { name: "context_id", type: "text" },
    { name: "archived", type: "boolean" },
  ],
  heavy_columns: ["elements"],
  has_context_id: true,
  has_archived: true,
  has_status: true,
};

const PUSH = {
  table: "push_subscriptions",
  columns: [
    { name: "id", type: "uuid" },
    { name: "user_agent", type: "text" },
  ],
  secret_columns: ["endpoint", "p256dh", "auth_key"],
  has_context_id: false,
  has_archived: false,
  has_status: false,
};

test("defaults", () => {
  const o = parseReadOptions({}, ITEMS);
  assert.deepEqual(o, {
    limit: 20, offset: 0, ids: null, include: [], archived: "exclude", no_context: false,
  });
});

test("limit clamps to 50", () => {
  assert.equal(parseReadOptions({ limit: 500 }, ITEMS).limit, 50);
});

test("bad limit and offset name the parameter", () => {
  assert.throws(() => parseReadOptions({ limit: 0 }, ITEMS), /^Error: limit:/);
  assert.throws(() => parseReadOptions({ limit: "5" }, ITEMS), /^Error: limit:/);
  assert.throws(() => parseReadOptions({ offset: -1 }, ITEMS), /^Error: offset:/);
  assert.throws(() => parseReadOptions({ offset: 1.5 }, ITEMS), /^Error: offset:/);
});

test("ids set the limit, include archived, refuse offset", () => {
  const o = parseReadOptions({ ids: ["a", "b", "a"] }, ITEMS);
  assert.deepEqual(o.ids, ["a", "b"]);
  assert.equal(o.limit, 2);
  assert.equal(o.archived, "include");
  assert.throws(() => parseReadOptions({ ids: ["a"], offset: 5 }, ITEMS), /offset: cannot be combined/);
  assert.throws(() => parseReadOptions({ ids: [] }, ITEMS), /^Error: ids:/);
  assert.throws(() => parseReadOptions({ ids: [""] }, ITEMS), /^Error: ids:/);
  assert.throws(() => parseReadOptions({ ids: Array(51).fill("x") }, ITEMS), /at most 50/);
});

test("include must be allowed by the tool", () => {
  assert.deepEqual(parseReadOptions({ include: ["notes"] }, ITEMS, ["notes"]).include, ["notes"]);
  assert.throws(() => parseReadOptions({ include: ["links"] }, ITEMS, ["notes"]), /Allowed: notes/);
  assert.throws(() => parseReadOptions({ include: ["notes"] }, ITEMS), /no includes/);
});

test("archived and no_context only where the columns exist", () => {
  assert.equal(parseReadOptions({ archived: "only" }, ITEMS).archived, "only");
  assert.throws(() => parseReadOptions({ archived: "all" }, ITEMS), /^Error: archived:/);
  assert.equal(parseReadOptions({}, PUSH).archived, null);
  assert.throws(() => parseReadOptions({ archived: "include" }, PUSH), /no archived column/);
  assert.equal(parseReadOptions({ no_context: true }, ITEMS).no_context, true);
  assert.throws(() => parseReadOptions({ no_context: true }, PUSH), /no context_id column/);
  assert.throws(
    () => parseReadOptions({ no_context: true, context_id: "c1" }, ITEMS),
    /cannot be combined with context_id/,
  );
});

test("selectColumns drops secrets always and heavy columns in lists", () => {
  assert.equal(selectColumns(ITEMS, { byIds: false }), "id, name, description, context_id, archived");
  assert.equal(selectColumns(ITEMS, { byIds: true }), "id, name, description, elements, context_id, archived");
  const leaky = { ...PUSH, columns: [...PUSH.columns, { name: "auth_key", type: "text" }] };
  assert.equal(selectColumns(leaky, { byIds: true }), "id, user_agent");
});

function fakeQuery() {
  const calls = [];
  const q = {
    calls,
    in(c, v) { calls.push(["in", c, v]); return q; },
    eq(c, v) { calls.push(["eq", c, v]); return q; },
    is(c, v) { calls.push(["is", c, v]); return q; },
    range(a, b) { calls.push(["range", a, b]); return q; },
  };
  return q;
}

test("applyReadOptions pushes filters before the page window", () => {
  const q = fakeQuery();
  applyReadOptions(q, parseReadOptions({ offset: 40, limit: 20, no_context: true }, ITEMS));
  assert.deepEqual(q.calls, [
    ["eq", "archived", false],
    ["is", "context_id", null],
    ["range", 40, 59],
  ]);
  const q2 = fakeQuery();
  applyReadOptions(q2, parseReadOptions({ ids: ["a"] }, ITEMS));
  assert.deepEqual(q2.calls, [["in", "id", ["a"]], ["range", 0, 0]]);
  const q3 = fakeQuery();
  applyReadOptions(q3, parseReadOptions({ archived: "only" }, ITEMS));
  assert.deepEqual(q3.calls[0], ["eq", "archived", true]);
});

test("shapeRows previews long text and heavy json in lists only", () => {
  const long = "x".repeat(450);
  const big = { steps: Array(200).fill("step") };
  const row = { id: "1", description: long, elements: big, short: "ok", n: 3 };
  const list = shapeRows([row], ITEMS, { byIds: false });
  assert.equal(list.previewed, 2);
  assert.ok(list.rows[0].description.startsWith("x".repeat(200) + "… [cut: 450 chars"));
  assert.match(list.rows[0].elements, /^\[omitted: \d+ chars of json; fetch by ids\]$/);
  assert.equal(list.rows[0].short, "ok");
  const byIds = shapeRows([row], ITEMS, { byIds: true });
  assert.equal(byIds.previewed, 0);
  assert.equal(byIds.rows[0].description, long);
  assert.deepEqual(byIds.rows[0].elements, big);
});

test("shapeRows keeps fullText columns whole in lists", () => {
  const long = "c".repeat(300);
  const { rows, previewed } = shapeRows([{ captured_text: long, ai_reasoning: long }], ITEMS, { byIds: false, fullText: ["captured_text"] });
  assert.equal(rows[0].captured_text, long);
  assert.match(rows[0].ai_reasoning, /\[cut: 300 chars/);
  assert.equal(previewed, 1);
});

test("shapeRows strips secret keys even if selected", () => {
  const { rows } = shapeRows([{ id: "1", endpoint: "https://x", auth_key: "k" }], PUSH, { byIds: true });
  assert.deepEqual(rows, [{ id: "1" }]);
});

test("capResponse drops trailing rows and keeps the first", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ i, pad: "y".repeat(100) }));
  const capped = capResponse(rows, 600);
  assert.ok(capped.rows.length < 10 && capped.rows.length >= 1);
  assert.equal(capped.cutForSize, 10 - capped.rows.length);
  assert.ok(JSON.stringify(capped.rows, null, 2).length <= 600);
  const one = capResponse([{ pad: "z".repeat(1000) }], 100);
  assert.equal(one.rows.length, 1);
  assert.equal(one.oversizedFirst, true);
  assert.equal(capResponse(rows).cutForSize, 0);
});

test("pageMeta: next_offset from a counted total", () => {
  const opts = parseReadOptions({ offset: 20 }, ITEMS);
  assert.deepEqual(pageMeta({ opts, returned: 20, total: 55 }), {
    truncated: true, limit_applied: 20, total: 55, next_offset: 40,
  });
  assert.deepEqual(pageMeta({ opts, returned: 15, total: 35 }), {
    truncated: false, limit_applied: 20, total: 35,
  });
});

test("pageMeta: size cut moves next_offset back and says why", () => {
  const opts = parseReadOptions({}, ITEMS);
  const m = pageMeta({ opts, returned: 12, total: 30, cutForSize: 8, previewed: 3, omittedHeavy: ["elements"] });
  assert.equal(m.next_offset, 12);
  assert.equal(m.notes.length, 3);
  assert.match(m.notes[0], new RegExp(`8 more row\\(s\\).*${MAX_RESPONSE_CHARS}`));
});

test("pageMeta: by-ids reads are never truncated pages", () => {
  const opts = parseReadOptions({ ids: ["a", "b"] }, ITEMS);
  const m = pageMeta({ opts, returned: 1, cutForSize: 1, omittedHeavy: ["elements"] });
  assert.equal(m.truncated, false);
  assert.equal(m.next_offset, undefined);
  assert.ok(m.notes.some((n) => /missing from this result/.test(n)));
  assert.ok(!m.notes.some((n) => /Heavy columns/.test(n)));
});

test("pageMeta: no total, full page means more", () => {
  const opts = parseReadOptions({ limit: 5 }, ITEMS);
  assert.equal(pageMeta({ opts, returned: 5 }).truncated, true);
  assert.equal(pageMeta({ opts, returned: 4 }).truncated, false);
});

test("truncationNote", () => {
  assert.equal(truncationNote({ truncated: false }, 3), null);
  assert.equal(
    truncationNote({ truncated: true, total: 55, next_offset: 40 }, 20),
    "NOTE: results truncated to 20 of 55. Next page: offset=40. Narrow the query or request a specific subset.\n\n",
  );
  assert.equal(
    truncationNote({ truncated: false, notes: ["a"] }, 1),
    "NOTE: a\n\n",
  );
});
