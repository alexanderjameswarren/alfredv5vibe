// Handler tests for apps.ts.
//
// Run:
//   node --experimental-strip-types --test supabase/functions/_shared/tools/apps.test.mjs
//
// platform.ts is stubbed, as in reminders.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "apps-"));
writeFileSync(join(dir, "platform.ts"), `
export const defineTool = (o) => o;
export const clampLimit = (n) => Math.min(n ?? 20, 50);
export const envelope = (data, meta = {}) => ({ data, meta });
`);
const IMPORT = 'from "../platform.ts";';
const src = readFileSync(join(HERE, "apps.ts"), "utf-8");
if (!src.includes(IMPORT)) throw new Error("apps.ts import line changed — update this test.");
writeFileSync(join(dir, "apps.ts"), src.replace(IMPORT, 'from "./platform.ts";'));
const m = await import(pathToFileURL(join(dir, "apps.ts")).href);

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
  return db;
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

test("get_apps: tier 1, reads apps with every column, bounded", async () => {
  assert.equal(m.getAppsTool.tier, 1);
  const db = fakeDb({ data: [{ id: "jobs", name: "Jobs" }], error: null });
  const out = await m.getAppsTool.handler({}, { db });
  assert.deepEqual(out.data, [{ id: "jobs", name: "Jobs" }]);
  assert.deepEqual(db.calls[0], ["apps", "select", "id, name, description, icon, path, button_name"]);
  assert.ok(db.calls.some((c) => c[1] === "limit" && c[2] === 50));
});
