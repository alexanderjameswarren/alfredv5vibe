// Handler tests for groups.ts (Restructure P5 step 16).
//
// Run:
//   node --experimental-strip-types --test supabase/functions/_shared/tools/groups.test.mjs
//
// The REAL platform.ts (jsr: imports stripped), platform-read.ts and records.ts
// are loaded, since get_groups runs on the shared readTable; only defineTool is
// replaced so the handler can be called with a fake ctx.db.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED = join(HERE, "..");
const dir = mkdtempSync(join(tmpdir(), "groups-"));
writeFileSync(join(dir, "platform.ts"), readFileSync(join(SHARED, "platform.ts"), "utf-8")
  .split("\n").filter((l) => !/^import .*"jsr:/.test(l)).join("\n"));
writeFileSync(join(dir, "platform-read.ts"), readFileSync(join(SHARED, "platform-read.ts"), "utf-8"));
writeFileSync(join(dir, "shim.ts"), `
export { clampLimit, finishRead, readTable, requireSettings } from "./platform.ts";
export const defineTool = (o) => o;
`);
const rewrite = (file) => {
  const src = readFileSync(join(HERE, file), "utf-8");
  if (!src.includes('from "../platform.ts";')) throw new Error(`${file} import line changed — update this test.`);
  writeFileSync(join(dir, file), src.replaceAll('from "../platform.ts";', 'from "./shim.ts";')
    .replaceAll('from "../platform-read.ts";', 'from "./platform-read.ts";'));
};
rewrite("records.ts");
rewrite("groups.ts");
const m = await import(pathToFileURL(join(dir, "groups.ts")).href);

const GROUP_SETTINGS = {
  table: "item_groups",
  columns: ["id", "user_id", "group_type_id", "context_id", "name", "description", "status", "pinned", "archived",
    "last_completed_at", "created_at", "updated_at"].map((name) => ({ name, type: "text" })),
  secret_columns: [], heavy_columns: [], has_context_id: true, has_archived: true, has_status: true,
};

const TYPES = [
  { id: "menu", label_singular: "Menu", label_plural: "Menus", execution_mode: "together" },
  { id: "proj", label_singular: "Project", label_plural: "Projects", execution_mode: "separately" },
];

/** Fake db: each table resolves to its rows (with a count); every call is logged. */
function fakeDb(tables) {
  const calls = [];
  return {
    calls,
    rpc: (name, params) => {
      calls.push(["rpc", name, params]);
      return Promise.resolve({ data: !params?.p_table || params.p_table === "item_groups" ? [GROUP_SETTINGS] : [], error: null });
    },
    from(table) {
      const b = new Proxy({}, {
        get: (_t, k) => {
          if (k === "then") {
            const rows = tables[table] ?? [];
            return (res) => res({ data: rows, error: null, count: tables[`${table}:count`] ?? rows.length });
          }
          return (...args) => { calls.push([table, k, ...args]); return b; };
        },
      });
      return b;
    },
  };
}

test("typeIdsFor: a label, singular or plural, any case; null when none given", () => {
  assert.deepEqual(m.typeIdsFor("project", TYPES), ["proj"]);
  assert.deepEqual(m.typeIdsFor("Menus", TYPES), ["menu"]);
  assert.deepEqual(m.typeIdsFor("Series", TYPES), []);
  assert.equal(m.typeIdsFor(undefined, TYPES), null);
});

test("shapeGroups: derived name from live members in order, type, context, own date", () => {
  const [g] = m.shapeGroups(
    [{ id: "g", name: null, group_type_id: "menu", context_id: "c", status: "active", pinned: true, last_completed_at: "2026-10-23T18:00:00Z" }],
    {
      types: TYPES,
      contexts: [{ id: "c", name: "Recipes" }],
      members: [
        { id: "b", group_id: "g", member_type: "item", member_id: "dal", position: 2 },
        { id: "a", group_id: "g", member_type: "item", member_id: "rice", position: 1 },
        { id: "z", group_id: "g", member_type: "item", member_id: "gone", position: 3 },
        { id: "i", group_id: "g", member_type: "intention", member_id: "shop", position: 4 },
      ],
      items: [
        { id: "rice", name: "Spanish Rice", status: "active" },
        { id: "dal", name: "Red Lentil Dal", status: "someday" },
        { id: "gone", name: "Old", status: "active", archived: true },
      ],
      intents: [{ id: "shop", text: "Buy lentils", status: "active" }],
      ownIntents: [{ id: "o", group_id: "g" }],
      events: [{ id: "e2", intent_id: "o", time: "2026-10-30" }, { id: "e1", intent_id: "o", time: "2026-10-25" }],
    },
  );
  assert.equal(g.name, "Spanish Rice + Red Lentil Dal + Buy lentils");
  assert.equal(g.name_is_derived, true);
  assert.deepEqual(g.type, { id: "menu", label: "Menu", execution_mode: "together" });
  assert.equal(g.context_name, "Recipes");
  assert.equal(g.pinned, true);
  assert.equal(g.own_intention_id, "o");
  assert.equal(g.scheduled_date, "2026-10-25");
  assert.deepEqual(g.members.map((x) => [x.type, x.id, x.status]), [
    ["item", "rice", "active"], ["item", "dal", "someday"], ["intention", "shop", "active"],
  ]);
});

test("shapeGroups: a typed name stays; no own intention means no date", () => {
  const [g] = m.shapeGroups([{ id: "p", name: "Kitchen remodel", group_type_id: "proj" }], { types: TYPES });
  assert.equal(g.name, "Kitchen remodel");
  assert.equal(g.name_is_derived, false);
  assert.equal(g.scheduled_date, null);
  assert.equal(g.status, "someday");
});

test("get_groups: live groups only, filters in the query, bounded, with a truncation total", async () => {
  const db = fakeDb({
    group_types: TYPES,
    item_groups: [{ id: "p", name: "Kitchen remodel", group_type_id: "proj", context_id: "c", status: "active" }],
    "item_groups:count": 3,
    contexts: [{ id: "c", name: "Home" }],
  });
  const out = await m.getGroupsTool.handler({ group_type: "Projects", context_id: "c", status: ["active"], limit: 1 }, { db });
  const q = db.calls.filter(([t]) => t === "item_groups");
  assert.ok(q.some(([, k, ...a]) => k === "eq" && a[0] === "archived" && a[1] === false));
  assert.ok(q.some(([, k, ...a]) => k === "eq" && a[0] === "context_id" && a[1] === "c"));
  assert.ok(q.some(([, k, ...a]) => k === "in" && a[0] === "status" && a[1][0] === "active"));
  assert.ok(q.some(([, k, ...a]) => k === "in" && a[0] === "group_type_id" && a[1][0] === "proj"));
  assert.ok(q.some(([, k, a, b]) => k === "range" && a === 0 && b === 0));
  assert.ok(q.some(([, k, c, o]) => k === "order" && c === "pinned" && o.ascending === false));
  assert.equal(out.data[0].context_name, "Home");
  assert.deepEqual(out.meta, { count: 1, limit_applied: 1, truncated: true, total: 3, next_offset: 1 });
});

test("get_groups: shared options — offset, ids, archived, include notes", async () => {
  const db = fakeDb({
    group_types: TYPES,
    item_groups: [{ id: "p", name: "Kitchen remodel", group_type_id: "proj", archived: true }],
    notes: [{ id: "n1", target_id: "p", body: "Call the plumber", created_at: "2026-10-23" }],
  });
  const out = await m.getGroupsTool.handler({ ids: ["p"], include: ["notes"] }, { db });
  const q = db.calls.filter(([t]) => t === "item_groups");
  assert.ok(q.some(([, k, c, v]) => k === "in" && c === "id" && v[0] === "p"));
  assert.ok(!q.some(([, k, c]) => k === "eq" && c === "archived"));
  assert.equal(out.data[0].archived, true);
  assert.equal(out.data[0].notes[0].body, "Call the plumber");
  const db2 = fakeDb({ group_types: TYPES });
  await m.getGroupsTool.handler({ offset: 20, archived: "only" }, { db: db2 });
  assert.ok(db2.calls.some(([t, k, c, v]) => t === "item_groups" && k === "eq" && c === "archived" && v === true));
  assert.ok(db2.calls.some(([t, k, a, b]) => t === "item_groups" && k === "range" && a === 20 && b === 39));
  await assert.rejects(m.getGroupsTool.handler({ include: ["memberships"] }, { db: fakeDb({ group_types: TYPES }) }), /Allowed: notes/);
});

test("get_groups: an unknown type label names the real ones", async () => {
  await assert.rejects(
    m.getGroupsTool.handler({ group_type: "Series" }, { db: fakeDb({ group_types: TYPES }) }),
    /no group type is called "Series"\. Types: Menu, Project/,
  );
});
