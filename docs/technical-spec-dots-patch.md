# SAM Patch — Dotted-Duration Note Rendering

## Overview

Dotted note durations (`"qd"`, `"8d"`, `"hd"`, and similar) are
correctly used by SAM's beat math (`DURATION_BEATS` in
`measureUtils.js`), but VexFlow's `StaveNote` constructor does not
accept the `d` suffix as part of the duration string. Dots must be
attached as separate `Dot` modifiers via VexFlow's API.

Currently, six call sites in two files pass the raw shorthand
(`"qd"`, `"qdr"`, etc.) directly to `new VF.StaveNote({ duration:
evt.duration })`. VexFlow's constructor fails to parse the `d` and
falls back to treating the duration as the base note type (a
quarter, in the case of `"qd"`). The notehead is rendered without
a dot. VexFlow's `Formatter.format()` then sees a voice whose
notes sum to less than the time signature requires, and pads the
remainder with an auto-generated rest.

Visible symptoms:
- M.23 RH "you" chord renders as a quarter (should be dotted
  quarter) and a half-rest appears at the end of the measure to
  fill the missing 0.5 beats.
- M.22 RH "find" (F#4 `"8d"`) likely renders as a plain eighth
  without a visible dot — this was overshadowed by the m.22
  triplet overflow bug and was not separately noticed at the time.
- Same pattern applies to any dotted figure in any measure.

## Root Cause

In `scoreRender.js` (lines ~122, 157, 257, 270) and
`ScoreRenderer.jsx` (lines ~220, 255, 345, 360), notes and rests
are constructed with:

```js
new VF.StaveNote({ clef, keys, duration: evt.duration })
// or for rests:
new VF.StaveNote({ clef, keys: [...], duration: evt.duration + "r" })
```

VexFlow 4.2.2's `StaveNote` does not recognize the `d` suffix on
the duration string. Per VexFlow's API, dots must be attached as
`Dot` modifiers via the modern `VF.Dot.buildAndAttach([note])` or
the older per-key `note.addModifier(new VF.Dot(), keyIdx)`.

For chords, the older API requires one `addModifier` call per
chord tone — easy to get wrong (forgetting to dot one of the keys
gives a misaligned-looking chord). `Dot.buildAndAttach` handles all
keys correctly in a single call. The fix should use the modern API
consistently.

## The Fix

### Step 1 — Add a shared helper to `scoreRender.js`

Place this near the top of `scoreRender.js`, alongside other
duration-related helpers:

```js
// VexFlow's StaveNote constructor does not parse the "d" suffix for dotted
// durations — it must be attached as a separate Dot modifier. SAM's beat
// math (see DURATION_BEATS in measureUtils) handles dotted durations
// natively; this helper bridges the two layers for rendering.
//
// Supports multi-dot durations (e.g., "hdd" = double-dotted half = 3.5 beats),
// though SAM doesn't currently produce these. Future-proof.
export function parseDuration(d) {
  let base = d;
  let dots = 0;
  while (base.endsWith("d")) {
    dots++;
    base = base.slice(0, -1);
  }
  return { base, dots };
}
```

### Step 2 — Use the helper at every StaveNote construction site

At each of the six locations, replace:

```js
new VF.StaveNote({ clef, keys, duration: evt.duration })
```

with:

```js
const { base, dots } = parseDuration(evt.duration);
const note = new VF.StaveNote({ clef, keys, duration: base });
if (dots > 0) {
  for (let i = 0; i < dots; i++) VF.Dot.buildAndAttach([note]);
}
// ...continue with whatever the existing code does with `note`
```

For **rest** constructions where the existing code appends `"r"`:

```js
new VF.StaveNote({ clef, keys: [...], duration: evt.duration + "r" })
```

Replace with:

```js
const { base, dots } = parseDuration(evt.duration);
const note = new VF.StaveNote({ clef, keys: [...], duration: base + "r" });
if (dots > 0) {
  for (let i = 0; i < dots; i++) VF.Dot.buildAndAttach([note]);
}
```

The crucial detail: **parse before adding the `"r"` suffix**, not
after. Parsing `"qdr"` would not find any `d` at the end (only `r`)
and would return `{ base: "qdr", dots: 0 }` — broken. Parse `"qd"`
to get `{ base: "q", dots: 1 }`, then build `"qr"` for the rest's
StaveNote, then attach dots.

### Step 3 — Import the helper in `ScoreRenderer.jsx`

`ScoreRenderer.jsx` has two of the six call sites. Import the helper:

```js
import { parseDuration } from "../lib/scoreRender";
```

(or `from "../lib/scoreRender.js"` depending on how other imports
in the file are written). Apply the same transformation at both
sites.

### Step 4 — Use `VF.Dot.buildAndAttach` consistently

Do not use the older `note.addModifier(new VF.Dot(), keyIdx)` API
at any site. The modern API handles chords correctly in a single
call; the older API requires per-key calls that are easy to get
wrong for multi-note chords.

## Components Affected

| File | Changes |
|------|---------|
| `lib/scoreRender.js` | Add `parseDuration` helper; replace four StaveNote constructions |
| `components/ScoreRenderer.jsx` | Import helper; replace two StaveNote constructions |

No changes to `measureUtils.js`, `useAudioSync.js`, `ScrollEngine.jsx`,
or any other file. SAM's beat math via `DURATION_BEATS` is correct
and unrelated.

## Why This Layer

The duration string in SAM's measure data (`"qd"`, `"8d"`, etc.)
serves two consumers:
- **Beat math** via `DURATION_BEATS` — used for scroll timing,
  miss detection, audio-sync.
- **Visual rendering** via VexFlow's `StaveNote` — used for
  drawing noteheads, stems, beams, dots.

These two consumers have different requirements for the same
input. Beat math correctly interprets `"qd"` as 1.5 beats. VexFlow
needs the duration split into `(base, dots)`. The helper
`parseDuration` is the bridge — it lives next to the rendering
code because that's where the impedance mismatch exists.

Trying to normalize the duration format itself (changing all
`"qd"` strings to a different representation) is out of scope and
risky — it would require changes to the MusicXML importer, the
auto-match flow, the lyric placement code, and any other code that
reads the `rh`/`lh` arrays. The helper-bridge approach is
strictly additive.

## Caveats

- This patch addresses **only** the dotted-duration rendering. It
  does not address triplet rendering (which still requires the
  importer to handle `<time-modification>` in MusicXML, currently
  out of scope).
- The `Dot.buildAndAttach` API works on the StaveNote AFTER
  construction. If any of the six call sites mutates the note
  between construction and being added to a voice, the dot
  attachment must happen before that mutation. Verify the existing
  code's flow at each site.
- The same `parseDuration` helper could theoretically also be used
  by `DURATION_BEATS` lookups in `measureUtils.js`, but that's a
  cleanup, not a fix — `DURATION_BEATS` already works correctly
  via direct map lookups (`DURATION_BEATS["qd"] === 1.5`). Don't
  refactor `measureUtils` as part of this patch.

## Success Criteria

- **M.23 RH "you" chord:** renders as a dotted quarter (notehead +
  visible dot to its right) — no auto-padded half-rest at the end
  of the measure.
- **M.22 RH "find" (F#4):** renders as a dotted eighth (notehead +
  visible dot). This was almost certainly broken before but masked
  by the triplet overflow that's already been corrected.
- **Any other dotted figure in "Someone Like You":** renders with
  a visible dot. Spot-check at least one dotted half if one exists
  in the song.
- **Dotted rests:** if any measure contains a dotted rest, it
  renders with a dot. (Unlikely in this song, but the patch covers
  it.)
- **No regression in non-dotted notes:** plain quarters, halves,
  eighths, sixteenths still render identically. Chord rendering,
  tie rendering, beam grouping unchanged.
- **Auto-padded rests disappear** in any measure that previously
  had a "missing-beats" rest at the end caused by a stripped dot.
- **No new console errors or warnings.**

## Verification Sequence

1. Load "Someone Like You", scroll the stopped-state view to m.23.
   Confirm "you" has a visible dot; confirm no auto-rest at the
   end of m.23.
2. Scroll back to m.22. Confirm "find" (F#4) has a visible dot.
3. Press Play. Confirm dots remain visible during scrolling
   playback.
4. Scroll through the entire song in stopped state, looking for
   any auto-padded rests at the end of measures. There should be
   none unless the measure genuinely has fewer than 4 beats of
   content.
5. Confirm playback timing is unchanged (no regression from the
   resume/spin-up fixes).
