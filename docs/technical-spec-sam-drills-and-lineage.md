# Technical Spec — SAM: Drills, Song Lineage, and Notation Authoring

**Status:** ready for implementation
**Scope:** SAM (song catalogue, importer, MCP tools, library UI)
**Explicitly out of scope:** the local daemon, Cloudflare tunnel, music21 analysis,
difficulty simplification. This increment is the foundation those land on and needs
none of them.

---

## 1. Overview

Three related capabilities:

1. **Song lineage** — a song may descend from another. Originals, simplified variants,
   and drills form a family rendered as a tree in the library.
2. **Drills** — bespoke practice arrangements (scales, chord-transition patterns) that
   share no notation with any song. Authored as JSON, either pasted into the UI or
   written by Claude through MCP.
3. **Notation authoring over MCP** — two new tier-3 tools that can create a song and
   append measures, which no existing tool can do.

Plus two defects and a data-integrity backfill discovered during design.

### Governing principle — snapshot semantics

Derivation is a **historical fact, not a live dependency.**

- Editing a parent never propagates to a child.
- A child is never recompiled or regenerated from its parent.
- If a variant drifts from what is needed, a new variant is created.
- `generation_notes` is a receipt for human reading, not source for a build step.

This is a deliberate rejection of a build-artifact model. Do not add staleness
detection, regeneration, or read-only enforcement on derived songs.

---

## 2. Architecture decisions

| Decision | Choice | Rationale |
|---|---|---|
| Derived-song relationship | `parent_song_id`, self-FK, `ON DELETE SET NULL` | Deleting an original must not destroy independently valuable drills |
| Type discriminator | `song_type` ∈ `original` \| `simplified` \| `drill` | `difficulty_tier` alone cannot express "drill" |
| Drill parent | Optional | An A-minor scale exercise serves every song in that key |
| Tree depth | Arbitrary in data, flat in UI | Self-FK gives depth free; avoids a migration if branching ever happens |
| Document format | Existing paste format, extended | Already parsed by the app; every existing file stays valid |
| Measure format | `rh` / `lh` only | `beats[]` is legacy and unsupported by `sam_song_measures` |
| Validation parity | Shared JSON Schema file | React and the Edge Function cannot import a common JS module across the deploy boundary, but both can load JSON |
| Both new tools | Tier 3 | Tier is a property of the tool, not the situation — a situational tier is unreadable from the manifest |

---

## 3. Data model

Added to `public.sam_songs` (see `migration-sam-lineage.sql`):

| Column | Type | Notes |
|---|---|---|
| `song_type` | `text not null default 'original'` | CHECK `('original','simplified','drill')` |
| `parent_song_id` | `uuid null` | FK → `sam_songs(id)` `ON DELETE SET NULL` |
| `difficulty_tier` | `smallint null` | 1–9, only when `song_type='simplified'` |
| `generation_notes` | `jsonb null` | Receipt |
| `source_xml_path` | `text null` | Reserved for the daemon phase |

Constraints:

- `sam_songs_lineage_check` — original ⇒ no parent; simplified ⇒ parent required;
  drill ⇒ either.
- `sam_songs_difficulty_tier_check` — tier null unless simplified.
- `sam_songs_no_self_parent_check`.

**`sam_songs` is already registered with the platform layer.** This migration ALTERs
it; `platform.register_table()` must NOT be called again.

---

## 4. The document format (drills and pasted songs)

Top level — camelCase, matching what `parseMusicXML` emits and `SongLoader` inserts:

```json
{
  "title": "Am ↔ F Transition Drill",
  "artist": "SAM Practice",
  "songType": "drill",
  "parentSongId": null,
  "difficultyTier": null,
  "generationNotes": { "purpose": "Am/F transitions" },
  "key": "C major",
  "timeSignature": "4/4",
  "defaultBpm": 60,
  "measures": [ /* ... */ ]
}
```

`songType`, `parentSongId`, `difficultyTier`, `generationNotes` are **optional**;
absent `songType` means `original`, which keeps every pre-existing file valid.

### Measure

```json
{
  "number": 1,
  "timeSignature": { "beats": 4, "beatType": 4 },
  "chord": "Am",
  "section": "ascent",
  "rh": [ /* voice events */ ],
  "lh": [ /* voice events */ ]
}
```

- `rh`, `lh`, and `timeSignature` are **required on every measure**. A silent hand is
  `[{ "duration": "w", "notes": [] }]` — never an omitted key, never `[]`.
- `number` is advisory. `fanOutMeasures` assigns it from array index; array order wins.
- `chord`, `section`, `audioOffsetMs` optional.
- `beats[]` is **rejected**.

### Voice event

```json
{ "duration": "8", "notes": [{ "midi": 69, "name": "A4" }] }
```

- `duration` — VexFlow token: `w` `h` `q` `8` `16` `32`, `d` appended per dot
  (`hd`, `qd`, `8d`). Regex: `^(w|h|q|8|16|32)d*$`
- `notes` — simultaneous pitches. **`[]` means a rest.**
- `midi` — `(octave + 1) × 12 + step + alter`. C4 = 60, A4 = 69.
- `name` — display spelling: step, then `#`/`b`/`##`/`bb`, then octave. `Bb4`, `F#3`.
- Optional on a note: `tie` ∈ `start` \| `end` \| `both`.
- Optional on an event: `tuplet` `{ actual, normal, position }`.
- **`lyric` must NOT appear in authored documents.** `recompileMeasures` strips inline
  lyrics and re-injects from `sam_song_lyrics`; an authored lyric would vanish on first
  recompile.

### The two checks that matter

1. **`midi` and `name` must agree.** They are independent fields with no cross-check
   anywhere in the current codebase. A mismatch renders one pitch and grades another —
   a bug that presents as "my playing is wrong."
2. **Durations must sum to the measure.** On MusicXML import `buildVoice` fills gaps
   automatically, so this has never mattered. For hand-authored drills it does. Skip
   this check for any measure containing a `tuplet`.

---

## 5. Defects to fix

### 5.1 `fanOutMeasures` writes NULL into NOT NULL columns

`src/lib/measureCompiler.js`:

```js
rh: m.rh || null,
lh: m.lh || null,
time_signature: m.timeSignature ? {...} : null,
```

`sam_song_measures.rh`, `.lh`, `.time_signature` are all **NOT NULL**. An explicit
`null` violates the constraint outright — a column default does not rescue it. Any
measure missing a hand fails the whole batch insert with 23502.

Fix: `?? []` for both hands, and a real fallback for `time_signature`
(`{ beats: 4, beatType: 4 }`).

### 5.2 Fan-out failure is silent

In `SongLoader.jsx`, fan-out runs fire-and-forget inside `.then()` with only
`console.error`. The song saves, the `measures` blob is intact, playback works — and
zero measure rows exist. Nothing tells the user.

This is almost certainly why *Someone Like You (Arpeggios — Accompaniment Only)*, an
LH-only document, has no rows in `sam_song_measures`. Not a pre-migration artifact —
this bug, and it will recur on the next single-hand import.

Fix: surface the failure through `setError` with actionable text.

---

## 6. Components

| File | Change |
|---|---|
| `sam-drill-format.schema.json` (repo root) | **new** — JSON Schema, single source of truth |
| `src/lib/songSchema.js` | **new** — validator over the schema plus the two semantic checks |
| `src/lib/measureCompiler.js` | fix 5.1 |
| `src/components/SongLoader.jsx` | fix 5.2; use new validator; pass new fields to insert; Drills section; tree rendering |
| `scripts/backfill-measures.mjs` | **new** — one-off, dry-run first |
| `supabase/functions/_shared/tools/sam-authoring.ts` | **new** — `create_sam_song`, `append_sam_measures` |
| `supabase/functions/mcp/index.ts` | register the two tools |

**`SongLoader`'s insert currently drops `songType` / `parentSongId` / `generationNotes`.**
A drill pastes and plays today, but lands as `original` with no parent. Wiring these
into both insert paths (file and paste) is part of Step 2.

---

## 7. MCP tools

Both built with `defineTool` from `_shared/platform.ts`. Database access only via
`ctx.db`. Never import a Supabase client in a tool file.

### `create_sam_song` — tier 3

Creates an empty song row. Params: `title`, `artist?`, `songType`, `parentSongId?`,
`difficultyTier?`, `generationNotes?`, `key?`, `timeSignature?`, `defaultBpm?`.

- `sam_songs.measures` is **NOT NULL** — insert `[]`.
- Leave `measures_compiled_at` null.
- Returns the new song id.

### `append_sam_measures` — tier 3

Appends measures to an existing song. Params: `songId`, `measures[]`.

- Validates every measure against the shared schema, including the `midi`/`name` and
  duration-sum checks. Reject the whole batch on any failure; report measure index and
  hand.
- `number` continues from `max(number)` for that song.
- Batch of 500 rows max per insert, mirroring `fanOutMeasures`.
- Clamp `measures.length` per call (suggest 100) and report truncation honestly rather
  than silently dropping.
- **Sets `measures_edited_at = now()` and leaves `measures_compiled_at` untouched.**

That last point is the whole integration story. `isMeasuresStale()` returns true when
`measures_edited_at` is set and `measures_compiled_at` is null, so
`handleLoadFromLibrary` recompiles the blob from rows on first open. The React app
self-heals; the tool never touches the blob.

### Descriptions must state the negative

`update_sam_song_measures` is **metadata only** — chord, section, audio offset. It
cannot touch notation. `append_sam_measures` is the only tool that writes `rh`/`lh`.
Both descriptions must say so explicitly, so selection between them doesn't rest on
inference.

---

## 8. Implementation sequence

Each step is independently verifiable. Do not proceed without confirmation.

| # | Step | Gate |
|---|---|---|
| 0 | SQL migration (manual, Supabase SQL editor) | `conformance_failures` empty; `check_platform_conformance` returns CONFORMANT |
| 1 | Fix `fanOutMeasures` nulls + surface failure | Import an LH-only document; measure rows appear |
| 2 | Shared schema + validator + wire new fields into insert | Paste the drill; lands as `song_type='drill'`; bad `midi`/`name` rejected |
| 3 | Backfill measure rows | Dry run first; every song with a non-empty blob has rows |
| 4 | MCP tools | Fresh conversation; tool count rises by 2; drill created end to end |
| 5 | Drills section + tree UI | Families nest; parentless drills have their own section |

Step 3 is gated on Step 1 — backfilling through the null bug would fail on exactly the
songs that need backfilling most.

Step 4 requires a **fresh conversation** to be callable. The MCP manifest freezes at
conversation start; the settings-panel tool count is the reliable deployment
confirmation.

---

## 9. Success criteria

- `check_platform_conformance` returns CONFORMANT after the migration.
- An LH-only JSON document imports and produces measure rows.
- A document with `midi: 69, name: "Bb4"` is rejected with a specific message.
- A pasted drill lands with `song_type='drill'` and the correct `parent_song_id`.
- No song with a non-empty `measures` blob has zero `sam_song_measures` rows.
- Claude can create a drill end to end over MCP, and it opens and plays in SAM.
- Deleting an original leaves its drills intact, re-rooted in the library tree.
- The library shows families as trees and parentless drills in their own section.
