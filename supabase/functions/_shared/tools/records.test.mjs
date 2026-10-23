// get_records, through the REAL platform.ts readTable and platform-read.ts.
//
//   node --test supabase/functions/_shared/tools/records.test.mjs
//
// platform.ts's jsr: imports are stripped (nothing here calls them); only
// defineTool is replaced, so the handler can be called with a fake ctx.db.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED = join(HERE, "..");
const dir = mkdtempSync(join(tmpdir(), "records-"));

const platform = readFileSync(join(SHARED, "platform.ts"), "utf-8")
  .split("\n").filter((l) => !/^import .*"jsr:/.test(l)).join("\n");
writeFileSync(join(dir, "platform.ts"), platform);
writeFileSync(join(dir, "platform-read.ts"), readFileSync(join(SHARED, "platform-read.ts"), "utf-8"));
writeFileSync(join(dir, "shim.ts"), `
export { clampLimit, finishRead, readTable, requireSettings } from "./platform.ts";
export const defineTool = (o) => o;
`);
const src = readFileSync(join(HERE, "records.ts"), "utf-8");
for (const line of ['from "../platform.ts";', 'from "../platform-read.ts";']) {
  if (!src.includes(line)) throw new Error(`records.ts import ${line} changed — update this test.`);
}
writeFileSync(join(dir, "records.ts"),
  src.replace('from "../platform.ts";', 'from "./shim.ts";').replace('from "../platform-read.ts";', 'from "./platform-read.ts";'));
const m = await import(pathToFileURL(join(dir, "records.ts")).href);
const run = (args, db) => m.getRecordsTool.handler(args, { db, userId: "u" });

const ITEMS = {
  table: "items",
  columns: ["id", "name", "description", "elements", "context_id", "status", "archived", "created_at"]
    .map((name) => ({ name, type: name === "elements" ? "jsonb" : "text" })),
  secret_columns: [],
  heavy_columns: ["elements"],
  has_context_id: true, has_archived: true, has_status: true,
};
const PUSH = {
  table: "push_subscriptions",
  columns: [{ name: "id", type: "uuid" }, { name: "user_agent", type: "text" }, { name: "created_at", type: "timestamptz" }],
  secret_columns: ["endpoint", "p256dh", "auth_key"],
  heavy_columns: [],
  has_context_id: false, has_archived: false, has_status: false,
};
const VISIBLE = [ITEMS, PUSH];

/** Fake ctx.db: rpc serves read settings (and search results); from(table) logs its chain and resolves to tables[table]. */
function fakeDb(tables = {}, search = { rows: [], total: 0 }) {
  const calls = [];
  const builder = (table) => {
    const b = new Proxy({}, {
      get: (_t, k) => {
        if (k === "then") return (res) => res(tables[table] ?? { data: [], error: null, count: 0 });
        return (...a) => { calls.push([table, k, ...a]); return b; };
      },
    });
    return b;
  };
  return {
    calls,
    from: (t) => builder(t),
    rpc: (name, params) => {
      calls.push(["rpc", name, params]);
      if (name === "platform_search_items") return Promise.resolve({ data: search, error: null });
      const list = params?.p_table ? VISIBLE.filter((s) => s.table === params.p_table) : VISIBLE;
      return Promise.resolve({ data: list, error: null });
    },
  };
}
const selectOf = (db, table) => db.calls.find(([t, k]) => t === table && k === "select")?.[2];

test("a secret column is never selected and never returned", async () => {
  const db = fakeDb({ push_subscriptions: {
    data: [{ id: "p1", user_agent: "Chrome", endpoint: "https://push", p256dh: "k", auth_key: "a" }], error: null, count: 1 } });
  const out = await run({ table: "push_subscriptions", ids: ["p1"] }, db);
  assert.equal(selectOf(db, "push_subscriptions"), "id, user_agent, created_at");
  assert.deepEqual(out.data, [{ id: "p1", user_agent: "Chrome" }]);
});

test("a hidden or unknown table is refused, naming the readable ones", async () => {
  await assert.rejects(run({ table: "secret_stuff" }, fakeDb()),
    /"secret_stuff" is not a readable table\. Readable tables: items, push_subscriptions\./);
  await assert.rejects(run({ table: "items; drop" }, fakeDb()), /table must be a table name/);
});

test("list read: heavy columns left out, long text previewed, next offset given", async () => {
  const long = "d".repeat(300);
  const db = fakeDb({ items: { data: [{ id: "i1", name: "A", description: long }], error: null, count: 45 } });
  const out = await run({ table: "items", limit: 1, offset: 10 }, db);
  assert.ok(!selectOf(db, "items").includes("elements"));
  assert.ok(db.calls.some(([t, k, c, v]) => t === "items" && k === "eq" && c === "archived" && v === false));
  assert.ok(db.calls.some(([t, k, a, b]) => t === "items" && k === "range" && a === 10 && b === 10));
  assert.match(out.data[0].description, /^d{200}… \[cut: 300 chars/);
  assert.equal(out.meta.truncated, true);
  assert.equal(out.meta.total, 45);
  assert.equal(out.meta.next_offset, 11);
  assert.ok(out.meta.notes.some((n) => /Heavy columns left out of list reads: elements/.test(n)));
});

test("by ids: full text and heavy columns, archived included", async () => {
  const long = "d".repeat(300);
  const db = fakeDb({ items: { data: [{ id: "i1", description: long, elements: [{ x: 1 }] }], error: null, count: 1 } });
  const out = await run({ table: "items", ids: ["i1"] }, db);
  assert.ok(selectOf(db, "items").includes("elements"));
  assert.ok(db.calls.some(([t, k, c, v]) => t === "items" && k === "in" && c === "id" && v[0] === "i1"));
  assert.ok(!db.calls.some(([t, k, c]) => t === "items" && k === "eq" && c === "archived"));
  assert.equal(out.data[0].description, long);
  assert.equal(out.meta.truncated, false);
});

test("context_id, status and no_context filters, and refusal where the column is missing", async () => {
  const db = fakeDb({ items: { data: [], error: null, count: 0 } });
  await run({ table: "items", context_id: "c1", status: ["active"] }, db);
  assert.ok(db.calls.some(([t, k, c, v]) => t === "items" && k === "eq" && c === "context_id" && v === "c1"));
  assert.ok(db.calls.some(([t, k, c, v]) => t === "items" && k === "in" && c === "status" && v[0] === "active"));
  const db2 = fakeDb();
  await run({ table: "items", no_context: true }, db2);
  assert.ok(db2.calls.some(([t, k, c, v]) => t === "items" && k === "is" && c === "context_id" && v === null));
  await assert.rejects(run({ table: "push_subscriptions", status: ["x"] }, fakeDb()), /has no status column/);
  await assert.rejects(run({ table: "push_subscriptions", archived: "only" }, fakeDb()), /no archived column/);
});

test("include notes attaches each row's notes; refused where the table has none", async () => {
  const db = fakeDb({
    items: { data: [{ id: "i1", name: "A" }, { id: "i2", name: "B" }], error: null, count: 2 },
    notes: { data: [{ id: "n1", target_id: "i1", body: "b".repeat(250), created_at: "2026-10-23" }], error: null },
  });
  const out = await run({ table: "items", include: ["notes"] }, db);
  assert.ok(db.calls.some(([t, k, c, v]) => t === "notes" && k === "eq" && c === "target_type" && v === "item"));
  assert.equal(out.data[0].notes.length, 1);
  assert.match(out.data[0].notes[0].body, /\[cut: 250 chars/);
  assert.deepEqual(out.data[1].notes, []);
  await assert.rejects(run({ table: "push_subscriptions", include: ["notes"] }, fakeDb()), /no includes/);
});

test("a database error is operational, not do-not-retry", async () => {
  const db = fakeDb({ items: { data: null, error: { message: "boom" }, count: null } });
  await assert.rejects(run({ table: "items" }, db), (e) => /get_records failed: boom/.test(e.message) && !/Do NOT retry/.test(e.message));
});

test("include memberships: collections and groups an item belongs to", async () => {
  const db = fakeDb({
    items: { data: [{ id: "i1", name: "Rice" }, { id: "i2", name: "Dal" }], error: null, count: 2 },
    collection_items: { data: [{ item_id: "i1", collection_id: "c1" }], error: null },
    item_group_members: { data: [{ group_id: "g1", member_id: "i1" }, { group_id: "g1", member_id: "i2" }], error: null },
    item_collections: { data: [{ id: "c1", name: "Pantry", archived: false }], error: null },
    item_groups: { data: [{ id: "g1", name: null, group_type_id: "menu", archived: false }], error: null },
    group_types: { data: [{ id: "menu", label_singular: "Menu" }], error: null },
  });
  const out = await run({ table: "items", include: ["memberships"] }, db);
  assert.deepEqual(out.data[0].memberships, [
    { kind: "collection", id: "c1", name: "Pantry", archived: false },
    { kind: "group", id: "g1", name: null, archived: false, group_type: "Menu" },
  ]);
  assert.deepEqual(out.data[1].memberships.map((x) => x.kind), ["group"]);
  assert.ok(db.calls.some(([t, k, c, v]) => t === "item_group_members" && k === "eq" && c === "member_type" && v === "item"));
  assert.ok(db.calls.some(([t, k, c]) => t === "item_group_members" && k === "is" && c === "removed_at"));
});

test("readItems (get_items): the search RPC gets every option; rows previewed; elements on request", async () => {
  const db = fakeDb(
    { items: { data: [{ id: "i1", elements: [{ step: 1 }] }], error: null }, contexts: { data: [{ id: "c1", name: "Home" }], error: null } },
    { rows: [{ id: "i1", name: "Rice", description: "x".repeat(250), context_id: "c1", status: "active" }], total: 30 },
  );
  const out = await m.readItems({ db }, "get_items",
    { search_text: "rice beans", status: ["active"], tags: ["food"], offset: 20, limit: 5, include: ["elements"], no_context: false, context_id: "c1" },
    { text: "rice beans", status: ["active"], contextNames: false });
  const [, , p] = db.calls.find(([k, n]) => k === "rpc" && n === "platform_search_items");
  assert.deepEqual(p, { p_context_id: "c1", p_search_text: "rice beans", p_tags: ["food"], p_limit: 5, p_status: ["active"],
    p_offset: 20, p_archived: "exclude", p_no_context: false });
  assert.match(out.data[0].description, /\[cut: 250 chars/);
  assert.deepEqual(out.data[0].elements, [{ step: 1 }]);
  assert.equal(out.meta.next_offset, 21);
  assert.ok(!(out.meta.notes ?? []).some((n) => /Heavy columns/.test(n)));
});

test("readItems (search_items): context names, and by ids goes to the table", async () => {
  const db = fakeDb({ contexts: { data: [{ id: "c1", name: "Home" }], error: null } },
    { rows: [{ id: "i1", name: "Rice", context_id: "c1" }], total: 1 });
  const out = await m.readItems({ db }, "search_items", { query: "rice" }, { text: "rice", status: m.LIVE_STATUSES, contextNames: true });
  assert.equal(out.data[0].context_name, "Home");
  assert.deepEqual(db.calls.find(([k, n]) => k === "rpc" && n === "platform_search_items")[2].p_status, ["someday", "active", "background"]);
  const db2 = fakeDb({ items: { data: [{ id: "i9", name: "X", elements: [] }], error: null, count: 1 }, contexts: { data: [], error: null } });
  await m.readItems({ db: db2 }, "search_items", { query: "x", ids: ["i9"] }, { text: "x", contextNames: true });
  assert.ok(!db2.calls.some(([k, n]) => k === "rpc" && n === "platform_search_items"));
  assert.ok(selectOf(db2, "items").includes("elements"));
});

test("withCollectionMembers keeps position order and flags unreadable items", async () => {
  const db = fakeDb({
    collection_items: { data: [
      { collection_id: "c1", item_id: "a", quantity: "2", position: 1 },
      { collection_id: "c1", item_id: "gone", quantity: null, position: 2 }], error: null },
    items: { data: [{ id: "a", name: "Apples" }], error: null },
  });
  const [c] = await m.withCollectionMembers(db, [{ id: "c1", name: "Groceries" }]);
  assert.deepEqual(c.items, [
    { item_id: "a", name: "Apples", quantity: "2" },
    { item_id: "gone", name: null, quantity: null, unavailable: true },
  ]);
});
