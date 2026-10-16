import React, { useState } from "react";
import NumberInput, { parseWhole } from "../NumberInput";

/**
 * Interval-from-completion dialog — schedule next event N days/weeks/months after done.
 */
export default function IntervalRecurrenceDialog({ initialConfig, onDone, onCancel }) {
  const init = initialConfig && initialConfig.type === "interval" ? initialConfig : null;
  // The raw text: it may be empty while typing (NumberInput).
  const [everyText, setEveryText] = useState(String(init?.every || 2));
  const every = parseWhole(everyText, { min: 1, max: 99 });
  const [unit, setUnit] = useState(init?.unit || "days");
  const [endMode, setEndMode] = useState("never");
  const [endDate, setEndDate] = useState("");

  function handleDone() {
    if (every === null) return;
    const config = { type: "interval", every, unit };
    onDone(config, endMode === "on" && endDate ? endDate : null);
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        className="bg-background border border-border rounded-lg shadow-xl p-5 w-full max-w-sm mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-4">Repeat after completion</h3>

        {/* One phrase: "Schedule next event / [3] [days] after last completion". The
            number and unit stay together; the trailing words wrap beneath them. */}
        <p className="text-sm mb-2">Schedule next event</p>
        <div className="flex items-start gap-x-2 gap-y-1 mb-4 flex-wrap">
          <span className="inline-flex items-start gap-2 whitespace-nowrap">
            <NumberInput
              aria-label="How many"
              value={everyText}
              onChange={setEveryText}
              min={1}
              max={99}
              className="w-16 px-2 py-1 border border-border rounded text-center text-sm"
            />
            <select
              aria-label="Unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              className="px-2 py-1 border border-border rounded text-sm"
            >
              <option value="days">{every === 1 ? "day" : "days"}</option>
              <option value="weeks">{every === 1 ? "week" : "weeks"}</option>
              <option value="months">{every === 1 ? "month" : "months"}</option>
            </select>
          </span>
          <span className="text-sm py-1">after last completion</span>
        </div>

        <div className="mb-4 space-y-2">
          <span className="text-sm text-muted-foreground block">Ends</span>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="intervalEndMode" checked={endMode === "never"} onChange={() => setEndMode("never")} />
            Never
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="intervalEndMode" checked={endMode === "on"} onChange={() => setEndMode("on")} />
            <span>On</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="px-2 py-1 border border-border rounded text-sm"
              disabled={endMode !== "on"}
            />
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="px-4 py-2 text-sm border border-border rounded hover:bg-muted transition-colors">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDone}
            disabled={every === null}
            className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded hover:opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
