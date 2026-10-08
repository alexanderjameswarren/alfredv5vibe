import React, { useState } from "react";
import { Archive, ArrowLeft, CalendarPlus, CalendarX, Play, Settings } from "lucide-react";
import OverflowMenu from "../shared/OverflowMenu";
import { ACTION_BUTTON } from "../shared/actionButton";
import { getTodayDate } from "../utils/eventDates";
import { getRecurrenceConfig } from "../utils/recurrence";
import { getRecurrenceDisplayString } from "../utils/recurrenceDisplay";
import ObjectIcon from "../shared/ObjectIcon";
import DetailMeta from "../shared/DetailMeta";
import SchedulePopover from "../shared/recurrence/SchedulePopover";
import PendingReminder from "../inbox/PendingReminder";
import OriginalCapture from "../inbox/OriginalCapture";
import IntentionCard from "./IntentionCard";
import ItemCard from "../items/ItemCard";
import ScheduledLine from "../shared/ScheduledLine";
import PreviousExecutions from "../executions/PreviousExecutions";
import StatusMenu from "../shared/StatusMenu";
import StatusEventsSheet from "../shared/StatusEventsSheet";
import { liveEventsFor, closedBlockTitle, recordActions, STATUS_LABELS } from "../utils/status";

export default function IntentionDetailView({
  tagPool = [],
  intention,
  // The capture this intention was filed from, resolved by the caller from
  // `sourceInboxId`. Null for one created by hand. See OriginalCapture.
  capturedText,
  intents,
  events,
  contexts,
  items,
  onBack,
  onUpdateIntention,
  onEditIntention,
  onUpdateEvent,
  onUpdateItem,
  onActivate,
  getIntentDisplay,
  onViewItemDetail,
  // Step 12.9. Threaded through purely so the event cards below can make their
  // context badge a link; nothing else on this page uses it.
  onViewContextDetail,
  executions = [],
  onOpenExecution,
  onCancelExecution,
  onArchiveIntention,
  onSchedule,
  onStartNow,
  onSetStatus,
  collections = [],
  onDirtyChange,
}) {
  const [isEditing, setIsEditing] = useState(false);
  // The move waiting on the live-events sheet's answer — `{ status, form }`, where
  // `form` is the edit form's save riding along — and why a move was refused.
  const [pending, setPending] = useState(null);
  const [statusBlocked, setStatusBlocked] = useState(null);

  if (!intention) return null;

  const liveEvents = liveEventsFor(events, intention.id);
  const closedTitle = closedBlockTitle(intention, "intention");
  const actions = recordActions(intention, events, executions);

  // The page picker and the form's Save both pass through here. Returns false
  // when the move must wait (sheet) or is refused (running execution).
  function gateStatus(status, form = null) {
    setStatusBlocked(null);
    if (status !== "background" && status !== "closed") return true;
    if (hasActiveExecutions) {
      setStatusBlocked(
        `Cannot move to ${STATUS_LABELS[status]}: an execution is in progress. Finish or cancel it first.`,
      );
      return false;
    }
    if (liveEvents.length > 0) {
      setPending({ status, form });
      return false;
    }
    return true;
  }

  function chooseStatus(status) {
    if (gateStatus(status)) onSetStatus(intention.id, status);
  }

  // Edit form Save: fields first, then status through its own patch.
  async function commit({ status, form }, archiveEvents = false) {
    if (form) await onUpdateIntention(form.id, form.fields, form.scheduledDate);
    if (status) await onSetStatus(intention.id, status, { archiveEvents });
    if (form) setIsEditing(false);
  }

  function saveForm(id, { status, ...fields }, scheduledDate) {
    const form = { id, fields, scheduledDate };
    if (!status || gateStatus(status, form)) return commit({ status, form });
    // Held or refused: the form stays open, and still dirty.
    if (onDirtyChange) onDirtyChange(true, "this intention");
  }

  function answerSheet(archiveEvents) {
    const held = pending;
    setPending(null);
    commit(held, archiveEvents);
  }

  function cancelSheet() {
    if (pending?.form && onDirtyChange) onDirtyChange(true, "this intention");
    setPending(null);
  }

  const statusNotices = (
    <>
      {statusBlocked && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {statusBlocked}
        </p>
      )}
      {pending && (
        <StatusEventsSheet
          status={pending.status}
          event={liveEvents[0]}
          onArchive={() => answerSheet(true)}
          onKeep={() => answerSheet(false)}
          onCancel={cancelSheet}
        />
      )}
    </>
  );

  const isRecurring = getRecurrenceConfig(intention).type !== "once";

  // `executions` is allLiveExecutions — active plus paused, which is exactly
  // the set IntentionCard's own guard queries the database for. Same rule,
  // no round trip.
  const hasActiveExecutions = executions.some(
    (ex) => ex.intentId === intention.id,
  );

  // Get context name for badge
  const contextName =
    intention.contextId && contexts
      ? contexts.find((c) => c.id === intention.contextId)?.name
      : null;

  // If editing, show the IntentionCard in edit mode
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

        <IntentionCard
          tagPool={tagPool}
          intent={intention}
          contexts={contexts}
          items={items}
          collections={collections}
          onUpdate={saveForm}
          getIntentDisplay={getIntentDisplay}
          showScheduling={true}
          isEditing={true}
          editableStatus={Boolean(onSetStatus)}
          formNotice={statusNotices}
          onCancel={() => setIsEditing(false)}
          onArchive={onArchiveIntention}
          // Required as of Step 8a: the card's archive guard is derived from
          // this prop now rather than from its own query, and this was the one
          // onArchive site that did not pass it. Without it the guard silently
          // reads "no executions" and Archive stays enabled mid-execution.
          executions={executions}
          onDirtyChange={onDirtyChange}
          // Same reasoning as item detail: alone on the page.
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
          holding a fixed width on the right. A long intention was squeezed into
          whatever column was left and broke across four or five lines while
          empty space sat beside it. Nothing here competes for horizontal room
          any more. Structurally identical to ItemDetailView's header. */}
      <div className="mb-4 sm:mb-6">
        <div className="flex items-start justify-between gap-2">
          <h2 className="flex items-start gap-2 text-xl sm:text-2xl font-bold min-w-0">
            <ObjectIcon type="intention" className="w-6 h-6 text-primary" align="first-line" />
            <span className="min-w-0">{intention.text}</span>
          </h2>
          {onSetStatus && <StatusMenu row={intention} onChoose={chooseStatus} />}
        </div>

        {/* Details — `intents.description`, migration 069. Step 17c.
            Below the name and above the metadata, because it is the intention's
            own prose rather than a fact about the record. Absent entirely when
            empty: an always-present blank paragraph would push the metadata down
            on every intention to serve the few that have one.
            `whitespace-pre-wrap`, unlike `items.description` a screen away, and
            the difference is deliberate — this field is long text and paragraph
            breaks are content. */}
        {intention.description && (
          <p className="mt-2 text-muted-foreground whitespace-pre-wrap">
            {intention.description}
          </p>
        )}

        <DetailMeta contextName={contextName} tags={intention.tags} />

        <p className="text-sm text-muted-foreground mt-2">
          Recurrence: {getRecurrenceDisplayString(getRecurrenceConfig(intention), intention.endDate)}
        </p>
        {/* The one live event, as part of the intention; its actions are in the row below. */}
        <p className="text-sm mt-1">
          <ScheduledLine actions={actions} />
        </p>

        <PendingReminder intentId={intention.id} />

        {statusNotices}

        {/* Record actions, matching item detail and the cards (recordActions):
            Start Now / Continue, Schedule / Reschedule, Edit, ⋯ holding
            Archive. Always present; the first two are disabled while closed.
            Archive keeps the active-execution guard. */}
        <div className="flex flex-wrap gap-2 mt-3">
          {onStartNow && (
            <button
              onClick={() => (actions.open ? onOpenExecution?.(actions.open) : onStartNow(intention.id))}
              disabled={Boolean(closedTitle)}
              title={closedTitle || undefined}
              className={`${ACTION_BUTTON} bg-success hover:bg-success-hover text-white`}
            >
              <Play className="w-4 h-4" />
              {actions.primaryLabel}
            </button>
          )}
          {onSchedule && (
            <span title={closedTitle || actions.moveBlocked || undefined}>
              <SchedulePopover
                label={actions.scheduleLabel}
                icon={<CalendarPlus className="w-4 h-4" />}
                initialDate={actions.liveDate || getTodayDate()}
                onPick={(date) => onSchedule(intention.id, date)}
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
              // Drops the live date. Recurring: the next one follows (updateEvent).
              actions.live && onUpdateEvent && {
                label: isRecurring ? "Skip this date" : "Unschedule",
                icon: CalendarX,
                onClick: () => onUpdateEvent(actions.live.id, { archived: true }),
                disabled: Boolean(actions.open),
                // Paused too: archiving the date would orphan the paused run.
                title: actions.open ? "Finish or cancel the execution before dropping its date" : null,
              },
              onArchiveIntention && {
                label: "Archive",
                icon: Archive,
                destructive: true,
                onClick: () => onArchiveIntention(intention.id),
                disabled: hasActiveExecutions,
                title: hasActiveExecutions ? "Cannot archive: active execution in progress" : null,
              },
            ].filter(Boolean)}
          />
        </div>
        {/* Phones show no tooltips, so the reason is also spelled out here. */}
        {(closedTitle || actions.moveBlocked) && (onStartNow || onSchedule) && (
          <p className="mt-2 text-sm text-muted-foreground">{closedTitle || actions.moveBlocked}</p>
        )}
      </div>

      {/* Linked Item Section */}
      {intention.itemId && items && (
        <div className="mb-6">
          <h3 className="text-lg font-medium mb-3">Linked Item</h3>
          {(() => {
            const linkedItem = items.find((i) => i.id === intention.itemId);
            return linkedItem ? (
              <ItemCard
                tagPool={tagPool}
                item={linkedItem}
                contexts={contexts}
                onUpdate={onUpdateItem}
                onViewDetail={onViewItemDetail}
                executions={executions.filter((ex) => ex.itemIds?.includes(linkedItem.id))}
                // All of them: the item's run may belong to another of its intentions,
                // and a badge that cannot find its intention reads "Execution".
                intents={intents || [intention]}
                getIntentDisplay={getIntentDisplay}
                onOpenExecution={onOpenExecution}
              />
            ) : (
              <p className="text-muted-foreground text-sm">Item not found</p>
            );
          })()}
        </div>
      )}

      <PreviousExecutions intentId={intention.id} />

      {/* Last on the page, and only when this intention was filed from a capture. */}
      <OriginalCapture capturedText={capturedText} />
    </div>
  );
}
