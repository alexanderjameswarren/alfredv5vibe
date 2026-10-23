import { supabase } from "../supabaseClient";
import { toCamelCase } from "../utils/caseConvert";

// Reads and writes for public.notes (migration 100). RLS decides who sees and
// adds notes (anyone who can see the target) and who edits (the author only).
const COLUMNS = "id, user_id, target_type, target_id, body, execution_id, created_at, updated_at";

const q = (v) => `"${String(v).replace(/"/g, '\\"')}"`;

// Leaving the execution page saves its note without waiting, so the page you
// land on can read before the write lands. Every write announces itself here
// and the lists that show notes reload.
const listeners = new Set();
export function onNotesChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function changed(note) {
  for (const fn of [...listeners]) fn(note);
}

/**
 * A completed execution appeared, moved or went (Log Execution, its Undo, a date
 * change): everything that lists completions reloads, as after a note change.
 */
export function completionsChanged() {
  changed(null);
}

/** Every note (general and execution) on these items, intentions and groups, newest first. */
export async function listNotesForTargets({ itemIds = [], intentionIds = [], groupIds = [], limit = 100 }) {
  const targets = [];
  if (itemIds.length) targets.push(`and(target_type.eq.item,target_id.in.(${itemIds.map(q).join(",")}))`);
  if (intentionIds.length) targets.push(`and(target_type.eq.intention,target_id.in.(${intentionIds.map(q).join(",")}))`);
  if (groupIds.length) targets.push(`and(target_type.eq.group,target_id.in.(${groupIds.map(q).join(",")}))`);
  if (targets.length === 0) return [];
  const { data, error } = await supabase
    .from("notes")
    .select(COLUMNS)
    .or(targets.join(","))
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return toCamelCase(data || []);
}

/** The latest completed executions of an item (across its intentions) or of one intention, each with its notes. */
export async function listRecentCompletions({ itemId = null, intentId = null, limit = 3 }) {
  const { data, error } = await supabase.rpc("alfred_recent_completions", {
    p_item_id: itemId,
    p_intent_id: intentId,
    p_limit: limit,
  });
  if (error) throw error;
  return toCamelCase(data || []);
}

/**
 * How many completed and skipped executions an intention (`intentIds`) or an item (its
 * intentions, or `item_ids`) has: what "Show all (N older)" counts (Step 9).
 */
export async function countRecentExecutions({ itemId = null, intentIds = [] }) {
  const ors = [];
  if (intentIds.length) ors.push(`intent_id.in.(${intentIds.join(",")})`);
  if (itemId) ors.push(`item_ids.cs.["${itemId}"]`);
  if (ors.length === 0) return 0;
  const { count, error } = await supabase
    .from("executions")
    .select("id", { count: "exact", head: true })
    .eq("status", "closed")
    .in("outcome", ["done", "skipped"])
    .or(ors.join(","));
  if (error) throw error;
  return count || 0;
}

/** The latest skipped executions of these intentions, newest first (Step 9). Never completions. */
export async function listRecentSkips(intentIds, limit = 3) {
  if (intentIds.length === 0) return [];
  const { data, error } = await supabase
    .from("executions")
    .select("id, intent_id, event_id, closed_at")
    .in("intent_id", intentIds)
    .eq("status", "closed")
    .eq("outcome", "skipped")
    .order("closed_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = toCamelCase(data || []);
  // The date skipped is the event's, not the moment of the skip.
  const eventIds = rows.map((r) => r.eventId).filter(Boolean);
  const { data: evs, error: evError } = eventIds.length
    ? await supabase.from("events").select("id, time").in("id", eventIds)
    : { data: [], error: null };
  if (evError) throw evError;
  const timeOf = Object.fromEntries((evs || []).map((e) => [e.id, e.time]));
  return rows.map((r) => ({ ...r, skippedOn: timeOf[r.eventId] ? String(timeOf[r.eventId]).slice(0, 10) : null }));
}

export async function deleteNote(id) {
  const { error } = await supabase.from("notes").delete().eq("id", id);
  if (error) throw error;
  changed({ id });
}

/** Notes for many executions in one query, newest first (the list-card batch). */
export async function listNotesForExecutions(executionIds) {
  if (executionIds.length === 0) return [];
  const { data, error } = await supabase
    .from("notes")
    .select(COLUMNS)
    .in("execution_id", executionIds)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return toCamelCase(data || []);
}

/** Every note written during one execution, oldest first. */
export async function listExecutionNotes(executionId) {
  const { data, error } = await supabase
    .from("notes")
    .select(COLUMNS)
    .eq("execution_id", executionId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return toCamelCase(data || []);
}

/**
 * Create, update or delete one note from a body. Empty text deletes the note
 * (the table refuses a blank body). Returns the row as saved, or null when
 * there is no note any more. Throws on a failed write.
 */
export async function saveNote({ id, body, targetType, targetId, executionId = null }) {
  const text = (body || "").trim();
  if (!text) {
    if (id) await deleteNote(id);
    return null;
  }
  const write = id
    ? supabase.from("notes").update({ body: text }).eq("id", id)
    : supabase.from("notes").insert({
        target_type: targetType,
        target_id: targetId,
        execution_id: executionId,
        body: text,
      });
  const { data, error } = await write.select(COLUMNS).single();
  if (error) throw error;
  const row = toCamelCase(data);
  changed(row);
  return row;
}

/** The signed-in user's id, from the local session (no network round trip). */
export async function currentUserId() {
  const { data } = await supabase.auth.getSession();
  return data?.session?.user?.id || null;
}
