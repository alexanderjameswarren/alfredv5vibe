import React from "react";
import usePracticeStats from "../lib/usePracticeStats";
import { formatMinutesShort } from "../lib/practiceTimeFormat";

// 7-day rolling practice-minutes snapshot. Renders today + the previous six
// PT calendar days, most-recent first. Days without any completed sessions
// read "No practice". The hook handles bucketing; this component just
// formats and lays out.
export default function PracticeWeekSnapshot() {
  const { sevenDayTotals, loading } = usePracticeStats({ currentSongId: null });

  if (loading) {
    return (
      <div className="mt-6 text-center text-sm text-muted-foreground">
        Loading practice stats...
      </div>
    );
  }

  return (
    <div className="mt-6">
      <h3 className="text-sm font-medium text-muted-foreground mb-2">
        Practice — last 7 days
      </h3>
      <div className="flex flex-col gap-0.5">
        {sevenDayTotals.map((row) => (
          <div key={row.dateISO} className="text-sm text-dark px-1">
            <span className="font-medium">{row.dayLabel}:</span>{" "}
            <span className="text-muted-foreground">
              {row.minutes > 0 ? formatMinutesShort(row.minutes) : "No practice"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
