import { storage, writeError } from "../utils/storage";
import { uid } from "../utils/flattenElements";
import { assertNoActiveRun } from "../utils/runGuard";
import { getTodayDate, formatEventDate } from "../utils/eventDates";
import { intentionUpdateRow } from "../utils/intentionRows";
import { liveEventsFor, carriedItems, STATUS_LABELS, closeFields, restoredCloseFields, CLOSE_REASON_SAVED } from "../utils/status";
import { closedAtFor } from "../executions/useExecutionActions";
import { saveNote, deleteNote, completionsChanged } from "../notes/notesApi";
import { cancelRemindersForStatus, restoreRemindersAfterStatus } from "../utils/remindersApi";
import { getRecurrenceConfig } from "../utils/recurrence";

const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** " and archived 1 event and cancelled 2 reminders" for the status Undo toast. */
export function statusUndoWhat(events, reminders) {
  const parts = [];
  if (events) parts.push(`archived ${plural(events, "event")}`);
  if (reminders) parts.push(`cancelled ${plural(reminders, "reminder")}`);
  return parts.length ? ` and ${parts.join(" and ")}` : "";
}

// Intention writers, moved out of Alfred.jsx unchanged. Holds no state: everything
// it reads or sets is Alfred's, passed in. `refreshReminderIndex` is optional.
export function useIntentionActions({
  user,
  intents,
  setIntents,
  items,
  setItems,
  events,
  setEvents,
  view,
  setView,
  setSelectedIntentionId,
  intentionReturnView,
  withLoading,
  offerUndoFor,
  watchStatus,
  refreshReminderIndex,
}) {
  async function moveToPlanner(intentId, scheduledDate = "today") {
    return withLoading('Scheduling...', async () => {
      // Always read from storage first to get the latest data
      // (state may be stale if updateIntent was just called)
      let intent = await storage.get(`intent:${intentId}`);
      if (!intent) {
        intent = intents.find((i) => i.id === intentId);
      }

      if (!intent) {
        console.error("Intent not found:", intentId);
        return;
      }

      const eventDate = scheduledDate === "today" ? getTodayDate() : scheduledDate;

      // One live event per intention: an existing one is moved, not joined.
      // A move is not a new commitment, so no status trigger fires.
      const live = liveEventsFor(events, intentId)[0];
      if (live) {
        await assertNoActiveRun(live.id);
        const moved = await storage.set(`event:${live.id}`, { ...live, time: eventDate });
        if (!moved) throw writeError("Rescheduling");
        setEvents((prev) => prev.map((e) => (e.id === live.id ? moved : e)));
        offerUndoFor(`Rescheduled to ${formatEventDate(eventDate)}.`, async () => {
          const back = await storage.set(`event:${live.id}`, live);
          if (!back) throw writeError("Undo");
          setEvents((prev) => prev.map((e) => (e.id === live.id ? back : e)));
        });
        return;
      }

      const itemIds = intent.itemId ? [intent.itemId] : [];
      const settle = watchStatus({ intents: [intent], items: carriedItems(intent, itemIds, items) });

      // Create event for this intent
      const event = {
        id: uid(),
        user_id: user.id,
        intentId,
        time: eventDate,
        itemIds,
        contextId: intent.contextId,
        collectionId: intent.collectionId || null,
        archived: false,
        createdAt: new Date().toISOString(),
      };

      const savedEvent = await storage.set(`event:${event.id}`, event);
      if (!savedEvent) throw writeError("Scheduling");
      setEvents((prev) => [...prev, savedEvent]);
      const flip = await settle({ announce: false });

      // No navigation. This used to end by switching the view to the schedule
      // whenever the date was today, which is what made "Do Today" throw you
      // off whatever list you were working through. The message below is how
      // you now know it worked, and it names the date so scheduling for today
      // and scheduling for a Tuesday give the same feedback.
      //
      // (No literal call syntax in this comment — the navigation call sites are
      // counted by grep at every step of the routing work, and a comment would
      // inflate the count. Same convention as the bridge comment at the top.)
      //
      // Every caller loses the jump, not just the two surfaces Step 6 touches:
      // the add-intention forms on Intentions, Context detail and Item detail
      // all funnelled through here too. Staying put is right for all of them.
      //
      // Undo deletes rather than archives — the event was created seconds ago
      // and never seen, so an archived ghost in the recycle bin would be a
      // record of something that never happened. Same reasoning as the
      // recurrence successor in Step 2.
      offerUndoFor(`Scheduled for ${formatEventDate(eventDate)}.${flip?.moved ? " Moved to Active." : ""}`, async () => {
        if (!(await storage.delete(`event:${event.id}`))) throw writeError("Undo");
        setEvents((prev) => prev.filter((e) => e.id !== event.id));
        // Undo reverses everything the tap did: the status it un-parked too.
        await flip?.restore();
      });
    });
  }

  // Item detail's Schedule: a new one-off intention for the item and its event,
  // together. Undo deletes both; neither was ever seen.
  // `targetIntentId`: the intention item detail's buttons act on (itemActionTarget),
  // (re)scheduled; only with none is a new one made.
  async function scheduleFromItem(item, date, targetIntentId) {
    if (targetIntentId) return moveToPlanner(targetIntentId, date);
    return withLoading('Scheduling...', async () => {
      const intentId = uid();
      const settle = watchStatus({ items: [item], refreshIntentIds: [intentId] });
      const intent = {
        id: intentId,
        user_id: user.id,
        text: item.name,
        createdAt: new Date().toISOString(),
        isIntention: true,
        archived: false,
        itemId: item.id,
        contextId: item.contextId || null,
        recurrenceConfig: { type: "once" },
      };
      const savedIntent = await storage.set(`intent:${intentId}`, intent);
      if (!savedIntent) throw new Error("Intention was not saved.");
      setIntents((prev) => [...prev, savedIntent]);

      const event = {
        id: uid(),
        user_id: user.id,
        intentId,
        time: date,
        itemIds: [item.id],
        contextId: intent.contextId,
        archived: false,
        createdAt: new Date().toISOString(),
      };
      const savedEvent = await storage.set(`event:${event.id}`, event);
      if (!savedEvent) throw writeError("Scheduling");
      setEvents((prev) => [...prev, savedEvent]);
      const flip = await settle({ announce: false });

      offerUndoFor(`Scheduled for ${formatEventDate(date)}.${flip?.moved ? " Moved to Active." : ""}`, async () => {
        if (!(await storage.delete(`event:${event.id}`))) throw writeError("Undo");
        setEvents((prev) => prev.filter((e) => e.id !== event.id));
        if (!(await storage.delete(`intent:${intentId}`))) throw writeError("Removing the intention");
        setIntents((prev) => prev.filter((i) => i.id !== intentId));
        await flip?.restore();
      });
    });
  }

  async function updateIntent(intentId, updates, scheduledDate) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return;
    return withLoading('Saving...', async () => {
      // The whitelist lives in utils/intentionRows.js, under test. It was inline
      // here, and `description` was missing from it — which made Details silently
      // unwritable from the edit screen: typed, "saved", and gone, with no error.
      // A list like this fails invisibly once per new column, so it is somewhere a
      // test can reach.
      const updated = intentionUpdateRow(intent, updates);

      const savedIntent = await storage.set(`intent:${intent.id}`, updated);
      // Functional: a realtime update that landed meanwhile must not be overwritten.
      setIntents((prev) => prev.map((i) => (i.id === intentId ? savedIntent || updated : i)));

      // If scheduledDate provided, create an event
      if (scheduledDate) {
        await moveToPlanner(intentId, scheduledDate);
      }
    });
  }

  async function archiveIntention(intentId) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return;
    return withLoading('Archiving...', async () => {
      const archivedIntent = { ...intent, archived: true };
      await storage.set(`intent:${intentId}`, archivedIntent);
      setIntents((prev) => prev.map((i) => (i.id === intentId ? archivedIntent : i)));

      // Archive all related events
      const relatedEvents = events.filter((e) => e.intentId === intentId && !e.archived);
      for (const event of relatedEvents) {
        const archivedEvent = { ...event, archived: true };
        await storage.set(`event:${event.id}`, archivedEvent);
        setEvents((prev) => prev.map((e) => (e.id === event.id ? archivedEvent : e)));
      }

      // Archiving an intention cascades to its events, so undoing it has to as
      // well — restoring the intention alone would leave its schedule silently
      // archived. `relatedEvents` holds only the ones this call actually
      // touched, so an event archived earlier stays archived.
      offerUndoFor(`Archived "${intent.text || "intention"}".`, async () => {
        if (!(await storage.set(`intent:${intentId}`, intent))) throw writeError("Restoring the intention");
        setIntents((prev) => prev.map((i) => (i.id === intentId ? intent : i)));
        for (const event of relatedEvents) {
          if (!(await storage.set(`event:${event.id}`, event))) throw writeError("Restoring its event");
          setEvents((prev) => prev.map((e) => (e.id === event.id ? event : e)));
        }
      });

      // Only the detail page has to leave: it is showing the record that just
      // got archived, so staying would render an archived intention. A list row
      // simply disappears from its own list, and yanking the user to another
      // screen for that was the defect.
      //
      // `view` is derived from the URL, so this reads the screen the click
      // actually came from. The return address is `intentionReturnView` — the
      // slot `viewIntentionDetail` wrote on the way in — not the globally
      // shared `previousView`, which any intervening navigation can clobber.
      if (view === "intention-detail") {
        setSelectedIntentionId(null);
        setView(intentionReturnView);
      }
    });
  }

  // Status changes go through storage.patch only (storage.set drops status on
  // UPDATE). `archiveEvents` is the live-events sheet's answer: archive every
  // live event, past-due and future, and cancel every scheduled reminder
  // (reason intent_status). Undo puts all of it back; it never restores
  // someday, which the database would refuse.
  async function setIntentionStatus(intentId, status, { archiveEvents = false } = {}) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return;
    return withLoading("Saving...", async () => {
      const saved = await storage.patch(`intent:${intentId}`, { status });
      if (!saved) throw new Error("Status was not saved.");
      setIntents((prev) => prev.map((i) => (i.id === intentId ? saved : i)));

      const archivedEvents = [];
      if (archiveEvents) {
        for (const event of liveEventsFor(events, intentId)) {
          const archivedEvent = { ...event, archived: true };
          await storage.set(`event:${event.id}`, archivedEvent);
          setEvents((prev) => prev.map((e) => (e.id === event.id ? archivedEvent : e)));
          archivedEvents.push(event);
        }
      }

      let cancelledReminders = [];
      if (archiveEvents) {
        try {
          cancelledReminders = await cancelRemindersForStatus(intentId);
        } catch (err) {
          console.error("[Reminders] cancel on status change failed:", err);
          window.alert(`Moved to ${STATUS_LABELS[status]}, but its reminders could not be cancelled and may still fire.`);
        }
        refreshReminderIndex?.();
      }

      const previous = intent.status;
      const canRestore = previous && previous !== "someday";
      if (!canRestore && archivedEvents.length === 0 && cancelledReminders.length === 0) return;
      const what = statusUndoWhat(archivedEvents.length, cancelledReminders.length);
      offerUndoFor(`Moved to ${STATUS_LABELS[status]}${what}.`, async () => {
        if (canRestore) {
          const back = await storage.patch(`intent:${intentId}`, { status: previous });
          if (!back) throw writeError("Restoring the status");
          setIntents((prev) => prev.map((i) => (i.id === intentId ? back : i)));
        }
        for (const event of archivedEvents) {
          if (!(await storage.set(`event:${event.id}`, event))) throw writeError("Restoring its event");
          setEvents((prev) => prev.map((e) => (e.id === event.id ? event : e)));
        }
        if (cancelledReminders.length) {
          await restoreRemindersAfterStatus(cancelledReminders);
          refreshReminderIndex?.();
        }
      });
    });
  }

  /**
   * Stop (Restructure P4 Step 10): end a repeat without closing it. end_date today,
   * recurrence_config kept (the line reads "Ended …"), and always Background.
   * `archiveEvents`: the one question's answer when something was pending — archive
   * the live dates and cancel the scheduled reminders, or keep them. Undo restores the
   * end date and status, then the dates and reminders still ahead; it stops at the
   * first failed write. (status_changed_at is the database's until Step 11.)
   */
  async function stopRepeat(intentId, { archiveEvents = false } = {}) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return;
    const today = getTodayDate();
    return withLoading("Stopping...", async () => {
      const saved = await storage.patch(`intent:${intentId}`, { status: "background", endDate: today });
      if (!saved) throw new Error("Stop was not saved.");
      setIntents((prev) => prev.map((i) => (i.id === intentId ? saved : i)));

      const archivedEvents = [];
      let cancelledReminders = [];
      if (archiveEvents) {
        for (const event of liveEventsFor(events, intentId)) {
          const archivedEvent = { ...event, archived: true };
          if (!(await storage.set(`event:${event.id}`, archivedEvent))) throw writeError("Archiving its date");
          setEvents((prev) => prev.map((e) => (e.id === event.id ? archivedEvent : e)));
          archivedEvents.push(event);
        }
        try {
          cancelledReminders = await cancelRemindersForStatus(intentId);
        } catch (err) {
          console.error("[Reminders] cancel on stop failed:", err);
          window.alert("Stopped, but its reminders could not be cancelled and may still fire.");
        }
        refreshReminderIndex?.();
      }

      const futureEvents = archivedEvents.filter((e) => String(e.time).slice(0, 10) >= today);
      const previous = intent.status;
      offerUndoFor("Stopped repeating. Moved to Background.", async () => {
        const back = await storage.patch(`intent:${intentId}`, {
          endDate: intent.endDate || null,
          // Never back to someday: status_guard allows that only from closed.
          ...(previous && previous !== "someday" ? { status: previous } : {}),
          ...(CLOSE_REASON_SAVED && previous !== "someday" && intent.statusChangedAt ? { statusChangedAt: intent.statusChangedAt } : {}),
        });
        if (!back) throw writeError("Restoring the repeat");
        setIntents((prev) => prev.map((i) => (i.id === intentId ? back : i)));
        for (const event of futureEvents) {
          if (!(await storage.set(`event:${event.id}`, event))) throw writeError("Restoring its date");
          setEvents((prev) => prev.map((e) => (e.id === event.id ? event : e)));
        }
        if (cancelledReminders.length) {
          await restoreRemindersAfterStatus(cancelledReminders);
          refreshReminderIndex?.();
        }
      });
    });
  }

  // Close from a list row (Restructure P4): the item, if any, and every listed
  // intention go to closed. Closing keeps no plan, so every live event is archived
  // and scheduled reminders cancelled; a recurring intention also gets end_date
  // today, as Stop does. Undo restores statuses (not someday, which status_guard
  // refuses), end dates, events dated today or later, and reminders still ahead.
  //
  // Close reason (P4, every one of the six places comes here through CloseDialog):
  // `reason` 'done' | 'wont_do', `note`, `closedOn` ("YYYY-MM-DD"), and `pickedIntentId`,
  // the one intention a Completed close may record an execution on. Completed with no
  // completed execution on it yet: a closed `done` execution dated Closed on, on its
  // live event or a new archived one, carrying the note; it never makes a next event.
  // Otherwise the note is a standalone note (item first, else the intention). Undo
  // deletes what was created first, then restores; it stops at the first failed write.
  async function closeRecords({ item = null, intentIds = [], label, reason = null, note = "", closedOn = null, pickedIntentId = null }) {
    const targets = intents.filter((i) => intentIds.includes(i.id));
    const today = getTodayDate();
    const day = closedOn || today;
    const closedAt = closedAtFor(day);
    const extra = closeFields(reason, closedAt);
    const picked = targets.find((i) => i.id === pickedIntentId) || null;
    // Captured before the close archives it: a Completed close records on this date.
    const pickedLive = picked ? liveEventsFor(events, picked.id)[0] || null : null;
    return withLoading("Closing...", async () => {
      const before = [];
      for (const intent of targets) {
        const stop = getRecurrenceConfig(intent).type !== "once" && (!intent.endDate || intent.endDate > today);
        const saved = await storage.patch(`intent:${intent.id}`, { status: "closed", ...extra, ...(stop ? { endDate: today } : {}) });
        if (!saved) throw new Error("Close was not saved.");
        setIntents((prev) => prev.map((i) => (i.id === intent.id ? saved : i)));
        before.push({ intent, stop });
      }
      let itemBefore = null;
      if (item && item.status !== "closed") {
        const saved = await storage.patch(`item:${item.id}`, { status: "closed", ...extra });
        if (!saved) throw new Error("Close was not saved.");
        setItems?.((prev) => prev.map((i) => (i.id === item.id ? saved : i)));
        itemBefore = item;
      }

      const archivedEvents = [];
      for (const { intent } of before) {
        for (const event of liveEventsFor(events, intent.id)) {
          const archivedEvent = { ...event, archived: true };
          await storage.set(`event:${event.id}`, archivedEvent);
          setEvents((prev) => prev.map((e) => (e.id === event.id ? archivedEvent : e)));
          archivedEvents.push(event);
        }
      }
      let cancelledReminders = [];
      try {
        for (const { intent } of before) cancelledReminders.push(...(await cancelRemindersForStatus(intent.id)));
      } catch (err) {
        console.error("[Reminders] cancel on close failed:", err);
        window.alert("Closed, but its reminders could not be cancelled and may still fire.");
      }
      if (before.length) refreshReminderIndex?.();

      // What the reason writes. After the status moves, so the execution's insert
      // cannot activate a someday intention on its way to closed.
      let createdExecution = null;
      let createdEvent = null;
      let createdNote = null;
      if (reason === "done" && picked && !picked.lastCompletedAt) {
        let event = pickedLive;
        if (!event) {
          createdEvent = {
            id: uid(),
            user_id: user.id,
            intentId: picked.id,
            time: day,
            itemIds: picked.itemId ? [picked.itemId] : [],
            contextId: picked.contextId || null,
            collectionId: picked.collectionId || null,
            archived: true,
            createdAt: new Date().toISOString(),
          };
          if (!(await storage.set(`event:${createdEvent.id}`, createdEvent))) throw writeError("Recording the completion");
          setEvents((prev) => [...prev, createdEvent]);
          event = createdEvent;
        }
        createdExecution = {
          id: uid(),
          user_id: user.id,
          eventId: event.id,
          intentId: picked.id,
          contextId: picked.contextId || null,
          collectionId: picked.collectionId || null,
          itemIds: event.itemIds || [],
          startedAt: closedAt,
          closedAt,
          status: "closed",
          outcome: "done",
          elements: [],
          progress: [],
        };
        if (!(await storage.set(`execution:${createdExecution.id}`, createdExecution))) throw writeError("Recording the completion");
        if (note.trim()) await saveNote({ body: note, targetType: "intention", targetId: picked.id, executionId: createdExecution.id });
      } else if (note.trim()) {
        const target = item ? { targetType: "item", targetId: item.id } : { targetType: "intention", targetId: (picked || targets[0])?.id };
        if (target.targetId) createdNote = await saveNote({ body: note, ...target });
      }
      if (createdExecution) {
        await refreshClosed(targets, item);
        completionsChanged();
      }

      const what = statusUndoWhat(archivedEvents.length, cancelledReminders.length);
      // Someday comes back too once Step 11's guard allows closed -> someday (Undo window).
      const restorable = (s) => Boolean(s) && (CLOSE_REASON_SAVED || s !== "someday");
      const futureEvents = archivedEvents.filter((e) => String(e.time).slice(0, 10) >= today);
      const canUndo =
        before.some(({ intent, stop }) => stop || restorable(intent.status)) ||
        restorable(itemBefore?.status) || futureEvents.length > 0 || cancelledReminders.length > 0 ||
        Boolean(createdExecution || createdNote);
      // Nothing to put back (all were someday, which status_guard refuses): a plain notice.
      offerUndoFor(`Closed "${label}"${what}.`, canUndo ? async () => {
        // What the close created goes first (the execution's note cascades with it).
        if (createdExecution && !(await storage.delete(`execution:${createdExecution.id}`))) throw writeError("Removing the completion");
        if (createdEvent) {
          if (!(await storage.delete(`event:${createdEvent.id}`))) throw writeError("Removing the completion");
          setEvents((prev) => prev.filter((e) => e.id !== createdEvent.id));
        }
        if (createdNote) await deleteNote(createdNote.id);
        for (const { intent, stop } of before) {
          const fields = {
            ...(restorable(intent.status) ? { status: intent.status } : {}),
            ...(stop ? { endDate: intent.endDate || null } : {}),
            ...restoredCloseFields(intent),
          };
          if (!Object.keys(fields).length) continue;
          const back = await storage.patch(`intent:${intent.id}`, fields);
          if (!back) throw writeError("Restoring the intention");
          setIntents((prev) => prev.map((i) => (i.id === intent.id ? back : i)));
        }
        if (restorable(itemBefore?.status)) {
          const back = await storage.patch(`item:${itemBefore.id}`, {
            status: itemBefore.status,
            ...restoredCloseFields(itemBefore),
          });
          if (!back) throw writeError("Restoring the item");
          setItems?.((prev) => prev.map((i) => (i.id === itemBefore.id ? back : i)));
        }
        for (const event of futureEvents) {
          if (!(await storage.set(`event:${event.id}`, event))) throw writeError("Restoring its event");
          setEvents((prev) => prev.map((e) => (e.id === event.id ? event : e)));
        }
        if (cancelledReminders.length) {
          await restoreRemindersAfterStatus(cancelledReminders);
          refreshReminderIndex?.();
        }
        // last_completed_at falls back by itself (the 100 trigger); the rows re-read it.
        if (createdExecution) {
          await refreshClosed(targets, item);
          completionsChanged();
        }
      } : null);
    });
  }

  // Re-reads the records a close touched, for last_completed_at (set by triggers).
  async function refreshClosed(targets, item) {
    for (const intent of targets) {
      const fresh = await storage.get(`intent:${intent.id}`);
      if (fresh) setIntents((prev) => prev.map((i) => (i.id === fresh.id ? fresh : i)));
    }
    if (item && setItems) {
      const fresh = await storage.get(`item:${item.id}`);
      if (fresh) setItems((prev) => prev.map((i) => (i.id === fresh.id ? fresh : i)));
    }
  }

  return { moveToPlanner, scheduleFromItem, updateIntent, archiveIntention, setIntentionStatus, stopRepeat, closeRecords };
}
