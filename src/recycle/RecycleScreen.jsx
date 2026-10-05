import React from "react";
import { ArchiveRestore, Scissors, Trash2 } from "lucide-react";
import UnderlineTabs from "../shared/UnderlineTabs";
import { OBJECT_ICONS } from "../shared/ObjectIcon";
import { getRecurrenceDisplayString } from "../utils/recurrenceDisplay";

// The Recycle Bin screen, moved out of Alfred.jsx unchanged. Everything it reads comes
// in as props: `contexts` and `intents` from Alfred, the rest from useRecycleBin.
export default function RecycleScreen({
  contexts,
  intents,
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
}) {
  return (
    <div>
      <h2 className="text-lg sm:text-xl font-medium mb-3 sm:mb-4">Recycle Bin</h2>

      {/* Tabs */}
      {/* No counts here, deliberately: each tab's contents are fetched per tab,
          so a number would mean a query per tab on arrival.

          EVERY TAB CARRIES AN ICON — Clipboard Step 22 — and with no counts the
          icon is the WHOLE tab below `lg`. So these are the six glyphs the top
          navigation already uses for the same six records, straight out of
          `OBJECT_ICONS`: whatever a record looks like in the nav is what it looks
          like here.

          ⚠️ Two of the eight are not in that vocabulary, because the nav has one
          SAM entry and this row has two:

            Songs      `Music` — OBJECT_ICONS.sam, the nav's SAM glyph.
            Snippets   `Scissors` — CHOSEN, not reused. Reusing `Music` verbatim
                       would give this row two identical icons, and below `lg`
                       they are all it has: two indistinguishable tabs with no
                       counts to tell them apart. A snippet IS a clipping out of a
                       song, `Scissors` says so, and it is used nowhere else in
                       Alfred so it cannot collide. */}
      <UnderlineTabs
        ariaLabel="Recycle bin record types"
        activeKey={recycleTab}
        onSelect={setRecycleTab}
        className="gap-4 mb-4 text-sm"
        tabs={[
          { key: "items", label: "Items", icon: OBJECT_ICONS.item },
          { key: "intents", label: "Intents", icon: OBJECT_ICONS.intention },
          { key: "events", label: "Events", icon: OBJECT_ICONS.event },
          { key: "executions", label: "Executions", icon: OBJECT_ICONS.execution },
          { key: "collections", label: "Collections", icon: OBJECT_ICONS.collection },
          { key: "contexts", label: "Contexts", icon: OBJECT_ICONS.context },
          { key: "songs", label: "Songs", icon: OBJECT_ICONS.sam },
          { key: "snippets", label: "Snippets", icon: Scissors },
        ]}
      />

      {/* Bulk action bar */}
      <div className="flex items-center justify-between mb-3">
        <label className="flex items-center gap-2 cursor-pointer min-h-[44px]">
          <input
            type="checkbox"
            checked={recycleData.length > 0 && recycleSelected.size === recycleData.length}
            onChange={recycleSelectAll}
            className="w-4 h-4 rounded border-border accent-primary"
          />
          <span className="text-sm text-muted-foreground">
            {recycleSelected.size > 0
              ? `${recycleSelected.size} selected`
              : "Select all"}
          </span>
        </label>
        {recycleSelected.size > 0 && (
          <div className="flex gap-2">
            <button
              onClick={recycleBulkRestore}
              disabled={recycleLoading}
              className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-success hover:bg-secondary rounded-lg transition-colors min-h-[44px] disabled:opacity-50"
            >
              <ArchiveRestore className="w-4 h-4" />
              Restore
            </button>
            <button
              onClick={recycleBulkDelete}
              disabled={recycleLoading}
              className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-destructive hover:bg-secondary rounded-lg transition-colors min-h-[44px] disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4" />
              Delete
            </button>
          </div>
        )}
      </div>

      {/* Content */}
      {recycleLoading && recycleData.length === 0 ? (
        <p className="text-muted-foreground text-sm">Loading...</p>
      ) : recycleData.length === 0 ? (
        <p className="text-muted-foreground text-sm">No archived {recycleTab}.</p>
      ) : (
        <div className="space-y-2">
          {recycleData.map((record) => {
            let title = "";
            let subtitle = "";
            const contextName = record.contextId
              ? contexts.find((c) => c.id === record.contextId)?.name
              : null;

            switch (recycleTab) {
              case "items":
                title = record.name || "Untitled item";
                subtitle = [contextName, (record.tags || []).join(", ")].filter(Boolean).join(" · ");
                break;
              case "intents":
                title = record.text || "Untitled intent";
                subtitle = [contextName, record.recurrenceConfig && record.recurrenceConfig.type !== "once" ? getRecurrenceDisplayString(record.recurrenceConfig) : null].filter(Boolean).join(" · ");
                break;
              case "events": {
                const intent = intents.find((i) => i.id === record.intentId);
                title = intent ? intent.text : "Unknown intent";
                subtitle = [record.time, contextName].filter(Boolean).join(" · ");
                break;
              }
              case "executions": {
                const intent = intents.find((i) => i.id === record.intentId);
                title = intent ? intent.text : "Unknown intent";
                subtitle = [record.outcome, record.closedAt ? new Date(record.closedAt).toLocaleDateString() : null].filter(Boolean).join(" · ");
                break;
              }
              case "collections":
                title = record.name || "Untitled collection";
                subtitle = contextName || "";
                break;
              case "contexts":
                title = record.name || "Untitled context";
                subtitle = [record.description, record.shared ? "Shared" : null]
                  .filter(Boolean)
                  .join(" · ");
                break;
              case "songs":
                title = record.title || "Untitled song";
                subtitle = record.artist || "";
                break;
              case "snippets":
                title = record.title || "Untitled snippet";
                subtitle = `Measures ${record.startMeasure}–${record.endMeasure}`;
                break;
              default:
                break;
            }

            const updatedLabel = record.updatedAt
              ? new Date(record.updatedAt).toLocaleDateString()
              : "";

            return (
              <div
                key={record.id}
                className="flex items-center gap-3 px-4 py-3 bg-card border border-border rounded-lg group"
              >
                <input
                  type="checkbox"
                  checked={recycleSelected.has(record.id)}
                  onChange={() => recycleToggleSelect(record.id)}
                  className="w-4 h-4 flex-shrink-0 rounded border-border accent-primary"
                />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-foreground truncate">{title}</p>
                  {(subtitle || updatedLabel) && (
                    <p className="text-xs text-muted-foreground truncate">
                      {[subtitle, updatedLabel].filter(Boolean).join(" · ")}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => recycleRestore(recycleTab, record.id)}
                  className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-success transition-colors"
                  title="Restore"
                >
                  <ArchiveRestore className="w-4 h-4" />
                </button>
                <button
                  onClick={() => recyclePermanentDelete(recycleTab, record.id)}
                  className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors"
                  title="Delete forever"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            );
          })}

          {/* Load More */}
          {recycleHasMore && (
            <button
              onClick={() => loadRecycleBin(recycleTab, true)}
              disabled={recycleLoading}
              className="w-full py-3 text-sm text-primary hover:text-primary-hover font-medium disabled:opacity-50"
            >
              {recycleLoading ? "Loading..." : "Load more"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
