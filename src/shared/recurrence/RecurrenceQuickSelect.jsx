import React, { useState, useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";
import { getRecurrenceDisplayString } from "../../utils/recurrenceDisplay";
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

  // Dynamic labels based on today
  const today = new Date();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const todayName = dayNames[today.getDay()];
  const todayIsoDay = today.getDay() === 0 ? 7 : today.getDay();
  const todayDom = today.getDate();

  function suffix(n) {
    const m = n % 100;
    if (m >= 11 && m <= 13) return `${n}th`;
    switch (n % 10) {
      case 1: return `${n}st`;
      case 2: return `${n}nd`;
      case 3: return `${n}rd`;
      default: return `${n}th`;
    }
  }

  const options = [
    {
      label: "Does not repeat",
      config: { type: "once" },
    },
    {
      label: "Daily",
      config: { type: "fixed", frequency: "daily", interval: 1 },
    },
    {
      label: `Weekly on ${todayName}`,
      config: { type: "fixed", frequency: "weekly", interval: 1, daysOfWeek: [todayIsoDay] },
    },
    {
      label: `Monthly on the ${suffix(todayDom)}`,
      config: { type: "fixed", frequency: "monthly", interval: 1, dayOfMonth: todayDom },
    },
    {
      label: "Every weekday (Mon\u2013Fri)",
      config: { type: "fixed", frequency: "weekly", interval: 1, daysOfWeek: [1, 2, 3, 4, 5] },
    },
  ];

  // Determine display label from current value
  function getDisplayLabel() {
    if (!value || value.type === "once") return "Does not repeat";
    // Check if it matches a quick option (use quick label for those)
    if (value.type === "fixed") {
      const match = options.find((o) =>
        o.config.type === value.type &&
        o.config.frequency === value.frequency &&
        o.config.interval === value.interval &&
        JSON.stringify(o.config.daysOfWeek || null) === JSON.stringify(value.daysOfWeek || null) &&
        (o.config.dayOfMonth || null) === (value.dayOfMonth || null)
      );
      if (match) return match.label;
    }
    // For custom configs and interval configs, use the display string helper
    return getRecurrenceDisplayString(value);
  }

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
