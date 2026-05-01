# Project Context

We're refactoring SAM, a web-based piano practice app built on React +
VexFlow. Two components have grown beyond their seams: `SamPlayer.jsx`
(1,015 lines) is doing audio sync, lyric editing, and orchestration all
at once, and `SettingsBar.jsx` (806 lines, 30+ props) is a god
component. `ScrollEngine.jsx` also bundles ~400 lines of pure VexFlow
rendering with React-bound animation logic.

This is a behavior-preserving refactor — no new features, no schema
changes, no UI changes. Just extracting cohesive subsystems into
hooks and modules so the codebase is ready for the upcoming audio
stem separation and Tone.js GrainPlayer work.

# Reference Documents

- Technical spec: `docs/technical-spec-sam-refactor.md`
- Progress tracking: `docs/progress-sam-refactor.md`

# Your Task

1. Read the technical specification end to end before writing any code.
   The five milestones must be done in the documented order — milestone
   3 (audio sync) depends on milestone 2 (settings split) landing first
   so SamPlayer's prop forwarding is clean when audio sync extracts.
2. Review the progress tracking file.
3. Execute **only Milestone 1** (Extract `useLyricEditor`). Do not
   start Milestone 2 in the same pass.
4. After completing the development steps for Milestone 1, update
   `progress-sam-refactor.md` to mark each completed step.
5. Provide the verification instructions from the progress file
   verbatim, then stop and wait.

# Verification Pattern

After Milestone 1, I will:
- Run the app locally
- Load "Someone Like You" (song ID `2545eec0-ddc7-44d7-a7c8-300693acfcc3`)
- Walk through the lyric-editing verification checklist in
  `progress-sam-refactor.md`
- Reply "verified, proceed" or describe any issues found

Only after I confirm verification do you proceed to Milestone 2.
The same pattern repeats for milestones 2, 3, 4, and 5.

# Important Constraints

- **Do not change behavior.** If you find a bug while refactoring,
  note it in the progress file's Notes section but do not fix it as
  part of the refactor.
- **Do not modify these subsystems:** `measureCompiler`, `useMIDI`,
  `usePracticeSession`, the Supabase schema, the lyric storage
  architecture (separate `sam_song_lyrics` table merged at compile
  time), or any MCP-write boundaries.
- **Do not modify these files** (they're already appropriately sized):
  `AudioControls.jsx`, `StatsBar.jsx`, `SnippetPanel.jsx`,
  `ScoreRenderer.jsx`.
- **Lint/run after each milestone.** Confirm no new console warnings
  before declaring a step complete.
- **Update the progress file** after each milestone, both checklist
  and Notes section (decisions made, anything surprising).
- **If you need clarification** on hook signatures, prop boundaries,
  or whether something is in or out of scope, stop and ask.
- **Stop after each milestone's verification step is presented** —
  do not chain into the next milestone without my confirmation.
