import { useState, useEffect, useCallback } from "react";
import { getListReminders, indexReminders } from "../utils/remindersApi";

// The reminder index, moved out of Alfred.jsx unchanged. Two hooks because the
// state and the list-view refresh sat far apart in Alfred, and the refresh effect
// must keep its place among Alfred's other effects: call each where it was.
export function useReminderIndex() {
  // Per inbox row and per intention: the soonest scheduled reminder, else the latest
  // sent one, for the list cards. One query for the whole list; refreshed on list
  // views and after reminder-changing actions.
  const [reminderIndex, setReminderIndex] = useState({ byInbox: {}, byIntent: {} });
  const refreshReminderIndex = useCallback(async () => {
    try {
      setReminderIndex(indexReminders(await getListReminders()));
    } catch (err) {
      console.error("[Reminders] list read failed:", err);
    }
  }, []);

  return { reminderIndex, refreshReminderIndex };
}

export function useReminderListRefresh({ dataLoaded, view, refreshReminderIndex }) {
  // Reminders are also created by Claude, outside this app, so a list view re-reads them.
  useEffect(() => {
    if (dataLoaded && (view === "inbox" || view === "intentions" || view === "memories")) {
      refreshReminderIndex();
    }
  }, [dataLoaded, view, refreshReminderIndex]);
}
