import React from "react";
import { formatMinutesLong, formatTotalHours } from "../lib/practiceTimeFormat";

// Stopped-state practice-time display in the StatsBar. Today is the
// all-songs aggregate; Total is the per-song lifetime. Data comes in as
// props so the StatsBar's single `usePracticeStats` call serves both this
// component and `LiveSessionCounter`.
export default function PracticeTimeIndicator({ todayMinutes, perSongTotalSeconds }) {
  return (
    <span className="flex items-center gap-3">
      <span>Practice Time:</span>
      <span>
        Today: <strong className="text-dark">{formatMinutesLong(todayMinutes)}</strong>
      </span>
      <span>
        Total: <strong className="text-dark">{formatTotalHours(perSongTotalSeconds)}</strong>
      </span>
    </span>
  );
}
