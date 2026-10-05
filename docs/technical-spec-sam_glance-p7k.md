# SAM glance line — technical spec (sam_glance-p7k)

Goal: while playing a plan item, one line answers "am I done?" at a glance, and
it is correct during the rest bar — the only moment Alex can read the screen.

## What is on screen while playing

- **Top row:** Pause, Session, Playthrough current/target, Completed Passes,
  Practiced today. Plan n/m is no longer here.
- **Warm-up strip** (while a ladder runs), unchanged. On a warm-up plan item it
  ends with the plan readout, e.g. "Warm-up · rung 1 of 2" (or "Warm-up" /
  "Warm-up ✓" when no ladder is running).
- **Goal line** (`PlanGoalLine`), on any plan item that is not a warm-up item:
  - in a row: `In a row 90% (60) ●●○○ · best 2 of 4 today · Plan 2/4`
  - otherwise: `Goal 90% (60) ●●○○ · Plan 2/4` (free play: tempo only)
  - no plan item: no line, as before.

## Behaviour

1. Dots are 16px circles; filled ones are solid `done-strong` green. In a row:
   the current run. Otherwise: today's qualifying count.
2. Done: the whole line is `bg-done` with dark text and a 28px check; all dots
   filled; the plan text reads "Plan ✓". The line has a fixed min-height so
   the check does not move anything.
3. Playthrough figure: green (`done-strong`) at or above target, amber
   (`amber-700`) below, em dash before any graded note. The red "can't reach"
   warning still shows mid-pass, but once the music ends the finished pass is
   shown as amber "short".
4. Pulse: a qualifying pass gives the line a green ring and pale green
   background; a broken in-a-row run (run > 0, then a pass that does not
   qualify) gives an amber ring and background. 450ms, then a 300ms colour
   transition back. Ring is a box-shadow, so nothing moves.

## Timing

Every indicator updates at `onContentEnd` — the end of the music, which is the
start of the rest bar — not when the database answers.

- `SamPlayer.creditPlanPass` judges the pass with `passQualifies` (the
  database's rule) at that instant, for every non-warm-up plan item, and keeps
  page-lifetime live credit per item: `run`, `bestRun`, `qualifying`, and
  `baseline` (the database's qualifying count when the first was credited).
- `liveItemState` folds that into `itemState`: in a row takes
  `max(db streak, bestRun)`; otherwise `max(db qualifying, baseline + qualifying)`.
  Both live figures are lower bounds of what the database will return, so the
  refetch can move the count forward but never back — no flicker.
- Only the playing bar uses the live state. Stopped and paused views read the
  database alone, as before.
- Practice mode credits nothing (it writes no rows).
- The playthrough figure hides the previous pass once the next has started
  (`sessionStats.playthroughLoop !== loopCount`), so it shows the em dash from
  the wrap until the first graded note.

On a range with **no rest bars**, the end of the music and the next pass are
the same instant, so the playthrough figure goes straight to the em dash; the
goal line still updates and pulses.

## Colours

New tokens in `src/index.css`, exposed in `tailwind.config.js` as `done`:
`--done #4ADE80`, `--done-foreground #052E16` (~11:1 on done),
`--done-strong #15803D` (~5:1 on the page), `--done-light #DCFCE7`.
Amber uses Tailwind's amber scale, as the rest of the app already does. The app
has no dark theme today; these are tokens so one can override them later.
