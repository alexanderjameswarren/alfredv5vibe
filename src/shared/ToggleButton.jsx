import React from "react";

// The inbox detail page's section-toggle style, shared (Restructure P4): filled when
// chosen, outlined in its own colour when not. "secondary" is tan: teal is reserved
// for an execution in progress.
export const TOGGLE_TONES = {
  primary: { edge: "border-primary", on: "bg-primary text-white", off: "bg-card text-primary" },
  secondary: { edge: "border-primary/40", on: "bg-secondary text-foreground", off: "bg-card text-foreground" },
};

/**
 * A large two-state toggle with a glyph, in a `tone` of TOGGLE_TONES.
 * `role="radio"` (one of a set) reports aria-checked; otherwise aria-pressed.
 */
export default function ToggleButton({ on, onClick, icon: Glyph, label, tone = "primary", role, disabled = false }) {
  const look = TOGGLE_TONES[tone];
  const state = role === "radio" ? { role, "aria-checked": on } : { "aria-pressed": on };
  return (
    <button
      type="button"
      {...state}
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 inline-flex items-center justify-center gap-2 min-h-[48px] px-4 py-2.5 rounded-lg border-2 transition-colors disabled:opacity-60 ${look.edge} ${
        on ? look.on : look.off
      }`}
    >
      <Glyph className="w-[18px] h-[18px] shrink-0" aria-hidden="true" />
      {label}
    </button>
  );
}
