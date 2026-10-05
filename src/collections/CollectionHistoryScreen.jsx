import React from "react";
import { ArrowLeft } from "lucide-react";
import RemovalMeta from "../shared/RemovalMeta";
import ItemNameLabel from "../items/ItemNameLabel";
import { friendlyDate } from "../inbox/CaptureMeta";
import { removalReasonLabel, groupRemovalsByAction } from "../utils/removalLabels";

// The removal history route, moved out of Alfred.jsx unchanged. It was an inline
// `(() => { ... })()` under `view === "collection-history"`; that test stays in
// Alfred and the function body is this component's body.
export default function CollectionHistoryScreen({
  collections,
  selectedCollectionId,
  collectionHistory,
  collectionHistoryError,
  setView,
}) {
  const coll = collections.find((c) => c.id === selectedCollectionId);
  if (!coll) return <p className="text-muted-foreground">Collection not found</p>;
  const history = collectionHistory[coll.id] || [];
  const groups = groupRemovalsByAction(history);

  return (
    <div>
      <button
        onClick={() => setView("collection-detail")}
        className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Collection
      </button>

      <h2 className="text-lg font-medium mb-1">Removal history</h2>
      <p className="text-sm text-muted-foreground mb-3">
        {coll.name.trim()} — newest first
        {history.length >= 50 ? ", most recent 50" : ""}
      </p>

      {collectionHistoryError && (
        <p className="text-xs text-destructive mb-2">{collectionHistoryError}</p>
      )}

      {groups.length === 0 ? (
        !collectionHistoryError && (
          <p className="text-muted-foreground text-sm py-4 text-center">
            Nothing has been removed from this collection.
          </p>
        )
      ) : (
        <div className="space-y-3">
          {groups.map((group, groupIndex) =>
            // A single removal carries its own timestamp inline, the same
            // shape as the panel row. A heading over one item would be
            // ceremony for nothing. Bulk actions get the heading, so the
            // timestamp is stated once instead of on every row.
            group.rows.length === 1 ? (
              <div
                key={group.rows[0].id}
                className="flex items-start gap-2 p-3 bg-card border border-border rounded-lg"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">
                    <ItemNameLabel name={group.rows[0].itemName} />
                  </p>
                  <RemovalMeta
                    quantity={group.rows[0].quantity}
                    tags={group.rows[0].tags}
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    {friendlyDate(group.removedAt)}
                  </p>
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {removalReasonLabel(group.reason)}
                </span>
              </div>
            ) : (
              <div
                key={`${group.removedAt}-${group.reason}-${groupIndex}`}
                className="p-3 bg-card border border-border rounded-lg"
              >
                {/* Same header shape as a single entry — count in the slot
                    a lone item's name occupies, timestamp beneath, reason
                    label on the right — so the two read as two shapes of
                    one thing rather than two components. */}
                <div className="flex items-start gap-2 pb-2 mb-2 border-b border-border">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm">{group.rows.length} items</p>
                    <p className="text-xs text-muted-foreground">
                      {friendlyDate(group.removedAt)}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {removalReasonLabel(group.reason)}
                  </span>
                </div>
                <div className="space-y-1">
                  {group.rows.map((removal) => (
                    <div key={removal.id} className="min-w-0">
                      <p className="text-sm truncate">
                        <ItemNameLabel name={removal.itemName} />
                      </p>
                      {/* The group heading already states the time and
                          the reason once; what a row still needs to say
                          for itself is what it was. */}
                      <RemovalMeta
                        quantity={removal.quantity}
                        tags={removal.tags}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
