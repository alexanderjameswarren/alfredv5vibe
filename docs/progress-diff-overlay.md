# Progress: SAM Diff Overlay (Phase 6)

## Status: M0 complete, awaiting verification

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

- [ ] Resolved: can `buildGeometry` expose an x for an arbitrary beat offset,
      or is it derivable from `applyTimeProportionalLayout`? **Report the
      answer before building.**
- [ ] Parent song loaded read-only alongside the child
- [ ] Snippet slice applied identically to both; measure numbers asserted to
      match before drawing
- [ ] Faint noteheads drawn for every parent LH note in m1–4 at computed x
      and pitch y

**Exit criteria**
- [ ] User screenshots m1–4
- [ ] Ghosts trace the original sixteenth-note arpeggio under the four
      simplified quarter chords at visibly correct beat positions
- [ ] **If x positions are wrong or underivable, STOP and report.** This is the
      load-bearing assumption of the entire approach.

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
