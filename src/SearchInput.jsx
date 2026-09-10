import React from "react";

// The shared search box. Used by ListToolbar on every list page and by
// ItemPicker for every "pick an item" search — one box, one look.
//
// Matching is not done here: callers filter with `matchesQuery` from
// utils/search, so this component knows nothing about what is being searched.
//
// text-base (16px), not text-sm like the sort select beside it: iOS Safari
// zooms the whole page when an input under 16px takes focus.
//
// No autoFocus unless asked for. List pages are mostly opened to read, and a
// focused field would raise the phone keyboard on every visit; a picker you
// opened on purpose passes `autoFocus`. Any other input prop (onFocus,
// onBlur, autoFocus) passes straight through.
export default function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  label,
  className = "",
  ...inputProps
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={label || placeholder}
      className={`min-h-[36px] px-3 py-1 text-base rounded-lg border border-border bg-card text-dark ${className}`}
      {...inputProps}
    />
  );
}
