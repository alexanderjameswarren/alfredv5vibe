// ============================================================================
// supabase/functions/_shared/tools/overwatch-activity.ts
//
// Overwatch's activity log. Spec: docs/technical-spec-overwatch-q4n.md 4.2 and 7.
//
//   get_activity  tier 1 — what got done, newest first: date range, app, context, group, kind, tag, source.
//   log_activity  tier 1 — append one row; a repeated (source, source_ref) returns the row already there.
//
// Alfred's own closes are logged by database triggers (source 'trigger'); this tool logs everything else.
// ============================================================================

import { defineTool, describeDbError, readTable } from "../platform.ts";

export const ACTIVITY_KINDS = ["shipped", "done", "progress", "used"] as const;
export const ACTIVITY_SOURCES = ["trigger", "claude", "cli", "nightly", "manual"] as const;
// 'trigger' is the database's own; a tool never writes it.
export const LOG_SOURCES = ["claude", "cli", "nightly", "manual"] as const;
export const ACTIVITY_TARGETS = ["item", "intention", "group", "execution", "job_application", "other"] as const;

const COLUMNS =
  "id, occurred_at, app_id, context_id, group_id, target_type, target_id, kind, title, summary, source, source_ref, tags, created_at";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

/** Midnight in America/Los_Angeles at the start of `day` (YYYY-MM-DD), as a UTC ISO string. */
export function pacificMidnight(day: string): string {
  const noonUtc = new Date(`${day}T12:00:00Z`);
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "shortOffset" })
    .formatToParts(noonUtc).find((p) => p.type === "timeZoneName")?.value ?? "GMT-8";
  const m = /GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(name);
  const hours = m ? Number(m[1]) : -8;
  const minutes = m?.[2] ? Number(m[2]) * Math.sign(hours) : 0;
  return new Date(Date.parse(`${day}T00:00:00Z`) - (hours * 60 + minutes) * 60_000).toISOString();
}

/** A bound: a Pacific date (from = its midnight; to = the next midnight, exclusive) or an ISO time with offset. */
export function parseBound(T: string, key: "from" | "to", value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${T}: ${key} must be a date (YYYY-MM-DD) or an ISO time with offset.`);
  const s = value.trim();
  if (DAY.test(s)) {
    if (Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new Error(`${T}: ${key} ${JSON.stringify(s)} is not a real date.`);
    if (key === "from") return pacificMidnight(s);
    const next = new Date(Date.parse(`${s}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    return pacificMidnight(next);
  }
  if (WITH_OFFSET.test(s) && !Number.isNaN(Date.parse(s))) return new Date(s).toISOString();
  throw new Error(
    `${T}: ${key} must be a Pacific date (YYYY-MM-DD) or an ISO time WITH offset; got ${JSON.stringify(value)}.`,
  );
}

function optionalText(T: string, key: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${T}: ${key} must be a non-empty string when given.`);
  return value.trim();
}

function oneOf<V extends string>(T: string, key: string, value: unknown, allowed: readonly V[]): V | null {
  if (value === undefined || value === null) return null;
  if (!(allowed as readonly unknown[]).includes(value)) {
    throw new Error(`${T}: ${key} must be one of ${allowed.join(", ")}; got ${JSON.stringify(value)}.`);
  }
  return value as V;
}

// ---------------------------------------------------------------------------
// get_activity — tier 1
// ---------------------------------------------------------------------------

export const getActivityTool = defineTool({
  name: "get_activity",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_activity";
    const from = parseBound(T, "from", args.from);
    const to = parseBound(T, "to", args.to);
    if (from && to && from >= to) throw new Error(`${T}: from must be before to.`);
    const kind = oneOf(T, "kind", args.kind, ACTIVITY_KINDS);
    const source = oneOf(T, "source", args.source, ACTIVITY_SOURCES);
    const appId = optionalText(T, "app_id", args.app_id);
    const contextId = optionalText(T, "context_id", args.context_id);
    const groupId = optionalText(T, "group_id", args.group_id);
    const tag = optionalText(T, "tag", args.tag);

    return await readTable(ctx, {
      tool: T,
      table: "activity",
      args,
      filter: (query) => {
        let q = query;
        if (from) q = q.gte("occurred_at", from);
        if (to) q = q.lt("occurred_at", to);
        if (kind) q = q.eq("kind", kind);
        if (source) q = q.eq("source", source);
        if (appId) q = q.eq("app_id", appId);
        if (contextId) q = q.eq("context_id", contextId);
        if (groupId) q = q.eq("group_id", groupId);
        // Tags are a snapshot taken when the row was written (spec 4.2).
        if (tag) q = q.contains("tags", [tag]);
        return q;
      },
      order: [{ column: "occurred_at", ascending: false }, { column: "id", ascending: true }],
    });
  },
});

// ---------------------------------------------------------------------------
// log_activity — tier 1
// ---------------------------------------------------------------------------
// Tier 1: it appends to an append-only log. With a source_ref, a second call is a no-op that returns the first
// row (the unique index is partial, so PostgREST cannot upsert on it: look first, insert, look again on a race).

export const logActivityTool = defineTool({
  name: "log_activity",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "log_activity";
    const kind = oneOf(T, "kind", args.kind, ACTIVITY_KINDS);
    if (!kind) throw new Error(`${T}: kind is required: ${ACTIVITY_KINDS.join(", ")}.`);
    if (args.source === "trigger") {
      throw new Error(`${T}: source 'trigger' is written only by the database; use ${LOG_SOURCES.join(", ")}.`);
    }
    const source = oneOf(T, "source", args.source, LOG_SOURCES);
    if (!source) {
      throw new Error(`${T}: source is required: ${LOG_SOURCES.join(", ")} ('trigger' is written only by the database).`);
    }
    const title = optionalText(T, "title", args.title);
    if (!title) throw new Error(`${T}: title is required, one line.`);
    if (title.length > 300) throw new Error(`${T}: title is ${title.length} characters; keep it to one line (300 at most).`);
    const targetType = oneOf(T, "target_type", args.target_type, ACTIVITY_TARGETS) ?? "other";
    const sourceRef = optionalText(T, "source_ref", args.source_ref);
    let occurredAt = new Date().toISOString();
    if (args.occurred_at !== undefined && args.occurred_at !== null) {
      if (typeof args.occurred_at !== "string" || !WITH_OFFSET.test(args.occurred_at.trim()) ||
          Number.isNaN(Date.parse(args.occurred_at))) {
        throw new Error(`${T}: occurred_at must be an ISO time WITH offset, e.g. 2026-10-24T09:30:00-07:00.`);
      }
      occurredAt = new Date(args.occurred_at).toISOString();
    }
    let tags: string[] = [];
    if (args.tags !== undefined && args.tags !== null) {
      if (!Array.isArray(args.tags) || args.tags.some((t) => typeof t !== "string" || !t.trim())) {
        throw new Error(`${T}: tags must be a list of non-empty strings.`);
      }
      tags = [...new Set((args.tags as string[]).map((t) => t.trim()))];
    }

    const existing = async () => {
      if (!sourceRef) return null;
      const { data, error } = await ctx.db.from("activity").select(COLUMNS)
        .eq("source", source).eq("source_ref", sourceRef).maybeSingle();
      if (error) throw new Error(describeDbError(T, error));
      return data;
    };
    const before = await existing();
    if (before) return { ...before, already_logged: true };

    const row = {
      occurred_at: occurredAt,
      app_id: optionalText(T, "app_id", args.app_id) ?? "alfred",
      context_id: optionalText(T, "context_id", args.context_id),
      group_id: optionalText(T, "group_id", args.group_id),
      target_type: targetType,
      target_id: optionalText(T, "target_id", args.target_id),
      kind,
      title,
      summary: optionalText(T, "summary", args.summary),
      source,
      source_ref: sourceRef,
      tags,
    };
    const { data, error } = await ctx.db.from("activity").insert(row).select(COLUMNS).maybeSingle();
    if (error?.code === "23505") {
      const raced = await existing();
      if (raced) return { ...raced, already_logged: true };
    }
    if (error) throw new Error(describeDbError(T, error));
    return { ...data, already_logged: false };
  },
});
