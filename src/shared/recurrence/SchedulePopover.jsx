import React, { useState, useEffect, useRef } from "react";

/**
 * A trigger button that opens a small date popover and schedules on confirm.
 * Step 6 of docs/technical-spec-ui-standardization.md.
 *
 * This exists to make "Do Today" and "Schedule Later" the same kind of thing.
 * They used to be opposites: Do Today wrote an event and threw you to the
 * Schedule page, while Schedule Later wrote nothing at all — it toggled a date
 * input whose value was only applied if you afterwards remembered to press
 * Save. Two buttons side by side, one committing and one not, is the whole of
 * the "feels off" complaint.
 *
 * Now both open this control and both commit. The only difference is where the
 * date starts: `initialDate` is today for Do Today and empty for Schedule
 * Later. A confirm button rather than committing on the input's change event —
 * `<input type="date">` fires change per keystroke during keyboard entry in
 * some browsers, so committing on change would write a half-typed year.
 *
 * `placement` because the two surfaces sit at opposite ends of the screen: the
 * edit-form footer opens upward (downward would land under the fixed Capture
 * bar), the detail-page header opens downward.
 */
const PANEL_WIDTH = 240; // w-60
const EDGE = 16; // the page gutter

export default function SchedulePopover({
  label,
  icon = null,
  initialDate = "",
  onPick,
  className = "",
  placement = "bottom",
  disabled = false,
  confirmLabel = "Schedule",
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(initialDate);
  const [align, setAlign] = useState("left");
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function toggle() {
    // Open from the button's left edge when the panel fits that way, else its
    // right edge; anchoring right on a left-hand button ran it off a phone.
    const rect = ref.current?.getBoundingClientRect();
    setAlign(rect && rect.left + PANEL_WIDTH + EDGE > window.innerWidth ? "right" : "left");
    setOpen((wasOpen) => {
      // Reset on every open, so Do Today always offers today even after the
      // popover was left holding some other date from a previous visit.
      if (!wasOpen) setDate(initialDate);
      return !wasOpen;
    });
  }

  function commit() {
    if (!date) return;
    setOpen(false);
    onPick(date);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        className={className}
      >
        {icon}
        {label}
      </button>
      {open && (
        <div
          data-align={align}
          className={`absolute ${align === "right" ? "right-0" : "left-0"} z-30 w-60 p-3 bg-card border border-border rounded-lg shadow-lg ${
            placement === "top" ? "bottom-full mb-2" : "top-full mt-2"
          }`}
        >
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            Schedule for
          </label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
            }}
            className="w-full px-3 py-2 min-h-[44px] border border-border rounded text-base mb-2"
            autoFocus
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={commit}
              disabled={!date}
              className="flex-1 px-3 py-2 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {confirmLabel}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-3 py-2 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
