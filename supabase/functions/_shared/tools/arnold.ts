// ============================================================================
// supabase/functions/_shared/tools/arnold.ts
//
// Arnold (workout and wellbeing coach) — Claude's tools. Spec:
// docs/arnold_v1-technical-spec.md §5.
//
//   get_arnold_plan       tier 1  active plan with goals; a plan by id; or the version history
//   create_arnold_plan    tier 3  supersedes the active plan, via arnold_create_plan()
//   get_arnold_progress   tier 1  wraps arnold_get_progress()
//
// Every number, time, limit and instruction lives in the plan record; these tools
// hold none. Database access ONLY through ctx.db. The database validates plans
// (arnold_create_plan and its validators); `propose` calls the same validators so
// a plan that would be refused is refused before Alex is asked to approve it.
// ============================================================================

import { defineTool, envelope, readTable } from "../platform.ts";
import { dbError, fail, optionalDate, ptDate } from "./claude-notifications.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
type Row = Record<string, unknown>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_PROGRESS_DAYS = 93;
export const MAX_PROGRESS_ROWS = 400;

// The fields arnold_create_plan() accepts; it refuses anything else.
export const PLAN_FIELDS = ["focus", "change_summary", "internal_notes", "review_instructions", "nudge_instructions",
  "voice_notes", "review_cadence_days", "notification_settings", "prompt_templates", "starts_on"];
export const GOAL_FIELDS = ["goal_key", "label", "intent_id", "measure", "target", "period", "usual_days",
  "pace_checkpoints", "notes"];

const PLAN_COLS =
  "id, status, starts_on, ended_at, supersedes_plan_id, focus, change_summary, internal_notes, review_instructions, " +
  "nudge_instructions, voice_notes, review_cadence_days, notification_settings, prompt_templates, created_at, updated_at";
const GOAL_COLS =
  "id, plan_id, position, goal_key, label, intent_id, measure, target, period, usual_days, pace_checkpoints, notes, created_at";

function optionalUuid(tool: string, name: string, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !UUID_RE.test(v)) throw fail(tool, `\`${name}\` must be a UUID, got ${JSON.stringify(v)}.`);
  return v;
}

async function findPlan(db: Db, tool: string, planId: string | null): Promise<Row | null> {
  let q = db.from("arnold_plans").select(PLAN_COLS);
  q = planId ? q.eq("id", planId) : q.eq("status", "active");
  const { data, error } = await q.maybeSingle();
  if (error) throw dbError(tool, "plan lookup", error);
  if (!data && planId) throw fail(tool, `plan ${planId} not found.`);
  return (data as Row | null) ?? null;
}

async function planGoals(db: Db, tool: string, planId: unknown): Promise<Row[]> {
  const { data, error } = await db.from("arnold_goals").select(GOAL_COLS).eq("plan_id", planId).order("position");
  if (error) throw dbError(tool, "goals lookup", error);
  return (data ?? []) as Row[];
}

// ---------------------------------------------------------------------------
// get_arnold_plan — tier 1
// ---------------------------------------------------------------------------

export const getArnoldPlanTool = defineTool({
  name: "get_arnold_plan",
  tables: { reads: ["arnold_plans", "arnold_goals"], writes: [] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_arnold_plan";
    if (args.history === true) {
      // Version history: plan headers newest first, through the shared list read.
      return await readTable(ctx, {
        tool,
        table: "arnold_plans",
        args,
        order: [{ column: "created_at", ascending: false }],
        fullText: ["focus", "change_summary"],
      });
    }
    const plan = await findPlan(ctx.db, tool, optionalUuid(tool, "plan_id", args.plan_id));
    if (!plan) return { plan: null, goals: [] };
    return { plan, goals: await planGoals(ctx.db, tool, plan.id) };
  },
});

// ---------------------------------------------------------------------------
// create_arnold_plan — tier 3 (supersedes the active plan)
// ---------------------------------------------------------------------------

export function normalisePlanInput(tool: string, args: Record<string, unknown>) {
  const plan = args.plan;
  const goals = args.goals;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw fail(tool, "`plan` must be an object.");
  if (!Array.isArray(goals) || goals.length === 0) throw fail(tool, "`goals` must be a non-empty array.");
  return { plan: plan as Row, goals: goals as Row[] };
}

/** Shape errors the tool can see without the database; the database checks the rest. */
export function shapeErrors(plan: Row, goals: Row[]): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(plan)) {
    if (!PLAN_FIELDS.includes(k)) errors.push(`plan: unknown field "${k}". Allowed: ${PLAN_FIELDS.join(", ")}.`);
  }
  for (const k of ["focus", "review_instructions", "nudge_instructions"]) {
    if (typeof plan[k] !== "string" || (plan[k] as string).trim() === "") errors.push(`plan: ${k} is required.`);
  }
  const keys = new Set<string>();
  goals.forEach((g, i) => {
    const at = `goal ${i + 1}${typeof g?.goal_key === "string" ? ` "${g.goal_key}"` : ""}`;
    if (!g || typeof g !== "object" || Array.isArray(g)) {
      errors.push(`${at}: must be an object.`);
      return;
    }
    for (const k of Object.keys(g)) {
      if (!GOAL_FIELDS.includes(k)) errors.push(`${at}: unknown field "${k}". Allowed: ${GOAL_FIELDS.join(", ")}.`);
    }
    if (typeof g.goal_key === "string") {
      if (keys.has(g.goal_key)) errors.push(`${at}: goal_key is listed more than once.`);
      keys.add(g.goal_key);
    }
  });
  if (goals.length > 20) errors.push(`a plan may have at most 20 goals (got ${goals.length}).`);
  return errors;
}

/** The database's own validators, so the proposal and the write can never disagree. */
async function validatorErrors(db: Db, tool: string, plan: Row, goals: Row[]): Promise<string[]> {
  const errors: string[] = [];
  const check = async (fn: string, params: Row, label: string) => {
    const { data, error } = await db.rpc(fn, params);
    if (error) throw dbError(tool, fn, error);
    if (typeof data === "string" && data) errors.push(`${label}: ${data}`);
  };
  await check("arnold_notification_settings_problem", { p: plan.notification_settings ?? null }, "plan");
  await check("arnold_prompt_templates_problem", { p: plan.prompt_templates ?? {} }, "plan");
  for (const g of goals) {
    if (Number.isInteger(g.target)) {
      await check("arnold_pace_checkpoints_problem", { p: g.pace_checkpoints ?? [], p_target: g.target },
        `goal "${g.goal_key}"`);
    }
  }
  return errors;
}

const show = (v: unknown) => (v === undefined || v === null ? "none" : typeof v === "string" ? v : JSON.stringify(v));

function goalLine(g: Row, intentText: string | undefined): string {
  const days = Array.isArray(g.usual_days) && g.usual_days.length ? `, usually ${(g.usual_days as string[]).join("/")}` : "";
  const cps = Array.isArray(g.pace_checkpoints) && g.pace_checkpoints.length
    ? `, pace ${(g.pace_checkpoints as Row[]).map((c) => `${c.count} by ${c.time}`).join(", ")}`
    : "";
  return `${g.label} (${g.goal_key}): ${g.target} ${g.measure} a ${g.period}${days}${cps} — ` +
    `intention "${intentText ?? g.intent_id}"`;
}

/** A readable before-and-after for Alex, and early refusal of a plan the database would refuse. */
export async function proposePlan(db: Db, args: Record<string, unknown>) {
  const tool = "create_arnold_plan";
  const { plan, goals } = normalisePlanInput(tool, args);
  const errors = shapeErrors(plan, goals);

  const intentIds = [...new Set(goals.map((g) => g.intent_id).filter((v) => typeof v === "string"))];
  const intents = new Map<string, Row>();
  if (intentIds.length) {
    const { data, error } = await db.from("intents").select("id, text, archived").in("id", intentIds);
    if (error) throw dbError(tool, "intents lookup", error);
    for (const r of (data ?? []) as Row[]) intents.set(r.id as string, r);
  }
  goals.forEach((g) => {
    const it = intents.get(g.intent_id as string);
    if (!it) errors.push(`goal "${g.goal_key}": intention ${show(g.intent_id)} not found.`);
    else if (it.archived) errors.push(`goal "${g.goal_key}": intention "${it.text}" is archived.`);
  });
  errors.push(...await validatorErrors(db, tool, plan, goals));

  const active = await findPlan(db, tool, null);
  if (active && !(typeof plan.change_summary === "string" && plan.change_summary.trim())) {
    errors.push("plan: change_summary is required when replacing the active plan: say what changed and why.");
  }
  if (errors.length) {
    throw fail(tool, `${errors.length} validation error(s). Nothing was proposed or written:\n` + errors.join("\n"));
  }

  const oldGoals = active ? await planGoals(db, tool, active.id) : [];
  const text = (g: Row) => (intents.get(g.intent_id as string)?.text as string | undefined);
  const lines: string[] = [active
    ? `Replaces the plan that started ${active.starts_on} ("${active.focus}"). It stays in the history.`
    : "Arnold's first plan."];
  lines.push(`Focus: ${plan.focus}`);
  if (active) lines.push(`What changed and why: ${plan.change_summary}`);

  const oldByKey = new Map(oldGoals.map((g) => [g.goal_key as string, g]));
  lines.push("Goals:");
  for (const g of goals) {
    const before = oldByKey.get(g.goal_key as string);
    const now = goalLine(g, text(g));
    if (!active) lines.push(`  ${now}`);
    else if (!before) lines.push(`  NEW ${now}`);
    else {
      const was = goalLine(before, text(before) ?? undefined);
      lines.push(was === now ? `  unchanged: ${now}` : `  CHANGED ${now}\n      was: ${was}`);
    }
  }
  for (const [key, g] of oldByKey) {
    if (!goals.some((n) => n.goal_key === key)) lines.push(`  REMOVED ${g.label} (${key})`);
  }

  const settings = plan.notification_settings as Row;
  const was = (active?.notification_settings ?? {}) as Row;
  lines.push("Notifications: " + Object.keys(settings).map((k) =>
    active && JSON.stringify(was[k]) !== JSON.stringify(settings[k])
      ? `${k} ${show(settings[k])} (was ${show(was[k])})`
      : `${k} ${show(settings[k])}`).join(", "));
  const cadence = plan.review_cadence_days ?? 7;
  lines.push(`Review cadence: every ${cadence} days` +
    (active && active.review_cadence_days !== cadence ? ` (was ${active.review_cadence_days})` : ""));
  for (const k of ["nudge_instructions", "review_instructions", "voice_notes"]) {
    const changed = !active || (active[k] ?? null) !== (plan[k] ?? null);
    lines.push(`${k}${active ? (changed ? " (changed)" : " (unchanged)") : ""}: ${show(plan[k])}`);
  }
  const templates = Object.keys((plan.prompt_templates ?? {}) as Row);
  lines.push(`Prompt templates: ${templates.length ? templates.join(", ") : "none"}`);

  return {
    text: lines.join("\n"),
    supersedes_plan: active ? { id: active.id, starts_on: active.starts_on, focus: active.focus } : null,
    goal_count: goals.length,
  };
}

export const createArnoldPlanTool = defineTool({
  name: "create_arnold_plan",
  // Through arnold_create_plan.
  tables: { reads: ["arnold_plans", "arnold_goals", "intents"], writes: ["arnold_plans", "arnold_goals"] },
  tier: 3,
  propose: async (args: Record<string, unknown>, ctx) => proposePlan(ctx.db, args),
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "create_arnold_plan";
    const { plan, goals } = normalisePlanInput(tool, args);
    const { data, error } = await ctx.db.rpc("arnold_create_plan", { p_plan: plan, p_goals: goals });
    if (error) throw dbError(tool, "arnold_create_plan", error);
    const newId = typeof data === "string" ? data : ((Array.isArray(data) ? data[0] : data) as Row | null)?.arnold_create_plan;
    if (typeof newId !== "string") throw fail(tool, `arnold_create_plan returned no plan id (got ${JSON.stringify(data)}).`);
    const created = await findPlan(ctx.db, tool, newId);
    return { plan: created, goals: await planGoals(ctx.db, tool, newId) };
  },
});

// ---------------------------------------------------------------------------
// get_arnold_progress — tier 1
// ---------------------------------------------------------------------------

function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export const getArnoldProgressTool = defineTool({
  name: "get_arnold_progress",
  // Through arnold_get_progress.
  tables: { reads: ["arnold_plans", "arnold_goals", "executions"], writes: [] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_arnold_progress";
    const today = ptDate();
    const to = optionalDate(tool, "date_to", args.date_to) ?? today;
    const from = optionalDate(tool, "date_from", args.date_from) ?? to;
    if (from > to) throw fail(tool, `date_from (${from}) is after date_to (${to}).`);
    if (daysInclusive(from, to) > MAX_PROGRESS_DAYS) {
      throw fail(tool, `at most ${MAX_PROGRESS_DAYS} days per call (got ${daysInclusive(from, to)}).`);
    }
    const planId = optionalUuid(tool, "plan_id", args.plan_id);
    const goalKey = typeof args.goal_key === "string" && args.goal_key ? args.goal_key : null;

    const { data, error } = await ctx.db.rpc("arnold_get_progress", {
      p_date_from: from, p_date_to: to, p_plan_id: planId,
    });
    if (error) {
      // P0002: no active plan. Not an error for the caller, who may simply not have one yet.
      if (error.code === "P0002" && !planId) return { plan: null, range: { date_from: from, date_to: to, today }, rows: [] };
      throw dbError(tool, "arnold_get_progress", error);
    }
    let rows = (data ?? []) as Row[];
    if (goalKey) rows = rows.filter((r) => r.goal_key === goalKey);
    const range = { date_from: from, date_to: to, today };
    if (rows.length > MAX_PROGRESS_ROWS) {
      return envelope({ range, rows: rows.slice(0, MAX_PROGRESS_ROWS) }, {
        truncated: true, total: rows.length, limit_applied: MAX_PROGRESS_ROWS,
        notes: [`Rows cut to ${MAX_PROGRESS_ROWS} of ${rows.length}. Narrow the dates or pass goal_key.`],
      });
    }
    return { range, rows };
  },
});
