# Project Context

SAM does not currently model tuplets (triplets, quintuplets,
etc.). The MusicXML importer drops `<time-modification>`, so
triplet members get stored as their base duration (e.g.,
triplet-eighth → `"8"`). Beat math then over-counts the measure,
and the renderer has no way to draw the standard triplet bracket
and "3" label.

Concrete failing case: m.1 RH of "Someone Like You" (song ID
`98d02ba2-d628-4da9-9e74-eea5ca98a530`) stores 12 events as
`"8"`, summing to 6 beats in a 4-beat measure. The intended
content is four triplet groups of three eighths = 4 beats.

This project adds tuplet support across four milestones:
1. Data shape + beat math (`tuplet` field on events; new
   `getEventBeats` helper)
2. Importer support (read `<time-modification>` and write
   `tuplet` field)
3. Rendering (Tuplet brackets + time-correct spacing)
4. Cut-time visual (`C|` symbol — purely cosmetic, separate
   from triplets)

Triplet support (M1+M2+M3) is the primary deliverable. Cut-time
(M4) is a follow-up using the same data structure pattern.

# Reference Documents

- Technical spec: `docs/technical-spec-tuplets.md`
- Progress tracking: `docs/progress-tuplets.md`

# Your Task

1. Read the technical specification end to end before writing
   any code.
2. Review the progress tracking file.
3. Execute milestones **in the order documented in the spec**:
   M1 (data shape + beat math) → M2 (importer) → M3 (rendering)
   → M4 (cut-time).
4. **Stop after each milestone.** Update the progress file's
   checklist and Notes section, present the verification
   checklist verbatim, and wait for me to reply "verified,
   proceed" before starting the next milestone.

# Verification Pattern Per Milestone

- **M1 verification includes a manual data edit.** After
  M1's code lands, you'll need to provide the SQL or Supabase
  dashboard instructions for adding `tuplet` fields to the 12
  events of m.1 RH. I'll do the edit, recompile the song, and
  verify the beat math via dev tools console before approving
  M1.
- **M2 verification includes a real re-import.** I'll re-import
  "Someone Like You" from the original .mxl file. The newly
  imported record should have `tuplet` fields populated.
- **M3 verification is visual.** I'll cold reload, look at m.1
  in stopped and playback states, and confirm the brackets and
  "3" labels appear.
- **M4 verification is also visual.** Confirm `C|` appears for
  m.1's time signature.

# Important Constraints

- **The `tuplet` field is optional.** Events without it must
  continue to work exactly as today — beat math and rendering
  unchanged. This is strictly additive.
- **Use `getEventBeats(evt)` everywhere event durations
  contribute to beat sums.** Direct `DURATION_BEATS[evt.duration]`
  reads are the bug pattern. Grep at the end of M1 to confirm
  no direct lookups remain in code paths that consume event
  durations.
- **Do NOT modify `DURATION_BEATS` itself.** It's a static
  base-duration map; tuplet handling layers on top via
  `getEventBeats`.
- **Do NOT support nested tuplets.** If the importer encounters
  one, raise an explicit "not supported" error rather than
  producing garbage data.
- **The xShift time-proportional layout in `scoreRender.js`
  must NOT need any changes for tuplets.** It positions notes
  by cumulative beats; once `getEventBeats` returns correct
  values, tuplet members will land at correct positions
  automatically. If M3 finds that xShift needs modification,
  stop and surface — that indicates a deeper issue with how
  positions are computed.
- **VexFlow's `Tuplet` wraps already-constructed StaveNotes.**
  Don't change how StaveNotes are constructed — just add the
  Tuplet construction + draw pass after the existing flow.
- **Cross-mode consistency.** Whatever renders in
  `scoreRender.js` must also render in `ScoreRenderer.jsx`.
  Extract a shared helper if duplication appears (similar to
  `parseDuration` for dots).
- **Stop and ask** if any of the following surfaces:
  - The importer code is in an unfamiliar language or location
    you can't easily edit.
  - Beat-math sites for tuplets are in places not enumerated
    in the spec.
  - VexFlow's `Tuplet` API behaves differently than expected
    (e.g., requires notes to be in a specific Voice
    arrangement).
  - The xShift layout produces incorrect positions even after
    `getEventBeats` is updated.
  - A measure exists with mixed tuplet and non-tuplet events
    that the spec doesn't account for.
