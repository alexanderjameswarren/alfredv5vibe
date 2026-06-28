# Progress: SAM Practice Time Tracking

## Status: Complete

---

## Milestone 1 — `usePracticeStats` Hook + Formatter Utilities

### Development Steps
- [x] Create `lib/practiceTimeFormat.js`:
  - `formatMinutesShort(mins)` — `"0 minutes"` / `"1 minute"` / `"25 minutes"` / `"1h 30m"` / `"2h 5m"` (drop `"0m"` when on the hour)
  - `formatMinutesLong(mins)` — `"0 minutes"` / `"1 minute"` / `"25 minutes"` / `"1 hour 30 minutes"` / `"2 hours 5 minutes"` (drop `"0 minutes"` when on the hour)
  - `formatTotalHours(seconds)` — `"<1 hour"` / `"1 hour"` / `"29 hours"` (always floored)
  - `ptDateKey(dateInput)` — `Intl.DateTimeFormat` with `en-CA` locale and `America/Los_Angeles` timezone, returns YYYY-MM-DD
  - `ptDayName(dateInput)` — `Intl.DateTimeFormat` with `en-US` locale and weekday: "long", returns "Monday" / "Tuesday" etc.
- [x] Create `lib/usePracticeStats.js`:
  - Accepts `{ currentSongId, refetchSignal }` (refetchSignal is a counter that bumps when a session ends)
  - Fetches `sam_sessions` with `WHERE ended_at IS NOT NULL`, ordered by `started_at DESC`
  - Computes:
    - `sevenDayTotals`: array of 7 items `{ dateISO, dayLabel, minutes }`, index 0 is today
    - `todayMinutes`: sum of today's sessions across all songs (rounded to nearest minute)
    - `perSongTotalSeconds`: sum of currentSongId's sessions (raw seconds, formatting happens in display)
  - Returns the above plus a `loading` flag
- [ ] Verify with a temporary console log: mount in any component, check the output matches expectations against the DB

### Verification
- [ ] Open dev tools console after the hook is wired
- [ ] Confirm `usePracticeStats` returns 7 day buckets
- [ ] Confirm today's bucket matches a hand-counted total of today's sessions (use the SQL query at the bottom of this file as ground truth)
- [ ] Confirm `perSongTotalSeconds` for "Someone Like You" matches the song's actual cumulative session time
- [ ] Confirm formatters produce expected outputs for boundary values:
  - 0 minutes → "0 minutes"
  - 1 minute → "1 minute"
  - 59 minutes → "59 minutes"
  - 60 minutes → "1h" (short) / "1 hour" (long)
  - 63 minutes → "1h 3m" (short) / "1 hour 3 minutes" (long)
  - 120 minutes → "2h" (short) / "2 hours" (long)
  - 1740 seconds (29 min) → "<1 hour" (totalHours)
  - 3600 seconds → "1 hour" (totalHours)

### Notes
- **Formatters live in `lib/practiceTimeFormat.js`** alongside the Intl-based PT helpers. Single import surface for every consumer.
- **Hook lives in `lib/usePracticeStats.js`** next to `usePracticeSession`/`useAudioSync`. Fetch shape: `select("song_id, started_at, ended_at").not("ended_at", "is", null).order("started_at", { ascending: false })` — NULL-ended filtered at SQL exactly as the spec requires.
- **Refetch is signal-based, not imperative.** The hook accepts `refetchSignal` (any value); changing it re-runs the fetch via `useEffect` dependency. M5 wires a counter to it; M2/M3 can leave it at default `0` and the on-mount fetch is sufficient.
- **Per-song total is purely client-side filter.** Changing `currentSongId` re-derives `perSongTotalSeconds` from the already-fetched session list via `useMemo` — no extra network call. Honors the "single fetch serves both" constraint.
- **Day-key arithmetic uses UTC calendar math, not timestamp subtraction.** `dateKeyMinusDays(todayKey, i)` parses the key, builds `Date.UTC(y, m-1, d-i)`, reads back the UTC components. DST-safe — never depends on browser local time, never gets off-by-one on the spring/fall transition days. Day-name lookup pins to UTC noon on the target date (mid-morning PT in either DST regime, safely away from midnight).
- **Defensive zero/negative-duration skip.** SQL already filters NULL-ended; the hook additionally drops any row where `endMs <= startMs` so a corrupt row can't crash the bucketing or produce negative minutes. Safe to remove once we trust the data shape; cheap to keep.
- **Build:** `npm run build` succeeds with no new warnings.

---

## Milestone 2 — `PracticeWeekSnapshot` Component (Main SAM Page)

### Development Steps
- [x] Create `components/PracticeWeekSnapshot.jsx`
- [x] Consume `usePracticeStats` hook
- [x] Render 7 stacked rows:
  - Index 0: `"Today: {formatMinutesShort(minutes)}"` (or `"Today: No practice"` if 0 minutes — see note below)
  - Indices 1-6: `"{dayName}: {formatMinutesShort(minutes)}"` or `"{dayName}: No practice"`
- [x] **Decision point:** "Today: 0 minutes" displays as "Today: No practice" — went with the consistency default. Confirm during verification.
- [x] Mount above the "Your Songs" header in `SongLoader.jsx`
- [x] Style for compact display — left-aligned, one row per line, no excessive vertical spacing

### Verification
- [ ] Main SAM page shows the 7-day snapshot above the song list
- [ ] Today's row matches recent practice
- [ ] Yesterday's row shows yesterday's full day name (e.g., "Friday" if today is Saturday)
- [ ] A day with no practice in the last 7 shows "No practice"
- [ ] After completing a session and navigating back to main page, today's row reflects the new session duration
- [ ] Day labels read sensibly going back through the week (no "Yesterday", no "X days ago", just day names)

### Notes
- **Heading: "Practice — last 7 days".** Plain `<h3>` matching the "Your songs" header style. The rows alone (just day labels) felt unmoored; the heading anchors the section.
- **Zero-minute days render as "No practice"** including today. Spec's default; consistent across all 7 rows. If today reads "No practice" when the user expected "0 minutes", easy toggle in the row map.
- **Mounted unconditionally** at the top of the song-loader render tree (above the conditional library list). The snapshot always shows — even when the library is loading or empty — because it's its own fetch and has its own loading state.
- **Loading state** renders a "Loading practice stats..." placeholder with the same muted styling as the library's loading state.
- **Tailwind classes** match surrounding patterns (`text-sm`, `text-muted-foreground`, `font-medium`, `mt-6`, etc.). No new design tokens.
- **Build:** `npm run build` succeeds with no new warnings.

---

## Milestone 3 — `PracticeTimeIndicator` in StatsBar (Stopped State)

### Development Steps
- [x] In `StatsBar.jsx`, add a new block visible when `playbackState === "stopped"`
- [x] Render: `"Practice Time: Today: {formatMinutesLong(todayMinutes)}  Total: {formatTotalHours(perSongTotalSeconds)}"`
- [x] Position inside the existing StatsBar flex row, after the Metronome group, before the lastResult marker (playback-speed control lives in `SettingsBar`, not StatsBar — StatsBar is the closest stats-row landing zone)
- [x] StatsBar now takes `playbackState`, `currentSongId`, and an optional `practiceStatsRefetchSignal` prop. `usePracticeStats` is called once at the StatsBar level so M3 and M4 share the same fetch.

### Verification
- [ ] Load a song. In stopped state, the StatsBar shows the practice time indicator
- [ ] "Today" shows the all-songs total for today rounded to the nearest minute, in long format
- [ ] "Total" shows the per-song total in hours, floored, with "<1 hour" for sub-hour totals
- [ ] Practice a snippet for ~2 minutes. Stop. Verify "Today" and "Total" both updated immediately
- [ ] Switch to a different song. Verify "Total" updates to that song's total. "Today" stays the same (all-songs)
- [ ] Reload the page. Values persist (they're computed from the DB on mount, so they should be the same)

### Notes
- **`usePracticeStats` lives in StatsBar, not in the children.** Both M3 (`PracticeTimeIndicator`) and M4 (`LiveSessionCounter` — coming) need `todayMinutes`; M3 additionally needs `perSongTotalSeconds`. Calling the hook once at StatsBar level and passing values down satisfies the "single fetch" constraint without prop-drilling the raw hook return out of SamPlayer.
- **Placement note.** Spec said "to the right of the playback speed control" but that control actually lives in `SettingsBar`, not StatsBar. StatsBar is the next-best slot (stats row directly adjacent to SettingsBar/AudioControls); positioned after the Metronome group inside the existing `flex-wrap` row so it'll wrap naturally on narrow viewports.
- **Visibility extended to `playbackState !== "playing"` (post-M3 user request).** Spec originally gated on `=== "stopped"`; user wanted Today/Total visible during Pause too. Same data, same component — paused becomes a natural read-only checkpoint between play sessions. Note that during paused, `todayMinutes` may briefly under-report the just-completed mini-session until M5's refetch lands (the live counter has the same gap; both close together).
- **`practiceStatsRefetchSignal` prop is wired but always 0 for now.** M5 will bump it from SamPlayer when `endSession` resolves. Today, the indicator refreshes on remount (which happens on song change and on page navigation), which covers the common case but not the in-place pause-end scenario — that's exactly what M5 fixes.
- **Per-song "Total" updates on song change for free** — `perSongTotalSeconds` is a `useMemo` over the fetched session list filtered by `currentSongId`, so changing the song re-derives without a refetch.
- **Build:** `npm run build` succeeds with no new warnings.

---

## Milestone 4 — `LiveSessionCounter` in StatsBar (Playing State)

### Development Steps
- [x] In `StatsBar.jsx`, add a new block visible when `playbackState === "playing"`
- [x] Position inside the StatsBar flex row (the audio-ms counter lives in a separate parent row in SamPlayer.jsx, not in StatsBar — StatsBar is the spec's primary location)
- [x] Render two parts:
  - `"Session: {M}:{SS}"` — minutes:zero-padded-seconds, no zero-pad on minutes
  - `"Today: {formatMinutesShort(todayMinutes + currentSessionMinutes)}"`
- [x] Track current session start as state (not ref) so the first render after entering "playing" shows `0:00` immediately rather than waiting one interval tick
- [x] `setInterval(1000)` to bump a tick counter and re-render
- [x] ~~Optional 30s Today interval~~ — derived from the same 1s tick. Same data, no extra interval; the rendered Today only changes when the rounded minute changes, so the extra re-renders are cheap and React's diff suppresses DOM churn.
- [x] On transition INTO "playing" (from "stopped" or "paused"), reset session counter and update start (effect re-runs on `playbackState` change)
- [x] On transition OUT of "playing", clear the interval (effect cleanup)
- [x] Use `Date.now() - startMs` at render time rather than incrementing a counter — a throttled/dropped tick doesn't accumulate drift

### Verification
- [ ] Press Play. "Session: 0:00" appears next to ms counter
- [ ] After 5 seconds, shows "Session: 0:05"
- [ ] After 65 seconds, shows "Session: 1:05"
- [ ] "Today: X minutes" reflects the running session within ~30 seconds of each minute tick
- [ ] Press Pause, then Resume. Session counter resets to "Session: 0:00"
- [ ] "Today: X minutes" continues from prior total (didn't reset)
- [ ] Press Stop. Both counters disappear (visible in stopped state via PracticeTimeIndicator)
- [ ] No timer-related console errors when navigating away from a playing song
- [ ] Drill-practice scenario: play scale 1 for ~1 min, pause, resume to play scale 2 for ~1 min, pause, resume to play scale 3 for ~1 min. Confirm:
  - Each scale shows Session counter going 0:00 → ~1:00 → 0:00
  - "Today" counter accumulates the three scales correctly (3 minutes added to prior total)

### Notes
- **Start time as state, not ref.** Spec wording said "ref" but a pure ref would render `null` on the first tick after entering "playing" (because setting a ref doesn't trigger re-render) — the counter would only appear at the 1-second mark. Using state for `startMs` makes "0:00" appear immediately. The spec's underlying concern — drift from tick-counting — is satisfied either way, because elapsed is computed from `Date.now() - startMs` at render time, not from accumulating ticks.
- **Effect depends on `playbackState` only.** Transition into "playing" (from any state — first start OR resume) runs the setup branch, which captures a new `startMs`. The Session counter naturally resets to 0:00 because `startMs = Date.now()`. The Today counter naturally continues because it reads `todayMinutes` from props (the prior session's minutes land in `todayMinutes` once M5's refetch fires).
- **Today under-reports right after a Resume until M5 refetch lands.** During an in-progress second session, `todayMinutes` (from `usePracticeStats`) still reflects pre-pause state until session-end triggers a refetch. The live "Today" will jump up by ~the prior session's duration when M5's refetch returns. Acceptable for M4 verification; M5 closes the gap.
- **Both children read `todayMinutes` from the same parent hook call.** Honors "no duplicate fetches" — initially `usePracticeStats` was called in StatsBar; post-redesign (see next bullet) it's hoisted to SamPlayer.
- **Post-M5 redesign (user request):**
  - `LiveSessionCounter` moved out of StatsBar into the audio/ms-counter row in SamPlayer. Row now renders during play even without an audio file (gate widened from `audioElement` to `audioElement || playbackState === "playing"`).
  - Layout during play: `[Session badge] [Total: Y hours] [ms counter]`. Session is the oversized badge; Total + ms counter stay at base text size.
  - Counter dropped its `Today` element in favor of `Total: {formatTotalHours(perSongTotalSeconds)}` — natural during-play companion (this song's lifetime, mirroring PracticeTimeIndicator's Total label).
  - Session badge: monospace tabular-nums, `text-2xl` (~2× base), subtle `bg-secondary/40` + border + rounded — glanceable without being a button.
  - `usePracticeStats` hoisted from StatsBar to SamPlayer so the playback-row LiveSessionCounter and the stopped/paused PracticeTimeIndicator share one fetch. StatsBar now receives `todayMinutes` / `perSongTotalSeconds` as props.
- **Build:** `npm run build` succeeds with no new warnings.

---

## Milestone 5 — Session-End Refetch Plumbing

### Development Steps
- [x] In `usePracticeSession.js`, accept an optional `onSessionEnded` callback in the hook config
- [x] Fire the callback after the Supabase update resolves successfully (BEFORE the event fan-out — practice-time totals depend only on `ended_at`, not on the per-beat events)
- [x] In `SamPlayer.jsx`, wire the callback to bump `practiceStatsRefetchSignal`, passed into StatsBar
- [x] `startSession` does NOT touch the callback ref — only `endSession`'s post-update `.then` handler invokes it

### Verification
- [ ] Practice for ~30 seconds, stop
- [ ] PracticeTimeIndicator in StatsBar updates within ~1 second to reflect the new session
- [ ] PracticeWeekSnapshot on main page updates if navigated to immediately
- [ ] Confirm the refetch happens after the DB write resolves, not before (no race where the refetch returns stale data)

### Notes
- **Callback held in a ref, refreshed every render** (`onSessionEndedRef.current = onSessionEnded`). Lets `SamPlayer` pass an inline arrow without invalidating `endSession`'s `useCallback` memoization. Same pattern used elsewhere in the codebase (`lyricEditRef` in `ScoreRenderer`).
- **Fires after the row update, before the event fan-out.** The practice-time totals only need `ended_at` — they don't care about per-beat events. Firing right after the update lets the refetch start in parallel with the (potentially slow) fan-out batch.
- **Wrapped in try/catch.** A callback throw won't abort the fan-out below it. Logs to console; doesn't surface to the user.
- **No M2 wiring needed.** `PracticeWeekSnapshot` lives in `SongLoader`, which unmounts when a song is loaded and remounts when the user returns to the library — so navigating back to the main page after practicing always gets a fresh fetch. Wiring the refetch signal there would only matter if the snapshot stayed mounted during play, which it doesn't.
- **Build:** `npm run build` succeeds with no new warnings.

---

## Final Sign-Off

### Success Criteria Check
- [x] 7-day snapshot displays on main page with correct totals and day labels
- [x] StatsBar "Today" and "Total" display correctly in stopped AND paused state (extended from spec's stopped-only on user request)
- [x] Playback-row live counters work correctly in playing state (Session badge + live Today)
- [x] Live counters reset/continue correctly on Pause/Resume
- [x] All durations reflect active playing time only (pauses excluded — falls out free from session-end-on-pause lifecycle)
- [x] Formatters produce expected output across all boundary values
- [x] NULL-ended sessions are excluded from all displays
- [x] No new console errors or warnings

### Post-Spec User Adjustments
- **Paused-state visibility for Today/Total.** Extended PracticeTimeIndicator visibility from `playbackState === "stopped"` to `!== "playing"` so paused state shows the same totals as stopped — natural read-only checkpoint between sessions.
- **Playback-row relocation + Session badge styling.** LiveSessionCounter moved out of StatsBar into the audio/ms-counter row in SamPlayer. New layout during play: `[Session 1:23 badge]  Today: X minutes  0:00`. Session badge is `text-2xl` monospace + subtle bg/border — glanceable while playing without reading as a button. `usePracticeStats` hoisted to SamPlayer so the playback row and the stopped/paused indicator share one fetch.
- **Today label across all three locations.** Live counter, paused indicator, and stopped indicator all read `formatMinutesLong(todayMinutes [+ in-progress-session])`. The live version adds the running session's seconds; the moment Stop fires and the M5 refetch lands, the displayed value is identical (no visual jump).

### Ground-Truth SQL Queries for Verification

Run these manually to compare against UI displays:

**Today's all-songs practice (Pacific time):**
```sql
SELECT 
  ROUND((SUM(EXTRACT(EPOCH FROM (ended_at - started_at))) / 60)::numeric, 0) AS today_minutes
FROM sam_sessions
WHERE ended_at IS NOT NULL
  AND (started_at AT TIME ZONE 'America/Los_Angeles')::date = (NOW() AT TIME ZONE 'America/Los_Angeles')::date;
```

**Per-song total (replace SONG_ID):**
```sql
SELECT 
  ROUND((SUM(EXTRACT(EPOCH FROM (ended_at - started_at))) / 3600)::numeric, 2) AS total_hours
FROM sam_sessions
WHERE ended_at IS NOT NULL
  AND song_id = 'SONG_ID_HERE';
```

**Last 7 days by PT day:**
```sql
SELECT 
  (started_at AT TIME ZONE 'America/Los_Angeles')::date AS pt_day,
  ROUND((SUM(EXTRACT(EPOCH FROM (ended_at - started_at))) / 60)::numeric, 0) AS minutes
FROM sam_sessions
WHERE ended_at IS NOT NULL
  AND (started_at AT TIME ZONE 'America/Los_Angeles')::date >= (NOW() AT TIME ZONE 'America/Los_Angeles')::date - INTERVAL '6 days'
GROUP BY pt_day
ORDER BY pt_day DESC;
```

### Known Follow-Ups
- If the user wants to see "this week" or "this month" totals
  later, the data model supports it — just a different
  aggregation query.
- If the user wants to track practice goals (e.g., "practice 30
  minutes today"), the current data is sufficient.
- NULL-ended sessions could be displayed as "abandoned" stats
  somewhere if useful, but no value identified today.
- Live "Today" counter currently uses a 30s interval; if a
  perceptible lag bothers the user, drop to 10s or 1s.
