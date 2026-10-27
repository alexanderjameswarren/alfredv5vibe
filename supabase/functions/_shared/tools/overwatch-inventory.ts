// ============================================================================
// supabase/functions/_shared/tools/overwatch-inventory.ts
//
// Overwatch Phase 7: the inventory, open work and finish summaries. Spec: docs/technical-spec-overwatch-q4n.md 4.9,
// 4.13, 4.14, 5.4 and 7.
//
//   get_platform_inventory          tier 1 — parts by kind, name, app or table; counts per kind in a note.
//   get_open_work                   tier 1 — unfinished work in docs/, live or history.
//   get_finish_summaries            tier 1 — what each Finish carried into main; unreviewed by default.
//   mark_finish_summaries_reviewed  tier 2 — stamp reviewed_at and the run that reviewed them.
// ============================================================================

import { defineTool, describeDbError, readTable } from "../platform.ts";

export const INVENTORY_KINDS = ["tool", "skill", "edge_function", "schedule", "table", "screen", "task_prompt", "trigger"] as const;
export const OPEN_WORK_KINDS = ["checkbox", "deferred_phase", "not_fixed"] as const;
export const OPEN_WORK_WHERE = ["all", "live", "history"] as const;

const CODE = /^[a-z0-9_-]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A table or view: public ones bare, others schema-qualified (platform.registry).
const TABLE_NAME = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;
const SUMMARY_COLUMNS =
  "id, project_code, branch, merge_commit, finished_at, diff_stat, migrations, tools, skills, functions, task_prompts, " +
  "paths, reviewed_at, reviewed_by_run, created_at";

type Row = Record<string, unknown>;

const given = (args: Row, k: string) => args[k] !== undefined && args[k] !== null;

/** Optional text, trimmed; an empty string counts as not given. */
function text(T: string, key: string, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new Error(`${T}: ${key} must be text; got ${JSON.stringify(v)}.`);
  return v.trim() || null;
}

function oneOf<K extends string>(T: string, key: string, v: unknown, allowed: readonly K[]): K | null {
  if (v === undefined || v === null) return null;
  if (!(allowed as readonly unknown[]).includes(v)) {
    throw new Error(`${T}: ${key} must be one of ${allowed.join(", ")}; got ${JSON.stringify(v)}.`);
  }
  return v as K;
}

function code(T: string, key: string, v: unknown): string | null {
  const s = text(T, key, v);
  if (s && !CODE.test(s)) throw new Error(`${T}: ${key} must be a project code such as overwatch-q4n; got ${JSON.stringify(s)}.`);
  return s;
}

const likeTerm = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** "reads", "writes" or "both": how a part uses a table. */
export function usesOf(row: Row, table: string): "reads" | "writes" | "both" | null {
  const r = ((row.reads as string[] | null) ?? []).includes(table);
  const w = ((row.writes as string[] | null) ?? []).includes(table);
  return r && w ? "both" : r ? "reads" : w ? "writes" : null;
}

/** "tool 163, trigger 165, …" from the rows' kinds. */
export function countsNote(kinds: { kind: string }[]): string {
  const counts = new Map<string, number>();
  for (const { kind } of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return `Inventory by kind: ${[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} ${n}`).join(", ")}.`;
}

// ---------------------------------------------------------------------------
// get_platform_inventory — tier 1
// ---------------------------------------------------------------------------

export const getPlatformInventoryTool = defineTool({
  name: "get_platform_inventory",
  tier: 1,
  tables: { reads: ["platform_inventory"], writes: [] },
  handler: async (args: Row, ctx) => {
    const T = "get_platform_inventory";
    const kind = oneOf(T, "kind", args.kind, INVENTORY_KINDS);
    const name = text(T, "name", args.name);
    const appId = text(T, "app_id", args.app_id);
    const table = text(T, "table", args.table);
    if (table && !TABLE_NAME.test(table)) {
      throw new Error(`${T}: table must be a table or view name such as items or platform.registry; got ${JSON.stringify(table)}.`);
    }
    if (given(args, "reads_any") && typeof args.reads_any !== "boolean") throw new Error(`${T}: reads_any must be true or false.`);
    const readsAny = args.reads_any === true;
    return await readTable(ctx, {
      tool: T,
      table: "platform_inventory",
      args,
      filter: (query) => {
        let q = query;
        if (kind) q = q.eq("kind", kind);
        if (name) q = q.ilike("name", likeTerm(name));
        if (appId) q = q.eq("app_id", appId);
        if (table) q = q.or(`reads.cs.{${table}},writes.cs.{${table}}`);
        if (readsAny) q = q.eq("reads_any", true);
        return q;
      },
      order: [{ column: "kind", ascending: true }, { column: "name", ascending: true }],
      attach: async (rows) => {
        const notes: string[] = [];
        const { data, error } = await ctx.db.from("platform_inventory").select("kind").limit(10000);
        if (!error) notes.push(countsNote((data ?? []) as { kind: string }[]));
        if (table) notes.push(`Generic readers (reads_any) may read ${table} too: ask with reads_any: true.`);
        return { rows: table ? (rows as Row[]).map((r) => ({ ...r, uses: usesOf(r, table) })) : rows, notes };
      },
    });
  },
});

// ---------------------------------------------------------------------------
// get_open_work — tier 1
// ---------------------------------------------------------------------------

export const getOpenWorkTool = defineTool({
  name: "get_open_work",
  tier: 1,
  tables: { reads: ["platform_open_work"], writes: [] },
  handler: async (args: Row, ctx) => {
    const T = "get_open_work";
    const file = text(T, "file", args.file);
    const project = code(T, "project_code", args.project_code);
    const kind = oneOf(T, "kind", args.kind, OPEN_WORK_KINDS);
    const where = oneOf(T, "where", args.where, OPEN_WORK_WHERE) ?? "all";
    return await readTable(ctx, {
      tool: T,
      table: "platform_open_work",
      args,
      filter: (query) => {
        let q = query;
        if (file) q = q.ilike("file", likeTerm(file));
        if (project) q = q.eq("project_code", project);
        if (kind) q = q.eq("kind", kind);
        if (where === "history") q = q.like("file", "docs/history/%");
        if (where === "live") q = q.not("file", "like", "docs/history/%");
        return q;
      },
      order: [{ column: "file", ascending: true }, { column: "line", ascending: true }],
      fullText: ["text"],
    });
  },
});

// ---------------------------------------------------------------------------
// get_finish_summaries — tier 1
// ---------------------------------------------------------------------------

export const getFinishSummariesTool = defineTool({
  name: "get_finish_summaries",
  tier: 1,
  tables: { reads: ["finish_summaries"], writes: [] },
  handler: async (args: Row, ctx) => {
    const T = "get_finish_summaries";
    if (given(args, "all") && typeof args.all !== "boolean") throw new Error(`${T}: all must be true or false.`);
    const all = args.all === true;
    const project = code(T, "project_code", args.project_code);
    return await readTable(ctx, {
      tool: T,
      table: "finish_summaries",
      args,
      filter: (query) => {
        let q = query;
        if (!all) q = q.is("reviewed_at", null);
        if (project) q = q.eq("project_code", project);
        return q;
      },
      order: [{ column: "finished_at", ascending: false }, { column: "id", ascending: true }],
    });
  },
});

// ---------------------------------------------------------------------------
// mark_finish_summaries_reviewed — tier 2
// ---------------------------------------------------------------------------

export const markFinishSummariesReviewedTool = defineTool({
  name: "mark_finish_summaries_reviewed",
  tier: 2,
  tables: { reads: ["finish_summaries"], writes: ["finish_summaries"] },
  handler: async (args: Row, ctx) => {
    const T = "mark_finish_summaries_reviewed";
    if (!Array.isArray(args.ids) || args.ids.length === 0 || args.ids.some((i) => typeof i !== "string" || !UUID.test(i))) {
      throw new Error(`${T}: ids is required, a list of finish summary ids.`);
    }
    if (args.ids.length > 50) throw new Error(`${T}: at most 50 ids per call.`);
    const run = text(T, "run_id", args.run_id);
    if (!run) throw new Error(`${T}: run_id is required: the platform_runs id of the run that reviewed them.`);
    const { data, error } = await ctx.db
      .from("finish_summaries")
      .update({ reviewed_at: new Date().toISOString(), reviewed_by_run: run })
      .in("id", args.ids)
      .select(SUMMARY_COLUMNS);
    if (error) throw new Error(describeDbError(T, error));
    const rows = (data ?? []) as unknown as { id: string }[];
    const missing = (args.ids as string[]).filter((i) => !rows.some((r) => r.id === i));
    return { updated: rows, ...(missing.length ? { not_found: missing } : {}) };
  },
});
