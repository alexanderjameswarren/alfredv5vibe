# Technical Specification: Sight Reader

## Overview

A sight-reading flashcard game for SAM. It draws one note or one chord on a
single stave with a clef, offers four tappable answer tiles, and tracks accuracy
for the session. When a chord is answered wrongly it explains the correct chord
in plain English and names the difference from what was picked.

It lives as a variant on the existing Games tab, alongside the tile-merge
puzzles. It is not a "drill" in SAM's existing sense — that word already means a
derived practice song (`song_type = 'drill'`) and must not be reused here.

**Touches no database.** No migration, no new table, no MCP tool, no platform
conformance step. All state is in memory or in browser storage.

## Decisions already made

| Question | Decision | Why |
|---|---|---|
| Where it lives | A variant in `src/games/variants.js`, named "Sight Reader" | The registry costs one entry and one file; no router or `Alfred.jsx` edits. Reversible if it later deserves its own tab. |
| Notation rendering | A small new renderer, not a retrofit of `ScoreRenderer.jsx` | `ScoreRenderer` is 795 lines, always draws a braced grand staff with a time signature, and only accepts measure arrays. Making it optional means threading conditions through tie tracking, geometry capture, and the fingering and ghost overlays to use ~5% of it — the regression risk lands on live practice screens. |
| Accuracy storage | Browser storage via `src/games/gameStorage.js` | Free, already wrapped and try/caught. Device-local is a known limitation, accepted for v1. |
| Prompt source | Generated pitches | Even coverage of the tricky ledger-line notes, which is the point of the exercise. |
| Chord vocabulary | Seven qualities | Four tiles can only carry so much confusion; eighteen makes wrong answers arbitrary rather than instructive. |

## Phase 2 (design for it, do not build it)

A toggle limiting prompts to notes and chords that appear in songs currently
being learned. This is the reason for the data-shape rule below: if generated
prompts use SAM's own note shape from the start, the song-sourced mode becomes a
different source feeding the same renderer and the same tiles, not a rewrite.

## Data shapes

### Reuse SAM's note shape verbatim

A note is `{ midi, name }`, where `name` matches `^[A-G](##|bb|#|b)?-?[0-9]$` —
the same shape stored in `sam_song_measures` and validated by
`sam-drill-format.schema.json`. `midi` is `(octave + 1) * 12 + step + alter`,
so C4 = 60.

Both fields are required and must agree. Generated prompts follow this even
though they are never persisted.

A chord is several notes in one event, exactly as SAM already represents it:
`{ duration: "w", notes: [Note, Note, Note] }`.

`name` already spells "F#3", which is the answer-tile text. No separate display
formatting is needed.

### The prompt object

```js
{
  clef: "treble" | "bass",
  event: { duration: "w", notes: [ {midi, name}, ... ] },
  label: "F#3" | "Dm7",        // the correct answer, as shown on a tile
  options: [string, string, string, string],   // shuffled, includes label
  chord: { root, quality, octave } | null      // present only for chords
}
```

`chord` is carried so a wrong answer can be explained without re-deriving
anything.

## Music logic (new — `src/games/sightReader/music.js`, pure, no React, no VexFlow)

### Chord model

Store roots and qualities separately and derive the notes. Twelve roots times
seven qualities is eighty-four chords from about fifteen lines of data, rather
than eighty-four hand-typed rows that can be mistyped.

Roots: C, D, E, F, G, A, B, F#, C#, Bb, Eb, Ab.

Qualities, as intervals in half-steps above the root:

| Name | Suffix | Intervals |
|---|---|---|
| Major | (none) | 0, 4, 7 |
| Minor | m | 0, 3, 7 |
| Diminished | dim | 0, 3, 6 |
| Augmented | aug | 0, 4, 8 |
| Dominant seventh | 7 | 0, 4, 7, 10 |
| Major seventh | maj7 | 0, 4, 7, 11 |
| Minor seventh | m7 | 0, 3, 7, 10 |

### Spelling

Chords must spell correctly: D major is D–F#–A, never D–Gb–A. Stack letter names
first, then compute the accidental needed to hit the target pitch.

1. Chord tones sit at letter distances 0, 2, 4, 6 from the root letter — root,
   third, fifth, seventh.
2. For each, take the target letter. Find the natural half-step gap between the
   root letter and that letter, modulo 12.
3. The accidental is `rootAlter + interval - naturalGap`, clamped into the range
   from double-flat to double-sharp by adding or subtracting 12.

This is about eight lines and is the only correct way to get the enharmonic
spelling right.

### Naming

`chordName(root, quality)` = root letter + accidental symbol + quality suffix.
So "C", "Dm", "F#dim", "Bbmaj7".

Nothing in SAM does this today. The MusicXML importer
(`buildChordSymbol`, `songParser.js:110`) goes the other way — symbol text out of
an XML element — and cannot be called with pitches. Its quality-suffix table at
`songParser.js:100-107` may be lifted as a shared constant if the suffix
spellings should match, but that is a pure move with no behaviour change and is
optional.

### Pitch ranges and difficulty weighting

Notes off the staff on ledger lines are the tricky ones and must appear more
often than notes sitting on the staff.

| Clef | Pool | Staff lines run from |
|---|---|---|
| Treble | B3 to C6 | E4 to F5 |
| Bass | C2 to D4 | G2 to A3 |

Weight for a pitch = `1 + 2.2 × (diatonic steps outside the staff range)`, so a
note four ledger steps out comes up roughly ten times as often as one sitting on
a line. Multiply further by `1 + 2 × (times missed)` so mistakes get drilled.

### Distractor generation

**The accidental must never be the giveaway.** An earlier version of this rule
spelled every distractor natural, which meant that whenever the answer carried a
sharp it was the only tile that did — and the round could be won by scanning the
tiles instead of reading the staff. Closing that is the first job of the note
rule, and closing its mirror is the second.

For notes, by branch:

- **The answer carries an accidental.** One wrong answer must be the same letter
  and octave spelled natural — if the answer is F#4, one tile reads F4. At least
  one other wrong answer must also carry an accidental, so the answer is not the
  only altered tile. The natural twin is deliberate rather than a trick:
  noticing the sharp is the skill being drilled, so having both spellings of
  that notehead on screen at once is the point.
- **The answer is a plain natural.** Roughly half the time, at least one wrong
  answer should carry an accidental anyway. Without this the player simply
  learns the opposite tell — that an all-natural set of tiles means a natural
  answer.
- **Whatever is left over** stays as it was: the octave twin at roughly 60%
  (C3 versus C4 is exactly the confusion the octave numbers exist to train, and
  the twin keeps the answer's accidental — F#4's twin is F#5, not F5), then
  staff neighbours one to three steps away.

Both required takes are satisfiable for the declared pitch pools: every
accidental in either pool has its natural twin and at least one octave twin in
the same pool. The tests assert this for every pitch, so a later range change
that broke the guarantee fails loudly rather than quietly restoring the tell.

For chords: at least one wrong answer is the same root with a different quality
(the hardest and most useful confusion), the rest are different roots with the
same quality.

All four options shuffled. The correct answer is always present exactly once,
and no two tiles may be identical.

## Rendering (new — `src/games/sightReader/BareStave.jsx`)

A small React component. Props: `clef` ("treble" or "bass") and `event` (one
VoiceEvent). Draws one stave, one clef, one whole note or chord. No time
signature, no brace, no second stave, no ties, no tuplets, no lyrics, no
fingerings, no geometry capture, no tap handling.

Constraints, all confirmed against the existing codebase:

- VexFlow is **global, not imported**. It loads from a CDN at
  `public/index.html:44` (version 4.2.2) and every consumer reads
  `const VF = window.Vex?.Flow`. Do not add it to `package.json`. Guard for it
  being absent and render a readable fallback rather than throwing.
- **Accidentals attach to the notehead, never as a key signature.**
  `addKeySignature` is called nowhere in SAM; everything renders in C with
  explicit per-note accidentals via `new VF.Accidental(acc)` as a modifier.
  Match that.
- **Do not shift the note's x position after layout.** The accidental does not
  travel with an x-shift and ends up floating out near the clef, where it reads
  as a key signature. The note should sit just after the clef with a small gap,
  which is what the formatter does naturally at a narrow format width.
- Reuse `noteAccidental` and `toVexKeys` from `src/sam/lib/vexflowHelpers.js`
  rather than re-deriving accidentals.
- Output SVG sized to fit its container: set a `viewBox` and strip the fixed
  width and height attributes VexFlow writes.
- **The vertical window is derived from the pitch pools, not chosen by eye.**
  An early fixed window clipped the bottom half of C2's notehead. The renderer
  now walks everything it can be asked to draw — every pitch in both pools and
  all eighty-four chords in both clefs — and measures the furthest any reaches
  past the five lines (four diatonic steps, from C6 in treble and C2 in bass;
  chords never exceed two). Widen a pool in `music.js` and the window follows.
  One symmetric value shared by both clefs, so the stave is centred and does not
  jump when the clef changes — which in a drill that alternates clef constantly
  would be worse than the few pixels it costs.
- **Frame the viewBox from the stave's reported line positions**, not from
  VexFlow's constants. VexFlow reserves blank space above the five lines, so the
  `y` passed to `new VF.Stave()` is not where the top line lands; draw at a
  fixed `y` and read `getYForLine(0)` and `getYForLine(4)` back. Pixels-per-step
  comes from the same measurement — the staff spans eight diatonic steps — so no
  VexFlow default is baked in.

This is deliberately a third VexFlow renderer in a codebase that already has
two. That duplication is a real cost, accepted because the alternative puts the
live practice screens at risk.

## Screen (new — `src/games/variants/sightReader.jsx`)

Layout, top to bottom: two toggle groups, the stave, four answer tiles in a
two-by-two grid, the scoreboard, the list of what is being missed, a
collapsible chord guide, and Reset.

**What fits one phone screen.** The toggles, the stave and the tiles always sit
together — reading the note and answering it must never need a scroll, and that
is the constraint the rest of the layout gives way to. On the smallest phone in
regular use (375×667) those come to roughly 464px of the ~507px available at
scroll top, leaving the scoreboard right at the fold. The missed list, the chord
guide and Reset are below it deliberately: the guide is reference rather than
part of the loop, the missed list is for between rounds, and Reset should be
nowhere near a thumb working the tiles. Two things bought that fit without
shrinking anything — the scoreboard is a single line in StatsBar's wording
rather than a block of figures, and the missed list is wrapping chips rather
than six rows.

Changing either toggle draws a fresh prompt. Leaving the old one on screen with
tiles that no longer match what was asked for is the obvious bug here.

Toggles:
- What to drill: Notes / Chords / Mix. Mix is a 50/50 split.
- Which clef: Treble / Bass / Both.

Answering:
- Correct: tile turns to the success colour, advance after ~550ms.
- Wrong note: tile turns to the destructive colour, the right answer is
  outlined, advance after ~1500ms.
- Wrong chord: same feedback, but **do not auto-advance**. Show the explanation
  panel and wait for an explicit "Next chord" press.
- Number keys 1–4 select a tile, for desktop use. Modified presses are left
  alone; `Cmd-1` switches browser tabs and is not the game's to take.
- Tiles are inert between answering and advancing, so a second tap cannot
  register against the prompt that has not appeared yet.

Scoreboard: accuracy percent, correct over asked, and current streak. Plus a
running list of the six most-missed prompts with their counts.

**Both name their own scope on screen.** Accuracy says "this session"; the
missed list says "all time". They sit four lines apart and span different
things, and `PracticeFigures.jsx` records what happens when that is left
implicit — SAM once showed "Today:" beside "Total:" where one meant every song
and the other meant this song, and neither could be read.

## Chord explanations

On a wrong chord, show four things: the chord name and its type, the notes
actually on the staff spelled out, a plain-English description of that chord
type, and the specific difference from what was picked.

The difference line is computed, not canned:
- Different root: say which note the chord is named after and why.
- Different number of notes: say there is an extra note on top, or one fewer.
- Otherwise: find the first differing note and say "that chord wants F where the
  staff shows F#, a half-step lower."

### Descriptions (`src/games/sightReader/chordTypes.js`)

Write these for a reader who does not know what a third or a fifth is.

- **Major** — The plain, settled-sounding chord. Three notes: the root, the note
  four half-steps above it, and the note seven half-steps above it.
- **Minor** — The same as major, except the middle note sits one half-step
  lower. That single change is what makes it sound sad rather than bright.
- **Diminished** — Minor, with the top note also pulled down a half-step. Both
  upper notes are squeezed inward, so it sounds tense and unfinished.
- **Augmented** — Major, with the top note pushed up a half-step instead.
  Stretched outward, so it sounds unsettled and floating.
- **Dominant seventh** — A major chord with a fourth note added on top, ten
  half-steps above the root. It sounds like it wants to move somewhere — the
  usual chord just before you land home.
- **Major seventh** — A major chord with a fourth note added eleven half-steps
  above the root, one half-step short of the octave. Calm and lush.
- **Minor seventh** — A minor chord with that same lower fourth note on top.
  Mellow and relaxed — the everyday chord of jazz and soul.

The chord guide shows all seven with their descriptions and how each looks
written on C, so they can be read cold rather than only learned by getting them
wrong.

## Scoring and persistence

Accuracy comes from `src/sam/lib/practiceScoring.js` rather than being computed
inline — `accuracyOf({ hits, misses, notesPlayed })` and `formatAccuracy`. The
mapping is `hits: correct`, `misses: asked - correct`, `notesPlayed: asked`;
`notesPlayed` is SAM's guard for "did anything arrive to be scored", which here
is whether a tile has been pressed at all. That inherits SAM's rule that
accuracy is `null`, never zero, when nothing has been measured, and it displays
as "—".

`bestAccuracy` is **not used**. Its contract is "best of a list of accuracies,
ignoring nulls", and this screen holds exactly one accuracy at a time and keeps
no history of accuracies to pick a best from. The only ways to give it an input
would be to invent a history — which contradicts session accuracy being
in-memory only — or to take a high-water mark of the running average, which
would read 100% forever for anyone whose first answer was right. Left unused
rather than shoe-horned in; see the open question at the end of the progress
file.

Persistence through `src/games/gameStorage.js`, keyed to `"sight-reader"`:

- **Session accuracy** — correct, asked, streak. In memory only, resets on
  reload.
- **Miss tally per prompt label** — persisted, so the difficulty weighting keeps
  improving across sessions. This is also what the missed list displays, so the
  list on screen and the weighting behind it can never disagree.
- **Reset** clears both, and removes the stored key.

Stored shape is versioned: `{ version: 1, missTally: { "C6": 3 } }`. A save
whose version does not match is discarded and the weighting starts cold, so a
future shape change cannot crash on old data. The envelope is validated whole;
individual tally entries are sanitised rather than rejected wholesale, because
one corrupt count should cost one label's weighting and not months of
accumulated misses.

Every read and write degrades rather than throws — a full disk, private
browsing, a cleared cache or corrupt JSON all leave a working game with cold
weighting. An empty tally is stored as the *absence* of a save rather than as an
empty object, so Reset genuinely removes the key instead of leaving a husk that
means the same thing.

This is device-local. Accuracy will not follow between the desktop, the Surface
Go and the Chromebook. Accepted for v1; a table is the eventual answer if this
becomes something to track over time.

## Styling

Tailwind utility classes with SAM's existing semantic colour names — `bg-card`,
`border-border`, `text-foreground`, `text-muted-foreground`, `text-success`,
`text-destructive`. No raw hex values. There is no shared Button component in
SAM; write the answer tile locally rather than refactoring existing screens.

House conventions to follow: `type="button"` always, `min-h-[44px]` on every
touch target, and the page heading idiom
`<h2 className="text-lg sm:text-xl font-medium mb-3 sm:mb-4">` — though the
screen itself renders no `<h2>`, because `GamesPage` already renders the
variant's name as exactly that heading above an open variant, and a second one
would print "Sight Reader" twice. Sub-sections use a subordinate `<h3>`.

`SegmentedControl.jsx` exists but deliberately omits the 44px minimum because it
is built for a dense toolbar. It is fine for the two small toggle groups and
wrong for the large answer tiles.

## Testing

VexFlow is a CDN global and is therefore `undefined` under Jest. Every existing
test covers pure helpers only.

- `music.js` is pure and **must** have tests: chord spelling (D major gives F#,
  not Gb; Eb minor spells correctly), MIDI and name agreement, distractors always
  containing the correct answer and never duplicating, and pitch pools staying
  inside their declared ranges.
- The renderer and the screen are verified by hand in the browser. Do not add
  VexFlow as a dev dependency or stub `window.Vex` to test rendering — that is
  new infrastructure and out of scope.

## Success criteria

1. "Sight Reader" appears in the Games tab and opens.
2. A single note on a single stave with a clef, sitting just after the clef, no
   time signature, no second stave.
3. Sharps and flats sit against their noteheads, not out by the clef.
4. Both clefs work; ledger-line notes appear noticeably more often than notes on
   the staff.
5. All three modes work: notes, chords, mix.
6. Chords spell correctly — check D major, Bb7, F#dim by eye against the guide.
7. A wrong chord shows an explanation naming the difference from what was
   picked, and waits for a press before moving on.
8. Accuracy, tally and streak update correctly; the missed list fills in.
9. Reloading clears session accuracy but keeps the miss weighting.
10. Reset clears both, and the weighting is still cold after a reload.
11. Storage being unavailable leaves a working game with cold weighting, never a
    blank screen.
12. Usable one-handed on a phone; every tap target at least 44px. The stave and
    the four tiles are on screen together without scrolling.
13. Existing games and practice screens are untouched and still work.
