import React, { useState } from "react";
import { ArchiveRestore, ArrowLeft } from "lucide-react";
import ObjectIcon from "../shared/ObjectIcon";
import { friendlyDate } from "../inbox/CaptureMeta";
import { removedMembers } from "./groupModel";

/**
 * A group's member removal history, newest first, laid out as the collection
 * page's: each removal with its date, and Put back, which adds the member again
 * at the end (as a collection's does) and keeps the removal listed. A removal
 * whose member is live again reads "in the group again", with no Put back.
 */
// `archived`: the group is archived, so nothing on it is changed here (bug mvjx4363b4bn4gezrys).
export default function GroupHistoryScreen({ groupName, groupId, groupMembers, items, intents, onBack, onRestore, archived = false }) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  const history = removedMembers(groupId, { members: groupMembers, items, intents });
  const live = new Set(
    groupMembers.filter((m) => m.groupId === groupId && !m.removedAt).map((m) => `${m.memberType}:${m.memberId}`),
  );

  async function putBack(member) {
    setBusyId(member.id);
    setError("");
    try {
      await onRestore(member);
    } catch (e) {
      setError(e.message || "It was not put back.");
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

      <h2 className="text-lg font-medium mb-1">Removal history</h2>
      <p className="text-sm text-muted-foreground mb-3">{groupName} — newest first</p>

      {error && <p className="text-xs text-destructive mb-2">{error}</p>}

      {history.length === 0 ? (
        <p className="text-muted-foreground text-sm py-4 text-center">Nothing has been removed from this group.</p>
      ) : (
        <div className="space-y-2">
          {history.map(({ member, record, name }) => {
            const already = live.has(`${member.memberType}:${member.memberId}`);
            return (
              <div key={member.id} className="flex items-center gap-2 p-3 bg-card border border-border rounded-lg">
                <ObjectIcon type={member.memberType} className="w-4 h-4 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{name}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {friendlyDate(member.removedAt)}
                    {already ? " · in the group again" : ""}
                  </p>
                </div>
                {record && !record.archived && !already && !archived && (
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
            );
          })}
        </div>
      )}
    </div>
  );
}
