import { storage, writeError } from "../utils/storage";
import { uid } from "../utils/flattenElements";
import { toLocalDateString } from "../utils/eventDates";
import { calculateNextEventDate, getRecurrenceConfig } from "../utils/recurrence";
import { liveEventsFor, statusOf } from "../utils/status";
import { assertNoActiveRun } from "../utils/runGuard";

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
      const updated = { ...event, ...updates };
      const savedEvent = await storage.set(`event:${event.id}`, updated);
      if (!savedEvent) throw writeError("The event");
      setEvents(events.map((e) => (e.id === eventId ? savedEvent : e)));

      // If archiving a recurring event, trigger recurrence to create next event
      let successor = null;
      if (updates.archived === true && event.intentId) {
        successor = await triggerRecurrence(event.intentId, event);
      }

      if (updates.archived === true) {
        const intent = intents.find((i) => i.id === event.intentId);
        const label = event.text || intent?.text || "event";
        offerUndoFor(`Archived "${label}".`, async () => {
          // The successor only exists because of the archive being undone, so
          // it goes with it. Deleting rather than archiving: it was never a
          // real event the user saw, and an archived ghost would surface in the
          // recycle bin as something they never scheduled. Deleted FIRST: one
          // live event per intention, so the original cannot return beside it.
          if (successor) {
            await storage.delete(`event:${successor.id}`);
            setEvents((prev) => prev.filter((e) => e.id !== successor.id));
          }
          if (!(await storage.set(`event:${event.id}`, event))) throw writeError("Restoring the event");
          setEvents((prev) => prev.map((e) => (e.id === eventId ? event : e)));
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
  async function triggerRecurrence(intentId, archivedEvent) {
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

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const nextDate = calculateNextEventDate(config, today);

    if (nextDate && (!intent.endDate || nextDate <= new Date(intent.endDate + "T23:59:59"))) {
      const newEvent = {
        id: uid(),
        user_id: user.id,
        intentId: intent.id,
        // Local fields, not toISOString: calculateNextEventDate returns a
        // LOCAL-midnight Date (it normalises with setHours and parses via
        // parseLocalDate), and converting that to UTC moves it back a day in
        // any zone east of Greenwich.
        time: toLocalDateString(nextDate),
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
