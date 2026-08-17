// Display formatters for the SAM landing page redesign.
//
// One rule: every "today" / "yesterday" / weekday check delegates to
// practiceTimeFormat.js. A hand-rolled Date comparison here would drift out
// of Pacific-time alignment at midnight and permanently if the user practises
// from another timezone. See technical-spec-sam-landing-redesign.md § 5.

import {
  ptDateKey,
  ptDayNameFromKey,
  daysBetween,
} from "./practiceTimeFormat";

// Month/day (short month, unpadded day) — "Jul 12" / "Mar 3".
const PT_MMM_D = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "short",
  day: "numeric",
});

// Month/day/year — "Jul 12, 2024" / "Mar 3, 2024".
const PT_MMM_D_YYYY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "short",
  day: "numeric",
  year: "numeric",
});

// Clock time — "2:14 PM" / "11:05 AM".
const PT_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

// Recent ICU builds emit U+202F (narrow no-break space) before AM/PM where
// older ones emit U+0020. Both render almost identically but compare
// unequal, which would make any assertion on these strings depend on the
// Node build. Normalise once, here, so callers see one shape.
const normalizeSpaces = (s) => s.replace(/\s/g, " ");

/**
 * Format a total practice duration for display.
 *
 * Bands (spec § Formatting rules):
 *   0 / no sessions       → "never played"
 *   0 < seconds < 3600    → "45 min"   (integer minutes)
 *   3600 ≤ seconds < 36000 → "3.5 hours" (one decimal; even 1.0)
 *   seconds ≥ 36000       → "42 hours"  (whole hours)
 */
export function formatDuration(seconds) {
  const s = Number(seconds) || 0;
  if (s <= 0) return "never played";
  if (s < 3600) {
    const mins = Math.max(1, Math.round(s / 60));
    return `${mins} min`;
  }
  if (s < 36000) {
    const hours = s / 3600;
    return `${hours.toFixed(1)} hours`;
  }
  return `${Math.floor(s / 3600)} hours`;
}

/**
 * Format the "last practiced" moment for a session's `started_at`.
 *
 * Bands (spec § Formatting rules):
 *   same PT day as today       → "today"
 *   yesterday's PT day         → "yesterday"
 *   2..7 days ago in PT        → weekday name ("Monday")
 *   older, same PT year        → "Jul 12"
 *   older, different PT year   → "Jul 12, 2024"
 *
 * Returns null when `isoTs` is null / undefined so callers can distinguish
 * "never practiced" from any dated string.
 */
export function formatLastPracticed(isoTs) {
  if (!isoTs) return null;
  const inputKey = ptDateKey(isoTs);
  const todayKey = ptDateKey(new Date());
  const days = daysBetween(inputKey, todayKey);

  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days >= 2 && days <= 7) return ptDayNameFromKey(inputKey);

  const input = new Date(isoTs);
  const inputYear = inputKey.split("-")[0];
  const todayYear = todayKey.split("-")[0];
  return inputYear === todayYear
    ? PT_MMM_D.format(input)
    : PT_MMM_D_YYYY.format(input);
}

/**
 * Format a song's `created_at` for the "added Mar 3, 2:14 PM" caption shown
 * on every song row. Year is appended when the input's PT year differs from
 * the current PT year.
 *
 * The TIME is part of the caption, not decoration. Generating several
 * simplified variants of one song in a single sitting produces rows that are
 * identical on a date-only stamp; the clock time is the only thing on the
 * card that tells them apart and orders them.
 *
 * Returns null for a null/undefined input so callers can omit the caption
 * rather than render "added null".
 */
export function formatCreated(isoTs) {
  if (!isoTs) return null;
  // Checked BEFORE ptDateKey, which formats the Date and throws RangeError on
  // an invalid one. This runs inside a row render, so a bad timestamp would
  // take down the whole library list rather than one caption.
  const input = new Date(isoTs);
  if (Number.isNaN(input.getTime())) return null;
  const inputKey = ptDateKey(isoTs);
  const todayKey = ptDateKey(new Date());
  const inputYear = inputKey.split("-")[0];
  const todayYear = todayKey.split("-")[0];
  const stamp =
    inputYear === todayYear
      ? PT_MMM_D.format(input)
      : PT_MMM_D_YYYY.format(input);
  return normalizeSpaces(`added ${stamp}, ${PT_TIME.format(input)}`);
}
