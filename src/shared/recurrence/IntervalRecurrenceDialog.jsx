import React, { useState } from "react";

/**
 * Interval-from-completion dialog — schedule next event N days/weeks/months after done.
 */
export default function IntervalRecurrenceDialog({ initialConfig, onDone, onCancel }) {
  const init = initialConfig && initialConfig.type === "interval" ? initialConfig : null;
  const [every, setEvery] = useState(init?.every || 2);
  const [unit, setUnit] = useState(init?.unit || "days");
  const [endMode, setEndMode] = useState("never");
  const [endDate, setEndDate] = useState("");

  function handleDone() {
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

        <div className="flex items-center gap-2 mb-4">
          <span className="text-sm">Schedule next event</span>
          <input
            type="number"
            min={1}
            max={99}
            value={every}
            onChange={(e) => setEvery(Math.max(1, parseInt(e.target.value) || 1))}
            className="w-16 px-2 py-1 border border-border rounded text-center text-sm"
          />
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            className="px-2 py-1 border border-border rounded text-sm"
          >
            <option value="days">{every > 1 ? "days" : "day"}</option>
            <option value="weeks">{every > 1 ? "weeks" : "week"}</option>
            <option value="months">{every > 1 ? "months" : "month"}</option>
          </select>
          <span className="text-sm">after done</span>
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
          <button type="button" onClick={handleDone} className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded hover:opacity-90 transition-colors">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
