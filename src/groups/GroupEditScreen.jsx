import React, { useRef, useState } from "react";
import { Archive, ArrowLeft, GripVertical, Plus, X } from "lucide-react";
import EditCard from "../shared/EditCard";
import PinnedFooter from "../shared/PinnedFooter";
import ObjectIcon, { GroupTypeIcon } from "../shared/ObjectIcon";
import ArchiveGroupDialog from "./ArchiveGroupDialog";
import { useDragReorder } from "../shared/useDragReorder";
import { derivedGroupName, liveMembers, removedMembers } from "./groupModel";
import { defaultTypeId } from "./groupSave";
import MemberPicker, { memberKey } from "./MemberPicker";

const DRAFT_ID = "__draft__";

// The draft's members as member rows, so groupModel can name and order them.
const asMembers = (drafts) =>
  drafts.map((d, i) => ({ id: d.id || memberKey(d.memberType, d.memberId), groupId: DRAFT_ID, ...d, position: i + 1 }));

/**
 * The group create/edit page (Restructure P5). Laid out as the collection edit
 * page, with ContextForm's Save/Cancel footer, because nothing is written until
 * Save: a new group and its members are created together.
 */
export default function GroupEditScreen({
  group,
  initialContextId,
  groupTypes,
  contexts,
  items,
  intents,
  groupMembers,
  onSave,
  onCancel,
  onArchive,
  onOpenHistory,
  onDirtyChange,
}) {
  const editing = Boolean(group);
  const [name, setName] = useState(group?.name || "");
  const [contextId, setContextId] = useState(group ? group.contextId || "" : initialContextId || "");
  const [groupTypeId, setGroupTypeId] = useState(
    group?.groupTypeId || defaultTypeId(initialContextId, { contexts, groupTypes }) || "",
  );
  const [typeChosen, setTypeChosen] = useState(editing);
  const [description, setDescription] = useState(group?.description || "");
  const [pinned, setPinned] = useState(Boolean(group?.pinned));
  // Live members in order, then any whose record is gone or archived: hidden
  // here, but kept, so an item restored later is still in its group.
  const [members, setMembers] = useState(() => {
    if (!group) return [];
    const own = groupMembers.filter((m) => m.groupId === group.id && !m.removedAt);
    const live = liveMembers(group.id, { members: own, items, intents }).map((x) => x.member);
    const hidden = own.filter((m) => !live.includes(m)).sort((a, b) => a.position - b.position);
    return [...live, ...hidden].map((m) => ({ id: m.id, memberType: m.memberType, memberId: m.memberId }));
  });
  const [adding, setAdding] = useState(!editing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const type = groupTypes.find((t) => t.id === groupTypeId);
  const label = type?.labelSingular || "Group";
  const dirtyRef = useRef(false);
  const markDirty = () => {
    dirtyRef.current = true;
    if (onDirtyChange) onDirtyChange(true, `this ${label.toLowerCase()}`);
  };
  const removedCount = group ? removedMembers(group.id, { members: groupMembers, items, intents }).length : 0;
  function openHistory() {
    if (dirtyRef.current && !window.confirm(`You have unsaved changes to this ${label.toLowerCase()}. Discard them?`)) return;
    dirtyRef.current = false;
    if (onDirtyChange) onDirtyChange(false);
    onOpenHistory();
  }
  const dirty = (fn) => (...args) => {
    markDirty();
    fn(...args);
  };
  // Positions are written on Save, so a drop only marks the page dirty.
  const { dragIdx, rowProps } = useDragReorder(setMembers, markDirty);

  const lists = { members: asMembers(members), items, intents };
  const shown = liveMembers(DRAFT_ID, lists);
  const derived = derivedGroupName(DRAFT_ID, lists);
  const excluded = new Set(members.map((m) => memberKey(m.memberType, m.memberId)));
  const contextName = (id) => contexts.find((c) => c.id === id)?.name;

  async function save() {
    if (!groupTypeId) {
      setError("Pick a type first.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave({ name, groupTypeId, contextId: contextId || null, description, pinned, members });
      dirtyRef.current = false;
      if (onDirtyChange) onDirtyChange(false);
    } catch (e) {
      setError(e.message || "Not saved.");
      setSaving(false);
    }
  }

  return (
    <div>
      <button
        onClick={onCancel}
        className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <EditCard className="mb-4 sm:mb-6">
        <h2 className="flex items-center gap-2 font-medium text-lg mb-4">
          <GroupTypeIcon icon={type?.icon} className="w-5 h-5" />
          {editing ? `Edit ${label}` : `New ${label}`}
        </h2>

        <div className="space-y-4">
          <div>
            <label htmlFor="group-name" className="block text-sm font-medium text-foreground mb-1">Name</label>
            <input
              id="group-name"
              type="text"
              value={name}
              onChange={dirty((e) => setName(e.target.value))}
              placeholder={derived || "Named from its members"}
              className="w-full px-3 py-2 border border-border rounded text-base"
            />
            <p className="text-xs text-muted-foreground mt-1">Leave empty to name it from its members.</p>
          </div>

          <div>
            <label htmlFor="group-type" className="block text-sm font-medium text-foreground mb-1">Type</label>
            <select
              id="group-type"
              value={groupTypeId}
              onChange={dirty((e) => {
                setGroupTypeId(e.target.value);
                setTypeChosen(true);
              })}
              className="w-full px-3 py-2 min-h-[44px] border border-border rounded text-base"
            >
              {!groupTypeId && <option value="">Pick a type</option>}
              {groupTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.labelSingular}
                  {contextName(t.contextId) ? ` (${contextName(t.contextId)})` : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="group-context" className="block text-sm font-medium text-foreground mb-1">Context</label>
            <select
              id="group-context"
              value={contextId}
              onChange={dirty((e) => {
                const next = e.target.value;
                setContextId(next);
                if (!typeChosen) setGroupTypeId(defaultTypeId(next, { contexts, groupTypes }) || "");
              })}
              className="w-full px-3 py-2 min-h-[44px] border border-border rounded text-base"
            >
              <option value="">No context</option>
              {contexts
                .filter((c) => !c.archived || c.id === contextId)
                .map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
            </select>
          </div>

          <div>
            <label htmlFor="group-description" className="block text-sm font-medium text-foreground mb-1">Description</label>
            <textarea
              id="group-description"
              value={description}
              onChange={dirty((e) => setDescription(e.target.value))}
              rows={3}
              className="w-full px-3 py-2 border border-border rounded text-base"
            />
          </div>

          <label className="flex items-center gap-2 min-h-[44px]">
            <input
              type="checkbox"
              checked={pinned}
              onChange={dirty((e) => setPinned(e.target.checked))}
              className="rounded accent-primary"
            />
            <span className="text-sm">Pin to home</span>
          </label>

          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-base font-medium">Members ({shown.length})</h3>
              <button
                type="button"
                onClick={() => setAdding((v) => !v)}
                className="flex items-center gap-2 px-3 py-2 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm"
              >
                {!adding && <Plus className="w-4 h-4" />}
                {adding ? "Done adding" : "Add Members"}
              </button>
            </div>

            {shown.length === 0 ? (
              <p className="text-muted-foreground text-sm py-4 text-center">No members yet</p>
            ) : (
              <div className="space-y-2">
                {shown.map((entry) => {
                  const index = members.findIndex(
                    (d) => d.memberType === entry.memberType && d.memberId === entry.record.id,
                  );
                  const otherContext =
                    entry.record.contextId && entry.record.contextId !== contextId
                      ? contextName(entry.record.contextId)
                      : null;
                  return (
                    <div
                      key={memberKey(entry.memberType, entry.record.id)}
                      className={`p-3 bg-card border border-border rounded-lg ${dragIdx === index ? "opacity-50" : ""}`}
                      {...rowProps(index)}
                    >
                      <div className="flex items-center gap-2">
                        <GripVertical className="w-4 h-4 text-muted-foreground cursor-move flex-shrink-0" title="Drag to reorder" />
                        <ObjectIcon type={entry.memberType} className="w-4 h-4 text-muted-foreground" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">{entry.name || "Untitled"}</p>
                          {otherContext && (
                            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                              <ObjectIcon type="context" className="w-3 h-3" />
                              {otherContext}
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={dirty(() => setMembers((prev) => prev.filter((_, i) => i !== index)))}
                          aria-label={`Remove ${entry.name}`}
                          className="p-1 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-destructive"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {adding && (
              <MemberPicker
                items={items}
                intents={intents}
                contexts={contexts}
                contextId={contextId || null}
                excluded={excluded}
                onAdd={dirty((memberType, memberId) => setMembers((prev) => [...prev, { memberType, memberId }]))}
              />
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <PinnedFooter unpinnedClassName="pt-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
            >
              Cancel
            </button>
          </PinnedFooter>

          {/* As the collection page: the history is reachable once something was removed. */}
          {editing && onOpenHistory && removedCount > 0 && (
            <button
              type="button"
              onClick={openHistory}
              className="flex items-center gap-2 min-h-[44px] text-sm text-primary hover:text-primary-hover"
            >
              <Archive className="w-4 h-4" />
              View removal history
            </button>
          )}

          {editing && onArchive && (
            <div className="pt-4 border-t border-border">
              <button
                type="button"
                onClick={() => setConfirmArchive(true)}
                className="px-4 py-2.5 min-h-[44px] border-2 border-destructive text-destructive hover:bg-destructive/10 rounded-lg text-sm transition-colors"
              >
                Archive {label}
              </button>
            </div>
          )}
        </div>
      </EditCard>

      {confirmArchive && (
        <ArchiveGroupDialog
          label={label}
          onCancel={() => setConfirmArchive(false)}
          onConfirm={() => {
            setConfirmArchive(false);
            if (onDirtyChange) onDirtyChange(false);
            onArchive();
          }}
        />
      )}
    </div>
  );
}
