// Handler tests for arnold.ts.
//
// Run:
//   node --experimental-strip-types --test supabase/functions/_shared/tools/arnold.test.mjs
//
// The real platform.ts and shared read run (test-platform.mjs); only defineTool is replaced.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTool, settingsFor, withSettings } from "./test-platform.mjs";

const m = await loadTool("arnold.ts");
const PLAN_SETTINGS = settingsFor("arnold_plans", ["id", "user_id", "status", "starts_on", "ended_at",
  "supersedes_plan_id", "focus", "change_summary", "internal_notes", "review_instructions", "nudge_instructions",
  "voice_notes", "review_cadence_days", "notification_settings", "prompt_templates", "created_at", "updated_at"]);

const PLAN_ID = "00000000-0000-4000-8000-000000000001";
const NEW_ID = "00000000-0000-4000-8000-000000000002";
const SETTINGS = { window_start: "05:00", window_end: "20:00", max_nudges_per_day: 3,
  max_encouragements_per_day: 2, inbox_waiting_delay_minutes: 120 };
const ACTIVE = { id: PLAN_ID, status: "active", starts_on: "2026-10-29", focus: "Yoga and microworkouts",
  nudge_instructions: "Nudge.", review_instructions: "Review.", voice_notes: null, review_cadence_days: 7,
  notification_settings: SETTINGS, prompt_templates: {} };
const MICRO = { goal_key: "microworkout", label: "Microworkouts", intent_id: "mur79qma8apmj8yc4i",
  measure: "elements", target: 5, period: "day", usual_days: [],
  pace_checkpoints: [{ time: "10:00", count: 1 }, { time: "19:00", count: 5 }] };
const YOGA = { goal_key: "yoga", label: "Yoga classes", intent_id: "yoga1", measure: "executions", target: 3,
  period: "week", usual_days: ["tue", "thu", "sun"], pace_checkpoints: [] };
const INTENTS = [{ id: "mur79qma8apmj8yc4i", text: "Micro Workout Rotation", archived: false },
  { id: "yoga1", text: "Yoga class", archived: false }, { id: "old1", text: "Old", archived: true }];

/**
 * Fake db. `tables[name]` is the rows a chain on that table resolves to (maybeSingle gives the first or null);
 * `rpcs[name]` answers db.rpc. Every call is logged.
 */
function fakeDb({ tables = {}, rpcs = {} } = {}) {
  const calls = [];
  const db = {
    calls,
    from(table) {
      let single = false;
      const b = new Proxy({}, {
        get: (_t, k) => {
          if (k === "then") {
            const rows = tables[table] ?? [];
            return (res) => res(single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null, count: rows.length });
          }
          return (...args) => { calls.push([table, k, ...args]); if (k === "maybeSingle") single = true; return b; };
        },
      });
      return b;
    },
    rpc(name, params) {
      calls.push(["rpc", name, params]);
      const r = rpcs[name];
      return Promise.resolve(typeof r === "function" ? r(params) : (r ?? { data: null, error: null }));
    },
  };
  return withSettings(db, [PLAN_SETTINGS]);
}

const OK_VALIDATORS = {
  arnold_notification_settings_problem: { data: null, error: null },
  arnold_prompt_templates_problem: { data: null, error: null },
  arnold_pace_checkpoints_problem: { data: null, error: null },
};

test("tiers: reads are 1, create is 3 with a propose", () => {
  assert.equal(m.getArnoldPlanTool.tier, 1);
  assert.equal(m.getArnoldProgressTool.tier, 1);
  assert.equal(m.createArnoldPlanTool.tier, 3);
  assert.equal(typeof m.createArnoldPlanTool.propose, "function");
});

test("get_arnold_plan: active plan with goals in position order", async () => {
  const db = fakeDb({ tables: { arnold_plans: [ACTIVE], arnold_goals: [MICRO, YOGA] } });
  const out = await m.getArnoldPlanTool.handler({}, { db });
  assert.equal(out.plan.id, PLAN_ID);
  assert.equal(out.goals.length, 2);
  assert.ok(db.calls.some(([t, k, c, v]) => t === "arnold_plans" && k === "eq" && c === "status" && v === "active"));
  assert.ok(db.calls.some(([t, k, c]) => t === "arnold_goals" && k === "order" && c === "position"));
});

test("get_arnold_plan: no active plan is { plan: null }, not an error", async () => {
  const out = await m.getArnoldPlanTool.handler({}, { db: fakeDb() });
  assert.deepEqual(out, { plan: null, goals: [] });
});

test("get_arnold_plan: an unknown plan_id is an error", async () => {
  await assert.rejects(m.getArnoldPlanTool.handler({ plan_id: NEW_ID }, { db: fakeDb() }), /not found/);
  await assert.rejects(m.getArnoldPlanTool.handler({ plan_id: "x" }, { db: fakeDb() }), /must be a UUID/);
});

test("get_arnold_plan: history is a shared list read, newest first", async () => {
  const db = fakeDb({ tables: { arnold_plans: [ACTIVE] } });
  const out = await m.getArnoldPlanTool.handler({ history: true }, { db });
  assert.equal(out.data.length, 1);
  assert.ok(db.calls.some(([t, k, c, o]) => t === "arnold_plans" && k === "order" && c === "created_at" && !o.ascending));
});

test("shapeErrors: unknown fields (pauses, nudge_rules) and duplicate goal keys", () => {
  const errors = m.shapeErrors({ focus: "f", review_instructions: "r", nudge_instructions: "n", pauses: [] },
    [{ ...MICRO, nudge_rules: [] }, MICRO]);
  assert.ok(errors.some((e) => /plan: unknown field "pauses"/.test(e)));
  assert.ok(errors.some((e) => /unknown field "nudge_rules"/.test(e)));
  assert.ok(errors.some((e) => /listed more than once/.test(e)));
});

test("propose: refuses before approval — archived intention and a validator message", async () => {
  const db = fakeDb({
    tables: { intents: INTENTS },
    rpcs: { ...OK_VALIDATORS, arnold_pace_checkpoints_problem: { data: "pace checkpoint times must be in increasing order.", error: null } },
  });
  const args = { plan: { focus: "f", review_instructions: "r", nudge_instructions: "n", notification_settings: SETTINGS },
    goals: [{ ...YOGA, intent_id: "old1" }] };
  await assert.rejects(m.createArnoldPlanTool.propose(args, { db }),
    (e) => /archived/.test(e.message) && /increasing order/.test(e.message) && /Nothing was proposed or written/.test(e.message));
});

test("propose: change_summary required when an active plan exists", async () => {
  const db = fakeDb({ tables: { intents: INTENTS, arnold_plans: [ACTIVE], arnold_goals: [MICRO] }, rpcs: OK_VALIDATORS });
  const args = { plan: { focus: "f", review_instructions: "r", nudge_instructions: "n", notification_settings: SETTINGS },
    goals: [MICRO] };
  await assert.rejects(m.createArnoldPlanTool.propose(args, { db }), /change_summary is required/);
});

test("propose: a readable before and after against the active plan", async () => {
  const db = fakeDb({ tables: { intents: INTENTS, arnold_plans: [ACTIVE], arnold_goals: [MICRO] }, rpcs: OK_VALIDATORS });
  const args = {
    plan: { focus: "Add yoga", change_summary: "Yoga three times a week.", review_instructions: "Review.",
      nudge_instructions: "Nudge.", notification_settings: { ...SETTINGS, max_nudges_per_day: 4 } },
    goals: [{ ...MICRO, target: 6 }, YOGA],
  };
  const out = await m.createArnoldPlanTool.propose(args, { db });
  assert.match(out.text, /Replaces the plan that started 2026-10-29/);
  assert.match(out.text, /CHANGED Microworkouts \(microworkout\): 6 elements a day/);
  assert.match(out.text, /was: Microworkouts \(microworkout\): 5 elements a day/);
  assert.match(out.text, /NEW Yoga classes \(yoga\): 3 executions a week, usually tue\/thu\/sun — intention "Yoga class"/);
  assert.match(out.text, /max_nudges_per_day 4 \(was 3\)/);
  assert.equal(out.supersedes_plan.id, PLAN_ID);
  assert.ok(!db.calls.some(([t, k]) => ["insert", "update", "upsert", "delete"].includes(k)), "propose must not write");
  assert.ok(!db.calls.some(([t, n]) => t === "rpc" && n === "arnold_create_plan"));
});

test("create handler: calls arnold_create_plan and returns the new plan with goals", async () => {
  const db = fakeDb({ tables: { arnold_plans: [{ ...ACTIVE, id: NEW_ID }], arnold_goals: [MICRO] },
    rpcs: { arnold_create_plan: { data: NEW_ID, error: null } } });
  const args = { plan: { focus: "f" }, goals: [MICRO], confirmed: true };
  const out = await m.createArnoldPlanTool.handler(args, { db });
  const call = db.calls.find(([t, n]) => t === "rpc" && n === "arnold_create_plan");
  assert.deepEqual(call[2], { p_plan: { focus: "f" }, p_goals: [MICRO] });
  assert.equal(out.plan.id, NEW_ID);
  assert.equal(out.goals.length, 1);
});

test("create handler: a database refusal is a validation error with its message", async () => {
  const db = fakeDb({ rpcs: { arnold_create_plan: { data: null,
    error: { code: "P0001", message: 'arnold_create_plan: unknown plan field "pauses".' } } } });
  await assert.rejects(m.createArnoldPlanTool.handler({ plan: { pauses: [] }, goals: [MICRO] }, { db }),
    /validation error: arnold_create_plan: unknown plan field "pauses"/);
});

test("get_arnold_progress: defaults to today, passes the range and plan", async () => {
  const db = fakeDb({ rpcs: { arnold_get_progress: { data: [{ goal_key: "microworkout", count: 2 }], error: null } } });
  const out = await m.getArnoldProgressTool.handler({}, { db });
  const call = db.calls.find(([t, n]) => t === "rpc" && n === "arnold_get_progress");
  assert.equal(call[2].p_date_from, out.range.today);
  assert.equal(call[2].p_date_to, out.range.today);
  assert.equal(call[2].p_plan_id, null);
  assert.equal(out.rows.length, 1);
});

test("get_arnold_progress: no active plan is { plan: null }", async () => {
  const db = fakeDb({ rpcs: { arnold_get_progress: { data: null,
    error: { code: "P0002", message: "arnold_get_progress: there is no active Arnold plan." } } } });
  const out = await m.getArnoldProgressTool.handler({ date_from: "2026-10-01", date_to: "2026-10-02" }, { db });
  assert.equal(out.plan, null);
  assert.deepEqual(out.rows, []);
});

test("get_arnold_progress: bad ranges are refused before the database", async () => {
  const db = fakeDb();
  await assert.rejects(m.getArnoldProgressTool.handler({ date_from: "2026-10-05", date_to: "2026-10-01" }, { db }), /after/);
  await assert.rejects(m.getArnoldProgressTool.handler({ date_from: "2026-01-01", date_to: "2026-10-01" }, { db }), /at most 93 days/);
  await assert.rejects(m.getArnoldProgressTool.handler({ date_to: "2026-13-01" }, { db }), /Pacific date/);
  assert.equal(db.calls.length, 0);
});

test("get_arnold_progress: goal_key filters; over 400 rows is cut with a note", async () => {
  const rows = Array.from({ length: 450 }, (_, i) => ({ goal_key: i % 2 ? "yoga" : "microworkout", count: i }));
  const db = fakeDb({ rpcs: { arnold_get_progress: { data: rows, error: null } } });
  const one = await m.getArnoldProgressTool.handler({ date_from: "2026-10-01", date_to: "2026-10-29", goal_key: "yoga" }, { db });
  assert.equal(one.rows.length, 225);
  const all = await m.getArnoldProgressTool.handler({ date_from: "2026-10-01", date_to: "2026-10-29" }, { db });
  assert.equal(all.data.rows.length, 400);
  assert.equal(all.meta.truncated, true);
  assert.equal(all.meta.total, 450);
});
