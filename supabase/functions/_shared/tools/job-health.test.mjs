// Tests for job-health.ts. Fake values only.
//
// Run:
//   node --experimental-strip-types --test supabase/functions/_shared/tools/job-health.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTool } from "./test-platform.mjs";

const m = await loadTool("job-health.ts");

const HEALTH = {
  since: "2026-11-17T18:00:00+00:00",
  watchdog: { last_run_at: "2026-11-17T20:45:00+00:00", minutes_since: 3, healthy: true, last_error: null },
  outage: { open: false, started_at: null, alerted_at: null, last_heartbeat_at: "2026-11-17T20:09:13+00:00",
            last_recovery_at: null, last_outage_started_at: null },
  stuck_runs: [{ id: "run-1", app: "warren_buffet", job: "wb-sync", swept: true, ran_minutes: 1904, max_run_minutes: 10 }],
  missed_runs: [],
};

function fakeDb(answer = { data: HEALTH, error: null }) {
  const calls = [];
  return {
    calls,
    from() { throw new Error("get_job_health must not read tables directly"); },
    rpc(name, params) { calls.push([name, params]); return Promise.resolve(typeof answer === "function" ? answer(params) : answer); },
  };
}

test("get_job_health: tier 1, read-only, declares its tables", () => {
  assert.equal(m.getJobHealthTool.name, "get_job_health");
  assert.equal(m.getJobHealthTool.tier, 1);
  assert.deepEqual(m.getJobHealthTool.tables, {
    reads: ["platform_runs", "platform_schedules", "job_health_state"], writes: [] });
});

test("get_job_health: no since → the RPC's own default, and the RPC's object comes back bare", async () => {
  const db = fakeDb();
  const out = await m.getJobHealthTool.handler({}, { db });
  assert.deepEqual(db.calls, [["get_job_health", {}]]);
  assert.deepEqual(out, HEALTH);
});

test("get_job_health: since is passed as p_since", async () => {
  const db = fakeDb();
  await m.getJobHealthTool.handler({ since: " 2026-11-17T09:40:00-08:00 " }, { db });
  assert.deepEqual(db.calls, [["get_job_health", { p_since: "2026-11-17T09:40:00-08:00" }]]);
  await m.getJobHealthTool.handler({ since: "2026-11-17T17:40:00Z" }, { db });
  assert.deepEqual(db.calls[1], ["get_job_health", { p_since: "2026-11-17T17:40:00Z" }]);
});

test("get_job_health: a since without a time zone, or not a timestamp, is refused before the database", async () => {
  const db = fakeDb();
  for (const bad of ["2026-11-17", "2026-11-17T09:40:00", "9:40 AM", "yesterday", 42]) {
    await assert.rejects(m.getJobHealthTool.handler({ since: bad }, { db }), /since must be an ISO timestamp/);
  }
  assert.equal(db.calls.length, 0);
});

test("get_job_health: a database error is reported, operational errors without do-not-retry wording", async () => {
  const db = fakeDb({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
  await assert.rejects(m.getJobHealthTool.handler({}, { db }), (err) => {
    assert.match(err.message, /^get_job_health: get_job_health failed: canceling statement/);
    assert.doesNotMatch(err.message, /do not retry/i);
    return true;
  });
  const refused = fakeDb({ data: null, error: { code: "P0001", message: "get_job_health needs a signed-in user" } });
  await assert.rejects(m.getJobHealthTool.handler({}, { db: refused }), /validation error: get_job_health needs a signed-in user/);
});

test("get_job_health: an unexpected shape is an error, not an empty all-clear", async () => {
  const db = fakeDb({ data: {}, error: null });
  await assert.rejects(m.getJobHealthTool.handler({}, { db }), /unexpected shape/);
});
