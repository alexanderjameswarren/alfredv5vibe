import React, { useState, useEffect } from "react";
import NumberInput, { parseWhole } from "../NumberInput";
import CancelButton from "../CancelButton";

/**
 * Custom recurrence dialog — Google Calendar-style fixed schedule builder.
 * Supports daily/weekly/monthly frequency, interval, day-of-week toggles,
 * monthly mode (day-of-month vs ordinal weekday), end date, and anchor date.
 */
export default function CustomRecurrenceDialog({ initialConfig, onDone, onCancel }) {
  const DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"]; // Mon–Sun
  const DAY_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const ORDINALS = ["first", "second", "third", "fourth", "last"];

  // Parse initialConfig into local state
  const init = initialConfig && initialConfig.type === "fixed" ? initialConfig : null;
  const [frequency, setFrequency] = useState(init?.frequency || "week");
  // Number boxes hold raw text (NumberInput); parsed values are null while unusable.
  const [intervalText, setIntervalText] = useState(String(init?.interval || 1));
  const interval = parseWhole(intervalText, { min: 1, max: 99 });
  const [daysOfWeek, setDaysOfWeek] = useState(init?.daysOfWeek || []);
  const [monthlyMode, setMonthlyMode] = useState(init?.ordinal ? "ordinal" : "dayOfMonth");
  const [dayOfMonthText, setDayOfMonthText] = useState(String(init?.dayOfMonth || new Date().getDate()));
  const dayOfMonth = parseWhole(dayOfMonthText, { min: 1, max: 31 });
  const [ordinal, setOrdinal] = useState(init?.ordinal || "first");
  const [dayOfWeek, setDayOfWeek] = useState(init?.dayOfWeek || 1);
  const [endMode, setEndMode] = useState("never");
  const [endDate, setEndDate] = useState("");
  const [anchorDate, setAnchorDate] = useState(init?.anchorDate || "");

  // Map frequency display name
  const freqToLabel = { day: "day", week: "week", month: "month" };
  const freqOptions = ["day", "week", "month"];

  // Map internal frequency to config frequency
  const freqToConfig = { day: "daily", week: "weekly", month: "monthly" };

  // Initialise frequency from config
  useEffect(() => {
    if (init?.frequency === "daily") setFrequency("day");
    else if (init?.frequency === "weekly") setFrequency("week");
    else if (init?.frequency === "monthly") setFrequency("month");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleDay(isoDay) {
    setDaysOfWeek((prev) =>
      prev.includes(isoDay) ? prev.filter((d) => d !== isoDay) : [...prev, isoDay].sort((a, b) => a - b)
    );
  }

  const usesDayOfMonth = frequency === "month" && monthlyMode === "dayOfMonth";
  const valid = interval !== null && (!usesDayOfMonth || dayOfMonth !== null);

  function handleDone() {
    if (!valid) return;
    const config = { type: "fixed", frequency: freqToConfig[frequency], interval };

    if (frequency === "week") {
      config.daysOfWeek = daysOfWeek.length > 0 ? daysOfWeek : [];
      if (interval > 1 && anchorDate) {
        config.anchorDate = anchorDate;
      }
    }

    if (frequency === "month") {
      if (monthlyMode === "dayOfMonth") {
        config.dayOfMonth = dayOfMonth;
      } else {
        config.ordinal = ordinal;
        config.dayOfWeek = dayOfWeek;
      }
    }

    onDone(config, endMode === "on" && endDate ? endDate : null);
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        className="bg-background border border-border rounded-lg shadow-xl p-5 w-full max-w-sm mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-4">Custom recurrence</h3>

        {/* Repeat every [N] [frequency] */}
        <div className="flex items-start gap-2 mb-4">
          <span className="text-sm py-1">Repeat every</span>
          <NumberInput
            aria-label="Repeat every"
            value={intervalText}
            onChange={setIntervalText}
            min={1}
            max={99}
            className="w-16 px-2 py-1 border border-border rounded text-center text-sm"
          />
          <select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
            className="px-2 py-1 border border-border rounded text-sm"
          >
            {freqOptions.map((f) => (
              <option key={f} value={f}>
                {interval > 1 ? freqToLabel[f] + "s" : freqToLabel[f]}
              </option>
            ))}
          </select>
        </div>

        {/* Weekly: day-of-week toggles */}
        {frequency === "week" && (
          <div className="mb-4">
            <span className="text-sm text-muted-foreground block mb-2">Repeat on</span>
            <div className="flex gap-1">
              {DAY_LABELS.map((label, i) => {
                const isoDay = i + 1; // 1=Mon, 7=Sun
                const active = daysOfWeek.includes(isoDay);
                return (
                  <button
                    key={isoDay}
                    type="button"
                    onClick={() => toggleDay(isoDay)}
                    className={`w-9 h-9 rounded-full text-xs font-medium transition-colors ${
                      active
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Weekly + interval > 1: anchor date */}
        {frequency === "week" && interval > 1 && (
          <div className="mb-4">
            <label className="text-sm text-muted-foreground block mb-1">
              Anchor week of
            </label>
            <input
              type="date"
              value={anchorDate}
              onChange={(e) => setAnchorDate(e.target.value)}
              className="w-full px-2 py-1 border border-border rounded text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">Determines which week is "on"</p>
          </div>
        )}

        {/* Monthly: day-of-month vs ordinal weekday */}
        {frequency === "month" && (
          <div className="mb-4 space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="monthlyMode"
                checked={monthlyMode === "dayOfMonth"}
                onChange={() => setMonthlyMode("dayOfMonth")}
              />
              <span>On day</span>
              <NumberInput
                aria-label="Day of the month"
                value={dayOfMonthText}
                onChange={setDayOfMonthText}
                min={1}
                max={31}
                className="w-14 px-2 py-1 border border-border rounded text-center text-sm"
                disabled={monthlyMode !== "dayOfMonth"}
              />
            </label>
            <label className="flex items-center gap-2 text-sm flex-wrap">
              <input
                type="radio"
                name="monthlyMode"
                checked={monthlyMode === "ordinal"}
                onChange={() => setMonthlyMode("ordinal")}
              />
              <span>On the</span>
              <select
                value={ordinal}
                onChange={(e) => setOrdinal(e.target.value)}
                className="px-2 py-1 border border-border rounded text-sm"
                disabled={monthlyMode !== "ordinal"}
              >
                {ORDINALS.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
              <select
                value={dayOfWeek}
                onChange={(e) => {
                  const v = e.target.value;
                  setDayOfWeek(v === "weekday" ? "weekday" : parseInt(v));
                }}
                className="px-2 py-1 border border-border rounded text-sm"
                disabled={monthlyMode !== "ordinal"}
              >
                {DAY_FULL.map((name, i) => (
                  <option key={i + 1} value={i + 1}>{name}</option>
                ))}
                <option value="weekday">Weekday (Mon–Fri)</option>
              </select>
            </label>
          </div>
        )}

        {/* End date */}
        <div className="mb-4 space-y-2">
          <span className="text-sm text-muted-foreground block">Ends</span>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="endMode"
              checked={endMode === "never"}
              onChange={() => setEndMode("never")}
            />
            Never
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="endMode"
              checked={endMode === "on"}
              onChange={() => setEndMode("on")}
            />
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

        {/* Actions */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleDone}
            disabled={!valid}
            className="flex-1 px-4 py-2.5 min-h-[44px] text-sm bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Done
          </button>
          <CancelButton onClick={onCancel} />
        </div>
      </div>
    </div>
  );
}
