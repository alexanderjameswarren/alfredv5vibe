# Technical Spec: songParser.js Rewrite

**Status:** Ready for implementation
**Owner:** Alex (solo)
**Blocks:** Song Simplification Pipeline (all phases), Workshop analysis stages, clean re-import of the song library
**Validated by:** `tools/sam-tools` — `npm run validate`

---

## 1. Why

`src/sam/lib/songParser.js` silently corrupts real scores. A validator that runs
the parser against 13 MusicXML fixtures and diffs the output against ground truth
computed independently from the source found defects in **all 13**.

The corruption is not cosmetic. It changes which notes sound, how long they sound,
which hand plays them, and how many measures the song has. Every downstream
feature — playback, scroll timing, miss counting, lyric placement, audio sync,
snippet ranges, and the entire simplification pipeline — is built on this output.

Critically, **most of the damage is invisible to any check written against the
parser's own output.** Six measures in "Someone Like You" have per-hand duration
sums that are exactly correct and pitch content that is wrong. Detecting them
requires comparing against the MusicXML, which is what `sam-tools` does.

### Baseline

Authoritative machine-readable version: `tools/sam-tools/baseline-report.json`.
**Regenerate it against your local fixture set before starting** (see §6).

Status at time of writing: 9 BLOCKED, 4 WARN, 0 CLEAN. Dominant classes:

```
voice collision           129   Entertainer, Pastorale, La Candeur, Say It Ain't So,
                                Someone Like You, Moonlight
tuplet scaling            115   Für Elise, Someone Like You, Moonlight
notes[] not pitch-sorted   81   (100% correlated with voice collision — no exceptions)
cross-staff voice          33   Entertainer, Moonlight
grace note dropped         19   Pastorale, Für Elise, Say It Ain't So, Someone Like You
unflattened repeat          6   six songs
UNHANDLED · alters pitch    5   Entertainer, Für Elise (octave-shift), Bach Invention (ornaments)
incomplete measure          -   Entertainer m3 (cross-staff artifact), Prelude m43 (genuine)
anacrusis                   4   Für Elise m1 + m9 — informational, never padded
```

### The oracle is independently cross-checked

`music21.expandRepeats()` was run against every fixture and agreed with
`resolvePlaybackOrder()` on measure counts for all but one — including the D.S. al
Coda case (73 → 82). The exception is Für Elise, where **music21 silently declined
to expand** (106 → 106, no exception, no warning), almost certainly because the
backward repeat at bar 8 has no matching forward repeat. Our resolver produces the
musically correct order. See §8.4.

---

## 2. Guiding principle

> **Nothing that affects playback is dropped silently.**

Every MusicXML feature gets one of three dispositions, explicit in code:

| Disposition | Meaning |
|---|---|
| **HANDLE** | The parser implements it and it changes the output. |
| **CARRY** | Stored on the event/measure for a later consumer; not acted on now. |
| **FLAG** | Recorded in `parseWarnings[]`, surfaced to the user at import. |

A feature that is neither handled, carried, nor flagged is a bug — regardless of
whether the output happens to look right.

---

## 3. Architecture decisions

### 3.1 Reference implementations already exist — port, don't reinvent

`tools/sam-tools/lib/xmlTruth.js` contains working implementations of the two
hardest pieces, verified against the whole corpus:

- **`mergeStaff(voices, staff, measureLen)`** — merges the voices of one staff into
  a single serial array by splitting sustained notes into tied fragments at every
  onset boundary. The voice-collision fix.
- **`resolvePlaybackOrder(measEls)`** — resolves forward/backward repeats, voltas,
  segno, To Coda, D.S., D.C. and Fine into a flat array of source measure indices.
  The repeat/navigation fix.

Port these into `src/sam/lib/`. Do not rewrite from scratch. The validator will
confirm the port is faithful.

### 3.2 `<duration>` is the authority, never `<type>`

MusicXML `<duration>` is already tuplet-scaled sounding time. `<type>` is the
visual glyph.

**Corrected 2026-08-05 (surfaced by the M1 mutation test):** the parser
itself is *not* wrong about tuplets. It reads `<time-modification>` and emits
`{ duration: "8", tuplet: { actual: 3, normal: 2 } }` for a triplet-eighth.
That is the correct storage shape — SAM's token vocabulary can't express
1/3 of a beat as a single scalar, so tokens are display glyphs and the ratio
lives on the event. Sounding time is recoverable as
`tokenToBeats(duration) × normal/actual`.

The actual bug is in every consumer that sums durations *without* applying
the ratio. The old validator's `sumEvents` was one of them and produced 115
false-positive `tuplet_scaling` findings. The M1 call-site audit
(progress doc) enumerates the app-side offenders — measureCompiler,
playback scheduling, snippet range math, and anything else summing rh/lh
by naive `tokenToBeats(duration)`. Any consumer that doesn't now go through
tuplet-aware `sumEvents` is a live 4.5-beats-in-a-4-beat-bar bug.

**Rule:** beats come from `<duration> / <divisions>` and the stored `tuplet`
marker in combination. `<type>` only chooses the display token. If `<type>`
and `<duration>` disagree with no `<time-modification>` to explain it, FLAG.

`divisions` varies across the corpus (2, 4, 24). Never assume a value.

### 3.3 Position stays implied in storage; explicit in memory

Do **not** change the stored shape. `rh`/`lh` remain ordered arrays with position
reconstructed by walking and summing. Changing this breaks the compiled measures
blob, VexFlow rendering, `rh_index` lyric placement, and `append_sam_measures`.

Add a lift/lower pair used internally by the parser and every future transform:

```js
toTimeline(events)   // -> [{ onsetBeats, durBeats, notes, ... }]
fromTimeline(tl)     // -> [{ duration, notes, ... }]
```

with a round-trip property test. Voice merging, gap filling, and everything in the
simplification pipeline operate on the timeline, never the raw array.

### 3.4 Repeats are flattened at parse time

Stored measures are **played** measures. This is required, not convenient:
`audio_offset_ms` maps a measure to a timestamp in a linear recording, and under
repeats that relation is one-to-many and unrepresentable.

Consequences, all accepted:

- Measure numbering diverges from the printed score → mitigated by `source_measure`.
- `chord`, `section` and `audio_offset_ms` duplicate per pass. Desired — each pass
  has a different timestamp and may carry a different label.
- Lyrics get distinct measures per verse, which is what makes verse-2 placement
  possible at all.

**The flattener must be idempotent.** Flattening an already-flat score is a no-op.
This matters because Workshop-produced variants may arrive pre-expanded.

Repeat/navigation structure is recorded in `sam_songs.generation_notes` so an
unflattened variant can be regenerated without re-parsing. **Recordings frequently
do not take the repeats.**

### 3.5 `fifths` is trusted; `<mode>` is not

`fifths` is correct in every fixture. `<mode>` is absent in most and *wrong* in
Prelude in C minor, which declares `mode=major` at `fifths=-3`. Für Elise reports
`fifths 0` against a title saying A minor.

Store `fifths` as an integer, derive the display name from it, do not prompt the
user, do not build an inference engine. Every consumer that matters (VexFlow
accidentals, MIDI matching, playback) uses `fifths` or absolute pitch. A piece
labelled with its relative major is cosmetic.

### 3.6 Hand assignment is per-voice, per-song — NOT per-note

**This supersedes any earlier "trust `<staff>`" rule.**

Neither signal works alone:

- **`<staff>` alone tears cross-staff lines apart.** Moonlight m6 voice 2 is one
  continuous triplet arpeggio — `G3(staff2) D4(staff1) F4(staff1) G3(staff2) …` —
  with its lowest note engraved on the bass staff for readability. Splitting by
  staff sends every third note to the wrong hand.
- **Voice number alone is wrong too.** MuseScore's 1–4 / 5–8 convention is not
  universal; music21's writer emits voice 2 on staff 2.

**The rule:**

1. Group notes by the `(staff, voice)` tuple for *voice identification*.
2. Tally each voice number's `<staff>` distribution **across the whole song**.
3. Assign each voice to the hand of its majority staff, and apply that to every
   note of that voice everywhere — including notes engraved on the other staff.
4. If a voice's majority is below 60%, FLAG rather than guess. Corpus low is 67%.

Song-level tallies are stable; per-measure majorities are not. Entertainer m3 has
voice 1 at 3 notes on staff 1 vs 5 on staff 2, while m4 has 7 vs 1 — a per-measure
rule flips the melody between hands in adjacent bars. Song-level gives
`voice 1 → staff 1 (99%)`, `voice 5 → staff 2 (99%)` unambiguously.

Applied to Moonlight: voices 1 and 2 → RH, voices 5 and 6 → LH. Melody and full
arpeggio in the right hand, bass octaves in the left. Exactly how it is played.

The existing `staff === 0 && midi < 60` middle-C fallback stays for single-staff
sources only, and FLAGs when it fires.

### 3.7 Short measures: anacrusis vs incomplete

`measure_underflow` is two distinct things and only one is a defect.

| Class | Test | Action |
|---|---|---|
| `anacrusis` | `<measure implicit="yes">`, or measure 1 is short | **Keep short. Never pad.** Record pickup length on the song. |
| `anacrusis` (borrowed partner) | Short measure where its length + pickup = one full bar | **Keep short. Never pad.** |
| `incomplete_measure` | Anything else short | Pad with a trailing rest |

Für Elise measure 1 is `implicit="yes"`, 0.5 of 1.5 beats. Measure 9 is 1.0 of 1.5.
Together they are exactly one bar — the standard repeat seam, where the first
ending is shortened by the pickup's length because the repeat replays the pickup.
**Padding either inserts two extra beats and drifts every subsequent
`audio_offset_ms`.**

The flattener must not treat a borrowed pair as two separate measures when
computing playback order.

### 3.8 `source_measure` comes from the `<measure number>` attribute

Für Elise's measures carry `number="0", "1", … "105"` — printed numbers offset by
the pickup. The current parser ignores the attribute and uses `measIdx + 1`.

`source_measure` must be read from the `number` attribute, or the Stopped UI will
display numbers that do not match the printed page.

---

## 4. Data model changes

### 4.1 Migration (manual prerequisite — see §6)

```sql
alter table public.sam_song_measures
  add column if not exists source_measure integer;

comment on column public.sam_song_measures.source_measure is
  'Measure number in the printed/source score, read from the MusicXML <measure '
  'number> attribute. Differs from `number` when repeats and navigation marks '
  'were flattened at parse time, and when a pickup offsets the numbering. '
  'Null = same as `number`.';
```

`sam_song_measures` is already registered with the platform layer (registered
2026-07-24, audited, RLS via parent song), so `register_table` is **not** called
again. The conformance check still is.

### 4.2 Event shape additions (all optional, backward-compatible)

| Field | Level | Disposition | Notes |
|---|---|---|---|
| `voice` | event | CARRY | Source voice number. Needed for multi-voice VexFlow later. |
| `tuplet` | event | HANDLE | `{actual, normal}`. Beat math multiplies by `normal/actual`. |
| `tie` | note | HANDLE | Exists. Merging must never orphan a start or end. |
| `pedal` | measure | CARRY | 51 marks in Für Elise, 28 in Someone Like You. |
| `articulations` | event | CARRY | staccato / accent / tenuto. |
| `fermata` | event | CARRY | Affects timing; FLAG until handled. |
| `source_measure` | measure | HANDLE | See §3.8. |

`notes[]` must be **sorted ascending by midi**. All 81 unsorted arrays sit inside
voice-collision measures, so this likely falls out of the merge fix for free — but
assert it, because the simplification pipeline's melody rule depends on it.

### 4.3 Free metadata wins

- `<harmony>` → `chord`. 101 chord symbols unread in Someone Like You.
  **De-duplicate per measure** — a music21 round-trip doubles them (101 → 202).
- `<rehearsal>` → `section`. 8 marks in Beverly Hills.
- Multiple `<sound tempo>` → tempo map. Auld Lang Syne has 19 marks / 10 distinct
  (24–58 BPM); Für Elise has 4 distinct (72, 66, 60, 48). Parser keeps only the first.

---

## 5. Notation disposition table

From an actual scan of the 13 fixtures. Anything not listed and not handled FLAGs.

| Notation | Present in | Disposition |
|---|---|---|
| `<voice>` | all | **HANDLE** — group by `(staff, voice)`, merge with tie splitting |
| `<time-modification>` | Someone Like You, Für Elise, Moonlight | **HANDLE** — scale by `normal/actual` |
| repeats / `<ending>` | six songs | **HANDLE** — flatten, idempotently |
| segno / coda / D.S. | Someone Like You | **HANDLE** — flatten |
| `<octave-shift>` | Entertainer m37, Für Elise m82–83 | **CARRY** — display element, does NOT alter sounding pitch (see amendment below) |
| `implicit` / pickup | Für Elise m1 | **HANDLE** — never pad; see §3.7 |
| short final measure | Prelude m43 | **HANDLE** — pad with trailing rest |
| multiple `<sound tempo>` | Auld Lang Syne, Für Elise | **HANDLE** — tempo map |
| `<harmony>` | Someone Like You | **HANDLE** — populate `chord`, de-duplicated |
| `<rehearsal>` | Beverly Hills | **HANDLE** — populate `section` |
| `<transpose>` | none | **FLAG** — alters pitch; refuse rather than guess |
| `<arpeggiate>` | Bach Invention | **FLAG** |
| mordent / trill / turn / tremolo | Bach Invention | **FLAG** |
| `<grace>` | 4 songs, 19 notes | **FLAG** — currently dropped silently |
| `<fermata>` | many | **CARRY + FLAG** |
| `<pedal>` | Für Elise, Someone Like You | **CARRY** |
| articulations, dynamics, wedges, slurs | many | **CARRY** |

### §5 amendment (Alex, 2026-08-05) — NOTATION_TIERS were unverified

The tier assignments in `tools/sam-tools/lib/xmlTruth.js:NOTATION_TIERS`
were originally made from tag names during the initial notation scan
and were NOT verified against actual behaviour. Two turned out to be
wrong:

- `<octave-shift>` was tier A ("alters pitch"). Empirical evidence
  (below) shows MusicXML `<pitch>` already encodes sounding pitch;
  the bracket is a display element. **Reclassified to tier C** (same
  bucket as pedal / dynamics / articulations). Also promoted to a
  CARRY item for a future milestone (renderer draws the 8va bracket).
- `<arpeggiate>` was tier A. A rolled chord has the same PITCHES as
  a block chord — the notation just staggers the ONSETS. That's a
  timing change, not a pitch change. **Reclassified to tier B** along
  with its explicit-no-roll counterpart `<non-arpeggiate>`.

**If a future milestone touches a tier-A tag, verify what it actually
does to sounding pitch before implementing anything.** The tier
declares the taxonomic bucket the finding lands in; it does not by
itself prove the notation behaves the way the name suggests.

Tier A after reclass — genuinely pitch-affecting:
`transpose`, `trill-mark`, `mordent`, `inverted-mordent`, `turn`,
`inverted-turn`, `tremolo`, `glissando`, `slide`, `cue`.
Only `mordent` and `inverted-mordent` are corpus-reachable today
(Bach Invention).

### §5 amendment (Alex, 2026-08-05) — `song.tempos` is SAMPLED PLAYBACK tempo

Verified empirically for Auld Lang Syne and Für Elise. Only three of
Auld Lang Syne's 19 `<sound tempo>` marks carry a notated `<words>`
label:
- m1: "Andante" (opening tempo)
- m18: "Rallentando" (start of rit.)
- All 16 others: `words="S"` — MuseScore's sampled playback tempo
  interpolation of the rall. bracket into per-position samples

Für Elise's 4 marks:
- m0: "Poco moto"
- m104: three marks with `words="66"`, `"60"`, `"48"` — literal BPM
  numbers, either MuseScore-sampled or hand-typed to notate the final
  ritardando as discrete steps

**Field semantics.** `song.tempos: [{playIndex, beatOffset, bpm}]` holds
every `<sound tempo>` mark in the source, positioned by measure + beat
offset. Under playback flattening, marks on a repeated source measure
appear at each play position (Für Elise's `Poco moto` at m0 shows at
both play0 and play9 because the pickup replays). This is MuseScore's
sampled playback tempo TRACK — the audio playback engine can feed it
straight into a bpm envelope.

**What it is NOT.** Notated markings — "Andante", "Rallentando",
"rit.", "a tempo", "molto rall.", metronome equations — live in
`<words>` and `<metronome>` elements. The parser does not read those
today. A future feature that needs "which measures have a notated
tempo instruction, and what does it say" must go through `<words>`,
NOT `song.tempos`. The sampled track will always overcount: 19 tempo
marks vs 2 notated ones for Auld Lang Syne.

Same class of misinterpretation risk as `<octave-shift>` (below):
inferring behaviour from the tag name. Verified 2026-08-05 to avoid
downstream features building on the wrong assumption.

### §5 amendment (Alex, 2026-08-05) — `<octave-shift>` is CARRY, not HANDLE

The table originally listed `<octave-shift>` as HANDLE with "transposes
pitch". That was wrong and truth was briefly patched to apply the
transformation before it got caught. Corrected empirically against the
corpus:

**Evidence.** MusicXML `<pitch>` already encodes the SOUNDING pitch.
`<octave-shift>` describes how the passage is DRAWN (engraved an
octave lower or higher, under an 8va/8vb bracket, to avoid many ledger
lines). It is a display element in the same family as
`<time symbol="cut">`.

Für Elise source pitches (verified 2026-08-05):

```
idx80  A3 C4 E4 A4 C5 E5        (no shift active)
idx81  A4 C5 E5 A5 C6 E6        (no shift active — one octave above idx80 already)
idx82  A5 C6 E6 A6 C7 E7        octave-shift type="down" size="8" active
idx83  B6 A6 G6 ...             stop; continues from idx82's E7 naturally
```

The line already climbs A3→A4→A5 across three measures at written
pitch. Idx83's B6 sits one step down from idx82's E7. Transposing
idx82 UP by an octave would yield A6 C7 E7 A7 C8 E8 — above the top of
an 88-key piano — and would create a 2-octave discontinuity between
idx82 and idx83 at the bracket's stop. Not musical, not what the
score sounds like.

Entertainer m36-37 shows the same shape: the octave-shift-bracketed
figure `E5 C6 E6 F5 D6 F6 F5 D6 F6` sits in the same register as m35's
`F4-C5-D5-E5` context and m37's `E4 C5 E4 C5`. Transposing UP would
break the continuous line across the barline.

**Corrected disposition.** `<octave-shift>` is CARRY:
- Truth: leave `<pitch>` values alone. `<octave-shift>` is not applied
  to computed midi.
- Parser: store the bracket per-measure so the renderer can draw an
  8va line later. Do not transform pitches.

**Truth does not model unverified pitch transformations.** If a
`<transpose>` fixture ever arrives (none in corpus today), truth
should emit a distinct "cannot verify" finding rather than guess at a
transformation. Group A's mechanism (truth models it → content_divergence
fires on parser miss) remains in the validator for a future notation
that genuinely alters sounding pitch, but Group A is EMPTY for this
corpus.

Do not re-fix this: the empirical evidence above is the authority. Any
future proposal to move `<octave-shift>` back to HANDLE must first
account for the pitch sequences above.

---

## 6. Manual prerequisites

Run **before** the CLI touches any code. Platform SQL is applied out-of-band in the
Supabase SQL editor, never by the CLI.

1. Apply the §4.1 migration in the Supabase SQL editor.
2. Run `check_platform_conformance`. Expect `CONFORMANT`. Do not proceed otherwise.
3. Confirm `sam_songs.generation_notes` exists; add it in the same block if not,
   and re-run the conformance check.
4. Create the `sam-scores` Storage bucket with RLS, and wire SongLoader to upload
   the raw source file and populate `sam_songs.source_xml_path` (the column already
   exists from the lineage migration, currently null everywhere). **Do this now,
   not in the simplify project** — this rewrite ends with a full library re-import,
   and if the bucket lands first, that single pass populates it. Otherwise you
   re-import twice.
5. `cd tools/sam-tools && npm install && npm run sync && npm run baseline`.
   `sync` copies the live parser into `vendor/`; `baseline` records the true
   before-picture **against your local fixture set**. Commit the result.

---

## 7. Milestones

Each milestone has a **mechanical** exit criterion: a named defect class drops to
zero and no other class moves. That property is why the harness was built first —
these bugs interact and cannot be fixed by eye.

After every change to `src/sam/lib/songParser.js`:

```bash
npm run check        # syncs vendor/ then validates
```

| # | Milestone | Exit criterion |
|---|---|---|
| **M0** | Harness in repo, baseline recorded | Reproduces `baseline-report.json` |
| **M1** | `durations.js` + tuplet-aware beat math | `tuplet_scaling` → 0 |
| **M2** | Voice grouping, per-song hand assignment, `mergeStaff` port | `voice_collision`, `notes_unsorted`, `cross_staff` → 0 |
| **M3** | Anacrusis detection; trailing-rest padding; exact gap-fill | `incomplete_measure`, `measure_overflow`, `gap_fill_inexact` → 0. `anacrusis` stays non-zero. |
| **M4** | `resolvePlaybackOrder` port; `source_measure` from the `number` attribute; Stopped UI | `unflattened_repeat` → 0 |
| **M5** | D.S. / segno / coda / Fine | `unresolved_navigation` → 0 |
| **M6** | ornaments/arpeggiate/transpose FLAG (grace already FLAGged as of M2). Scope shrunk 2026-08-05 — no `<octave-shift>` implementation this milestone; the tag is now CARRY (display element), tracked separately | `unhandled_notation_pitch` → 0; `parseWarnings` non-empty for Bach Invention |
| **M7** | `<harmony>` → `chord` (de-duped), `<rehearsal>` → `section`, tempo map | `discarded_metadata`, `tempo_changes_lost`, `key_mode_wrong` → 0 |
| **M8** | `parseWarnings[]` surfaced in the import UI | User sees the list before committing |

**Order is a dependency chain.** M2 needs M1's beat math. M4 needs M2 producing
correct measures before duplicating them. Do not reorder.

**M2 and M3 interact.** Entertainer m3 currently reports `incomplete_measure`
(RH sums to 0.75 of 2), but its voice tally is `1:1 → 3, 1:2 → 5, 5:2 → 8`. Under
§3.6, voice 1 goes entirely to the RH and the measure is full. **That underflow is
a cross-staff artifact and M2 fixes it — do not pad it in M3.** Re-measure M3's
residual set after M2 lands. Prelude m43 is the genuinely incomplete one.

---

## 8. Testing

### 8.1 Automated

13 fixtures, run after every milestone. Target end state: **13 CLEAN**.

### 8.2 Unit tests

- `toTimeline` / `fromTimeline` round-trip on every fixture measure.
- `tokenToBeats("qdd") === 1.75` — double dots exist (Someone Like You m47).
- Per-hand sum equals measure length, except anacrusis measures.
- Tie integrity: no orphan starts or ends across a whole song.
- Flattener idempotence: `flatten(flatten(x)) === flatten(x)`.

### 8.3 Human verification — required, not optional

The validator proves structure, not music.

- **After M2 — Moonlight, bars 1–12.** The acid test: 96 tuplet findings and 80
  collisions across 69 bars, 31 of them cross-staff. The RH must play melody plus
  the *complete* triplet arpeggio; the LH only bass octaves. If the arpeggio is
  split across hands, §3.6 was implemented per-note instead of per-voice.
- **After M2 — Someone Like You m37–39.** LH must be an eighth-note pulse under a
  held dyad, not seven beats of noise.
- **After M4 — Arabesque.** 55 measures, repeating where the printed score repeats.
  Stopped UI shows both numbers.
- **After M4 — Für Elise.** 127 measures. The pickup must be replayed on the repeat
  and the first ending skipped on the second pass.
- **After M5 — Someone Like You.** 82 measures, reaching the coda.

### 8.4 Known limits

**music21 is not authoritative on repeat structure.** It agreed with our resolver
on every fixture except Für Elise, where `expandRepeats()` silently returned the
input unchanged — no exception, no warning. Two silent structural losses are now
documented: this, and D.S./coda semantics being dropped on `write('musicxml')`
(the `<segno>`/`<coda>` glyphs survive; the `<sound dalsegno>`/`<sound tocoda>`
attributes do not).

Consequence for Workshop: `sam_analyze.py` must **assert** the expanded measure
count against a value passed in from SAM and fail loudly on mismatch, rather than
analyzing a score that quietly did not expand.

**No fixture has a `<transpose>` element.** That path is unexercised, which is why
its disposition is FLAG rather than HANDLE.

---

## 9. Success criteria

- [ ] `npm run validate` reports 13 CLEAN.
- [ ] Someone Like You parses to 82 measures, Für Elise to 127, with zero defects.
- [ ] Every measure's per-hand sum equals its measure length (anacrusis excepted),
      so `append_sam_measures` accepts every song in the library.
- [ ] Moonlight's arpeggio is intact in the right hand, verified by ear.
- [ ] `source_measure` populated from the `number` attribute; Stopped UI shows it.
- [ ] `parseWarnings[]` returned by every parse and surfaced at import.
- [ ] `source_xml_path` populated for every song, so re-parsing never requires
      re-downloading from musescore.org.
- [ ] No MusicXML feature dropped without being handled, carried, or flagged.

---

## 10. Out of scope

- The simplification pipeline itself (this unblocks it; it does not build it).
- Workshop tooling. The parser rewrite does not touch it.
- Multi-voice VexFlow rendering. `voice` is CARRIED for it; merged output renders
  as a single voice with ties, which is correct notation and sufficient.
- Playback of pedal, dynamics, articulations. CARRIED only.
- Ornament realization. FLAG only.
- Any change to the stored `rh`/`lh` array shape.
