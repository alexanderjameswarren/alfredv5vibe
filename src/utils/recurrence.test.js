/**
 * Quick validation script for calculateNextEventDate.
 *
 * Run with: node --experimental-vm-modules src/utils/recurrence.test.js
 * Or via the inline CJS wrapper below (no flag needed).
 */

// CJS-compatible inline import for react-scripts / Node without ESM flags
// We re-implement the function inline to keep this script zero-dependency.
// The real source of truth is recurrence.js — this is a validation harness.

// ─── Inline copy of helpers + main function (for standalone execution) ──────

function parseLocalDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function startOfWeek(date) {
  const d = new Date(date);
  const jsDay = d.getDay();
  const diff = jsDay === 0 ? -6 : 1 - jsDay;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function isoDay(date) {
  const jsDay = date.getDay();
  return jsDay === 0 ? 7 : jsDay;
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addMonths(date, n) {
  const d = new Date(date);
  const dayOfMonth = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const maxDay = daysInMonth(d.getFullYear(), d.getMonth());
  d.setDate(Math.min(dayOfMonth, maxDay));
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function fixedDaily(config, ref) {
  const interval = config.interval || 1;
  let candidate = addDays(ref, 1);
  if (interval === 1) return candidate;
  const anchor = config.anchorDate ? parseLocalDate(config.anchorDate) : ref;
  const MAX_ITER = 400;
  for (let i = 0; i < MAX_ITER; i++) {
    const diff = daysBetween(anchor, candidate);
    if (((diff % interval) + interval) % interval === 0) return candidate;
    candidate = addDays(candidate, 1);
  }
  return null;
}

function fixedWeekly(config, ref) {
  const { daysOfWeek = [], interval = 1 } = config;
  if (daysOfWeek.length === 0) return null;
  const daysSet = new Set(daysOfWeek);
  let candidate = addDays(ref, 1);
  let anchorWeekStart = null;
  if (interval > 1) {
    const anchor = config.anchorDate ? parseLocalDate(config.anchorDate) : ref;
    anchorWeekStart = startOfWeek(anchor);
  }
  const MAX_ITER = 400;
  for (let i = 0; i < MAX_ITER; i++) {
    if (daysSet.has(isoDay(candidate))) {
      if (interval === 1) return candidate;
      const candidateWeekStart = startOfWeek(candidate);
      const weeksDiff = Math.round(
        (candidateWeekStart.getTime() - anchorWeekStart.getTime()) / (7 * 86400000)
      );
      const isValidWeek = ((weeksDiff % interval) + interval) % interval === 0;
      if (isValidWeek) return candidate;
    }
    candidate = addDays(candidate, 1);
  }
  return null;
}

function fixedMonthlyDayOfMonth(config, ref) {
  const interval = config.interval || 1;
  const dayOfMonth = config.dayOfMonth || ref.getDate();
  let year = ref.getFullYear();
  let month = ref.getMonth();
  const maxDay = daysInMonth(year, month);
  const clampedDay = Math.min(dayOfMonth, maxDay);
  const candidate = new Date(year, month, clampedDay);
  candidate.setHours(0, 0, 0, 0);
  if (candidate > ref) return candidate;
  const next = new Date(year, month + interval, 1);
  const nextMaxDay = daysInMonth(next.getFullYear(), next.getMonth());
  const nextClampedDay = Math.min(dayOfMonth, nextMaxDay);
  const result = new Date(next.getFullYear(), next.getMonth(), nextClampedDay);
  result.setHours(0, 0, 0, 0);
  return result;
}

function nthWeekdayOfMonth(year, month, ordinal, dayOfWeek) {
  if (dayOfWeek === 'weekday') return nthBusinessDayOfMonth(year, month, ordinal);
  const jsDow = dayOfWeek === 7 ? 0 : dayOfWeek;
  if (ordinal === 'last') {
    const lastDay = daysInMonth(year, month);
    let d = new Date(year, month, lastDay);
    for (let i = 0; i < 7; i++) {
      if (d.getDay() === jsDow) { d.setHours(0, 0, 0, 0); return d; }
      d.setDate(d.getDate() - 1);
    }
    return null;
  }
  const ordinalIndex = { first: 0, second: 1, third: 2, fourth: 3 };
  const idx = ordinalIndex[ordinal];
  if (idx === undefined) return null;
  let d = new Date(year, month, 1);
  while (d.getDay() !== jsDow) d.setDate(d.getDate() + 1);
  d.setDate(d.getDate() + idx * 7);
  if (d.getMonth() !== month) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function nthBusinessDayOfMonth(year, month, ordinal) {
  if (ordinal === 'last') {
    const lastDay = daysInMonth(year, month);
    let d = new Date(year, month, lastDay);
    for (let i = 0; i < 7; i++) {
      const dow = d.getDay();
      if (dow >= 1 && dow <= 5) { d.setHours(0, 0, 0, 0); return d; }
      d.setDate(d.getDate() - 1);
    }
    return null;
  }
  const ordinalMap = { first: 1, second: 2, third: 3, fourth: 4 };
  const target = ordinalMap[ordinal];
  if (!target) return null;
  const maxDays = daysInMonth(year, month);
  let count = 0;
  for (let day = 1; day <= maxDays; day++) {
    const d = new Date(year, month, day);
    const dow = d.getDay();
    if (dow >= 1 && dow <= 5) {
      count++;
      if (count === target) { d.setHours(0, 0, 0, 0); return d; }
    }
  }
  return null;
}

function fixedMonthlyOrdinal(config, ref) {
  const interval = config.interval || 1;
  const { ordinal, dayOfWeek } = config;
  let year = ref.getFullYear();
  let month = ref.getMonth();
  const candidate = nthWeekdayOfMonth(year, month, ordinal, dayOfWeek);
  if (candidate && candidate > ref) return candidate;
  const next = new Date(year, month + interval, 1);
  return nthWeekdayOfMonth(next.getFullYear(), next.getMonth(), ordinal, dayOfWeek);
}

function intervalFromCompletion(config, ref) {
  const { every, unit } = config;
  if (!every || !unit) return null;
  switch (unit) {
    case 'days': return addDays(ref, every);
    case 'weeks': return addDays(ref, every * 7);
    case 'months': return addMonths(ref, every);
    default: return null;
  }
}

function calculateNextEventDate(config, referenceDate) {
  if (!config || config.type === 'once') return null;
  const ref = new Date(referenceDate);
  ref.setHours(0, 0, 0, 0);
  if (config.type === 'fixed') {
    switch (config.frequency) {
      case 'daily': return fixedDaily(config, ref);
      case 'weekly': return fixedWeekly(config, ref);
      case 'monthly':
        if (config.ordinal) return fixedMonthlyOrdinal(config, ref);
        return fixedMonthlyDayOfMonth(config, ref);
      default: return null;
    }
  }
  if (config.type === 'interval') return intervalFromCompletion(config, ref);
  return null;
}

// ─── Test Harness ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function fmt(d) {
  if (!d) return 'null';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function assert(actual, expected, label) {
  const a = fmt(actual);
  if (a === expected) {
    console.log(`  PASS: ${label}  →  ${a}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}  →  got ${a}, expected ${expected}`);
    failed++;
  }
}

// ─── Test Cases ─────────────────────────────────────────────────────────────

console.log('\n=== calculateNextEventDate Tests ===\n');

// Test 1: Daily, interval=1, today=2026-02-27 → 2026-02-28
console.log('Test 1: Daily interval=1');
assert(
  calculateNextEventDate(
    { type: 'fixed', frequency: 'daily', interval: 1 },
    new Date(2026, 1, 27) // Feb 27
  ),
  '2026-02-28',
  'Daily next day'
);

// Test 2: Weekly on Tuesday (day 2), interval=1, today=2026-02-27 (Friday) → 2026-03-03
console.log('Test 2: Weekly on Tuesday');
assert(
  calculateNextEventDate(
    { type: 'fixed', frequency: 'weekly', interval: 1, daysOfWeek: [2] },
    new Date(2026, 1, 27) // Feb 27 (Friday)
  ),
  '2026-03-03',
  'Next Tuesday from Friday'
);

// Test 3: Biweekly Tuesday, anchor=2026-02-03, today=2026-02-17 → 2026-03-03
console.log('Test 3: Biweekly Tuesday with anchor');
assert(
  calculateNextEventDate(
    {
      type: 'fixed',
      frequency: 'weekly',
      interval: 2,
      daysOfWeek: [2],
      anchorDate: '2026-02-03',
    },
    new Date(2026, 1, 17) // Feb 17 (Tuesday)
  ),
  '2026-03-03',
  'Biweekly skip to valid week'
);

// Test 4: Monthly first Monday, today=2026-02-27 → 2026-03-02
console.log('Test 4: Monthly first Monday');
assert(
  calculateNextEventDate(
    { type: 'fixed', frequency: 'monthly', interval: 1, ordinal: 'first', dayOfWeek: 1 },
    new Date(2026, 1, 27) // Feb 27
  ),
  '2026-03-02',
  'First Monday of March'
);

// Test 5: Monthly first weekday, interval=3, today=2026-04-10 → 2026-07-01
console.log('Test 5: Quarterly first weekday');
assert(
  calculateNextEventDate(
    { type: 'fixed', frequency: 'monthly', interval: 3, ordinal: 'first', dayOfWeek: 'weekday' },
    new Date(2026, 3, 10) // April 10
  ),
  '2026-07-01',
  'First weekday of July (quarterly skip)'
);

// Test 6: Interval 2 days, referenceDate=2026-02-27 → 2026-03-01
console.log('Test 6: Interval 2 days');
assert(
  calculateNextEventDate(
    { type: 'interval', every: 2, unit: 'days' },
    new Date(2026, 1, 27) // Feb 27
  ),
  '2026-03-01',
  '2 days from Feb 27'
);

// Test 7: Interval 6 months, referenceDate=2026-02-21 → 2026-08-21
console.log('Test 7: Interval 6 months');
assert(
  calculateNextEventDate(
    { type: 'interval', every: 6, unit: 'months' },
    new Date(2026, 1, 21) // Feb 21
  ),
  '2026-08-21',
  '6 months from Feb 21'
);

// ─── Additional Edge Cases ──────────────────────────────────────────────────

console.log('\n--- Additional Edge Cases ---\n');

// Once → null
console.log('Edge: once returns null');
assert(
  calculateNextEventDate({ type: 'once' }, new Date(2026, 1, 27)),
  'null',
  'Once type returns null'
);

// Monthly day 31 in February → clamp to Feb 28 (2026 is not a leap year)
console.log('Edge: Monthly day 31 clamped in short month');
assert(
  calculateNextEventDate(
    { type: 'fixed', frequency: 'monthly', interval: 1, dayOfMonth: 31 },
    new Date(2026, 0, 31) // Jan 31
  ),
  '2026-02-28',
  'Day 31 clamped to Feb 28'
);

// Last Friday of February 2026
console.log('Edge: Last Friday of month');
assert(
  calculateNextEventDate(
    { type: 'fixed', frequency: 'monthly', interval: 1, ordinal: 'last', dayOfWeek: 5 },
    new Date(2026, 1, 1) // Feb 1
  ),
  '2026-02-27',
  'Last Friday of Feb 2026'
);

// Interval weeks
console.log('Edge: Interval 2 weeks');
assert(
  calculateNextEventDate(
    { type: 'interval', every: 2, unit: 'weeks' },
    new Date(2026, 1, 27) // Feb 27
  ),
  '2026-03-13',
  '2 weeks from Feb 27'
);

// Multi-day weekly (Mon, Wed, Fri) from Wednesday
// Feb 25 (Wed) → Feb 26 is Thu (not in set) → Feb 27 is Fri (ISO 5, in set)
console.log('Edge: Multi-day weekly Mon/Wed/Fri from Wednesday');
assert(
  calculateNextEventDate(
    { type: 'fixed', frequency: 'weekly', interval: 1, daysOfWeek: [1, 3, 5] },
    new Date(2026, 1, 25) // Feb 25 (Wednesday)
  ),
  '2026-02-27',
  'Next matching day is Friday Feb 27'
);

// Interval months with end-of-month clamping: Aug 31 + 6 months = Feb 28
console.log('Edge: Interval months end-of-month clamp');
assert(
  calculateNextEventDate(
    { type: 'interval', every: 6, unit: 'months' },
    new Date(2026, 7, 31) // Aug 31
  ),
  '2027-02-28',
  'Aug 31 + 6 months = Feb 28 (non-leap)'
);

// ─── Display String Tests ───────────────────────────────────────────────────

// Inline copy of recurrenceDisplay for standalone execution

const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_ABBR = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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

function formatEndDate(dateStr) {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const [year, month, day] = dateStr.split('-').map(Number);
  return `${months[month - 1]} ${day}, ${year}`;
}

function formatDaily(interval) {
  if (interval === 1) return 'Every day';
  return `Every ${interval} days`;
}

function formatWeekly(config) {
  const { interval = 1, daysOfWeek = [] } = config;
  if (daysOfWeek.length === 0) return interval === 1 ? 'Weekly' : `Every ${interval} weeks`;
  const sorted = [...daysOfWeek].sort((a, b) => a - b);
  const dayStr = sorted.length === 1 ? DAY_NAMES[sorted[0]] : sorted.map((d) => DAY_ABBR[d]).join(', ');
  if (interval === 1) return `Weekly on ${dayStr}`;
  return `Every ${interval} weeks on ${dayStr}`;
}

function formatMonthly(config) {
  const { interval = 1 } = config;
  const prefix = interval === 1 ? 'Monthly' : `Every ${interval} months`;
  if (config.ordinal) {
    const dayStr = config.dayOfWeek === 'weekday' ? 'weekday' : DAY_NAMES[config.dayOfWeek] || '';
    return `${prefix} on the ${config.ordinal} ${dayStr}`;
  }
  if (config.dayOfMonth) return `${prefix} on the ${ordinalSuffix(config.dayOfMonth)}`;
  return prefix;
}

function formatInterval(config) {
  const { every, unit } = config;
  if (!every || !unit) return 'After completion';
  const unitStr = every === 1 ? unit.replace(/s$/, '') : unit;
  if (every === 1) return `Every ${unitStr} after completion`;
  return `Every ${every} ${unitStr} after completion`;
}

function getRecurrenceDisplayString(config, endDate) {
  if (!config || config.type === 'once') return 'Does not repeat';
  let text = '';
  if (config.type === 'fixed') {
    const { frequency, interval = 1 } = config;
    switch (frequency) {
      case 'daily': text = formatDaily(interval); break;
      case 'weekly': text = formatWeekly(config); break;
      case 'monthly': text = formatMonthly(config); break;
      default: text = 'Does not repeat';
    }
  } else if (config.type === 'interval') {
    text = formatInterval(config);
  } else {
    return 'Does not repeat';
  }
  if (endDate) text += ` · until ${formatEndDate(endDate)}`;
  return text;
}

function assertStr(actual, expected, label) {
  if (actual === expected) {
    console.log(`  PASS: ${label}  →  "${actual}"`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}  →  got "${actual}", expected "${expected}"`);
    failed++;
  }
}

console.log('\n=== Display String Tests ===\n');

assertStr(
  getRecurrenceDisplayString({ type: 'once' }),
  'Does not repeat', 'once'
);
assertStr(
  getRecurrenceDisplayString({ type: 'fixed', frequency: 'daily', interval: 1 }),
  'Every day', 'daily 1'
);
assertStr(
  getRecurrenceDisplayString({ type: 'fixed', frequency: 'daily', interval: 2 }),
  'Every 2 days', 'daily 2'
);
assertStr(
  getRecurrenceDisplayString({ type: 'fixed', frequency: 'weekly', interval: 1, daysOfWeek: [2] }),
  'Weekly on Tuesday', 'weekly tue'
);
assertStr(
  getRecurrenceDisplayString({ type: 'fixed', frequency: 'weekly', interval: 2, daysOfWeek: [2] }),
  'Every 2 weeks on Tuesday', 'biweekly tue'
);
assertStr(
  getRecurrenceDisplayString({ type: 'fixed', frequency: 'weekly', interval: 1, daysOfWeek: [1, 3, 5] }),
  'Weekly on Mon, Wed, Fri', 'weekly MWF'
);
assertStr(
  getRecurrenceDisplayString({ type: 'fixed', frequency: 'monthly', interval: 1, dayOfMonth: 15 }),
  'Monthly on the 15th', 'monthly 15th'
);
assertStr(
  getRecurrenceDisplayString({ type: 'fixed', frequency: 'monthly', interval: 1, ordinal: 'first', dayOfWeek: 1 }),
  'Monthly on the first Monday', 'monthly 1st mon'
);
assertStr(
  getRecurrenceDisplayString({ type: 'fixed', frequency: 'monthly', interval: 3, ordinal: 'first', dayOfWeek: 'weekday' }),
  'Every 3 months on the first weekday', 'quarterly 1st weekday'
);
assertStr(
  getRecurrenceDisplayString({ type: 'interval', every: 2, unit: 'days' }),
  'Every 2 days after completion', 'interval 2 days'
);
assertStr(
  getRecurrenceDisplayString({ type: 'interval', every: 6, unit: 'months' }),
  'Every 6 months after completion', 'interval 6 months'
);

// With end date
assertStr(
  getRecurrenceDisplayString(
    { type: 'fixed', frequency: 'daily', interval: 1 },
    '2026-05-29'
  ),
  'Every day · until May 29, 2026', 'daily with end date'
);

// Ordinal suffix edge cases
assertStr(ordinalSuffix(1), '1st', '1st');
assertStr(ordinalSuffix(2), '2nd', '2nd');
assertStr(ordinalSuffix(3), '3rd', '3rd');
assertStr(ordinalSuffix(11), '11th', '11th');
assertStr(ordinalSuffix(12), '12th', '12th');
assertStr(ordinalSuffix(13), '13th', '13th');
assertStr(ordinalSuffix(21), '21st', '21st');
assertStr(ordinalSuffix(22), '22nd', '22nd');
assertStr(ordinalSuffix(31), '31st', '31st');

// ─── getRecurrenceConfig Normalization Tests ─────────────────────────────────

// Inline copy of getRecurrenceConfig for standalone execution
function getRecurrenceConfig(intent) {
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

console.log('\n=== getRecurrenceConfig Normalization Tests ===\n');

assertStr(
  JSON.stringify(getRecurrenceConfig({ recurrence: 'daily' })),
  '{"type":"fixed","frequency":"daily","interval":1}',
  'legacy daily → fixed daily'
);
assertStr(
  JSON.stringify(getRecurrenceConfig({ recurrence: 'weekly' })),
  '{"type":"fixed","frequency":"weekly","interval":1,"daysOfWeek":[]}',
  'legacy weekly → fixed weekly'
);
assertStr(
  JSON.stringify(getRecurrenceConfig({ recurrence: 'monthly' })),
  '{"type":"fixed","frequency":"monthly","interval":1}',
  'legacy monthly → fixed monthly'
);
assertStr(
  JSON.stringify(getRecurrenceConfig({ recurrence: 'once' })),
  '{"type":"once"}',
  'legacy once → once'
);
assertStr(
  JSON.stringify(getRecurrenceConfig({})),
  '{"type":"once"}',
  'no recurrence → once'
);
// recurrenceConfig takes priority over legacy
assertStr(
  JSON.stringify(getRecurrenceConfig({
    recurrence: 'daily',
    recurrenceConfig: { type: 'interval', every: 3, unit: 'days' }
  })),
  '{"type":"interval","every":3,"unit":"days"}',
  'recurrenceConfig takes priority over legacy'
);

// ─── Spec Test Scenarios (Integration Logic) ─────────────────────────────────

console.log('\n=== Spec Test Scenarios ===\n');

// Test 3: Opposite week trash — anchor Feb 10 vs anchor Feb 3, both biweekly Tuesday
// From Feb 17 (a Tuesday): anchor Feb 3 → next valid = Mar 3; anchor Feb 10 → next valid = Feb 24
console.log('Spec Test 3: Opposite week biweekly');
const biweeklyA = calculateNextEventDate(
  { type: 'fixed', frequency: 'weekly', interval: 2, daysOfWeek: [2], anchorDate: '2026-02-03' },
  new Date(2026, 1, 17) // Feb 17 (Tue)
);
const biweeklyB = calculateNextEventDate(
  { type: 'fixed', frequency: 'weekly', interval: 2, daysOfWeek: [2], anchorDate: '2026-02-10' },
  new Date(2026, 1, 17) // Feb 17 (Tue)
);
assert(biweeklyA, '2026-03-03', 'Anchor Feb 3 from Feb 17 → Mar 3');
assert(biweeklyB, '2026-02-24', 'Anchor Feb 10 from Feb 17 → Feb 24 (opposite week)');

// Test 5 extended: Quarterly skip — complete very late (April 10)
// Every 3 months, first weekday. From April 10 → first weekday of July (July 1 is Wed)
console.log('Spec Test 5b: Quarterly skip on late completion');
assert(
  calculateNextEventDate(
    { type: 'fixed', frequency: 'monthly', interval: 3, ordinal: 'first', dayOfWeek: 'weekday' },
    new Date(2026, 3, 10) // April 10
  ),
  '2026-07-01',
  'Late April completion → first weekday of July'
);

// Test 8: End-date enforcement logic
// Simulate: daily config, endDate = 3 days from Feb 27
// Day 1: Feb 27 → next = Feb 28 (within end date Mar 2) ✓
// Day 2: Feb 28 → next = Mar 1 (within end date) ✓
// Day 3: Mar 1 → next = Mar 2 (within end date) ✓
// Day 4: Mar 2 → next = Mar 3 (PAST end date Mar 2) ✗
console.log('Spec Test 8: End-date enforcement');
const dailyConfig = { type: 'fixed', frequency: 'daily', interval: 1 };
const endDate = '2026-03-02';
const endDateObj = new Date(endDate + 'T23:59:59');
const next1 = calculateNextEventDate(dailyConfig, new Date(2026, 1, 27));
const next2 = calculateNextEventDate(dailyConfig, new Date(2026, 1, 28));
const next3 = calculateNextEventDate(dailyConfig, new Date(2026, 2, 1));
const next4 = calculateNextEventDate(dailyConfig, new Date(2026, 2, 2));
assert(next1, '2026-02-28', 'Day 1 within end date');
assert(next2, '2026-03-01', 'Day 2 within end date');
assert(next3, '2026-03-02', 'Day 3 within end date');
assert(next4, '2026-03-03', 'Day 4 date calculated');
// Simulate triggerRecurrence end-date check
if (next1 <= endDateObj) { passed++; console.log('  PASS: Day 1 passes end-date check'); }
else { failed++; console.error('  FAIL: Day 1 should pass end-date check'); }
if (next4 <= endDateObj) { failed++; console.error('  FAIL: Day 4 should NOT pass end-date check'); }
else { passed++; console.log('  PASS: Day 4 correctly blocked by end-date'); }

// Test 12: Multi-day weekly gym (Mon=1, Wed=3, Fri=5)
// Complete Monday Feb 23 → next = Wed Feb 25
// Complete Wed Feb 25 → next = Fri Feb 27
// Complete Fri Feb 27 → next = Mon Mar 2
console.log('Spec Test 12: Multi-day weekly gym sequence');
const gymConfig = { type: 'fixed', frequency: 'weekly', interval: 1, daysOfWeek: [1, 3, 5] };
assert(
  calculateNextEventDate(gymConfig, new Date(2026, 1, 23)), // Mon Feb 23
  '2026-02-25',
  'Mon → Wed'
);
assert(
  calculateNextEventDate(gymConfig, new Date(2026, 1, 25)), // Wed Feb 25
  '2026-02-27',
  'Wed → Fri'
);
assert(
  calculateNextEventDate(gymConfig, new Date(2026, 1, 27)), // Fri Feb 27
  '2026-03-02',
  'Fri → Mon (next week)'
);

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
