// Handler tests for overwatch-activity.ts.
// Run: node --experimental-strip-types --test supabase/functions/_shared/tools/overwatch-activity.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTool, settingsFor, withSettings } from "./test-platform.mjs";

const m = await loadTool("overwatch-activity.ts");
const SETTINGS = settingsFor("activity", ["id", "user_id", "occurred_at", "app_id", "context_id", "group_id",
  "target_type", "target_id", "kind", "title", "summary", "source", "source_ref", "tags", "created_at"]);

/** Fake ctx.db: chains are logged; `answer(table, calls)` gives each awaited result. */
function fakeDb(answer = () => ({ data: [], error: null, count: 0 })) {
  const calls = [];
  const builder = (table) => {
    const mine = [];
    const b = new Proxy({}, {
      get: (_t, k) => {
        if (k === "then") return (res) => res(answer(table, mine));
        if (k === "maybeSingle") return () => { mine.push(["maybeSingle"]); return Promise.resolve(answer(table, mine)); };
        return (...a) => { calls.push([table, k, ...a]); mine.push([k, ...a]); return b; };
      },
    });
    return b;
  };
  return withSettings({ calls, from: (t) => builder(t) }, [SETTINGS]);
}
const saw = (db, k, ...a) => db.calls.some(([, kk, ...aa]) => kk === k && JSON.stringify(aa) === JSON.stringify(a));

test("pacificMidnight follows daylight time", () => {
  assert.equal(m.pacificMidnight("2026-07-01"), "2026-07-01T07:00:00.000Z");
  assert.equal(m.pacificMidnight("2026-12-01"), "2026-12-01T08:00:00.000Z");
});

test("parseBound: a date's from is its midnight, its to the next midnight; times keep their offset", () => {
  assert.equal(m.parseBound("t", "from", "2026-10-24"), "2026-10-24T07:00:00.000Z");
  assert.equal(m.parseBound("t", "to", "2026-10-24"), "2026-10-25T07:00:00.000Z");
  assert.equal(m.parseBound("t", "from", "2026-10-24T09:00:00-07:00"), "2026-10-24T16:00:00.000Z");
  assert.equal(m.parseBound("t", "from", undefined), null);
  assert.throws(() => m.parseBound("t", "from", "2026-10-24T09:00:00"), /WITH offset/);
  assert.throws(() => m.parseBound("t", "to", "yesterday"), /Pacific date/);
});

test("get_activity pushes every filter into the query, tags by containment, newest first", async () => {
  const db = fakeDb();
  await m.getActivityTool.handler({
    from: "2026-10-01", to: "2026-10-24", kind: "done", source: "trigger", app_id: "dj",
    context_id: "c1", group_id: "g1", tag: "overwatch-test",
  }, { db });
  assert.ok(saw(db, "gte", "occurred_at", "2026-10-01T07:00:00.000Z"));
  assert.ok(saw(db, "lt", "occurred_at", "2026-10-25T07:00:00.000Z"));
  for (const [col, v] of [["kind", "done"], ["source", "trigger"], ["app_id", "dj"], ["context_id", "c1"], ["group_id", "g1"]]) {
    assert.ok(saw(db, "eq", col, v), col);
  }
  assert.ok(saw(db, "contains", "tags", ["overwatch-test"]));
  assert.ok(saw(db, "order", "occurred_at", { ascending: false }));
});

test("get_activity refuses bad filters before any read", async () => {
  const db = fakeDb();
  await assert.rejects(() => m.getActivityTool.handler({ kind: "finished" }, { db }), /kind must be one of/);
  await assert.rejects(() => m.getActivityTool.handler({ from: "2026-10-24", to: "2026-10-01" }, { db }), /from must be before to/);
  assert.equal(db.calls.length, 0);
});

test("log_activity inserts one row with defaults", async () => {
  const db = fakeDb((table, mine) =>
    mine.some(([k]) => k === "insert") ? { data: { id: "a1", title: "Shipped Step 4" }, error: null } : { data: null, error: null });
  const out = await m.logActivityTool.handler({
    kind: "progress", source: "cli", title: " Shipped Step 4 ", source_ref: "overwatch-q4n-s4-j2tc", tags: ["a", "a", "b"],
  }, { db });
  assert.equal(out.already_logged, false);
  const row = db.calls.find(([, k]) => k === "insert")[2];
  assert.equal(row.title, "Shipped Step 4");
  assert.equal(row.app_id, "alfred");
  assert.equal(row.target_type, "other");
  assert.deepEqual(row.tags, ["a", "b"]);
  assert.ok(saw(db, "eq", "source_ref", "overwatch-q4n-s4-j2tc"));
});

test("log_activity with a source_ref already logged returns that row and writes nothing", async () => {
  const db = fakeDb(() => ({ data: { id: "a0" }, error: null }));
  const out = await m.logActivityTool.handler({ kind: "progress", source: "cli", title: "x", source_ref: "r1" }, { db });
  assert.deepEqual(out, { id: "a0", already_logged: true });
  assert.ok(!db.calls.some(([, k]) => k === "insert"));
});

test("log_activity: a race on the unique index returns the winner", async () => {
  let reads = 0;
  const db = fakeDb((table, mine) => {
    if (mine.some(([k]) => k === "insert")) return { data: null, error: { code: "23505", message: "duplicate" } };
    reads += 1;
    return { data: reads === 1 ? null : { id: "won" }, error: null };
  });
  const out = await m.logActivityTool.handler({ kind: "done", source: "claude", title: "x", source_ref: "r2" }, { db });
  assert.deepEqual(out, { id: "won", already_logged: true });
});

test("log_activity refuses what the table would refuse, with a reason", async () => {
  const db = fakeDb();
  const base = { kind: "done", source: "claude", title: "x" };
  await assert.rejects(() => m.logActivityTool.handler({ ...base, source: "trigger" }, { db }), /written only by the database/);
  await assert.rejects(() => m.logActivityTool.handler({ ...base, kind: undefined }, { db }), /kind is required/);
  await assert.rejects(() => m.logActivityTool.handler({ ...base, title: "x".repeat(301) }, { db }), /one line/);
  await assert.rejects(() => m.logActivityTool.handler({ ...base, occurred_at: "2026-10-24" }, { db }), /WITH offset/);
  await assert.rejects(() => m.logActivityTool.handler({ ...base, tags: ["ok", ""] }, { db }), /non-empty strings/);
  await assert.rejects(() => m.logActivityTool.handler({ ...base, target_type: "song" }, { db }), /target_type must be one of/);
  assert.equal(db.calls.length, 0);
});
