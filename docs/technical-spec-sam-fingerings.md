# Technical Spec — RH Fingering Cues

## Overview

Add right-hand fingering numbers (1–5) to SAM scores. Entry happens on the Surface tablet
in the edit screen via tap-to-select + a docked number bar. Fingerings render as circled
badges with a subtle ring on the notehead. Usage is expected to be sparse — a handful per
piece, marking hand-position changes, thumb-unders, crossings, and problem spots.

## Architecture decisions

### 1. Sidecar table, not inline in `rh[]`

Fingerings live in `sam_song_fingerings`, mirroring the `sam_song_lyrics` pattern
(reference into `sam_song_measures.rh` via `rh_index`).

Rationale:
- `append_sam_measures` validates and rewrites whole `rh[]` arrays; inline fingering
  would have to survive schema validation and the duration-sum checks.
- The `songParser.js` rewrite regenerates every event object. Inline data would be
  destroyed on every re-import.
- `update_sam_song_measures` cannot write notation at all, so inline fingering would be
  unreachable from MCP by design.
- Touching `rh` invalidates the compiled `sam_songs.measures` blob on every tap. A
  sidecar write is a single small row.

### 2. Scope is `song_id`-keyed. No repeat fan-out, no re-import portability.

A fingering belongs to one `(song_id, measure_num, rh_index, note_index)`. If a repeat is
flattened into measures 5 and 21, those are two independent fingerings and must be entered
twice. If a song is re-imported under a new `song_id`, its manual fingerings do not follow.

This is a deliberate simplification. `source_measure` is *not* used as a key.

**Sequencing consequence:** do not enter manual fingerings on song rows that are about to
be replaced by the parser rewrite. Land the schema and UI first, re-import, then mark up.

### 3. Imported and manual fingerings coexist

`source` is `'manual'` or `'musicxml'`. Uniqueness is on
`(song_id, measure_num, rh_index, note_index, source)`, so a MusicXML fingering and a
manual override can both exist on the same notehead.

Render precedence:
- A `manual` row always renders, regardless of the toggle.
- A `musicxml` row renders only when `sam_songs.show_imported_fingerings` is true **and**
  no `manual` row exists at the same coordinate.

Clearing a fingering deletes only the `manual` row. If a `musicxml` row exists underneath
and the toggle is on, it reappears — which is the correct behavior (clear means "remove my
override", not "suppress the source").

**Upsert conflict target** is the full coordinate including source:
`song_id, measure_num, rh_index, note_index, source`. In supabase-js:
`.upsert(row, { onConflict: 'song_id,measure_num,rh_index,note_index,source' })`.

**`updated_at` must be set explicitly** on every upsert. The column defaults to `now()` on
insert but nothing bumps it on update — verify whether `sam_song_measures` behaves the same
way before assuming a shared trigger exists.

### 4. Overlay layer, not VexFlow modifiers

Do **not** use `VF.FretHandFinger` or `VF.Annotation`. Fingerings are drawn on a separate
SVG layer after `stave.draw()`, positioned from note geometry.

Rationale:
- `scoreRender.js` is scheduled for a multi-voice and tuplet rewrite. An overlay keeps
  fingering work out of the file being rewritten; only the geometry export contract has
  to survive.
- Full control over badge size, weight, and color, which the visibility requirement needs
  and `FretHandFinger` does not give.
- The same geometry powers the tap targets, so hit testing and rendering can never drift
  out of alignment.

### 5. Geometry export is the contract between render and interaction

`scoreRender.js` exports a pure `buildGeometry()` helper. It derives a per-event geometry
map from already-formatted VexFlow objects — no drawing, no layout decisions, no side
effects. The two renderers each call it against their **own** formatted output:
`ScoreRenderer.jsx` (the edit / stopped view, where fingering entry happens) and
`renderCopy` (the scrolling playback view).

The helper is shared rather than living in either renderer because **fingerings render in
both views**: entry happens in the edit screen, but the badges exist to cue the player
mid-piece at the piano, which is the playback view. A feature that only drew in the editor
would be useless for its purpose. The two views format at different widths, so their maps
are **not numerically identical** — what is stable is the *structure*: one entry per event,
in event order, carrying `measureNum`, `hand`, and `index`. The `x`/`y` values are
render-space and specific to each view's own layout.

```js
// one entry per notation event, returned per (measure, hand) and concatenated
{
  measureNum: 7,
  hand: 'rh',
  index: 3,              // rh_index
  x: 412.5,              // note center x
  staveTop: 88,          // top of the treble stave
  staveBottom: 148,
  noteheadYs: [122],     // one y per notehead in the event, low→high pitch order
  isRest: false
}
```

This entry shape is the only coupling point. The multi-voice rewrite of `scoreRender.js`
must preserve it (adding a `voice` field is fine and expected). `buildGeometry` is the
seam that survives the rewrite; where each renderer formats its notes is free to change.

## Visual language

The problem is distinguishing fingering from measure numbers, chord symbols, and section
labels, all of which already occupy the band above the treble stave.

**Shape carries the distinction, not position.** A filled circle with a bold numeral is a
different visual class from small plain measure-number text and alphanumeric chord symbols.
This is also standard engraving convention for editorial fingering, so it reads correctly
to anyone who knows scores.

Badge:
- Circle, radius `9px` at score scale 1.0, scaling with the score scale factor.
- Numeral: bold, `12px` at scale 1.0, centered.
- Fill: solid `--fingering-accent`. Numeral: `--fingering-accent-fg` (high contrast).
- Positioned centered on the note's `x`, `18px` above `staveTop`.
- **Collision nudge:** if the badge's x-extent overlaps the measure number or chord symbol
  for that measure (both are drawn at the measure's left edge), shift the badge up by
  `16px`. This only affects notes near beat 1.

Notehead ring:
- Stroked circle, no fill, radius `7px` at scale 1.0, `1.5px` stroke, `--fingering-accent`
  at 45% opacity, centered on the notehead y for `note_index`.
- Drawn on the overlay layer. **Never** set `note.setStyle()` or otherwise mutate the
  VexFlow notehead fill — playback highlighting owns that property.

Color token:
- `--fingering-accent` must not collide with the playback/current-note highlight or the
  hand colors. Check the existing palette before picking; if playback is cool-toned, a warm
  amber reads clearly against it.
- **Chosen: violet `#7c3aed`** (numeral `#ffffff`), defined in `src/index.css`. Amber was
  ruled out — the score's live highlight palette is green hit `#16a34a`, **amber partial
  `#d97706`**, red miss `#dc2626`, blue target line `#2563eb` (hardcoded in
  `colorBeatEls` callers, not CSS vars). Amber would read as a partial-hit state. Violet is
  absent from that palette and from the warm-brown UI chrome, so a badge/ring can never be
  mistaken for a playback state.

## Interaction

RH in La Candeur is straight eighths — 8 events per measure. At 4 measures per system on
the Surface, note spacing is roughly 35–45px, below the 44px minimum touch target. Precision
tapping on noteheads is not viable.

### Fingering mode

A toggle in the edit screen toolbar. Off by default. While on:
- Other score gestures are suppressed.
- The tap-zone layer is active.
- The number bar is docked.

### Tap zones (Voronoi in x, not notehead bounds)

Built from the geometry map, RH events only:
- Zone boundaries are the midpoints between adjacent event `x` values.
- Vertical extent: `staveTop - 24` to `staveBottom + 12`.
- First and last zones in a system extend to the system edges.
- Rests get zones too, but tapping one is a no-op with a brief "no note here" shake.

Result: any tap in the RH region resolves to the nearest note. There are no dead zones and
no precision requirement.

Zones must be at least 44px wide where the layout allows; where note density forces them
narrower, the Voronoi partition still guarantees a nearest-note resolution, so a slightly
off tap lands on a neighbor rather than nothing. Zones scale with interface scale, not
score scale, and never shrink below the layout-imposed minimum.

### Number bar

Docked at the bottom of the score pane. Not a floating popover — a docked bar avoids
occlusion by the hand, has no flip/clip placement logic, is thumb-reachable, and stays put
for consecutive entry.

Contents: `1 2 3 4 5`, `✕` (clear), `›` (advance to next RH note).

Flow:
1. Tap a note → selection ring appears, number bar enables.
2. Tap a number → writes immediately, badge and ring appear, selection stays on the note.
3. Tap `›` → selection moves to the next RH event, so note→number→›→number works for runs.
4. Tap `✕` → deletes the manual row for the selected notehead.

Buttons are `56px` minimum, spaced `8px`.

### Chords

`note_index` is the index into the event's noteheads, low pitch → high. For a single-note
event it is always `0`. When the selected event has more than one notehead, the number bar
gains a small notehead picker (stacked dots matching the chord shape); default selection is
the top notehead, since RH fingering usually marks the melody note.

### Writes and undo

- Single tap writes immediately. No save button.
- Optimistic local update, then upsert. On failure, roll back the local state and surface
  a toast.
- In-session undo stack, last 20 operations, `⌘Z`-equivalent button in the toolbar. Each
  entry is `{ op: 'set'|'clear', coord, prevFinger, nextFinger }`.

## MusicXML import

The `songParser.js` rewrite reads `<notations><technical><fingering>` on RH notes and emits
a parallel `fingerings[]` array alongside the measure data — **not** inside the event
objects. The import path writes those rows with `source: 'musicxml'`.

`sam_songs.show_imported_fingerings` defaults to `false`. A checkbox in song settings turns
it on per song.

## Components affected

| File | Change |
|---|---|
| `songParser.js` | Emit `fingerings[]` from `<technical><fingering>`; keep out of event objects |
| `scoreRender.js` | Export the pure `buildGeometry()` helper (the geometry contract) |
| `ScoreRenderer.jsx` | Edit/stopped view: call `buildGeometry` per measure/hand, publish the map |
| `renderCopy` (in `scoreRender.js`) | Playback view: call the same helper so badges/rings draw during playback (wired at the overlay step) |
| `fingeringOverlay.js` | **New.** Draw badges + rings from geometry + fingering data |
| `fingeringZones.js` | **New.** Build tap zones from geometry; hit test |
| `FingeringBar.jsx` | **New.** Docked number bar, notehead picker, undo |
| `fingeringsApi.js` | **New.** Load / upsert / delete against `sam_song_fingerings` |
| Edit screen | Fingering mode toggle, wire selection state |
| Song settings | `show_imported_fingerings` checkbox |
| MCP `get_sam_song_measures` | Add `placed_fingerings` to the response (tier 1, read only) |

## Success criteria

1. Tapping anywhere in the RH staff region selects the nearest note; no taps are ignored.
2. A fingering can be set and cleared in two taps, with no dialogs.
3. Badges are legible at arm's length on the Surface at the piano.
4. No badge overlaps a measure number, chord symbol, or section label.
5. Playback highlighting still works on fingered notes — the ring does not blink or vanish
   as the highlight moves.
6. A song with `show_imported_fingerings` off shows only manual fingerings.
7. Clearing a manual fingering over an imported one reveals the imported one when the
   toggle is on.
8. `check_platform_conformance` returns CONFORMANT after the migration.
