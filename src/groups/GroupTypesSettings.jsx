import React, { useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Settings, Trash2 } from "lucide-react";
import EditCard from "../shared/EditCard";
import PinnedFooter from "../shared/PinnedFooter";
import CancelButton from "../shared/CancelButton";
import { GroupTypeIcon, GROUP_TYPE_ICONS } from "../shared/ObjectIcon";
import { storage } from "../utils/storage";
import { uid } from "../utils/flattenElements";
import { sortTypes } from "./groupSave";
import { EXECUTION_MODES, groupsUsingType, modeLabel, typeDraft, typeProblem, typeRow, TYPE_ICON_CHOICES } from "./groupTypes";

const upsert = (prev, row) => [...prev.filter((r) => r.id !== row.id), row];

/**
 * Settings: group types (Restructure P5). A list; Add and Edit in the shared edit
 * card; Delete only for a type no group uses, behind a confirm. Types are shared
 * across contexts, so this is the one place they are managed.
 */
export default function GroupTypesSettings({ groupTypes = [], itemGroups = [], setGroupTypes, writer = storage, newId = uid }) {
  const [editing, setEditing] = useState(null); // null | "new" | a type
  const [draft, setDraft] = useState(typeDraft());
  const [problem, setProblem] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);

  function open(type) {
    setEditing(type || "new");
    setDraft(typeDraft(type));
    setProblem("");
  }

  async function save() {
    const editingId = editing === "new" ? null : editing.id;
    const found = typeProblem(draft, groupTypes, editingId);
    if (found) {
      setProblem(found);
      return;
    }
    setSaving(true);
    const id = editingId || newId();
    const saved = await writer.set(`group_type:${id}`, { id, ...typeRow(draft) });
    setSaving(false);
    if (!saved) {
      setProblem("It was not saved. Try again.");
      return;
    }
    setGroupTypes?.((prev) => upsert(prev, saved));
    setEditing(null);
  }

  async function remove(type) {
    setDeleting(null);
    if (!(await writer.delete(`group_type:${type.id}`))) {
      setProblem(`${type.labelSingular} was not deleted.`);
      return;
    }
    setGroupTypes?.((prev) => prev.filter((t) => t.id !== type.id));
  }

  return (
    <section className="mt-4 p-4 sm:p-6 bg-card border border-border rounded-lg" aria-label="Group types">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-base sm:text-lg font-medium">Group types</h3>
        {!editing && (
          <button
            type="button"
            onClick={() => open(null)}
            className="flex items-center gap-2 px-3 py-2 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm text-sm"
          >
            <Plus className="w-4 h-4" />
            Add
          </button>
        )}
      </div>

      {editing ? (
        <EditCard>
          <h4 className="font-medium text-lg mb-4">{editing === "new" ? "New group type" : `Edit ${editing.labelSingular}`}</h4>
          <div className="space-y-4">
            <div>
              <label htmlFor="type-singular" className="block text-sm font-medium text-foreground mb-1">Name</label>
              <input
                id="type-singular"
                value={draft.labelSingular}
                onChange={(e) => setDraft({ ...draft, labelSingular: e.target.value })}
                placeholder="Menu"
                className="w-full px-3 py-2 border border-border rounded text-base"
              />
            </div>
            <div>
              <label htmlFor="type-plural" className="block text-sm font-medium text-foreground mb-1">Plural</label>
              <input
                id="type-plural"
                value={draft.labelPlural}
                onChange={(e) => setDraft({ ...draft, labelPlural: e.target.value })}
                placeholder="Menus"
                className="w-full px-3 py-2 border border-border rounded text-base"
              />
            </div>
            <fieldset>
              <legend className="block text-sm font-medium text-foreground mb-1">Icon</legend>
              <div className="flex flex-wrap gap-2">
                {TYPE_ICON_CHOICES.map((name) => {
                  const Glyph = GROUP_TYPE_ICONS[name];
                  const on = draft.icon === name;
                  return (
                    <button
                      key={name}
                      type="button"
                      aria-label={name}
                      aria-pressed={on}
                      onClick={() => setDraft({ ...draft, icon: name })}
                      className={`min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg border-2 ${
                        on ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"
                      }`}
                    >
                      <Glyph className="w-5 h-5" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <fieldset>
              <legend className="block text-sm font-medium text-foreground mb-1">How it is worked</legend>
              <div className="space-y-1">
                {EXECUTION_MODES.map((m) => (
                  <label key={m.value} className="flex items-center gap-2 min-h-[44px]">
                    <input
                      type="radio"
                      name="type-mode"
                      value={m.value}
                      checked={draft.executionMode === m.value}
                      onChange={() => setDraft({ ...draft, executionMode: m.value })}
                      className="accent-primary"
                    />
                    <span className="text-sm">{m.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {problem && <p className="text-sm text-destructive">{problem}</p>}
            <PinnedFooter pinned={false} unpinnedClassName="pt-2">
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
                onClick={() => setEditing(null)}
                className="px-4 py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
              >
                Cancel
              </button>
            </PinnedFooter>
          </div>
        </EditCard>
      ) : (
        <>
          {problem && <p className="text-sm text-destructive mb-2">{problem}</p>}
          {groupTypes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No group types yet</p>
          ) : (
            <ul className="space-y-2">
              {sortTypes(groupTypes).map((t) => {
                const used = groupsUsingType(t.id, itemGroups);
                return (
                  <li key={t.id} className="flex items-center gap-2 p-3 bg-background border border-border rounded-lg">
                    <GroupTypeIcon icon={t.icon} className="w-5 h-5 text-primary" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm">
                        {t.labelSingular} <span className="text-muted-foreground font-normal">/ {t.labelPlural}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {modeLabel(t.executionMode)} · {used === 0 ? "not used" : `${used} group${used === 1 ? "" : "s"}`}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => open(t)}
                      aria-label={`Edit ${t.labelSingular}`}
                      className="p-1 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-primary"
                    >
                      <Settings className="w-4 h-4" />
                    </button>
                    {used === 0 && (
                      <button
                        type="button"
                        onClick={() => setDeleting(t)}
                        aria-label={`Delete ${t.labelSingular}`}
                        className="p-1 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {deleting &&
        createPortal(
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={() => setDeleting(null)}>
            <div
              role="dialog"
              aria-label="Delete group type"
              className="bg-background border border-border rounded-lg shadow-xl p-5 w-full max-w-sm mx-4"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold mb-3">Delete {deleting.labelSingular}?</h3>
              <p className="text-sm">No group uses it. This cannot be undone.</p>
              <div className="flex gap-2 mt-4">
                <button
                  type="button"
                  onClick={() => remove(deleting)}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] border-2 border-destructive text-destructive hover:bg-destructive/10 rounded-lg text-sm"
                >
                  <Trash2 className="w-4 h-4" aria-hidden="true" />
                  Delete
                </button>
                <CancelButton onClick={() => setDeleting(null)} />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </section>
  );
}
