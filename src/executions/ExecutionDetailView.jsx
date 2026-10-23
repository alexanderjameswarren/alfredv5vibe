import React, { useState, useEffect } from "react";
import { ArrowLeft, Check, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { formatEventDate, getTodayDate, toLocalDateString } from "../utils/eventDates";
import ObjectIcon from "../shared/ObjectIcon";
import ItemNameLabel from "../items/ItemNameLabel";
import ExecutionElements from "./ExecutionElements";
import MenuRecipeSections from "./MenuRecipeSections";
import { useExecutionNotes } from "../notes/useExecutionNotes";
import RecordLinks from "../shared/RecordLinks";
import CompleteNoteDialog from "../notes/CompleteNoteDialog";
import CompletedOnDialog from "./CompletedOnDialog";
import CancelButton from "../shared/CancelButton";
import { nextForCompletion } from "../utils/recurrence";
import { describeRepeat } from "../utils/recurrenceDisplay";
import { NoteList, ARCHIVED_NOTICE } from "../notes/NoteTimeline";
import { useRecordNotes } from "../notes/useRecordNotes";
import { useExecutionGroups } from "../groups/GroupsContext";

export const DELETE_EXECUTION_CONFIRM =
  "Delete this execution? Its notes and ticked steps are deleted. A date Start Now moved to today goes back.";
export const DELETE_CLOSED_CONFIRM = "Delete this execution? It will be removed from the history.";

export default function ExecutionDetailView({
  execution,
  intent,
  event,
  items,
  contexts,
  collections,
  collectionMembers = {},
  onToggleElement,
  onUpdateElement,
  onToggleCollectionItem,
  onUpdateCollectionItemQty,
  onRefreshCollection,
  onEditItem,
  onComplete,
  onPause,
  onMakeActive,
  onCancel,
  onBack,
  getIntentDisplay,
  onOpenSettings,
  onViewContext,
  onViewIntention,
  onViewItem,
  onOpenExecution,
  // (date) => Promise<boolean>: a completed execution's date, its one editable field.
  onChangeCompletionDate,
  // () => Promise<boolean>: delete a completed or skipped execution from the history.
  onDeleteClosed,
  // Restructure P5 step 14, a menu run: { recipes: [{ run, item }], onToggleElement(run, i),
  // onUpdateElement(run, i, fields), onSkip(run, skipped) }. Null otherwise.
  menu = null,
}) {
  const [completing, setCompleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editingCompletedOn, setEditingCompletedOn] = useState(false);
  // A completed execution is a record: nothing on this page writes to it, apart
  // from notes and its completion date. useExecutionActions refuses other writes.
  const closed = execution.status === "closed";
  const completedOnDate = execution.closedAt ? toLocalDateString(new Date(execution.closedAt)) : null;
  // Restructure P5: the group this execution belongs to (its own, else its intention's).
  const execGroups = useExecutionGroups({
    groupId: execution.groupId,
    intentId: execution.intentId,
    itemIds: execution.itemIds || [],
  });

  // Poll collection every 5 seconds for collection-based executions
  useEffect(() => {
    if (!execution.collectionId || !onRefreshCollection) return;
    onRefreshCollection(execution.collectionId);
    const interval = setInterval(() => {
      onRefreshCollection(execution.collectionId);
    }, 5000);
    return () => clearInterval(interval);
  }, [execution.collectionId, onRefreshCollection]);

  const contextName =
    execution.contextId && contexts
      ? contexts.find((c) => c.id === execution.contextId)?.name
      : null;

  // A group's own run is named after the group as it is now (its intention is hidden).
  const ownGroup = intent?.groupId ? execGroups.chips.find((g) => g.id === intent.groupId) : null;
  const displayName = ownGroup ? ownGroup.name : intent ? getIntentDisplay(intent) : "Execution";
  const dateDisplay = event?.time ? formatEventDate(event.time) : "";

  // Exactly one underlying item, and it still exists. Anything else — none, many,
  // a collection-based execution, or an item since deleted — yields null and the
  // link does not render. See the comment on the link below.
  const soleItemId =
    !execution.collectionId && execution.itemIds?.length === 1
      ? execution.itemIds[0]
      : null;
  const soleItem = soleItemId ? items.find((i) => i.id === soleItemId) : null;
  const editableItemId = soleItem ? soleItemId : null;
  const editableItemName = soleItem?.name || "";
  // The intention's own item first, else the run's single item.
  const linkedItem = (intent?.itemId && items.find((i) => i.id === intent.itemId)) || soleItem || null;

  // Notes live in the notes table: this user's one note for the run (the box),
  // and every note on the intention and its item (the list) (Restructure P2).
  // A menu run's own note is on the menu (target 'group'), not its hidden intention.
  const notes = useExecutionNotes({
    executionId: execution.id,
    intentId: execution.intentId,
    target: menu ? { type: "group", id: execution.groupId } : null,
  });
  const noteItemId = intent?.itemId || soleItemId;
  const listNotes = useRecordNotes(
    menu
      ? { target: { type: "group", id: execution.groupId }, groupIds: [execution.groupId] }
      : {
          target: { type: "intention", id: execution.intentId },
          itemIds: noteItemId ? [noteItemId] : [],
          intentionIds: execution.intentId ? [execution.intentId] : [],
        },
  );

  function leaveTo(go) {
    notes.save();
    go();
  }

  // Note sources link out, except to this execution itself.
  const noteSources = {
    here: { type: "execution", id: execution.id },
    itemName: (id) => items.find((i) => i.id === id)?.name,
    intentionName: (id) => (intent && intent.id === id ? getIntentDisplay(intent) : null),
    onViewItem: onViewItem && ((id) => leaveTo(() => onViewItem(id))),
    onViewIntention: onViewIntention && ((id) => leaveTo(() => onViewIntention(id))),
    onOpenExecution: onOpenExecution && ((exec) => leaveTo(() => onOpenExecution(exec))),
  };

  async function completeWithNote(text, nextDate, completedOn) {
    notes.setDraft(text);
    if (!(await notes.save(text))) return false;
    onComplete(nextDate, completedOn);
    return true;
  }

  // Step 7: "Completed on" for every execution: any past day, never a future one.
  const today = getTodayDate();
  const completionOnComplete = { today };

  // A repeating, active intention also offers its next date, by the shared rule.
  const nextOnComplete = nextForCompletion(intent, {
    eventDate: event?.time ? String(event.time).slice(0, 10) : null,
    today,
    describe: (config, endDate, day) => describeRepeat({ config, endDate, today: day }),
  });

  return (
    <div>
      <button
        onClick={() => leaveTo(onBack)}
        className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="mb-4 sm:mb-6">
        <div className="flex items-start justify-between gap-3">
          <h2 className="flex items-start gap-2 text-xl sm:text-2xl font-bold text-foreground">
            <ObjectIcon type="execution" className="w-6 h-6 text-primary" align="first-line" />
            <span className="min-w-0">{displayName}</span>
          </h2>
          {/* Step 12.2 — a LINK, not an edit surface.

              Shown only when the execution has EXACTLY ONE underlying item.
              `itemIds` is an array and `flattenElements` pulls in nested
              referenced items, so "the underlying item" is not guaranteed to
              exist or to be singular: an intention with no item gives zero, and
              the schema permits many. Rather than guess which one the user meant,
              the link is absent unless the answer is unambiguous. In the whole of
              Alex's execution history — 50 executions — none has more than one:
              42 have exactly one and 8 have none, so this covers every real case
              and declines only the hypothetical.

              Collection-based executions get no link at all: they carry
              `itemIds: []` by construction and resolve live from the collection,
              so there is no underlying item to open. Tapping through to a row's
              item is 12.9, deliberately separate.

              Notes are flushed first, exactly as the Back button does — the
              textarea also saves on blur, but a click that lands on the link
              without blurring it would otherwise lose what was typed. */}
          {editableItemId && onEditItem && !closed && (
            <button
              onClick={() => leaveTo(() => onEditItem(editableItemId))}
              title={`Edit "${editableItemName}"`}
              className="flex items-center gap-1.5 shrink-0 min-h-[44px] px-2 text-sm text-muted-foreground hover:text-foreground underline underline-offset-4 decoration-border hover:decoration-foreground transition-colors"
            >
              <Pencil className="w-4 h-4" />
              Edit item
            </button>
          )}
        </div>
        {/* The scheduled date, for an open execution only: a completed one shows
            its real date on the Completed line, which a backfill can make differ. */}
        {dateDisplay && !closed && (
          <p className="text-sm text-muted-foreground mt-1">{dateDisplay}</p>
        )}
        {closed && (
          <p className="flex items-center gap-2 text-sm font-medium text-foreground mt-1">
            <span>
              {/* A skip is never a completion (Step 9): it reads "Skipped" and its event's date. */}
              {execution.outcome === "skipped"
                ? `Skipped${dateDisplay ? ` ${dateDisplay}` : ""} · read only`
                : `Completed${completedOnDate ? ` ${formatEventDate(completedOnDate)}` : ""} · read only`}
            </span>
            {/* Only the date may change (Step 7), for cleanup and backfills. */}
            {onChangeCompletionDate && execution.outcome === "done" && (
              <button
                type="button"
                onClick={() => setEditingCompletedOn(true)}
                aria-label="Change completion date"
                className="text-sm text-primary hover:text-primary-hover min-h-[44px] px-2 font-normal"
              >
                Change
              </button>
            )}
          </p>
        )}
        {closed && onDeleteClosed && (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className="mt-2 flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] border-2 border-destructive text-destructive hover:bg-destructive/10 rounded-lg transition-colors duration-200"
          >
            <Trash2 className="w-4 h-4" />
            Delete Execution
          </button>
        )}
        {confirmingDelete && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={() => setConfirmingDelete(false)}>
            <div
              role="dialog"
              aria-label="Delete execution"
              className="bg-background border border-border rounded-lg shadow-xl p-5 w-full max-w-sm mx-4"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="text-sm mb-4">{DELETE_CLOSED_CONFIRM}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    if (await onDeleteClosed()) setConfirmingDelete(false);
                  }}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] bg-destructive hover:bg-destructive-hover text-white rounded-lg shadow-sm"
                >
                  <Trash2 className="w-4 h-4" />
                  Delete
                </button>
                <CancelButton onClick={() => setConfirmingDelete(false)} />
              </div>
            </div>
          </div>
        )}
        {editingCompletedOn && (
          <CompletedOnDialog
            initialDate={completedOnDate}
            onCancel={() => setEditingCompletedOn(false)}
            onSave={async (date) => {
              const ok = await onChangeCompletionDate(date);
              if (ok) setEditingCompletedOn(false);
              return ok;
            }}
          />
        )}
        {/* Linked records, the event edit form's pattern: context, intention and
            item, each tappable, so a running or paused run is never a dead end.
            Notes are flushed first, as Back does. */}
        <div className="mt-2">
          <RecordLinks
            context={contextName ? {
              name: contextName,
              onOpen: onViewContext && (() => leaveTo(() => onViewContext(execution.contextId))),
            } : null}
            groups={execGroups.onOpenGroup ? execGroups.chips.map((g) => ({
              ...g,
              onOpen: () => leaveTo(() => execGroups.onOpenGroup(g.id)),
            })) : []}
            intention={intent && !intent.groupId && onViewIntention ? {
              name: getIntentDisplay(intent),
              onOpen: () => leaveTo(() => onViewIntention(intent.id)),
            } : null}
            item={linkedItem && onViewItem ? {
              name: linkedItem.name,
              onOpen: () => leaveTo(() => onViewItem(linkedItem.id)),
            } : null}
          />
        </div>
      </div>

      {/* Collection-based execution view */}
      {execution.collectionId && (() => {
        const coll = collections?.find((c) => c.id === execution.collectionId);
        // Step 3b: checklist membership is read from collection_items. The
        // completion handler still clears items out of the jsonb until Step 4.
        const collItems = collectionMembers[execution.collectionId] || [];
        const completedIds = execution.completedItemIds || [];
        const completedCount = collItems.filter((ci) => completedIds.includes(ci.itemId)).length;

        return (
          <div className="mb-6">
            <div className="border-t border-border pt-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-medium">
                  {coll ? coll.name : "Collection"} ({completedCount}/{collItems.length})
                </h3>
              </div>
              {collItems.length === 0 ? (
                <p className="text-muted-foreground text-sm py-4 text-center">No items in collection</p>
              ) : (
                <div className="space-y-1">
                  {collItems.map((collItem) => {
                    const linkedItem = items.find((i) => i.id === collItem.itemId);
                    const isChecked = completedIds.includes(collItem.itemId);
                    return (
                      <div
                        key={collItem.itemId}
                        className="flex items-center gap-3 py-2 px-3 rounded hover:bg-secondary/50"
                      >
                        <span
                          onClick={closed ? undefined : () => onToggleCollectionItem(collItem.itemId)}
                          aria-disabled={closed || undefined}
                          className={`w-5 h-5 flex-shrink-0 rounded border-2 flex items-center justify-center ${closed ? "cursor-default" : "cursor-pointer"} ${
                            isChecked
                              ? "bg-primary border-primary"
                              : "bg-white border-border"
                          }`}
                        >
                          {isChecked && (
                            <Check className="w-3 h-3 text-white" />
                          )}
                        </span>
                        <div className="flex-1 min-w-0">
                          <span className={isChecked ? "line-through text-muted-foreground" : "text-foreground"}>
                            <ItemNameLabel name={linkedItem?.name} />
                          </span>
                        </div>
                        {/* Same call as the detail list: quantity disabled while
                            the item cannot be shown, but the checkbox stays live.
                            Ticking it is the first half of clearing the row on
                            completion, which is the same legitimate act as the X
                            button in the detail view. */}
                        <input
                          type="text"
                          value={collItem.quantity || ""}
                          disabled={!linkedItem || closed}
                          title={linkedItem ? undefined : "This item cannot be shown, so its quantity cannot be edited"}
                          onChange={(e) => {
                            if (closed) return;
                            onUpdateCollectionItemQty(execution.collectionId, collItem.itemId, e.target.value);
                          }}
                          placeholder="Qty"
                          className="w-20 sm:w-24 px-2 py-2 border border-border rounded text-base disabled:opacity-50 disabled:cursor-not-allowed"
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Element-based execution view */}
      {!execution.collectionId && !menu && execution.elements && execution.elements.length > 0 && (
        <div className="mb-6">
          <div className="border-t border-border pt-4">
            <ExecutionElements
              execution={execution}
              closed={closed}
              onToggleElement={onToggleElement}
              onUpdateElement={onUpdateElement}
              onOpenSettings={onOpenSettings}
            />
          </div>
        </div>
      )}

      {/* A menu run (Restructure P5 step 14): one section per recipe, with a jump bar. */}
      {menu && (
        <MenuRecipeSections
          recipes={menu.recipes}
          loading={menu.loading}
          closed={closed}
          onToggleElement={menu.onToggleElement}
          onUpdateElement={menu.onUpdateElement}
          onSkip={menu.onSkip}
          onOpenSettings={onOpenSettings}
        />
      )}
      {/* Notes, laid out as on item and intention detail: this execution's one
          note (autosaving), then the grouped list of every other note on the
          intention and its item. The same on a completed run. */}
      <section className="mb-6 border-t border-border pt-4" aria-label="Notes">
        <h3 className="text-lg font-medium mb-3">Notes</h3>
        {intent?.archived && !notes.draft ? (
          <p className="text-sm text-muted-foreground mb-3">{ARCHIVED_NOTICE}</p>
        ) : (
          <>
            <textarea
              aria-label="This execution's note"
              value={notes.draft}
              onChange={(e) => notes.setDraft(e.target.value)}
              onBlur={() => notes.save()}
              disabled={!notes.loaded}
              placeholder={notes.loaded ? "Add notes about this execution..." : "Loading notes…"}
              className="w-full px-3 py-2.5 border border-border rounded-lg text-base bg-input-background min-h-[120px] disabled:opacity-60"
            />
            {notes.saveState === "saving" && <p className="text-xs text-muted-foreground mt-1">Saving…</p>}
            {notes.saveState === "error" && (
              <p className="text-xs text-destructive mt-1">Note not saved. Tap outside the box to try again.</p>
            )}
          </>
        )}
        {listNotes.error && <p className="text-sm text-destructive mt-2">{listNotes.error}</p>}
        <div className="mt-3">
          <NoteList
            notes={(listNotes.notes || []).filter((n) => n.id !== notes.mineId)}
            userId={listNotes.userId}
            edit={listNotes.edit}
            remove={listNotes.remove}
            sources={noteSources}
          />
        </div>
      </section>

      {completing && !closed && (
        <CompleteNoteDialog
          initialNote={notes.draft}
          onComplete={completeWithNote}
          next={nextOnComplete}
          completion={completionOnComplete}
          onCancel={() => setCompleting(false)}
        />
      )}

      {!closed && (
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 sm:gap-0 pt-4 border-t border-border">
        {/* Deletes the execution outright: no undo anywhere, so it asks first.
            Red outline, no fill, alone on the left. Pause is tinted, Complete the
            only solid button. Teal is reserved for "in progress". */}
        <button
          onClick={() => {
            if (window.confirm(DELETE_EXECUTION_CONFIRM)) onCancel();
          }}
          className="flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] border-2 border-destructive text-destructive hover:bg-destructive/10 rounded-lg transition-colors duration-200"
        >
          <Trash2 className="w-4 h-4" />
          Delete Execution
        </button>
        {execution.status === "paused" ? (
          <button
            onClick={onMakeActive}
            className="flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] bg-success hover:bg-success-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
          >
            <Play className="w-4 h-4" />
            Make Active
          </button>
        ) : (
          <button
            onClick={onPause}
            className="flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] border-2 border-warning bg-warning-light text-foreground hover:shadow-md rounded-lg transition-all duration-200"
          >
            <Pause className="w-4 h-4" />
            Pause
          </button>
        )}
        <button
          onClick={() => setCompleting(true)}
          className="flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
        >
          <Check className="w-5 h-5" />
          Complete
        </button>
      </div>
      )}
    </div>
  );
}
