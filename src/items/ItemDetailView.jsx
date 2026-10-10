import React, { useState } from "react";
import { Archive, ArrowLeft, CalendarPlus, Copy, Play, Plus, Settings } from "lucide-react";
import ObjectIcon from "../shared/ObjectIcon";
import OverflowMenu from "../shared/OverflowMenu";
import { ACTION_BUTTON } from "../shared/actionButton";
import DetailMeta from "../shared/DetailMeta";
import RecordLinks from "../shared/RecordLinks";
import StatusMenu from "../shared/StatusMenu";
import StatusFilterChips from "../shared/StatusFilterChips";
import SchedulePopover from "../shared/recurrence/SchedulePopover";
import { getTodayDate } from "../utils/eventDates";
import { itemActionTarget } from "../utils/runNow";
import {
  closedBlockTitle,
  filterByStatus,
  rankByActivity,
  recordActions,
  readStoredStatusFilter,
  statusCounts,
  toggleStatusFilter,
  writeStoredStatusFilter,
} from "../utils/status";
import PendingReminder from "../inbox/PendingReminder";
import OriginalCapture from "../inbox/OriginalCapture";
import ItemCard from "./ItemCard";
import IntentionCard from "../intentions/IntentionCard";
import ExecutionBadge from "../executions/ExecutionBadge";
import NoteTimeline from "../notes/NoteTimeline";
import RecentCompletions from "../notes/RecentCompletions";
import OpenExecutionNotes from "../notes/OpenExecutionNotes";
import { useRecordNotes } from "../notes/useRecordNotes";

const CollectionIcon = (props) => <ObjectIcon type="collection" {...props} />;

export default function ItemDetailView({
  tagPool = [],
  // As IntentionDetailView: the capture this item was filed from, or null.
  capturedText,
  // Step 12.6. Takes the item id so the add page can seed the intention against
  // it, exactly as the inline form did.
  onOpenAddIntention,
  item,
  intents,
  events,
  contexts,
  items,
  onBack,
  onAddToCollection,
  onUpdateItem,
  onEditItem,
  onUpdateIntent,
  onSchedule,
  getIntentDisplay,
  executions = [],
  onOpenExecution,
  onStartNow,
  onScheduleItem,
  onUpdateEvent,
  onActivate,
  onAddIntention,
  onCancelExecution,
  onStartNowIntention,
  onArchiveIntention,
  onViewItem,
  onViewIntentionDetail,
  onViewContextDetail,
  onClone,
  onSetStatus,
  collections = [],
  onDirtyChange,
  startInEditMode = false,
}) {
  // Seeded rather than set by an effect. This view is mounted conditionally on
  // `view === "item-detail"`, so it unmounts on the way out and remounts on the
  // way in — the initialiser runs exactly once per visit, which is precisely the
  // moment the flag means anything. An effect would also have to decide what to
  // do on every later render, and the answer would be "nothing".
  const [isEditing, setIsEditing] = useState(Boolean(startInEditMode));
  const [showCloneDialog, setShowCloneDialog] = useState(false);
  const [cloneName, setCloneName] = useState("");
  const [relatedStatus, setRelatedStatus] = useState(() => readStoredStatusFilter("item-related"));
  // One timeline: the item's own notes plus every one of its intentions', archived ones included.
  const notesIntentions = (intents || []).filter((i) => item && i.itemId === item.id);
  const notesState = useRecordNotes({
    target: { type: "item", id: item?.id },
    itemIds: item ? [item.id] : [],
    intentionIds: notesIntentions.map((i) => i.id),
  });

  if (!item) return null;

  // Note sources as links; the item itself is this page, so it is left out.
  const noteSources = {
    here: { type: "item", id: item.id },
    intentionName: (id) => {
      const intent = notesIntentions.find((i) => i.id === id);
      return intent ? getIntentDisplay(intent) : null;
    },
    onViewIntention: onViewIntentionDetail,
    onOpenExecution,
  };

  function toggleRelatedStatus(status) {
    const next = toggleStatusFilter(relatedStatus, status);
    setRelatedStatus(next);
    writeStoredStatusFilter("item-related", next);
  }

  function copyElementToClipboard(el) {
    const linkedItem = (el.itemId || el.item_id) ? items.find((i) => i.id === (el.itemId || el.item_id)) : null;
    let text = el.name;
    if (el.description) text += " " + el.description;
    if (el.quantity) text += " qty:" + el.quantity;
    if (linkedItem) text += " related item:" + linkedItem.name;
    navigator.clipboard.writeText(text);
  }

  // Find all non-archived intentions linked to this item
  const itemIntentions = intents.filter(
    (i) => i.itemId === item.id && !i.archived,
  );
  const visibleIntentions = rankByActivity(filterByStatus(itemIntentions, relatedStatus), events, executions);
  const closedTitle = closedBlockTitle(item, "item");
  // Item Start Now and Schedule act on the intention Run Now would pick.
  // One picker for every item button: an intention mid-run first (itemActionTarget).
  const target = itemActionTarget(item.id, intents, events, executions);
  const actions = recordActions(target?.intent, events, executions);

  // Get context name for badge
  const contextName =
    item.contextId && contexts
      ? contexts.find((c) => c.id === item.contextId)?.name
      : null;

  // If editing, show the ItemCard in edit mode
  if (isEditing) {
    return (
      <div>
        <button
          onClick={onBack}
          className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>

        <ItemCard
          tagPool={tagPool}
          item={item}
          contexts={contexts}
          onUpdate={async (id, { status, ...updates }) => {
            await onUpdateItem(id, updates);
            // Status goes through its own patch, after the fields (see storage.set).
            if (status && onSetStatus) await onSetStatus(id, status);
            if (updates.archived) {
              onBack();
            } else {
              setIsEditing(false);
            }
          }}
          isEditing={true}
          editableStatus={Boolean(onSetStatus)}
          onCancel={() => setIsEditing(false)}
          allItems={items}
          onDirtyChange={onDirtyChange}
          // This card IS the page here — nothing else renders alongside it, so
          // the objection to sticky footers inside lists does not apply. A long
          // recipe puts Save thousands of pixels below the fold; this is the
          // case the phase started from.
          stickyFooter
        />
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      {/* Header, as of Phase 1b: title on its own full-width row, then the
          record's metadata, then the actions on a row of their own.

          The title and the buttons used to share a flex row, the buttons
          holding a fixed width on the right. A long item name was squeezed into
          whatever column was left and broke across four or five lines while
          empty space sat beside it. Nothing here competes for horizontal room
          any more. Structurally identical to IntentionDetailView's header. */}
      <div className="mb-4 sm:mb-6">
        <div className="flex items-start justify-between gap-2">
          <h2 className="flex items-start gap-2 text-xl sm:text-2xl font-bold min-w-0">
            <ObjectIcon type="item" className="w-6 h-6 text-primary" align="first-line" />
            <span className="min-w-0">{item.name}</span>
          </h2>
          {onSetStatus && <StatusMenu row={item} onChoose={(status) => onSetStatus(item.id, status)} />}
        </div>

        {/* The execution page's link row: the context pill. */}
        <div className="mt-2">
          <RecordLinks
            context={contextName ? {
              name: contextName,
              onOpen: onViewContextDetail && (() => onViewContextDetail(item.contextId)),
            } : null}
          />
        </div>
        <DetailMeta tags={item.tags} />

        {/* Reminders stay on the capture the item was filed from. */}
        {item.sourceInboxId && <PendingReminder inboxId={item.sourceInboxId} />}

        {/* Phones show no tooltips, so the disabled buttons' reason is spelled out. */}
        {(closedTitle || actions.moveBlocked) && (
          <p className="mt-2 text-sm text-muted-foreground">{closedTitle || actions.moveBlocked}</p>
        )}

        {/* Record actions: Start Now / Continue (the one primary), Schedule /
            Reschedule, Edit, ⋯ — the same rule as intention detail, applied to
            the intention Run Now would pick. Labels at every width. The rarer
            actions live in the menu, each with icon and label: Create
            Intention, Clone, Add to Collection, Archive. */}
        <div className="flex flex-wrap gap-2 mt-3">
          {onStartNow && (
            <button
              onClick={() => (actions.open ? onOpenExecution?.(actions.open) : onStartNow(item.id, target?.intent.id))}
              disabled={Boolean(closedTitle)}
              title={closedTitle || undefined}
              className={`${ACTION_BUTTON} bg-success hover:bg-success-hover text-white`}
            >
              <Play className="w-4 h-4" />
              {actions.primaryLabel}
            </button>
          )}
          {onScheduleItem && (
            <span title={closedTitle || actions.moveBlocked || undefined}>
              <SchedulePopover
                label={actions.scheduleLabel}
                icon={<CalendarPlus className="w-4 h-4" />}
                initialDate={actions.liveDate || getTodayDate()}
                onPick={(date) => onScheduleItem(item, date, target?.intent.id)}
                disabled={Boolean(closedTitle || actions.moveBlocked)}
                className={`${ACTION_BUTTON} bg-secondary hover:bg-secondary text-foreground`}
              />
            </span>
          )}
          <button
            onClick={() => setIsEditing(true)}
            className={`${ACTION_BUTTON} bg-secondary hover:bg-secondary text-foreground`}
          >
            <Settings className="w-4 h-4" />
            Edit
          </button>
          <OverflowMenu
            actions={[
              onOpenAddIntention && {
                label: "Create Intention",
                icon: Plus,
                onClick: () => onOpenAddIntention(item.id),
                disabled: Boolean(closedTitle),
                title: closedTitle,
              },
              onClone && {
                label: "Clone",
                icon: Copy,
                onClick: () => {
                  setCloneName(item.name + " (Copy)");
                  setShowCloneDialog(true);
                },
              },
              onAddToCollection && { label: "Add to Collection", icon: CollectionIcon, onClick: onAddToCollection },
              // `onUpdateItem` offers the Undo; leaves the page it was showing.
              {
                label: "Archive",
                icon: Archive,
                destructive: true,
                onClick: () => {
                  onUpdateItem(item.id, { archived: true });
                  onBack();
                },
              },
            ].filter(Boolean)}
          />
        </div>
      </div>

      {/* Clone Dialog */}
      {showCloneDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h3 className="text-lg font-medium mb-4">Clone Item</h3>
            <label className="block text-sm font-medium text-foreground mb-1">Name for clone</label>
            <input
              type="text"
              value={cloneName}
              onChange={(e) => setCloneName(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-primary"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && cloneName.trim()) {
                  setShowCloneDialog(false);
                  onClone(item.id, cloneName.trim());
                }
              }}
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowCloneDialog(false)}
                className="px-4 py-2 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (cloneName.trim()) {
                    setShowCloneDialog(false);
                    onClone(item.id, cloneName.trim());
                  }
                }}
                className="px-4 py-2 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg"
              >
                Clone
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Item Description */}
      {item.description && (
        <div className="mb-6">
          <p className="text-muted-foreground">{item.description}</p>
        </div>
      )}

      {/* Capture Target Badge */}
      {item.isCaptureTarget && (
        <div className="mb-4">
          <span className="inline-block text-xs bg-success-light text-foreground px-2 py-1 rounded">
            📍 Capture Target
          </span>
        </div>
      )}

      {/* Elements Section */}
      {(item.elements || item.components) &&
        (item.elements || item.components).length > 0 && (
          <div className="mb-6">
            <h3 className="text-lg font-medium mb-3">Elements</h3>
            <div className="space-y-2">
              {(() => {
                let stepCounter = 0;
                return (item.elements || item.components).map((element, index) => {
                  const el =
                    typeof element === "string"
                      ? { name: element, displayType: "step" }
                      : {
                          ...element,
                          displayType: element.displayType || element.display_type || "step",
                          itemId: element.itemId || element.item_id,
                        };

                  const linkedItem = el.itemId ? items.find((i) => i.id === el.itemId) : null;

                  if (el.displayType === "header") {
                    return (
                      <div key={index}>
                        <div className="mt-4 mb-2">
                          <div className="flex items-center gap-2">
                            <h4 className="text-md font-bold text-foreground">
                              {el.name}
                            </h4>
                            <button
                              onClick={() => copyElementToClipboard(el)}
                              className="text-muted-foreground hover:text-foreground flex-shrink-0"
                              title="Copy element"
                            >
                              <Copy className="w-3 h-3" />
                            </button>
                          </div>
                          {el.description && (
                            <p className="text-sm text-muted-foreground mt-1">
                              {el.description}
                            </p>
                          )}
                        </div>
                        {linkedItem && (
                          <button
                            onClick={() => onViewItem(linkedItem.id, "item-detail")}
                            className="ml-0 flex items-center gap-2 text-sm text-primary hover:text-primary-hover mb-2"
                          >
                            <ObjectIcon type="item" className="w-4 h-4 shrink-0" />
                            <span>{linkedItem.name}</span>
                          </button>
                        )}
                      </div>
                    );
                  }

                  if (el.displayType === "bullet") {
                    return (
                      <div key={index}>
                        <div className="ml-4 flex items-start gap-2">
                          <span className="text-muted-foreground mt-1">•</span>
                          <div className="flex-1">
                            <span className="text-foreground">
                              {el.quantity && (
                                <span className="font-medium">{el.quantity} </span>
                              )}
                              {el.name}
                            </span>
                            {el.description && (
                              <p className="text-sm text-muted-foreground mt-1">
                                {el.description}
                              </p>
                            )}
                          </div>
                          <button
                            onClick={() => copyElementToClipboard(el)}
                            className="text-muted-foreground hover:text-foreground flex-shrink-0 mt-1"
                            title="Copy element"
                          >
                            <Copy className="w-3 h-3" />
                          </button>
                        </div>
                        {linkedItem && (
                          <button
                            onClick={() => onViewItem(linkedItem.id, "item-detail")}
                            className="ml-6 flex items-center gap-2 text-sm text-primary hover:text-primary-hover mt-1"
                          >
                            <ObjectIcon type="item" className="w-4 h-4 shrink-0" />
                            <span>{linkedItem.name}</span>
                          </button>
                        )}
                      </div>
                    );
                  }

                  // Default: step
                  stepCounter++;
                  const stepNum = stepCounter;
                  return (
                    <div key={index}>
                      <div className="flex items-start gap-3">
                        <span className="text-muted-foreground font-medium min-w-[24px]">
                          {stepNum}.
                        </span>
                        <div className="flex-1">
                          <span className="text-foreground">
                            {el.quantity && (
                              <span className="font-medium">{el.quantity} </span>
                            )}
                            {el.name}
                          </span>
                          {el.description && (
                            <p className="text-sm text-muted-foreground mt-1">
                              {el.description}
                            </p>
                          )}
                        </div>
                        <button
                          onClick={() => copyElementToClipboard(el)}
                          className="text-muted-foreground hover:text-foreground flex-shrink-0 mt-1"
                          title="Copy element"
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                      </div>
                      {linkedItem && (
                        <button
                          onClick={() => onViewItem(linkedItem.id, "item-detail")}
                          className="ml-9 flex items-center gap-2 text-sm text-primary hover:text-primary-hover mt-1"
                        >
                          <ObjectIcon type="item" className="w-4 h-4 shrink-0" />
                          <span>{linkedItem.name}</span>
                        </button>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}

      {/* Used In Section - items that reference this item */}
      {(() => {
        const parents = items.filter(
          (i) => i.id !== item.id && !i.archived && (i.elements || []).some((el) => (el.itemId || el.item_id) === item.id)
        );
        if (parents.length === 0) return null;
        return (
          <div className="mb-6">
            <h3 className="text-lg font-medium mb-3">Used In ({parents.length})</h3>
            <div className="space-y-1">
              {parents.map((parent) => (
                <button
                  key={parent.id}
                  onClick={() => onViewItem(parent.id, "item-detail")}
                  className="flex items-center gap-2 w-full text-left px-3 py-2 rounded hover:bg-secondary/50 text-primary hover:text-primary-hover"
                >
                  <span>←</span>
                  <span>{parent.name}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Active/Paused Executions Section */}
      {executions.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-medium mb-3">
            Executions ({executions.length})
          </h3>
          <div className="space-y-2">
            {executions.map((exec) => (
              <ExecutionBadge
                key={exec.id}
                exec={exec}
                intents={intents}
                contexts={contexts}
                getIntentDisplay={getIntentDisplay}
                onOpen={onOpenExecution}
              >
                <OpenExecutionNotes executionId={exec.id} />
              </ExecutionBadge>
            ))}
          </div>
        </div>
      )}

      {/* Related Intentions Section */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-medium">
            Related Intentions ({itemIntentions.length})
          </h3>
        </div>

        {itemIntentions.length > 0 && (
          <StatusFilterChips
            counts={statusCounts(itemIntentions)}
            selected={relatedStatus}
            onToggle={toggleRelatedStatus}
          />
        )}

        {itemIntentions.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No intentions linked to this item
          </p>
        ) : visibleIntentions.length === 0 ? (
          <p className="text-muted-foreground text-sm">No intentions match the chips above</p>
        ) : (
          <div className="space-y-2">
            {visibleIntentions.map((intent) => (
              <IntentionCard
                tagPool={tagPool}
                key={intent.id}
                intent={intent}
                contexts={contexts}
                items={items}
                collections={collections}
                onUpdate={onUpdateIntent}
                onSchedule={onSchedule}
                onStartNow={onStartNowIntention}
                getIntentDisplay={getIntentDisplay}
                showScheduling={true}
                // Without onViewDetail this card fell through to inline edit —
                // the only edit surface in the app with no dirty guard behind
                // it. Navigating matches the other two list sites and removes
                // the unguarded form rather than guarding it.
                onViewDetail={onViewIntentionDetail}
                events={events}
                onUpdateEvent={onUpdateEvent}
                onActivate={onActivate}
                executions={executions}
                onOpenExecution={onOpenExecution}
                onCancelExecution={onCancelExecution}
                onArchive={onArchiveIntention}
              />
            ))}
          </div>
        )}
      </div>

      <div className="mt-6">
        {/* Across every intention of this item. */}
        <RecentCompletions itemId={item.id} showIntention onOpenExecution={onOpenExecution} />
        <NoteTimeline
          notesState={notesState}
          archived={Boolean(item.archived)}
          sources={noteSources}
        />
      </div>

      {/* Last on the page, and only when this item was filed from a capture. */}
      <OriginalCapture capturedText={capturedText} />
    </div>
  );
}
