// ============================================================================
// supabase/functions/_shared/tools/reminders.ts
//
// Standalone reminders. Spec: docs/technical-spec-reminders.md.
//
//   create_reminder  tier 1 — one push at a fixed time; creates an inbox item
//                             to back it when nothing is linked.
//   get_reminders    tier 1 — scheduled by default, soonest first.
//   update_reminder  tier 2 — change text, reschedule, or cancel.
//
// notify-dispatch sends them; these tools only write the rows.
// ============================================================================

import { clampLimit, defineTool, describeDbError, envelope } from "../platform.ts";

export const REMINDER_STATES = ["scheduled", "sent", "cancelled", "no_subscription"] as const;

const COLUMNS =
  "id, text, due_at, state, cancel_reason, sent_at, inbox_id, intent_id, created_by, created_at, updated_at";

// ISO 8601 with an explicit offset: Z or ±HH:MM. A bare local time is refused,
// because Postgres would silently read it in the session time zone (UTC).
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

/** Validate due_at and return it as a UTC ISO string. Shared by create and update. */
export function parseDueAt(T: string, value: unknown, now: Date = new Date()): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${T}: due_at is required, as ISO 8601 with a UTC offset (e.g. 2026-10-01T09:00:00-07:00).`);
  }
  const s = value.trim();
  if (!WITH_OFFSET.test(s)) {
    throw new Error(
      `${T}: due_at must be ISO 8601 WITH a UTC offset, e.g. 2026-10-01T09:00:00-07:00 or ` +
        `2026-10-01T16:00:00Z. Got ${JSON.stringify(value)}. Alex is in America/Los_Angeles ` +
        `(-07:00 in daylight time, -08:00 in standard time).`,
    );
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`${T}: due_at ${JSON.stringify(value)} is not a real date and time.`);
  }
  if (d.getTime() <= now.getTime()) {
    throw new Error(
      `${T}: due_at ${s} is in the past (now is ${now.toISOString()}). A reminder must be in the future.`,
    );
  }
  return d.toISOString();
}

function optionalId(T: string, key: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${T}: ${key} must be a non-empty string when given.`);
  }
  return value.trim();
}

function requireText(T: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${T}: text is required — the notification body Alex will see.`);
  }
  return value.trim();
}

// ---------------------------------------------------------------------------
// create_reminder — tier 1
// ---------------------------------------------------------------------------
// Tier 1 like create_inbox_item: it appends, and what it creates lands in the
// inbox where Alex sees it. Goes through public.create_reminder so the backing
// inbox row and the reminder are one transaction.

export const createReminderTool = defineTool({
  name: "create_reminder",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "create_reminder";
    const text = requireText(T, args.text);
    const dueAt = parseDueAt(T, args.due_at);
    const inboxId = optionalId(T, "inbox_id", args.inbox_id);
    const intentId = optionalId(T, "intent_id", args.intent_id);
    if (inboxId && intentId) {
      throw new Error(`${T}: give inbox_id OR intent_id, not both. Nothing was created.`);
    }

    const { data, error } = await ctx.db.rpc("create_reminder", {
      p_text: text,
      p_due_at: dueAt,
      p_inbox_id: inboxId,
      p_intent_id: intentId,
      p_created_by: "claude",
    });
    if (error) throw new Error(describeDbError(T, error));
    return data;
  },
});

// ---------------------------------------------------------------------------
// get_reminders — tier 1
// ---------------------------------------------------------------------------

export const getRemindersTool = defineTool({
  name: "get_reminders",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_reminders";
    const state = args.state === undefined || args.state === null ? "scheduled" : args.state;
    if (state !== "all" && !(REMINDER_STATES as readonly unknown[]).includes(state)) {
      throw new Error(
        `${T}: state must be one of ${REMINDER_STATES.join(", ")} or all. Got ${JSON.stringify(args.state)}.`,
      );
    }
    const inboxId = optionalId(T, "inbox_id", args.inbox_id);
    const intentId = optionalId(T, "intent_id", args.intent_id);
    const LIMIT = clampLimit(args.limit as number | undefined);

    let q = ctx.db.from("reminders").select(COLUMNS, { count: "exact" });
    if (state !== "all") q = q.eq("state", state as string);
    if (inboxId) q = q.eq("inbox_id", inboxId);
    if (intentId) q = q.eq("intent_id", intentId);
    // Pending: soonest first. Anything else: most recent first.
    const { data, error, count } = await q
      .order("due_at", { ascending: state === "scheduled" })
      .limit(LIMIT);
    if (error) throw new Error(`${T}: ${error.message}`);

    const rows = data ?? [];
    const total = count ?? rows.length;
    return envelope(rows, { count: total, limit_applied: LIMIT, truncated: total > rows.length });
  },
});

// ---------------------------------------------------------------------------
// update_reminder — tier 2
// ---------------------------------------------------------------------------
// One of three changes per call, which keeps the resulting state obvious:
// text (state untouched), due_at (re-arms: scheduled, sent_at and
// cancel_reason cleared), or cancel (cancelled, reason 'manual').

export const updateReminderTool = defineTool({
  name: "update_reminder",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "update_reminder";
    const id = optionalId(T, "id", args.id);
    if (!id) throw new Error(`${T}: id is required.`);

    const cancel = args.cancel === true;
    if (args.cancel !== undefined && args.cancel !== null && typeof args.cancel !== "boolean") {
      throw new Error(`${T}: cancel must be true or false.`);
    }
    const hasText = args.text !== undefined && args.text !== null;
    const hasDue = args.due_at !== undefined && args.due_at !== null;
    if (cancel && (hasText || hasDue)) {
      throw new Error(`${T}: cancel cannot be combined with text or due_at. Nothing was changed.`);
    }
    if (!cancel && !hasText && !hasDue) {
      throw new Error(`${T}: nothing to change — pass text, due_at, or cancel: true.`);
    }

    const { data: current, error: readError } = await ctx.db
      .from("reminders")
      .select("id, state")
      .eq("id", id)
      .maybeSingle();
    if (readError) throw new Error(`${T}: ${readError.message}`);
    if (!current) {
      throw new Error(`${T}: no reminder ${id} that you can see. Nothing was changed.`);
    }

    const patch: Record<string, unknown> = {};
    if (cancel) {
      if (current.state === "sent" || current.state === "cancelled") {
        throw new Error(`${T}: reminder ${id} is already ${current.state}; there is nothing to cancel.`);
      }
      patch.state = "cancelled";
      patch.cancel_reason = "manual";
    } else {
      if (hasText) patch.text = requireText(T, args.text);
      if (hasDue) {
        patch.due_at = parseDueAt(T, args.due_at);
        patch.state = "scheduled";
        patch.sent_at = null;
        patch.cancel_reason = null;
      }
    }

    const { data, error } = await ctx.db
      .from("reminders")
      .update(patch)
      .eq("id", id)
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw new Error(`${T}: ${error.message}`);
    if (!data) throw new Error(`${T}: reminder ${id} could not be updated. Nothing was changed.`);
    return data;
  },
});
