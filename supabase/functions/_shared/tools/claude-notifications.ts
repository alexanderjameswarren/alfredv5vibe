// ============================================================================
// supabase/functions/_shared/tools/claude-notifications.ts
//
// The shared Claude notification log (claude_notifications), for every app, not
// Arnold only. Spec: docs/arnold_v1-technical-spec.md §3.5, §5.
//
//   log_claude_notification   tier 1  log a claude_push or inbox_item notification
//   get_claude_notifications  tier 1  read the log, with today's counts by kind
//
// Alfred pushes are logged by send_alfred_push (alfred-push.ts), which logs and
// sends in one call. Database access ONLY through ctx.db.
// ============================================================================

import { defineTool, envelope, readTable } from "../platform.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
type Row = Record<string, unknown>;

export const KINDS = ["nudge", "encouragement", "flag", "info"];
export const CHANNELS = ["alfred_push", "claude_push", "inbox_item"];
export const DELIVERY_STATUSES = ["pending", "sent", "failed", "no_subscription"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function fail(tool: string, message: string): Error {
  return new Error(`${tool}: ${message}`);
}

/**
 * RAISE EXCEPTION (P0001) and constraint or data errors (classes 22, 23) are the
 * database refusing the request; anything else is operational and retryable.
 */
export function dbError(tool: string, what: string, error: { code?: string; message?: string }): Error {
  const code = error.code ?? "";
  const message = error.message ?? "(no message)";
  if (code === "P0001" || code.startsWith("22") || code.startsWith("23")) {
    return fail(tool, `validation error: ${message}`);
  }
  return fail(tool, `${what} failed: ${message}${code ? ` [${code}]` : ""}`);
}

export function requireText(tool: string, name: string, v: unknown, max: number): string {
  if (typeof v !== "string" || v.trim() === "") throw fail(tool, `\`${name}\` is required and must be non-empty text.`);
  if (v.trim().length > max) throw fail(tool, `\`${name}\` must be at most ${max} characters.`);
  return v.trim();
}

export function optionalText(tool: string, name: string, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw fail(tool, `\`${name}\` must be a string.`);
  return v.trim() === "" ? null : v.trim();
}

export function requireEnum(tool: string, name: string, v: unknown, allowed: string[]): string {
  if (typeof v !== "string" || !allowed.includes(v)) {
    throw fail(tool, `\`${name}\` must be one of ${allowed.join(" | ")}, got ${JSON.stringify(v)}.`);
  }
  return v;
}

export function optionalDate(tool: string, name: string, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  // An impossible date like 2026-13-01 parses to NaN, and toISOString would throw on it.
  const t = typeof v === "string" && DATE_RE.test(v) ? Date.parse(`${v}T00:00:00Z`) : NaN;
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v) {
    throw fail(tool, `\`${name}\` must be a Pacific date "YYYY-MM-DD", got ${JSON.stringify(v)}.`);
  }
  return v as string;
}

const PT_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
});

/** "YYYY-MM-DD" in America/Los_Angeles. */
export function ptDate(d: Date = new Date()): string {
  return PT_DATE.format(d);
}

/** Calls log_claude_notification(); returns {created, id, duplicate_of?}. */
export async function logNotification(db: Db, tool: string, p: {
  app: string; job: string; kind: string; channel: string; title: string; dedupe_key: string;
  body: string | null; link: string | null; local_date?: string | null;
  delivery_status?: string; delivery_detail?: Row | null;
}): Promise<{ created: boolean; id: string; duplicate_of?: Row }> {
  const { data, error } = await db.rpc("log_claude_notification", {
    p_app: p.app,
    p_job: p.job,
    p_kind: p.kind,
    p_channel: p.channel,
    p_title: p.title,
    p_dedupe_key: p.dedupe_key,
    p_body: p.body,
    p_link: p.link,
    p_local_date: p.local_date ?? null,
    p_delivery_status: p.delivery_status ?? "pending",
    p_delivery_detail: p.delivery_detail ?? null,
  });
  if (error) throw dbError(tool, "log_claude_notification", error);
  const row = (Array.isArray(data) ? data[0] : data) as Row | null;
  if (!row || typeof row.created !== "boolean") {
    throw fail(tool, `log_claude_notification returned an unexpected result: ${JSON.stringify(data)}.`);
  }
  return row as { created: boolean; id: string; duplicate_of?: Row };
}

// ---------------------------------------------------------------------------
// log_claude_notification — tier 1 (append)
// ---------------------------------------------------------------------------

export const logClaudeNotificationTool = defineTool({
  name: "log_claude_notification",
  tables: { reads: ["apps", "claude_notifications"], writes: ["claude_notifications"] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "log_claude_notification";
    const channel = requireEnum(tool, "channel", args.channel, ["claude_push", "inbox_item"]);
    const detail = args.delivery_detail;
    if (detail !== undefined && detail !== null && (typeof detail !== "object" || Array.isArray(detail))) {
      throw fail(tool, "`delivery_detail` must be an object, e.g. {\"inbox_id\": \"...\"}.");
    }
    return await logNotification(ctx.db, tool, {
      app: requireText(tool, "app", args.app, 100),
      job: requireText(tool, "job", args.job, 100),
      kind: requireEnum(tool, "kind", args.kind, KINDS),
      channel,
      title: requireText(tool, "title", args.title, 200),
      dedupe_key: requireText(tool, "dedupe_key", args.dedupe_key, 300),
      body: optionalText(tool, "body", args.body),
      link: optionalText(tool, "link", args.link),
      local_date: optionalDate(tool, "local_date", args.local_date),
      // Claude logs what it has just done (or is about to do), so it counts as sent.
      delivery_status: args.delivery_status === undefined
        ? "sent"
        : requireEnum(tool, "delivery_status", args.delivery_status, DELIVERY_STATUSES),
      delivery_detail: (detail as Row | null | undefined) ?? null,
    });
  },
});

// ---------------------------------------------------------------------------
// get_claude_notifications — tier 1
// ---------------------------------------------------------------------------

/** What counts toward a daily limit: notifications Alex could have seen. */
const COUNTED_STATUSES = ["pending", "sent"];

export async function todayCounts(db: Db, tool: string, app: string | null, today: string) {
  let q = db.from("claude_notifications").select("kind, channel, delivery_status")
    .eq("local_date", today).in("delivery_status", COUNTED_STATUSES).limit(1000);
  if (app) q = q.eq("app", app);
  const { data, error } = await q;
  if (error) throw dbError(tool, "today's counts", error);
  const by_kind: Record<string, number> = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const by_channel: Record<string, number> = Object.fromEntries(CHANNELS.map((c) => [c, 0]));
  for (const r of (data ?? []) as Row[]) {
    by_kind[r.kind as string] = (by_kind[r.kind as string] ?? 0) + 1;
    by_channel[r.channel as string] = (by_channel[r.channel as string] ?? 0) + 1;
  }
  return { date: today, app: app ?? "all", by_kind, by_channel };
}

export const getClaudeNotificationsTool = defineTool({
  name: "get_claude_notifications",
  tables: { reads: ["claude_notifications"], writes: [] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_claude_notifications";
    const app = optionalText(tool, "app", args.app);
    const job = optionalText(tool, "job", args.job);
    const kind = args.kind === undefined ? null : requireEnum(tool, "kind", args.kind, KINDS);
    const channel = args.channel === undefined ? null : requireEnum(tool, "channel", args.channel, CHANNELS);
    const from = optionalDate(tool, "date_from", args.date_from);
    const to = optionalDate(tool, "date_to", args.date_to);
    if (from && to && from > to) throw fail(tool, `date_from (${from}) is after date_to (${to}).`);

    const today = await todayCounts(ctx.db, tool, app, ptDate());
    const page = await readTable(ctx, {
      tool,
      table: "claude_notifications",
      args,
      filter: (query) => {
        let q = query;
        if (app) q = q.eq("app", app);
        if (job) q = q.eq("job", job);
        if (kind) q = q.eq("kind", kind);
        if (channel) q = q.eq("channel", channel);
        if (from) q = q.gte("local_date", from);
        if (to) q = q.lte("local_date", to);
        return q;
      },
      order: [{ column: "created_at", ascending: false }, { column: "id", ascending: true }],
      fullText: ["body"],
    });
    return envelope({ today, notifications: page.data }, page.meta);
  },
});
