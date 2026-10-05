import React from "react";
import { Archive, ArchiveRestore, ArrowLeft, GripVertical, Plus, Tag, X } from "lucide-react";
import TagFilter from "../shared/TagFilter";
import TagPicker from "../shared/TagPicker";
import RemovalMeta from "../shared/RemovalMeta";
import ItemNameLabel from "../items/ItemNameLabel";
import { friendlyDate } from "../inbox/CaptureMeta";
import { TAG_TOGGLE_ATTR } from "../utils/tagFilterViews";

// The collection detail route, moved out of Alfred.jsx unchanged. It was an
// inline `(() => { ... })()` under `view === "collection-detail"`; that test
// stays in Alfred and the function body is this component's body.
export default function CollectionDetailScreen({
  collections,
  setCollections,
  selectedCollectionId,
  setSelectedCollectionId,
  items,
  contexts,
  previousView,
  setView,
  membersOf,
  setMembersFor,
  collectionMembersError,
  collectionFilterTag,
  setCollectionFilterTag,
  collectionTagPool,
  collectionRemovals,
  collectionRemovalsError,
  collectionHistory,
  collectionHistoryError,
  reAddingRemovalId,
  editingTagsItemId,
  editingTagsRowRef,
  collDragIdx,
  setCollDragIdx,
  setEditingQuantityItemId,
  tagsCollapsedFor,
  toggleTagsFor,
  updateCollection,
  archiveCollection,
  saveMemberOrder,
  saveMemberTags,
  saveMemberQuantity,
  toggleTagEditor,
  removeItemFromCollection,
  putBackRemoval,
}) {
  const coll = collections.find((c) => c.id === selectedCollectionId);
  if (!coll) return <p className="text-muted-foreground">Collection not found</p>;
  const members = membersOf(coll.id);
  // An item that has been put back is a resolved problem, so it drops out
  // of a panel meant for unresolved ones. The removal record itself stays
  // in the table — the history stays honest.
  const memberItemIds = new Set(members.map((m) => m.itemId));
  // Filtered for display only. Drag-to-reorder still works against the
  // full `members` list — reordering a filtered subset would write
  // positions that mean nothing once the filter is cleared, so the
  // handles are hidden while a filter is on.
  const visibleMembers = collectionFilterTag
    ? members.filter((m) => (m.tags || []).includes(collectionFilterTag))
    : members;
  const tagPoolForCollection = collectionTagPool[coll.id] || [];
  // No .slice() any more — the fetch is already bounded to today, and
  // capping a time window by count as well is what hid the older half
  // of a heavy shopping day.
  //
  // The still-a-member filter STAYS. It is how "Put back" clears a row
  // without needing its own optimistic update: re-adding the member is
  // enough to drop its removal out of the panel.
  const recentRemovals = (collectionRemovals[coll.id] || []).filter(
    (r) => !memberItemIds.has(r.itemId),
  );
  const history = collectionHistory[coll.id] || [];
  return (
    <div>
      <button
        onClick={() => {
          setSelectedCollectionId(null);
          setView(previousView || "collections");
        }}
        className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">Name</label>
          <input
            type="text"
            value={coll.name}
            onChange={(e) => {
              const updated = { ...coll, name: e.target.value };
              setCollections(collections.map((c) => (c.id === coll.id ? updated : c)));
            }}
            onBlur={() => updateCollection(coll.id, { name: coll.name }, true)}
            className="w-full px-3 py-2 border border-border rounded text-base"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1">Context</label>
          <select
            value={coll.contextId || ""}
            onChange={(e) => updateCollection(coll.id, { contextId: e.target.value || null })}
            className="w-full px-3 py-2 border border-border rounded text-base"
          >
            <option value="">No context</option>
            {/* Filtered inline rather than by swapping the prop: this
                component also looks context names up by id for badges,
                and an archived context must still resolve there. */}
            {contexts.filter((c) => !c.archived).map((ctx) => (
              <option key={ctx.id} value={ctx.id}>{ctx.name}</option>
            ))}
          </select>
        </div>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={coll.shared || false}
            onChange={(e) => updateCollection(coll.id, { shared: e.target.checked })}
            className="rounded accent-primary"
          />
          <span className="text-sm">Shared collection</span>
        </label>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={coll.pinned || false}
            onChange={(e) => updateCollection(coll.id, { pinned: e.target.checked })}
            className="rounded accent-primary"
          />
          <span className="text-sm">Pin to home</span>
        </label>

        {/* The column has existed since the collections migration and
            enrichment has been reading it to decide where a capture
            should go, but there was no UI — the only way to set it was
            raw SQL, which is how Groceries got its flag. (That reader is
            the alfred-enrich skill in claude.ai now, not the ai-enrich
            function — Clipboard Step 14.) */}
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={coll.isCaptureTarget || false}
            onChange={(e) =>
              updateCollection(coll.id, { isCaptureTarget: e.target.checked })
            }
            className="mt-1 rounded accent-primary"
          />
          <span className="text-sm">
            Capture target
            <span className="block text-xs text-muted-foreground">
              Alfred files new captures here by default, and it is
              preselected when adding an item's ingredients to a
              collection.
            </span>
          </span>
        </label>

        <div>
          {/* Membership — reads and writes both go to collection_items. */}
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-base font-medium">
              Items ({members.length})
            </h3>
            <button
              onClick={() => setView("collection-add-items")}
              className="flex items-center gap-2 px-3 py-2 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm"
            >
              <Plus className="w-4 h-4" />
              Add Items
            </button>
          </div>

          {collectionMembersError && (
            <p className="text-xs text-destructive mb-2">{collectionMembersError}</p>
          )}

          {members.length >= 50 && members.length < 200 && (
            <p className="text-xs text-warning mb-2">Warning: {members.length} items. Performance may degrade above 200.</p>
          )}
          {members.length >= 200 && (
            <p className="text-xs text-destructive mb-2">Maximum 200 items reached.</p>
          )}

          {/* Store filter. Same component the item and intention lists
              use, handed the members so it counts this collection's
              tags — but wired to `collectionFilterTag`, which is NOT
              the `filterTag` those lists share. See the state
              declaration for why they must stay apart. */}
          {/* This view has no search box, so nothing ever collapses
              this bar for you — the toggle is the only way, and it is
              here so the control exists on every bar rather than on
              three of the four. Its own collapse key for the same
              reason `collectionFilterTag` is its own filter. */}
          <TagFilter
            entities={members}
            activeTag={collectionFilterTag}
            onFilter={setCollectionFilterTag}
            collapsed={tagsCollapsedFor("collection-detail")}
            onToggleCollapsed={toggleTagsFor("collection-detail")}
          />

          {members.length === 0 ? (
            <p className="text-muted-foreground text-sm py-4 text-center">No items in this collection</p>
          ) : visibleMembers.length === 0 ? (
            <p className="text-muted-foreground text-sm py-4 text-center">
              No items tagged &quot;{collectionFilterTag}&quot;
            </p>
          ) : (
            <div className="space-y-2">
              {visibleMembers.map((member, index) => {
                const linkedItem = items.find((i) => i.id === member.itemId);
                const memberTags = member.tags || [];
                const tagsOpen = editingTagsItemId === member.itemId;
                return (
                  <div
                    key={member.id || member.itemId || index}
                    ref={tagsOpen ? editingTagsRowRef : undefined}
                    className={`p-3 bg-card border border-border rounded-lg ${collDragIdx === index ? "opacity-50" : ""}`}
                    draggable={!collectionFilterTag && !tagsOpen}
                    onDragStart={(e) => { setCollDragIdx(index); e.dataTransfer.effectAllowed = "move"; }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (collDragIdx === null || collDragIdx === index) return;
                      setMembersFor(coll.id, (prev) => {
                        const next = [...prev];
                        const [dragged] = next.splice(collDragIdx, 1);
                        next.splice(index, 0, dragged);
                        return next;
                      });
                      setCollDragIdx(index);
                    }}
                    onDragEnd={() => {
                      setCollDragIdx(null);
                      saveMemberOrder(coll.id, members);
                    }}
                  >
                  <div className="flex items-center gap-2">
                    {/* Hidden while filtering: the visible rows are a
                        subset, so a drop position would be a lie. */}
                    {!collectionFilterTag && (
                      <GripVertical className="w-4 h-4 text-muted-foreground cursor-move flex-shrink-0" title="Drag to reorder" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">
                        <ItemNameLabel name={linkedItem?.name} />
                      </p>
                      {/* Tag chips, under the name rather than beside
                          it. At 360px the row has no spare width — name,
                          quantity and the two buttons already fill it —
                          and the tag has to be readable at a glance in
                          an aisle, which a count badge or an icon is not.
                          A second line only appears when a row actually
                          has tags, so an untagged list is exactly as
                          compact as it was before this phase.

                          Each chip removes itself. Removing a tag used
                          to mean opening the editor to reach a second
                          copy of the same chips; now it is one tap on
                          the chip you are already looking at, and the
                          editor is only for ADDING.

                          The × is a 32px target inside a ~30px chip, not
                          the usual 44px. 44 would make a chip taller than
                          the item name it sits under and would crowd the
                          row it is meant to annotate. 32 is a
                          comfortable deliberate tap, and mis-taps while
                          scrolling are not the risk they look like —
                          a browser cancels the click once the finger
                          moves, so a scroll never fires one. gap-1.5
                          keeps two ×s from sitting shoulder to shoulder,
                          which is the mis-tap that could happen. */}
                      {memberTags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-1">
                          {memberTags.map((tag) => (
                            <span
                              key={tag}
                              className="inline-flex items-center gap-0.5 pl-2.5 pr-0.5 bg-warning-light text-accent-foreground text-xs rounded-full"
                            >
                              {tag}
                              <button
                                onClick={() =>
                                  saveMemberTags(
                                    coll.id,
                                    member.itemId,
                                    memberTags.filter((t) => t !== tag),
                                  )
                                }
                                aria-label={`Remove tag ${tag}`}
                                title={`Remove tag ${tag}`}
                                className="min-h-[32px] min-w-[32px] flex items-center justify-center rounded-full hover:text-destructive"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    {/* Quantity is disabled when the item cannot be shown:
                        setting an amount on something you cannot identify
                        is a guess, and it would be a silent edit to data
                        the owner can see and you cannot. Removing the row
                        stays available — a member you cannot see is exactly
                        the one you may need to get rid of. */}
                    <input
                      type="text"
                      value={member.quantity || ""}
                      disabled={!linkedItem}
                      title={linkedItem ? undefined : "This item cannot be shown, so its quantity cannot be edited"}
                      onChange={(e) => {
                        const quantity = e.target.value;
                        setMembersFor(coll.id, (prev) =>
                          prev.map((m) => (m.itemId === member.itemId ? { ...m, quantity } : m)),
                        );
                      }}
                      // The typed value lives in collectionMembers until
                      // blur, which is exactly what the poll overwrites.
                      // Focus pauses the poll; the pause is not lifted
                      // until the save has settled, so a tick cannot land
                      // between blur and the write completing.
                      onFocus={() => setEditingQuantityItemId(member.itemId)}
                      onBlur={async () => {
                        await saveMemberQuantity(coll.id, member.itemId, member.quantity);
                        setEditingQuantityItemId(null);
                      }}
                      placeholder="Qty"
                      className="w-20 sm:w-24 px-2 py-2 border border-border rounded text-base disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                    {/* Opens the picker below this row, one at a time.
                        Disabled for an unreadable item for the same
                        reason quantity is: tagging something you cannot
                        identify is a guess. */}
                    <button
                      {...{ [TAG_TOGGLE_ATTR]: "" }}
                      // Switches on the PRESS, not the click, and this
                      // is load-bearing rather than stylistic.
                      //
                      // An open editor makes its row taller, so every
                      // row below it sits lower. Closing one on
                      // mousedown moved those rows back UP between the
                      // press and the release, so the button that was
                      // under the finger on press was somewhere else on
                      // release and the click never completed on it.
                      // Tapping a row BELOW the open one did nothing;
                      // tapping one ABOVE worked, because rows above
                      // never move. Doing the whole switch on the press
                      // means no click has to land anywhere.
                      //
                      // preventDefault keeps focus off the button, so
                      // the phone keyboard does not flicker on the way
                      // from one editor to the next.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        toggleTagEditor(member.itemId);
                      }}
                      // Keyboard only. A click from Enter or Space
                      // carries detail 0; a pointer click carries 1 or
                      // more and was already handled above. The guard
                      // also absorbs a stray click that reflow lands on
                      // the wrong button.
                      onClick={(e) => {
                        if (e.detail === 0) toggleTagEditor(member.itemId);
                      }}
                      disabled={!linkedItem}
                      aria-label={tagsOpen ? "Done tagging" : "Tag this item"}
                      title={
                        linkedItem
                          ? tagsOpen
                            ? "Done tagging"
                            : "Tag this item"
                          : "This item cannot be shown, so it cannot be tagged"
                      }
                      className={`p-1 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg disabled:opacity-50 disabled:cursor-not-allowed ${
                        tagsOpen
                          ? "bg-primary text-white"
                          : "text-muted-foreground hover:text-primary"
                      }`}
                    >
                      <Tag className="w-4 h-4" />
                    </button>
                    <button
                      // No overlay — Step 12.4. This is THE shopping
                      // action: one-handed, in an aisle, once per item.
                      // A full-screen scrim per tick was the complaint.
                      // The row disappearing is the confirmation, and
                      // removeItemFromCollection reports its own failures
                      // through reportMembershipError.
                      onClick={() =>
                        removeItemFromCollection(coll.id, member.itemId)
                      }
                      className="p-1 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-destructive"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  {/* The editor, expanded under its own row. One at a
                      time — two of them open at once would push the list
                      off a phone screen.

                      Input and dropdown ONLY. It used to carry its own
                      copy of the chips and a Done button; the chips are
                      now removable in the row directly above, which
                      makes both redundant. What is left is the one thing
                      the editor is for: adding. The row's chips stay
                      visible while it is open, so a tag landing is still
                      confirmed on screen.

                      No Done button either — tapping anywhere outside
                      the row closes it. See the dismissal effect.

                      Its pool is the COLLECTION pool: this collection's
                      members plus its removal history. It never mixes
                      with the item/intent pool — "tjs" has no business
                      on a recipe and "vegetarian" none on a shopping
                      row. */}
                  {tagsOpen && (
                    <div className="mt-3 pt-3 border-t border-border">
                      <TagPicker
                        value={memberTags}
                        pool={tagPoolForCollection}
                        onChange={(next) =>
                          saveMemberTags(coll.id, member.itemId, next)
                        }
                        // Not "a store": a collection's tags are
                        // whatever splits the list usefully, and that is
                        // not always a shop.
                        placeholder="Search or add"
                        label="Search or add a tag"
                        // Opened by tapping the Tag button, so it is
                        // ready to type into. Raises the keyboard
                        // immediately, which is the intent. The four
                        // item/intention pickers do NOT pass this —
                        // they sit in a form you may be scrolling past.
                        autoFocus
                        // The row above already shows these, removably.
                        showChips={false}
                      />
                    </div>
                  )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Recently removed — manual removals only, most recent first,
            plus the entry point to the full history. The whole region
            disappears when there is neither history nor an error to
            report; an empty panel on a fresh collection is noise. */}
        {(recentRemovals.length > 0 ||
          collectionRemovalsError ||
          history.length > 0 ||
          collectionHistoryError) && (
          <div className="pt-4 border-t border-border">
            {(recentRemovals.length > 0 || collectionRemovalsError) && (
              <>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-base font-medium">Recently removed</h3>
                  {/* Also shown when the panel has rows but `history` is
                      stale: the poll refreshes removals, not history, so
                      a removal polled in from the other person would
                      otherwise have no way through to the full view.
                      The history view reloads on entry regardless. */}
                  {(history.length > 0 || recentRemovals.length > 0) && (
                    <button
                      onClick={() => setView("collection-history")}
                      className="min-h-[44px] text-sm text-primary hover:text-primary-hover"
                    >
                      View all
                    </button>
                  )}
                </div>

                {collectionRemovalsError && (
                  <p className="text-xs text-destructive mb-2">{collectionRemovalsError}</p>
                )}

                <div className="space-y-2">
                  {recentRemovals.map((removal) => (
                    <div
                      key={removal.id}
                      className="flex items-center gap-2 p-3 bg-card border border-border rounded-lg"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">
                          <ItemNameLabel name={removal.itemName} />
                        </p>
                        <RemovalMeta
                          quantity={removal.quantity}
                          tags={removal.tags}
                        />
                        <p className="text-xs text-muted-foreground mt-1">
                          {friendlyDate(removal.removedAt)}
                        </p>
                      </div>
                      <button
                        // No overlay — Step 12.4, same aisle, same hand.
                        // The button disables via reAddingRemovalId while
                        // the write runs, which is feedback enough for a
                        // single row, and putBackRemoval reports its own
                        // failures.
                        onClick={() => putBackRemoval(removal)}
                        disabled={reAddingRemovalId !== null}
                        className="flex items-center gap-2 px-3 py-2 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm shrink-0 disabled:opacity-50"
                      >
                        <ArchiveRestore className="w-4 h-4" />
                        Put back
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* A collection can have history worth reading while the panel
                itself is empty — every removal was a completion, or every
                manual one has been put back. Keep the history reachable. */}
            {recentRemovals.length === 0 && !collectionRemovalsError && history.length > 0 && (
              <button
                onClick={() => setView("collection-history")}
                className="flex items-center gap-2 min-h-[44px] text-sm text-primary hover:text-primary-hover"
              >
                <Archive className="w-4 h-4" />
                View removal history
              </button>
            )}

            {collectionHistoryError && (
              <p className="text-xs text-destructive mt-2">{collectionHistoryError}</p>
            )}
          </div>
        )}

        <div className="pt-4 border-t border-border">
          {/* Relabelled with the behaviour: this archives now, and the
              row is recoverable from the Recycle Bin. The confirm is
              gone — safety is the 5-second Undo, per governing rule 3.
              Navigating away is unconditional because this page is
              showing the record being archived. */}
          <button
            onClick={() => {
              archiveCollection(coll.id);
              setSelectedCollectionId(null);
              setView("collections");
            }}
            className="px-4 py-2.5 min-h-[44px] bg-destructive hover:bg-destructive-hover text-white rounded-lg text-sm"
          >
            Archive Collection
          </button>
        </div>
      </div>
    </div>
  );
}
