import React, { useState, useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";
import { repeatPattern } from "../../utils/recurrenceDisplay";
import CustomRecurrenceDialog from "./CustomRecurrenceDialog";
import IntervalRecurrenceDialog from "./IntervalRecurrenceDialog";

/**
 * Quick-select recurrence dropdown — replaces the old 4-option <select>.
 * Shows dynamic labels based on today's date (e.g., "Weekly on Friday").
 * "Custom..." opens the CustomRecurrenceDialog inline.
 * "After completion..." opens the interval dialog (Step 8).
 */
export default function RecurrenceQuickSelect({ value, onChange, onOpenInterval, onEndDateChange, className = "" }) {
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [showInterval, setShowInterval] = useState(false);
  const ref = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Presets based on today. Labels come from the shared formatter (Restructure
  // P4), so the picker reads exactly as the repeat line will.
  const today = new Date();
  const todayIsoDay = today.getDay() === 0 ? 7 : today.getDay();
  const todayDom = today.getDate();

  const options = [
    { type: "once" },
    { type: "fixed", frequency: "daily", interval: 1 },
    { type: "fixed", frequency: "weekly", interval: 1, daysOfWeek: [todayIsoDay] },
    { type: "fixed", frequency: "monthly", interval: 1, dayOfMonth: todayDom },
    { type: "fixed", frequency: "weekly", interval: 1, daysOfWeek: [1, 2, 3, 4, 5] },
  ].map((config) => ({ label: repeatPattern(config), config }));

  const getDisplayLabel = () => repeatPattern(value);

  function select(option) {
    onChange(option.config);
    setOpen(false);
  }

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full px-3 py-2 border border-border rounded text-base text-left bg-background flex items-center justify-between"
      >
        <span>{getDisplayLabel()}</span>
        <ChevronDown className="w-4 h-4 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full bg-background border border-border rounded shadow-lg">
          {options.map((option, i) => (
            <button
              key={i}
              type="button"
              onClick={() => select(option)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors"
            >
              {option.label}
            </button>
          ))}
          <div className="border-t border-border" />
          <button
            type="button"
            onClick={() => { setOpen(false); setShowCustom(true); }}
            className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors text-muted-foreground"
          >
            Custom…
          </button>
          <button
            type="button"
            onClick={() => { setOpen(false); setShowInterval(true); }}
            className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors text-muted-foreground"
          >
            After completion…
          </button>
        </div>
      )}

      {/* Custom fixed schedule dialog */}
      {showCustom && (
        <CustomRecurrenceDialog
          initialConfig={value && value.type === "fixed" ? value : null}
          onDone={(config, endDateVal) => {
            onChange(config);
            if (onEndDateChange && endDateVal) onEndDateChange(endDateVal);
            setShowCustom(false);
          }}
          onCancel={() => setShowCustom(false)}
        />
      )}

      {/* Interval dialog placeholder — implemented in Step 8 */}
      {showInterval && (
        <IntervalRecurrenceDialog
          initialConfig={value && value.type === "interval" ? value : null}
          onDone={(config, endDateVal) => {
            onChange(config);
            if (onEndDateChange && endDateVal) onEndDateChange(endDateVal);
            setShowInterval(false);
          }}
          onCancel={() => setShowInterval(false)}
        />
      )}
    </div>
  );
}
