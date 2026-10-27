// Handler tests for overwatch-inventory.ts.
// Run: node --experimental-strip-types --test supabase/functions/_shared/tools/overwatch-inventory.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTool, settingsFor, withSettings } from "./test-platform.mjs";

const m = await loadTool("overwatch-inventory.ts");
const SETTINGS = [
  settingsFor("platform_inventory", ["id", "user_id", "kind", "name", "app_id", "reads", "writes", "reads_any", "location",
    "fingerprint", "last_changed_project", "details", "seen_at"]),
  settingsFor("platform_open_work", ["id", "user_id", "file", "line", "kind", "text", "project_code", "seen_at"]),
  settingsFor("finish_summaries", ["id", "user_id", "project_code", "branch", "merge_commit", "finished_at", "diff_stat",
    "migrations", "tools", "skills", "functions", "task_prompts", "paths", "reviewed_at", "reviewed_by_run", "created_at"]),
];
const ID = "11111111-2222-3333-4444-555555555555";

function fakeDb(answer = () => ({ data: [], error: null, count: 0 })) {
  const calls = [];
  const builder = (table) => {
    const b = new Proxy({}, {
      get: (_t, k) => {
        if (k === "then") return (res) => res(answer(table, calls));
        return (...a) => { calls.push([table, k, ...a]); return b; };
      },
    });
    return b;
  };
  return withSettings({ calls, from: (t) => builder(t) }, SETTINGS);
}
const saw = (db, table, k, ...a) => db.calls.some(([t, kk, ...aa]) => t === table && kk === k && JSON.stringify(aa) === JSON.stringify(a));

test("get_platform_inventory: filters, and table marks each row's use", async () => {
  const rows = [{ id: "a", kind: "tool", name: "create_inbox_item", reads: ["apps"], writes: ["inbox"] },
    { id: "b", kind: "tool", name: "update_inbox_item", reads: ["inbox"], writes: ["inbox"] }];
  const db = fakeDb((t, calls) => (calls.at(-1)?.[1] === "limit" && calls.at(-1)[2] === 10000
    ? { data: [{ kind: "tool" }, { kind: "tool" }, { kind: "skill" }], error: null }
    : { data: rows, error: null, count: 2 }));
  const r = await m.getPlatformInventoryTool.handler({ kind: "tool", name: "inbox", app_id: "alfred", table: "inbox" }, { db });
  assert.ok(saw(db, "platform_inventory", "eq", "kind", "tool"));
  assert.ok(saw(db, "platform_inventory", "ilike", "name", "%inbox%"));
  assert.ok(saw(db, "platform_inventory", "eq", "app_id", "alfred"));
  assert.ok(saw(db, "platform_inventory", "or", "reads.cs.{inbox},writes.cs.{inbox}"));
  assert.deepEqual(r.data.map((x) => x.uses), ["writes", "both"]);
  assert.ok(r.meta.notes.some((n) => n === "Inventory by kind: skill 1, tool 2."));
});

test("get_platform_inventory: reads_any, and bad values refused", async () => {
  const db = fakeDb();
  await m.getPlatformInventoryTool.handler({ reads_any: true }, { db });
  assert.ok(saw(db, "platform_inventory", "eq", "reads_any", true));
  await assert.rejects(m.getPlatformInventoryTool.handler({ kind: "widget" }, { db: fakeDb() }), /kind must be one of/);
  await assert.rejects(m.getPlatformInventoryTool.handler({ table: "inbox),or(x" }, { db: fakeDb() }), /table must be a table or view/);
  await assert.rejects(m.getPlatformInventoryTool.handler({ reads_any: "yes" }, { db: fakeDb() }), /reads_any must be true or false/);
});

test("usesOf and the name filter's escaping", () => {
  assert.equal(m.usesOf({ reads: ["a"], writes: [] }, "a"), "reads");
  assert.equal(m.usesOf({ reads: null, writes: ["a"] }, "a"), "writes");
  assert.equal(m.usesOf({ reads: [], writes: [] }, "a"), null);
});

test("get_open_work: file, project, kind, and live or history", async () => {
  let db = fakeDb();
  await m.getOpenWorkTool.handler({ file: "warren_buffet", where: "history", kind: "deferred_phase" }, { db });
  assert.ok(saw(db, "platform_open_work", "ilike", "file", "%warren\\_buffet%"));
  assert.ok(saw(db, "platform_open_work", "like", "file", "docs/history/%"));
  assert.ok(saw(db, "platform_open_work", "eq", "kind", "deferred_phase"));
  db = fakeDb();
  await m.getOpenWorkTool.handler({ where: "live", project_code: "overwatch-q4n" }, { db });
  assert.ok(saw(db, "platform_open_work", "not", "file", "like", "docs/history/%"));
  assert.ok(saw(db, "platform_open_work", "eq", "project_code", "overwatch-q4n"));
  await assert.rejects(m.getOpenWorkTool.handler({ where: "old" }, { db: fakeDb() }), /where must be one of/);
  await assert.rejects(m.getOpenWorkTool.handler({ project_code: "Bad Code" }, { db: fakeDb() }), /project code/);
});

test("get_finish_summaries: unreviewed by default, all drops it", async () => {
  let db = fakeDb();
  await m.getFinishSummariesTool.handler({}, { db });
  assert.ok(saw(db, "finish_summaries", "is", "reviewed_at", null));
  db = fakeDb();
  await m.getFinishSummariesTool.handler({ all: true, project_code: "overwatch-q4n" }, { db });
  assert.ok(!db.calls.some(([, k, c]) => k === "is" && c === "reviewed_at"));
  assert.ok(saw(db, "finish_summaries", "eq", "project_code", "overwatch-q4n"));
});

test("mark_finish_summaries_reviewed: stamps the run, reports the missing", async () => {
  const other = "99999999-2222-3333-4444-555555555555";
  const db = fakeDb(() => ({ data: [{ id: ID }], error: null }));
  const r = await m.markFinishSummariesReviewedTool.handler({ ids: [ID, other], run_id: "run-1" }, { db });
  const upd = db.calls.find(([, k]) => k === "update");
  assert.equal(upd[2].reviewed_by_run, "run-1");
  assert.match(upd[2].reviewed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(r.not_found, [other]);
  await assert.rejects(m.markFinishSummariesReviewedTool.handler({ ids: [ID] }, { db: fakeDb() }), /run_id is required/);
  await assert.rejects(m.markFinishSummariesReviewedTool.handler({ ids: ["x"], run_id: "r" }, { db: fakeDb() }), /ids is required/);
});
