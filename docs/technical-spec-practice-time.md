# SAM Practice Time Tracking — Technical Specification

## Overview

Surface practice time at three locations in the SAM UI:

1. **Main SAM page (above "Your Songs"):** a 7-day rolling
   snapshot showing today + the previous six days, each with a
   day label and rounded practice minutes.
2. **StatsBar during stopped state (next to playback speed):**
   "Practice Time: Today: X minutes  Total: Y hours" — today is
   all-songs aggregate, total is per-song aggregate.
3. **StatsBar during playing state (next to the ms audio
   counter):** a live "Session: M:SS" counter incrementing every
   second, plus a live "Today: Xh Ym" counter that includes the
   currently-running session.

All durations derive from existing `sam_sessions` rows. No schema
changes. No backfill. NULL-ended sessions are filtered out as
zero-contribution.

## Non-goals

- No schema changes to `sam_sessions`, `sam_song_events`, or any
  other table.
- No backfill of historical data.
- No new tables. Practice time is derived data from session
  rows, not stored separately.
- No server-side aggregation (Postgres views, materialized views).
  Aggregation happens client-side.
- No tracking of paused-state time. The existing session
  lifecycle already excludes pause intervals: pause ends a
  session, resume starts a new one, so the DB only contains
  active-play intervals.
- No midnight rollover refresh while the tab is open. Staleness
  across day boundaries is acceptable.
- No NULL-ended session cleanup. They represent lyric-check
  workflows without a connected piano and are an expected
  ongoing pattern.

## Data Model

### Practice Duration Formula

For any session row with `ended_at IS NOT NULL`:
```
duration_seconds = EXTRACT(EPOCH FROM (ended_at - started_at))
```

For any session row with `ended_at IS NULL`: **excluded from all
practice-time totals**. These are abandoned sessions (lyric
checks, browser closes, etc.) and contribute zero.

### Day Bucket Assignment

A session's "day" is determined by its `started_at` converted to
**America/Los_Angeles** (Pacific time), then truncated to the
local date. A session that starts at 11:55pm PT and ends at
12:05am PT counts entirely toward the started_at day.

In JavaScript, the safest approach is to format `started_at`
with `Intl.DateTimeFormat` using `timeZone: "America/Los_Angeles"`
and extract the year/month/day components to form a YYYY-MM-DD
key. Do NOT use `Date.prototype.getDate()` etc. without an
explicit timezone — those use the browser's local time which
may not match Pacific.

### Aggregation Queries

Two server fetches are needed:

**Fetch 1 — All sessions (for the dashboard and all-songs
"Today"):**
```sql
SELECT song_id, started_at, ended_at
FROM sam_sessions
WHERE ended_at IS NOT NULL
ORDER BY started_at DESC;
```

Cost: ~one row per session ever. Acceptable for single-user
single-digit-thousands of sessions over years of use.

**Fetch 2 — Per-song sessions (for StatsBar's "Total: X hours"):**
```sql
SELECT started_at, ended_at
FROM sam_sessions
WHERE song_id = $1
  AND ended_at IS NOT NULL;
```

In practice, both can be served from a single Fetch 1 by
filtering client-side. Use Fetch 1 only; derive per-song from
the same in-memory result.

### Refresh Triggers

The aggregated stats refetch on:

1. **Mount of the component that displays them.** Main SAM page
   loads → fetch. StatsBar mounts (song selected) → fetch.
2. **Session end.** When `endSession` fires (pause or stop),
   trigger a refetch so the new session's duration is reflected.
3. **Song change.** When the user selects a different song,
   StatsBar refetches (the per-song total changes).

NOT refresh on:
- Tab refocus
- Every minute via timer
- Midnight rollover

The live counters (session timer, today live update) are NOT
driven by the refetch. They tick on local state. See below.

## Component Design

### 1. PracticeWeekSnapshot (new component)

**Location:** Main SAM page, above "Your Songs" header in
`SongLoader.jsx` (or wherever the library list lives).

**Behavior:**
- Fetches sessions on mount.
- Buckets by PT day.
- Renders 7 rows: today + the previous 6 calendar days, in
  reverse chronological order (today first).
- Day labels:
  - Today's row: `"Today: X minutes"` or `"Today: 1h 30 minutes"`
    (see formatting rules below)
  - Other rows: the day's full name (`"Monday"`, `"Tuesday"`,
    etc.) — derived from the date in PT.
- Rows for days with no practice show `"<DayName>: No practice"`.
- The 7-day window slides with the current date but does NOT
  refresh while the page is open across midnight. Initial fetch
  + initial bucketing wins for the tab's lifetime.

**Layout:**
A simple stacked list, each row on its own line, left-aligned
or in a compact card. Use existing utility classes for
consistency with surrounding UI.

### 2. PracticeTimeIndicator (new component, in StatsBar)

**Location:** `StatsBar.jsx`, rendered to the right of the
playback speed control. Only visible in stopped state
(`playbackState === "stopped"`).

**Behavior:**
- Reads from the same fetched sessions data as
  `PracticeWeekSnapshot`. (Hoist the fetch + the aggregated
  result into a shared hook or context so both components share
  one fetch.)
- Renders: `"Practice Time: Today: X minutes  Total: Y hours"`
- "Today" = all-songs total for today in PT, rounded to nearest
  minute. Format rules below.
- "Total" = sum of all sessions for the currently-selected song,
  ever. Display in whole hours, floored. Format rules below.
- Refetches when `playbackState` transitions from playing/paused
  to stopped (a session just ended).

### 3. LiveSessionCounter (new component, in StatsBar)

**Location:** `StatsBar.jsx`, next to the existing ms audio
counter. Only visible during `playbackState === "playing"`.

**Behavior:**
- Two live counters side by side:
  - `"Session: M:SS"` — seconds since the current session
    started, formatted as `minutes:seconds` (zero-padded
    seconds, no zero-pad on minutes). `0:00` to `9:59` to
    `10:00` to ... `99:59` (cap unrealistic but no special
    handling).
  - `"Today: Xh Ym"` or `"Today: Y minutes"` — sum of today's
    completed sessions PLUS the elapsed seconds of the current
    session, rounded to nearest minute.
- The "Session" counter increments every second from a
  `setInterval(1000)` driven by local state.
- The "Today" counter updates every 30 seconds (or every minute
  if simpler — sub-minute precision is unnecessary given the
  display rounds to the minute).
- On Resume (new session begins), the Session counter resets to
  0:00. The Today counter continues smoothly (incorporates the
  newly-completed session from the DB plus the new running
  session).

## Format Rules

### Round to the nearest minute

Always. `Math.round(seconds / 60)`. Never floor or ceiling unless
explicitly noted. Output is always whole minutes; no seconds in
practice-time displays.

### "Today" / "X minutes" / "Yh Ym" format

These three formats are used in different places:

**Minutes-only format ("X minutes"):**
- For values < 60 minutes
- Examples:
  - 0 → `"0 minutes"`
  - 1 → `"1 minute"` (singular)
  - 25 → `"25 minutes"`
  - 59 → `"59 minutes"`

**Hours-and-minutes format ("Xh Ym" or "X hours Y minutes"):**
- For values ≥ 60 minutes
- Use compact form `"Xh Ym"` for the live "Today" counter and
  for 7-day snapshot rows
- Use long form `"X hours Y minutes"` for the StatsBar "Today"
  display
- Examples:
  - 60 → `"1h 0m"` / `"1 hour 0 minutes"` — actually drop the
    minutes if 0: `"1h"` / `"1 hour"`
  - 63 → `"1h 3m"` / `"1 hour 3 minutes"`
  - 90 → `"1h 30m"` / `"1 hour 30 minutes"`
  - 125 → `"2h 5m"` / `"2 hours 5 minutes"`
  - Singular/plural: 1 hour vs 2 hours; 1 minute vs 2 minutes

**Decision tree:**
```
minutes === 0  → "0 minutes"
minutes === 1  → "1 minute"
minutes < 60   → "{minutes} minutes"
minutes % 60 === 0 (and >= 60) → "{hours} hour(s)"
otherwise       → "{hours} hour(s) {mins} minute(s)" (long form)
                  "{hours}h {mins}m"               (short form)
```

### Total Hours format (per-song, StatsBar)

- Always hours, floored: `Math.floor(totalSeconds / 3600)`.
- Less than 1 hour: `"<1 hour"`
- 1 hour: `"1 hour"`
- More: `"{n} hours"` (no minute resolution)
- Examples:
  - 0 seconds → `"<1 hour"`
  - 30 minutes → `"<1 hour"`
  - 1 hour 30 minutes → `"1 hour"`
  - 29 hours → `"29 hours"`

### Day name formatting (7-day snapshot)

- Index 0 (today): always labeled `"Today"`
- Indices 1-6: full day name in English (`"Monday"`,
  `"Tuesday"`, etc.) — derived from the PT date for that row
- No "Yesterday" label
- No wraparound: even though "Wednesday" might appear both for
  the most recent Wednesday AND a Wednesday from 8 days ago,
  the display always shows exactly today + the previous 6
  days. Older sessions are not shown.
- A day with no sessions: row reads `"{DayName}: No practice"`

## Implementation Approach

### Shared data fetch

Create a `usePracticeStats` hook in `lib/`:

```js
export default function usePracticeStats({ currentSongId }) {
  // Fetches sam_sessions on mount, on session end signal, and on song change.
  // Returns:
  //   sevenDayTotals: [{ dateISO, dayLabel, minutes }, ...] (7 items)
  //   todayMinutes: number (all songs)
  //   perSongTotalSeconds: number (currentSongId only)
  //   refetch: function (callable when session ends)
}
```

Both `PracticeWeekSnapshot` and `StatsBar`'s practice indicator
consume this hook. A single fetch serves both views.

### Session-end signal

`SamPlayer.jsx` needs to inform the practice-stats system when a
session ends. Two clean approaches:

- **A: callback prop.** `usePracticeSession.endSession` accepts
  an `onSessionEnded` callback that fires after the DB write
  resolves. `SamPlayer` passes a refetch trigger.
- **B: event emitter or React context.** A small context that
  `endSession` calls into; consumers subscribe to refetch.

**Use A.** Simpler, no new abstraction. `usePracticeSession`
already takes nothing — adding one optional config field at the
hook call site is minimal.

### Live counters

Two `setInterval`s in the `LiveSessionCounter` component:

- 1-second interval: bumps a local counter for "Session: M:SS"
- 30-second interval: re-renders the "Today" display, which
  reads `(todayMinutesFromHook + currentSessionSeconds/60)` and
  formats

Both intervals clear on unmount and on `playbackState`
transition away from "playing". Reset session counter to 0 on
each transition INTO "playing" (start or resume both count).

The current session's start timestamp is captured when
`playbackState` becomes "playing" — store in a ref so the
counter reads `Date.now() - startRef.current` rather than
counting ticks (avoids drift if a tick is dropped).

### Pacific time bucketing

```js
const PT_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function ptDateKey(dateInput) {
  // Returns YYYY-MM-DD for the PT calendar date.
  // en-CA locale uses YYYY-MM-DD format natively.
  return PT_FORMATTER.format(new Date(dateInput));
}
```

Bucket sessions by their `ptDateKey(session.started_at)`. The
7-day window is built from `[today, today-1, today-2, ..., today-6]`
where each day is also computed via `ptDateKey` on an offset
`Date` object.

### Day name for 7-day rows

```js
const DAY_NAME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "long",
});

function dayName(dateInput) {
  return DAY_NAME_FORMATTER.format(new Date(dateInput));
}
```

Use this for indices 1-6 of the snapshot. Index 0 is hardcoded
to `"Today"`.

## Constraints

- **No changes to `usePracticeSession.js`** except (optionally)
  adding an `onSessionEnded` callback parameter. Internal logic
  unchanged.
- **No changes to the session DB schema.**
- **No changes to existing session lifecycle.** Pause continues
  to end the session; Resume continues to start a new one. This
  is what makes "active playing time only" fall out for free.
- **The shared hook `usePracticeStats` lives in `lib/`,** next
  to `usePracticeSession`, `useAudioSync`, `useLyricEditor`,
  `useNumericInput`.
- **No timezone other than America/Los_Angeles.** No
  configuration knob. Hard-code the IANA timezone string.
- **NULL-ended sessions stay NULL.** Excluded from all
  practice-time queries. Do not write them to anything.
- **"Today" rolling boundary is midnight PT.** Sessions that
  start at 11:55pm PT and end the next day count toward the
  started_at day in full.

## Success Criteria

- Main page shows a 7-day snapshot above the song list. Today
  shows correct practice time for today. Previous days show
  correct or "No practice".
- StatsBar in stopped state shows "Today" (all-songs) and
  "Total" (per-song) for the selected song. Values update when
  a session ends.
- StatsBar in playing state shows a live session counter
  ticking every second (`Session: M:SS`) and a live today
  counter updating ~every 30 seconds.
- Practice totals reflect active playing time only — pauses
  don't count.
- Session ends (pause OR stop) cause stats to refresh.
- Selecting a different song updates the per-song Total
  immediately.
- Live counters reset cleanly on Resume (Session counter goes
  back to 0; Today counter continues with the prior session's
  duration now in the DB).
- Display formats match the rules above (no seconds in
  totals; rounded to nearest minute; correct singular/plural;
  correct hours-and-minutes joining).
- NULL-ended sessions are completely invisible to the
  practice-time display.
