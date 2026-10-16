/**
 * Repeats in plain words (Restructure P4 Step 5). The one formatter for every
 * repeat line: rows, intention detail, the repeat picker, inbox triage, recycle bin.
 *
 * Two kinds, and the words say which:
 *   fixed schedule      "Every week on Tuesday"        (the calendar decides)
 *   after completion    "3 weeks after last completion" (the last time decides)
 *
 * Pure — no React, no app state.
 */

const DAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const ORDINAL_WORDS = { first: "first", second: "second", third: "third", fourth: "fourth", last: "last" };

/** "Monday", "Monday and Friday", "Monday, Wednesday and Friday" */
function listWords(words) {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** 1→"1st", 2→"2nd", 11→"11th", 22→"22nd" */
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

const plural = (n, unit) => `${n} ${n === 1 ? unit : `${unit}s`}`;

/** True when the config repeats at all ({type:"once"}, null and unknown shapes do not). */
export function repeats(config) {
  if (!config) return false;
  if (config.type === "interval") return Boolean(config.every && config.unit);
  return config.type === "fixed" && ["daily", "weekly", "monthly"].includes(config.frequency);
}

/** The pattern alone: "Every day", "3 weeks after last completion", "Does not repeat". */
export function repeatPattern(config) {
  if (!repeats(config)) return "Does not repeat";
  if (config.type === "interval") {
    const unit = String(config.unit).replace(/s$/, "");
    return `${plural(config.every, unit)} after last completion`;
  }
  const n = config.interval || 1;
  if (config.frequency === "daily") return n === 1 ? "Every day" : `Every ${n} days`;
  if (config.frequency === "weekly") {
    const every = n === 1 ? "Every week" : `Every ${n} weeks`;
    const days = [...(config.daysOfWeek || [])].sort((a, b) => a - b);
    if (days.length === 0) return `${every}, with no day chosen`;
    if (n === 1 && days.join() === "1,2,3,4,5") return "Every weekday, Monday to Friday";
    if (n === 1 && days.length === 7) return "Every day";
    return `${every} on ${listWords(days.map((d) => DAY_NAMES[d]))}`;
  }
  const every = n === 1 ? "Every month" : `Every ${n} months`;
  if (config.ordinal) {
    const day = config.dayOfWeek === "weekday" ? "weekday" : DAY_NAMES[config.dayOfWeek] || "day";
    return `${every} on the ${ORDINAL_WORDS[config.ordinal] || config.ordinal} ${day}`;
  }
  if (config.dayOfMonth) return `${every} on the ${ordinalSuffix(config.dayOfMonth)}`;
  return `${every}, with no day chosen`;
}

/** "Wednesday, October 15", with the year when it is not this year's. */
export function longDate(dateStr, today) {
  const [y, m, d] = String(dateStr).slice(0, 10).split("-").map(Number);
  const weekday = DAY_NAMES[((new Date(y, m - 1, d).getDay() + 6) % 7) + 1];
  const year = y !== Number(String(today).slice(0, 4)) ? `, ${y}` : "";
  return `${weekday}, ${MONTHS[m - 1]} ${d}${year}`;
}

/** "October 13" (or with the year), for until and ended. */
function shortLongDate(dateStr, today) {
  const [y, m, d] = String(dateStr).slice(0, 10).split("-").map(Number);
  const year = y !== Number(String(today).slice(0, 4)) ? `, ${y}` : "";
  return `${MONTHS[m - 1]} ${d}${year}`;
}

/**
 * The full repeat line: the pattern, "· until …" or "Ended …". No next date: the
 * schedule line beside it always carries the date.
 *   config     the intention's recurrence (getRecurrenceConfig)
 *   endDate    intents.end_date ("YYYY-MM-DD") or null
 *   today      "YYYY-MM-DD"
 */
export function describeRepeat({ config, endDate = null, today }) {
  if (!repeats(config)) return "Does not repeat";
  // Today counts as ended: no occurrence can follow it (Stop writes today).
  if (endDate && endDate <= today) return `Ended ${shortLongDate(endDate, today)}`;
  const text = repeatPattern(config);
  return endDate ? `${text} · until ${shortLongDate(endDate, today)}` : text;
}

/**
 * Pattern plus end date, for the repeat picker and triage, where there is no event yet.
 * Kept under its old name for those callers.
 */
export function getRecurrenceDisplayString(config, endDate, today = null) {
  if (!repeats(config)) return "Does not repeat";
  const text = repeatPattern(config);
  return endDate ? `${text} · until ${shortLongDate(endDate, today || endDate)}` : text;
}
