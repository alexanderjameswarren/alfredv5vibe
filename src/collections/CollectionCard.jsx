import React from "react";
import { Archive, Pin, Share2 } from "lucide-react";
import ObjectIcon from "../shared/ObjectIcon";

/**
 * One collection row. Step 4a of docs/technical-spec-ui-standardization.md.
 *
 * Replaces three copy-pasted copies that had drifted on four axes with no two
 * identical. Two of the four differences were adaptation and survive as props;
 * two were drift and are gone:
 *
 *   Pin icon        DRIFT       Home rendered it unconditionally. Invisible,
 *                               because every row in "Pinned Collections" is
 *                               pinned by definition — but only by accident.
 *                               Now conditional, and hardcoded rather than a
 *                               prop: no caller wants it suppressed, and a
 *                               never-varied prop is noise.
 *   Member count    DRIFT       Home and Collections called Alfred's
 *                               `membersOf`; Context detail inlined the same
 *                               lookup because `membersOf` is out of its scope.
 *                               The component takes the number, so neither
 *                               caller needs the lookup shape.
 *   Context badge   ADAPTATION  Context detail omits it: every row already
 *                               shares that context, so the chip says nothing.
 *                               Kept as `showContextBadge`.
 *   Click handler   ADAPTATION  Each site returns to a different screen.
 *                               Kept as `onOpen`.
 *
 * Anatomy matches the other five shared cards after Step 3: the whole card is
 * the click target, not just the title block. There are no action buttons yet —
 * Step 8 adds Edit and Archive — and when they arrive they go inside this root
 * as descendants with `stopPropagation`, the way ContextCard's gear and
 * EventCard's Start button already do.
 *
 * Not an anchor, deliberately: `/collections/detail` carries no record id, so a
 * middle-click would open the wrong screen in a new tab. See the spec's "Row
 * click targets — deferred".
 */
export default function CollectionCard({
  collection,
  contexts = [],
  memberCount = 0,
  showContextBadge = true,
  onOpen,
  onArchive,
}) {
  // Cards in this file take `contexts` and resolve the name themselves —
  // ItemCard, IntentionCard and EventCard all do. Following that keeps the
  // lookup out of two call sites rather than duplicating it in both.
  const contextName =
    showContextBadge && collection.contextId
      ? contexts.find((c) => c.id === collection.contextId)?.name
      : null;

  return (
    <div
      onClick={onOpen}
      className="p-3 sm:p-4 bg-card border border-border rounded-lg cursor-pointer hover:border-primary shadow-sm hover:shadow-md transition-shadow"
    >
      {/* gap-3 as a floor. justify-between leaves a generous gap on a wide row
          but collapses to nothing once the collection name fills the width, and
          what sits on the other side of that gap is the card's own onClick. */}
      <div className="flex items-center justify-between gap-3">
        <div>
          {/* See ContextCard — same ordering, same reason. */}
          <div className="flex items-center gap-2">
            <ObjectIcon type="collection" className="w-4 h-4 text-primary" />
            <p className="font-medium">{collection.name}</p>
            {collection.pinned && (
              <Pin className="w-3.5 h-3.5 text-muted-foreground" />
            )}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-sm text-muted-foreground">
              {memberCount} {memberCount === 1 ? "item" : "items"}
            </span>
            {contextName && (
              <span className="text-xs bg-warning-light text-foreground px-2 py-0.5 rounded">
                {contextName}
              </span>
            )}
            {collection.shared && (
              <span className="text-xs text-primary flex items-center gap-1">
                <Share2 className="w-3 h-3" />
                Shared
              </span>
            )}
          </div>
        </div>
        {/* Archive only — no Edit. Clicking the row opens collection detail,
            which auto-saves each field on blur and has no Save button, so it
            genuinely IS this record's edit surface. A row action never
            duplicates the row click.

            stopPropagation because this sits inside the card's own onClick.
            No confirmation: `onArchive` routes to archiveCollection, which
            offers the Undo. */}
        {onArchive && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onArchive(collection.id);
            }}
            title="Archive this collection"
            className="flex items-center justify-center p-2 min-h-[44px] min-w-[44px] rounded-lg text-muted-foreground hover:text-destructive hover:bg-secondary transition-colors shrink-0"
          >
            <Archive className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
