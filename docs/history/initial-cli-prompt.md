# Project Context

The resume-from-measure bug ("scroll restarts at snippet start
instead of paused measure") has been root-caused via dev-tools
instrumentation. The bug is a race condition in
`SamPlayer.handleLoopCount`:

1. ScrollEngine fires `onLoopCount(0)` at the start of every
   playback session (initial play, snippet apply, AND resume).
2. SamPlayer's `handleLoopCount` clears `pausedMeasure` on every
   call regardless of `n`.
3. After Resume, the playback effect runs once with the correct
   `firstPassStart` derived from `pausedMeasure`, sets origin
   correctly, then fires `onLoopCount(0)`.
4. SamPlayer clears `pausedMeasure → null`.
5. SamPlayer re-renders, `firstPassStart` becomes 0.
6. Playback effect re-runs and sets origin to position the
   snippet's first measure at the lead-in — overwriting the
   correct setup.

The fix is one line: only clear `pausedMeasure` on `n > 0`
(actual loop wraps), not on the initial `n=0` notification.

Diagnostic data confirming the diagnosis is in the conversation —
two `[DEBUG resume]` log entries logged 6ms apart, the first with
`firstPassStart: 2, originPx: 444.4` (correct), the second with
`firstPassStart: 0, originPx: -541.6` (snippet-start position).

# Reference Documents

- Technical spec: `docs/technical-spec-resume-patch.md`
- Progress tracking: `docs/progress-resume-patch.md`

# Your Task

1. Read the technical specification end to end.
2. Review the progress tracking file.
3. Apply the one-line change in `SamPlayer.handleLoopCount` per
   the spec.
4. Remove the diagnostic `console.log` statements that were added
   to `ScrollEngine.jsx` during root-causing — there are two:
   a `[DEBUG resume]` log inside the playback effect (around
   line 178) and a `[DEBUG frame N]` block inside the `frame()`
   function (around line 279).
5. Update the progress file's checklist for the development step.
6. Present the verification checklist verbatim and stop. Wait for
   me to walk through the verifications before declaring complete.

# Important Constraints

- **One-line code change.** The fix is `if (n > 0)` guarding the
  `setPausedMeasure(null)` call inside the existing
  `handleLoopCount` callback. Do not rewrite the callback, do not
  refactor surrounding code, do not modify the deps array.
- **Do not modify ScrollEngine** beyond removing the two debug
  log blocks. The `onLoopCount(0)` emission at session start is
  correct and intentional from ScrollEngine's perspective.
- **Do not "fix" bug #3** (scroll-speed change at target line).
  It has a separate root cause and is explicitly out of scope.
  The spec calls this out.
- **Stop and ask** if the diagnostic console.logs aren't where the
  spec says they are, or if you find that `handleLoopCount`'s
  shape differs from what the spec describes. The conversation
  history has the exact code snippet that needs changing.
