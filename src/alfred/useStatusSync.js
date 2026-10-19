import { supabase } from "../supabaseClient";
import { toCamelCase } from "../utils/caseConvert";
import { storage, writeError } from "../utils/storage";
import { CLOSE_REASON_SAVED, flippedToActive, mergeStatuses, statusOf } from "../utils/status";

// The 088 triggers move status in the database after an event or execution
// insert; the browser never does. An action that may cause that calls
// `watchStatus` with the rows as they stood BEFORE its write, and awaits the
// returned `settle` AFTER it: the rows' status is re-read, merged into state,
// and "Moved to Active" shown if any flipped. Before-states are taken from the
// caller, not from state, because realtime may already have delivered the flip.
export function useStatusSync({ setIntents, setItems, showNotice }) {
  async function readStatuses(table, ids) {
    if (!ids.length) return [];
    const { data, error } = await supabase
      .from(table)
      .select("id, status, status_changed_at")
      .in("id", ids);
    if (error) {
      console.error(`[status] re-read ${table} failed:`, error);
      return [];
    }
    return (data || []).map(toCamelCase);
  }

  // Puts flipped rows back to their status before the action (Undo). Someday cannot
  // come back (status_guard refuses it); those stay Active. Stops at a failed write.
  async function restoreStatuses(flips) {
    for (const { key, row } of flips) {
      const was = statusOf(row);
      if (was === "someday") continue;
      const back = await storage.patch(key, {
        status: was,
        ...(CLOSE_REASON_SAVED ? { statusChangedAt: row.statusChangedAt } : {}),
      });
      if (!back) throw writeError("Restoring the status");
      const set = key.startsWith("intent:") ? setIntents : setItems;
      set((prev) => prev.map((r) => (r.id === back.id ? { ...r, status: back.status, statusChangedAt: back.statusChangedAt } : r)));
    }
  }

  // `refreshIntentIds`: rows created by the same action. Re-read and merged,
  // never announced — they had no status to move from.
  function watchStatus({ intents = [], items = [], refreshIntentIds = [] }) {
    const before = { intents: intents.filter(Boolean), items: items.filter(Boolean) };
    // Returns { moved, restore }: whether anything flipped, and the Undo for it.
    // `announce: false`: the caller folds " Moved to Active." into its own toast
    // (one tap, one message) and runs `restore` in that toast's Undo.
    return async function settle({ announce = true } = {}) {
      const [freshIntents, freshItems] = await Promise.all([
        readStatuses("intents", [...before.intents.map((r) => r.id), ...refreshIntentIds]),
        readStatuses("items", before.items.map((r) => r.id)),
      ]);
      if (freshIntents.length) setIntents((prev) => mergeStatuses(prev, freshIntents));
      if (freshItems.length) setItems((prev) => mergeStatuses(prev, freshItems));
      const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
      const was = { intents: byId(before.intents), items: byId(before.items) };
      const flips = [
        ...flippedToActive(before.intents, freshIntents).map((r) => ({ key: `intent:${r.id}`, row: was.intents.get(r.id) })),
        ...flippedToActive(before.items, freshItems).map((r) => ({ key: `item:${r.id}`, row: was.items.get(r.id) })),
      ];
      if (flips.length && announce) showNotice("Moved to Active");
      return { moved: flips.length > 0, restore: () => restoreStatuses(flips) };
    };
  }

  return { watchStatus };
}
