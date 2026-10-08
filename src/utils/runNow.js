import { getRecurrenceConfig } from "./recurrence";

const dateOf = (event) => String(event?.time || "").slice(0, 10);

function liveEventsFor(intentId, events, excludeEventId) {
  return events
    .filter((e) => e.intentId === intentId && !e.archived && e.id !== excludeEventId)
    .sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
}

/**
 * The live intention Run Now on an item should attach to, and its earliest live
 * event, or null when there is none and a new one-off is right.
 * Precedence: recurring first (earliest live event wins), then the newest one-off.
 */
export function runNowTargetForItem(itemId, intents, events) {
  const candidates = intents
    // Closed is over for good (nothing pulls a row out of it), so never a target.
    .filter((i) => !i.archived && i.status !== "closed" && i.itemId === itemId)
    .map((intent) => ({ intent, event: liveEventsFor(intent.id, events)[0] || null }));
  if (candidates.length === 0) return null;

  const recurring = candidates.filter((c) => getRecurrenceConfig(c.intent).type !== "once");
  if (recurring.length > 0) {
    // An intention with no live event sorts after any that has one.
    return recurring.sort((a, b) =>
      (dateOf(a.event) || "9999").localeCompare(dateOf(b.event) || "9999"),
    )[0];
  }
  return candidates.sort((a, b) =>
    String(b.intent.createdAt || "").localeCompare(String(a.intent.createdAt || "")),
  )[0];
}

/**
 * Which of the item's intentions its buttons act on: one with an OPEN (active or
 * paused) execution first, so the item reads Continue while any run is going;
 * otherwise runNowTargetForItem's pick. Same shape, `{ intent, event }`.
 */
export function itemActionTarget(itemId, intents, events, openExecutions) {
  const running = openExecutions
    .map((x) => intents.find((i) => i.id === x.intentId && i.itemId === itemId && !i.archived))
    .find(Boolean);
  if (running) return { intent: running, event: liveEventsFor(running.id, events)[0] || null };
  return runNowTargetForItem(itemId, intents, events);
}

/** Is the event dated today or earlier, so Run Now should start it rather than add one? */
export function isDueBy(event, today) {
  return Boolean(event) && dateOf(event) !== "" && dateOf(event) <= today;
}

/**
 * Does the intention already have a live event after `today`, other than the one
 * just archived? If so, a recurrence successor would be a duplicate.
 * `excludeEventId` matters because callers pass `events` from a closure that
 * still holds the just-archived event as live.
 */
export function hasFutureLiveEvent(intentId, events, excludeEventId, today) {
  return liveEventsFor(intentId, events, excludeEventId).some((e) => dateOf(e) > today);
}
