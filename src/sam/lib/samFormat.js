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
 * Format a song's `created_at` for the "added Mar 3" caption on the
 * All songs tab. Year is appended when the input's PT year differs from
 * the current PT year.
 */
export function formatCreated(isoTs) {
  if (!isoTs) return null;
  const inputKey = ptDateKey(isoTs);
  const todayKey = ptDateKey(new Date());
  const inputYear = inputKey.split("-")[0];
  const todayYear = todayKey.split("-")[0];
  const input = new Date(isoTs);
  const stamp =
    inputYear === todayYear
      ? PT_MMM_D.format(input)
      : PT_MMM_D_YYYY.format(input);
  return `added ${stamp}`;
}
