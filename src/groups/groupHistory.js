import { supabase } from "../supabaseClient";
import { toCamelCase } from "../utils/caseConvert";
import { toLocalDateString } from "../utils/eventDates";

// A project's or series' history (Restructure P5 step 15): every closed, done or
// skipped execution of its live members, newest first.

const q = (v) => `"${String(v).replace(/"/g, '\\"')}"`;

/** PostgREST `or` for executions on these intentions or carrying these items; null when empty. */
export function memberFilter(intentIds = [], itemIds = []) {
  const ors = [];
  if (intentIds.length) ors.push(`intent_id.in.(${intentIds.map(q).join(",")})`);
  for (const id of itemIds) ors.push(`item_ids.cs.${JSON.stringify([id])}`);
  return ors.length ? ors.join(",") : null;
}

/** The latest member executions and how many there are in all: { rows, total }. */
export async function listMemberExecutions({ intentIds = [], itemIds = [], limit = 5 }) {
  const filter = memberFilter(intentIds, itemIds);
  if (!filter) return { rows: [], total: 0 };
  const [{ data, error }, { count, error: countError }] = await Promise.all([
    supabase
      .from("executions")
      .select("id, intent_id, event_id, item_ids, outcome, closed_at")
      .eq("status", "closed")
      .in("outcome", ["done", "skipped"])
      .or(filter)
      .order("closed_at", { ascending: false })
      .limit(limit),
    supabase
      .from("executions")
      .select("id", { count: "exact", head: true })
      .eq("status", "closed")
      .in("outcome", ["done", "skipped"])
      .or(filter),
  ]);
  if (error) throw error;
  const rows = (data || []).map(toCamelCase);
  // A skip is dated by the date it skipped (Phase 4), its event's.
  const eventIds = rows.filter((r) => r.outcome === "skipped" && r.eventId).map((r) => r.eventId);
  const { data: evs } = eventIds.length
    ? await supabase.from("events").select("id, time").in("id", eventIds)
    : { data: [] };
  const timeOf = Object.fromEntries((evs || []).map((e) => [e.id, String(e.time).slice(0, 10)]));
  return {
    rows: rows.map((r) => ({
      ...r,
      day: (r.outcome === "skipped" && timeOf[r.eventId]) || (r.closedAt ? toLocalDateString(new Date(r.closedAt)) : null),
    })),
    total: countError ? rows.length : count || 0,
  };
}

/**
 * Which member an execution belongs to, by name: a member intention, else a member
 * item (carried or through its intention), else the group's own intention. Pure.
 */
export function memberNameFor(execution, { live = [], intents = [], ownIntentionId = null, groupName = "" }) {
  const intention = live.find((m) => m.memberType === "intention" && m.record.id === execution.intentId);
  if (intention) return intention.name;
  const viaIntent = intents.find((i) => i.id === execution.intentId)?.itemId;
  const item = live.find(
    (m) => m.memberType === "item" && (m.record.id === viaIntent || (execution.itemIds || []).includes(m.record.id)),
  );
  if (item) return item.name;
  return execution.intentId && execution.intentId === ownIntentionId ? groupName : "";
}
