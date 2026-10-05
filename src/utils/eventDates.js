/**
 * A Date rendered as the "YYYY-MM-DD" the app stores in `events.time`.
 *
 * Built from the LOCAL calendar fields, never `toISOString()`. That method
 * converts to UTC first, which shifts the date across the day boundary by the
 * zone offset:
 *
 *   now, at 18:30 in Pacific     -> UTC is already tomorrow  -> tomorrow's date
 *   local midnight, in Berlin    -> UTC is still yesterday   -> yesterday's date
 *
 * The two directions bit in two different places. `getTodayDate` was wrong every
 * evening in the Americas; `triggerRecurrence`'s serialisation was wrong all day
 * east of Greenwich and only looked right here by accident. One helper, so a
 * third caller cannot pick the broken idiom again.
 *
 * The counterpart for reading is `formatEventDate`, which appends "T00:00:00"
 * before parsing for the same reason, and `parseLocalDate` in utils/recurrence.js.
 */
export function toLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getTodayDate() {
  return toLocalDateString(new Date());
}

export function formatEventDate(dateString) {
  const eventDate = new Date(dateString + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  eventDate.setHours(0, 0, 0, 0);

  const isToday = eventDate.getTime() === today.getTime();

  if (isToday) {
    return 'Today, ' + eventDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  }
  return eventDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}
