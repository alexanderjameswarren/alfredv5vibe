import React from "react";

// Compact one-click selector, used where a row of radio buttons was eating
// horizontal space and pushing the stats row onto a second line (M3.5).
//
// Deliberately a row of buttons rather than a <select>: a dropdown costs two
// interactions to change a value, and the rule for this pass was that nothing
// currently reachable in one click may become more than one. Each option stays
// a single tap, and the group is narrower than the radios it replaces because
// the dots and their gaps are gone.
//
// Sized to sit inside the dense stats row, so no `min-h-[44px]` here — that
// would make the row taller than the wrapping it saves. The buttons are still a
// considerably larger touch target than the 12px radio inputs they replace.
// The text label is the first thing to go when the settings row runs out of
// width: it is hidden below `xl` (1280px), not removed, so `title` and
// `aria-label` on the wrapper keep the control identifiable by hover and to a
// screen reader. Hiding both labels frees roughly 195px, which is what keeps
// Score playback on the same line as everything else on a laptop.
// `disabled` greys the whole group; a fourth element on an option tuple greys
// that option alone. Both are optional and additive — every existing caller
// passes neither and is unaffected. Sight Reader's Focus mode needs both: its
// own button is dead while the focus list is empty, and it greys the clef group
// out while it is active, because it uses each entry's own clef.
export default function SegmentedControl({
  label,
  value,
  options,
  onChange,
  disabled = false,
}) {
  return (
    <span
      className={`flex items-center gap-1.5 shrink-0 whitespace-nowrap ${
        disabled ? "opacity-40" : ""
      }`}
      title={label}
      aria-label={label}
      aria-disabled={disabled || undefined}
    >
      <span className="hidden xl:inline">{label}</span>
      <span className="inline-flex rounded border border-border overflow-hidden">
        {options.map(([optionValue, optionLabel, optionTitle, optionDisabled], i) => {
          const selected = value === optionValue;
          const off = disabled || Boolean(optionDisabled);
          return (
            <button
              key={optionValue}
              type="button"
              title={optionTitle || optionLabel}
              aria-pressed={selected}
              disabled={off}
              onClick={() => onChange(optionValue)}
              className={`px-2 py-1 text-xs transition-colors ${
                i > 0 ? "border-l border-border" : ""
              } ${
                selected
                  ? "bg-primary-light text-primary font-medium"
                  : "bg-card text-muted-foreground hover:text-dark"
              } ${off ? "cursor-not-allowed " : ""}${
                // Only the option-level grey, or it would compound with the
                // group's own opacity and fade the whole row nearly out.
                optionDisabled && !disabled ? "opacity-50" : ""
              }`}
            >
              {optionLabel}
            </button>
          );
        })}
      </span>
    </span>
  );
}
