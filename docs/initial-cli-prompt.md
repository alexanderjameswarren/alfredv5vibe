# Project Context

SAM tracks practice sessions via `sam_sessions` (one row per
continuous play stretch). Pauses end sessions; resumes start
new ones. Active-playing-time semantics fall out naturally from
this lifecycle — paused intervals are simply not represented in
the DB.

This project adds practice-time surface area in three UI
locations:

1. **Main SAM page:** 7-day snapshot of daily practice minutes
   above "Your Songs"
2. **StatsBar (stopped state):** all-songs today total +
   per-song lifetime total
3. **StatsBar (playing state):** live session counter (M:SS) +
   live today counter (rolling, includes the running session)

No DB schema changes. No backfill. Data already exists in
`sam_sessions.ended_at - started_at`. NULL-ended sessions
(common, from lyric-checking without a piano connected) are
filtered out as zero-contribution and never displayed.

All times are Pacific (America/Los_Angeles). Day buckets are
midnight-to-midnight PT. The "today" boundary is the started_at
date in PT — a session crossing midnight counts entirely toward
its start day.

# Reference Documents

- Technical spec: `docs/technical-spec-practice-time.md`
- Progress tracking: `docs/progress-practice-time.md`

# Your Task

1. Read the technical specification end to end before writing
   any code.
2. Review the progress tracking file.
3. Execute milestones **in the order documented in the spec**:
   M1 (hook + formatters) → M2 (week snapshot) → M3
   (PracticeTimeIndicator in StatsBar stopped) → M4
   (LiveSessionCounter in StatsBar playing) → M5 (session-end
   refetch plumbing).
4. **Stop after each milestone.** Update the progress file's
   checklist and Notes section, present the verification
   checklist verbatim, and wait for me to reply "verified,
   proceed" before starting the next milestone.

# Verification Notes

- **M1 is invisible.** It builds the shared hook and formatters.
  Verify by adding a temporary console log in any consuming
  component and checking the hook's output against ground-truth
  SQL queries (provided in the progress file).
- **M2 is the first visible milestone.** Cold reload the main
  page, verify the 7-day snapshot appears with correct totals.
- **M3 verifies via real practice.** Play a snippet for ~30
  seconds, stop, watch the StatsBar update.
- **M4 verifies the live counters.** Both the per-second
  session counter and the per-30-second today update.
- **M5 connects the dots.** Pause-end → refetch → display
  updates immediately.

# Important Constraints

- **No DB schema changes.** No new columns, no new tables, no
  views. Aggregation is purely client-side from existing data.
- **No backfill.** Existing NULL-ended sessions stay NULL and
  are excluded from displays.
- **No timezone configuration.** Hardcode
  `America/Los_Angeles` throughout. Do not read from browser
  locale.
- **No midnight rollover handling.** If the user keeps the tab
  open across midnight, "Today" will be slightly stale until
  next refetch. Acceptable.
- **Single fetch serves both `PracticeWeekSnapshot` and
  StatsBar.** Both consume the same `usePracticeStats` hook.
  Do NOT issue duplicate queries from different components.
- **NULL-ended sessions are filtered at the SQL level**
  (`WHERE ended_at IS NOT NULL`). Do not write code that
  handles NULL ended_at — it should never reach component
  logic.
- **Active-playing-time semantics are free.** Do NOT add
  pause-tracking, do NOT modify `usePracticeSession.js`'s
  session lifecycle. Pause already ends sessions; that's what
  makes the math work.
- **The session counter uses `Date.now() - startRef.current`**,
  not a tick-incrementing counter. Avoids drift if the browser
  throttles `setInterval` (e.g., backgrounded tab).
- **All durations round to the nearest minute** for display,
  except "Total" which is whole hours floored. Never display
  seconds (except in the live `Session: M:SS` counter, where
  seconds are the whole point).
- **Singular/plural matters.** "1 minute" not "1 minutes"; "1
  hour" not "1 hours". The formatters handle this — every
  consumer must call through the formatters, not hand-roll
  display strings.
- **Stop and ask** if:
  - The current StatsBar layout has no room for the new
    indicators without major restructuring.
  - `currentSongId` isn't accessible to `StatsBar` and would
    require deep prop drilling — propose a context or
    alternative plumbing.
  - Any session in the DB has unexpected shape (e.g.,
    `started_at > ended_at`).
  - A milestone's verification turns up data that doesn't
    match the ground-truth SQL queries in the progress file.
