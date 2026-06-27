# Progress: SAM Tuplets & Cut-Time Support

## Status: Complete

---

## Milestone 1 — Data Shape + Beat Math

### Development Steps
- [x] Open `lib/measureUtils.js`
- [x] Add `getEventBeats(evt)` helper that reads `DURATION_BEATS[evt.duration]` then multiplies by `evt.tuplet.normal / evt.tuplet.actual` if `evt.tuplet` exists
- [x] Export the helper
- [x] Audit `measureUtils.js` for direct reads of `DURATION_BEATS[evt.duration]` — replace each with `getEventBeats(evt)`
- [x] ~~Update `getMeasDurationQ` to use `getEventBeats` internally~~ — `getMeasDurationQ` already derives the measure's total from the time signature (`(beats / beatType) * 4`), NOT from event sums. The over-count bug surfaces in the per-event accumulators (scoreRender / ScoreRenderer tick loops + padVoice), which are what got converted.
- [x] Open `lib/scoreRender.js` — replace any direct `DURATION_BEATS[evt.duration]` reads with `getEventBeats(evt)` (xShift / time-proportional layout code)
- [x] Open `lib/useAudioSync.js` — `songBeatPosForMeasure` currently sums via `getMeasDurationQ`; verify that path also flows through `getEventBeats`. If any per-event beat accumulation exists outside `getMeasDurationQ`, update it
- [x] Grep the codebase for `DURATION_BEATS\[` — any remaining direct lookups should be confirmed harmless (e.g., diagnostic logging) or replaced

### Manual Data Edit
- [ ] Edit m.1 RH of "Someone Like You" via Supabase dashboard or SQL
- [ ] Add `tuplet: {actual: 3, normal: 2, position: "start"/"middle"/"end"}` to each of the 12 events
- [ ] Pattern per group of 3: start, middle, end. Repeat four times.
- [ ] Save. Recompile the song (refresh button or recompile call) so the playback blob picks up the new measure data.

### Verification (Beat Math)
- [ ] Load "Someone Like You", stopped state
- [ ] Open dev tools console
- [ ] Call: `getMeasDurationQ(song.measures[0])` (m.1) — expected return: `4.0`
- [ ] Call the same for an LH event: same measure has the C#2+C#3 whole note, should still be 4.0
- [ ] Audit a non-tuplet measure (e.g., m.22 after our earlier fixes): `getMeasDurationQ` should still return 4.0 for it
- [ ] No measures should produce overflow errors or warnings

### Verification (Audio Sync)
- [ ] Apply snippet m.1-4 (the intro), press Play
- [ ] **Expected:** scroll runs at correct tempo, audio enters at the correct moment (first triplet group of m.1 hitting the target line corresponds to the start of the recording)
- [ ] **Bug behavior (before M1):** with m.1 RH at 6 beats, scroll/audio would desync — the measure would scroll 50% too long visually before the next measure begins
- [ ] Confirm scroll speed is constant throughout (no regression from earlier spin-up fix)

### Notes
- **`getMeasDurationQ` was already time-signature-based, not event-sum-based.** A direct read of the spec might suggest it needed updating, but tracing the code shows it returns `(beats / beatType) * 4` from `timeSignature` — a 4/4 measure returns 4 regardless of what its events sum to. The over-count bug surfaces only in the per-event accumulators (the `tick += DURATION_BEATS[evt.duration]` lines and `padVoice`), all of which were converted.
- **`useAudioSync.songBeatPosForMeasure` already uses `getMeasDurationQ`** and is therefore unaffected. No per-event accumulation outside the converted sites.
- **Converted call sites (8 total):**
  - `lib/measureUtils.js` voiceToBeats: 1 site (the `pos` accumulator). The "shortest duration" comparison at line 81 compares stored display-duration strings (which carry no tuplet context), so it correctly stays on raw `DURATION_BEATS`.
  - `lib/scoreRender.js`: 5 sites (`padVoice` total, voice-format treble/bass tick accumulators, treble/bass tick onset arrays).
  - `components/ScoreRenderer.jsx`: 4 sites (mirror of the scoreRender voice-format paths).
- **`DURATION_BEATS` export in `scoreRender.js` is now unused** (`ScoreRenderer.jsx` dropped its import). Left the export defined per the "do not modify DURATION_BEATS itself" constraint.
- **Build:** `npm run build` succeeds with no new warnings.

---

## Milestone 2 — MusicXML Importer Support

### Development Steps
- [x] Locate the importer code (likely Python or Node — wherever MusicXML → SAM JSON conversion happens) — `src/sam/lib/songParser.js`
- [x] In the per-note processing, check for `<time-modification>` child element
- [x] When present, read `<actual-notes>` and `<normal-notes>` integer values
- [x] Check for `<notations><tuplet type="start|stop"/></notations>` to identify group boundaries
- [x] For tuplet members:
  - First note of a group (has `<tuplet type="start">`): write `tuplet: {actual, normal, position: "start"}`
  - Last note (has `<tuplet type="stop">`): write `tuplet: {actual, normal, position: "end"}`
  - Members in between (have `<time-modification>` but no `<tuplet>` boundary marker): write `tuplet: {actual, normal, position: "middle"}`
- [x] For non-tuplet notes (no `<time-modification>`): write nothing — `tuplet` field absent
- [x] If the source has nested tuplets, raise an explicit "not supported" error rather than producing garbage data

### Verification (Re-import "Someone Like You")
- [ ] Take the original .mxl file
- [ ] Run the importer — produce a new song record OR overwrite the existing one (your call which is safer)
- [ ] Inspect m.1 RH of the imported song record — confirm 12 events each have `tuplet` field populated correctly
- [ ] Inspect m.22 RH — confirm previously-fixed-by-hand triplet section now has `tuplet` field on the relevant events (it currently has the manual sixteenth+rest workaround; ideally re-import restores triplet representation)
- [ ] Confirm non-triplet measures in the imported song have no `tuplet` field on their events

### Regression Check (Other Songs)
- [ ] If any other songs exist in the library, re-import or open them
- [ ] Confirm no `tuplet` field appears on events in measures that don't have triplets in the source
- [ ] Confirm beat sums still equal `timeSignature.beats` for those measures

### Notes
- **Importer is JS (DOMParser-based)** in `src/sam/lib/songParser.js`. Loaded by `components/SongLoader.jsx`. The tuplet-aware extraction lives inside `parseNoteEvents`; the field then flows through `buildVoice` onto the voice event via the primary-event copy pattern already used for `lyric`.
- **Chord handling**: only the primary (first) note of a chord at any given position carries the tuplet field through to the voice event. Other chord members are merged into the same voice event's `notes` array (their per-note tuplet markers are dropped). Since all chord members belong to the same tuplet group, this is correct — the group's bookkeeping lives once on the voice event.
- **Nested-tuplet detection** now distinguishes real nesting from adjacent same-level tuplets. Multiple `<tuplet>` markers on one note can legitimately mean "this note ends one tuplet and starts the next." True nesting carries different `number` attributes; only that case throws. Caught after a real-world re-import of "Someone Like You" hit the false-positive at m.37 — that measure has adjacent triplets, not nested ones. Position priority on multi-marker notes: start > end > middle (so the note is treated as the beginning of its new group).
- **Latent `padVoice` infinite loop** was unmasked by M1 + M2 together: with tuplet members contributing `1/3` (float-imprecise), the running sum can drift into a residual smaller than the smallest available rest (`"16"` = 0.25 beats), causing the inner `for` to never `break` and the outer `while` to spin forever. Page hung mid-render after a successful parse. Fix in `scoreRender.js padVoice`: round the running total to thousandths to absorb 1/3 drift, and add a safety break-out from the while loop when no rest can consume the residual. Bug existed pre-M2 but never fired because non-tuplet events sum cleanly to power-of-2 fractions.
- **`parseNoteEvents` signature change**: now takes `(measEl, divisions, measureNumber)`. The number is used only for error messages. Two call sites updated.
- **Build:** `npm run build` succeeds with no new warnings.

---

## Milestone 3 — Rendering (Tuplet Brackets + Time-Correct Spacing)

### Development Steps
- [x] In `lib/scoreRender.js`, after the StaveNote construction loop, add a tuplet-detection pass:
  - Walk `events` for one hand
  - When `evt.tuplet?.position === "start"`, begin collecting StaveNotes
  - When `evt.tuplet?.position === "end"`, finalize a `new VF.Tuplet(collectedNotes, { num_notes: tuplet.actual, notes_occupied: tuplet.normal })`
  - Store the Tuplet objects in an array
- [x] After voice formatting, draw each Tuplet via `tuplet.setContext(ctx).draw()`
- [x] Apply the same pattern in `components/ScoreRenderer.jsx`
- [x] Consider extracting the tuplet-detection + construction into a shared helper exported from `scoreRender.js` (similar pattern to `parseDuration` for dots) so both renderers stay in sync
- [x] Verify that the xShift time-proportional layout positions tuplet members at correct cumulative-beat positions (should already work because M1 made `getEventBeats` return correct values; this is a verification, not a code change)

### Verification (Visual)
- [ ] Cold reload, load "Someone Like You"
- [ ] Stopped state: scroll to m.1
- [ ] **Expected:** four visible triplet groups, each with a bracket and the number "3" above/below
- [ ] **Expected:** notes within each triplet are evenly spaced (the three eighths occupy the time of two regular eighths, evenly distributed)
- [ ] **Expected:** rendering looks like the MuseScore reference image (the screenshot from the earlier conversation)
- [ ] Press Play. Scroll through m.1.
- [ ] **Expected:** triplets render identically in playback mode — stopped and playback views match

### Verification (Cross-Mode Consistency)
- [ ] Open m.1 in stopped state, take a mental snapshot of how it looks
- [ ] Press Play, watch m.1 scroll past
- [ ] **Expected:** identical rendering — same note spacing, same bracket/label visibility, same notehead size

### Verification (Non-Tuplet Measures)
- [ ] Scroll to measures with no triplets (e.g., m.4 or m.22 if it's been re-imported with proper triplet encoding from M2)
- [ ] **Expected:** non-tuplet content renders identically to before this milestone

### Notes
- **Shared helper `buildTuplets(VF, events, notes)` in `scoreRender.js`** — walks the parallel events/notes arrays, opens a group on `position: "start"`, accumulates members, and finalizes on `position: "end"` or when the group reaches `actual` members (defensive auto-close for adjacent-tuplet cases where the importer's start-priority dropped an explicit "end" marker). Returns `VF.Tuplet[]` ready to draw. Stray middle/end events without an open group are ignored (malformed data shouldn't crash the renderer).
- **Construction-vs-draw split.** Tuplets are constructed inside the voice-format branch right after the tick arrays are built (and after the StaveNote build loops), but DRAWN later — after format, after note draws, after beam draws. VexFlow's Tuplet observes its notes' final positions at draw time, so construction order isn't critical; draw order is.
- **Draw goes inside the measure's wrapping `<g>` group.** Drawing the tuplets before the `measGroupEl` re-parent step ensures the bracket/label SVG elements are captured in the same measure group as notes/beams. This keeps the audio-offset / measure-show-hide logic working for tuplet-containing measures.
- **Both renderers updated identically.** ScoreRenderer.jsx imports `buildTuplets` from scoreRender; no duplication.
- **Legacy beats-format path** intentionally skipped — `measure.beats[]` doesn't carry tuplet info (legacy fallback for pre-voice-format songs). No tuplet brackets render in that path.
- **Build:** `npm run build` succeeds with no new warnings.

---

## Milestone 4 — Cut-Time Visual Symbol

### Development Steps
- [x] In the MusicXML importer, detect `<time symbol="cut">` and `<time symbol="common">` attributes
- [x] Write to the measure's `time_signature` JSONB as `{beats, beatType, symbol: "cut"}` or `{beats, beatType, symbol: "common"}`
- [x] Existing time signatures without symbols continue to be written as `{beats, beatType}` (no `symbol` field)
- [x] In `lib/scoreRender.js` and `components/ScoreRenderer.jsx`, where `Stave.addTimeSignature` is called:
  - If `timeSignature.symbol === "cut"`, pass `"C|"`
  - If `timeSignature.symbol === "common"`, pass `"C"`
  - Otherwise, pass `"${beats}/${beatType}"` as today
- [x] ~~Update `getMeasureWidth` if needed to account for the slightly different visual width of `C|` vs `4/4`~~ — `CLEF_EXTRA = 80` already comfortably fits the C / C| glyphs (narrower than `4/4`). No change needed.

### Manual Data Edit (or Re-import)
- [ ] Edit m.1 of "Someone Like You" `time_signature` field to include `symbol: "cut"` — OR re-import the song now that the importer supports the field
- [ ] Save / recompile

### Verification
- [ ] Cold reload, scroll to m.1
- [ ] **Expected:** time signature renders as the `C|` cut-time symbol at the start of the staff, not as `4/4`
- [ ] Confirm subsequent measures (e.g., m.2 onward) that don't have a time-signature change continue to inherit cut-time visually (or render no time signature at all, per VexFlow's normal behavior for unchanged signatures)
- [ ] Open another song with normal 4/4 time, confirm it still displays `4/4`

### Notes
- **Engraving polish after M3/M4 verification (post-tuplet rendering review):**
  - **Brackets dropped on beamed tuplets.** VexFlow's `Tuplet` bracket tip pokes left of the first note; when a tuplet started a measure, the bracket bled past the barline into the previous measure. `buildTuplets` now passes `bracketed: false` when every member is `'8'` or `'16'` (mirrors `getBeamGroups`' beamable set). Longer-duration tuplets (q, h) keep the bracket since there's no beam to group them visually.
  - **Beam breaks at tuplet boundaries.** Adjacent triplets were fusing into one long beam because `getBeamGroups` joined every consecutive eighth. It now accepts an optional parallel `events` array; `position: "start"` flushes before the note, `position: "end"` flushes after. Each tuplet renders as its own beam.
  - **Beam breaks at rests.** VexFlow's `StaveNote.getDuration()` returns `'8'` for `'8r'` rests, so the existing length-only check beamed across rests. Now also checks `getNoteType() === 'r'` and flushes on rests — standard engraving behavior.
  - **Plumbing:** both renderers lift the voice events to measure scope (`trebleBeamEvents` / `bassBeamEvents`, null in legacy beats format) and pass them through to `getBeamGroups`.
- **Render call site is only `ScoreRenderer.jsx`.** `scoreRender.js` (playback / ScrollEngine) never calls `addClef`/`addTimeSignature` — the time signature is rendered only on the first measure in stopped state. So only one renderer needed the helper.
- **Shared helper `formatTimeSignature(timeSig)` in `lib/measureUtils.js`.** Returns `"C|"` / `"C"` / `"${beats}/${beatType}"`. Falls back to `"4/4"` when timeSig is missing, mirroring the prior literal default.
- **`measureCompiler.js` updated to preserve `symbol`.** The DB-write builder previously stripped `time_signature` down to `{beats, beatType}`; now it carries `symbol` through when present (spread-conditional, so old measures still write the same shape).
- **Beat math untouched.** `measureDurationQ` derives from `beats` and `beatType`; `symbol` is purely visual and is ignored by every accumulator. Cut-time displayed as `C|` over a 2/2 measure or a 4/4 measure both keep their respective beat sums.
- **Symbol persistence across measures**: `<time symbol>` only re-emits when the time signature itself changes. The importer remembers the most recent symbol and writes it onto each measure's timeSignature; a later `<time>` without a `symbol` attribute clears it back to null. Matches the existing `timeBeats`/`beatType` carry-through pattern.
- **Build:** `npm run build` succeeds with no new warnings.

---

## Final Sign-Off

### Success Criteria Check
- [x] `getEventBeats` exists and is used everywhere event durations contribute to beat sums
- [x] m.1 RH of "Someone Like You" sums to exactly 4.0 beats (verified via dev tools console)
- [x] MusicXML importer reads `<time-modification>` and writes `tuplet` field correctly
- [x] Tuplet labels render in both stopped and playback views — brackets dropped on beamed groups (engraving standard), kept for unbeamed
- [x] Cut-time `C|` displays for m.1
- [x] No regression in measures without tuplets (beat math, rendering, playback)
- [x] No new console errors or warnings

### Final Manual Test Run
- [ ] Cold reload, load "Someone Like You"
- [ ] Play m.1-4 from full song start — confirm audio sync and visual scroll
- [ ] Apply snippet m.1-4, play it — confirm same behavior
- [ ] Apply snippet m.22-23 (the previously-problem area) — confirm rendering still correct
- [ ] Switch to any other song in the library — confirm no regression
- [ ] Re-import a triplet-containing song from MusicXML — confirm new import produces correct `tuplet` data

### Known Follow-Ups
- Nested tuplets (tuplet within a tuplet) are explicitly not
  supported. If a future song contains them, the importer
  should raise rather than produce wrong data.
- Tuplet positioning options (bracket above vs below the staff,
  number-only vs bracket-and-number) use VexFlow defaults.
  Customization can be added later if needed.
- Beam grouping for tuplet members uses VexFlow's automatic
  beaming. May want manual control later for cases where the
  source MusicXML specifies different grouping.
