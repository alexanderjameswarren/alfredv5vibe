# SAM song export format

The JSON produced by the Export button in SAM (`buildSongExport` in
[`src/sam/lib/songExport.js`](../src/sam/lib/songExport.js)) and consumed by the
JSON import path (`commitImport` in
[`src/sam/components/SongLoader.jsx`](../src/sam/components/SongLoader.jsx)).

It is intended to be a **complete representation of a song** — everything needed
to reconstruct it exactly, with nothing left only in the database. Anything
missing here is silently lost on every generated version.

Structure is enforced by [`sam-drill-format.schema.json`](../sam-drill-format.schema.json)
at the repo root, which is the machine-readable authority; this document
explains it and records the conventions the schema cannot express.

**Version 2** — `formatVersion: 2`. Version 1 is the original unversioned export
carrying only `title`, `artist`, `defaultBpm`, `measures`; a document with no
`formatVersion` key is v1 and still imports.

---

## 1. Null conventions — read this before anything else

The format is **not** uniformly "null for absent". There are two conventions and
they apply at different levels:

| Level | Convention |
|---|---|
| **Song-level scalars** | Always present. A song without the value emits `null`, never omits the key. |
| **`lyrics` / `fingerings`** | Always present. A song with none emits `[]` — zero rows is a fact, not an absent field. |
| **`measures[].audioOffsetMs`** | Always present, `null` included. Deliberately forced, because the stored blob omits it when null. |
| **Other measure keys** (`chord`, `section`, `sourceMeasure`) | **Absent when the song has no value**, following the stored blob's convention. Do not distinguish "absent" from "null" for these — treat a missing key as null. |

The asymmetry is real and load-bearing: `audioOffsetMs` is forced present so a
reader can tell "this measure has no offset" from "this exporter was too old to
know about offsets". The other measure keys were left on the blob convention
because changing them would have reshaped existing data.

A consumer should read every measure-level optional as `m.chord ?? null`.

---

## 2. Song level

| Field | Type | Notes |
|---|---|---|
| `formatVersion` | `integer` | `2`. Absent ⇒ v1. |
| `title` | `string` | Required, non-empty. |
| `artist` | `string \| null` | |
| `defaultBpm` | `number` | Quarter-note BPM. Always present from the Export button (falls back to the live transport BPM). **Unreliable as a performance tempo** — see §7. |
| `key` | `string \| null` | Display label, e.g. `"A major"`. **The mode is not trustworthy** — see §6. |
| `fifths` | `integer \| null` | MusicXML `<fifths>`, −7…7. The authoritative key signature. |
| `timeSignature` | `string \| null` | Song-level default, `"N/M"`. Per-measure `timeSignature` overrides it. |
| `sourceXmlPath` | `string \| null` | Path in the `sam-scores` Storage bucket. Exported and inherited on import, but only a MusicXML upload creates one. |
| `songType` | `"original" \| "simplified" \| "drill" \| null` | `null` means `original`. |
| `parentSongId` | `uuid string \| null` | Required when `songType` is `simplified`. |
| `difficultyTier` | `integer 1..9 \| null` | Only meaningful for `simplified`; DB constraint forces null otherwise. |
| `generationNotes` | `object \| null` | Free-form receipt. Never source for a build step. |
| `lyrics` | `Lyric[]` | See §4. |
| `fingerings` | `Fingering[]` | See §5. |
| `measures` | `Measure[]` | At least one. See §3. |

---

## 3. Measure

| Field | Type | Notes |
|---|---|---|
| `number` | `integer \| null` | 1-based position in `measures`. |
| `timeSignature` | `TimeSignature` | **Required.** |
| `rh`, `lh` | `VoiceEvent[]` | Required. `[]` is a legitimately silent hand. |
| `audioOffsetMs` | `number \| null` | Always present. Milliseconds into the backing track where this measure begins. |
| `chord` | `string` | Absent when none. Chord symbol, e.g. `"C#m/G#"`. |
| `section` | `string` | Absent when none. |
| `sourceMeasure` | `string` | Absent when none. The **printed** measure number from the source `<measure number>` attribute. TEXT, not a number: MuseScore emits `X1`…`X4` for ending brackets and other editions use `12a`/`12b`. |

`sourceMeasure` is how you detect structure. Playback order is *flattened* — a
repeat is written out — so a **discontinuity in `sourceMeasure` marks a seam**
(a repeat jump, volta, D.S. or coda). La Candeur is 38 measures flattened from
23 printed.

### TimeSignature

| Field | Type | Notes |
|---|---|---|
| `beats` | `integer ≥ 1` | |
| `beatType` | `1 \| 2 \| 4 \| 8 \| 16 \| 32` | |
| `symbol` | `"common" \| "cut"` | Absent when the signature is printed as numerals. Purely presentational — `4/4` and `common` sound identical. |

Measure length in quarter-note beats is `(beats * 4) / beatType`. Use
`measureBeats()` from `durations.js`; do not recompute it.

### VoiceEvent

One rhythmic position in one hand. **Simultaneity is the `notes` array, not
separate events.**

| Field | Type | Notes |
|---|---|---|
| `duration` | `string` | VexFlow token: `w h q 8 16 32` plus one `d` per augmentation dot (`qd`, `8d`, `qdd`). |
| `notes` | `Note[]` | Simultaneous pitches. **`[]` means a rest.** |
| `tuplet` | `{actual, normal, position?}` | Absent for normal events. See below. |

`lyric` **must not appear** on a voice event. The schema rejects it, and
`recompileMeasures` strips inline lyrics and re-injects them from
`sam_song_lyrics`, so an authored one would vanish on first recompile. Lyrics
live at the top level (§4).

**Duration is the DISPLAY token, not sounded time.** For a tuplet event, sounded
beats = `tokenToBeats(duration) * tuplet.normal / tuplet.actual` — a triplet
eighth is stored as `"8"` with `{actual: 3, normal: 2}` and sounds for ⅓ beat.
`sumEvents()` in `durations.js` already does this; any beat math must go through
it rather than reading `duration` directly.

`tuplet.position` (`start`/`middle`/`end`) is **optional and normally absent**.
Spec §3.3 keeps storage token-based — position is implied by a run of
consecutive tuplet events. Do not require it.

Known gap: `durations.js` understands `64`, but the schema's duration pattern
does not include it. A 64th note would fail validation.

### Note

| Field | Type | Notes |
|---|---|---|
| `midi` | `integer 0..127` | `(octave + 1) × 12 + step + alter`. C4 = 60. |
| `name` | `string` | Display spelling: `A4`, `Bb4`, `F#3`, `C-1`. |
| `tie` | `"start" \| "end" \| "both"` | Absent when untied. |

`midi` and `name` **must agree**; disagreement is a hard validation error.
`name` carries the enharmonic spelling `midi` cannot (`F#` vs `Gb`).

A tie chain may cross a measure boundary. An unmatched `end` is not necessarily
corruption — at a seam (§3) the note it continued from was in a measure the
flattening skipped.

---

## 4. Lyric

Rows of `sam_song_lyrics`, in the table's own snake_case shape.

| Field | Type | Notes |
|---|---|---|
| `word_order` | `integer` | Global syllable sequence, unique per song. **The stable identity of a syllable — carry it verbatim.** |
| `syllable` | `string` | Trailing `-` marks a word continuation. |
| `measure_num` | `integer \| null` | `null` = not yet placed. |
| `rh_index` | `integer \| null` | Index into that measure's `rh`. |

Unplaced syllables are included deliberately: they are real rows, and dropping
them would lose typed-but-unplaced work on every round trip.

Two syllables may share one `(measure_num, rh_index)`; the lyric editor permits
it and real data contains it.

---

## 5. Fingering

Rows of `sam_song_fingerings`, camelCase (this one mirrors the parser's shape,
not the table's).

| Field | Type | Notes |
|---|---|---|
| `measureNum` | `integer ≥ 1` | |
| `rhIndex` | `integer ≥ 0` | Index into that measure's `rh`. |
| `noteIndex` | `integer ≥ 0` | Which notehead in a chord, low to high. Defaults to 0. |
| `finger` | `integer 1..5` | 1 = thumb. |
| `source` | `"manual" \| "musicxml"` | Defaults to `musicxml` when absent. |

Right hand only. One coordinate may carry **both** a `manual` and a `musicxml`
row; manual wins at render, and clearing it re-reveals the imported one.

---

## 6. Key signature — use `fifths`, never `key`

`key` is a display label derived through a **major-only** table
(`KEY_NAMES` in `songParser.js`), so every song reports some `X major`
regardless of its actual mode. A piece in A minor has `fifths: 0` and is
labelled `"C major"`.

`fifths` is the real signature. To get the diatonic pitch-class set, the mode
does not matter — a key and its relative minor share the collection:

```js
const tonicPc = ((7 * fifths) % 12 + 12) % 12;          // major tonic
const scale = [0, 2, 4, 5, 7, 9, 11].map((i) => (tonicPc + i) % 12);
```

`fifths` may be `null` on documents whose label was hand-entered and could not
be inverted without guessing. Handle that rather than defaulting to 0.

---

## 7. Tempo — `defaultBpm` is not a performance tempo

Do not derive timing from `defaultBpm`. Stored tempos are unreliable: one 6/8
song stores `25`, which could mean two things a factor of five apart depending
on whether it counts dotted quarters or eighths, and the player generally works
below printed marks anyway.

Tools that need a tempo must **take one explicitly**. `tools/sam-tools`'
analyzer requires `--bpm` and prints the value it used.

BPM throughout SAM means **quarter notes per minute**, matching the
quarter-note beat unit used by `durations.js`.

---

## 8. Invariants across the version ladder

A simplified variant is a *different arrangement of the same piece*. These must
match its parent exactly, or the variant is no longer the same song and audio
sync, lyric placement and practice history stop lining up:

- **Measure count.**
- **Per-measure `timeSignature`** — including `symbol`.
- **`audioOffsetMs` on every measure**, nulls included. These are hand-aligned
  against a recording; regenerating them is not possible.
- **`sourceMeasure`** — the link back to the engraved score.

Free to change: pitches, durations, `notes` contents, `chord`, fingerings, and
anything derived from them.

`lyrics` need care rather than preservation: `word_order` and `syllable` must
survive verbatim, but `measure_num`/`rh_index` point at RH event indices that a
simplification will renumber. A variant that rewrites RH must re-place its
syllables or leave them unplaced — it must not silently point them at the wrong
notes.

---

## 9. What is NOT in the export

Not currently round-tripped; anything relying on these must read the database:

- `playback_speed`, `default_timing_window_ms`, `default_chord_ms`,
  `default_measure_width` — per-song practice settings.
- `audio_file_path` — the backing track. `audioOffsetMs` values survive but the
  track they reference does not.
- `show_imported_fingerings`, `archived`, `created_at`/`updated_at`.
- Practice history: `sam_sessions`, `sam_session_events`, `sam_snippets`.

`sourceXmlPath` is exported and written on import, but the import cannot create
the underlying Storage object — a copy inherits a path to its parent's document.
