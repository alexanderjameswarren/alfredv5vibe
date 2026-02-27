/**
 * Recurrence date calculation utility for Alfred v5 Phase 8.
 *
 * Pure function — no side effects, no app imports, no React.
 * Uses only native Date. ISO day numbers: 1=Monday, 7=Sunday.
 * All week alignment normalizes to Monday as start of week.
 */

// ─── Normalization Helper ────────────────────────────────────────────────────

/**
 * Returns a normalized recurrence config object for an intent.
 *
 * During the transition from the old `recurrence` TEXT column to the new
 * `recurrenceConfig` JSONB column, this helper bridges both formats.
 * Prefers `recurrenceConfig` when present; falls back to mapping the
 * legacy `recurrence` string ("daily", "weekly", "monthly", "once").
 *
 * @param {Object} intent - An intent object (camelCase, after toCamelCase conversion)
 * @returns {Object} A recurrence_config object (e.g., { type: "fixed", frequency: "daily", interval: 1 })
 */
export function getRecurrenceConfig(intent) {
  if (intent.recurrenceConfig) return intent.recurrenceConfig;
  switch (intent.recurrence) {
    case 'daily':
      return { type: 'fixed', frequency: 'daily', interval: 1 };
    case 'weekly':
      return { type: 'fixed', frequency: 'weekly', interval: 1, daysOfWeek: [] };
    case 'monthly':
      return { type: 'fixed', frequency: 'monthly', interval: 1 };
    default:
      return { type: 'once' };
  }
}

// ─── Main Export ────────────────────────────────────────────────────────────

/**
 * Calculates the next event date based on a recurrence configuration.
 *
 * @param {Object} config - A recurrence_config JSONB object from the intents table.
 *   Shapes: { type: "once" } | { type: "fixed", frequency, interval, ... } | { type: "interval", every, unit }
 * @param {Date} referenceDate - For fixed types: today. For interval types: the completion date.
 * @returns {Date|null} The next event date (midnight local time), or null if no recurrence.
 */
export function calculateNextEventDate(config, referenceDate) {
  if (!config || config.type === 'once') return null;

  const ref = new Date(referenceDate);
  ref.setHours(0, 0, 0, 0);

  if (config.type === 'fixed') {
    switch (config.frequency) {
      case 'daily':
        return fixedDaily(config, ref);
      case 'weekly':
        return fixedWeekly(config, ref);
      case 'monthly':
        if (config.ordinal) return fixedMonthlyOrdinal(config, ref);
        return fixedMonthlyDayOfMonth(config, ref);
      default:
        return null;
    }
  }

  if (config.type === 'interval') {
    return intervalFromCompletion(config, ref);
  }

  return null;
}

// ─── Date Helpers ───────────────────────────────────────────────────────────

/**
 * Parses a "YYYY-MM-DD" string as a local-time Date at midnight.
 * Avoids the UTC-parsing pitfall of `new Date("YYYY-MM-DD")`.
 */
function parseLocalDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/** Returns the Monday of the week containing the given date. */
function startOfWeek(date) {
  const d = new Date(date);
  const jsDay = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = jsDay === 0 ? -6 : 1 - jsDay;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Gets the ISO day-of-week (1=Mon, 7=Sun) for a Date. */
function isoDay(date) {
  const jsDay = date.getDay(); // 0=Sun
  return jsDay === 0 ? 7 : jsDay;
}

/** Returns the number of days in a given month (0-indexed JS month). */
function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

/** Adds `n` days to a date and returns a new Date at midnight. */
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Adds `n` months to a date, clamping day-of-month to the target month's length.
 * E.g., Jan 31 + 1 month → Feb 28 (or 29 in a leap year).
 */
function addMonths(date, n) {
  const d = new Date(date);
  const dayOfMonth = d.getDate();
  d.setDate(1); // avoid day overflow during month arithmetic
  d.setMonth(d.getMonth() + n);
  const maxDay = daysInMonth(d.getFullYear(), d.getMonth());
  d.setDate(Math.min(dayOfMonth, maxDay));
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Number of whole days between two midnight-normalised dates.
 * Returns (b - a) in days.
 */
function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// ─── 3a: Fixed Daily ────────────────────────────────────────────────────────

/**
 * Fixed daily recurrence.
 *
 * - interval=1 (95% case): returns tomorrow.
 * - interval>1: returns the first day strictly after referenceDate where
 *   daysSince(anchorDate, candidate) is divisible by interval.
 *   anchorDate establishes the cadence origin for multi-day intervals.
 *
 * @param {Object} config - { frequency: "daily", interval: number, anchorDate?: string }
 * @param {Date} ref - referenceDate normalised to midnight
 * @returns {Date}
 */
function fixedDaily(config, ref) {
  const interval = config.interval || 1;
  let candidate = addDays(ref, 1);

  if (interval === 1) return candidate;

  // interval > 1: need anchorDate for modular arithmetic
  const anchor = config.anchorDate ? parseLocalDate(config.anchorDate) : ref;

  const MAX_ITER = 400;
  for (let i = 0; i < MAX_ITER; i++) {
    const diff = daysBetween(anchor, candidate);
    if (((diff % interval) + interval) % interval === 0) {
      return candidate;
    }
    candidate = addDays(candidate, 1);
  }

  return null; // safety valve — should never reach here
}

// ─── 3b: Fixed Weekly ───────────────────────────────────────────────────────

/**
 * Fixed weekly recurrence.
 *
 * Finds the first day strictly after referenceDate that:
 *   1. Has an ISO day-of-week present in config.daysOfWeek
 *   2. Falls in a valid week per interval + anchorDate alignment
 *
 * For interval=1 only condition 1 is checked.
 * For interval>1 both conditions must hold. anchorDate establishes which
 * week is "week 0" — week alignment is computed by normalising both
 * anchor and candidate to their Monday (start of ISO week).
 *
 * @param {Object} config - { frequency: "weekly", interval, daysOfWeek: number[], anchorDate?: string }
 * @param {Date} ref - referenceDate normalised to midnight
 * @returns {Date|null}
 */
function fixedWeekly(config, ref) {
  const { daysOfWeek = [], interval = 1 } = config;
  if (daysOfWeek.length === 0) return null;

  const daysSet = new Set(daysOfWeek);
  let candidate = addDays(ref, 1);

  // Pre-compute anchor week start for multi-week intervals
  let anchorWeekStart = null;
  if (interval > 1) {
    const anchor = config.anchorDate ? parseLocalDate(config.anchorDate) : ref;
    anchorWeekStart = startOfWeek(anchor);
  }

  const MAX_ITER = 400;
  for (let i = 0; i < MAX_ITER; i++) {
    if (daysSet.has(isoDay(candidate))) {
      if (interval === 1) {
        return candidate;
      }
      // Check week alignment for multi-week intervals
      const candidateWeekStart = startOfWeek(candidate);
      const weeksDiff = Math.round(
        (candidateWeekStart.getTime() - anchorWeekStart.getTime()) / (7 * 86400000)
      );
      const isValidWeek = ((weeksDiff % interval) + interval) % interval === 0;
      if (isValidWeek) {
        return candidate;
      }
    }
    candidate = addDays(candidate, 1);
  }

  return null; // safety valve
}

// ─── 3c: Fixed Monthly — Day of Month ───────────────────────────────────────

/**
 * Fixed monthly recurrence by day of month.
 *
 * Tries the target dayOfMonth in the current month first. If that day
 * is not strictly after referenceDate, advances by `interval` months.
 * Clamps dayOfMonth to the last day of the target month when the month
 * is too short (e.g., dayOfMonth=31 in a 30-day month).
 *
 * If no dayOfMonth is in the config (e.g., migrated data), falls back
 * to referenceDate's day of month.
 *
 * @param {Object} config - { frequency: "monthly", interval, dayOfMonth?: number }
 * @param {Date} ref - referenceDate normalised to midnight
 * @returns {Date}
 */
function fixedMonthlyDayOfMonth(config, ref) {
  const interval = config.interval || 1;
  const dayOfMonth = config.dayOfMonth || ref.getDate();

  let year = ref.getFullYear();
  let month = ref.getMonth();

  // Try current month
  const maxDay = daysInMonth(year, month);
  const clampedDay = Math.min(dayOfMonth, maxDay);
  const candidate = new Date(year, month, clampedDay);
  candidate.setHours(0, 0, 0, 0);

  if (candidate > ref) {
    return candidate;
  }

  // Advance by interval months
  const next = new Date(year, month + interval, 1);
  const nextMaxDay = daysInMonth(next.getFullYear(), next.getMonth());
  const nextClampedDay = Math.min(dayOfMonth, nextMaxDay);
  const result = new Date(next.getFullYear(), next.getMonth(), nextClampedDay);
  result.setHours(0, 0, 0, 0);
  return result;
}

// ─── 3d: Fixed Monthly — Ordinal Weekday ────────────────────────────────────

/**
 * Finds the nth occurrence of a specific weekday in a month, or the
 * nth weekday (Mon-Fri) if dayOfWeek === "weekday".
 *
 * @param {number} year
 * @param {number} month - 0-indexed JS month
 * @param {string} ordinal - "first" | "second" | "third" | "fourth" | "last"
 * @param {number|string} dayOfWeek - ISO day 1–7 or "weekday" for Mon–Fri
 * @returns {Date|null}
 */
function nthWeekdayOfMonth(year, month, ordinal, dayOfWeek) {
  if (dayOfWeek === 'weekday') {
    return nthBusinessDayOfMonth(year, month, ordinal);
  }

  // Convert ISO day (1=Mon, 7=Sun) to JS day (0=Sun, 1=Mon, ..., 6=Sat)
  const jsDow = dayOfWeek === 7 ? 0 : dayOfWeek;

  if (ordinal === 'last') {
    const lastDay = daysInMonth(year, month);
    let d = new Date(year, month, lastDay);
    // Walk backward at most 7 days to find the target weekday
    for (let i = 0; i < 7; i++) {
      if (d.getDay() === jsDow) {
        d.setHours(0, 0, 0, 0);
        return d;
      }
      d.setDate(d.getDate() - 1);
    }
    return null;
  }

  const ordinalIndex = { first: 0, second: 1, third: 2, fourth: 3 };
  const idx = ordinalIndex[ordinal];
  if (idx === undefined) return null;

  // Find first occurrence of jsDow in the month
  let d = new Date(year, month, 1);
  while (d.getDay() !== jsDow) {
    d.setDate(d.getDate() + 1);
  }

  // Advance by ordinalIndex weeks
  d.setDate(d.getDate() + idx * 7);

  // Verify still in the same month
  if (d.getMonth() !== month) return null;

  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Finds the nth weekday (Mon–Fri) of a month, or the last weekday.
 *
 * "first" = first Mon–Fri of the month (usually the 1st or 2nd/3rd if month starts on weekend).
 * "last"  = last Mon–Fri of the month.
 *
 * @param {number} year
 * @param {number} month - 0-indexed JS month
 * @param {string} ordinal - "first" | "second" | "third" | "fourth" | "last"
 * @returns {Date|null}
 */
function nthBusinessDayOfMonth(year, month, ordinal) {
  if (ordinal === 'last') {
    const lastDay = daysInMonth(year, month);
    let d = new Date(year, month, lastDay);
    // Walk backward at most 7 days to find a Mon–Fri
    for (let i = 0; i < 7; i++) {
      const dow = d.getDay();
      if (dow >= 1 && dow <= 5) {
        d.setHours(0, 0, 0, 0);
        return d;
      }
      d.setDate(d.getDate() - 1);
    }
    return null;
  }

  const ordinalMap = { first: 1, second: 2, third: 3, fourth: 4 };
  const target = ordinalMap[ordinal];
  if (!target) return null;

  let count = 0;
  const maxDays = daysInMonth(year, month);
  for (let day = 1; day <= maxDays; day++) {
    const d = new Date(year, month, day);
    const dow = d.getDay();
    if (dow >= 1 && dow <= 5) {
      count++;
      if (count === target) {
        d.setHours(0, 0, 0, 0);
        return d;
      }
    }
  }

  return null;
}

/**
 * Fixed monthly recurrence by ordinal weekday.
 *
 * E.g., first Monday, last Friday, first weekday, third Wednesday, etc.
 * Tries the target ordinal weekday in the current month. If not strictly
 * after referenceDate, advances by `interval` months and recalculates.
 *
 * @param {Object} config - { frequency: "monthly", interval, ordinal: string, dayOfWeek: number|string }
 * @param {Date} ref - referenceDate normalised to midnight
 * @returns {Date|null}
 */
function fixedMonthlyOrdinal(config, ref) {
  const interval = config.interval || 1;
  const { ordinal, dayOfWeek } = config;

  let year = ref.getFullYear();
  let month = ref.getMonth();

  // Try current month
  const candidate = nthWeekdayOfMonth(year, month, ordinal, dayOfWeek);
  if (candidate && candidate > ref) {
    return candidate;
  }

  // Advance by interval months and recalculate
  const next = new Date(year, month + interval, 1);
  return nthWeekdayOfMonth(next.getFullYear(), next.getMonth(), ordinal, dayOfWeek);
}

// ─── 3e: Interval From Completion ───────────────────────────────────────────

/**
 * Interval-based recurrence: adds the configured interval to the
 * reference (completion) date.
 *
 * - "days":   referenceDate + every days
 * - "weeks":  referenceDate + every * 7 days
 * - "months": referenceDate + every months (with end-of-month clamping)
 *
 * @param {Object} config - { every: number, unit: "days"|"weeks"|"months" }
 * @param {Date} ref - completion date normalised to midnight
 * @returns {Date|null}
 */
function intervalFromCompletion(config, ref) {
  const { every, unit } = config;
  if (!every || !unit) return null;

  switch (unit) {
    case 'days':
      return addDays(ref, every);
    case 'weeks':
      return addDays(ref, every * 7);
    case 'months':
      return addMonths(ref, every);
    default:
      return null;
  }
}
