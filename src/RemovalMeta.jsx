import React from "react";

/**
 * What a removal carried when it was taken off the list: its quantity, and its
 * tags as read-only chips.
 *
 * One component for all three places a removal renders — the "recently removed"
 * panel, a single entry in the history view, and a row inside a grouped bulk
 * entry — so the three cannot drift.
 *
 * Both fields are snapshots written at removal time, not live lookups, which is
 * what makes them meaningful here: the point of showing them is to recognise
 * what you took off the list, and to see the tag survive a Put back.
 *
 * READ-ONLY, deliberately. No × and nothing tappable. A removal is a record of
 * something that happened; editing it would be editing history. Tags are edited
 * on the member row, which is where the item is.
 *
 * Chips use the app's standard read-only tag styling — the same fill and shape
 * as an item or intention card, and as a collection member row's chips minus
 * the × that only a removable one needs — so a tag reads as a tag wherever you
 * meet it.
 *
 * Renders nothing when there is neither a quantity nor a tag.
 */
export default function RemovalMeta({ quantity, tags }) {
  const shown = Array.isArray(tags) ? tags : [];
  if (!quantity && shown.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1">
      {quantity && (
        <span className="text-xs text-muted-foreground">{quantity}</span>
      )}
      {shown.map((tag) => (
        <span
          key={tag}
          className="px-2 py-0.5 bg-warning-light text-accent-foreground text-xs rounded-full"
        >
          {tag}
        </span>
      ))}
    </div>
  );
}
