/**
 * The pending reminder time(s) for an inbox item or an intention, in Pacific time.
 * Renders nothing when there is none, or when the read fails (logged): a missing
 * line is better than an error box on a detail page.
 */

import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { formatPacific, getPendingReminders } from "./utils/remindersApi";

export default function PendingReminder({ inboxId = null, intentId = null }) {
  const [reminders, setReminders] = useState([]);

  useEffect(() => {
    let live = true;
    getPendingReminders({ inboxId, intentId })
      .then((rows) => live && setReminders(rows))
      .catch((err) => {
        console.error("[PendingReminder]", err);
        if (live) setReminders([]);
      });
    return () => {
      live = false;
    };
  }, [inboxId, intentId]);

  if (reminders.length === 0) return null;

  return (
    <ul className="mt-2 space-y-1">
      {reminders.map((r) => (
        <li key={r.id} className="flex items-center gap-2 text-sm text-muted-foreground">
          <Bell className="w-4 h-4 shrink-0 text-primary" aria-hidden="true" />
          <span>Reminder: {formatPacific(r.due_at)}</span>
        </li>
      ))}
    </ul>
  );
}
