# Project Context

The five-milestone refactor of SAM is complete and verified. This is a
follow-up cleanup pass addressing five specific issues surfaced during
review:

1. `getSeekForMeasure` ignores audio anchors when the target measure
   has no `audioOffsetMs` — latent correctness bug for multi-anchor
   songs.
2. `saveLyrics` does N+1 row updates and can leave rows + blob
   inconsistent on partial failure.
3. `useNumericInput.commit()` treats `0` as invalid input.
4. `lyricEditHandlers` memo deps work today but are fragile to extend.
5. Five default settings values (BPM 68, timing 300, chord 80, width
   300, speed 100) and several geometry/audio constants are duplicated
   across files. Extract to `lib/samConstants.js`.

This is preparation for an upcoming playback debugging session — the
goal is a clean codebase where "is this a real bug or a refactor
artifact" has an easy answer.

# Reference Documents

- Technical spec: `docs/technical-spec-sam-cleanup.md`
- Progress tracking: `docs/progress-sam-cleanup.md`

# Your Task

1. Read the technical specification end to end before writing any code.
2. Review the progress tracking file.
3. Execute the milestones **in the order documented in the spec**:
   M1 (constants) → M2 (commit zero) → M3 (handlers memo) →
   M4 (anchor-aware seek) → M5 (saveLyrics atomicity).
4. **Stop after each milestone.** Update the progress file's checklist
   and Notes section, present the verification checklist verbatim, and
   wait for me to reply "verified, proceed" before starting the next
   milestone.
5. **For Milestone 5 specifically:** there is a manual prerequisite —
   confirm the unique constraint on `sam_song_lyrics(song_id,
   word_order)` before generating code, since the implementation
   differs based on the answer. Use the Alfred MCP
   `get_database_schema` tool if available, otherwise ask me to run
   the SQL query in the spec.

# Verification Pattern

Each milestone has its own verification checklist in the progress
file. Of particular note:

- **M1 verification:** grep the modified files for the magic-number
  literals being extracted — confirm none remain outside JSX class
  strings or unrelated contexts. This is the "did we actually finish"
  check for the constants extraction.
- **M4 verification:** the multi-anchor test is the actual fix. The
  single-anchor test confirms no regression. Both must pass. If a
  multi-anchor test song doesn't exist, the verification calls for
  temporarily adding a second anchor to "Someone Like You" via the
  audio-offset editor — and removing it afterward.
- **M5 verification:** includes a manual network-throttling test to
  confirm partial-failure handling works as designed.

# Important Constraints

- **No behavior changes** except #1, which fixes a latent bug. After
  M1 (constants), the app should behave identically to before.
- **Do not modify** the lyric storage architecture, the Supabase
  schema, or the four already-sized components (`AudioControls`,
  `StatsBar`, `SnippetPanel`, `ScoreRenderer`).
- **Do not modify** `useMIDI`, `usePracticeSession`, or
  `measureCompiler`.
- **The constants extraction (M1) is mechanical** — no logic changes.
  The point is one source of truth for default values and geometry.
  If you find yourself rewriting logic in M1, stop and ask.
- **The anchor interpolation in M4** must mirror the existing
  `audioMsToBeatPos` in `ScrollEngine.jsx`, just inverted. Read that
  function first to understand the established convention before
  implementing the inverse.
- **For M5,** if the unique constraint check comes back negative, do
  NOT add the constraint as part of this work — use the fallback
  approach and note it in the progress file. Schema changes belong in
  their own pass.
- **Stop and ask** if you need clarification on anchor math, the
  upsert-vs-fallback decision, or whether a constant is in or out of
  scope for extraction.
