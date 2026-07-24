# Progress: Timer

## Status: Complete

### Development Steps
- [x] Step 1: Add "Timer" nav item (left of SAM) + route/page shell (mirror SAM wiring)
- [x] Step 2: Builder mode — total duration input + dynamic phase list (add/remove/reorder), validation, live summary
- [x] Step 3: Run engine — timestamp-based ticking, phase derivation, loop + graceful end, pause/resume/stop
- [x] Step 4: Run mode UI — phase label, countdown, animated pacing cue, overall progress
- [x] Step 5: Phase-change cues — Web Audio chime + guarded navigator.vibrate
- [x] Step 6: Styling pass — earth-tone palette, Lucide icons, spacing/polish

### Testing Steps
- [ ] Timer appears left of SAM and routes correctly; SAM and other nav still work
- [ ] Build a 5-minute breathing timer (4/4/6/7) and start it
- [ ] Per-phase countdown is accurate; phases loop in order
- [ ] Timer stops gracefully at the total duration (finishes current phase)
- [ ] Chime fires on each transition; vibration works on mobile, no error on desktop
- [ ] Pause/Resume holds timing; Stop returns to builder with config intact

### Notes

**Step 1 — Nav + route + shell**
- **New file:** `src/timer/TimerPage.jsx` — matches SamPlayer's outer shell (`min-h-screen bg-primary-bg` root, sticky `bg-card` header with back button + title, centered `max-w-4xl` body). Body is a "Builder coming soon." placeholder until Step 2.
- **Route pattern is SAM's** — Alfred uses `view` state, not a router. Added a `view === "timer"` early-return branch alongside `view === "sam"` at the top of Alfred.jsx's render; `TimerPage` receives `onBack={() => setView(previousView || "home")}` verbatim from the SAM template. Full-page takeover (not an inline view) because the Run mode needs the real estate.
- **Desktop nav:** new "Timer" button inserted immediately before the "Sam" button in the desktop nav row. Duplicated SAM's inline click handler (unsaved-changes confirm → `setPreviousView(view)` → `setView("timer")`) rather than routing through `guardedSetView`, because only the two full-page views track `previousView`.
- **Desktop button is text-only "Timer"** — matches the sibling nav buttons (Home / Inbox / Contexts / etc. + SAM) exactly; the icon lives in the mobile drawer per the existing pattern. Spec says "Match the existing nav item markup/styling exactly" for the desktop nav; interpreted as "no icon on desktop" since SAM has none.
- **Mobile drawer:** added `{ key: "timer", label: "Timer", icon: <Timer className="w-4 h-4" /> }` immediately before SAM's entry in the drawer's array. Extended the drawer's inline `if (item.key === "sam")` `previousView` capture to cover `"timer"` too.
- **Icon:** `Timer` from `lucide-react` — already imported at the top of Alfred.jsx (unused before this change); no new import needed.
- **Build:** `npm run build` succeeds with no new warnings.

**Step 2 — Builder mode**
- **Structure**
  - `TimerPage.jsx` upgraded from a shell to a mode switcher. Owns config state (`totalMinutes`, `totalSecondsIn`, `phases`, `loop`) so a Stop from Run returns to Builder with the config intact — state lives above the mode conditional.
  - New: `src/timer/components/TimerBuilder.jsx` — the builder UI (total duration, phase list, summary, Start).
  - New: `src/timer/components/TimerRun.jsx` — placeholder for Steps 3-4 that closes the Builder → Run → Builder loop for Step 2 verification.
- **Numeric inputs**
  - Total duration uses `useNumericInput` (two hooks: minutes + seconds), imported from `../sam/lib/useNumericInput`. Reusing the SAM utility rather than duplicating; if a future `src/lib/` extraction happens, one grep updates both. Minutes clamps to `[0, 180]`, seconds to `[0, 59]`.
  - Per-phase `seconds` uses inline commit-on-blur rather than a hook per row — React hooks can't be called from inside a `phases.map`, so the same clamp pattern (`Number()` → `min/max` → `round` → write back) is inlined via `commitPhaseSeconds`.
- **Phase model**
  - Each phase is `{ id, label, seconds, secondsInput }` — `id` from `crypto.randomUUID()`, `secondsInput` holds the draft string so the numeric commit can round-trip. New phases seed with `{ label: "", seconds: 0 }` — validation guards Start until every phase has `seconds > 0`.
  - Reorder is up/down arrow buttons (swap adjacent indices); up disabled on row 0, down disabled on the last row. Trash button removes.
- **Validation for Start**
  - `canStart = totalSeconds > 0 && phases.length > 0 && phases.every(p => p.seconds > 0)`. Button styling flips between primary and disabled-secondary; `cursor-not-allowed` when off.
- **Live summary line**
  - Three states: no phases → "Cycle: — · Add phases to see how many fit."; cycle longer than total → "Cycle: Xs · Total duration is shorter than one cycle."; otherwise → "Cycle: Xs · ~N cycles fit in Ms." (singular "cycle" for N=1).
- **Loop toggle deferred**
  - Config has `loop: true` hardcoded for now. No UI toggle in Step 2 — the checkbox would be non-functional until Step 3 lands the engine; will add alongside engine to avoid the "why doesn't this do anything?" confusion.
- **Build:** `npm run build` succeeds with no new warnings.

**Step 3 — Run engine**
- **Hook:** new `src/timer/lib/useTimerEngine.js` — `useTimerEngine({ totalSeconds, phases, loop })` returns `{ status, elapsedMs, remainingMs, effectiveEndMs, currentPhaseIdx, currentPhase, phaseElapsedMs, phaseRemainingMs, phaseTotalMs, pause, resume }`. UI-agnostic; Step 4's Run UI + Step 5's cues both hang off this.
- **Timestamp discipline, not tick-count** — every rAF frame reads `performance.now()` and computes `elapsed = accumMs + (now - startTs)`. Drift-free: a dropped/throttled frame just snaps back to true elapsed on the next tick rather than under-counting.
- **Pause/Resume math** — on pause, fold `now - startTs` into `accumMs` and null `startTs`. On resume, the tick effect re-anchors `startTs = performance.now()` when status flips to "running". Paused wall-clock is invisible to the schedule.
- **Phase derivation** — `computePhase(elapsedMs)` walks the cumulative phase durations. Loop=true uses `elapsedMs % cycleMs` to map into the current cycle; loop=false clamps at `cycleMs` so past-end reads as the last phase.
- **Graceful end** — `computeEffectiveEndMs(phases, totalMs, loop)` snaps `totalMs` UP to the next phase boundary (or the exact boundary if it lands cleanly). Engine keeps running past `totalMs` until it hits that boundary, then flips to `status = "ended"`. Loop=false caps at one full cycle regardless of totalMs (documented in the code).
- **RAF, not setInterval** — rAF for smooth countdown display and the Step 4 pacing-cue animation. Overhead is trivial (single tiny subtree; React reconciles quickly).
- **Cleanup discipline** — tick effect uses a `cancelled` closure flag plus `cancelAnimationFrame` on cleanup; unmount (via Stop → parent flips mode → hook unmounts) cancels the frame cleanly.
- **Run mode UI (minimal, for Step 3 verification)** — `TimerRun.jsx` now wires the engine and shows: phase index/count · status badge · phase label · MM.Xs countdown · per-phase progress bar · overall elapsed/remaining seconds + overall progress bar · Pause/Resume/Stop buttons. Step 4 replaces this with the polished layout (large phase label, animated expanding/contracting circle, better typography). Step 5 layers the chime + haptics on top.
- **No visible loop toggle yet** — TimerPage still hardcodes `loop=true`. The engine already handles loop=false correctly; UI toggle can land in Step 4 or 6.
- **Build:** `npm run build` succeeds with no new warnings.

**Step 4 — Run mode polished UI**
- **Layout** — vertical centered stack: status pill → big phase label (`text-4xl sm:text-5xl`) → 18rem pacing-cue container → giant monospace countdown (`text-6xl tabular-nums` + smaller "s" suffix) → overall progress bar with elapsed/target labels → transport row.
- **Pacing circle** — 16rem circle inside an 18rem fixed-size container. Container size is stable so the scaled child never pushes surrounding elements around. `transform: scale(...)` updated ~60fps by rAF; no CSS transition on the transform (would fight the rAF loop). Colored with `bg-primary/20 border-4 border-primary` for a soft breathing look.
- **Scale rule** — label-based classifier (see `classifyPhase`): substring "out"/"exhale" → out, else substring "in"/"inhale" → in, else hold. "Out" checked first because it's the more distinctive substring. "In" phases expand `0.4 → 1.0` linearly across `phaseFraction`; "out" contracts `1.0 → 0.4`; hold phases sit at the FINAL scale of the most recent non-hold phase — so "Breathe in / Hold" visually holds at the top of the breath, "Breathe out / Hold" holds at the bottom. If no prior in/out (or the sequence is all hold), sits at the midpoint.
- **Countdown format** — one tenth-second resolution (`"3.0"`, `"2.9"`, ..., `"0.0"`). Reads smoothly and doesn't flicker the whole-second digit at frame boundaries; the "s" suffix is smaller and muted to keep the number the visual anchor.
- **Ended state** — pill reads "Complete", label reads "Done", circle is replaced with a solid check-mark badge (Lucide `Check` inside a filled-primary circle), countdown hidden. Stop button relabels to "Back to Builder".
- **Overall progress** — bar spans `w-full max-w-md`; elapsed/target seconds shown as small labels above (formatted as `Xm Ys` or `Ys`). Target = `effectiveEndMs` from the engine, so the label reflects the graceful-end snap rather than the raw total duration.
- **Transport** — Pause (amber, matches the SAM Focus-mode Pause pill), Resume (primary), Stop (secondary/bordered — matches SAM's paused-state Stop). Buttons swap based on `status`.
- **Progress-bar bug (post-verification fix):** removed `transition-[width] duration-100` from the overall progress bar. rAF was already updating width every frame, but the 100 ms CSS transition chased a moving target — visible width only advanced a fraction of true elapsed and snapped to the correct position on Pause. Direct style update (no CSS transition) fixed it and matches the pattern used by the circle's `transform: scale`.
- **Build:** `npm run build` succeeds with no new warnings.

**Step 5 — Chime + haptics**
- **Hook:** new `src/timer/lib/usePhaseCues.js` — `usePhaseCues({ currentPhaseIdx, status })`. Watches those two engine outputs and fires cues on transitions. Zero return value; pure side-effect hook wired at the top of TimerRun.
- **Fires on:**
  - Initial mount (prev index is `null` → first phase index differs → cue fires) — gives the first "Breathe in" a start cue.
  - Any `currentPhaseIdx` change while `status === "running"` — one short sine chime at 880 Hz for 120 ms + `navigator.vibrate(40)`.
  - Transition `status !== "ended" → "ended"` — distinct two-tone "ding-dong" (660 Hz then 990 Hz at +180 ms, both ~150-200 ms) + `vibrate([60, 40, 80])`.
- **Silent on** pause/resume (currentPhaseIdx unchanged), remounts of the same-status/same-idx render pass, and unmount.
- **AudioContext** lazily created inside the effect via `window.AudioContext || window.webkitAudioContext`. Runs downstream of the Start-click gesture, so autoplay policy admits an immediate `resume()` on any suspended context. `resume()` failures are caught and swallowed — cue silently drops rather than crashing the run.
- **Chime envelope:** `linearRampToValueAtTime(0.15)` over 10 ms attack, then `exponentialRampToValueAtTime(0.001)` for decay. Short attack keeps the tone from clicking; exponential decay is gentler than a hard stop. Peak gain 0.15 so it's audible over ambient noise but not startling.
- **Web Audio scheduling** (`ctx.currentTime + delay`) for the two-tone end cue rather than `setTimeout` — precise to the audio clock and immune to main-thread jank.
- **Vibrate** — `"vibrate" in navigator` feature-detect; wrapped in try/catch (some browsers throw on invalid patterns). No-op on desktop, buzzes on supporting mobile.
- **Build:** `npm run build` succeeds with no new warnings.

**Step 6 — Styling pass**
- **Builder sections wrapped in `bg-card border border-border rounded-lg p-4` cards** — visually chunks the builder into "Total duration" and "Phases" cards, then a free-floating summary+Start row below. Card container matches the SAM SnippetPanel + song-library styling exactly.
- **Section headings gained Lucide icons** — `Clock` on "Total duration", `LayoutList` on "Phases". Small (`w-4 h-4`) and muted (`text-muted-foreground`) so they scan as label metadata, not attention-grabbers.
- **Loop toggle added** — right-aligned inside the "Total duration" row with a `Repeat` icon and a plain checkbox styled `accent-primary`. Wired end-to-end: `TimerPage` upgraded the loop useState to be mutable and passes both `loop` and `onLoopChange` down; the engine already handled `loop=false`, so unchecking it now correctly runs the phase list once and stops at the last phase boundary (or at total-duration snap, whichever is earlier).
- **Phase rows** now sit on `bg-background` inside their `bg-card` container — a subtle two-tone that makes the row edges legible without adding lines. Empty state got a friendlier prompt.
- **Start button** grew slightly (`px-5` + `shadow-sm`) and moved to a right-aligned position in the summary row on desktop (`sm:flex-row`), which keeps the summary line the leftmost read and Start the terminal call-to-action.
- **Run mode pacing circle** — outer opacity dropped from `bg-primary/20` to `bg-primary/15` for a softer fill; added an inner concentric ring (`w-3/4 h-3/4 rounded-full border border-primary/40`) to give the circle depth without competing with the animation; `shadow-sm` grounds it against the background. Inner ring scales with the outer circle (it's a child of the transformed div), so the depth cue rides the breath.
- **Ended-state check** — bumped the check badge from 40 rem-square to 44, and the `Check` icon from `w-16` to `w-20` (`strokeWidth={3}` retained) so completion feels more decisive.
- **Lucide-only icons throughout** — no emoji, no custom SVG. Icons touched this step: `Clock`, `LayoutList`, `Repeat` (added). All others (`Plus`, `Trash2`, `ArrowUp`/`Down`, `Play`, `Pause`, `Square`, `Check`, `Timer`, `ArrowLeft`) were already Lucide.
- **Semantic tokens throughout** — `text-foreground` / `text-muted-foreground`, `bg-card` / `bg-background`, `border-border`, `text-primary` / `bg-primary` / `bg-primary/15`, `text-destructive`. Follows the CSS-variable palette that other pages use; earth-tone or otherwise, we inherit whatever the design tokens resolve to.
- **Build:** `npm run build` succeeds with no new warnings.

### Testing Steps
- [x] Timer appears left of SAM and routes correctly; SAM and other nav still work
- [x] Build a 5-minute breathing timer (4/4/6/7) and start it
- [x] Per-phase countdown is accurate; phases loop in order
- [x] Timer stops gracefully at the total duration (finishes current phase)
- [x] Chime fires on each transition; vibration works on mobile, no error on desktop
- [x] Pause/Resume holds timing; Stop returns to builder with config intact
