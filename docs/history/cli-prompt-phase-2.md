# Project Context

SAM is a personal piano practice app. We're building a pipeline that takes a
song that's too hard and produces a version at my current playing level, by
mechanically thinning the accompaniment while leaving the melody untouched.

Phase 0 (complete export format) and Phase 1/1.5 (analyzer with calibrated
thresholds) are done and committed. This is Phase 2: the transform engine.

It is a LOCAL CLI only. No database writes, no Edge Function, no UI. It reads
a song JSON and a plan JSON and writes a new song JSON, which I import through
the SAM UI myself.

# Reference Documents

- Technical spec: `docs/technical-spec-sam-simplifier.md`
- Progress tracking: `docs/progress-sam-simplifier.md`
- Export format: `docs/song-export-format.md`
- Existing analyzer: `tools/sam-tools/lib/analyze.js`
- Duration math: `tools/sam-tools/lib/durations.js`

# The property that governs everything

Claude selects from a fixed enum of settings. The code writes every note.
A language model never emits notation. If you find yourself implementing
anything that would let a plan specify pitches directly, stop and ask me —
that was requested and deliberately declined.

# Your Task

1. Read the technical spec in full before writing anything.
2. Read the progress tracker.
3. Execute M1 only.
4. Update the progress file, ticking what you completed.
5. Give me explicit verification steps.
6. Stop and wait for my confirmation before starting M2.

# Constraints

- Reuse `lib/durations.js` for all duration math and `lib/analyze.js` for
  metrics. Do not reimplement either.
- Beat position is IMPLIED, not stored. Walk each hand's event array
  accumulating durations. Tuplet events scale by `normal/actual`;
  `durations.js` handles this.
- Measure numbers in plans are PLAYED numbers (`number`), not printed
  (`sourceMeasure`).
- No new tables, no new MCP tools, no migrations, no changes to the parser,
  the export, or the schema. If you think you need one, stop and tell me.
- Work on a branch.

# Verification Pattern

After each milestone, tell me exactly what to run and what output proves it
worked. Two milestones (M2 and M6) require mutation tests — deliberately break
something and prove the check catches it. A check that has never failed has
not been tested.

# Important

- Mark steps complete in the progress file as you go.
- Note any decisions or surprises in the Notes section.
- If the spec is ambiguous or you disagree with it, stop and ask rather than
  guessing. Several details in it were settled after long discussion and the
  reasoning may not be obvious from the text.
