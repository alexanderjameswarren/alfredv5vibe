# Project Context

SAM is a personal piano practice app. Phase 2 built a simplifier that generates
easier versions of songs by thinning the accompaniment. It works — the first
simplified song plays correctly.

This is Phase 6: a visual diff so I can see what the simplifier removed. Most
of what it changes is the left hand, and the change is large — Someone Like You
went from 866 left-hand events to 301. Seeing the original matters.

# Reference Documents

- Technical spec: `docs/technical-spec-diff-overlay.md`
- Progress tracking: `docs/progress-diff-overlay.md`
- Simplifier spec: `docs/technical-spec-sam-simplifier.md`

# This phase is experimental

The spec is a sequence of experiments, not a design. Each milestone puts
something on screen, I screenshot it, and we decide together whether to keep
it, adjust it, or try the next approach.

**Stop after every milestone.** Do not build ahead, do not optimise, do not
generalise. Virtualisation, caching, and abstraction all wait until an approach
has been chosen. The cost of trying an approach is low; the cost of building
the wrong one thoroughly is not.

# Your Task

1. Read the technical spec in full.
2. Read the progress tracker.
3. Execute M0 (prerequisites) only.
4. Update the progress file.
5. Give me explicit verification steps.
6. Stop and wait before starting M1.

# Constraints

- **Stopped state only.** No overlay during playback.
- **Never touch VexFlow elements.** All drawing goes into an isolated `<g>`,
  following `drawFingeringOverlay`'s documented invariant. That isolation
  exists so playback recolouring can't interfere with the layer — preserve it.
- **Follow the `fingeringMode` pattern** for the mode toggle. Local state in
  `SamPlayer`, layer-only effects in `ScoreRenderer`, button in the stopped
  branch. Do not invent a new pattern.
- **No stacked scores.** Rendering the parent as a second full score is out of
  scope this phase. It remains the fallback if every overlay approach fails.
  Do not build toward it.
- No new tables, no new MCP tools, no migrations. If you think you need one,
  stop and tell me.
- Work on a branch.

# The trap to watch for

`activeMeasures` applies snippet slicing and lyric injection before rendering.
The parent's measures need the identical slice or the overlay silently
desynchronises and the diff looks wrong for reasons that have nothing to do
with the diff. Assert measure numbers match between the two sliced arrays
before drawing anything.

# Important

- Mark steps complete in the progress file as you go.
- Note decisions and surprises in the Notes section.
- If the spec is ambiguous or you disagree with it, stop and ask. Several
  decisions in it were settled after long discussion and the reasoning may not
  be obvious from the text.
