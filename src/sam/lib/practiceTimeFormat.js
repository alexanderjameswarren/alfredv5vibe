// Practice-time formatting + Pacific-time date helpers.
//
// All practice-time displays in SAM go through these. Every duration in the
// UI is whole minutes (or whole hours for the per-song Total), so no consumer
// should be formatting seconds-to-minutes itself.
//
// Pacific time (America/Los_Angeles) is hardcoded throughout — sessions are
// bucketed by their start day in PT, never by browser local time.

const PT_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const PT_DAY_NAME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "long",
});

/**
 * YYYY-MM-DD key for the Pacific calendar date that `dateInput` falls on.
 * Accepts a Date, an ISO string, or anything `new Date(...)` understands.
 * en-CA locale formats as `YYYY-MM-DD` natively.
 */
export function ptDateKey(dateInput) {
  return PT_DATE_FORMATTER.format(new Date(dateInput));
}

/**
 * Long-form English weekday for the PT date of `dateInput` (e.g. "Monday").
 */
export function ptDayName(dateInput) {
  return PT_DAY_NAME_FORMATTER.format(new Date(dateInput));
}

/**
 * Subtract `daysBack` calendar days from a YYYY-MM-DD key, returning a new
 * YYYY-MM-DD key. Uses UTC calendar-component arithmetic, so DST transitions
 * don't shift the result. The output is a canonical PT-date key when the
 * input is one.
 */
export function dateKeyMinusDays(key, daysBack) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - daysBack));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Long-form English weekday for a YYYY-MM-DD PT date key. Asks `ptDayName`
 * about UTC noon on that calendar date — noon UTC is mid-morning PT (PDT
 * or PST), comfortably away from the midnight boundary in either direction.
 */
export function ptDayNameFromKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return ptDayName(new Date(Date.UTC(y, m - 1, d, 12, 0, 0)));
}

/**
 * Integer calendar days between two YYYY-MM-DD keys (later minus earlier).
 * Uses UTC-anchored timestamps of the calendar components, so DST doesn't
 * distort the count. `daysBetween("2026-07-30", "2026-07-31")` → 1.
 */
export function daysBetween(earlierKey, laterKey) {
  const [ya, ma, da] = earlierKey.split("-").map(Number);
  const [yb, mb, db] = laterKey.split("-").map(Number);
  const ta = Date.UTC(ya, ma - 1, da);
  const tb = Date.UTC(yb, mb - 1, db);
  return Math.round((tb - ta) / 86400000);
}

/**
 * Compact "Xh Ym" / "X minutes" form. Used in the 7-day snapshot and the
 * live "Today" counter.
 *
 *   0   → "0 minutes"
 *   1   → "1 minute"
 *   25  → "25 minutes"
 *   60  → "1h"
 *   63  → "1h 3m"
 *   120 → "2h"
 *   125 → "2h 5m"
 */
export function formatMinutesShort(mins) {
  const m = Math.max(0, Math.round(mins));
  if (m === 0) return "0 minutes";
  if (m === 1) return "1 minute";
  if (m < 60) return `${m} minutes`;
  const hours = Math.floor(m / 60);
  const rem = m % 60;
  if (rem === 0) return `${hours}h`;
  return `${hours}h ${rem}m`;
}

/**
 * Long-form "X hours Y minutes" / "X minutes" form. Used in the StatsBar
 * stopped-state "Today" display.
 *
 *   0   → "0 minutes"
 *   1   → "1 minute"
 *   25  → "25 minutes"
 *   60  → "1 hour"
 *   61  → "1 hour 1 minute"
 *   63  → "1 hour 3 minutes"
 *   120 → "2 hours"
 *   125 → "2 hours 5 minutes"
 */
export function formatMinutesLong(mins) {
  const m = Math.max(0, Math.round(mins));
  if (m === 0) return "0 minutes";
  if (m === 1) return "1 minute";
  if (m < 60) return `${m} minutes`;
  const hours = Math.floor(m / 60);
  const rem = m % 60;
  const hourPart = hours === 1 ? "1 hour" : `${hours} hours`;
  if (rem === 0) return hourPart;
  const minPart = rem === 1 ? "1 minute" : `${rem} minutes`;
  return `${hourPart} ${minPart}`;
}

/**
 * Per-song "Total" form. Always floored to whole hours; sub-hour totals
 * render as "<1 hour" rather than "0 hours".
 *
 *   0       → "<1 hour"
 *   1740    → "<1 hour"   (29 minutes)
 *   3600    → "1 hour"
 *   7200    → "2 hours"
 *   104400  → "29 hours"
 */
export function formatTotalHours(seconds) {
  const hours = Math.floor(Math.max(0, seconds) / 3600);
  if (hours < 1) return "<1 hour";
  if (hours === 1) return "1 hour";
  return `${hours} hours`;
}
