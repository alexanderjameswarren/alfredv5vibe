import { supabase } from "../supabaseClient";

/**
 * reminders persistence for the app. Spec: docs/technical-spec-reminders.md.
 *
 * Rows go straight to PostgREST in the database's spelling, like
 * notificationStepsApi. Every write asks for its rows back: an UPDATE that
 * matches nothing returns [] and no error, and the callers need the count.
 */

const TABLE = "reminders";
const SHOWN_STATES = ["scheduled", "sent"]; // cancelled and no_subscription show nothing
const LIST_COLUMNS = "id, state, due_at, sent_at, inbox_id, intent_id";

const sentAt = (r) => r.sent_at || r.due_at;

/**
 * What one link shows: soonest scheduled wins; else the latest sent; else null.
 * Returns { scheduled: [rows soonest first], lastSent: row | null }.
 */
export function summariseReminders(rows) {
  const scheduled = (rows || [])
    .filter((r) => r.state === "scheduled")
    .sort((a, b) => a.due_at.localeCompare(b.due_at));
  const sent = (rows || []).filter((r) => r.state === "sent");
  const lastSent = sent.reduce((best, r) => (!best || sentAt(r) > sentAt(best) ? r : best), null);
  return { scheduled, lastSent };
}

/** Detail pages: scheduled and sent reminders for one inbox item or intention. */
export async function getReminderSummary({ inboxId = null, intentId = null }) {
  let q = supabase.from(TABLE).select(`${LIST_COLUMNS}, text`).in("state", SHOWN_STATES);
  if (inboxId) q = q.eq("inbox_id", inboxId);
  else if (intentId) q = q.eq("intent_id", intentId);
  else return summariseReminders([]);
  const { data, error } = await q.order("due_at", { ascending: true });
  if (error) throw new Error(`Failed to read reminders: ${error.message}`);
  return summariseReminders(data);
}

/** Every scheduled or sent reminder, for the list cards: one query per list, not per card. */
export async function getListReminders() {
  const { data, error } = await supabase
    .from(TABLE)
    .select(LIST_COLUMNS)
    .in("state", SHOWN_STATES)
    .order("due_at", { ascending: true });
  if (error) throw new Error(`Failed to read reminders: ${error.message}`);
  return data || [];
}

/**
 * { byInbox, byIntent }, each link -> { kind: "scheduled" | "sent", at }: the soonest
 * scheduled due_at, else the latest sent_at.
 */
export function indexReminders(rows) {
  const group = (key) => {
    const buckets = {};
    for (const r of rows || []) {
      if (r[key]) (buckets[r[key]] = buckets[r[key]] || []).push(r);
    }
    const out = {};
    for (const [id, rs] of Object.entries(buckets)) {
      const { scheduled, lastSent } = summariseReminders(rs);
      if (scheduled.length) out[id] = { kind: "scheduled", at: scheduled[0].due_at };
      else if (lastSent) out[id] = { kind: "sent", at: sentAt(lastSent) };
    }
    return out;
  };
  return { byInbox: group("inbox_id"), byIntent: group("intent_id") };
}

/** An item has no reminder link of its own: its reminder stays on its source capture. */
export function itemReminder(item, index) {
  return (item?.sourceInboxId && index?.byInbox?.[item.sourceInboxId]) || null;
}

/** Card badge for an index entry: { text, muted }, or null. */
export function reminderBadge(entry, now = new Date()) {
  if (!entry) return null;
  if (entry.kind === "scheduled") return { text: formatReminderShort(entry.at, now), muted: false };
  return { text: `Sent ${formatSentShort(entry.at, now)}`, muted: true };
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

const PACIFIC_MONTH_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "short",
  day: "numeric",
});
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Sent label: "7:36 AM" today, "Wed 7:36 AM" within the last week, else "Sep 30". */
export function formatSentShort(iso, now = new Date()) {
  const d = new Date(iso);
  if (PACIFIC_DAY.format(d) === PACIFIC_DAY.format(now)) return PACIFIC_TIME.format(d);
  if (now.getTime() - d.getTime() < WEEK_MS) {
    return `${PACIFIC_WEEKDAY.format(d)} ${PACIFIC_TIME.format(d)}`;
  }
  return PACIFIC_MONTH_DAY.format(d);
}

/** Card label: "7:17 AM" today in Pacific time, else "Thu 7:17 AM". */
export function formatReminderShort(iso, now = new Date()) {
  const d = new Date(iso);
  const time = PACIFIC_TIME.format(d);
  return PACIFIC_DAY.format(d) === PACIFIC_DAY.format(now)
    ? time
    : `${PACIFIC_WEEKDAY.format(d)} ${time}`;
}
