// Handler tests for apps.ts.
//
// Run:
//   node --experimental-strip-types --test supabase/functions/_shared/tools/apps.test.mjs
//
// The real platform.ts and shared read run (test-platform.mjs); only defineTool is replaced.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTool, sawRange, settingsFor, withSettings } from "./test-platform.mjs";

const m = await loadTool("apps.ts");
const APPS_SETTINGS = settingsFor("apps", ["id", "name", "description", "icon", "path", "button_name", "created_at", "updated_at"]);

const APPS = [{ id: "arnold" }, { id: "jobs" }, { id: "warren_buffet" }];

/** Fake db: every chain resolves to `result`; the table and calls are logged. */
function fakeDb(result = { data: APPS, error: null }) {
  const calls = [];
  const db = {
    calls,
    from(table) {
      const b = new Proxy({}, {
        get: (_t, k) => {
          if (k === "then") return (res) => res(result);
          return (...args) => { calls.push([table, k, ...args]); return b; };
        },
      });
      return b;
    },
  };
  return withSettings(db, [APPS_SETTINGS]);
}

test("checkSourceApp: undefined leaves it alone, null and empty clear it", async () => {
  assert.equal(await m.checkSourceApp("t", undefined, fakeDb()), undefined);
  assert.equal(await m.checkSourceApp("t", null, fakeDb()), null);
  assert.equal(await m.checkSourceApp("t", "", fakeDb()), null);
});

test("checkSourceApp: a known id passes", async () => {
  assert.equal(await m.checkSourceApp("t", "jobs", fakeDb()), "jobs");
});

test("checkSourceApp: an unknown id names the valid ones", async () => {
  await assert.rejects(m.checkSourceApp("create_inbox_item", "job", fakeDb()), /unknown source_app "job"\. Valid ids: arnold, jobs, warren_buffet/);
});

test("checkSourceApp: a non-string is refused", async () => {
  await assert.rejects(m.checkSourceApp("t", 3, fakeDb()), /must be an app id string/);
});

test("get_apps: tier 1, every readable column, up to 50 by name, description whole", async () => {
  assert.equal(m.getAppsTool.tier, 1);
  const long = "d".repeat(300);
  const db = fakeDb({ data: [{ id: "jobs", name: "Jobs", description: long }], error: null, count: 1 });
  const out = await m.getAppsTool.handler({}, { db });
  assert.deepEqual(out.data, [{ id: "jobs", name: "Jobs", description: long }]);
  assert.deepEqual(db.calls.find((c) => c[1] === "select").slice(0, 3),
    ["apps", "select", "id, name, description, icon, path, button_name, created_at, updated_at"]);
  assert.ok(sawRange(db.calls, "apps", 0, 49));
  assert.ok(db.calls.some(([t, k, c, o]) => t === "apps" && k === "order" && c === "name" && o.ascending));
});
