# Progress: SAM Diff Overlay (Phase 6)

## Status: M1 built, awaiting screenshot

Branch: `phase-6-diff-overlay`

Spec: `docs/technical-spec-diff-overlay.md`

This phase is a sequence of experiments. **Stop after every milestone and wait
for the user's screenshot and verdict before continuing.** Do not optimise,
generalise, or build ahead.

---

### M0 — Prerequisites ✅

Files: `tools/sam-tools/lib/report.js`, `src/sam/lib/songLoad.js`,
`src/sam/components/SongLoader.jsx`, `src/sam/components/ScoreRenderer.jsx`

- [x] `buildRunReport` emits `resolvedSettings` — per-measure effective settings
      plus status (transformed / untouched / unneeded / unable)
- [x] Read-only fetch-by-id extracted as a shared helper, including the
      `isMeasuresStale` / `recompileMeasures` check
- [x] `sam-note` element ids carry a per-instance prefix

**Exit criteria**
- [x] Regenerating Someone Like You produces a report containing
      `resolvedSettings` with 82 entries
- [x] The parent song can be fetched by id without duplicating staleness logic
- [⚠] No duplicate element ids with two renderers mounted — **not automatable
      this phase**; see Notes. Mechanism is in place and verifiable by hand.

143 sam-tools tests + 106 app tests, all passing. App builds clean.

---

### M1 — Positioning proof

The narrowest test that beat-offset-to-x works. Measures 1–4 only, LH only,
fixed opacity, no toggle.

- [x] Resolved: **derivable from `applyTimeProportionalLayout`, not from
      `buildGeometry`.** Answer recorded in the Notes.
- [x] Parent song loaded read-only alongside the child
- [x] Snippet slice applied identically to both; measure numbers asserted to
      match before drawing
- [x] Faint noteheads drawn for every parent LH note in m1–4 at computed x
      and pitch y

**Exit criteria**
- [ ] User screenshots m1–4
- [ ] Ghosts trace the original sixteenth-note arpeggio under the four
      simplified quarter chords at visibly correct beat positions

---

### M2 — Full ghost layer

- [ ] Whole song, both hands
- [ ] Drawn in an isolated `<g>`, never touching VexFlow elements
- [ ] Bare noteheads only — no stems, beams, or flags
- [ ] RH ghosts at the same x as their real event (index alignment is exact)
- [ ] Opacity control in the stopped-state UI
- [ ] Per-hand toggles: RH ghosts / LH ghosts / both
- [ ] Overlay mode toggle following the `fingeringMode` pattern

**Exit criteria**
- [ ] User screenshots at several opacity levels and hand combinations
- [ ] Verdict on whether bare noteheads read as a trace of the original or as
      noise. This decides whether M4 happens.

---

### M3 — Annotations

- [ ] `melodyBlips[]` marked at the specific notehead
- [ ] `strippedTies[]` marked (four in Someone Like You: m22, 27, 46, 69)
- [ ] Measures with non-default settings tinted or labelled from
      `resolvedSettings`
- [ ] Untouched measures visually distinct

**Exit criteria**
- [ ] User can locate m32 (half grid), m37 and m68 (untouched islands), and
      the two m47 blips without being told where they are

---

### M4 — Two-voice experiment

**Only if M2 reads poorly, and only after discussion with the user.**

- [ ] Parent hand rendered as a second VexFlow voice in the same stave, drawn
      faintly
- [ ] Built on Someone Like You m1 ONLY before extending

**Exit criteria**
- [ ] User screenshots m1
- [ ] Verdict on whether the real simplified notes visibly shift to make room
      for the ghost voice. **If they do, the approach is dead — say so rather
      than working around it.** The overlay's value depends on real positions
      being truthful.

---

### Notes

#### M1 — the positioning question, answered

**`buildGeometry` cannot do it; `applyTimeProportionalLayout` can.**

`buildGeometry` reports one entry per event the CHILD actually has. A ghost sits
at a beat the child has no event at — the whole point is that the parent had
notes there — so there is nothing for it to report.

The position is instead derivable from the formula every real note is placed
with, in `applyTimeProportionalLayout`:

    x_anchor = xOffset + (beat / durationQ) * measWidth        [+ accPad at beat 0]

This is pure. It depends only on the measure's layout and the beat offset, and
on nothing VexFlow computes — so a ghost can be placed on exactly the same grid
as the real notes without a VexFlow note existing for it.

Two details that matter:

1. **The inputs are not the obvious ones.** `ScoreRenderer` passes
   `layoutXOffset = xOffset + (isFirst ? CLEF_EXTRA : 0)` and
   `layoutMeasWidth = measWidth - (isFirst ? CLEF_EXTRA : 0)`, because the first
   measure carries a clef and time signature. Using the raw `xOffset` would put
   every ghost in bar 1 eighty px left of where it belongs. These are now
   captured per measure into `layoutRef` during the render pass.

2. **`x_anchor` is a left edge; `buildGeometry.x` is a centre.** For a non-rest
   it returns `(getNoteHeadBeginX() + getNoteHeadEndX()) / 2`, roughly
   `x_anchor + noteheadWidth/2`. Rather than calibrate that half-width, a ghost
   is drawn as an ellipse centred at `x_anchor + rx` with a real notehead's
   half-width — so it occupies the same span as a real note at that beat, by
   construction, with no constant to keep in sync.

Arithmetic check for Someone Like You m1 at the default `measureWidth` of 500:
`layoutXOffset` 90, `layoutMeasWidth` 500, so `x = 90 + 125·beat`. The child's
four quarter chords land at 90, 215, 340, 465 — and the parent's sixteenths at
beats 0, 1, 2, 3 must land on exactly those, with the off-beat sixteenths
interleaved at 121.25, 152.5, 183.75 and so on. That is what the screenshot
should show.

**Pitch → y** uses VexFlow's own key-property mapping — a throwaway `StaveNote`
per distinct pitch, cached — then `stave.getYForNote(line)`. Re-implementing
clef arithmetic would have been a second source of truth for no gain.

**The overlay is disabled rather than wrong on misalignment.** If the parent and
child slices disagree on any measure number, `ghostMeasures` returns null and
logs which index diverged. Drawing something plausible-but-wrong is worse than
drawing nothing.

**For M3, not M1:** the imported simplified song (`f6db4cdc…`) was generated
before M0 added `resolvedSettings`, so its `generationNotes` lacks that field.
M3's settings annotations will need the song regenerated and re-imported.

#### M0

**`resolvedSettings` status is derived from the OUTPUT, not from the counters.**
A measure can hit the LH density floor while its RH is still thinned, so
"unneeded" as a per-measure verdict would be wrong. m18 of Someone Like You is
the case: LH floored, RH already single notes, so nothing changed and it really
is `unneeded`. But 10 of the 14 floored measures DID change in the RH and are
reported `transformed`. Status is therefore computed by comparing the output
measure to the input, with `unable` taking precedence and `untouched` decided
by the plan. Counts on the reference plan: 67 transformed, 4 unneeded, 11
untouched = 82.

`nonDefault` means "a range covered this measure", i.e. its resolved settings
differ from the plan default — including untouched measures, whose settings are
`null`. On the reference plan that is m32, 37, 57–61, 68, 79–82. This is the
flag M3 wants for "measures that ran non-default settings"; the per-hand
`unable` / `unneeded` detail stays where it was.

**The test suite's reference plan was stale.** `report.test.js` still carried
the M5-era plan without the m32 half-grid range, which spec §3 gained in Phase 2
M7. Updated to match the spec — otherwise the tests were asserting against a
plan that fails the regression check.

**`fetchSongById` is read-only in intent, not strictly side-effect-free.**
When the blob is stale, `recompileMeasures` writes the refreshed blob back to
`sam_songs.measures`. That is the pre-existing self-healing behaviour, not
something the extraction adds, but "read-only" should not be over-claimed. The
mapping lives in `mapSongRow` so there is one definition of the in-memory song
shape. Takes `supabase` as a parameter, mirroring `measureCompiler`.

**Id prefix scope.** Only `ScoreRenderer` got the prefix — it is the component
that could ever be mounted twice. `renderCopy` (used by `ScrollEngine`) was
deliberately left alone: playback is single-instance, and `ScrollEngine` looks
up `measure-0-{m}` by id, so changing that format would mean changing the
lookup for no benefit this phase. The prefix defaults to `useId()` with colons
stripped (legal in an HTML id, illegal in a CSS selector); an explicit
`idPrefix` prop overrides it.

**Exit criterion 3 is not automatable this phase.** Verifying "no duplicate ids
with two renderers mounted" needs two mounted renderers, and nothing mounts two
— stacking is out of scope. It also cannot be tested in jsdom: VexFlow is
loaded from a CDN in `public/index.html` and is not an npm dependency, so
`ScoreRenderer`'s effect bails at `if (!VF)` and emits no ids at all. Adding
`vexflow` as a dependency purely to test this would be building ahead. The
mechanism is `useId`, which React guarantees is unique per instance; the
browser check in the verification steps confirms the prefix is present and the
document is duplicate-free today.
