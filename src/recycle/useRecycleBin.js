import { useState, useEffect } from "react";
import { supabase } from "../supabaseClient";
import { storage } from "../utils/storage";
import { formatEventDate } from "../utils/eventDates";

// The Recycle Bin's state, loaders and writers, moved out of Alfred.jsx unchanged.
// `refreshData` and `contextArchiveBlockers` still belong to Alfred and come in as arguments.
export function useRecycleBin({ view, refreshData, contextArchiveBlockers }) {
  const [recycleTab, setRecycleTab] = useState("items");
  const [recycleData, setRecycleData] = useState([]);
  const [recycleLoading, setRecycleLoading] = useState(false);
  const [recycleHasMore, setRecycleHasMore] = useState(false);
  const [recycleSelected, setRecycleSelected] = useState(new Set());

  const RECYCLE_PAGE_SIZE = 30;

  /**
   * Wording for a permanent-delete confirmation.
   *
   * These two dialogs are the only confirmations left in the app, and they are
   * kept on purpose: this is the terminal irreversible step, and the Recycle Bin
   * is itself the undo for everything upstream of it. There is nothing behind
   * this one, so it is the one place a confirm is doing real work.
   *
   * Collections get their own wording. For the other six tabs the cascade takes
   * the record's own content, which is what "delete this song" already implies.
   * Deleting a collection also destroys `collection_item_removals` — an
   * append-only log of what was taken out of it and when, kept as the recovery
   * path for accidental removals during shopping. That is a record of actions
   * taken on OTHER things, and nothing in "delete this collection" hints at
   * losing it. This dialog is the last place anyone finds out.
   *
   * `count` is null for the single-row path, which says "this record" rather
   * than counting to one — preserving both existing strings verbatim.
   */
  function permanentDeleteWarning(tab, count = null) {
    const isCollection = tab === "collections";
    // Groups (Restructure P5) cascade the same way: their member list and its
    // removal history go; the items and intentions themselves stay.
    const isGroup = tab === "groups";
    // Contexts reach this point only when empty — the guards above refuse
    // otherwise — so there is nothing to warn about destroying. The generic
    // wording is honest here in a way it is not for collections.
    const noun = isCollection ? "collection" : isGroup ? "group" : tab === "contexts" ? "context" : "record";
    const subject =
      count === null ? `this ${noun}` : `${count} ${noun}${count > 1 ? "s" : ""}`;
    const one = count === null || count === 1;
    const cascade = isCollection
      ? one
        ? " Its item list and removal history will be destroyed."
        : " Their item lists and removal history will be destroyed."
      : isGroup
        ? one
          ? " Its member list, removal history and notes will be destroyed; the items and intentions stay."
          : " Their member lists, removal history and notes will be destroyed; the items and intentions stay."
        : "";
    return `Permanently delete ${subject}?${cascade} This cannot be undone.`;
  }

  async function loadRecycleBin(tab, append = false) {
    setRecycleLoading(true);
    try {
      let query;
      const offset = append ? recycleData.length : 0;
      // Archived tabs: newest archive first, by archived_at (migration 152), id breaking ties.
      const archived = (table, columns) =>
        supabase.from(table).select(`${columns}, updated_at, archived_at`)
          .eq("archived", true)
          .order("archived_at", { ascending: false, nullsFirst: false })
          .order("id", { ascending: true })
          .range(offset, offset + RECYCLE_PAGE_SIZE - 1);

      switch (tab) {
        case "items":
          query = archived("items", "id, name, context_id, tags");
          break;
        case "intents":
          query = archived("intents", "id, text, context_id, recurrence_config, target_start_date, end_date, tags");
          break;
        case "events":
          query = archived("events", "id, intent_id, time, context_id");
          break;
        case "executions":
          query = supabase.from("executions").select("id, intent_id, event_id, outcome, started_at, closed_at, updated_at")
            .eq("status", "closed")
            // Skips are history (Restructure P4 Step 9), not deleted records. Null kept.
            .or("outcome.is.null,outcome.neq.skipped")
            .order("updated_at", { ascending: false, nullsFirst: false })
            .range(offset, offset + RECYCLE_PAGE_SIZE - 1);
          break;
        case "contexts":
          query = archived("contexts", "id, name, description, shared");
          break;
        case "collections":
          // Only the columns the row actually renders. Membership is not read
          // here: an archived collection's `collection_items` rows are untouched
          // by the soft delete, so there is nothing to report and nothing to
          // repair on restore.
          query = archived("item_collections", "id, name, context_id");
          break;
        case "groups":
          // Members are not read here: Alfred already holds every member row, and
          // the derived name is built from them. Archiving never touches members.
          query = archived("item_groups", "id, name, group_type_id, context_id");
          break;
        case "songs":
          query = archived("sam_songs", "id, title, artist");
          break;
        case "snippets":
          query = archived("sam_snippets", "id, title, song_id, start_measure, end_measure");
          break;
        default:
          setRecycleLoading(false);
          return;
      }

      const { data, error } = await query;
      if (error) {
        console.error("[Recycle] Load error:", error);
        setRecycleLoading(false);
        return;
      }

      const camelData = (data || []).map(d => storage.toCamelCase(d));
      setRecycleData(append ? [...recycleData, ...camelData] : camelData);
      setRecycleHasMore((data || []).length === RECYCLE_PAGE_SIZE);
    } catch (e) {
      console.error("[Recycle] Load error:", e);
    } finally {
      setRecycleLoading(false);
    }
  }

  // Why restoring this row would break "one live event, at most one open
  // execution, per intention" — or null when it would not.
  async function restoreBlocker(tab, id) {
    if (tab !== "events" && tab !== "executions") return null;
    const { data: row } = await supabase.from(tab).select("intent_id").eq("id", id).maybeSingle();
    if (!row?.intent_id) return null;
    if (tab === "events") {
      const { data: live } = await supabase
        .from("events").select("id, time")
        .eq("intent_id", row.intent_id).not("archived", "is", true).neq("id", id).limit(1);
      return live?.length
        ? `Its intention already has a live event (${formatEventDate(String(live[0].time).slice(0, 10))}). Reschedule or archive that one first.`
        : null;
    }
    const { data: open } = await supabase
      .from("executions").select("id")
      .eq("intent_id", row.intent_id).in("status", ["active", "paused"]).neq("id", id).limit(1);
    return open?.length ? "Its intention already has an open execution. Finish or cancel that one first." : null;
  }

  async function recycleRestore(tab, id) {
    const blocker = await restoreBlocker(tab, id);
    if (blocker) {
      alert("Not restored. " + blocker);
      return;
    }
    setRecycleLoading(true);
    try {
      let table, updates;
      switch (tab) {
        case "items": table = "items"; updates = { archived: false }; break;
        case "intents": table = "intents"; updates = { archived: false }; break;
        case "events": table = "events"; updates = { archived: false }; break;
        case "executions": table = "executions"; updates = { status: "paused" }; break;
        case "collections": table = "item_collections"; updates = { archived: false }; break;
        // Members were never touched by the archive, so they come back as they were.
        case "groups": table = "item_groups"; updates = { archived: false }; break;
        case "contexts": table = "contexts"; updates = { archived: false }; break;
        case "songs": table = "sam_songs"; updates = { archived: false }; break;
        case "snippets": table = "sam_snippets"; updates = { archived: false }; break;
        default: return;
      }

      const { error } = await supabase.from(table).update(updates).eq("id", id);
      if (error) throw error;

      setRecycleData(prev => prev.filter(r => r.id !== id));

      // Collections MUST be in this list. Items, intents and events each have a
      // realtime channel that would eventually re-sync them anyway; there is no
      // channel on `item_collections`, so without this a restored collection
      // stays invisible until a manual refresh — a silent failure, not a delay.
      // refreshData also re-runs loadCollectionMembers, so the member counts
      // come back with it.
      // "contexts" is here for robustness, NOT necessity — unlike collections.
      // There IS a realtime channel on contexts, so an UPDATE propagates to
      // handleContextChange and the row reappears without this. But realtime
      // can be disconnected (the header shows exactly that state), and items,
      // intents and events are all in this list despite having channels too.
      // Consistent, and correct when the socket is down.
      if (["items", "intents", "events", "collections", "contexts", "groups"].includes(tab)) {
        refreshData();
      }
    } catch (e) {
      console.error("[Recycle] Restore error:", e);
      alert("Failed to restore: " + e.message);
    } finally {
      setRecycleLoading(false);
    }
  }

  // A permanent delete the database refused because rows still point at the
  // target. `sam_snippets` is the case that actually happens: both
  // `sam_sessions.snippet_id` and (since 2026-09-15) `sam_passes.snippet_id`
  // reference it with no ON DELETE rule, so a snippet carrying practice history
  // raises 23503 instead of taking that history down with it. The raw Postgres
  // text names a constraint and tells the user nothing about what to do next.
  function recycleDeleteErrorMessage(e, tab, count = 1) {
    if (e?.code !== "23503") return "Failed to delete: " + e.message;

    if (tab === "snippets") {
      const subject =
        count > 1
          ? `${count} of the selected snippets have`
          : "This snippet has";
      return (
        `${subject} practice history recorded against it — passes, ` +
        "sessions, or both — and deleting it would take that history with it.\n\n" +
        "Archive it instead. An archived snippet leaves the snippet list but " +
        "keeps everything recorded against it, and playing its range again " +
        "restores it with its history intact."
      );
    }

    if (tab === "songs") {
      return (
        "This song still has practice history recorded against it, so it " +
        "cannot be deleted.\n\nArchive it instead to keep that history."
      );
    }

    return (
      "Cannot delete: other records still reference this row, and removing " +
      "it would destroy or orphan them.\n\n" + e.message
    );
  }

  async function recyclePermanentDelete(tab, id) {
    // Re-check emptiness at the far end, not just at archive time. The empty
    // rule is what makes context archiving safe at all, and children can appear
    // between archive and purge — from another device, from an MCP tool, or
    // from Elise on a shared context. Deleting a context with children does not
    // remove them; it leaves them pointing at a row that no longer exists, and
    // an item in that state shows up nowhere at all: Memories filters on
    // `!contextId`, and an orphan HAS one.
    if (tab === "contexts") {
      const blockers = contextArchiveBlockers(id);
      if (blockers.length > 0) {
        window.alert(
          `Cannot delete this context: it still holds ${blockers.join(", ")}. ` +
            "Deleting it would leave those records pointing at nothing, and an " +
            "item in that state is reachable from nowhere. Restore the context " +
            "and empty it first.",
        );
        return;
      }
    }
    if (!window.confirm(permanentDeleteWarning(tab))) return;
    setRecycleLoading(true);
    try {
      let table;
      switch (tab) {
        case "items": table = "items"; break;
        case "intents": table = "intents"; break;
        case "events": table = "events"; break;
        case "executions": table = "executions"; break;
        // The one hard delete left in the app. Cascades to collection_items and
        // collection_item_removals — deliberate, and named in the confirm.
        case "collections": table = "item_collections"; break;
        // Cascades to item_group_members; notes go by trigger. Named in the confirm.
        case "groups": table = "item_groups"; break;
        // Contexts do NOT cascade: no child table carries a foreign key to
        // them. Deleting one ORPHANS its children instead, which is quieter
        // and worse — see the guard above recyclePermanentDelete.
        case "contexts": table = "contexts"; break;
        case "songs": table = "sam_songs"; break;
        case "snippets": table = "sam_snippets"; break;
        default: return;
      }

      const { error } = await supabase.from(table).delete().eq("id", id);
      if (error) throw error;

      setRecycleData(prev => prev.filter(r => r.id !== id));
    } catch (e) {
      console.error("[Recycle] Delete error:", e);
      alert(recycleDeleteErrorMessage(e, tab));
    } finally {
      setRecycleLoading(false);
    }
  }

  function recycleToggleSelect(id) {
    setRecycleSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function recycleSelectAll() {
    if (recycleSelected.size === recycleData.length) {
      setRecycleSelected(new Set());
    } else {
      setRecycleSelected(new Set(recycleData.map(r => r.id)));
    }
  }

  async function recycleBulkRestore() {
    if (recycleSelected.size === 0) return;
    setRecycleLoading(true);
    try {
      let table, updates;
      switch (recycleTab) {
        case "items": table = "items"; updates = { archived: false }; break;
        case "intents": table = "intents"; updates = { archived: false }; break;
        case "events": table = "events"; updates = { archived: false }; break;
        case "executions": table = "executions"; updates = { status: "paused" }; break;
        case "collections": table = "item_collections"; updates = { archived: false }; break;
        // Members were never touched by the archive, so they come back as they were.
        case "groups": table = "item_groups"; updates = { archived: false }; break;
        case "contexts": table = "contexts"; updates = { archived: false }; break;
        case "songs": table = "sam_songs"; updates = { archived: false }; break;
        case "snippets": table = "sam_snippets"; updates = { archived: false }; break;
        default: return;
      }

      const ids = Array.from(recycleSelected);
      let restored = new Set(ids);
      if (recycleTab === "events" || recycleTab === "executions") {
        // One at a time, so a second row for the same intention is refused by
        // the first one's restore rather than failing the whole batch.
        restored = new Set();
        const refused = [];
        for (const id of ids) {
          const blocker = await restoreBlocker(recycleTab, id);
          if (blocker) { refused.push(blocker); continue; }
          const { error } = await supabase.from(table).update(updates).eq("id", id);
          if (error) throw error;
          restored.add(id);
        }
        if (refused.length) alert(`${refused.length} not restored. ${refused[0]}`);
      } else {
        const { error } = await supabase.from(table).update(updates).in("id", ids);
        if (error) throw error;
      }

      setRecycleData(prev => prev.filter(r => !restored.has(r.id)));
      setRecycleSelected(new Set([...recycleSelected].filter((id) => !restored.has(id))));

      // See recycleRestore for why contexts is included and collections is
      // required.
      if (["items", "intents", "events", "collections", "contexts", "groups"].includes(recycleTab)) {
        refreshData();
      }
    } catch (e) {
      console.error("[Recycle] Bulk restore error:", e);
      alert("Failed to restore: " + e.message);
    } finally {
      setRecycleLoading(false);
    }
  }

  async function recycleBulkDelete() {
    if (recycleSelected.size === 0) return;
    if (recycleTab === "contexts") {
      const blocked = Array.from(recycleSelected).filter(
        (id) => contextArchiveBlockers(id).length > 0,
      );
      if (blocked.length > 0) {
        window.alert(
          `${blocked.length} of the selected contexts still hold records. ` +
            "Deleting them would leave those records pointing at nothing. " +
            "Deselect them and try again.",
        );
        return;
      }
    }
    if (!window.confirm(permanentDeleteWarning(recycleTab, recycleSelected.size))) return;
    setRecycleLoading(true);
    try {
      let table;
      switch (recycleTab) {
        case "items": table = "items"; break;
        case "intents": table = "intents"; break;
        case "events": table = "events"; break;
        case "executions": table = "executions"; break;
        // The one hard delete left in the app. Cascades to collection_items and
        // collection_item_removals — deliberate, and named in the confirm.
        case "collections": table = "item_collections"; break;
        // Cascades to item_group_members; notes go by trigger. Named in the confirm.
        case "groups": table = "item_groups"; break;
        // Contexts do NOT cascade: no child table carries a foreign key to
        // them. Deleting one ORPHANS its children instead, which is quieter
        // and worse — see the guard above recyclePermanentDelete.
        case "contexts": table = "contexts"; break;
        case "songs": table = "sam_songs"; break;
        case "snippets": table = "sam_snippets"; break;
        default: return;
      }

      const ids = Array.from(recycleSelected);
      const { error } = await supabase.from(table).delete().in("id", ids);
      if (error) throw error;

      setRecycleData(prev => prev.filter(r => !recycleSelected.has(r.id)));
      setRecycleSelected(new Set());
    } catch (e) {
      console.error("[Recycle] Bulk delete error:", e);
      // The delete is one statement, so a single protected row fails the whole
      // batch and nothing is removed — say so rather than implying a partial.
      alert(recycleDeleteErrorMessage(e, recycleTab, recycleSelected.size));
    } finally {
      setRecycleLoading(false);
    }
  }

  useEffect(() => {
    if (view === "recycle") {
      setRecycleSelected(new Set());
      loadRecycleBin(recycleTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, recycleTab]);

  return {
    recycleTab,
    setRecycleTab,
    recycleData,
    recycleLoading,
    recycleHasMore,
    recycleSelected,
    loadRecycleBin,
    recycleRestore,
    recyclePermanentDelete,
    recycleToggleSelect,
    recycleSelectAll,
    recycleBulkRestore,
    recycleBulkDelete,
  };
}
