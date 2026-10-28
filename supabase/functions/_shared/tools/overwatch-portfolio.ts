// ============================================================================
// supabase/functions/_shared/tools/overwatch-portfolio.ts
//
// Overwatch Phase 8b: portfolios and their versioned plans. Spec: docs/technical-spec-overwatch-q4n.md 4.16 and 7.
//
//   get_portfolios          tier 1 — every portfolio with its contexts and its active plan in brief.
//   upsert_portfolio        tier 2 — create a portfolio, or rename it, set its contexts, position or archived.
//   get_portfolio_plan      tier 1 — a portfolio's active version (or a named one): lanes, slices, and the versions list.
//   create_portfolio_plan   tier 3 — a new version, whole (propose shows what changes against the active one).
//   update_portfolio_slice  tier 2 — a slice's status on the active plan.
//
// The database does the hard checks (migration 181): a slice's group must be the caller's Project, lanes and slices
// are written only with their plan, one slice in progress per lane, only status changes in place.
// ============================================================================

import { defineTool, describeDbError, envelope, readTable } from "../platform.ts";

export const SLICE_STATUSES = ["planned", "in_progress", "done", "paused"] as const;
const AUTHORS = ["alex", "overwatch"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PORTFOLIO_COLUMNS = "id, name, context_ids, position, archived, created_at, updated_at";
const PLAN_COLUMNS = "id, portfolio_id, active, theory, notes_for_next_review, review_by, reason, written_by, supersedes_id, created_at";
const VERSION_COLUMNS = "id, active, written_by, reason, review_by, created_at";
const SLICE_COLUMNS = "id, plan_id, lane_id, position, group_id, phases, why, status, paused_reason, status_changed_at";

type Row = Record<string, unknown>;
type Ctx = { db: any };

const given = (args: Row, k: string) => args[k] !== undefined && args[k] !== null;

function text(T: string, key: string, v: unknown, { required = false } = {}): string | null {
  if (v === undefined || v === null) {
    if (required) throw new Error(`${T}: ${key} is required.`);
    return null;
  }
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${T}: ${key} must be non-empty text.`);
  return v.trim();
}

function uuid(T: string, key: string, v: unknown, { required = false } = {}): string | null {
  if (v === undefined || v === null) {
    if (required) throw new Error(`${T}: ${key} is required.`);
    return null;
  }
  if (typeof v !== "string" || !UUID.test(v)) throw new Error(`${T}: ${key} must be an id (uuid); got ${JSON.stringify(v)}.`);
  return v;
}

function oneOf<V extends string>(T: string, key: string, v: unknown, allowed: readonly V[]): V {
  if (!(allowed as readonly unknown[]).includes(v)) {
    throw new Error(`${T}: ${key} must be one of ${allowed.join(", ")}; got ${JSON.stringify(v)}.`);
  }
  return v as V;
}

function position(T: string, key: string, v: unknown): number {
  if (!Number.isInteger(v) || (v as number) < 1) throw new Error(`${T}: ${key} must be a whole number from 1.`);
  return v as number;
}

async function rows(T: string, query: PromiseLike<{ data: unknown; error: unknown }>): Promise<Row[]> {
  const { data, error } = await query;
  if (error) throw new Error(describeDbError(T, error as { message?: string }));
  return (data ?? []) as Row[];
}

/** The portfolio by id or by name, or an error naming get_portfolios. */
async function findPortfolio(T: string, ctx: Ctx, args: Row): Promise<Row> {
  const id = uuid(T, "portfolio_id", args.portfolio_id);
  const name = text(T, "portfolio", args.portfolio);
  if (!id && !name) throw new Error(`${T}: portfolio_id or portfolio (its name) is required; see get_portfolios.`);
  let q = ctx.db.from("portfolios").select(PORTFOLIO_COLUMNS);
  q = id ? q.eq("id", id) : q.eq("name", name);
  const found = await rows(T, q.limit(1));
  if (!found.length) throw new Error(`${T}: no portfolio ${JSON.stringify(id ?? name)} that you can see; see get_portfolios.`);
  return found[0];
}

/** One plan version with its lanes in order, each with its slices in order, each slice with its group's name. */
export async function loadPlan(T: string, ctx: Ctx, plan: Row) {
  const lanes = await rows(T, ctx.db.from("portfolio_lanes").select("id, name, position, note")
    .eq("plan_id", plan.id).order("position", { ascending: true }));
  const slices = await rows(T, ctx.db.from("portfolio_slices").select(SLICE_COLUMNS)
    .eq("plan_id", plan.id).order("position", { ascending: true }));
  const groupIds = [...new Set(slices.map((s) => s.group_id as string))];
  const groups = groupIds.length
    ? await rows(T, ctx.db.from("item_groups").select("id, name, status").in("id", groupIds))
    : [];
  const codes = groupIds.length
    ? await rows(T, ctx.db.from("project_plans").select("group_id, project_code").in("group_id", groupIds))
    : [];
  const group = new Map(groups.map((g) => [g.id, g]));
  const code = new Map(codes.map((c) => [c.group_id, c.project_code]));
  return {
    ...plan,
    lanes: lanes.map((l) => ({
      ...l,
      slices: slices.filter((s) => s.lane_id === l.id).map(({ plan_id: _p, lane_id: _l, ...s }) => ({
        ...s,
        group_name: (group.get(s.group_id) as Row | undefined)?.name ?? null,
        group_status: (group.get(s.group_id) as Row | undefined)?.status ?? null,
        project_code: code.get(s.group_id) ?? null,
      })),
    })),
  };
}

async function activePlanRow(T: string, ctx: Ctx, portfolioId: string): Promise<Row | null> {
  const found = await rows(T, ctx.db.from("portfolio_plans").select(PLAN_COLUMNS)
    .eq("portfolio_id", portfolioId).eq("active", true).limit(1));
  return found[0] ?? null;
}

// ---------------------------------------------------------------------------
// get_portfolios — tier 1
// ---------------------------------------------------------------------------

/** Counts of slices by status, every status present. */
export function statusCounts(slices: { status: string }[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(SLICE_STATUSES.map((s) => [s, 0]));
  for (const { status } of slices) out[status] = (out[status] ?? 0) + 1;
  return out;
}

export const getPortfoliosTool = defineTool({
  name: "get_portfolios",
  tier: 1,
  tables: { reads: ["portfolios", "portfolio_plans", "portfolio_slices"], writes: [] },
  handler: async (args: Row, ctx) => {
    const T = "get_portfolios";
    // Archived ones are left out by readTable's shared archived option unless asked for.
    return await readTable(ctx, {
      tool: T,
      table: "portfolios",
      args,
      order: [{ column: "position", ascending: true }, { column: "name", ascending: true }],
      attach: async (list) => {
        const ids = (list as Row[]).map((p) => p.id as string);
        const plans = await rows(T, ctx.db.from("portfolio_plans").select("id, portfolio_id, theory, review_by, created_at")
          .eq("active", true).in("portfolio_id", ids));
        const slices = plans.length
          ? await rows(T, ctx.db.from("portfolio_slices").select("plan_id, status").in("plan_id", plans.map((p) => p.id)))
          : [];
        return {
          rows: (list as Row[]).map((p) => {
            const plan = plans.find((x) => x.portfolio_id === p.id);
            return {
              ...p,
              active_plan: plan
                ? {
                  id: plan.id,
                  theory_first_line: String(plan.theory ?? "").split("\n")[0],
                  review_by: plan.review_by,
                  created_at: plan.created_at,
                  slices: statusCounts(slices.filter((s) => s.plan_id === plan.id) as { status: string }[]),
                }
                : null,
            };
          }),
        };
      },
    });
  },
});

// ---------------------------------------------------------------------------
// upsert_portfolio — tier 2
// ---------------------------------------------------------------------------
// With id: change that portfolio (a rename included). Without: create by name, or update the one with that name.

export const upsertPortfolioTool = defineTool({
  name: "upsert_portfolio",
  tier: 2,
  tables: { reads: ["portfolios"], writes: ["portfolios"] },
  handler: async (args: Row, ctx) => {
    const T = "upsert_portfolio";
    const id = uuid(T, "id", args.id);
    const patch: Row = {};
    if (given(args, "name")) patch.name = text(T, "name", args.name);
    if (given(args, "context_ids")) {
      const c = args.context_ids;
      if (!Array.isArray(c) || c.some((x) => typeof x !== "string" || x.trim() === "")) {
        throw new Error(`${T}: context_ids must be a list of context ids (see get_contexts).`);
      }
      patch.context_ids = [...new Set(c.map((x) => (x as string).trim()))];
    }
    if (given(args, "position")) {
      if (!Number.isInteger(args.position) || (args.position as number) < 0) throw new Error(`${T}: position must be a whole number from 0.`);
      patch.position = args.position;
    }
    if (given(args, "archived")) {
      if (typeof args.archived !== "boolean") throw new Error(`${T}: archived must be true or false.`);
      patch.archived = args.archived;
    }

    let result;
    if (id) {
      if (!Object.keys(patch).length) throw new Error(`${T}: nothing to change; pass name, context_ids, position or archived.`);
      result = await ctx.db.from("portfolios").update(patch).eq("id", id).select(PORTFOLIO_COLUMNS).maybeSingle();
    } else {
      if (!patch.name) throw new Error(`${T}: name is required to create a portfolio; pass id to change one.`);
      result = await ctx.db.from("portfolios").upsert(patch, { onConflict: "user_id,name" }).select(PORTFOLIO_COLUMNS).maybeSingle();
    }
    const { data, error } = result;
    if (error?.code === "23505") throw new Error(`${T}: there is already a portfolio named ${JSON.stringify(patch.name)}.`);
    if (error) throw new Error(describeDbError(T, error));
    if (!data) throw new Error(`${T}: no portfolio ${id} that you can see. Nothing was changed.`);
    return data;
  },
});

// ---------------------------------------------------------------------------
// get_portfolio_plan — tier 1
// ---------------------------------------------------------------------------

export const getPortfolioPlanTool = defineTool({
  name: "get_portfolio_plan",
  tier: 1,
  tables: {
    reads: ["portfolios", "portfolio_plans", "portfolio_lanes", "portfolio_slices", "item_groups", "project_plans"],
    writes: [],
  },
  handler: async (args: Row, ctx) => {
    const T = "get_portfolio_plan";
    const planId = uuid(T, "plan_id", args.plan_id);
    let portfolio: Row;
    let plan: Row | null;
    if (planId && !given(args, "portfolio_id") && !given(args, "portfolio")) {
      const found = await rows(T, ctx.db.from("portfolio_plans").select(PLAN_COLUMNS).eq("id", planId).limit(1));
      if (!found.length) throw new Error(`${T}: no plan version ${planId} that you can see.`);
      plan = found[0];
      portfolio = await findPortfolio(T, ctx, { portfolio_id: plan.portfolio_id });
    } else {
      portfolio = await findPortfolio(T, ctx, args);
      if (planId) {
        const found = await rows(T, ctx.db.from("portfolio_plans").select(PLAN_COLUMNS)
          .eq("id", planId).eq("portfolio_id", portfolio.id).limit(1));
        if (!found.length) throw new Error(`${T}: plan ${planId} is not a version of ${JSON.stringify(portfolio.name)}.`);
        plan = found[0];
      } else {
        plan = await activePlanRow(T, ctx, portfolio.id as string);
      }
    }
    const versions = await rows(T, ctx.db.from("portfolio_plans").select(VERSION_COLUMNS)
      .eq("portfolio_id", portfolio.id).order("created_at", { ascending: false }).limit(50));
    const notes = plan ? [] : [`No plan for ${portfolio.name} yet: write one with create_portfolio_plan.`];
    return envelope({ portfolio, plan: plan ? await loadPlan(T, ctx, plan) : null, versions }, { notes });
  },
});

// ---------------------------------------------------------------------------
// create_portfolio_plan — tier 3
// ---------------------------------------------------------------------------

type SliceIn = { position: number; group_id: string; phases: string | null; why: string | null; status: string; paused_reason: string | null };
type LaneIn = { name: string; position: number; note: string | null; slices: SliceIn[] };

export function portfolioPlanInput(T: string, args: Row) {
  const portfolioId = uuid(T, "portfolio_id", args.portfolio_id, { required: true })!;
  const theory = text(T, "theory", args.theory, { required: true })!;
  const reason = text(T, "reason", args.reason, { required: true })!;
  const notes = text(T, "notes_for_next_review", args.notes_for_next_review);
  let reviewBy: string | null = null;
  if (given(args, "review_by")) {
    if (typeof args.review_by !== "string" || !DAY.test(args.review_by) || Number.isNaN(Date.parse(args.review_by))) {
      throw new Error(`${T}: review_by must be a date, YYYY-MM-DD.`);
    }
    reviewBy = args.review_by;
  }
  const writtenBy = given(args, "written_by") ? oneOf(T, "written_by", args.written_by, AUTHORS) : "alex";
  if (!Array.isArray(args.lanes) || args.lanes.length === 0) {
    throw new Error(`${T}: lanes is required: a list of { name, position, note, slices: [...] }.`);
  }
  const lanes: LaneIn[] = args.lanes.map((l, i) => {
    if (!l || typeof l !== "object" || Array.isArray(l)) throw new Error(`${T}: lanes[${i}] must be an object.`);
    const lane = l as Row;
    const slicesIn = lane.slices ?? [];
    if (!Array.isArray(slicesIn)) throw new Error(`${T}: lanes[${i}].slices must be a list.`);
    return {
      name: text(T, `lanes[${i}].name`, lane.name, { required: true })!,
      position: position(T, `lanes[${i}].position`, lane.position),
      note: text(T, `lanes[${i}].note`, lane.note),
      slices: slicesIn.map((s, j) => {
        const k = `lanes[${i}].slices[${j}]`;
        if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error(`${T}: ${k} must be an object.`);
        const slice = s as Row;
        const status = given(slice, "status") ? oneOf(T, `${k}.status`, slice.status, SLICE_STATUSES) : "planned";
        const pausedReason = text(T, `${k}.paused_reason`, slice.paused_reason);
        if (status === "paused" && !pausedReason) throw new Error(`${T}: ${k} is paused, so it needs paused_reason.`);
        if (status !== "paused" && pausedReason) throw new Error(`${T}: ${k}.paused_reason is only for a paused slice.`);
        return {
          position: position(T, `${k}.position`, slice.position),
          group_id: text(T, `${k}.group_id`, slice.group_id, { required: true })!,
          phases: text(T, `${k}.phases`, slice.phases),
          why: text(T, `${k}.why`, slice.why),
          status,
          paused_reason: pausedReason,
        };
      }),
    };
  });
  return { portfolioId, theory, reason, notes, reviewBy, writtenBy, lanes };
}

type SliceShape = { group_id: unknown; phases: unknown; status?: unknown; paused_reason?: unknown };
type PlanShape = { theory?: unknown; lanes: { name: unknown; position: unknown; slices: SliceShape[] }[] };

const sliceKey = (s: SliceShape) => `${s.group_id}|${s.phases ?? ""}`;
const statusText = (s: SliceShape) => `${s.status ?? "planned"}${s.paused_reason ? ` (${s.paused_reason})` : ""}`;

/** What a new version changes against the active one: theory, lanes, slices added, removed or moved, and statuses. */
export function describePlanChange(current: PlanShape | null, next: PlanShape, names: Map<unknown, unknown>): string[] {
  const label = (s: SliceShape) => `${names.get(s.group_id) ?? s.group_id}${s.phases ? ` (${s.phases})` : ""}`;
  if (!current) {
    return ["This becomes the portfolio's first plan.", `Theory:\n${next.theory}`,
      ...next.lanes.flatMap((l) => [`Lane ${l.name}:`,
        ...(l.slices.length ? l.slices.map((s, i) => `  ${i + 1}. ${label(s)}: ${statusText(s)}`) : ["  no slices"])])];
  }
  const lines = [current.theory === next.theory ? "Theory: unchanged." : `Theory, new text:\n${next.theory}`];
  const oldNames = new Set(current.lanes.map((l) => l.name));
  const newNames = new Set(next.lanes.map((l) => l.name));
  // A rename: a new lane name at the position of an old lane whose name the new version no longer has.
  const renamed = new Map<unknown, unknown>();
  for (const l of next.lanes) {
    if (oldNames.has(l.name)) continue;
    const was = current.lanes.find((o) => o.position === l.position && !newNames.has(o.name));
    if (was) renamed.set(was.name, l.name);
    lines.push(was ? `Lane renamed: ${was.name} -> ${l.name}.` : `Lane added: ${l.name}.`);
  }
  for (const o of current.lanes) if (!newNames.has(o.name) && !renamed.has(o.name)) lines.push(`Lane removed: ${o.name}.`);
  // A slice is its group and phases; where it sits is lane and order within the lane. An old lane is compared
  // under its new name, so a renamed lane's slices have not moved.
  const where = (plan: PlanShape, laneName: (n: unknown) => unknown) => {
    const m = new Map<string, { lane: unknown; shown: unknown; index: number; slice: SliceShape }>();
    for (const l of plan.lanes) {
      l.slices.forEach((s, index) => m.set(sliceKey(s), { lane: laneName(l.name), shown: l.name, index, slice: s }));
    }
    return m;
  };
  const before = where(current, (n) => renamed.get(n) ?? n);
  const after = where(next, (n) => n);
  for (const [k, a] of after) {
    const b = before.get(k);
    if (!b) {
      lines.push(`Slice added: ${label(a.slice)} in ${a.lane}: ${statusText(a.slice)}.`);
      continue;
    }
    if (b.lane !== a.lane) lines.push(`Slice moved between lanes: ${label(a.slice)}, ${b.shown} -> ${a.lane}.`);
    else if (b.index !== a.index) lines.push(`Slice moved within ${a.lane}: ${label(a.slice)}, place ${b.index + 1} -> ${a.index + 1}.`);
    if (statusText(b.slice) !== statusText(a.slice)) {
      lines.push(`Status: ${label(a.slice)}: ${statusText(b.slice)} -> ${statusText(a.slice)}.`);
    }
  }
  for (const [k, b] of before) if (!after.has(k)) lines.push(`Slice removed: ${label(b.slice)} from ${b.shown}.`);
  if (lines.length === 1) lines.push("Lanes and slices: unchanged.");
  return lines;
}

const byPosition = <V extends { position: unknown }>(list: V[]) =>
  [...list].sort((a, b) => (a.position as number) - (b.position as number));

export const createPortfolioPlanTool = defineTool({
  name: "create_portfolio_plan",
  tier: 3,
  tables: {
    reads: ["portfolios", "portfolio_plans", "portfolio_lanes", "portfolio_slices", "item_groups", "project_plans"],
    writes: ["portfolio_plans", "portfolio_lanes", "portfolio_slices"],
  },
  propose: async (args: Row, ctx) => {
    const T = "create_portfolio_plan";
    const next = portfolioPlanInput(T, args);
    const portfolio = await findPortfolio(T, ctx, { portfolio_id: next.portfolioId });
    const active = await activePlanRow(T, ctx, next.portfolioId);
    // loadPlan's rows are loosely typed; the lanes and slices carry the fields PlanShape names.
    const current = (active ? await loadPlan(T, ctx, active) : null) as unknown as
      (PlanShape & { lanes: { slices: Row[] }[] }) | null;
    const ids = [...new Set(next.lanes.flatMap((l) => l.slices.map((s) => s.group_id)))];
    const groups = ids.length ? await rows(T, ctx.db.from("item_groups").select("id, name").in("id", ids)) : [];
    const names = new Map<unknown, unknown>(groups.map((g) => [g.id, g.name]));
    for (const l of current?.lanes ?? []) for (const s of l.slices) names.set(s.group_id, s.group_name);
    type Placed = { position: unknown; group_id: unknown; phases: unknown };
    const shape = (lanes: PlanShape["lanes"]) =>
      byPosition(lanes).map((l) => ({ ...l, slices: byPosition(l.slices as Placed[]) }));
    const lines = [`NEW PLAN VERSION for ${portfolio.name} (written by ${next.writtenBy}). Reason: ${next.reason}`,
      ...describePlanChange(current ? { theory: current.theory, lanes: shape(current.lanes) } : null,
        { theory: next.theory, lanes: shape(next.lanes) }, names)];
    return { text: lines.join("\n") };
  },
  handler: async (args: Row, ctx) => {
    const T = "create_portfolio_plan";
    const next = portfolioPlanInput(T, args);
    const { data, error } = await ctx.db.rpc("create_portfolio_plan", {
      p_portfolio_id: next.portfolioId,
      p_theory: next.theory,
      p_notes_for_next_review: next.notes,
      p_review_by: next.reviewBy,
      p_reason: next.reason,
      p_written_by: next.writtenBy,
      p_lanes: next.lanes,
    });
    if (error) throw new Error(describeDbError(T, error));
    const { lanes: _l, slices: _s, ...plan } = data as Row;
    return await loadPlan(T, ctx, plan);
  },
});

// ---------------------------------------------------------------------------
// update_portfolio_slice — tier 2
// ---------------------------------------------------------------------------

export const updatePortfolioSliceTool = defineTool({
  name: "update_portfolio_slice",
  tier: 2,
  tables: { reads: ["portfolio_slices"], writes: ["portfolio_slices"] },
  handler: async (args: Row, ctx) => {
    const T = "update_portfolio_slice";
    const id = uuid(T, "id", args.id, { required: true })!;
    const status = oneOf(T, "status", args.status, SLICE_STATUSES);
    const pausedReason = text(T, "paused_reason", args.paused_reason);
    if (status === "paused" && !pausedReason) throw new Error(`${T}: paused needs paused_reason, one line on why.`);
    if (status !== "paused" && pausedReason) throw new Error(`${T}: paused_reason is only for status paused.`);
    const { data, error } = await ctx.db.from("portfolio_slices")
      .update({ status, paused_reason: pausedReason }).eq("id", id).select(SLICE_COLUMNS).maybeSingle();
    if (error?.code === "23505") {
      throw new Error(`${T}: that lane already has a slice in progress; mark it done or paused first.`);
    }
    if (error) throw new Error(describeDbError(T, error));
    if (!data) throw new Error(`${T}: no slice ${id} that you can see. Nothing was changed.`);
    return data;
  },
});
