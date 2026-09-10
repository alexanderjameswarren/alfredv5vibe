import React, { useEffect, useRef, useState } from "react";
import SearchInput from "./SearchInput";
import { matchesQuery } from "./utils/search";

// The shared "pick an item" search: every place you search for ONE item to
// link, attach or target. (Add Items to Collection is deliberately not one of
// them — it is a multi-select with quantities.)
//
// Rules, the same everywhere:
//   * archived items never appear;
//   * matching is on the item's name only — you are choosing a specific item,
//     and a recipe that mentions salt must not bury the "Salt" item;
//   * at most ITEM_PICKER_CAP results, with a line saying how many were cut;
//   * "No matching items" when the search finds nothing, "No items available"
//     when there was nothing to find;
//   * each row shows the item's context, unless the caller turns it off
//     because every candidate already shares one.
//
// What varies is the variant, and each one fixes both the look and when the
// list shows:
//   dropdown  a field inside a form. Floats under the box, shows nothing until
//             you type, hides when focus leaves the box.
//   inline    opened on purpose, in the page flow. Shows everything straight
//             away, hides when focus leaves the box.
//   popup     opened on purpose, inside a popup. Shows everything and never
//             hides on its own — the popup closes it, and dismissing the phone
//             keyboard to scroll the list must not make it vanish.
//
// The caller owns the query (several pre-fill it, or write the picked name
// back into it) and whatever "selected" display it has. Filters specific to
// one site — the item being edited, items already attached, one context —
// come in as `exclude`.

export const ITEM_PICKER_CAP = 20;

// Delay before a blur hides the list, so a tap on a result lands before the
// list unmounts under it.
const BLUR_HIDE_MS = 200;

const ROW_IN_BOX =
  "w-full text-left px-3 py-2 min-h-[44px] hover:bg-background border-b border-border last:border-b-0";

const STYLES = {
  dropdown: {
    box: "absolute z-10 w-full mt-1 bg-card border border-border rounded-lg shadow-lg max-h-60 overflow-y-auto",
    row: ROW_IN_BOX,
  },
  inline: {
    box: "mt-1 bg-card border border-border rounded-lg max-h-60 overflow-y-auto",
    row: ROW_IN_BOX,
  },
  popup: {
    box: "mt-3 space-y-2",
    row: "w-full text-left px-3 py-2 min-h-[44px] border border-border rounded-lg hover:border-primary",
  },
};

export default function ItemPicker({
  variant = "dropdown",
  items,
  exclude,
  query,
  onQueryChange,
  onPick,
  contexts,
  showContext = true,
  showDescription = false,
  placeholder = "Search for an item...",
  autoFocus = false,
}) {
  const hidesOnBlur = variant !== "popup";
  // A dropdown opens on focus. The inline list starts open: it is mounted by a
  // tap that asked for it, and iOS does not reliably honour autoFocus.
  const [open, setOpen] = useState(variant === "inline");
  const blurTimer = useRef(null);
  useEffect(() => () => clearTimeout(blurTimer.current), []);

  function show() {
    clearTimeout(blurTimer.current);
    setOpen(true);
  }

  function hideSoon() {
    if (!hidesOnBlur) return;
    clearTimeout(blurTimer.current);
    blurTimer.current = setTimeout(() => setOpen(false), BLUR_HIDE_MS);
  }

  const typed = query.trim() !== "";
  const listVisible =
    variant === "popup" || (open && (variant === "inline" || typed));

  const available = (items || []).filter(
    (item) => !item.archived && !(exclude && exclude(item)),
  );
  const matches = available.filter((item) => matchesQuery(query, item.name));
  const shown = matches.slice(0, ITEM_PICKER_CAP);
  const style = STYLES[variant];
  const note = "px-3 py-2 text-sm text-muted-foreground";

  function contextNameOf(item) {
    if (!showContext || !item.contextId) return null;
    return (contexts || []).find((c) => c.id === item.contextId)?.name || null;
  }

  return (
    <div className={variant === "dropdown" ? "relative" : undefined}>
      <SearchInput
        value={query}
        onChange={(value) => {
          onQueryChange(value);
          show();
        }}
        onFocus={show}
        onBlur={hideSoon}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="w-full"
      />
      {listVisible && (
        <div className={style.box}>
          {available.length === 0 ? (
            <p className={note}>No items available</p>
          ) : matches.length === 0 ? (
            <p className={note}>No matching items</p>
          ) : (
            <>
              {shown.map((item) => {
                const contextName = contextNameOf(item);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      if (hidesOnBlur) setOpen(false);
                      onPick(item);
                    }}
                    className={style.row}
                  >
                    <div className="font-medium text-foreground break-words">
                      {item.name}
                    </div>
                    {contextName && (
                      <div className="text-xs text-muted-foreground">
                        {contextName}
                      </div>
                    )}
                    {showDescription && item.description && (
                      <div className="text-sm text-muted-foreground mt-1 line-clamp-2">
                        {item.description}
                      </div>
                    )}
                  </button>
                );
              })}
              {matches.length > shown.length && (
                <p className={`${note} text-xs`}>
                  Showing {shown.length} of {matches.length} — keep typing to
                  narrow
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
