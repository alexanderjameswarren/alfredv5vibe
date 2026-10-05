import React, { useState, useEffect } from "react";
import EditCard from "../shared/EditCard";
import PinnedFooter from "../shared/PinnedFooter";

export default function ContextForm({ editing, onSave, onCancel, onDirtyChange, stickyFooter = false, collections = [] }) {
  const [name, setName] = useState(editing?.name || "");
  const [shared, setShared] = useState(editing?.shared || false);
  const [keywords, setKeywords] = useState(editing?.keywords || "");
  const [description, setDescription] = useState(editing?.description || "");
  const [pinned, setPinned] = useState(editing?.pinned || false);
  const [defaultCollectionId, setDefaultCollectionId] = useState(
    editing?.defaultCollectionId || "",
  );

  useEffect(() => {
    if (!onDirtyChange) return;
    const isDirty =
      name !== (editing?.name || "") ||
      shared !== (editing?.shared || false) ||
      keywords !== (editing?.keywords || "") ||
      description !== (editing?.description || "") ||
      pinned !== (editing?.pinned || false) ||
      defaultCollectionId !== (editing?.defaultCollectionId || "");
    onDirtyChange(isDirty, "this context");
  }, [name, shared, keywords, description, pinned, defaultCollectionId]); // eslint-disable-line react-hooks/exhaustive-deps

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
                onSave(name, shared, keywords, description, pinned, defaultCollectionId);
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
      </div>
    </EditCard>
  );
}
