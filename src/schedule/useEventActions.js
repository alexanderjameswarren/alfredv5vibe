import { storage, writeError } from "../utils/storage";
import { uid } from "../utils/flattenElements";
import { getTodayDate } from "../utils/eventDates";
import { getRecurrenceConfig, nextOccurrence } from "../utils/recurrence";
import { liveEventsFor, statusOf } from "../utils/status";
import { assertNoActiveRun } from "../utils/runGuard";
import { supabase } from "../supabaseClient";
import { longDate } from "../utils/recurrenceDisplay";
import { completionsChanged } from "../notes/notesApi";

export const SKIP_BLOCKED = "An execution is in progress. Continue or delete it before skipping.";

const isRepeating = (intent) => Boolean(intent) && getRecurrenceConfig(intent).type !== "once";

/** Asked at the moment of the write: a skip never lands beside an open execution. */
async function assertNoOpenExecution(intentId) {
  const { data, error } = await supabase
    .from("executions")
    .select("id")
    .eq("intent_id", intentId)
    .is("closed_at", null)
    .limit(1);
  if (error) throw new Error("Could not check for an open execution.");
  if (data?.length) throw new Error(SKIP_BLOCKED);
}

// Event writers, moved out of Alfred.jsx unchanged. Holds no state: everything it
// reads or sets is Alfred's, passed in.
export function useEventActions({
  user,
  events,
  setEvents,
  intents,
  withLoading,
  offerUndoFor,
}) {
  async function updateEvent(eventId, updates) {
    const event = events.find((e) => e.id === eventId);
    if (!event) return;
    return withLoading('Saving...', async () => {
      if (updates.time && updates.time !== event.time) await assertNoActiveRun(event.id);
      const intent = intents.find((i) => i.id === event.intentId);
      // Archiving a repeating intention's live date is a Skip (Step 9): it writes a
      // closed execution with outcome "skipped", which never counts as a completion.
      const skipping = updates.archived === true && !event.archived && isRepeating(intent);
      let skipped = null;
      if (skipping) {
        await assertNoOpenExecution(intent.id);
        const now = new Date().toISOString();
        skipped = {
          id: uid(),
          user_id: user.id,
          eventId: event.id,
          intentId: intent.id,
          contextId: intent.contextId || null,
          collectionId: intent.collectionId || null,
          itemIds: event.itemIds || [],
          startedAt: now,
          closedAt: now,
          status: "closed",
          outcome: "skipped",
          elements: [],
          progress: [],
        };
        if (!(await storage.set(`execution:${skipped.id}`, skipped))) throw writeError("Skipping it");
      }
      const updated = { ...event, ...updates };
      const savedEvent = await storage.set(`event:${event.id}`, updated);
      if (!savedEvent) throw writeError("The event");
      setEvents(events.map((e) => (e.id === eventId ? savedEvent : e)));

      // If archiving a recurring event, trigger recurrence to create next event
      let successor = null;
      if (updates.archived === true && event.intentId) {
        // Archiving a live event is skipping it: an interval counts from its date.
        successor = await triggerRecurrence(event.intentId, event, { skipped: true });
      }
      if (skipped) completionsChanged();

      if (updates.archived === true) {
        const label = event.text || intent?.text || "event";
        const day = String(event.time || "").slice(0, 10);
        const message = skipped ? `Skipped ${longDate(day, getTodayDate())}.` : `Archived "${label}".`;
        offerUndoFor(message, async () => {
          // The skip goes first, and a failed delete stops the Undo: restoring the
          // date while the skip stays would leave a skip of a date that is live again.
          if (skipped && !(await storage.delete(`execution:${skipped.id}`))) throw writeError("Removing the skip");
          // The successor only exists because of the archive being undone, so
          // it goes with it. Deleting rather than archiving: it was never a
          // real event the user saw, and an archived ghost would surface in the
          // recycle bin as something they never scheduled. Deleted FIRST: one
          // live event per intention, so the original cannot return beside it.
          if (successor) {
            if (!(await storage.delete(`event:${successor.id}`))) throw writeError("Removing the next date");
            setEvents((prev) => prev.filter((e) => e.id !== successor.id));
          }
          if (!(await storage.set(`event:${event.id}`, event))) throw writeError("Restoring the event");
          setEvents((prev) => prev.map((e) => (e.id === eventId ? event : e)));
          if (skipped) completionsChanged();
        });
      }
    });
  }

  /**
   * Creates the next recurring event for an intent after an event is archived.
   * Shared by closeExecution (completion) and manual event archive (skip).
   */
  // Returns the successor event it created, or null when it created none — so
  // an undo of the archive that triggered it can take that successor back out.
  // Without this, undoing left the successor behind and the intention ended up
  // with two live events.
  // `nextDate` ("YYYY-MM-DD") is used as given (the completion dialog's edit, Step 7);
  // otherwise nextOccurrence decides, by completion or by `skipped`.
  async function triggerRecurrence(intentId, archivedEvent, { nextDate: chosen = null, skipped = false } = {}) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return null;

    const config = getRecurrenceConfig(intent);
    if (config.type === "once") return null;

    // Only an active intention recurs. A successor for one parked in background
    // would be flipped straight back to active by the event trigger (088).
    // Read fresh: state can lag the database's own status moves.
    const fresh = await storage.get(`intent:${intentId}`);
    if (statusOf(fresh || intent) !== "active") return null;

    // One live event per intention: if another is still live (overdue counts),
    // it already carries the recurrence. `events` still holds the archived one.
    if (liveEventsFor(events, intent.id).some((e) => e.id !== archivedEvent?.id)) {
      return null;
    }

    const today = getTodayDate();
    const nextDate =
      chosen ||
      nextOccurrence(config, {
        eventDate: archivedEvent?.time ? String(archivedEvent.time).slice(0, 10) : null,
        completedOn: today,
        today,
        skipped,
      });

    if (nextDate && (!intent.endDate || nextDate <= intent.endDate)) {
      const newEvent = {
        id: uid(),
        user_id: user.id,
        intentId: intent.id,
        time: nextDate,
        itemIds: archivedEvent?.itemIds || [],
        contextId: intent.contextId,
        collectionId: intent.collectionId || null,
        archived: false,
        createdAt: new Date().toISOString(),
      };
      const savedEvent = await storage.set(`event:${newEvent.id}`, newEvent);
      // Not thrown: the run that triggered this has already closed. Logged by storage.
      if (!savedEvent) return null;
      setEvents((prev) => [...prev, savedEvent]);
      return newEvent;
    }
    return null;
  }

  return { updateEvent, triggerRecurrence };
}
