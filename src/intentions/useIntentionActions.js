import { storage } from "../utils/storage";
import { uid } from "../utils/flattenElements";
import { getTodayDate, formatEventDate } from "../utils/eventDates";
import { intentionUpdateRow } from "../utils/intentionRows";

// Intention writers, moved out of Alfred.jsx unchanged. Holds no state: everything
// it reads or sets is Alfred's, passed in.
export function useIntentionActions({
  user,
  intents,
  setIntents,
  events,
  setEvents,
  view,
  setView,
  setSelectedIntentionId,
  intentionReturnView,
  withLoading,
  offerUndoFor,
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

      // Create event for this intent
      const event = {
        id: uid(),
        user_id: user.id,
        intentId,
        time: eventDate,
        itemIds: intent.itemId ? [intent.itemId] : [],
        contextId: intent.contextId,
        collectionId: intent.collectionId || null,
        archived: false,
        createdAt: new Date().toISOString(),
      };

      const savedEvent = await storage.set(`event:${event.id}`, event);
      setEvents([...events, savedEvent || event]);

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
      offerUndoFor(`Scheduled for ${formatEventDate(eventDate)}.`, async () => {
        await storage.delete(`event:${event.id}`);
        setEvents((prev) => prev.filter((e) => e.id !== event.id));
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
      setIntents(intents.map((i) => (i.id === intentId ? savedIntent || updated : i)));

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
      setIntents(intents.map((i) => (i.id === intentId ? archivedIntent : i)));

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
        await storage.set(`intent:${intentId}`, intent);
        setIntents((prev) => prev.map((i) => (i.id === intentId ? intent : i)));
        for (const event of relatedEvents) {
          await storage.set(`event:${event.id}`, event);
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

  return { moveToPlanner, updateIntent, archiveIntention };
}
