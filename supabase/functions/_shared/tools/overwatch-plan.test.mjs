// Handler tests for overwatch-plan.ts.
// Run: node --experimental-strip-types --test supabase/functions/_shared/tools/overwatch-plan.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTool, settingsFor, withSettings } from "./test-platform.mjs";

const m = await loadTool("overwatch-plan.ts");
const SETTINGS = [
  settingsFor("overwatch_plans", ["id", "user_id", "active", "instructions", "settings", "checks_next_run", "written_by",
    "reason", "supersedes_id", "created_at"]),
  settingsFor("overwatch_watch", ["id", "user_id", "kind", "text", "app_id", "group_id", "starts_on", "ends_on",
    "created_by", "expiry_noted_at", "created_at"]),
  settingsFor("overwatch_notes", ["id", "user_id", "period", "for_date", "body", "flags", "plan_id", "created_at"]),
  settingsFor("claim_blocks", ["id", "user_id", "waiter_code", "holder_code", "item", "run_tag", "blocked_at",
    "last_seen_at", "repeat_count", "cleared_at", "created_at"]),
  settingsFor("process_friction", ["id", "user_id", "occurred_at", "what_happened", "process", "project_code",
    "suggested_fix", "pattern_id", "status", "wont_fix_reason", "resolved_by", "resolved_at", "created_at"]),
];
const PLAN = { id: "p1", instructions: "Watch everything.", settings: { stall_days: 5, push_time: "07:30" }, checks_next_run: [{}] };

function fakeDb(answer = () => ({ data: [], error: null, count: 0 }), rpcAnswer = () => ({ data: { id: "new" }, error: null })) {
  const calls = [];
  const builder = (table) => {
    const b = new Proxy({}, {
      get: (_t, k) => {
        if (k === "then") return (res) => res(answer(table, calls));
        if (k === "maybeSingle") return () => Promise.resolve(answer(table, calls));
        return (...a) => { calls.push([table, k, ...a]); return b; };
      },
    });
    return b;
  };
  return withSettings({
    calls,
    from: (t) => builder(t),
    rpc: (name, params) => { calls.push(["rpc", name, params]); return Promise.resolve(rpcAnswer(name, params)); },
  }, SETTINGS);
}
const saw = (db, table, k, ...a) => db.calls.some(([t, kk, ...aa]) => t === table && kk === k && JSON.stringify(aa) === JSON.stringify(a));
const planArgs = { instructions: "Watch everything.", settings: { stall_days: 7, push_time: "07:30" }, reason: "Slower stalls" };

test("pacificToday is the Los Angeles date", () => {
  assert.equal(m.pacificToday(new Date("2026-10-25T05:00:00Z")), "2026-10-24");
  assert.equal(m.pacificToday(new Date("2026-10-25T08:00:00Z")), "2026-10-25");
});

test("get_overwatch_plan reads the active plan whole; history drops the filter", async () => {
  const db = fakeDb();
  await m.getOverwatchPlanTool.handler({}, { db });
  assert.ok(saw(db, "overwatch_plans", "eq", "active", true));
  const all = fakeDb();
  await m.getOverwatchPlanTool.handler({ history: true }, { db: all });
  assert.ok(!all.calls.some(([, k, a]) => k === "eq" && a === "active"));
});

test("create_overwatch_plan proposes the change in words, and writes through the RPC", async () => {
  const db = fakeDb(() => ({ data: PLAN, error: null }));
  const prop = await m.createOverwatchPlanTool.propose(planArgs, { db });
  assert.match(prop.text, /Reason: Slower stalls/);
  assert.match(prop.text, /Instructions: unchanged/);
  assert.match(prop.text, /stall_days 5 -> 7/);
  assert.match(prop.text, /current 1 carry over/);
  await m.createOverwatchPlanTool.handler(planArgs, { db });
  const rpc = db.calls.find(([t]) => t === "rpc");
  assert.deepEqual(rpc, ["rpc", "create_overwatch_plan", {
    p_instructions: "Watch everything.", p_settings: { stall_days: 7, push_time: "07:30" }, p_reason: "Slower stalls",
    p_written_by: "alex", p_checks: null,
  }]);
  assert.equal(m.createOverwatchPlanTool.tier, 3);
});

test("create_overwatch_plan refuses before proposing", async () => {
  const db = fakeDb();
  await assert.rejects(() => m.createOverwatchPlanTool.propose({ ...planArgs, reason: " " }, { db }), /reason must be non-empty/);
  await assert.rejects(() => m.createOverwatchPlanTool.propose({ ...planArgs, settings: [] }, { db }), /settings must be a JSON object/);
  await assert.rejects(() => m.createOverwatchPlanTool.propose({ ...planArgs, written_by: "bob" }, { db }), /written_by must be one of/);
});

test("update_overwatch_checks checks each entry, then calls the RPC", async () => {
  const db = fakeDb();
  await m.updateOverwatchChecksTool.handler({ checks: [{ text: "Look at DJ", check_on: "2026-11-01", about: "dj" }] }, { db });
  assert.equal(db.calls[0][1], "update_overwatch_checks");
  await assert.rejects(() => m.updateOverwatchChecksTool.handler({ checks: [{ text: "x" }] }, { db }), /check_on is required/);
  await assert.rejects(() => m.updateOverwatchChecksTool.handler({}, { db }), /checks is required/);
});

test("watch: current by default; create needs an end and keeps dates in order", async () => {
  const db = fakeDb();
  await m.getOverwatchWatchTool.handler({ kind: "ease_off" }, { db });
  const today = m.pacificToday();
  assert.ok(saw(db, "overwatch_watch", "lte", "starts_on", today));
  assert.ok(saw(db, "overwatch_watch", "gte", "ends_on", today));
  const ins = fakeDb(() => ({ data: { id: "w1" }, error: null }));
  await m.createOverwatchWatchTool.handler({ kind: "focus", text: " SAM ", ends_on: "2099-01-01" }, { db: ins });
  const row = ins.calls.find(([, k]) => k === "insert")[2];
  assert.equal(row.text, "SAM");
  assert.equal(row.starts_on, today);
  await assert.rejects(() => m.createOverwatchWatchTool.handler({ kind: "focus", text: "x" }, { db }), /ends_on is required/);
  await assert.rejects(() => m.createOverwatchWatchTool.handler({ kind: "focus", text: "x", starts_on: "2026-11-02", ends_on: "2026-11-01" }, { db }),
    /before starts_on/);
  await assert.rejects(() => m.updateOverwatchWatchTool.handler({ id: "w1" }, { db }), /nothing to change/);
});

test("create_overwatch_note upserts the day's note with the active plan", async () => {
  const db = fakeDb((table) => (table === "overwatch_plans" ? { data: PLAN, error: null } : { data: { id: "n1" }, error: null }));
  await m.createOverwatchNoteTool.handler({ period: "nightly", for_date: "2026-10-24", body: "All quiet.", flags: { quiet: [] } }, { db });
  const up = db.calls.find(([, k]) => k === "upsert");
  assert.deepEqual(up[2], { period: "nightly", for_date: "2026-10-24", body: "All quiet.", flags: { quiet: [] }, plan_id: "p1" });
  assert.deepEqual(up[3], { onConflict: "user_id,period,for_date" });
  await assert.rejects(() => m.createOverwatchNoteTool.handler({ period: "daily", body: "x" }, { db }), /period must be one of/);
});

test("get_claim_blocks: either side by code, open ones, and no injection", async () => {
  const db = fakeDb();
  await m.getClaimBlocksTool.handler({ code: "overwatch-q4n", open: true }, { db });
  assert.ok(saw(db, "claim_blocks", "or", "waiter_code.eq.overwatch-q4n,holder_code.eq.overwatch-q4n"));
  assert.ok(saw(db, "claim_blocks", "is", "cleared_at", null));
  await assert.rejects(() => m.getClaimBlocksTool.handler({ code: "a,b" }, { db }), /must be a project code/);
});

test("update_app_profile upserts per app; null clears; unknown app named", async () => {
  const db = fakeDb(() => ({ data: { app_id: "dj" }, error: null }));
  await m.updateAppProfileTool.handler({ app_id: "dj", rhythm_days: 7, current_state: null }, { db });
  const up = db.calls.find(([, k]) => k === "upsert");
  assert.deepEqual(up[2], { app_id: "dj", current_state: null, rhythm_days: 7 });
  assert.deepEqual(up[3], { onConflict: "user_id,app_id" });
  const bad = fakeDb(() => ({ data: null, error: { code: "23503", message: "fk" } }));
  await assert.rejects(() => m.updateAppProfileTool.handler({ app_id: "nope", rhythm_days: 3 }, { db: bad }), /use an id from get_apps/);
  await assert.rejects(() => m.updateAppProfileTool.handler({ app_id: "dj", rhythm_days: 0 }, { db }), /1 to 365/);
  await assert.rejects(() => m.updateAppProfileTool.handler({ app_id: "dj" }, { db }), /nothing to change/);
});

test("record_seen_releases records only the new entries and says which were seen", async () => {
  const db = fakeDb((table, calls) =>
    calls.some(([t, k]) => t === table && k === "upsert") ? { data: null, error: null }
      : { data: [{ source: "claude_code_changelog", entry_key: "2.1.0" }], error: null });
  const out = await m.recordSeenReleasesTool.handler({ entries: [
    { source: "claude_code_changelog", entry_key: "2.1.0", title: "old" },
    { source: "claude_code_changelog", entry_key: "2.2.0", title: "new" },
    { source: "claude_code_changelog", entry_key: "2.2.0", title: "new again" },
  ] }, { db });
  assert.deepEqual(out.recorded.map((r) => r.entry_key), ["2.2.0"]);
  assert.equal(out.already_seen.length, 2);
  await assert.rejects(() => m.recordSeenReleasesTool.handler({ entries: [{ source: "blog", entry_key: "x", title: "x" }] }, { db }),
    /source must be one of/);
});

test("friction: named processes or skill:<name>; open by default; patterns and resolving", async () => {
  const db = fakeDb(() => ({ data: { id: "f1" }, error: null }));
  await m.logFrictionTool.handler({ what_happened: "Missed the step", process: "skill:cli-workflow", project_code: "overwatch-q4n" }, { db });
  assert.equal(db.calls.find(([, k]) => k === "insert")[2].process, "skill:cli-workflow");
  await assert.rejects(() => m.logFrictionTool.handler({ what_happened: "x", process: "random" }, { db }), /process must be one of/);

  const list = fakeDb();
  await m.getFrictionTool.handler({ process: "cli_testing_steps" }, { db: list });
  assert.ok(saw(list, "process_friction", "eq", "status", "open"));

  const id = "11111111-2222-3333-4444-555555555555";
  const up = fakeDb(() => ({ data: [{ id }], error: null }));
  const out = await m.updateFrictionTool.handler({ ids: [id], pattern_id: "new", resolved_by: "cli-workflow v2" }, { db: up });
  const patch = up.calls.find(([, k]) => k === "update")[2];
  assert.match(patch.pattern_id, /^[0-9a-f-]{36}$/);
  assert.equal(patch.status, "fixed");
  assert.equal(patch.resolved_by, "cli-workflow v2");
  assert.ok(patch.resolved_at);
  assert.equal(out.not_found, undefined);
  await assert.rejects(() => m.updateFrictionTool.handler({ ids: ["x"] }, { db: up }), /ids is required/);
  await assert.rejects(() => m.updateFrictionTool.handler({ ids: [id] }, { db: up }), /nothing to change/);
});

test("get_friction: status filter, all, and bad values", async () => {
  const db = fakeDb();
  await m.getFrictionTool.handler({ status: "wont_fix" }, { db });
  assert.ok(saw(db, "process_friction", "eq", "status", "wont_fix"));
  const all = fakeDb();
  await m.getFrictionTool.handler({ status: "all" }, { db: all });
  assert.ok(!all.calls.some(([, k, c]) => k === "eq" && c === "status"));
  await assert.rejects(() => m.getFrictionTool.handler({ status: "resolved" }, { db }), /status must be one of/);
});

test("update_friction: wont_fix needs a reason, open clears the stamp, fixed needs resolved_by", async () => {
  const id = "11111111-2222-3333-4444-555555555555";
  const patchOf = async (args) => {
    const db = fakeDb(() => ({ data: [{ id }], error: null }));
    await m.updateFrictionTool.handler({ ids: [id], ...args }, { db });
    return db.calls.find(([, k]) => k === "update")[2];
  };
  const w = await patchOf({ status: "wont_fix", wont_fix_reason: " one-off " });
  assert.deepEqual([w.status, w.wont_fix_reason, w.resolved_by, !!w.resolved_at], ["wont_fix", "one-off", "alex", true]);
  assert.deepEqual(await patchOf({ status: "open" }), { status: "open", resolved_by: null, resolved_at: null, wont_fix_reason: null });
  const f = await patchOf({ status: "fixed", resolved_by: "skill v3" });
  assert.equal(f.wont_fix_reason, null);

  const bad = (args, re) => assert.rejects(() => patchOf(args), re);
  await bad({ status: "wont_fix" }, /needs wont_fix_reason/);
  await bad({ status: "fixed" }, /needs resolved_by/);
  await bad({ status: "fixed", resolved_by: "x", wont_fix_reason: "y" }, /only for status wont_fix/);
  await bad({ status: "open", resolved_by: "x" }, /not open/);
  await bad({ status: "resolved" }, /status must be one of/);
});
