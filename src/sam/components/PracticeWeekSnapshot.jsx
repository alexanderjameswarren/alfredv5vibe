import React from "react";
import { ChevronRight } from "lucide-react";

// Compact 7-day practice-minutes strip. Sits at the top of the landing
// page and doubles as the tap-target that opens the /stats view.
//
// Bar heights come from `.minutes` in `sevenDayTotals`, normalized against
// the week's max. Index 0 (today) is accented; the six older days render
// muted. Layout order: oldest on the left → today on the right (standard
// week-strip convention).
//
// Props:
//   sevenDayTotals  from usePracticeStats — 7 items, index 0 = today,
//                   ordered most-recent-first
//   loading         boolean; renders a compact skeleton while true
//   onTap           called when the strip is clicked — routes to /stats
//                   in the current landing implementation
//
// This component does NOT call usePracticeStats itself — the caller (today
// only SongLoader) owns the fetch so landing stays at one sam_sessions
// request.

function Skeleton() {
  return (
    <div className="mt-4 w-full flex items-center gap-3 p-3 bg-card border border-border rounded-lg min-h-[56px]">
      <div className="text-sm text-muted-foreground">Loading practice stats…</div>
    </div>
  );
}

export default function PracticeWeekSnapshot({ sevenDayTotals, loading, onTap }) {
  if (loading) return <Skeleton />;

  const todayMinutes = sevenDayTotals[0]?.minutes ?? 0;
  const todayKey = sevenDayTotals[0]?.dateISO;
  const chronological = [...sevenDayTotals].reverse();
  const max = Math.max(1, ...sevenDayTotals.map((r) => r.minutes));

  return (
    <button
      onClick={onTap}
      className="mt-4 w-full flex items-center gap-3 p-3 bg-card border border-border rounded-lg hover:bg-secondary/40 transition-colors min-h-[56px] text-left"
      aria-label="Open practice history"
    >
      <div className="flex-shrink-0">
        <div className="text-sm font-medium text-dark">
          {todayMinutes > 0
            ? `${todayMinutes} min today`
            : "No practice yet today"}
        </div>
        <div className="text-xs text-muted-foreground">last 7 days</div>
      </div>
      <div className="flex-1 flex items-end justify-end gap-1 h-9 ml-2">
        {chronological.map((row) => {
          const isToday = row.dateISO === todayKey;
          // Height is purely proportional to minutes / max — 0-minute
          // days render as blank space (empty column). No baseline tint
          // and no visibility floor: the chart truly reflects practice.
          const heightPct = row.minutes > 0 ? (row.minutes / max) * 100 : 0;
          return (
            <div
              key={row.dateISO}
              className="w-3 flex flex-col justify-end h-full"
              title={`${row.dayLabel}: ${row.minutes} min`}
            >
              {row.minutes > 0 && (
                <div
                  className={`w-full rounded-t ${
                    isToday ? "bg-primary" : "bg-primary-light"
                  }`}
                  style={{ height: `${heightPct}%` }}
                  aria-label={`${row.dayLabel}: ${row.minutes} minutes`}
                />
              )}
            </div>
          );
        })}
      </div>
      <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
    </button>
  );
}
