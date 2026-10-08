import React, { useState, useEffect, useCallback } from "react";
import { ArrowLeft, Check, Pause, Pencil, Play, Timer, Trash2 } from "lucide-react";
import { formatEventDate } from "../utils/eventDates";
import ObjectIcon from "../shared/ObjectIcon";
import {
  useNotificationChain,
  ChainUnreachableNotice,
  ElementNotification,
  ChainRemainingToggle,
} from "../NotificationChainInline";
import ItemNameLabel from "../items/ItemNameLabel";
import EventMetaLink from "../schedule/EventMetaLink";

export const DELETE_EXECUTION_CONFIRM =
  "Delete this execution? Its notes and ticked steps are deleted. The scheduled date stays.";

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
  onUpdateNotes,
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
}) {
  const [localNotes, setLocalNotes] = useState(execution.notes || "");
  const [, setTick] = useState(0);
  // Notification state lives ON the elements now, so the chain is loaded here
  // and threaded into the element rows rather than rendered as its own list.
  const chain = useNotificationChain(execution.id, execution.elements);
  const [editingStep, setEditingStep] = useState(null);

  // 🛑 Reload the chain AFTER the toggle has finished writing, not when the
  // element state changes.
  //
  // toggleExecutionElement updates elements optimistically and only THEN awaits
  // the storage write and the chain advance. The hook's completion-change
  // effect therefore fired first and read the rows back BEFORE the advance had
  // written them — so a ticked step left the next one still showing "notify N
  // min after…", and the stale read only corrected itself on the next unrelated
  // reload. Awaiting the toggle removes the race entirely.
  const handleToggleElement = useCallback(
    async (elementIndex) => {
      await onToggleElement(elementIndex);
      await chain.reload();
    },
    [onToggleElement, chain]
  );

  // Poll collection every 5 seconds for collection-based executions
  useEffect(() => {
    if (!execution.collectionId || !onRefreshCollection) return;
    onRefreshCollection(execution.collectionId);
    const interval = setInterval(() => {
      onRefreshCollection(execution.collectionId);
    }, 5000);
    return () => clearInterval(interval);
  }, [execution.collectionId, onRefreshCollection]);

  // Timer tick for in-progress elements
  useEffect(() => {
    const hasInProgress = execution.elements?.some((el) => el.inProgress);
    if (!hasInProgress) return;
    const interval = setInterval(() => setTick((t) => t + 1), 10000);
    return () => clearInterval(interval);
  }, [execution.elements]);

  function formatElapsed(startedAt) {
    if (!startedAt) return "";
    const startMs = typeof startedAt === 'string' ? new Date(startedAt).getTime() : startedAt;
    const seconds = Math.floor((Date.now() - startMs) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m ago`;
  }

  const contextName =
    execution.contextId && contexts
      ? contexts.find((c) => c.id === execution.contextId)?.name
      : null;

  const displayName = intent ? getIntentDisplay(intent) : "Execution";
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

  function leaveTo(go) {
    onUpdateNotes(localNotes);
    go();
  }

  return (
    <div>
      <button
        onClick={() => {
          onUpdateNotes(localNotes);
          onBack();
        }}
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
          {editableItemId && onEditItem && (
            <button
              onClick={() => {
                onUpdateNotes(localNotes);
                onEditItem(editableItemId);
              }}
              title={`Edit "${editableItemName}"`}
              className="flex items-center gap-1.5 shrink-0 min-h-[44px] px-2 text-sm text-muted-foreground hover:text-foreground underline underline-offset-4 decoration-border hover:decoration-foreground transition-colors"
            >
              <Pencil className="w-4 h-4" />
              Edit item
            </button>
          )}
        </div>
        {dateDisplay && (
          <p className="text-sm text-muted-foreground mt-1">{dateDisplay}</p>
        )}
        {/* Linked records, the event edit form's pattern: context, intention and
            item, each tappable, so a running or paused run is never a dead end.
            Notes are flushed first, as Back does. */}
        {(contextName || intent || linkedItem) && (
          <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-xs mt-2" aria-label="Linked records">
            {contextName &&
              (onViewContext ? (
                <button
                  onClick={() => leaveTo(() => onViewContext(execution.contextId))}
                  title={`Open context: ${contextName}`}
                  className="inline-flex items-center gap-1 bg-warning-light hover:bg-warning text-foreground px-2 py-1 rounded transition-colors"
                >
                  <ObjectIcon type="context" className="w-3.5 h-3.5" />
                  {contextName}
                </button>
              ) : (
                <span className="inline-flex items-center gap-1 bg-warning-light text-foreground px-2 py-1 rounded">
                  <ObjectIcon type="context" className="w-3.5 h-3.5" />
                  {contextName}
                </span>
              ))}
            {intent && onViewIntention && (
              <EventMetaLink
                icon={<ObjectIcon type="intention" className="w-3.5 h-3.5" />}
                name={getIntentDisplay(intent)}
                showName
                onClick={() => leaveTo(() => onViewIntention(intent.id))}
                title={`Open intention: ${getIntentDisplay(intent)}`}
              />
            )}
            {linkedItem && onViewItem && (
              <EventMetaLink
                icon={<ObjectIcon type="item" className="w-3.5 h-3.5" />}
                name={linkedItem.name}
                showName
                onClick={() => leaveTo(() => onViewItem(linkedItem.id))}
                title={`Open item: ${linkedItem.name}`}
              />
            )}
          </div>
        )}
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
                          onClick={() => onToggleCollectionItem(collItem.itemId)}
                          className={`w-5 h-5 flex-shrink-0 rounded border-2 flex items-center justify-center cursor-pointer ${
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
                          disabled={!linkedItem}
                          title={linkedItem ? undefined : "This item cannot be shown, so its quantity cannot be edited"}
                          onChange={(e) => {
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
      {!execution.collectionId && execution.elements && execution.elements.length > 0 && (
        <div className="mb-6">
          <div className="border-t border-border pt-4 space-y-2">
            <ChainUnreachableNotice chain={chain} onOpenSettings={onOpenSettings} />
            {(() => {
              let stepCounter = 0;
              return execution.elements.map((el, index) => {
                const indent = el.indent || 0;
                const indentPx = indent * 24;

                if (el.missing) {
                  return (
                    <div key={index} className="flex items-center gap-2 py-1 text-muted-foreground italic" style={{ marginLeft: indentPx }}>
                      <span>⚠ {el.name} (item deleted)</span>
                    </div>
                  );
                }

                if (el.circular) {
                  return (
                    <div key={index} className="flex items-center gap-2 py-1 text-muted-foreground italic" style={{ marginLeft: indentPx }}>
                      <span>↻ {el.name} (circular ref)</span>
                    </div>
                  );
                }

                if (el.displayType === "header") {
                  return (
                    <div key={index} className="mt-4 mb-2" style={{ marginLeft: indentPx }}>
                      <h4 className="text-md font-bold text-foreground uppercase tracking-wide">
                        {el.name}
                      </h4>
                    </div>
                  );
                }

                if (el.displayType === "bullet") {
                  return (
                    <div key={index} className="flex items-start gap-2 py-1" style={{ marginLeft: indentPx + 16 }}>
                      <span className="text-muted-foreground mt-0.5">•</span>
                      <div className="flex-1">
                        <span className="text-foreground">
                          {el.quantity && (
                            <span className="font-medium">{el.quantity} · </span>
                          )}
                          {el.name}
                        </span>
                        {el.description && (
                          <p className="text-sm text-muted-foreground">{el.description}</p>
                        )}
                      </div>
                    </div>
                  );
                }

                // step or any other displayType
                stepCounter++;
                const stepNum = stepCounter;
                return (
                  <div key={index} style={{ marginLeft: indentPx }}>
                    <ChainRemainingToggle chain={chain} index={index} />
                    <div
                      className="flex items-start gap-3 py-2 px-3 rounded hover:bg-secondary/50"
                    >
                      <span className={`font-medium min-w-[24px] mt-0.5 ${el.isCompleted ? "text-muted-foreground" : "text-muted-foreground"}`}>
                        {stepNum}.
                      </span>
                      <span
                        onClick={() => handleToggleElement(index)}
                        className={`mt-1 w-5 h-5 flex-shrink-0 rounded border-2 flex items-center justify-center cursor-pointer ${
                          el.isCompleted
                            ? "bg-primary border-primary"
                            : el.inProgress
                              ? "bg-white border-primary"
                              : "bg-white border-border"
                        }`}
                      >
                        {el.isCompleted && (
                          <Check className="w-3 h-3 text-white" />
                        )}
                      </span>
                      <div className="flex-1">
                        <span
                          className={
                            el.isCompleted
                              ? "line-through text-muted-foreground"
                              : el.inProgress
                                ? "text-primary font-medium"
                                : "text-foreground"
                          }
                        >
                          {el.name}
                        </span>
                        {(el.quantity || el.description) && (
                          <p
                            className={`text-sm ${el.isCompleted ? "text-muted-foreground" : "text-muted-foreground"}`}
                          >
                            {[el.quantity, el.description]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        )}
                        <ElementNotification
                          chain={chain}
                          element={el}
                          index={index}
                          editing={editingStep}
                          setEditing={setEditingStep}
                        />
                      </div>
                      {!el.isCompleted && !el.inProgress && (
                        <button
                          onClick={() => onUpdateElement(index, { inProgress: true, startedAt: new Date().toISOString() })}
                          className="text-sm text-primary hover:text-primary-hover whitespace-nowrap"
                        >
                          Start
                        </button>
                      )}
                      {el.inProgress && !el.isCompleted && (
                        <button
                          onClick={() => onUpdateElement(index, { inProgress: false, startedAt: null })}
                          className="text-sm text-muted-foreground hover:text-muted-foreground whitespace-nowrap"
                        >
                          Reset
                        </button>
                      )}
                    </div>
                    {el.inProgress && el.startedAt && !el.isCompleted && (
                      <div className="ml-16 pb-1 text-xs text-primary">
                        <Timer className="w-3.5 h-3.5 inline" /> Started {formatElapsed(el.startedAt)}
                      </div>
                    )}
                  </div>
                );
              });
            })()}
          </div>
        </div>
      )}

      <div className="mb-6">
        <div className="border-t border-border pt-4">
          <label className="block text-sm font-medium text-foreground mb-2">
            Notes
          </label>
          <textarea
            value={localNotes}
            onChange={(e) => setLocalNotes(e.target.value)}
            onBlur={() => onUpdateNotes(localNotes)}
            placeholder="Add notes about this execution..."
            className="w-full px-3 py-2 border border-border rounded min-h-[120px]"
          />
        </div>
      </div>

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
          onClick={onComplete}
          className="flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
        >
          <Check className="w-5 h-5" />
          Complete
        </button>
      </div>
    </div>
  );
}
