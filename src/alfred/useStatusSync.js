import { supabase } from "../supabaseClient";
import { toCamelCase } from "../utils/caseConvert";
import { flippedToActive, mergeStatuses } from "../utils/status";

// The 088 triggers move status in the database after an event or execution
// insert; the browser never does. An action that may cause that calls
// `watchStatus` with the rows as they stood BEFORE its write, and awaits the
// returned `settle` AFTER it: the rows' status is re-read, merged into state,
// and "Moved to active" shown if any flipped. Before-states are taken from the
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

  // `refreshIntentIds`: rows created by the same action. Re-read and merged,
  // never announced — they had no status to move from.
  function watchStatus({ intents = [], items = [], refreshIntentIds = [] }) {
    const before = { intents: intents.filter(Boolean), items: items.filter(Boolean) };
    return async function settle() {
      const [freshIntents, freshItems] = await Promise.all([
        readStatuses("intents", [...before.intents.map((r) => r.id), ...refreshIntentIds]),
        readStatuses("items", before.items.map((r) => r.id)),
      ]);
      if (freshIntents.length) setIntents((prev) => mergeStatuses(prev, freshIntents));
      if (freshItems.length) setItems((prev) => mergeStatuses(prev, freshItems));
      const flipped = [
        ...flippedToActive(before.intents, freshIntents),
        ...flippedToActive(before.items, freshItems),
      ];
      if (flipped.length) showNotice("Moved to active");
    };
  }

  return { watchStatus };
}
