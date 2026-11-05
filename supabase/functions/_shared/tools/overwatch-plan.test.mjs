// Handler tests for overwatch-plan.ts.
// Run: node --experimental-strip-types --test supabase/functions/_shared/tools/overwatch-plan.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTool, settingsFor, withSettings } from "./test-platform.mjs";

const m = await loadTool("overwatch-plan.ts");
const SETTINGS = [
  settingsFor("overwatch_plans", ["id", "user_id", "active", "instructions", "settings", "checks_next_run", "written_by",
    "reason", "supersedes_id", "created_at"]),
  settingsFor("overwatch_watch", ["id", "user_id", "kind", "text", "app_id", "group_id", "intent_id", "starts_on", "ends_on",
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

test("get_delivery_rules: the active plan's delivery section, or null with a note", async () => {
  assert.equal(m.getDeliveryRulesTool.tier, 1);
  const delivery = { window: { start: "05:00", end: "20:00" } };
  const db = fakeDb(() => ({ data: { ...PLAN, settings: { ...PLAN.settings, delivery } }, error: null }));
  const out = await m.getDeliveryRulesTool.handler({}, { db });
  assert.deepEqual(out.delivery, delivery);
  assert.equal(out.plan_id, "p1");
  assert.ok(saw(db, "overwatch_plans", "eq", "active", true));
  const none = await m.getDeliveryRulesTool.handler({}, { db: fakeDb(() => ({ data: PLAN, error: null })) });
  assert.equal(none.delivery, null);
  assert.match(none.note, /no delivery section/);
});

test("create_overwatch_plan: a delivery section that is not an object is refused before the database", async () => {
  const db = fakeDb();
  await assert.rejects(m.createOverwatchPlanTool.handler({ ...planArgs, settings: { delivery: [1] } }, { db }),
    /settings\.delivery must be a JSON object/);
  assert.equal(db.calls.filter(([t]) => t === "rpc").length, 0);
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

test("watch intent_id: get returns it, create saves it, update sets and clears it", async () => {
  const read = fakeDb(() => ({ data: [{ id: "w1", intent_id: "i1" }], error: null, count: 1 }));
  const got = await m.getOverwatchWatchTool.handler({}, { db: read });
  assert.equal(got.data[0].intent_id, "i1");
  assert.match(read.calls.find(([, k]) => k === "select")[2], /\bintent_id\b/);

  const ins = fakeDb(() => ({ data: { id: "w1" }, error: null }));
  await m.createOverwatchWatchTool.handler({ kind: "focus", text: "x", ends_on: "2099-01-01", intent_id: " i1 " }, { db: ins });
  assert.equal(ins.calls.find(([, k]) => k === "insert")[2].intent_id, "i1");
  assert.match(ins.calls.find(([, k]) => k === "select")[2], /\bintent_id\b/);
  const none = fakeDb(() => ({ data: { id: "w1" }, error: null }));
  await m.createOverwatchWatchTool.handler({ kind: "focus", text: "x", ends_on: "2099-01-01" }, { db: none });
  assert.equal(none.calls.find(([, k]) => k === "insert")[2].intent_id, null);

  const set = fakeDb(() => ({ data: { id: "w1" }, error: null }));
  await m.updateOverwatchWatchTool.handler({ id: "w1", intent_id: "i2" }, { db: set });
  assert.deepEqual(set.calls.find(([, k]) => k === "update")[2], { intent_id: "i2" });
  const clear = fakeDb(() => ({ data: { id: "w1" }, error: null }));
  await m.updateOverwatchWatchTool.handler({ id: "w1", intent_id: null }, { db: clear });
  assert.deepEqual(clear.calls.find(([, k]) => k === "update")[2], { intent_id: null });

  const db = fakeDb();
  await assert.rejects(() => m.updateOverwatchWatchTool.handler({ id: "w1", intent_id: " " }, { db }), /intent_id must be non-empty/);
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

// ---------------------------------------------------------------------------
// add_delivery_override, end_delivery_override
// ---------------------------------------------------------------------------

const DELIVERY = { window: { start: "05:00", end: "20:00" }, defaults: { low: "hold", normal: "inbox", high: "pop", urgent: "pop" } };
const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
const SIGNALS = [
  { id: "s1", app: "dj", job: "dj-daily", severity: "high", subject_key: "dj:daily:x", title: "New DJ album", state: "delivered",
    outcome: "pop", reason: "high signals default to pop", details: {}, created_at: ago(5) },
  { id: "s2", app: "arnold", job: "hourly", severity: "normal", subject_key: "arnold:sleep", title: "Sleep", state: "delivered",
    outcome: "inbox", reason: "normal signals default to inbox", details: {}, created_at: ago(4) },
  { id: "s3", app: "warren_buffet", job: "wb-sync", severity: "high", subject_key: "wb-sync:failure", title: "Sync failed",
    state: "delivered", outcome: "inbox", reason: "high signals default to pop; the hourly cap stops the pop, an inbox item instead",
    details: { kind: "failure" }, created_at: ago(3) },
];

/** A plan with a delivery section, signals for the replay, and RPC answers for the check and the save. */
function overrideDb({ overrides = [], problem = null } = {}) {
  const plan = { ...PLAN, settings: { ...PLAN.settings, delivery: { ...DELIVERY, overrides } } };
  return fakeDb((table) => (table === "signals" ? { data: SIGNALS, error: null } : { data: plan, error: null }),
    (name) => (name === "overwatch_delivery_problem" ? { data: problem, error: null } : { data: { id: "p2" }, error: null }));
}
const rpcs = (db, name) => db.calls.filter(([t, n]) => t === "rpc" && n === name);
const DJ = { label: "DJ is too chatty", match: { app: "dj" }, effect: { decision: "inbox" } };

test("add_delivery_override: tier 3; a dry run by default checks, replays the week, and saves nothing", async () => {
  assert.equal(m.addDeliveryOverrideTool.tier, 3);
  assert.deepEqual(m.addDeliveryOverrideTool.tables, { reads: ["overwatch_plans", "signals"], writes: ["overwatch_plans"] });
  const db = overrideDb();
  const out = await m.addDeliveryOverrideTool.handler({ override: DJ, reason: "Alex asked" }, { db, confirmed: true });
  assert.equal(out.saved, false);
  assert.equal(out.dry_run, true);
  assert.equal(rpcs(db, "create_overwatch_plan").length, 0);
  const [, , checked] = rpcs(db, "overwatch_delivery_problem")[0];
  assert.equal(checked.p.overrides.length, 1);
  assert.equal(checked.p.overrides[0].label, "DJ is too chatty");
  assert.ok(Date.parse(checked.p.overrides[0].created_at) <= Date.now());
  assert.equal(checked.p.overrides[0].created_by, "chat");
  assert.deepEqual(out.changed.map((c) => [c.signal_id, c.before, c.after]), [["s1", "notification", "inbox item"]]);
  assert.equal(out.checked, 3);
  assert.match(out.note, /not a full re-run/);
  assert.ok(saw(db, "signals", "neq", "state", "resolved"));

  const prop = await m.addDeliveryOverrideTool.propose({ override: DJ, reason: "Alex asked" }, { db: overrideDb() });
  assert.equal(prop.saved, false);
  assert.equal(prop.changed.length, 1);
});

test("add_delivery_override: dry_run false saves one new plan version changing only the overrides", async () => {
  const db = overrideDb({ overrides: [{ label: "Old", effect: { decision: "inbox" } }] });
  const out = await m.addDeliveryOverrideTool.handler({ override: DJ, reason: "Alex asked", dry_run: false }, { db });
  assert.equal(out.saved, true);
  assert.equal(out.plan_id, "p2");
  const [, , p] = rpcs(db, "create_overwatch_plan")[0];
  assert.equal(p.p_instructions, PLAN.instructions);
  assert.equal(p.p_reason, "Alex asked");
  assert.equal(p.p_checks, null);
  assert.equal(p.p_settings.stall_days, 5);
  assert.deepEqual(p.p_settings.delivery.window, DELIVERY.window);
  assert.deepEqual(p.p_settings.delivery.overrides.map((o) => o.label), ["Old", "DJ is too chatty"]);
});

test("add_delivery_override: refusals in plain words, before anything is saved", async () => {
  const live = overrideDb({ overrides: [{ label: "dj is too chatty", effect: { decision: "inbox" } }] });
  await assert.rejects(m.addDeliveryOverrideTool.handler({ override: DJ, reason: "x", dry_run: false }, { db: live }),
    /already in the plan and has not ended/);
  const ended = overrideDb({ overrides: [{ label: "DJ is too chatty", when: { ends_at: ago(1) }, effect: { decision: "inbox" } }] });
  await m.addDeliveryOverrideTool.handler({ override: DJ, reason: "again", dry_run: false }, { db: ended });
  assert.deepEqual(rpcs(ended, "create_overwatch_plan")[0][2].p_settings.delivery.overrides.length, 1, "the ended one is replaced");

  const refused = overrideDb({ problem: "Override 1 ('Mute DJ') holds signals, so it must end: give when.ends_at." });
  await assert.rejects(m.addDeliveryOverrideTool.handler({ override: { label: "Mute DJ", effect: { decision: "hold" } },
    reason: "x", dry_run: false }, { db: refused }), /must end: give when\.ends_at/);
  assert.equal(rpcs(refused, "create_overwatch_plan").length, 0);

  const db = overrideDb();
  await assert.rejects(m.addDeliveryOverrideTool.handler({ override: { ...DJ, created_at: "x" }, reason: "x" }, { db }),
    /unknown keys: created_at/);
  await assert.rejects(m.addDeliveryOverrideTool.handler({ override: DJ }, { db }), /reason is required/);
  await assert.rejects(m.addDeliveryOverrideTool.handler({ override: { effect: {} }, reason: "x" }, { db }), /label is required/);
  await assert.rejects(m.addDeliveryOverrideTool.handler({ override: DJ, reason: "x", dry_run: "no" }, { db }), /dry_run must be/);
  const none = fakeDb(() => ({ data: PLAN, error: null }));
  await assert.rejects(m.addDeliveryOverrideTool.handler({ override: DJ, reason: "x" }, { db: none }), /no delivery section/);
});

test("decision estimates: severity, merge false, window and pace exemptions, kind failure", () => {
  const d = DELIVERY.defaults;
  assert.equal(m.decisionWith({ label: "x", effect: { severity: -1 } }, SIGNALS[1], d), "hold");
  assert.equal(m.decisionWith({ label: "x", effect: { pace: { exempt: true } } }, SIGNALS[2], d), "pop");
  assert.equal(m.decisionWith({ label: "x", effect: { window: { ignore: true } } },
    { ...SIGNALS[1], reason: "outside the window 05:00-20:00", state: "queued" }, d), "pop");
  const merged = { ...SIGNALS[1], state: "merged", outcome: null };
  assert.equal(m.decisionWith({ label: "x", effect: { merge: false } }, merged, d), "inbox");
  assert.equal(m.decisionWith({ label: "x", effect: { decision: "notify" } }, merged, d), null, "a merge still merges");
  assert.equal(m.decisionWith({ label: "x", effect: { decision: "drop" } }, merged, d), "drop");
  assert.ok(m.overrideApplies({ label: "x", match: { kind: ["failure"] } }, SIGNALS[2], null));
  assert.ok(!m.overrideApplies({ label: "x", match: { kind: ["failure"] } }, SIGNALS[0], null));
  assert.ok(m.overrideApplies({ label: "x", match: { subject_key: "dj:*", severity: ["high"] } }, SIGNALS[0], null));
  const at = new Date("2026-11-05T18:00:00Z"); // Thu 10:00 AM Pacific
  assert.ok(m.overrideApplies({ label: "x", when: { days_of_week: ["thu"], time_from: "09:00", time_to: "11:00" } }, SIGNALS[0], at));
  assert.ok(!m.overrideApplies({ label: "x", when: { days_of_week: ["fri"] } }, SIGNALS[0], at));
  assert.ok(!m.overrideApplies({ label: "x", when: { time_from: "22:00", time_to: "09:30" } }, SIGNALS[0], at));
  assert.ok(!m.overrideApplies({ label: "x", when: { ends_at: "2026-11-05T17:00:00Z" } }, SIGNALS[0], at));
});

test("end_delivery_override: sets ends_at to now, dry-runs by default, and names what goes back", async () => {
  assert.equal(m.endDeliveryOverrideTool.tier, 3);
  const live = { ...DJ, created_at: ago(48) };
  const signals = [{ ...SIGNALS[0], outcome: "inbox", reason: "high signals default to pop; override 'DJ is too chatty': high to inbox" }];
  const plan = { ...PLAN, settings: { ...PLAN.settings, delivery: { ...DELIVERY, overrides: [live] } } };
  const mk = () => fakeDb((t) => (t === "signals" ? { data: signals, error: null } : { data: plan, error: null }),
    (n) => (n === "overwatch_delivery_problem" ? { data: null, error: null } : { data: { id: "p3" }, error: null }));
  const db = mk();
  const dry = await m.endDeliveryOverrideTool.handler({ label: "dj is too chatty", reason: "Better now" }, { db });
  assert.equal(dry.saved, false);
  assert.equal(rpcs(db, "create_overwatch_plan").length, 0);
  assert.deepEqual(dry.changed.map((c) => [c.before, c.after]), [["inbox item", "notification"]]);

  const db2 = mk();
  const out = await m.endDeliveryOverrideTool.handler({ label: "DJ is too chatty", reason: "Better now", dry_run: false }, { db: db2 });
  assert.equal(out.saved, true);
  assert.equal(out.removed, false);
  const [ended] = rpcs(db2, "create_overwatch_plan")[0][2].p_settings.delivery.overrides;
  assert.ok(Date.parse(ended.when.ends_at) <= Date.now());
  assert.equal(ended.effect.decision, "inbox", "kept, marked ended");

  await assert.rejects(m.endDeliveryOverrideTool.handler({ label: "Nope", reason: "x" }, { db: mk() }),
    /no override called 'Nope'. The plan's overrides: 'DJ is too chatty'/);
  const future = { ...PLAN, settings: { ...PLAN.settings, delivery: { ...DELIVERY,
    overrides: [{ ...DJ, when: { starts_at: new Date(Date.now() + 86400000).toISOString() } }] } } };
  const db3 = fakeDb((t) => (t === "signals" ? { data: [], error: null } : { data: future, error: null }),
    (n) => (n === "overwatch_delivery_problem" ? { data: null, error: null } : { data: { id: "p4" }, error: null }));
  const gone = await m.endDeliveryOverrideTool.handler({ label: "DJ is too chatty", reason: "Never mind", dry_run: false }, { db: db3 });
  assert.equal(gone.removed, true);
  assert.deepEqual(rpcs(db3, "create_overwatch_plan")[0][2].p_settings.delivery.overrides, []);
});
