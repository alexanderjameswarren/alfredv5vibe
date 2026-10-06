import { storage } from "../utils/storage";
import { uid } from "../utils/flattenElements";
import { toLocalDateString } from "../utils/eventDates";
import { calculateNextEventDate, getRecurrenceConfig } from "../utils/recurrence";
import { hasFutureLiveEvent } from "../utils/runNow";

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
      const updated = { ...event, ...updates };
      const savedEvent = await storage.set(`event:${event.id}`, updated);
      setEvents(events.map((e) => (e.id === eventId ? savedEvent || updated : e)));

      // If archiving a recurring event, trigger recurrence to create next event
      let successor = null;
      if (updates.archived === true && event.intentId) {
        successor = await triggerRecurrence(event.intentId, event);
      }

      if (updates.archived === true) {
        const intent = intents.find((i) => i.id === event.intentId);
        const label = event.text || intent?.text || "event";
        offerUndoFor(`Archived "${label}".`, async () => {
          await storage.set(`event:${event.id}`, event);
          setEvents((prev) => prev.map((e) => (e.id === eventId ? event : e)));
          // The successor only exists because of the archive being undone, so
          // it goes with it. Deleting rather than archiving: it was never a
          // real event the user saw, and an archived ghost would surface in the
          // recycle bin as something they never scheduled.
          if (successor) {
            await storage.delete(`event:${successor.id}`);
            setEvents((prev) => prev.filter((e) => e.id !== successor.id));
          }
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

    // A later live event already carries the recurrence (e.g. a Run Now beside a
    // scheduled one); a successor here would put two events on the same day.
    if (hasFutureLiveEvent(intent.id, events, archivedEvent?.id, toLocalDateString(new Date()))) {
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
      setEvents((prev) => [...prev, savedEvent || newEvent]);
      return newEvent;
    }
    return null;
  }

  return { updateEvent, triggerRecurrence };
}
