# SAM tempo — progress

Spec: `docs/technical-spec-sam_tempo-t7r.md`. No database work. **Done 2026-10-27.**

## Decisions (2026-10-27)

- Compare the HEARD tempo, round(bpm × speed / 100), with the plan item's
  `target_effective_bpm`. Never `default_bpm` or `goal_bpm`.
- Identity matching only (same saved snippet, or the whole song), via
  `itemForLoadedRange`. No matching by bars.
- A pass counts on tempo at or above the target, with no tolerance (migrations
  054 and 078, `passQualifies`). So slower is red "Below plan goal: 60", and
  faster is blue "Faster than plan (60)", which still counts. Never amber (the
  Goal button's colour).
- Quiet on warm-up rungs below 100%, and when paused mid-ladder.
- Set tempo moved from the plan line to the rail, directly above Save, shown
  only when slower or faster.
- Playing-bar alert in the top row beside Pause.
- Resume fix: ScrollEngine reads `firstPassStart` only when a run starts; it is
  no longer a reason to restart one.
- Warm-up rung advance: an explicit signal (`continueAtWrapRef`), not timing.
- Audio finishing loading after Play still restarts the scroll: left as is.
- Warm up is hidden on the GBOF drill items by design: their plan items set
  `warmup_ladder: []`.

## Steps

- [x] **1. Plan.** Files, claims check, Part B candidates.
- [x] **2. Comparison helper.** `planTempoCheck` in `activePlan.js`, with tests.
- [x] **3. Tempo box and Set tempo.** Warning under the box, box border to match,
  live from the draft; Set tempo moved to the rail above Save. Temporary
  diagnostic logging added. *Check:* passed in Chrome.
- [x] **3b. Wording** "Below plan goal: 60"; Warm up visibility explained.
- [x] **4. Part B reproduced** by Alex on desktop: at the first wrap after Resume,
  `firstPassStart 2→0` restarted the scroll into a second lead-in.
- [x] **5. Part B fix.** Resume fix, with `ScrollEngine.restart.test.jsx`.
  *Check:* passed on desktop, with and without a tempo change.
- [x] **6. Explicit warm-up signal** (replaced a 250ms rule). The engine test
  fails on the pre-Step-4 engine (3333ms lead-in) and passes now.
- [x] **7. Playing-bar alert** in `FocusedPlaybackBar`. *Check:* passed on desktop.
- [x] **8. Clean-up.** Temporary logging removed. Full app suite, CLI tooling
  suite and production build all pass.
