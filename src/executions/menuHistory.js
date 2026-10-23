import { useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import { toCamelCase } from "../utils/caseConvert";

// A menu cook's recipe runs point at the menu's run by parent_execution_id (migration
// 154, on delete cascade). These read and move them; deleting the menu run takes them.

/** The recipe runs of these menu runs (any status). */
export async function listCookRecipes(parentIds = []) {
  if (parentIds.length === 0) return [];
  const { data, error } = await supabase
    .from("executions")
    .select("*")
    .in("parent_execution_id", parentIds);
  if (error) throw error;
  return (data || []).map(toCamelCase);
}

/** For recipe runs listed on an item's page: their menu run and group. */
export async function listCookParents(ids = []) {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from("executions")
    .select("id, parent_execution_id, group_id")
    .in("id", ids)
    .not("parent_execution_id", "is", null);
  if (error) throw error;
  return (data || []).map(toCamelCase);
}

/**
 * A recipe's skips inside menus, newest first (step 15's leftover from 14b): skips
 * are otherwise listed by intention, and a recipe in a menu has none.
 */
export async function listMenuSkips(itemId, limit = 5) {
  if (!itemId) return [];
  const { data, error } = await supabase
    .from("executions")
    .select("id, parent_execution_id, group_id, closed_at")
    .contains("item_ids", [itemId])
    .not("parent_execution_id", "is", null)
    .eq("status", "closed")
    .eq("outcome", "skipped")
    .order("closed_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(toCamelCase);
}

/** Move a completed menu's recipe runs to its new completion time. */
export async function moveCookRecipes(menuRun, closedAt) {
  const { error } = await supabase
    .from("executions")
    .update({ closed_at: closedAt })
    .eq("parent_execution_id", menuRun.id)
    .eq("status", "closed");
  if (error) throw new Error("The recipes' completion date was not saved.");
}

/**
 * The recipe runs the cooking page shows: the live ones while the menu is open, else
 * the finished cook's, read once (step 14b). `null` while loading.
 */
export function useCookRecipes(menuRun, liveRuns = []) {
  const closed = menuRun?.status === "closed";
  const [finished, setFinished] = useState(null);
  const id = menuRun?.id;
  useEffect(() => {
    if (!closed || !id) return undefined;
    let live = true;
    listCookRecipes([id])
      .then((rows) => live && setFinished(rows))
      .catch((e) => {
        console.error("[Menu] cook recipes failed:", e);
        if (live) setFinished([]);
      });
    return () => {
      live = false;
    };
  }, [closed, id]);
  return closed ? finished : liveRuns.filter((x) => x.parentExecutionId === id);
}
