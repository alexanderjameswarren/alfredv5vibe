import React, { useState, useEffect, useMemo } from "react";
import { ArrowLeft, Plus, X } from "lucide-react";
import {
  parseIngredient,
  matchProduct,
  findNearMisses,
} from "../utils/ingredientMatch";
import PinnedFooter from "../shared/PinnedFooter";
import ItemPicker from "../shared/ItemPicker";

/**
 * Add to Collection — resolve an item's collectable elements to items in a
 * target collection's context, and pick which to add.
 *
 * Step 6 is read-only: it resolves, displays and lets the user adjust, but
 * writes nothing. The footer is inert.
 *
 * Measured on the real corpus, 55% of rows resolve to nothing and must create a
 * new item, so create-new is the common path and costs exactly one tap: the row
 * checkbox itself commits to it. There is no dialog and no detour. Rows that
 * failed to match but have plausible alternatives show them as chips, each of
 * which retargets and checks the row in one tap — that is what stops the
 * Shopping context growing "Salt", "kosher salt" and "Sea salt" separately.
 */
export default function ItemAddToCollection({ item, items, collections, contexts, onBack, onAdd }) {
  const available = useMemo(
    () => (collections || []).filter((c) => !c.archived),
    [collections],
  );

  // Preselect: the item context's default collection, then a capture target in
  // that context, then any capture target, then the first collection.
  //
  // The third rule is not in the spec. Without it the driving case never fires:
  // Groceries is the capture target but lives in Shopping, while recipes live
  // in Recipes, so rule two cannot match and an arbitrary "first collection"
  // wins. Preferring a capture target anywhere over an arbitrary one is
  // strictly better; flagged for review.
  const defaultCollectionId = useMemo(() => {
    const ctx = (contexts || []).find((c) => c.id === item.contextId);
    const pinned =
      ctx && ctx.defaultCollectionId
        ? available.find((c) => c.id === ctx.defaultCollectionId)
        : null;
    if (pinned) return pinned.id;
    const captureHere = available.find(
      (c) => c.isCaptureTarget && c.contextId === item.contextId,
    );
    if (captureHere) return captureHere.id;
    const captureAnywhere = available.find((c) => c.isCaptureTarget);
    if (captureAnywhere) return captureAnywhere.id;
    return available[0] ? available[0].id : "";
  }, [available, contexts, item.contextId]);

  const [collectionId, setCollectionId] = useState(defaultCollectionId);
  const [overrides, setOverrides] = useState({});
  const [pickerRow, setPickerRow] = useState(null);
  const [pickerSearch, setPickerSearch] = useState("");

  const collection = available.find((c) => c.id === collectionId) || null;
  const targetContextId = collection ? collection.contextId ?? null : null;

  // Targets are context-specific, so a change of collection invalidates every
  // resolved row. Reset rather than carry stale targets across.
  useEffect(() => {
    setOverrides({});
  }, [collectionId]);

  /**
   * Resolve once per (item, collection). Ordering is computed here and frozen:
   * unmatched first, then matched in recipe order. It deliberately does not
   * depend on `overrides`, because re-sorting as the user accepts a suggestion
   * would move rows out from under a thumb mid-tap.
   */
  const rows = useMemo(() => {
    const elements = Array.isArray(item.elements) ? item.elements : [];
    const typeOf = (el) => el.displayType || el.display_type || "step";
    // Carry the index into item.elements, not into the filtered list: Step 7
    // stamps collectable/collectableItemId back onto the original array.
    const indexed = elements.map((el, idx) => ({ el, idx }));
    const flagged = indexed.filter(({ el }) => el.collectable === true);
    // Fallback: an un-annotated item still works, on its bullets.
    const source = flagged.length
      ? flagged
      : indexed.filter(({ el }) => typeOf(el) === "bullet");

    const resolved = source.map(({ el, idx }) => {
      const text = el.name || "";
      const { quantity, product } = parseIngredient(text);
      const pinnedId = el.collectableItemId || el.collectable_item_id || null;
      // Already resolved on a previous visit: skip matching entirely.
      const pinned = pinnedId
        ? (items || []).find((i) => i.id === pinnedId && !i.archived)
        : null;
      const match =
        pinned ||
        matchProduct(product, items || [], { contextId: targetContextId });
      const near = match
        ? []
        : findNearMisses(product, items || [], { contextId: targetContextId });
      return { key: `${idx}-${text}`, elementIndex: idx, text, quantity, product, match, near };
    });

    const unmatched = resolved.filter((r) => !r.match);
    const matched = resolved.filter((r) => r.match);
    return [...unmatched, ...matched];
  }, [item.elements, items, targetContextId]);

  const stateFor = (row) => {
    const o = overrides[row.key] || {};
    return {
      checked: o.checked === true,
      quantity: o.quantity !== undefined ? o.quantity : row.quantity,
      targetId:
        o.targetId !== undefined ? o.targetId : row.match ? row.match.id : null,
    };
  };

  const patch = (key, next) =>
    setOverrides((prev) => ({ ...prev, [key]: { ...prev[key], ...next } }));

  const selectedCount = rows.filter((r) => stateFor(r).checked).length;

  const [busy, setBusy] = useState(false);

  // "Existing" means the row currently resolves to an item that already lives
  // in the target context — either matched automatically or via an accepted
  // suggestion. Deliberately NOT create-new rows: each of those mints a new
  // item in the catalogue, and fifteen uninspected new items in one tap is how
  // a shopping catalogue fills with junk. Creating stays one deliberate tap.
  const existingRows = rows.filter((r) => stateFor(r).targetId);
  const allExistingSelected =
    existingRows.length > 0 && existingRows.every((r) => stateFor(r).checked);

  function selectExisting() {
    const keys = existingRows.map((r) => r.key);
    setOverrides((prev) => {
      const next = { ...prev };
      for (const k of keys) next[k] = { ...next[k], checked: true };
      return next;
    });
  }

  function clearSelection() {
    const keys = rows.map((r) => r.key);
    setOverrides((prev) => {
      const next = { ...prev };
      for (const k of keys) next[k] = { ...next[k], checked: false };
      return next;
    });
  }

  async function handleAdd() {
    if (busy || !collection) return;
    const picks = rows
      .filter((r) => stateFor(r).checked)
      .map((r) => {
        const st = stateFor(r);
        return {
          elementIndex: r.elementIndex,
          targetItemId: st.targetId,
          productName: r.product,
          quantity: st.quantity,
        };
      });
    if (picks.length === 0) return;
    setBusy(true);
    const ok = await onAdd(collection.id, picks);
    setBusy(false);
    // Stay put on failure so the selection is not lost.
    if (ok) onBack();
  }

  const pickerRowData = pickerRow ? rows.find((r) => r.key === pickerRow) : null;
  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <h2 className="text-lg sm:text-xl font-medium text-foreground mb-1">
        Add to Collection
      </h2>
      <p className="text-sm text-muted-foreground mb-3">{item.name}</p>

      {available.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">
          No collections yet. Create one first.
        </p>
      ) : (
        <>
          <label className="block text-sm font-medium text-foreground mb-1">
            Collection
          </label>
          <select
            value={collectionId}
            onChange={(e) => setCollectionId(e.target.value)}
            className="w-full px-3 py-2 min-h-[44px] border border-border rounded-lg text-base mb-3"
          >
            {available.map((c) => {
              const ctx = (contexts || []).find((x) => x.id === c.contextId);
              return (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {ctx ? ` — ${ctx.name}` : ""}
                </option>
              );
            })}
          </select>

          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              Nothing to add — this item has no collectable elements and no
              bullets.
            </p>
          ) : (
            <>
            {/* Select-all covers only rows that already resolve to an existing
                item. A create-new row mints a new catalogue entry, so it stays
                one deliberate tap. The label carries the count and the word
                "existing" for exactly that reason: a plain "Select all" here
                would claim to do something it deliberately does not. */}
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-sm text-muted-foreground">
                {selectedCount} of {rows.length} selected
              </span>
              {existingRows.length > 0 && (
                <button
                  onClick={allExistingSelected ? clearSelection : selectExisting}
                  className="px-3 py-2 min-h-[44px] shrink-0 rounded-lg border border-border text-sm text-primary hover:border-primary"
                >
                  {allExistingSelected
                    ? "Select none"
                    : `Select ${existingRows.length} existing`}
                </button>
              )}
            </div>
            {existingRows.length < rows.length && (
              <p className="text-xs text-muted-foreground mb-2">
                Rows that create a new item are not included — tap those
                individually.
              </p>
            )}

            {/* No interior scroll. An inner scroller nested in the page
                scroller is unusable on a phone — a 32-row recipe in a
                half-screen box is the case that breaks it. The page scrolls
                once and the sticky footer now genuinely engages, which is
                what it was always there for. */}
            <div className="space-y-2 mb-4">
              {rows.map((row) => {
                const st = stateFor(row);
                const target = st.targetId
                  ? (items || []).find((i) => i.id === st.targetId)
                  : null;
                return (
                  <div
                    key={row.key}
                    onClick={() => patch(row.key, { checked: !st.checked })}
                    className={`flex gap-3 p-3 border rounded-lg cursor-pointer ${
                      st.checked
                        ? "border-primary bg-background"
                        : "border-border bg-white hover:border-primary"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={st.checked}
                      readOnly
                      className="mt-1 rounded accent-primary pointer-events-none shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground break-words">
                        {row.text}
                      </p>

                      <div className="flex items-center gap-2 mt-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setPickerSearch("");
                            setPickerRow(row.key);
                          }}
                          className={`flex-1 min-w-0 text-left truncate px-2 py-2 min-h-[44px] rounded text-sm ${
                            target
                              ? "border border-border text-foreground"
                              : "border-2 border-dashed border-primary text-primary"
                          }`}
                        >
                          {target ? (
                            <span className="truncate">{target.name}</span>
                          ) : (
                            <span className="truncate">
                              Create &quot;{row.product}&quot;
                            </span>
                          )}
                        </button>
                        <input
                          type="text"
                          value={st.quantity}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            e.stopPropagation();
                            patch(row.key, { quantity: e.target.value });
                          }}
                          placeholder="Qty"
                          className="w-20 sm:w-24 shrink-0 px-2 py-2 min-h-[44px] border border-border rounded text-base"
                        />
                      </div>

                      {!target && row.near.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 mt-2">
                          <span className="text-xs text-muted-foreground">
                            or use
                          </span>
                          {row.near.map((n) => (
                            <button
                              key={n.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                patch(row.key, { targetId: n.id, checked: true });
                              }}
                              className="px-2 py-1 min-h-[32px] rounded-full border border-border bg-secondary text-xs text-foreground hover:border-primary"
                            >
                              {n.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            </>
          )}

          {/* Same offsets as CollectionAddItems. Now that the list no longer
              scrolls internally this genuinely engages on a long recipe. */}
          <PinnedFooter className="bg-background">
            <button
              onClick={handleAdd}
              disabled={busy || selectedCount === 0 || !collection}
              className="px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm disabled:opacity-50 text-sm"
            >
              {busy
                ? "Adding..."
                : `Add ${selectedCount > 0 ? `(${selectedCount})` : ""} to Collection`}
            </button>
            <button
              onClick={onBack}
              className="px-4 py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg text-sm"
            >
              Cancel
            </button>
          </PinnedFooter>
        </>
      )}

      {pickerRowData && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setPickerRow(null)}
        >
          <div
            className="bg-card p-4 sm:p-6 rounded-lg max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-medium text-foreground">Change target</h3>
              <button
                onClick={() => setPickerRow(null)}
                aria-label="Close"
                className="flex items-center justify-center min-h-[44px] min-w-[44px] -mr-2 text-muted-foreground hover:text-foreground"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-muted-foreground mb-3 break-words">
              {pickerRowData.text}
            </p>

            <button
              onClick={() => {
                patch(pickerRowData.key, { targetId: null, checked: true });
                setPickerRow(null);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 min-h-[44px] mb-3 border-2 border-dashed border-primary rounded-lg text-primary text-sm"
            >
              <Plus className="w-4 h-4 shrink-0" />
              <span className="truncate">
                Create &quot;{pickerRowData.product}&quot;
              </span>
            </button>

            {/* No context name on rows: every candidate is already in the
                target collection's context. */}
            <ItemPicker
              variant="popup"
              items={items}
              showContext={false}
              exclude={(i) => targetContextId != null && i.contextId !== targetContextId}
              query={pickerSearch}
              onQueryChange={setPickerSearch}
              onPick={(cand) => {
                patch(pickerRowData.key, { targetId: cand.id, checked: true });
                setPickerRow(null);
              }}
              placeholder="Search items..."
              autoFocus
            />
          </div>
        </div>
      )}
    </div>
  );
}
