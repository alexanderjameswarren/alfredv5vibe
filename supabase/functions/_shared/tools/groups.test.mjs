// Handler tests for groups.ts (Restructure P5 step 16).
//
// Run:
//   node --experimental-strip-types --test supabase/functions/_shared/tools/groups.test.mjs
//
// platform.ts is stubbed, as in apps.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "groups-"));
writeFileSync(join(dir, "platform.ts"), `
export const defineTool = (o) => o;
export const clampLimit = (n) => Math.min(n ?? 20, 50);
export const envelope = (data, meta = {}) => ({ data, meta });
`);
const IMPORT = 'from "../platform.ts";';
const src = readFileSync(join(HERE, "groups.ts"), "utf-8");
if (!src.includes(IMPORT)) throw new Error("groups.ts import line changed — update this test.");
writeFileSync(join(dir, "groups.ts"), src.replace(IMPORT, 'from "./platform.ts";'));
const m = await import(pathToFileURL(join(dir, "groups.ts")).href);

const TYPES = [
  { id: "menu", label_singular: "Menu", label_plural: "Menus", execution_mode: "together" },
  { id: "proj", label_singular: "Project", label_plural: "Projects", execution_mode: "separately" },
];

/** Fake db: each table resolves to its rows (with a count); every call is logged. */
function fakeDb(tables) {
  const calls = [];
  return {
    calls,
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
  assert.ok(q.some(([, k, n]) => k === "limit" && n === 1));
  assert.equal(out.data[0].context_name, "Home");
  assert.deepEqual(out.meta, { limit_applied: 1, truncated: true, total: 3 });
});

test("get_groups: an unknown type label names the real ones", async () => {
  await assert.rejects(
    m.getGroupsTool.handler({ group_type: "Series" }, { db: fakeDb({ group_types: TYPES }) }),
    /no group type is called "Series"\. Types: Menu, Project/,
  );
});
