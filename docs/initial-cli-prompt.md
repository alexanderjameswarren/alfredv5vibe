# Project Context

A previous analysis (from a prior Claude Code session) correctly
diagnosed that SAM's dotted-duration note rendering is broken:
VexFlow's `StaveNote` constructor does not accept the `"d"` suffix
on duration strings (e.g., `"qd"`, `"8d"`, `"hd"`). The constructor
silently falls back to treating the duration as the base type
without a dot, and the Formatter pads the missing beats with an
auto-generated rest.

The proposed fix (correct in principle) is to parse the duration
shorthand into `(base, dots)` before constructing the StaveNote,
then attach `Dot` modifiers via VexFlow's modern
`VF.Dot.buildAndAttach` API.

This is being formalized with four refinements over the original
proposal:

1. Extract the parse logic into a shared `parseDuration` helper
   (one source of truth instead of six copy-pasted parse loops).
2. Support multiple dots via a `while` loop, not a single `endsWith`
   check (future-proofs against double-dotted notes).
3. For rests, parse the duration BEFORE appending the `"r"` suffix
   — otherwise the parser sees `"qdr"` and finds no trailing `d`.
4. Use `VF.Dot.buildAndAttach` consistently — never the older
   `addModifier(new Dot(), keyIdx)` API, which requires per-key
   calls and is easy to get wrong for chords.

SAM's beat math (`DURATION_BEATS` in `measureUtils.js`) is correct
and unrelated. Do not modify `measureUtils.js`.

# Reference Documents

- Technical spec: `docs/technical-spec-dots-patch.md`
- Progress tracking: `docs/progress-dots-patch.md`

# Your Task

1. Read the technical specification end to end.
2. Review the progress tracking file.
3. Apply the changes per the spec:
   a. Add `parseDuration` helper in `lib/scoreRender.js` and export it.
   b. Replace all four StaveNote construction sites in
      `scoreRender.js` with the parse-then-attach-dots pattern.
   c. Import `parseDuration` in `components/ScoreRenderer.jsx`.
   d. Replace both StaveNote construction sites in
      `ScoreRenderer.jsx` with the same pattern.
4. Confirm no direct `evt.duration` is passed to any `StaveNote`
   constructor anywhere in the codebase (grep to verify).
5. Update the progress file's development checklist.
6. Present the verification checklist verbatim and stop. Wait for
   confirmation before declaring complete.

# Important Constraints

- **One helper, six call sites.** Do not inline the parse logic at
  any call site. The point of the helper is to fix this in one
  place. Six copies of `while (d.endsWith("d"))` is exactly how
  the bug would silently regress later.
- **Parse BEFORE adding `"r"` for rests.** The spec is explicit
  about this. Reversing the order means `parseDuration("qdr")`
  returns `{ base: "qdr", dots: 0 }` and the bug persists.
- **Use `VF.Dot.buildAndAttach([note])` exclusively.** Do not mix
  in the older `note.addModifier(new Dot(), keyIdx)` API at any
  site. The modern API handles chords correctly in one call.
- **Do not modify `measureUtils.js` or `DURATION_BEATS`.** The
  beat-math layer is correct. Touching it is out of scope.
- **Do not modify the MusicXML importer.** Triplets remain
  unsupported; that is a separate concern.
- **Do not "improve" the duration format itself.** Don't change
  `"qd"` → `"q."` or anything similar. SAM's stored format is the
  format; the helper adapts it for VexFlow.
- **Multi-dot support is required.** Use `while (base.endsWith("d"))`
  to handle `"hdd"` (double-dotted half). SAM doesn't produce
  these today, but the parser should handle them.
- **Stop and ask** if any of the six call sites has a structure
  that differs from the spec's example (e.g., if a site mutates
  the StaveNote between construction and voice insertion in a way
  that would conflict with dot attachment).
