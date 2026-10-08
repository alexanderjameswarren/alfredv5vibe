import React from "react";
import { formatEventDate, getTodayDate } from "../utils/eventDates";

// The intention's one live event, as a line of its header rather than a card.
// `live` and `open` come from recordActions. Overdue is late, not a different state.
export function scheduledText({ live, open }) {
  if (!live) return open ? "In progress" : "Not scheduled";
  const day = String(live.time).slice(0, 10);
  if (open) return `${open.status === "paused" ? "Paused" : "In progress"} · ${formatEventDate(day)}`;
  return `${day < getTodayDate() ? "Overdue" : "Scheduled"} · ${formatEventDate(day)}`;
}

export default function ScheduledLine({ actions, className = "" }) {
  return <span className={className}>{scheduledText(actions)}</span>;
}
