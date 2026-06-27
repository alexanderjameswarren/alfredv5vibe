# Progress: Dotted-Duration Rendering Fix

## Status: Patch applied — awaiting verification

---

## The Patch

### Development Steps
- [x] Open `lib/scoreRender.js`
- [x] Add `parseDuration` helper near the top of the file, alongside other duration-related helpers; export it
- [x] Locate all four StaveNote construction sites in `scoreRender.js` (approximate lines: 122, 157, 257, 270 — actual locations may shift slightly)
- [x] For each note site: parse the duration, construct with base, attach dots via `VF.Dot.buildAndAttach`
- [x] For each rest site: parse the duration first, then build the rest with `base + "r"`, then attach dots
- [x] Open `components/ScoreRenderer.jsx`
- [x] Import `parseDuration` from `../lib/scoreRender`
- [x] Locate both StaveNote construction sites (approximate lines: 220 and 345 — note + rest patterns, plus 255/360 voice patterns)
- [x] Apply the same transformation at both sites
- [x] Verify lint passes
- [x] Confirm no remaining direct `evt.duration` passes to a `StaveNote` constructor anywhere

### Notes
- **The spec's "six call sites" undercount.** Spec body listed four note sites in `scoreRender.js` and two in `ScoreRenderer.jsx`, but the spec ALSO required fixing rest sites (where the existing code appends `"r"`). Each file has 4 note + 4 rest = 8 sites; 16 in total. All 16 transformed using the helper; grep for `new VF.StaveNote` confirms every constructor now reads `base` or `beatBase` (+ optional `"r"`), no raw `evt.duration` / `beat.duration` strings remain. The Notes flag is here so a future reviewer doesn't think the spec's count was the ceiling.
- **Dot attached immediately after construction, before other modifiers.** Following the spec's caveat about modifier ordering: at every site the `for (let i = 0; i < dots; i++) VF.Dot.buildAndAttach([note])` runs right after `new VF.StaveNote(...)`, before any accidental/annotation/tie tracking. VexFlow doesn't actually care about modifier order, but adhering to the spec keeps the future-proofing explicit.
- **Legacy beats format uses a single shared parse per beat.** The legacy path constructs both a treble StaveNote and a bass StaveNote from the same `beat.duration`. Parsed once into `beatBase`/`beatDots` at the top of the beat loop, then reused for the four StaveNote constructions inside the beat. Cheaper than parsing four times and clearer about the invariant that both clefs share the duration.
- **Build:** `npm run build` succeeds with no new warnings.


---

## Verification

### Primary — Dotted Quarter (m.23 "you")
- [ ] Cold reload, load "Someone Like You"
- [ ] Scroll the score (stopped state) to m.23
- [ ] **Expected:** "you" chord (A3+C#4+F#4) shows as a notehead with a visible dot to its right
- [ ] **Expected:** no auto-padded rest at the end of m.23 (the rectangular block visible in earlier screenshots)
- [ ] Bug behavior (before patch): undotted quarter notehead, half-rest at end of measure

### Primary — Dotted Eighth (m.22 "find")
- [ ] Scroll to m.22
- [ ] Locate the F#4 between the sixteenth run and the "some-one like" chord group
- [ ] **Expected:** dotted eighth notehead (visible dot)
- [ ] Bug behavior (before patch): probably undotted eighth — this was masked by the triplet overflow bug

### Dotted Half Check (if any exists)
- [ ] Scroll through the song looking for any dotted half note (will be a half notehead — open notehead — with a dot)
- [ ] If found: confirm the dot is visible
- [ ] If none exists in this song: note in the Notes section and move on

### Dotted Rest Check
- [ ] Scroll through the song looking for any auto-padded or explicit dotted rests
- [ ] If a dotted rest exists anywhere, confirm it renders with a dot
- [ ] More likely: confirm that previously-existing auto-padded rests at end-of-measure (caused by stripped dots) are now GONE

### Non-Dotted Notes Regression
- [ ] Scroll through several measures with no dotted figures (e.g., m.1-4 of the song — piano intro with whole-note chords + sixteenth arpeggios)
- [ ] **Expected:** plain quarters, halves, eighths, sixteenths all render identically to before
- [ ] **Expected:** chords stack properly (no missing notes)
- [ ] **Expected:** ties between notes still render

### Playback Regression
- [ ] Press Play from m.1
- [ ] **Expected:** dots remain visible during scrolling
- [ ] **Expected:** no scroll stutter, audio-sync still works (no regression from earlier patches)
- [ ] **Expected:** miss detection still works at expected timing (no change to beat math)
- [ ] Resume from a paused measure mid-song — confirm dotted notes still display correctly

### Snippet Playback
- [ ] Apply snippet m.20-25 (any range including m.22 and m.23)
- [ ] Press Play
- [ ] **Expected:** "find" (m.22) and "you" (m.23) both show with dots throughout snippet playback and loop

### Notes


---

## Sign-Off

- [ ] M.23 "you" renders as dotted quarter with visible dot
- [ ] M.22 "find" renders as dotted eighth with visible dot
- [ ] Auto-padded rests previously caused by stripped dots are gone
- [ ] Non-dotted notes unchanged
- [ ] Playback, miss detection, audio sync unchanged
- [ ] No new console errors or warnings
- [ ] `parseDuration` exists in exactly one place; both files import or share it

### Known Follow-Ups
- Triplet rendering (`<time-modification>` in MusicXML) is still
  unsupported. Affected measures must be manually edited or
  reshaped to non-triplet rhythms as a workaround.
- A broader audit of the entire song library for dotted figures
  could be valuable to confirm no other rendering bugs exist
  for less-common dotted patterns (double-dotted notes, etc).
