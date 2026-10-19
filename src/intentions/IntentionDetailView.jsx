import React, { useState } from "react";
import { ArrowLeft, CalendarPlus, CalendarX, NotebookPen, Play, Settings } from "lucide-react";
import CompleteNoteDialog from "../notes/CompleteNoteDialog";
import { recordCopyText } from "../shared/copyRecord";
import CopyButton from "../shared/CopyButton";
import ActionBar, { archiveAction, logAction, skipAction } from "../shared/ActionBar";
import { ACTION_BUTTON } from "../shared/actionButton";
import { getTodayDate } from "../utils/eventDates";
import { getRecurrenceConfig, nextForCompletion } from "../utils/recurrence";
import { describeRepeat } from "../utils/recurrenceDisplay";
import ObjectIcon from "../shared/ObjectIcon";
import DetailMeta from "../shared/DetailMeta";
import SchedulePopover from "../shared/recurrence/SchedulePopover";
import { IntentionReminderLines, useReminderSummary } from "../inbox/PendingReminder";
import OriginalCapture from "../inbox/OriginalCapture";
import IntentionCard from "./IntentionCard";
import RecordLinks from "../shared/RecordLinks";
import ScheduledLine from "../shared/ScheduledLine";
import InProgressSection from "../executions/InProgressSection";
import NoteTimeline from "../notes/NoteTimeline";
import RecentCompletions from "../notes/RecentCompletions";
import OpenExecutionNotes from "../notes/OpenExecutionNotes";
import { useRecordNotes } from "../notes/useRecordNotes";
import StatusMenu from "../shared/StatusMenu";
import StatusEventsSheet from "../shared/StatusEventsSheet";
import CloseDialog from "../shared/CloseDialog";
import { CLOSE_BLOCKED, closeDefaults, loadClosePending } from "../shared/useRowClose";
import { liveEventsFor, closedBlockTitle, recordActions, STATUS_LABELS } from "../utils/status";

export default function IntentionDetailView({
  tagPool = [],
  intention,
  // (message, { error }) => void, the app's short toast. Copy reports through it.
  onNotify,
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
  // closeRecords (close reason): Closed from the pill or the edit form goes through it.
  onCloseRecords,
  collections = [],
  onDirtyChange,
  // Step 8: (intentId, { note, nextDate, completedOn }) => Promise<boolean>.
  onMarkDone,
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [completing, setCompleting] = useState(false);
  // The move waiting on the live-events sheet's answer — `{ status, form }`, where
  // `form` is the edit form's save riding along — and why a move was refused.
  const [pending, setPending] = useState(null);
  const [statusBlocked, setStatusBlocked] = useState(null);
  // The Close pop-up's state: { form, defaults, future, reminderCount, loading }.
  const [closing, setClosing] = useState(null);
  const notesState = useRecordNotes({
    target: { type: "intention", id: intention?.id },
    intentionIds: intention ? [intention.id] : [],
  });
  const reminders = useReminderSummary({ intentId: intention?.id || null });

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
        `Cannot move to ${STATUS_LABELS[status]}: an execution is in progress. Finish or delete it first.`,
      );
      return false;
    }
    // Closed always asks, in the one Close pop-up (close reason).
    if (status === "closed" && onCloseRecords) {
      openClose(form);
      return false;
    }
    // Asked when there is a live event, pending reminders, or both (one answer for all).
    if (liveEvents.length > 0 || reminders.scheduled.length > 0) {
      setPending({ status, form });
      return false;
    }
    return true;
  }

  function chooseStatus(status) {
    if (gateStatus(status)) onSetStatus(intention.id, status);
  }

  // `form`: the edit form's Save, riding along to be saved first.
  async function openClose(form) {
    setClosing({ form, ...closeDefaults({ intents: [intention], picked: intention, events }), loading: true });
    const found = await loadClosePending(events, [intention]);
    setClosing((c) => c && { ...c, ...found, loading: false });
  }

  async function confirmClose({ reason, note, closedOn }) {
    const held = closing;
    setClosing(null);
    if (held.form) await onUpdateIntention(held.form.id, held.form.fields, held.form.scheduledDate);
    await onCloseRecords({ intentIds: [intention.id], label: intention.text, reason, note, closedOn, pickedIntentId: intention.id });
    reminders.reload();
    if (held.form) setIsEditing(false);
    return true;
  }

  function cancelClose() {
    if (closing?.form && onDirtyChange) onDirtyChange(true, "this intention");
    setClosing(null);
  }

  // Edit form Save: fields first, then status through its own patch.
  async function commit({ status, form }, archiveEvents = false) {
    if (form) await onUpdateIntention(form.id, form.fields, form.scheduledDate);
    if (status) await onSetStatus(intention.id, status, { archiveEvents });
    if (status && archiveEvents) reminders.reload();
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
          reminderCount={reminders.scheduled.length}
          onArchive={() => answerSheet(true)}
          onKeep={() => answerSheet(false)}
          onCancel={cancelSheet}
        />
      )}
      {closing && (
        <CloseDialog
          title={`Close "${intention.text}"`}
          today={closing.today}
          defaultClosedOn={closing.defaultClosedOn}
          defaultReason={closing.defaultReason}
          pending={closing.loading ? null : closing}
          onConfirm={confirmClose}
          onCancel={cancelClose}
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
  const linkedItem = intention.itemId ? (items || []).find((i) => i.id === intention.itemId) : null;

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
          closeBlocked={hasActiveExecutions ? CLOSE_BLOCKED : null}
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
            {/* Enabled even when closed: copying changes nothing. */}
            <CopyButton
              getText={() => recordCopyText({ title: intention.text, description: intention.description, id: intention.id })}
              title="Copy for a Claude chat"
            />
          </h2>
          {onSetStatus && (
            <StatusMenu row={intention} onChoose={chooseStatus} blocked={hasActiveExecutions ? { closed: CLOSE_BLOCKED } : {}} />
          )}
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

        {/* The execution page's link row: context pill, then the linked item. */}
        <div className="mt-2">
          <RecordLinks
            context={contextName ? {
              name: contextName,
              onOpen: onViewContextDetail && (() => onViewContextDetail(intention.contextId)),
            } : null}
            item={linkedItem && onViewItemDetail ? {
              name: linkedItem.name,
              onOpen: () => onViewItemDetail(linkedItem.id),
            } : null}
          />
        </div>
        <DetailMeta tags={intention.tags} />

        <p className="text-sm text-muted-foreground mt-2">
          Repeats:{" "}
          {describeRepeat({
            config: getRecurrenceConfig(intention),
            endDate: intention.endDate,
            today: getTodayDate(),
          })}
        </p>
        {/* The one live event, as part of the intention; its actions are in the row below. */}
        <p className="text-sm mt-1">
          <ScheduledLine actions={actions} />
        </p>

        <IntentionReminderLines
          intentId={intention.id}
          text={intention.text || ""}
          scheduled={reminders.scheduled}
          onChanged={reminders.reload}
          disabledReason={closedTitle}
        />

        {statusNotices}

        {/* Record actions (Restructure P4), in one order: Start Now, Schedule /
            Reschedule, Skip, Complete, Edit, Archive. As many as fit are buttons;
            the rest go into ⋯ in the same order (ActionBar). */}
        <ActionBar
          actions={[
            onStartNow && {
              key: "start",
              pinned: true,
              menu: null,
              button: (
                <button
                  onClick={() => (actions.open ? onOpenExecution?.(actions.open) : onStartNow(intention.id))}
                  disabled={Boolean(closedTitle)}
                  className={`${ACTION_BUTTON} bg-success hover:bg-success-hover text-white`}
                >
                  <Play className="w-4 h-4" />
                  {actions.primaryLabel}
                </button>
              ),
            },
            onSchedule && {
              key: "schedule",
              pinned: true,
              menu: null,
              button: (
                <SchedulePopover
                  label={actions.scheduleLabel}
                  icon={<CalendarPlus className="w-4 h-4" />}
                  initialDate={actions.liveDate || getTodayDate()}
                  minDate={getTodayDate()}
                  onPick={(date) => onSchedule(intention.id, date)}
                  disabled={Boolean(closedTitle || actions.moveBlocked)}
                  className={`${ACTION_BUTTON} bg-secondary hover:bg-secondary text-foreground`}
                />
              ),
            },
            // Skip and Log Execution are hidden while an execution is in progress or
            // paused: the page then offers Continue, never both.
            // Skip: a repeating intention with a live date only.
            isRecurring && actions.live && !actions.open && onUpdateEvent && {
              key: "skip",
              ...skipAction(() => onUpdateEvent(actions.live.id, { archived: true })),
            },
            // Log Execution (Step 8): every intention not closed.
            onMarkDone && !closedTitle && !actions.open && {
              key: "log",
              ...logAction(() => setCompleting(true)),
            },
            {
              key: "edit",
              menu: { label: "Edit", icon: Settings, onClick: () => setIsEditing(true) },
              button: (
                <button
                  onClick={() => setIsEditing(true)}
                  className={`${ACTION_BUTTON} bg-secondary hover:bg-secondary text-foreground`}
                >
                  <Settings className="w-4 h-4" />
                  Edit
                </button>
              ),
            },
            onArchiveIntention && {
              key: "archive",
              ...archiveAction(
                () => onArchiveIntention(intention.id),
                hasActiveExecutions ? "Cannot archive: active execution in progress" : null,
              ),
            },
          ].filter(Boolean)}
          menuOnly={[
            // A one-time intention's date can still be dropped.
            !isRecurring && actions.live && onUpdateEvent && {
              label: "Unschedule",
              icon: CalendarX,
              onClick: () => onUpdateEvent(actions.live.id, { archived: true }),
              disabled: Boolean(actions.open),
              title: actions.open ? "Finish the execution first" : null,
            },
          ].filter(Boolean)}
        />
        {/* The disabled buttons' reason, as visible text (no tooltip repeats it). */}
        {(closedTitle || actions.moveBlocked) && (onStartNow || onSchedule) && (
          <p className="mt-2 text-sm text-muted-foreground">{closedTitle || actions.moveBlocked}</p>
        )}
        {completing && (
          <CompleteNoteDialog
            title="Log execution"
            confirmLabel="Log"
            confirmIcon={NotebookPen}
            completion={{ today: getTodayDate() }}
            next={nextForCompletion(intention, {
              eventDate: actions.live ? String(actions.live.time).slice(0, 10) : null,
              today: getTodayDate(),
              describe: (config, endDate, day) => describeRepeat({ config, endDate, today: day }),
            })}
            onCancel={() => setCompleting(false)}
            onComplete={async (note, nextDate, completedOn) => {
              const ok = await onMarkDone(intention.id, { note, nextDate, completedOn });
              if (ok) setCompleting(false);
              return ok;
            }}
          />
        )}
      </div>

      {/* The linked item is a header link now; the Linked Item card is gone. */}

      {/* The open execution (at most one): the same "In progress" section as every list. */}
      <InProgressSection
        executions={executions.filter((ex) => ex.intentId === intention.id)}
        intents={intents || [intention]}
        contexts={contexts || []}
        getIntentDisplay={getIntentDisplay}
        onOpen={(ex) => onOpenExecution?.(ex)}
        extraFor={(exec) => <OpenExecutionNotes executionId={exec.id} />}
      />

      <RecentCompletions intentId={intention.id} onOpenExecution={onOpenExecution} />

      <NoteTimeline
        notesState={notesState}
        archived={Boolean(intention.archived)}
        sources={{
          here: { type: "intention", id: intention.id },
          itemName: (id) => (items || []).find((i) => i.id === id)?.name,
          onViewItem: onViewItemDetail,
          onOpenExecution,
        }}
      />

      {/* Last on the page, and only when this intention was filed from a capture. */}
      <OriginalCapture capturedText={capturedText} />
    </div>
  );
}
