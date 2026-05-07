# Project Context

Three reported playback bugs in SAM share one root cause:
`audioAnchors` in `lib/useAudioSync.js` doesn't have an anchor at
`beatPos: 0` when the snippet's first measure lacks an explicit
`audioOffsetMs`. This breaks the audio↔beat mapping that
ScrollEngine depends on, causing:

1. Resume restarts the scroll from the snippet's first measure
2. Snippet audio is several seconds late (audio file timestamp is
   correct, but ScrollEngine misinterprets it as a different beat
   position than the actual seek)
3. Scroll/metronome shift tempo when the first note crosses the
   target line (because `elapsed` calculation switches formulas
   discontinuously when audio starts)

The patch is small — about 5 lines added to one useMemo. It injects
a virtual anchor at `beatPos: 0` derived from
`getSeekForMeasure(snippet.startMeasure)` whenever the snippet
doesn't already have a real anchor at its start.

# Reference Documents

- Technical spec: `docs/technical-spec-sam-patch.md`
- Progress tracking: `docs/progress-sam-patch.md`

# Your Task

1. Read the technical specification end to end.
2. Review the progress tracking file.
3. Apply the patch as described in the spec — only `lib/useAudioSync.js`
   needs to change. Do NOT modify any other file.
4. Update the progress file's checklist for the development step.
5. Present the verification checklist verbatim and stop. Wait for me
   to walk through the three bug verifications and the regression
   check before declaring the patch complete.

# Important Constraints

- **Do not "improve" `getSeekForMeasure`.** It uses single-anchor
  BPM-extrapolation. That's correct for single-anchor songs (the
  only case that exists today). The multi-anchor correction is
  out of scope for this patch — it's a known follow-up that was
  scoped into the cleanup pass and never landed. The spec calls
  this out explicitly.
- **Do not modify `audioMsToBeatPos` in ScrollEngine.** It's correct
  given correct anchors. The fix is at the anchor-derivation site,
  not at the consumer.
- **Do not touch any other file** — not SamPlayer, not ScrollEngine,
  not any component. The bug surfaces in three places but the cause
  and fix are in one place.
- **The eslint-disable on the deps array is intentional.**
  `getSeekForMeasure` is a function declared in the same hook body,
  recreated each render — listing it in deps would cause infinite
  re-memoization. The values it actually closes over (`song`, `bpm`)
  are listed via `song`. This pattern is identical to the existing
  `lyricEditHandlers` memo elsewhere in the codebase.
- **Stop and ask** if you're tempted to refactor anything else. The
  larger timing-module refactor is planned as a separate change
  after this patch is verified — making the patch and the refactor
  separate diffs makes verification much easier.
