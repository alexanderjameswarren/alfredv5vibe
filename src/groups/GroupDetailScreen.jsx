import React, { useEffect, useState } from "react";
import { Archive, ArchiveRestore, ArrowLeft, CalendarPlus, Play, Settings } from "lucide-react";
import ObjectIcon, { GroupTypeIcon } from "../shared/ObjectIcon";
import CopyButton from "../shared/CopyButton";
import { recordCopyText } from "../shared/copyRecord";
import StatusPill from "../shared/StatusPill";
import StatusMenu from "../shared/StatusMenu";
import StatusEventsSheet from "../shared/StatusEventsSheet";
import CloseDialog from "../shared/CloseDialog";
import ScheduledLine from "../shared/ScheduledLine";
import SchedulePopover from "../shared/recurrence/SchedulePopover";
import { CLOSE_BLOCKED, closeDefaults, loadClosePending } from "../shared/useRowClose";
import { IntentionReminderLines, useReminderSummary } from "../inbox/PendingReminder";
import { onRemindersChanged } from "../reminders/useReminderIndex";
import { getTodayDate } from "../utils/eventDates";
import { closedBlockTitle, liveEventsFor, recordActions, statusOf, STATUS_LABELS } from "../utils/status";
import { ArchivedNotice, ArchivedPill, restoreAction } from "../shared/archivedRecord";
import RecordLinks from "../shared/RecordLinks";
import ActionBar, { archiveAction, closeAction, logAction } from "../shared/ActionBar";
import LogMenuDialog from "./LogMenuDialog";
import { ACTION_BUTTON } from "../shared/actionButton";
import RowList from "../shared/RowList";
import NoteTimeline from "../notes/NoteTimeline";
import RecentCompletions from "../notes/RecentCompletions";
import { useRecordNotes } from "../notes/useRecordNotes";
import { friendlyDate } from "../inbox/CaptureMeta";
import { groupIntention, groupTypeOf, liveMembers, removedMembers } from "./groupModel";
import { groupTitle, memberRows, recentRemovals } from "./groupDetail";
import ArchiveGroupDialog from "./ArchiveGroupDialog";

/**
 * The group detail page (Restructure P5 step 10), laid out as item and
 * intention detail: header (type icon, name, Copy, status, record links, the
 * schedule and reminder lines of its own intention), actions, members as
 * standard rows, Recently removed, Notes, Recent executions.
 * Step 13: Schedule/Reschedule, Edit, Close, Archive (Start Now and Log
 * Execution come in step 14); the status chip is editable, as on intentions.
 */
export default function GroupDetailScreen({
  group,
  groupTypes,
  groupMembers,
  contexts,
  items,
  intents,
  events,
  executions,
  onBack,
  onEdit,
  onArchive,
  onRestore,
  onOpenHistory,
  onViewContextDetail,
  onOpenExecution,
  onUnarchive,
  // Step 13: (groupId, date); (groupId, status, { archiveEvents }); closeRecords.
  onSchedule,
  onSetStatus,
  onCloseRecords,
  // Step 14: (groupId) Start Now on a menu; 14b: (groupId, { note, completedOn, doneIds }) => Promise<boolean>.
  onStartNow,
  onLogMenu,
  rowListProps,
}) {
  const [logging, setLogging] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [restoreError, setRestoreError] = useState("");
  const [busyId, setBusyId] = useState(null);
  // The move waiting on the live-events sheet, why a move was refused, and the Close pop-up.
  const [pending, setPending] = useState(null);
  const [statusBlocked, setStatusBlocked] = useState(null);
  const [closing, setClosing] = useState(null);
  const notesState = useRecordNotes({ target: { type: "group", id: group.id }, groupIds: [group.id] });
  const ownIntention = groupIntention(group.id, intents);
  const reminders = useReminderSummary({ intentId: ownIntention?.id || null });
  useEffect(() => onRemindersChanged(reminders.reload), [reminders.reload]);

  const lists = { members: groupMembers, items, intents };
  const type = groupTypeOf(group, groupTypes);
  const title = groupTitle(group, lists, type);
  const context = contexts.find((c) => c.id === group.contextId);
  const rows = memberRows(group.id, { ...lists, events, openExecutions: executions });
  const recent = recentRemovals(group.id, lists);
  const hasHistory = removedMembers(group.id, lists).length > 0;
  const plural = (type?.labelPlural || "members").toLowerCase();
  const noun = (type?.labelSingular || "group").toLowerCase();
  const together = type?.executionMode === "together";

  const actions = recordActions(ownIntention, events, executions);
  const liveEvents = ownIntention ? liveEventsFor(events, ownIntention.id) : [];
  const closedTitle = closedBlockTitle(group, noun);
  // A run on its own intention (or carrying the group) blocks Close and Archive.
  const runOpen = executions.some((x) => x.groupId === group.id || (ownIntention && x.intentId === ownIntention.id));
  const openIntents = ownIntention && statusOf(ownIntention) !== "closed" ? [ownIntention] : [];

  // As intention detail: Background asks about the live date and reminders; Closed is the Close pop-up.
  function chooseStatus(status) {
    setStatusBlocked(null);
    if (status === "background" || status === "closed") {
      if (runOpen) {
        setStatusBlocked(`Cannot move to ${STATUS_LABELS[status]}: an execution is in progress. Finish or delete it first.`);
        return;
      }
      if (status === "closed") return openClose();
      if (liveEvents.length > 0 || reminders.scheduled.length > 0) return setPending({ status });
    }
    onSetStatus(group.id, status);
  }

  async function answerSheet(archiveEvents) {
    const held = pending;
    setPending(null);
    await onSetStatus(group.id, held.status, { archiveEvents });
    if (archiveEvents) reminders.reload();
  }

  async function openClose() {
    setClosing({ ...closeDefaults({ item: group, intents: openIntents, picked: ownIntention, events }), loading: true });
    const found = await loadClosePending(events, openIntents);
    setClosing((c) => c && { ...c, ...found, loading: false });
  }

  async function confirmClose({ reason, note, closedOn }) {
    setClosing(null);
    await onCloseRecords({
      group,
      intentIds: openIntents.map((i) => i.id),
      label: title,
      reason,
      note,
      closedOn,
      pickedIntentId: ownIntention?.id || null,
    });
    reminders.reload();
    return true;
  }

  async function putBack(member) {
    setBusyId(member.id);
    setRestoreError("");
    try {
      await onRestore(member);
    } catch (e) {
      setRestoreError(e.message || "It was not put back.");
    } finally {
      setBusyId(null);
    }
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

      <div className="mb-4 sm:mb-6">
        <div className="flex items-start justify-between gap-2">
          <h2 className="flex items-start gap-2 text-xl sm:text-2xl font-bold min-w-0">
            <GroupTypeIcon icon={type?.icon} className="w-6 h-6 text-primary" align="first-line" />
            <span className="min-w-0">{title}</span>
            <CopyButton
              getText={() => recordCopyText({ title, description: group.description, id: group.id })}
              title="Copy for a Claude chat"
            />
          </h2>
          {group.archived || !onSetStatus ? (
            <div className="flex items-center gap-1.5 shrink-0">
              {group.archived && <ArchivedPill />}
              <StatusPill row={group} />
            </div>
          ) : (
            <StatusMenu row={group} onChoose={chooseStatus} blocked={runOpen ? { closed: CLOSE_BLOCKED } : {}} />
          )}
        </div>

        {/* Archived: say so where the eye lands (bug mvjx4363b4bn4gezrys). */}
        {group.archived && <ArchivedNotice noun={(type?.labelSingular || "group").toLowerCase()} />}

        <div className="mt-2">
          <RecordLinks
            context={context ? { name: context.name, onOpen: onViewContextDetail && (() => onViewContextDetail(context.id)) } : null}
          />
        </div>

        {/* Its own intention's date and reminders, as on intention detail (step 13). */}
        <p className="text-sm mt-2">
          <ScheduledLine actions={actions} />
        </p>
        <IntentionReminderLines
          intentId={ownIntention?.id || null}
          text={title}
          scheduled={reminders.scheduled}
          onChanged={reminders.reload}
          disabledReason={
            group.archived ? `This ${noun} is archived.` : closedTitle || (ownIntention ? null : "Schedule it first to add a reminder.")
          }
        />

        {statusBlocked && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {statusBlocked}
          </p>
        )}

        {/* An archived record offers Restore and nothing else (bug mvjx4363b4bn4gezrys).
            Otherwise, in the fixed order: Schedule/Reschedule, Edit, Close, Archive. */}
        <ActionBar
          actions={
            group.archived
              ? [restoreAction(onUnarchive)]
              : [
                  // Step 14: a menu (together type) cooks through Start Now; Continue while one is open.
                  together && onStartNow && {
                    key: "start",
                    pinned: true,
                    menu: null,
                    button: (
                      <button
                        onClick={() => (actions.open ? onOpenExecution?.(actions.open) : onStartNow(group.id))}
                        disabled={Boolean(closedTitle)}
                        className={`${ACTION_BUTTON} bg-success hover:bg-success-hover text-white disabled:opacity-50 disabled:cursor-not-allowed`}
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
                        onPick={(date) => onSchedule(group.id, date)}
                        disabled={Boolean(closedTitle || actions.moveBlocked)}
                        className={`${ACTION_BUTTON} bg-secondary hover:bg-secondary text-foreground`}
                      />
                    ),
                  },
                  // Step 14b: a menu not closed and not cooking now.
                  together && onLogMenu && !closedTitle && !actions.open && { key: "log", ...logAction(() => setLogging(true)) },
                  {
                    key: "edit",
                    menu: { label: "Edit", icon: Settings, onClick: onEdit },
                    button: (
                      <button onClick={onEdit} className={`${ACTION_BUTTON} bg-secondary hover:bg-secondary text-foreground`}>
                        <Settings className="w-4 h-4" />
                        Edit
                      </button>
                    ),
                  },
                  onCloseRecords && !closedTitle && { key: "close", ...closeAction(openClose, runOpen ? CLOSE_BLOCKED : null) },
                  {
                    key: "archive",
                    ...archiveAction(() => setConfirmArchive(true), runOpen ? "Cannot archive: active execution in progress" : null),
                  },
                ].filter(Boolean)
          }
        />
        {/* The disabled Schedule's reason, as visible text. */}
        {!group.archived && onSchedule && (closedTitle || actions.moveBlocked) && (
          <p className="mt-2 text-sm text-muted-foreground">{closedTitle || actions.moveBlocked}</p>
        )}
        {pending && (
          <StatusEventsSheet
            status={pending.status}
            event={liveEvents[0]}
            reminderCount={reminders.scheduled.length}
            onArchive={() => answerSheet(true)}
            onKeep={() => answerSheet(false)}
            onCancel={() => setPending(null)}
          />
        )}
        {closing && (
          <CloseDialog
            title={`Close "${title}"`}
            today={closing.today}
            defaultClosedOn={closing.defaultClosedOn}
            defaultReason={closing.defaultReason}
            pending={closing.loading ? null : closing}
            onConfirm={confirmClose}
            onCancel={() => setClosing(null)}
          />
        )}
      </div>

      {group.description && (
        <div className="mb-6">
          <p className="text-muted-foreground">{group.description}</p>
        </div>
      )}

      <section className="mb-6" aria-label="Members">
        <h3 className="text-lg font-medium mb-3">Members ({rows.length})</h3>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No {plural} yet. Add some with Edit.</p>
        ) : (
          <RowList rows={rows} events={events} executions={executions} contexts={contexts} allItems={items} allIntents={intents} {...rowListProps} />
        )}
      </section>

      {(recent.length > 0 || hasHistory) && (
        <section className="mb-6 pt-4 border-t border-border" aria-label="Recently removed">
          {recent.length > 0 && (
            <>
              <h3 className="text-base font-medium mb-2">Recently removed</h3>
              {restoreError && <p className="text-xs text-destructive mb-2">{restoreError}</p>}
              <div className="space-y-2">
                {recent.map(({ member, record, name }) => (
                  <div key={member.id} className="flex items-center gap-2 p-3 bg-card border border-border rounded-lg">
                    <ObjectIcon type={member.memberType} className="w-4 h-4 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{name}</p>
                      <p className="text-xs text-muted-foreground mt-1">{friendlyDate(member.removedAt)}</p>
                    </div>
                    {record && !record.archived && !group.archived && (
                      <button
                        type="button"
                        onClick={() => putBack(member)}
                        disabled={busyId !== null}
                        className="flex items-center gap-2 px-3 py-2 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm shrink-0 disabled:opacity-50"
                      >
                        <ArchiveRestore className="w-4 h-4" />
                        Put back
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
          {hasHistory && (
            <button
              type="button"
              onClick={onOpenHistory}
              className="flex items-center gap-2 mt-2 min-h-[44px] text-sm text-primary hover:text-primary-hover"
            >
              <Archive className="w-4 h-4" />
              View removal history
            </button>
          )}
        </section>
      )}

      <NoteTimeline notesState={notesState} archived={Boolean(group.archived)} sources={{ here: { type: "group", id: group.id }, onOpenExecution }} />

      {/* Executions on the group's own intention carry its group_id (migration 148). */}
      {ownIntention ? (
        // A menu lists each cook with its recipes' tally (step 14b).
        <RecentCompletions intentId={ownIntention.id} onOpenExecution={onOpenExecution} cooks={together} />
      ) : (
        <section className="mb-6" aria-label="Recent executions">
          <h3 className="text-lg font-medium mb-3">Recent executions</h3>
          <p className="text-sm text-muted-foreground">None yet</p>
        </section>
      )}

      {logging && (
        <LogMenuDialog
          recipes={liveMembers(group.id, lists).filter((m) => m.memberType === "item").map((m) => ({ id: m.record.id, name: m.name }))}
          onCancel={() => setLogging(false)}
          onLog={async (entry) => {
            const ok = await onLogMenu(group.id, entry);
            if (ok) setLogging(false);
            return ok;
          }}
        />
      )}

      {confirmArchive && (
        <ArchiveGroupDialog
          label={type?.labelSingular}
          onCancel={() => setConfirmArchive(false)}
          onConfirm={() => {
            setConfirmArchive(false);
            onArchive();
          }}
        />
      )}
    </div>
  );
}
