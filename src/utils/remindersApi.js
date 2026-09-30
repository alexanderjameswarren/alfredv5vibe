import { supabase } from "../supabaseClient";

/**
 * reminders persistence for the app. Spec: docs/technical-spec-reminders.md.
 *
 * Rows go straight to PostgREST in the database's spelling, like
 * notificationStepsApi. Every write asks for its rows back: an UPDATE that
 * matches nothing returns [] and no error, and the callers need the count.
 */

const TABLE = "reminders";
const COLUMNS = "id, text, due_at, state, cancel_reason, inbox_id, intent_id";

/** Scheduled reminders linked to one inbox item or intention, soonest first. */
export async function getPendingReminders({ inboxId = null, intentId = null }) {
  let q = supabase.from(TABLE).select(COLUMNS).eq("state", "scheduled");
  if (inboxId) q = q.eq("inbox_id", inboxId);
  else if (intentId) q = q.eq("intent_id", intentId);
  else return [];
  const { data, error } = await q.order("due_at", { ascending: true });
  if (error) throw new Error(`Failed to read reminders: ${error.message}`);
  return data || [];
}

/** Every scheduled reminder, for the list cards: one query per list, not per card. */
export async function getScheduledReminders() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, due_at, inbox_id, intent_id")
    .eq("state", "scheduled")
    .order("due_at", { ascending: true });
  if (error) throw new Error(`Failed to read reminders: ${error.message}`);
  return data || [];
}

/** { byInbox, byIntent }: the soonest due_at per linked row. Rows arrive soonest first. */
export function indexReminders(rows) {
  const byInbox = {};
  const byIntent = {};
  for (const r of rows || []) {
    if (r.inbox_id && !byInbox[r.inbox_id]) byInbox[r.inbox_id] = r.due_at;
    if (r.intent_id && !byIntent[r.intent_id]) byIntent[r.intent_id] = r.due_at;
  }
  return { byInbox, byIntent };
}

/** An item has no reminder link of its own: its reminder stays on its source capture. */
export function itemReminderDueAt(item, index) {
  return (item?.sourceInboxId && index?.byInbox?.[item.sourceInboxId]) || null;
}

/** Processing into an intention: every reminder on the capture follows it. */
export async function moveRemindersToIntention(inboxId, intentId) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({ intent_id: intentId, inbox_id: null })
    .eq("inbox_id", inboxId)
    .select("id");
  if (error) throw new Error(`Failed to move reminders: ${error.message}`);
  return data || [];
}

/** Discard: cancel the capture's scheduled reminders, marked so Undo can find them. */
export async function cancelRemindersForDiscard(inboxId) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({ state: "cancelled", cancel_reason: "inbox_discarded" })
    .eq("inbox_id", inboxId)
    .eq("state", "scheduled")
    .select("id");
  if (error) throw new Error(`Failed to cancel reminders: ${error.message}`);
  return data || [];
}

/** Undo / Put back: re-arm only what the discard cancelled and is still ahead. */
export async function restoreRemindersAfterDiscard(inboxId, now = new Date()) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({ state: "scheduled", cancel_reason: null })
    .eq("inbox_id", inboxId)
    .eq("state", "cancelled")
    .eq("cancel_reason", "inbox_discarded")
    .gt("due_at", now.toISOString())
    .select("id");
  if (error) throw new Error(`Failed to restore reminders: ${error.message}`);
  return data || [];
}

/**
 * Where a tap on an ARCHIVED capture should land: what it became, by sourceInboxId.
 * The item first; else the intention, directly or through an event it created
 * (events have no page of their own). null = nothing, fall back to the Inbox list.
 */
export function archivedCaptureTarget(inboxId, { items = [], intents = [], events = [] } = {}) {
  const from = (rows) => rows.find((r) => r?.sourceInboxId === inboxId);
  const item = from(items);
  if (item) return { kind: "item", id: item.id };
  const intent = from(intents);
  if (intent) return { kind: "intention", id: intent.id };
  const event = from(events);
  if (event?.intentId) return { kind: "intention", id: event.intentId };
  return null;
}

const PACIFIC = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "Thu, Oct 1, 9:00 AM PT" — always Pacific, whatever the device's zone. */
export function formatPacific(iso) {
  return `${PACIFIC.format(new Date(iso))} PT`;
}

const PACIFIC_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });
const PACIFIC_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hour: "numeric",
  minute: "2-digit",
});
const PACIFIC_WEEKDAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "short",
});

/** Card label: "7:17 AM" today in Pacific time, else "Thu 7:17 AM". */
export function formatReminderShort(iso, now = new Date()) {
  const d = new Date(iso);
  const time = PACIFIC_TIME.format(d);
  return PACIFIC_DAY.format(d) === PACIFIC_DAY.format(now)
    ? time
    : `${PACIFIC_WEEKDAY.format(d)} ${time}`;
}
