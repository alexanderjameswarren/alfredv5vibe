// ============================================================================
// supabase/functions/_shared/tools/overwatch-projects.ts
//
// Overwatch's projects. Spec: docs/technical-spec-overwatch-q4n.md 4.3, 4.4 and 7.
//
//   get_project_plans    tier 1 — Project groups with their plans, steps used, reports and last report time.
//   update_project_plan  tier 2 — create or change a Project's plan (status line, estimate, target date, waits).
//   get_project_links    tier 1 — links between Projects.
//   create_project_link  tier 2 — add a notify_on_ship, no_parallel or depends_on link.
//
// The database refuses any group that is not the caller's Project (project_plans_check_group).
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
// get_project_plans — tier 1 (a computed report, so it keeps its own shape and clamps)
// ---------------------------------------------------------------------------

export const getProjectPlansTool = defineTool({
  name: "get_project_plans",
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
    const page = rows.slice(0, limit);
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

const PLAN_FIELDS = [
  "project_code", "target_date", "effort_estimate", "where_now", "next_step", "waiting_on", "waiting_on_kind",
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
  if (given("effort_estimate")) {
    const v = args.effort_estimate;
    if (v !== null && (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 500)) {
      throw new Error(`${T}: effort_estimate is a whole number of CLI steps, 1 to 500.`);
    }
    patch.effort_estimate = v;
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
// get_project_links — tier 1
// ---------------------------------------------------------------------------

export const getProjectLinksTool = defineTool({
  name: "get_project_links",
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
