/**
 * The reminder line for an inbox item or an intention, in Pacific time: every
 * scheduled reminder, or — when none is scheduled — the most recent sent one, muted.
 * Renders nothing when there is neither, or when the read fails (logged): a missing
 * line is better than an error box on a detail page.
 */

import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { formatPacific, getReminderSummary } from "./utils/remindersApi";

export default function PendingReminder({ inboxId = null, intentId = null }) {
  const [summary, setSummary] = useState({ scheduled: [], lastSent: null });

  useEffect(() => {
    let live = true;
    getReminderSummary({ inboxId, intentId })
      .then((s) => live && setSummary(s))
      .catch((err) => {
        console.error("[PendingReminder]", err);
        if (live) setSummary({ scheduled: [], lastSent: null });
      });
    return () => {
      live = false;
    };
  }, [inboxId, intentId]);

  const { scheduled, lastSent } = summary;
  if (scheduled.length > 0) {
    return (
      <ul className="mt-2 space-y-1">
        {scheduled.map((r) => (
          <li key={r.id} className="flex items-center gap-2 text-sm text-muted-foreground">
            <Bell className="w-4 h-4 shrink-0 text-primary" aria-hidden="true" />
            <span>Reminder: {formatPacific(r.due_at)}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (lastSent) {
    return (
      <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground opacity-70">
        <Bell className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span>Reminder sent: {formatPacific(lastSent.sent_at || lastSent.due_at)}</span>
      </p>
    );
  }
  return null;
}
