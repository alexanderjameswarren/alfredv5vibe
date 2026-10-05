import React, { useState } from "react";
import { ArrowLeft, Plus } from "lucide-react";
import { matchesQuery } from "../utils/search";
import PinnedFooter from "../shared/PinnedFooter";

export default function CollectionAddItems({ availableItems, contexts, onAdd, onCancel, maxItems, collection, onCreateItem }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState({});

  const filtered = availableItems.filter((item) =>
    matchesQuery(search, item.name, ...(Array.isArray(item.tags) ? item.tags : [])),
  );

  function toggleItem(itemId) {
    setSelected((prev) => {
      if (prev[itemId]) {
        const next = { ...prev };
        delete next[itemId];
        return next;
      }
      if (Object.keys(prev).length >= maxItems) return prev;
      return { ...prev, [itemId]: { itemId, quantity: "" } };
    });
  }

  function setQuantity(itemId, quantity) {
    setSelected((prev) => ({
      ...prev,
      [itemId]: { ...prev[itemId], quantity },
    }));
  }

  return (
    <div>
      <button
        onClick={onCancel}
        className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Collection
      </button>

      <h2 className="text-lg font-medium mb-3">Add Items to Collection</h2>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search items by name or tag..."
        className="w-full px-3 py-2 border border-border rounded-lg text-base mb-3"
        autoFocus
      />

      <div className="space-y-2 mb-4" style={{ maxHeight: "50vh", overflowY: "auto" }}>
        {filtered.length === 0 && search.trim() ? (
          <div className="py-2">
            <button
              onClick={() => onCreateItem(search.trim())}
              className="w-full flex items-center gap-3 px-4 py-3 border-2 border-dashed border-primary rounded-lg hover:bg-primary/5 transition-colors"
            >
              <Plus className="w-5 h-5 text-primary flex-shrink-0" />
              <div className="text-left flex-1 min-w-0">
                <div className="font-medium text-primary">Create "{search.trim()}"</div>
                <div className="text-sm text-muted-foreground">
                  Add as new item{collection?.contextId && contexts ? ` in ${contexts.find(c => c.id === collection.contextId)?.name || 'this context'}` : ''}
                </div>
              </div>
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-muted-foreground text-sm py-4 text-center">No matching items</p>
        ) : (
          filtered.map((item) => {
            const isSelected = !!selected[item.id];
            const contextName = item.contextId && contexts
              ? contexts.find((c) => c.id === item.contextId)?.name
              : null;
            return (
              <div
                key={item.id}
                className={`flex items-center gap-2 p-3 border rounded cursor-pointer ${
                  isSelected ? "border-primary bg-background" : "border-border bg-white hover:border-primary"
                }`}
                onClick={() => toggleItem(item.id)}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  className="rounded accent-primary pointer-events-none"
                />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{item.name}</p>
                  {contextName && (
                    <span className="text-xs text-muted-foreground">{contextName}</span>
                  )}
                </div>
                {isSelected && (
                  <input
                    type="text"
                    value={selected[item.id]?.quantity || ""}
                    onChange={(e) => {
                      e.stopPropagation();
                      setQuantity(item.id, e.target.value);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    placeholder="Qty"
                    className="w-20 sm:w-24 px-2 py-2 border border-border rounded text-base"
                  />
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Same offsets as ContextForm's. Note this one will rarely engage: the
          item list above is capped at 50vh with its own scrollbar, so the page
          as a whole does not usually exceed the viewport. It is here for the
          cases that do — a very short window, or if that cap is ever lifted —
          rather than because it changes anything today. */}
      <PinnedFooter className="bg-background">
        <button
          onClick={() => onAdd(Object.values(selected))}
          disabled={Object.keys(selected).length === 0}
          className="px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm disabled:opacity-50 text-sm"
        >
          Add {Object.keys(selected).length > 0 ? `(${Object.keys(selected).length})` : ""} to Collection
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg text-sm"
        >
          Cancel
        </button>
      </PinnedFooter>
    </div>
  );
}
