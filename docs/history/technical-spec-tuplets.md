# SAM Tuplets & Cut-Time Support — Technical Specification

## Overview

SAM does not model tuplets (triplets, quintuplets, etc.) in its
measure data. The MusicXML importer drops MusicXML's
`<time-modification>` element, so triplet-eighths get stored as
regular eighths (`"8"`). Beat math then over-counts the measure
(a triplet of three eighths counts as 1.5 beats instead of 1.0
beats), and the renderer has no signal to draw the standard
triplet bracket and "3" label.

This is observed in m.1 of "Someone Like You" (song ID
`98d02ba2-d628-4da9-9e74-eea5ca98a530`): the RH stores 12 events
as `"8"`, summing to 6 beats in a 4-beat measure. The intended
content is four triplet groups of three eighths each = 4 beats.

The fix has three independent layers (data shape, beat math,
rendering) plus a separate cosmetic concern (cut-time
displaying `C|` instead of `4/4`). The first two layers
unblock correct beat-counting and audio sync immediately; the
third makes the visual rendering correct; the fourth is purely
cosmetic.

## Non-goals

- No changes to the lyric storage architecture, MCP boundaries,
  Supabase schema (`time_signature` JSONB column stays as
  `{beats, beatType}`).
- No changes to `useMIDI` or `usePracticeSession`.
- No support for nested tuplets (tuplet-of-tuplets). MusicXML
  supports it; SAM doesn't need to.
- No support for non-power-of-2 base durations in tuplets
  (everything in this song uses eighth-based triplets, which is
  the common case).

## Architecture Decisions

### Data shape

Add an optional `tuplet` field on note events. Mirrors MusicXML's
`<time-modification>` exactly:

```json
{
  "notes": [{ "midi": 56, "name": "G#3" }],
  "duration": "8",
  "tuplet": { "actual": 3, "normal": 2, "position": "start" }
}
```

Where:
- `actual`: how many notes are played (e.g., `3` for a triplet,
  `5` for a quintuplet).
- `normal`: how many notes would be played in the same time at
  normal duration (e.g., `2` for a triplet).
- `position`: `"start"`, `"middle"`, or `"end"`. Marks the
  boundaries of a tuplet group. For a triplet, the three events
  are `start`, `middle`, `end`. For a duplet, `start` and `end`.

Events without a `tuplet` field are normal. This is strictly
additive — existing measure data continues to work unchanged.

### Beat math

In `lib/measureUtils.js`, change every site that reads
`DURATION_BEATS[evt.duration]` to use a new helper:

```js
export function getEventBeats(evt) {
  let beats = DURATION_BEATS[evt.duration] || 0;
  if (evt.tuplet) {
    beats *= evt.tuplet.normal / evt.tuplet.actual;
  }
  return beats;
}
```

Use this everywhere event durations contribute to a beat sum.
Known sites (approximate): `getMeasDurationQ`, the audit/sum
helpers in `measureUtils`, any per-event beat accumulators in
`scoreRender.js` and `useAudioSync.js`'s `songBeatPosForMeasure`
helper.

### Rendering

VexFlow renders tuplets via a separate `Tuplet` object that
wraps the constituent notes and draws the bracket + label. The
underlying `StaveNote` is still constructed with the base
duration (e.g., `"8"` for triplet eighths) — VexFlow's `Tuplet`
handles the time-modification at format/render time.

Render flow:
1. Build StaveNotes normally (existing code, no change to note
   construction).
2. After building all notes for a measure, scan the events for
   tuplet groups. Each group is bounded by
   `tuplet.position === "start"` and `tuplet.position === "end"`.
3. For each group, collect the corresponding StaveNotes and
   construct a `new VF.Tuplet(notes, { num_notes:
   tuplet.actual, notes_occupied: tuplet.normal })`.
4. Format the voice as before. Then call `tuplet.setContext(ctx).draw()`
   for each tuplet object.

The xShift time-proportional layout in `scoreRender.js` already
positions notes by cumulative beats. Once beat math returns
correct values for tuplet members (via `getEventBeats`), tuplet
notes will be positioned correctly without further changes to
the xShift logic.

### Cut-time (separate milestone)

The MusicXML importer normalizes `<time symbol="cut">` to
`{beats: 4, beatType: 4}` (i.e., 4/4). Beat math works
correctly under this normalization. The remaining concern is
purely visual: the rendered time signature shows `4/4` when the
score should display `C|` (cut time symbol).

VexFlow's `Stave.addTimeSignature("C|")` renders cut time. To
support this, the data needs a way to distinguish "this measure
is 4/4 but should be rendered as cut time." Options:

- Add an optional `symbol` field on `timeSignature`:
  `{beats: 4, beatType: 4, symbol: "cut"}`. The importer
  populates it when source MusicXML has `<time symbol="cut">`.
  Renderer reads it and passes `"C|"` to VexFlow instead of
  `"4/4"`. Beat math ignores the field entirely (still uses
  `beats` and `beatType`).
- Similarly `symbol: "common"` for common time (`C` glyph).

This is implemented in milestone 4 below, after triplets are
verified working.

## Implementation Order

1. **M1 — Data shape + beat math.** Defines the `tuplet` field
   contract. Extends `getEventBeats` so beat math respects
   tuplets. Add a small data fix to m.1 of "Someone Like You"
   (manual SQL or Supabase dashboard edit) to populate the
   tuplet field on the 12 events so the measure sums to 4 beats.
2. **M2 — Importer support.** Updates the MusicXML importer to
   read `<time-modification>` and `<notations><tuplet>` and
   write the `tuplet` field on events. Enables re-importing
   songs without manual JSON edits.
3. **M3 — Rendering.** Adds Tuplet object construction and draw
   pass in `scoreRender.js` (and `ScoreRenderer.jsx`). Renders
   bracket + "3" label. Time-proportional spacing automatically
   correct because of M1.
4. **M4 — Cut-time visual.** Adds `symbol` field to
   `timeSignature`, plumbs through importer and renderer. Pure
   cosmetic.

## Components Affected

| File | Changes |
|------|---------|
| `lib/measureUtils.js` | Add `getEventBeats` helper; update existing beat-sum helpers to use it |
| `lib/scoreRender.js` | Use `getEventBeats` in xShift layout; add Tuplet construction + draw pass |
| `components/ScoreRenderer.jsx` | Add Tuplet construction + draw pass (mirror scoreRender) |
| `lib/useAudioSync.js` | Use `getEventBeats` in `songBeatPosForMeasure` |
| MusicXML importer | Read `<time-modification>` and `<notations><tuplet>`; write `tuplet` field — (M2 only) |
| (data) m.1 RH of "Someone Like You" | Manual edit to add `tuplet` field to 12 events — (M1 verification) |
| `lib/scoreRender.js` + importer | `timeSignature.symbol` plumbing — (M4 only) |

## Manual Data Edit for M1 Verification

After M1 lands, edit m.1 RH of "Someone Like You"
(song ID `98d02ba2-d628-4da9-9e74-eea5ca98a530`, measure number
`1`, row id `fb3471ae-1ce8-4198-802f-166f988f0241`) to add
`tuplet` fields. Pattern: every group of 3 events gets
`{actual: 3, normal: 2, position: "start"/"middle"/"end"}`.

Resulting structure (abbreviated):

```json
[
  {"notes": [{"midi": 56}], "duration": "8", "tuplet": {"actual": 3, "normal": 2, "position": "start"}},
  {"notes": [{"midi": 61}], "duration": "8", "tuplet": {"actual": 3, "normal": 2, "position": "middle"}},
  {"notes": [{"midi": 64}], "duration": "8", "tuplet": {"actual": 3, "normal": 2, "position": "end"}},
  {"notes": [{"midi": 56}], "duration": "8", "tuplet": {"actual": 3, "normal": 2, "position": "start"}},
  ...
]
```

12 events → 4 tuplet groups. Each group contributes 3 × (0.5 ×
2/3) = 1.0 beats. Total: 4.0 beats. ✓

Edit can be done via Supabase dashboard or direct SQL. The data
edit is part of M1 verification, not a separate milestone.

## Success Criteria

- **M1:** `getEventBeats(evt)` returns correct beat values for
  both tuplet and non-tuplet events. m.1 of "Someone Like You"
  after the manual data edit sums to exactly 4.0 beats RH (LH
  is already 4.0 via the whole-note chord). Audio sync and
  scroll work correctly when playing m.1.
- **M2:** Re-importing a song with triplets produces a fresh
  measure record where every triplet member has the correct
  `tuplet` field. Existing songs without tuplets are
  unaffected.
- **M3:** m.1 of "Someone Like You" renders with four visible
  triplet brackets, each labeled `3`. Notes within a triplet
  are evenly spaced. Cross-mode consistency (stopped state and
  playback state) is preserved — same measure looks the same in
  both renderers.
- **M4:** m.1 displays the cut-time `C|` symbol at the start of
  the staff instead of `4/4`. Time-signature changes mid-song
  still work for normal time signatures.
- No new console errors or warnings.
- No regression in measures without tuplets.
- No regression in beat math, audio sync, scroll speed, or miss
  detection for any measure.
