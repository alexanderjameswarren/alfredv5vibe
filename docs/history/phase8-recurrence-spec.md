# Phase 8: Intention Recurrence — Technical Specification

## Overview

Replace the simple `recurrence TEXT` field on intents with a rich recurrence system supporting Google Calendar-style scheduling. When an event is archived (execution completed or user-initiated), the system calculates and creates the next event based on the intention's recurrence configuration.

## Two Scheduling Paradigms

### Fixed Schedule (calendar is boss)
Next event = first canonical occurrence **strictly after today**, regardless of when completion happened.

| Use Case | Config |
|---|---|
| Take medication daily | Every 1 day |
| Take out trash every other Tuesday | Every 2 weeks on Tuesday |
| Big trash day, opposite weeks | Every 2 weeks on Tuesday (offset anchor) |
| Household chores, first Monday of month | Monthly, ordinal: first, day: Monday |
| Invoices, first weekday of each quarter | Every 3 months, ordinal: first, day: weekday |

**Core principle:** If due date has passed and you complete late, next event = first canonical date **after today**. Never backdate. If medication is due 2/6 and you complete on 2/7, next = 2/8. If invoices due 1/2 and you complete on 4/10, next = first weekday of Q3 (July).

### Interval From Completion (behavior is boss)
Next event = **completion date** + interval. The original due date is irrelevant.

| Use Case | Config |
|---|---|
| Check on plants every 2 days | Every 2 days from completion |
| Change AC filters every 6 months | Every 6 months from completion |

**Core principle:** Due date 3/1, completed 2/21 → next = 8/21 (6 months from 2/21). Completed Friday instead of Thursday → next = Sunday (2 days from Friday).

---

## 1. SQL Migrations

### 1a. Add new columns to intents

```sql
-- Add recurrence_config JSONB to replace simple recurrence TEXT
ALTER TABLE intents ADD COLUMN recurrence_config JSONB;

-- Add target_start_date (independent of recurrence — for planning/filtering)
ALTER TABLE intents ADD COLUMN target_start_date DATE;

-- Add end_date (no events auto-created after this date)
ALTER TABLE intents ADD COLUMN end_date DATE;

-- Index for querying recurring intents
CREATE INDEX idx_intents_recurrence_config ON intents USING GIN (recurrence_config);
```

### 1b. Migrate existing recurrence data

```sql
-- Migrate existing simple recurrence values to recurrence_config
UPDATE intents SET recurrence_config = CASE
  WHEN recurrence = 'once' THEN '{"type": "once"}'::jsonb
  WHEN recurrence = 'daily' THEN '{"type": "fixed", "frequency": "daily", "interval": 1}'::jsonb
  WHEN recurrence = 'weekly' THEN '{"type": "fixed", "frequency": "weekly", "interval": 1, "daysOfWeek": []}'::jsonb
  WHEN recurrence = 'monthly' THEN '{"type": "fixed", "frequency": "monthly", "interval": 1}'::jsonb
  ELSE '{"type": "once"}'::jsonb
END
WHERE recurrence_config IS NULL;
```

### 1c. Verification

```sql
-- Verify migration
SELECT recurrence, recurrence_config, COUNT(*)
FROM intents
GROUP BY recurrence, recurrence_config;

-- Verify new columns exist
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'intents'
AND column_name IN ('recurrence_config', 'target_start_date', 'end_date');
```

### 1d. Drop old column (ONLY after frontend is fully migrated and tested)

```sql
-- ALTER TABLE intents DROP COLUMN recurrence;
```

---

## 2. Recurrence Config Schema

All stored in `intents.recurrence_config` as JSONB.

### Type: `once`
```json
{ "type": "once" }
```
Intent archives after execution completes. No new events.

### Type: `fixed` — Daily
```json
{
  "type": "fixed",
  "frequency": "daily",
  "interval": 1
}
```
Every day. `interval: 2` = every other day on a fixed calendar cadence.

### Type: `fixed` — Weekly
```json
{
  "type": "fixed",
  "frequency": "weekly",
  "interval": 1,
  "daysOfWeek": [2]
}
```
- `daysOfWeek`: array of ISO day numbers (1=Monday ... 7=Sunday)
- `interval: 2` = every other week
- Multiple days allowed: `[1, 3, 5]` = Mon, Wed, Fri

**Biweekly trash (every other Tuesday):**
```json
{
  "type": "fixed",
  "frequency": "weekly",
  "interval": 2,
  "daysOfWeek": [2],
  "anchorDate": "2026-02-03"
}
```
`anchorDate` establishes which week is "week 0" for multi-week intervals.

**Big trash day (opposite weeks):** Same config but anchor offset by one week:
```json
{
  "type": "fixed",
  "frequency": "weekly",
  "interval": 2,
  "daysOfWeek": [2],
  "anchorDate": "2026-02-10"
}
```

### Type: `fixed` — Monthly (by day of month)
```json
{
  "type": "fixed",
  "frequency": "monthly",
  "interval": 1,
  "dayOfMonth": 15
}
```
Every month on the 15th. `interval: 3` = quarterly on the 15th.

### Type: `fixed` — Monthly (by ordinal weekday)
```json
{
  "type": "fixed",
  "frequency": "monthly",
  "interval": 1,
  "ordinal": "first",
  "dayOfWeek": 1
}
```
First Monday of every month.

- `ordinal`: `"first"`, `"second"`, `"third"`, `"fourth"`, `"last"`
- `dayOfWeek`: ISO day number (1–7), or the string `"weekday"` for Mon–Fri

**Invoices — first weekday of each quarter:**
```json
{
  "type": "fixed",
  "frequency": "monthly",
  "interval": 3,
  "ordinal": "first",
  "dayOfWeek": "weekday"
}
```

### Type: `interval` — From Completion
```json
{
  "type": "interval",
  "every": 2,
  "unit": "days"
}
```
- `unit`: `"days"`, `"weeks"`, `"months"`
- Plants every 2 days: `{ "type": "interval", "every": 2, "unit": "days" }`
- AC filters every 6 months: `{ "type": "interval", "every": 6, "unit": "months" }`

---

## 3. Next Date Calculation: `calculateNextEventDate(config, referenceDate)`

Pure function. No side effects. Returns a `Date` or `null`.

- For **fixed** types: `referenceDate` = today. Function finds first canonical date strictly after today.
- For **interval** types: `referenceDate` = completion date (today). Function returns referenceDate + interval.

### 3a. Fixed — Daily

```
candidate = referenceDate + 1 day
if interval === 1: return candidate
// For interval > 1, need anchorDate:
while (daysSince(anchorDate, candidate) % interval !== 0):
  candidate += 1 day
return candidate
```

For interval=1 (95% case), just return tomorrow.

### 3b. Fixed — Weekly

```
1. Start from referenceDate + 1 day
2. For each candidate day (up to 14 * interval days out):
   a. Is candidate's ISO day-of-week in daysOfWeek?
   b. Is candidate's week valid per interval + anchorDate?
3. Return first match
```

Week alignment check (when interval > 1):
```javascript
// Normalize both dates to start-of-week (Monday)
function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun, 1=Mon...
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

const anchorWeekStart = startOfWeek(new Date(config.anchorDate));
const candidateWeekStart = startOfWeek(candidate);
const weeksDiff = Math.round((candidateWeekStart - anchorWeekStart) / (7 * 86400000));
const isValidWeek = ((weeksDiff % config.interval) + config.interval) % config.interval === 0;
```

### 3c. Fixed — Monthly (day of month)

```
1. Try dayOfMonth in current month — if strictly after referenceDate, use it
2. Otherwise advance by interval months
3. Clamp: if dayOfMonth > days in target month, use last day of month
```

### 3d. Fixed — Monthly (ordinal weekday)

```
function nthWeekdayOfMonth(year, month, ordinal, dayOfWeek):
  if dayOfWeek === "weekday":
    candidate = 1st of month
    while candidate is Sat or Sun: candidate += 1 day
    if ordinal !== "first": apply ordinal offset for weekdays
    return candidate

  if ordinal === "last":
    start from last day of month, walk backward to find dayOfWeek
  else:
    find first occurrence of dayOfWeek in month
    add (ordinalIndex * 7) days
    // ordinalIndex: first=0, second=1, third=2, fourth=3

1. Calculate target day in current month
2. If strictly after referenceDate, use it
3. Otherwise advance by interval months and recalculate
```

### 3e. Interval — From Completion

```javascript
switch (config.unit) {
  case "days":
    return addDays(referenceDate, config.every);
  case "weeks":
    return addDays(referenceDate, config.every * 7);
  case "months":
    return addMonths(referenceDate, config.every);
    // addMonths: handle end-of-month (Aug 31 + 6 months = Feb 28/29)
}
```

---

## 4. End Date Enforcement

After calculating the next date:

```javascript
if (intent.endDate && nextDate > new Date(intent.endDate)) {
  return null; // Do NOT create a new event
}
```

When recurrence exhausts (hits end date): **do NOT auto-archive the intent**. Leave it unarchived with no active events. User can manually archive, extend end date, or schedule one-off events. Follows "Alfred stores truth" — the intent exists, the schedule just ran out.

---

## 5. Changes to `closeExecution`

### Current flow (lines 1924-1980):
1. If cancelled → delete execution, return
2. Close execution (status=closed, outcome)
3. Archive the event
4. If once + done → archive the intent
5. Handle collection cleanup

### New flow — replace step 4 with recurrence logic:

```javascript
// --- After archiving the event (step 3) ---

const intent = intents.find((i) => i.id === activeExecution.intentId);
if (intent) {
  const config = getRecurrenceConfig(intent); // normalization helper

  if (config.type === "once") {
    // One-time: archive intent on done (existing behavior)
    if (outcome === "done") {
      const archivedIntent = { ...intent, archived: true };
      await storage.set(`intent:${intent.id}`, archivedIntent);
      setIntents((prev) => prev.map((i) => (i.id === intent.id ? archivedIntent : i)));
    }
  } else {
    // Recurring: calculate and create next event
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const nextDate = calculateNextEventDate(config, today);

    if (nextDate && (!intent.endDate || nextDate <= new Date(intent.endDate))) {
      const newEvent = {
        id: `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        intentId: intent.id,
        time: nextDate.toISOString().split("T")[0],
        itemIds: event?.itemIds || [],
        contextId: intent.contextId,
        collectionId: intent.collectionId || null,
        archived: false,
        createdAt: new Date().toISOString(),
      };
      await storage.set(`event:${newEvent.id}`, newEvent);
      setEvents((prev) => [...prev, newEvent]);
    }
  }
}

// --- Continue with collection cleanup (step 5) ---
```

### Also wire into manual event archive

Extract shared logic into a helper:

```javascript
async function triggerRecurrence(intentId, archivedEvent) {
  const intent = intents.find((i) => i.id === intentId);
  if (!intent) return;

  const config = getRecurrenceConfig(intent);
  if (config.type === "once") return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const nextDate = calculateNextEventDate(config, today);

  if (nextDate && (!intent.endDate || nextDate <= new Date(intent.endDate))) {
    const newEvent = {
      id: `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      intentId: intent.id,
      time: nextDate.toISOString().split("T")[0],
      itemIds: archivedEvent?.itemIds || [],
      contextId: intent.contextId,
      collectionId: intent.collectionId || null,
      archived: false,
      createdAt: new Date().toISOString(),
    };
    await storage.set(`event:${newEvent.id}`, newEvent);
    setEvents((prev) => [...prev, newEvent]);
  }
}
```

Call `triggerRecurrence(event.intentId, event)` from both `closeExecution` and any manual archive function.

---

## 6. UI Specification — Recurrence Picker

Replace the current `<select>` (once/daily/weekly/monthly) with a Google Calendar-style recurrence picker.

### 6a. Quick Select (default view)

Dropdown covering 80% of cases. Dynamic labels based on current day:

```
┌───────────────────────────────┐
│ Does not repeat               │  → { type: "once" }
│ Daily                         │  → fixed, daily, 1
│ Weekly on Tuesday             │  → fixed, weekly, 1, [2]
│ Monthly on the 27th           │  → fixed, monthly, 1, dayOfMonth: 27
│ Every weekday (Mon–Fri)       │  → fixed, weekly, 1, [1,2,3,4,5]
│ ──────────────────────────    │
│ Custom...                     │  → opens fixed schedule dialog
│ After completion...           │  → opens interval dialog
└───────────────────────────────┘
```

### 6b. Custom Recurrence Dialog (fixed schedule)

Modal/dialog matching Google Calendar pattern (reference: uploaded screenshot):

```
┌──────────────────────────────────────┐
│  Custom recurrence                   │
│                                      │
│  Repeat every [ 1 ▲▼] [ week   ▼]   │
│                                      │
│  ┌─── shown when frequency=weekly ───┐
│  │ Repeat on                         │
│  │ (S) (M) (T) (W) (T) (F) (S)     │
│  └───────────────────────────────────┘
│                                      │
│  ┌─── shown when frequency=monthly ──┐
│  │ ○ On day [15]                     │
│  │ ○ On the [first ▼] [Monday ▼]    │
│  └───────────────────────────────────┘
│                                      │
│  Ends                                │
│  ○ Never                             │
│  ○ On [date picker]                  │
│                                      │
│  ┌─── shown when interval > 1 ───────┐
│  │     and frequency = weekly         │
│  │ Anchor week of: [date picker]     │
│  │ (Determines which week is "on")   │
│  └───────────────────────────────────┘
│                                      │
│           [Cancel]  [Done]           │
└──────────────────────────────────────┘
```

**Frequency dropdown:** day, week, month

**Ordinal dropdown:** first, second, third, fourth, last

**Day-of-week dropdown:** Monday ... Sunday, Weekday (Mon–Fri)

**Dynamic sections:**
- `week` → day-of-week toggle buttons
- `month` → radio: day-of-month vs ordinal weekday
- interval > 1 + weekly → anchor date picker
- End date section always visible

### 6c. Interval From Completion Dialog

```
┌──────────────────────────────────────┐
│  Repeat after completion             │
│                                      │
│  Schedule next event                 │
│  [ 2 ▲▼] [ days   ▼] after done     │
│                                      │
│  Unit options: days / weeks / months │
│                                      │
│  Ends                                │
│  ○ Never                             │
│  ○ On [date picker]                  │
│                                      │
│           [Cancel]  [Done]           │
└──────────────────────────────────────┘
```

### 6d. Display String Helper

Show human-readable summary on intention cards and edit form:

| Config | Display String |
|---|---|
| `{ type: "once" }` | *Does not repeat* |
| fixed, daily, 1 | *Every day* |
| fixed, daily, 2 | *Every 2 days* |
| fixed, weekly, 1, [2] | *Weekly on Tuesday* |
| fixed, weekly, 2, [2] | *Every 2 weeks on Tuesday* |
| fixed, weekly, 1, [1,3,5] | *Weekly on Mon, Wed, Fri* |
| fixed, monthly, 1, dayOfMonth: 15 | *Monthly on the 15th* |
| fixed, monthly, 1, first Monday | *Monthly on the first Monday* |
| fixed, monthly, 3, first weekday | *Every 3 months on the first weekday* |
| interval, 2, days | *Every 2 days after completion* |
| interval, 6, months | *Every 6 months after completion* |

With end date, append: *· until May 29, 2026*

---

## 7. Frontend Data Migration

### Normalization helper (support both old and new during transition)

```javascript
function getRecurrenceConfig(intent) {
  if (intent.recurrenceConfig) return intent.recurrenceConfig;
  switch (intent.recurrence) {
    case "daily":
      return { type: "fixed", frequency: "daily", interval: 1 };
    case "weekly":
      return { type: "fixed", frequency: "weekly", interval: 1, daysOfWeek: [] };
    case "monthly":
      return { type: "fixed", frequency: "monthly", interval: 1 };
    default:
      return { type: "once" };
  }
}
```

### Migration checklist
- [ ] Update all reads of `intent.recurrence` to use `getRecurrenceConfig(intent)`
- [ ] Update `closeExecution` to use `recurrenceConfig` (section 5)
- [ ] Update intention save to write `recurrenceConfig` instead of `recurrence`
- [ ] Update Supabase select queries to include `recurrence_config`
- [ ] Update intent card display to use display string helper (section 6d)
- [ ] After everything works: run migration 1d to drop old column

---

## 8. Implementation Steps (for CLI execution)

| Step | Description | Est. Effort |
|---|---|---|
| 1 | SQL migrations (1a–1c) — run in Supabase SQL Editor | Manual, 5 min |
| 2 | Create `src/utils/recurrence.js` — pure `calculateNextEventDate` function | 1–2 hours |
| 3 | Create `src/utils/recurrenceDisplay.js` — human-readable display string helper | 30 min |
| 4 | Update data layer — intent CRUD to read/write `recurrenceConfig`, add normalization helper | 1 hour |
| 5 | Wire `calculateNextEventDate` into `closeExecution` and manual event archive via `triggerRecurrence` helper | 1 hour |
| 6 | Build quick-select dropdown (replacing current 4-option select) | 1 hour |
| 7 | Build custom recurrence dialog (fixed schedule) | 2–3 hours |
| 8 | Build interval-from-completion dialog | 1 hour |
| 9 | Add display string to intention cards and edit form | 30 min |
| 10 | Add end date + target start date fields to intention edit form | 30 min |
| 11 | End-to-end testing of all scenarios (section 9) | 1–2 hours |
| 12 | Drop old `recurrence` column (migration 1d) | Manual, 5 min |

**Total estimated: 10–14 hours**

---

## 9. Test Scenarios

### Test 1: Daily Medication
1. Create intent "Take Creatine", recurrence: daily
2. Schedule for today → event for today
3. Execute and complete
4. **Verify:** New event created for tomorrow
5. Don't complete tomorrow's until the day after
6. **Verify:** Next event = day after completion, never backdated

### Test 2: Biweekly Trash
1. Create intent "Take out trash", recurrence: every 2 weeks on Tuesday, anchor: Feb 3
2. Schedule → event for next valid Tuesday
3. Complete on that Tuesday
4. **Verify:** Next event = 2 weeks later on Tuesday, not next week

### Test 3: Opposite Week Trash
1. Create intent "Big trash day", every 2 weeks on Tuesday, anchor: Feb 10
2. **Verify:** Events fall on opposite Tuesdays from Test 2

### Test 4: First Monday of Month
1. Create intent "Household chores", monthly, first Monday
2. Complete in February
3. **Verify:** Next event = first Monday of March

### Test 5: Quarterly First Weekday (Invoices)
1. Create intent "Send invoices", every 3 months, first weekday
2. Complete on Jan 3
3. **Verify:** Next event = first weekday of April
4. Complete very late (April 10)
5. **Verify:** Next event = first weekday of July (skips April which is past)

### Test 6: Plants (Interval — Days)
1. Create intent "Check plants", every 2 days after completion
2. Complete on Tuesday
3. **Verify:** Next event = Thursday
4. Don't check Thursday, complete on Friday
5. **Verify:** Next event = Sunday (2 days from Friday completion)

### Test 7: AC Filters (Interval — Months)
1. Create intent "Change AC filters", every 6 months after completion
2. Event due 3/1, complete on 2/21
3. **Verify:** Next event = 8/21 (6 months from completion, not due date)

### Test 8: End Date Enforcement
1. Create daily intent, end date = 3 days from now
2. Complete 3 events
3. **Verify:** No 4th event created
4. **Verify:** Intent NOT archived (visible, just no events)

### Test 9: Manual Archive Triggers Recurrence
1. Create recurring intent with scheduled event
2. Archive event manually (skip without executing)
3. **Verify:** Next event created based on recurrence

### Test 10: One-Time Intent Lifecycle
1. Create intent, recurrence: once
2. Execute and complete
3. **Verify:** Event archived, intent archived, no new event

### Test 11: Migration Verification
1. Check intents migrated from "daily"/"weekly"/"monthly"
2. **Verify:** `recurrence_config` populated correctly
3. **Verify:** Picker shows correct selection
4. **Verify:** Completing migrated intent creates next event

### Test 12: Multi-Day Weekly (Gym)
1. Create intent "Gym", weekly on Mon, Wed, Fri
2. Complete Monday → **Verify:** next = Wednesday
3. Complete Wednesday → **Verify:** next = Friday
4. Complete Friday → **Verify:** next = Monday (next week)
