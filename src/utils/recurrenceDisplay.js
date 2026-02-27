/**
 * Human-readable display string helper for recurrence configurations.
 *
 * Pure function — no side effects, no app imports, no React.
 */

const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_ABBR = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Returns a human-readable display string for a recurrence configuration.
 *
 * @param {Object} config - A recurrence_config JSONB object
 * @param {string} [endDate] - Optional end date string ("YYYY-MM-DD") to append "until ..." suffix
 * @returns {string} e.g. "Weekly on Tuesday", "Every 3 months on the first weekday"
 */
export function getRecurrenceDisplayString(config, endDate) {
  if (!config || config.type === 'once') {
    return 'Does not repeat';
  }

  let text = '';

  if (config.type === 'fixed') {
    text = formatFixed(config);
  } else if (config.type === 'interval') {
    text = formatInterval(config);
  } else {
    return 'Does not repeat';
  }

  if (endDate) {
    text += ` · until ${formatEndDate(endDate)}`;
  }

  return text;
}

/**
 * Formats a fixed-schedule recurrence config into a display string.
 */
function formatFixed(config) {
  const { frequency, interval = 1 } = config;

  switch (frequency) {
    case 'daily':
      return formatDaily(interval);
    case 'weekly':
      return formatWeekly(config);
    case 'monthly':
      return formatMonthly(config);
    default:
      return 'Does not repeat';
  }
}

/** "Every day" or "Every N days" */
function formatDaily(interval) {
  if (interval === 1) return 'Every day';
  return `Every ${interval} days`;
}

/** "Weekly on Tuesday" / "Every 2 weeks on Tuesday" / "Weekly on Mon, Wed, Fri" */
function formatWeekly(config) {
  const { interval = 1, daysOfWeek = [] } = config;

  if (daysOfWeek.length === 0) {
    return interval === 1 ? 'Weekly' : `Every ${interval} weeks`;
  }

  const sorted = [...daysOfWeek].sort((a, b) => a - b);
  const dayStr = sorted.length === 1
    ? DAY_NAMES[sorted[0]]
    : sorted.map((d) => DAY_ABBR[d]).join(', ');

  if (interval === 1) {
    return `Weekly on ${dayStr}`;
  }
  return `Every ${interval} weeks on ${dayStr}`;
}

/** "Monthly on the 15th" / "Monthly on the first Monday" / "Every 3 months on the first weekday" */
function formatMonthly(config) {
  const { interval = 1 } = config;
  const prefix = interval === 1 ? 'Monthly' : `Every ${interval} months`;

  if (config.ordinal) {
    const dayStr = config.dayOfWeek === 'weekday'
      ? 'weekday'
      : DAY_NAMES[config.dayOfWeek] || '';
    return `${prefix} on the ${config.ordinal} ${dayStr}`;
  }

  if (config.dayOfMonth) {
    return `${prefix} on the ${ordinalSuffix(config.dayOfMonth)}`;
  }

  return prefix;
}

/**
 * Formats an interval-from-completion config.
 * "Every 2 days after completion" / "Every 6 months after completion"
 */
function formatInterval(config) {
  const { every, unit } = config;
  if (!every || !unit) return 'After completion';

  // Singularise unit when every === 1 ("Every 1 day" → "Every day")
  const unitStr = every === 1 ? unit.replace(/s$/, '') : unit;

  if (every === 1) {
    return `Every ${unitStr} after completion`;
  }
  return `Every ${every} ${unitStr} after completion`;
}

/** Turns 1→"1st", 2→"2nd", 3→"3rd", 15→"15th", 21→"21st", etc. */
function ordinalSuffix(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** Formats "2026-05-29" → "May 29, 2026" */
function formatEndDate(dateStr) {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const [year, month, day] = dateStr.split('-').map(Number);
  return `${months[month - 1]} ${day}, ${year}`;
}
