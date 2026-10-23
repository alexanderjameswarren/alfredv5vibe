import React, { useState, useEffect } from "react";
import EditCard from "../shared/EditCard";
import PinnedFooter from "../shared/PinnedFooter";
import AppSelect from "../apps/AppSelect";
import useApps from "../apps/useApps";
import { sortTypes } from "../groups/groupSave";

/**
 * A context as the form holds it. The initial state and the dirty check both read
 * this one function, so a field normalised in one place cannot read as dirty on open.
 */
export function contextFormValues(editing) {
  return {
    name: editing?.name || "",
    shared: editing?.shared || false,
    keywords: editing?.keywords || "",
    description: editing?.description || "",
    pinned: editing?.pinned || false,
    defaultCollectionId: editing?.defaultCollectionId || "",
    appId: editing?.appId || "",
    defaultGroupTypeId: editing?.defaultGroupTypeId || "",
  };
}

export default function ContextForm({
  editing, onSave, onCancel, onDirtyChange, stickyFooter = false, collections = [],
  // Edit form only: archive, and what stops it (contexts never cascade).
  onArchive = null, archiveBlockers = [],
  // Restructure P5: every group type (shared across contexts), for "Default group type".
  groupTypes = [],
}) {
  const initial = contextFormValues(editing);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const apps = useApps();
  const [name, setName] = useState(initial.name);
  const [shared, setShared] = useState(initial.shared);
  const [keywords, setKeywords] = useState(initial.keywords);
  const [description, setDescription] = useState(initial.description);
  const [pinned, setPinned] = useState(initial.pinned);
  const [defaultCollectionId, setDefaultCollectionId] = useState(initial.defaultCollectionId);
  const [appId, setAppId] = useState(initial.appId);
  const [defaultGroupTypeId, setDefaultGroupTypeId] = useState(initial.defaultGroupTypeId);

  useEffect(() => {
    if (!onDirtyChange) return;
    const current = { name, shared, keywords, description, pinned, defaultCollectionId, appId, defaultGroupTypeId };
    const base = contextFormValues(editing);
    const isDirty = Object.keys(base).some((k) => current[k] !== base[k]);
    onDirtyChange(isDirty, "this context");
  }, [name, shared, keywords, description, pinned, defaultCollectionId, appId, defaultGroupTypeId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => { if (onDirtyChange) onDirtyChange(false); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <EditCard className="mb-4 sm:mb-6">
      <h3 className="font-medium text-lg mb-4">
        {editing ? "Edit Context" : "New Context"}
      </h3>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Context name"
            className="w-full px-3 py-2 border border-border rounded text-base"
            autoFocus
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            Keywords
          </label>
          <input
            type="text"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="Keywords (comma separated)"
            className="w-full px-3 py-2 border border-border rounded text-base"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description"
            rows={3}
            className="w-full px-3 py-2 border border-border rounded text-base"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            Default collection
          </label>
          {/* Every non-archived collection, deliberately unfiltered by context.
              A default collection names where this context's items GO, which is
              normally a *different* context: a recipe lives in Recipes and its
              ingredients belong in Shopping alongside the other products. An
              earlier same-context filter here broke the feature's own driving
              case, because Recipes could not point at Groceries. */}
          <select
            value={defaultCollectionId}
            onChange={(e) => setDefaultCollectionId(e.target.value)}
            className="w-full px-3 py-2 min-h-[44px] border border-border rounded text-base"
          >
            <option value="">None</option>
            {(collections || [])
              .filter((c) => !c.archived)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
          <p className="text-xs text-muted-foreground mt-1">
            Preselected when adding an item's ingredients to a collection.
          </p>
        </div>

        <AppSelect id="context-app" apps={apps} value={appId} onChange={setAppId} />

        {/* Restructure P5: names the context page's create button ("Create Menu"). */}
        {editing && (
          <div>
            <label htmlFor="context-default-group-type" className="block text-sm font-medium text-foreground mb-1">
              Default group type
            </label>
            <select
              id="context-default-group-type"
              value={defaultGroupTypeId}
              onChange={(e) => setDefaultGroupTypeId(e.target.value)}
              className="w-full px-3 py-2 min-h-[44px] border border-border rounded text-base"
            >
              <option value="">None</option>
              {sortTypes(groupTypes).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.labelSingular}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              Names the create button on this context's page. None shows "Add Group".
            </p>
          </div>
        )}

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={shared}
            onChange={(e) => setShared(e.target.checked)}
            className="rounded accent-primary"
          />
          <span className="text-sm">Share this context</span>
        </label>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={pinned}
            onChange={(e) => setPinned(e.target.checked)}
            className="rounded accent-primary"
          />
          <span className="text-sm">Pin to home</span>
        </label>

        {/* Everything about how this footer sits — the sticky offset, the inset
            that makes it finish on the card's border when it releases, and equal
            space above and below the buttons — belongs to PinnedFooter. All six of
            Alfred's pinned footers share it, which is the point: this took three
            rounds to get right and the third round fixed only one of the six. */}
        <PinnedFooter pinned={stickyFooter} unpinnedClassName="pt-2">
          <button
            onClick={() => {
              if (name.trim()) {
                if (onDirtyChange) onDirtyChange(false);
                onSave(name, shared, keywords, description, pinned, defaultCollectionId, appId, defaultGroupTypeId);
              }
            }}
            className="px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
          >
            Save
          </button>
          <button
            onClick={() => { if (onDirtyChange) onDirtyChange(false); onCancel(); }}
            className="px-4 py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
          >
            Cancel
          </button>
        </PinnedFooter>

        {/* Restructure P4: Archive lives here, below a divider, as on the
            collection edit form. Only when nothing is left in the context. */}
        {editing && onArchive && (
          <div className="pt-4 border-t border-border">
            {archiveBlockers.length > 0 && (
              <p className="text-sm text-muted-foreground mb-2">
                Cannot archive: still holds {archiveBlockers.join(", ")}.
              </p>
            )}
            <button
              type="button"
              onClick={() => setConfirmArchive(true)}
              disabled={archiveBlockers.length > 0}
              className="px-4 py-2.5 min-h-[44px] border-2 border-destructive text-destructive hover:bg-destructive/10 rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Archive Context
            </button>
          </div>
        )}
      </div>
      {confirmArchive && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={() => setConfirmArchive(false)}>
          <div
            role="dialog"
            aria-label="Archive context"
            className="bg-background border border-border rounded-lg shadow-xl p-5 w-full max-w-sm mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm mb-4">Archive this context?</p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => {
                  setConfirmArchive(false);
                  if (onDirtyChange) onDirtyChange(false);
                  onArchive();
                }}
                className="px-4 py-2 min-h-[44px] text-sm border-2 border-destructive text-destructive hover:bg-destructive/10 rounded-lg"
              >
                Archive
              </button>
              <button
                type="button"
                onClick={() => setConfirmArchive(false)}
                className="px-4 py-2 min-h-[44px] text-sm text-muted-foreground rounded-lg hover:bg-muted"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </EditCard>
  );
}
