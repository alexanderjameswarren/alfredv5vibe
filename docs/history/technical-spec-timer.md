# Technical Spec: Timer (Alfred)

## Overview
Add a standalone **Timer** tool to Alfred: a new top-level nav item (placed to the
LEFT of SAM) that opens a page where the user builds a looping, multi-phase timer
and runs it. First concrete use case is a breathing timer (e.g. in 4s / hold 4s /
out 6s / hold 7s), but the model is general — any sequence of labeled, timed phases
that repeats until an overall duration elapses.

## Scope decisions (v1)
- **Standalone tool**, mirroring how SAM is wired (nav item + top-level page/route).
  This is NOT an item element type and does NOT touch the execution / freeze
  pipeline. That integration is deliberately deferred to a later phase.
- **Units are seconds**, entered directly. No "counts" abstraction.
- **No persistence.** The user builds the sequence fresh each session. Saving named
  presets (localStorage or a Supabase table) is a future enhancement, out of scope.
- **No new dependencies.** Use existing React, Tailwind, and Lucide React. Audio via
  the built-in Web Audio API; haptics via `navigator.vibrate`.

## Data model (in-memory, client-side only)
```
Phase       = { id: string, label: string, seconds: number }
TimerConfig = {
  totalSeconds: number,   // overall duration cap
  loop: boolean,          // default true; if false, run the phase list once
  phases: Phase[]         // ordered
}
```

## UI

### Nav
- Add a "Timer" entry immediately to the LEFT of "SAM" in the existing nav.
- Use the Lucide `Timer` icon. Match the existing nav item markup/styling exactly
  (follow the SAM nav item as the template).
- New route (mirror SAM's routing setup), e.g. `/timer`.

### Page — two modes on one page: Builder and Run

**Builder mode (default)**
- **Total duration** input at the top (minutes + seconds, or a single seconds field —
  follow whatever numeric-input pattern already exists in the app).
- **Phase list**: a dynamic, add-as-you-go list. Each row has:
  - a text **label** field ("Breathe in", "Hold", "Breathe out", ...)
  - a numeric **seconds** field
  - a remove (trash) button
- **"Add phase"** button appends a new empty row.
- Simple reorder via up/down arrow buttons on each row (drag-and-drop is optional /
  future).
- A live summary line: total cycle length (sum of phase seconds) and roughly how many
  full cycles fit into the total duration.
- **"Start"** button switches to Run mode. Disable it if there are zero phases or any
  phase has 0 seconds.

**Run mode**
- Large display of the **current phase label** and a **countdown** for that phase.
- A visual pacing cue: an expanding/contracting circle (or bar) that animates over the
  current phase's duration — expand on "in", contract on "out". Keep it simple and
  smooth.
- Overall progress: elapsed / total remaining against `totalSeconds`.
- **Pause / Resume** and **Stop** (returns to Builder with the config intact).
- On each phase transition: a short audio chime (Web Audio oscillator) and
  `navigator.vibrate` (guarded — feature-detect, no-op if unavailable).

## Run engine
- **Timestamp-based**, not naive `setInterval` counting, to avoid drift. Track a start
  timestamp (`performance.now()`) and compute elapsed on each tick (rAF or a 100–250ms
  interval). Derive current phase + remaining from elapsed.
- **Pause** freezes accumulated elapsed; **Resume** re-anchors the start timestamp.
- **Loop behavior**: cycle through `phases` repeatedly. **Graceful end** — when the
  total elapsed reaches `totalSeconds`, finish the CURRENT phase rather than cutting
  off mid-phase, then stop. (Adjustable; noted here so behavior is explicit.)
- If `loop` is false, run the phase list once and stop.

## Styling
- Follow the Phase 7.5 warm earth-tone palette and existing Tailwind conventions.
- Lucide React icons throughout (no emoji).

## Success criteria
- "Timer" appears in the nav to the left of SAM and routes to the Timer page.
- User can set a total duration, add several labeled phases with second values,
  reorder and remove them.
- Start runs the sequence: correct phase order, accurate per-phase countdown, looping,
  and a graceful stop at the total duration.
- Phase transitions produce an audible chime (and vibration on supporting devices).
- Pause/Resume/Stop behave correctly; Stop returns to the builder with the config kept.
- No regressions to existing nav/routes (SAM etc. still work).

## Out of scope (future)
- Saving/loading named presets (e.g. "Box breathing").
- Timer as an item element type; attaching a timer to an execution step; freeze-at-start
  integration.
- Per-phase custom sounds or spoken cues.
