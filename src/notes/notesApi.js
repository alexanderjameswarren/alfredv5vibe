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

/** Every note (general and execution) on these items and intentions, newest first. */
export async function listNotesForTargets({ itemIds = [], intentionIds = [], limit = 100 }) {
  const targets = [];
  if (itemIds.length) targets.push(`and(target_type.eq.item,target_id.in.(${itemIds.map(q).join(",")}))`);
  if (intentionIds.length) targets.push(`and(target_type.eq.intention,target_id.in.(${intentionIds.map(q).join(",")}))`);
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
