import React, { useState } from "react";
import { Archive, ArchiveRestore, ArrowLeft, Settings } from "lucide-react";
import ObjectIcon, { GroupTypeIcon } from "../shared/ObjectIcon";
import CopyButton from "../shared/CopyButton";
import { recordCopyText } from "../shared/copyRecord";
import StatusPill from "../shared/StatusPill";
import { ArchivedNotice, ArchivedPill, restoreAction } from "../shared/archivedRecord";
import RecordLinks from "../shared/RecordLinks";
import ActionBar, { archiveAction } from "../shared/ActionBar";
import { ACTION_BUTTON } from "../shared/actionButton";
import RowList from "../shared/RowList";
import NoteTimeline from "../notes/NoteTimeline";
import RecentCompletions from "../notes/RecentCompletions";
import { useRecordNotes } from "../notes/useRecordNotes";
import { friendlyDate } from "../inbox/CaptureMeta";
import { groupIntention, groupTypeOf, removedMembers } from "./groupModel";
import { groupTitle, memberRows, recentRemovals } from "./groupDetail";
import ArchiveGroupDialog from "./ArchiveGroupDialog";

/**
 * The group detail page (Restructure P5 step 10), laid out as item and
 * intention detail: header (type icon, name, Copy, status, record links),
 * actions (Edit, Archive for now), members as standard rows, Recently removed,
 * Notes, Recent executions. Status is display-only until step 13.
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
  rowListProps,
}) {
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [restoreError, setRestoreError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const notesState = useRecordNotes({ target: { type: "group", id: group.id }, groupIds: [group.id] });

  const lists = { members: groupMembers, items, intents };
  const type = groupTypeOf(group, groupTypes);
  const title = groupTitle(group, lists, type);
  const context = contexts.find((c) => c.id === group.contextId);
  const rows = memberRows(group.id, { ...lists, events, openExecutions: executions });
  const recent = recentRemovals(group.id, lists);
  const hasHistory = removedMembers(group.id, lists).length > 0;
  const ownIntention = groupIntention(group.id, intents);
  const plural = (type?.labelPlural || "members").toLowerCase();

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
          <div className="flex items-center gap-1.5 shrink-0">
            {group.archived && <ArchivedPill />}
            <StatusPill row={group} />
          </div>
        </div>

        {/* Archived: say so where the eye lands (bug mvjx4363b4bn4gezrys). */}
        {group.archived && <ArchivedNotice noun={(type?.labelSingular || "group").toLowerCase()} />}

        <div className="mt-2">
          <RecordLinks
            context={context ? { name: context.name, onOpen: onViewContextDetail && (() => onViewContextDetail(context.id)) } : null}
          />
        </div>

        {/* An archived record offers Restore and nothing else (bug mvjx4363b4bn4gezrys). */}
        <ActionBar
          actions={
            group.archived
              ? [restoreAction(onUnarchive)]
              : [
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
                  { key: "archive", ...archiveAction(() => setConfirmArchive(true)) },
                ]
          }
        />
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
        <RecentCompletions intentId={ownIntention.id} onOpenExecution={onOpenExecution} />
      ) : (
        <section className="mb-6" aria-label="Recent executions">
          <h3 className="text-lg font-medium mb-3">Recent executions</h3>
          <p className="text-sm text-muted-foreground">None yet</p>
        </section>
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
