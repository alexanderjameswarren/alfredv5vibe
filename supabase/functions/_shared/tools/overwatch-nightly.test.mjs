// Handler tests for overwatch-nightly.ts.
// Run: node --experimental-strip-types --test supabase/functions/_shared/tools/overwatch-nightly.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTool } from "./test-platform.mjs";

const m = await loadTool("overwatch-nightly.ts");
const T = m.getOverwatchNightlyCountsTool;

function fakeDb(result = { data: { local_date: "2026-11-02", stalled: [] }, error: null }) {
  const calls = [];
  return { calls, rpc: (name, params) => { calls.push([name, params]); return Promise.resolve(result); } };
}

test("no as_of leaves the clock to the function", async () => {
  const db = fakeDb();
  await T.handler({}, { db });
  assert.deepEqual(db.calls, [["overwatch_nightly_counts", {}]]);
});

test("as_of is passed through", async () => {
  const db = fakeDb();
  await T.handler({ as_of: "2026-11-02T04:20:00-08:00" }, { db });
  assert.deepEqual(db.calls, [["overwatch_nightly_counts", { p_as_of: "2026-11-02T04:20:00-08:00" }]]);
});

test("a bad as_of is refused before any read", async () => {
  const db = fakeDb();
  for (const as_of of ["yesterday", "2026-11-02", "2026-11-02T04:20:00", "2026-13-40T04:20:00Z", 5]) {
    await assert.rejects(() => T.handler({ as_of }, { db }), /as_of must be an ISO timestamp/);
  }
  assert.equal(db.calls.length, 0);
});

test("returns the function's object as bare data", async () => {
  assert.deepEqual(await T.handler({}, { db: fakeDb() }), { local_date: "2026-11-02", stalled: [] });
});

test("a database error is retryable", async () => {
  const db = fakeDb({ data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } });
  await assert.rejects(() => T.handler({}, { db }), (e) => {
    assert.match(e.message, /get_overwatch_nightly_counts failed: canceling statement/);
    assert.doesNotMatch(e.message, /do not retry/i);
    return true;
  });
});

test("tier 1, reads only", () => {
  assert.equal(T.tier, 1);
  assert.deepEqual(T.tables.writes, []);
  for (const t of ["clips", "item_groups", "group_types", "project_plans", "overwatch_watch", "apps"]) {
    assert.ok(T.tables.reads.includes(t), t);
  }
});
