# Project Context

The "scroll stutters at the target-line crossing" bug has been
root-caused via dev-tools instrumentation. The bug is an
HTMLMediaElement spin-up race in ScrollEngine's elapsed-time
calculation:

1. ScrollEngine's audio-sync branch is gated on
   `!audioElement.paused`, which flips synchronously when
   `play()` is called.
2. But `audioElement.currentTime` doesn't actually advance for
   ~25ms after `play()` — the audio engine takes that long to
   start producing samples. During the spin-up, `currentTime`
   reports the post-seek value unchanged.
3. ScrollEngine commits `audioSyncOffset` on the first frame
   where `!paused`, using the stale `currentTime`. For the next
   ~3 frames, `elapsed` stays frozen because `contentElapsed`
   (derived from `currentTime`) doesn't change.
4. Visually: scroll freezes for ~25ms at exactly the target-line
   crossing moment, then resumes at correct speed.

Confirmed by diagnostic logs showing `audioMs=0.0` for 3
consecutive frames before advancing on frame 4.

The fix gates `audioSyncOffset` commit on actual currentTime
advancement: track `lastAudioMs` across frames, only commit when
`audioMs > lastAudioMs`. Until then, fall through to the same
wall-clock formula used during the lead-in. Once committed, the
audio-sync branch governs as before.

# Reference Documents

- Technical spec: `docs/technical-spec-spinup-patch.md`
- Progress tracking: `docs/progress-spinup-patch.md`

# Your Task

1. Read the technical specification end to end.
2. Review the progress tracking file.
3. Apply the changes per the spec — only `ScrollEngine.jsx`
   needs to change. Two edits:
   a. Add `lastAudioMs: null` to the scrollStateRef.current init.
   b. Replace the audio-playing branch with the gated version.
4. Confirm any leftover `[DEBUG audio frame N]` console.log
   from the diagnostic round is removed.
5. Update the progress file's checklist for the development step.
6. Present the verification checklist verbatim and stop. Wait for
   confirmation before declaring complete.

# Important Constraints

- **Only `ScrollEngine.jsx` changes.** Do not touch
  `useAudioSync`, `SamPlayer`, or any other file.
- **The lead-in branch stays as-is.** The fix is to make the
  audio-playing branch behave identically to the lead-in branch
  during spin-up, not to modify the lead-in.
- **The `audioEndMs` check at the end of the branch is preserved**
  — it still runs on every frame regardless of which sub-branch
  computed `elapsed`. The spec includes the full replacement
  block including this check.
- **Do not change `audioSyncOffset`'s formula.** The formula
  `(now - scrollStartT) * rate - contentElapsed` is correct;
  the bug is *when* it gets committed, not what it computes.
- **Do not "fix" the steady-state audio-clock branch.** Once
  audio is actually advancing, the existing math is right.
- **Stop and ask** if the audio-playing branch's structure
  differs from what the spec describes, or if you find that
  removing diagnostic logs would also remove non-diagnostic
  code by accident.
