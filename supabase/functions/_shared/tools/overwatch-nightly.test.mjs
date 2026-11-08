// Handler tests for overwatch-nightly.ts.
// Run: node --experimental-strip-types --test supabase/functions/_shared/tools/overwatch-nightly.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTool } from "./test-platform.mjs";

const m = await loadTool("overwatch-nightly.ts");
const T = m.getOverwatchNightlyCountsTool;

// tables: { name: rows | { error } }; each from() chain resolves to that table's rows.
function fakeDb(result = { data: { local_date: "2026-11-02", stalled: [] }, error: null }, tables = {}) {
  const calls = [];
  const reads = [];
  const from = (table) => {
    const q = { table, ops: [] };
    reads.push(q);
    const b = {};
    for (const op of ["select", "eq", "in", "gte", "lte", "order", "limit"]) {
      b[op] = (...a) => { q.ops.push([op, ...a]); return b; };
    }
    b.then = (res, rej) => {
      const t = tables[table] ?? [];
      return Promise.resolve(Array.isArray(t) ? { data: t, error: null } : { data: null, error: t.error }).then(res, rej);
    };
    return b;
  };
  return { calls, reads, from, rpc: (name, params) => { calls.push([name, params]); return Promise.resolve(result); } };
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

test("returns the function's object as bare data, plus dispatcher_checks", async () => {
  const out = await T.handler({}, { db: fakeDb() });
  assert.equal(out.local_date, "2026-11-02");
  assert.deepEqual(out.stalled, []);
  assert.deepEqual(out.dispatcher_checks.importance, []);
  assert.deepEqual(out.dispatcher_checks.failures, []);
});

test("no data from the function is returned unchanged, with no check reads", async () => {
  const db = fakeDb({ data: null, error: null });
  assert.equal(await T.handler({}, { db }), null);
  assert.equal(db.reads.length, 0);
});

test("a failed check read is reported, not thrown", async () => {
  const db = fakeDb(undefined, { signals: { error: { message: "canceling statement due to statement timeout", code: "57014" } } });
  const out = await T.handler({}, { db });
  assert.equal(out.local_date, "2026-11-02");
  assert.match(out.dispatcher_checks.error, /signals\) failed: canceling statement/);
});

test("check reads are bounded by as_of", async () => {
  const db = fakeDb();
  await T.handler({ as_of: "2026-11-06T04:20:00-08:00" }, { db });
  const runs = db.reads.find((r) => r.table === "platform_runs");
  assert.deepEqual(runs.ops.find((o) => o[0] === "gte"), ["gte", "started_at", "2026-11-05T12:20:00.000Z"]);
  assert.deepEqual(runs.ops.find((o) => o[0] === "in"), ["in", "status", ["failed", "partial"]]);
  const sig = db.reads.find((r) => r.table === "signals");
  assert.deepEqual(sig.ops.find((o) => o[0] === "gte"), ["gte", "created_at", "2026-11-05T00:20:00.000Z"]);
});

const AS_OF = "2026-11-06T12:20:00.000Z";
const sig = (o) => ({ id: "s1", app: "ken", job: "ken_seed_check", severity: "normal", subject_key: "ken:x", title: "t",
  state: "delivered", reason: "r", details: {}, created_at: "2026-11-06T08:00:00Z", decided_at: "2026-11-06T09:00:00Z", ...o });
const checks = (o = {}) => m.dispatcherChecks({ asOf: AS_OF, settings: null, signals: [], lastDeliveredAt: null, runs: [], ...o });

test("importance: a held failure or High signal is flagged, grouped by subject", () => {
  const out = checks({ signals: [
    sig({ id: "a", state: "held", details: { kind: "failure" }, subject_key: "ken:ken_seed_check:failure:x" }),
    sig({ id: "b", state: "held", details: { kind: "failure" }, subject_key: "ken:ken_seed_check:failure:x" }),
    sig({ id: "c", state: "held", severity: "high", subject_key: "arnold:review" }),
    sig({ id: "d", state: "held", severity: "low", subject_key: "wb-sync:failure:bank" }),
    sig({ id: "e", state: "delivered", severity: "urgent" }),
    sig({ id: "f", state: "held", severity: "high", decided_at: "2026-11-05T09:00:00Z" }),
  ] }).importance;
  assert.deepEqual(out.map((g) => [g.subject_key, g.held, g.signal_ids]),
    [["ken:ken_seed_check:failure:x", 2, ["a", "b"]], ["arnold:review", 1, ["c"]]]);
});

test("silence: hours since the last delivery against the default or the plan's threshold", () => {
  let s = checks({ lastDeliveredAt: "2026-11-04T12:20:00Z" }).silence;
  assert.deepEqual([s.hours_since, s.threshold_hours, s.threshold_from, s.silent], [48, 36, "default", true]);
  s = checks({ lastDeliveredAt: "2026-11-04T12:20:00Z", settings: { nightly_checks: { silence_hours: 72 } } }).silence;
  assert.deepEqual([s.threshold_hours, s.threshold_from, s.silent], [72, "plan", false]);
  s = checks({ lastDeliveredAt: "2026-11-06T10:20:00Z", settings: { nightly_checks: { silence_hours: "x" } } }).silence;
  assert.deepEqual([s.hours_since, s.threshold_from, s.silent], [2, "default", false]);
  assert.equal(checks().silence.silent, true);
});

test("silence: the counts' limits set the threshold", () => {
  const planned = { nightly_checks: { silence_hours: 72 } };
  let s = checks({ lastDeliveredAt: "2026-11-04T12:20:00Z", settings: planned,
    limits: { "nightly_checks.silence_hours": 72 } }).silence;
  assert.deepEqual([s.threshold_hours, s.threshold_from, s.silent], [72, "plan", false]);
  s = checks({ lastDeliveredAt: "2026-11-04T12:20:00Z", settings: {},
    limits: { "nightly_checks.silence_hours": 36 } }).silence;
  assert.deepEqual([s.threshold_hours, s.threshold_from, s.silent], [36, "default", true]);
});

test("the handler passes counts.limits to the silence check", async () => {
  const db = fakeDb({ data: { local_date: "2026-11-02", limits: { "nightly_checks.silence_hours": 500 } }, error: null });
  const out = await T.handler({}, { db });
  assert.equal(out.dispatcher_checks.silence.threshold_hours, 500);
});

test("silence: only broad hold or drop overrides in force are listed", () => {
  const o = (label, decision, match, when = {}) => ({ label, match, when, effect: { decision } });
  const settings = { delivery: { overrides: [
    o("all held", "hold", { severity: ["low", "normal"] }),
    o("ken dropped", "drop", { app: "ken" }),
    o("ended", "drop", {}, { ends_at: "2026-11-05T00:00:00Z" }),
    o("not yet", "hold", {}, { starts_at: "2026-11-07T00:00:00Z" }),
    o("inbox", "inbox", {}),
    o("all dropped", "drop", {}, { ends_at: "2026-11-10T00:00:00Z" }),
  ] } };
  assert.deepEqual(checks({ settings }).silence.broad_overrides.map((b) => [b.label, b.decision, b.ends_at]),
    [["all held", "hold", null], ["all dropped", "drop", "2026-11-10T00:00:00Z"]]);
});

test("failures: a failed run needs a failure signal, a partial one any signal", () => {
  const run = (o) => ({ id: "r1", app: "ken", job: "ken_seed_check", status: "failed", started_at: "2026-11-06T08:00:00Z",
    finished_at: "2026-11-06T08:05:00Z", details: { failure_kind: "ken_read" }, error_message: "boom", ...o });
  const out = checks({
    runs: [
      run({ id: "covered" }),
      run({ id: "flag-only", app: "sam", job: "daily_plan_review" }),
      run({ id: "partial-ok", app: "dj", job: "daily_history_sync", status: "partial" }),
      run({ id: "by-run-id", app: "warren_buffet", job: "wb_sync" }),
      run({ id: "nightly-partial", app: "overwatch", job: "nightly", status: "partial" }),
      run({ id: "old", started_at: "2026-11-05T08:00:00Z" }),
      run({ id: "none", app: "drive_mix", job: "daily_refresh" }),
    ],
    signals: [
      sig({ app: "ken", details: { kind: "failure" }, created_at: "2026-11-06T08:05:00Z" }),
      sig({ app: "sam", job: "daily_plan_review", details: { kind: "flag" }, subject_key: "sam:daily_plan_review:review_due" }),
      sig({ app: "dj", job: "daily_history_sync", details: { kind: "flag" } }),
      sig({ app: "warren_buffet", job: "other", details: { run_id: "by-run-id" } }),
    ],
  }).failures;
  assert.deepEqual(out.map((f) => f.run_id), ["flag-only", "none"]);
  assert.deepEqual(out[1], { run_id: "none", app: "drive_mix", job: "daily_refresh", status: "failed",
    started_at: "2026-11-06T08:00:00Z", failure_kind: "ken_read", error_message: "boom" });
});

test("failures: a failure subject_key counts as a failure signal", () => {
  const out = checks({
    runs: [{ id: "r", app: "warren_buffet", job: "wb_sync", status: "failed", started_at: "2026-11-06T08:00:00Z", details: {} }],
    signals: [sig({ app: "warren_buffet", job: "wb_sync", subject_key: "wb-sync:failure:bank", created_at: "2026-11-06T08:01:00Z" })],
  });
  assert.deepEqual(out.failures, []);
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
  for (const t of ["clips", "item_groups", "group_types", "project_plans", "overwatch_watch", "apps", "signals", "platform_runs"]) {
    assert.ok(T.tables.reads.includes(t), t);
  }
});
