// ============================================================================
// supabase/functions/_shared/tools/overwatch-projects.ts
//
// Overwatch's projects. Spec: docs/technical-spec-overwatch-q4n.md 4.3, 4.4 and 7.
//
//   get_project_plans        tier 1 — Project groups with their plans, estimates, steps used, reports and last report time.
//   update_project_plan      tier 2 — create or change a Project's plan (status line, target date, waits).
//   record_project_estimate  tier 2 — add an estimate to a Project's history; the only way to change its estimate.
//   get_project_estimates    tier 1 — a Project's estimate history, with original, scope-adjusted and current.
//   get_project_links        tier 1 — links between Projects.
//   create_project_link      tier 2 — add a notify_on_ship, no_parallel or depends_on link.
//
// The database refuses any group that is not the caller's Project (project_plans_check_group, project_estimates_guard).
// ============================================================================

import { clampLimit, defineTool, describeDbError, envelope, readTable } from "../platform.ts";

export const GROUP_STATUSES = ["someday", "active", "background", "closed"] as const;
export const WAITING_KINDS = ["alex", "decision", "project", "hurdle"] as const;
export const HURDLE_KINDS = ["technology", "time", "money", "skill"] as const;
export const LINK_KINDS = ["notify_on_ship", "no_parallel", "depends_on"] as const;

const CODE = /^[a-z0-9_-]{1,40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PLAN_COLUMNS =
  "group_id, project_code, target_date, effort_estimate, where_now, next_step, waiting_on, waiting_on_kind, " +
  "waiting_on_group_id, hurdle_kind, status_written_at, created_at, updated_at";
const LINK_COLUMNS = "id, from_group_id, to_group_id, kind, note, created_by, created_at";

function requireId(T: string, key: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${T}: ${key} is required.`);
  return value.trim();
}

function oneOf<V extends string>(T: string, key: string, value: unknown, allowed: readonly V[]): V {
  if (!(allowed as readonly unknown[]).includes(value)) {
    throw new Error(`${T}: ${key} must be one of ${allowed.join(", ")}; got ${JSON.stringify(value)}.`);
  }
  return value as V;
}

// ---------------------------------------------------------------------------
// estimate history helpers (spec 4.12)
// ---------------------------------------------------------------------------

export const ESTIMATE_KINDS = ["initial", "scope_increase", "scope_decrease", "re_estimate", "final"] as const;
const ESTIMATE_COLUMNS = "id, group_id, kind, estimate, cli_estimate, steps_added, at_step, reason, created_at";

type EstimateRow = { group_id: string; kind: string; estimate: number; steps_added: number | null };

/** Original (the initial row), scope-adjusted (original plus every steps_added) and final, for one project's rows. */
export function estimateSummary(rows: EstimateRow[]) {
  const initial = rows.find((r) => r.kind === "initial");
  const final = rows.find((r) => r.kind === "final");
  const added = rows.reduce((n, r) => n + (r.steps_added ?? 0), 0);
  return {
    original_estimate: initial?.estimate ?? null,
    scope_adjusted_estimate: initial ? initial.estimate + added : null,
    final_steps: final?.estimate ?? null,
  };
}

async function readEstimates(T: string, ctx: { db: any }, groupIds: string[]) {
  if (!groupIds.length) return [] as (EstimateRow & Record<string, unknown>)[];
  const { data, error } = await ctx.db.from("project_estimates").select(ESTIMATE_COLUMNS)
    .in("group_id", groupIds).order("created_at", { ascending: true }).order("id", { ascending: true });
  if (error) throw new Error(describeDbError(T, error));
  return (data ?? []) as (EstimateRow & Record<string, unknown>)[];
}

/** Adds original_estimate and scope_adjusted_estimate to each plan row (one read for the page). */
async function withEstimates(T: string, ctx: { db: any }, rows: Record<string, unknown>[]) {
  const all = await readEstimates(T, ctx, rows.map((r) => r.group_id as string));
  return rows.map((r) => {
    const s = estimateSummary(all.filter((e) => e.group_id === r.group_id));
    return { ...r, original_estimate: s.original_estimate, scope_adjusted_estimate: s.scope_adjusted_estimate };
  });
}

// ---------------------------------------------------------------------------
// get_project_plans — tier 1 (a computed report, so it keeps its own shape and clamps)
// ---------------------------------------------------------------------------

export const getProjectPlansTool = defineTool({
  name: "get_project_plans",
  // overwatch_project_progress reads item_groups, group_types, project_plans and clips.
  tables: { reads: ["item_groups", "group_types", "project_plans", "clips", "project_estimates"], writes: [] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_project_plans";
    let status: string[] | null = ["active"];
    if (args.status === "all") status = null;
    else if (args.status !== undefined && args.status !== null) {
      const list = Array.isArray(args.status) ? args.status : [args.status];
      status = list.map((s) => oneOf(T, "status", s, GROUP_STATUSES));
    }
    let groupIds: string[] | null = null;
    if (args.group_ids !== undefined && args.group_ids !== null) {
      if (!Array.isArray(args.group_ids) || args.group_ids.some((g) => typeof g !== "string" || !g)) {
        throw new Error(`${T}: group_ids must be a list of group ids.`);
      }
      groupIds = args.group_ids as string[];
    }
    if (args.limit !== undefined && args.limit !== null && (!Number.isInteger(args.limit) || (args.limit as number) < 1)) {
      throw new Error(`${T}: limit must be a whole number from 1 to 50.`);
    }
    const limit = clampLimit(args.limit as number | undefined);

    const { data, error } = await ctx.db.rpc("overwatch_project_progress", { p_status: status, p_group_ids: groupIds });
    if (error) throw new Error(describeDbError(T, error));
    const rows = (data ?? []) as Record<string, unknown>[];
    const page = await withEstimates(T, ctx, rows.slice(0, limit));
    return envelope(page, {
      total: rows.length,
      limit_applied: limit,
      truncated: rows.length > page.length,
      ...(rows.length > page.length ? { notes: [`Narrow with status or group_ids to see the other ${rows.length - page.length}.`] } : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// update_project_plan — tier 2
// ---------------------------------------------------------------------------
// Creates the plan when the Project has none. Only the fields passed change; null clears one.
// effort_estimate is not here: it changes only with a history row (record_project_estimate).

const PLAN_FIELDS = [
  "project_code", "target_date", "where_now", "next_step", "waiting_on", "waiting_on_kind",
  "waiting_on_group_id", "hurdle_kind",
] as const;

export function planPatch(T: string, args: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const given = (k: string) => args[k] !== undefined;
  if (given("project_code")) {
    const v = args.project_code;
    if (v !== null && (typeof v !== "string" || !CODE.test(v))) throw new Error(`${T}: project_code must match ${CODE}, e.g. overwatch-q4n.`);
    patch.project_code = v;
  }
  if (given("target_date")) {
    const v = args.target_date;
    if (v !== null && (typeof v !== "string" || !DAY.test(v) || Number.isNaN(Date.parse(v)))) {
      throw new Error(`${T}: target_date must be YYYY-MM-DD.`);
    }
    patch.target_date = v;
  }
  for (const k of ["where_now", "next_step", "waiting_on"]) {
    if (!given(k)) continue;
    const v = args[k];
    if (v !== null && (typeof v !== "string" || !v.trim())) throw new Error(`${T}: ${k} must be one line of text, or null to clear it.`);
    patch[k] = v === null ? null : (v as string).trim();
  }
  if (given("waiting_on_kind")) {
    patch.waiting_on_kind = args.waiting_on_kind === null ? null : oneOf(T, "waiting_on_kind", args.waiting_on_kind, WAITING_KINDS);
  }
  if (given("waiting_on_group_id")) {
    const v = args.waiting_on_group_id;
    if (v !== null && (typeof v !== "string" || !v)) throw new Error(`${T}: waiting_on_group_id must be a group id, or null.`);
    patch.waiting_on_group_id = v;
  }
  if (given("hurdle_kind")) {
    patch.hurdle_kind = args.hurdle_kind === null ? null : oneOf(T, "hurdle_kind", args.hurdle_kind, HURDLE_KINDS);
  }
  if (!Object.keys(patch).length) throw new Error(`${T}: nothing to change; pass at least one of ${PLAN_FIELDS.join(", ")}.`);
  return patch;
}

export const updateProjectPlanTool = defineTool({
  name: "update_project_plan",
  tables: { reads: ["project_plans"], writes: ["project_plans"] },
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "update_project_plan";
    const groupId = requireId(T, "group_id", args.group_id);
    const patch = planPatch(T, args);
    const { data, error } = await ctx.db
      .from("project_plans")
      .upsert({ group_id: groupId, ...patch }, { onConflict: "group_id" })
      .select(PLAN_COLUMNS)
      .maybeSingle();
    if (error) throw new Error(describeDbError(T, error));
    return data;
  },
});

// ---------------------------------------------------------------------------
// record_project_estimate — tier 2
// ---------------------------------------------------------------------------
// One RPC writes the history row and, except for final, the plan's current estimate, in one transaction.

function wholeSteps(T: string, key: string, v: unknown, { min, max }: { min: number; max: number }): number | null {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) {
    throw new Error(`${T}: ${key} must be a whole number of CLI steps, ${min} to ${max}.`);
  }
  return v as number;
}

export const recordProjectEstimateTool = defineTool({
  name: "record_project_estimate",
  tables: {
    reads: ["overwatch_plans", "project_estimates", "project_plans", "item_groups", "group_types", "clips"],
    writes: ["project_estimates", "project_plans"],
  },
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "record_project_estimate";
    const groupId = requireId(T, "group_id", args.group_id);
    const kind = oneOf(T, "kind", args.kind, ESTIMATE_KINDS);
    if (typeof args.reason !== "string" || !args.reason.trim()) throw new Error(`${T}: reason is required, one line.`);
    const estimate = wholeSteps(T, "estimate", args.estimate, { min: 0, max: 1000 });
    const cliEstimate = wholeSteps(T, "cli_estimate", args.cli_estimate, { min: 1, max: 1000 });
    const stepsAdded = wholeSteps(T, "steps_added", args.steps_added, { min: -1000, max: 1000 });
    const atStep = wholeSteps(T, "at_step", args.at_step, { min: 0, max: 1000 });

    if ((kind === "initial" || kind === "re_estimate") && cliEstimate === null && estimate === null) {
      throw new Error(`${T}: ${kind} needs cli_estimate (the CLI's figure; the correction factor is applied to it).`);
    }
    if (kind === "scope_increase" && !(stepsAdded !== null && stepsAdded > 0)) {
      throw new Error(`${T}: scope_increase needs steps_added greater than 0.`);
    }
    if (kind === "scope_decrease" && !(stepsAdded !== null && stepsAdded < 0)) {
      throw new Error(`${T}: scope_decrease needs steps_added less than 0, e.g. -2.`);
    }
    if (stepsAdded !== null && kind !== "scope_increase" && kind !== "scope_decrease") {
      throw new Error(`${T}: steps_added is only for scope_increase and scope_decrease.`);
    }

    const { data, error } = await ctx.db.rpc("record_project_estimate", {
      p_group_id: groupId,
      p_kind: kind,
      p_reason: (args.reason as string).trim(),
      p_estimate: estimate,
      p_cli_estimate: cliEstimate,
      p_steps_added: stepsAdded,
      p_at_step: atStep,
    });
    if (error?.code === "23505") throw new Error(`${T}: this project already has its ${kind} estimate. Nothing was written.`);
    if (error) throw new Error(describeDbError(T, error));
    return data;
  },
});

// ---------------------------------------------------------------------------
// get_project_estimates — tier 1 (a computed report: per project, its summary and full history)
// ---------------------------------------------------------------------------

export const getProjectEstimatesTool = defineTool({
  name: "get_project_estimates",
  tables: { reads: ["project_estimates", "project_plans"], writes: [] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_project_estimates";
    if (!Array.isArray(args.group_ids) || args.group_ids.length === 0 ||
        args.group_ids.some((g) => typeof g !== "string" || !g)) {
      throw new Error(`${T}: group_ids is required, a list of Project group ids (from get_project_plans).`);
    }
    if (args.group_ids.length > 20) throw new Error(`${T}: at most 20 projects per call.`);
    const ids = [...new Set(args.group_ids as string[])];
    const all = await readEstimates(T, ctx, ids);
    const { data: plans, error } = await ctx.db.from("project_plans").select("group_id, effort_estimate").in("group_id", ids);
    if (error) throw new Error(describeDbError(T, error));
    return ids.map((id) => {
      const history = all.filter((e) => e.group_id === id);
      const plan = ((plans ?? []) as { group_id: string; effort_estimate: number | null }[]).find((p) => p.group_id === id);
      return { group_id: id, current_estimate: plan?.effort_estimate ?? null, ...estimateSummary(history), history };
    });
  },
});

// ---------------------------------------------------------------------------
// get_project_links — tier 1
// ---------------------------------------------------------------------------

export const getProjectLinksTool = defineTool({
  name: "get_project_links",
  tables: { reads: ["project_links"], writes: [] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_project_links";
    const kind = args.kind === undefined || args.kind === null ? null : oneOf(T, "kind", args.kind, LINK_KINDS);
    const groupId = args.group_id === undefined || args.group_id === null ? null : requireId(T, "group_id", args.group_id);
    // It goes into a PostgREST or() string, so only id characters.
    if (groupId && !/^[A-Za-z0-9_-]+$/.test(groupId)) throw new Error(`${T}: group_id ${JSON.stringify(groupId)} is not a group id.`);
    return await readTable(ctx, {
      tool: T,
      table: "project_links",
      args,
      filter: (query) => {
        let q = query;
        if (kind) q = q.eq("kind", kind);
        // Either end of the link.
        if (groupId) q = q.or(`from_group_id.eq.${groupId},to_group_id.eq.${groupId}`);
        return q;
      },
      order: [{ column: "created_at", ascending: false }, { column: "id", ascending: true }],
    });
  },
});

// ---------------------------------------------------------------------------
// create_project_link — tier 2
// ---------------------------------------------------------------------------

export const createProjectLinkTool = defineTool({
  name: "create_project_link",
  tables: { reads: [], writes: ["project_links"] },
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "create_project_link";
    const from = requireId(T, "from_group_id", args.from_group_id);
    const to = requireId(T, "to_group_id", args.to_group_id);
    if (from === to) throw new Error(`${T}: a Project cannot link to itself.`);
    const kind = oneOf(T, "kind", args.kind, LINK_KINDS);
    const createdBy = args.created_by === undefined || args.created_by === null
      ? "alex"
      : oneOf(T, "created_by", args.created_by, ["alex", "overwatch"] as const);
    if (args.note !== undefined && args.note !== null && typeof args.note !== "string") throw new Error(`${T}: note must be text.`);
    const { data, error } = await ctx.db
      .from("project_links")
      .insert({ from_group_id: from, to_group_id: to, kind, note: (args.note as string | undefined)?.trim() || null, created_by: createdBy })
      .select(LINK_COLUMNS)
      .maybeSingle();
    if (error?.code === "23505") throw new Error(`${T}: that ${kind} link already exists. Nothing was added.`);
    if (error) throw new Error(describeDbError(T, error));
    return data;
  },
});
