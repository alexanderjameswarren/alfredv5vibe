# Progress: Sight Reader

## Status: Step 5 (Focus mode) built — awaiting verification

Spec: `docs/technical-spec-sight-reader.md`

No database work in this feature. No migration, no new table, no MCP tool, no
platform conformance step.

### Development Steps

- [x] Step 1: Music logic — `src/games/sightReader/music.js` and
      `src/games/sightReader/chordTypes.js`. Pure, no React, no VexFlow: pitch
      model, chord spelling, chord naming, pitch pools, difficulty weighting,
      distractor generation, chord descriptions. Plus Jest tests for the
      spelling and distractor rules.
      *(68 tests in `src/games/sightReader/music.test.js`; full suite 1336
      passing, no regressions.)*
- [x] Step 2: Renderer, plus enough screen to open it. Amended 2026-09-21: a
      renderer with no screen leaves nothing to verify, so registration moved
      forward from Step 4 and this step now ends with something reachable from
      the Games tab. `src/games/sightReader/BareStave.jsx` — one stave, one
      clef, one note or chord, accidentals on the notehead, no x-shift after
      layout. `src/games/variants/sightReader.jsx` — a scaffold screen: the
      stave, the answer as plain text, a Next button, and a temporary mode
      control. Entry in `src/games/variants.js`.
      *(Also carries Amendment 1: the distractor rule. Full suite 1340 passing;
      production build compiles clean.)*
- [x] Step 3: The real screen — `src/games/variants/sightReader.jsx` rewritten.
      Notes/Chords/Mix and Treble/Bass/Both toggles via `SegmentedControl`, four
      answer tiles, right/wrong feedback, chord explanation panel, chord guide,
      keyboard 1–4. Everything marked TEMPORARY in the scaffold is gone — the
      mode forcer, Double ♯♭ and Edges all removed.
      *(No new music logic; `music.js` untouched. Full suite 1340 passing;
      production build compiles clean.)*
- [x] Step 4: Scoring and persistence — session accuracy via
      `src/sam/lib/practiceScoring.js`, miss tally persisted through
      `src/games/gameStorage.js`, reset button. (Registration moved to Step 2.)
      Plus the finishing pass: spec brought in line with what was built.
      *(`bestAccuracy` deliberately unused — see the open question at the end.
      Full suite 1340 passing; production build compiles clean.)*

- [x] Step 5 (2026-09-25): Focus mode — a fourth drill mode asking only about a
      hand-picked list. New `src/games/sightReader/focusList.js` (the list, with
      a header comment written to be read cold) and
      `src/games/sightReader/focusList.test.js`. Focus logic appended to
      `music.js`: `focusEntryError`, `validFocusEntries`, `focusLabel`,
      `makeFocusPrompt`, and a `"focus"` branch in `makePrompt`. The screen
      gained the fourth button, Focus as its default, and a greyed clef group
      while Focus is active. `SegmentedControl` gained two optional disabled
      props.
      *(21 new tests; full suite 1776 passing, no regressions.)*

### Verification Gates

Each step is verified before the next begins.

- [x] Step 1 verified — tests pass; chord spellings checked by eye
- [x] Step 2 verified — Sight Reader opens from the Games tab; a stave draws
      with its clef and no time signature, accidentals sit against their
      noteheads, and the five double-accidental chords are legible.
      *First pass 2026-09-21 found low bass notes clipped (C2); geometry
      rewritten — see the C2 clipping fix below. Re-verified 2026-09-21: edges
      clean, nothing jumps when the clef changes.*
- [x] Step 3 verified — the game is playable on the phone; each toggle pair
      draws the right kind of prompt, right and wrong answers differ, a wrong
      chord waits for a press, the missed list fills, the guide reads correctly
- [ ] Step 4 verified — a reload clears session accuracy and keeps the
      weighting; Reset clears both for good; the game still runs with storage
      unavailable
      *(awaiting Alex)*
- [ ] Step 5 verified — Focus is the mode on load, the questions are only the
      twelve, the wrong answers are not, the clef group is greyed while Focus is
      active, and Notes / Chords / Mix still behave as before
      *(awaiting Alex)*

### Notes

### Step 1 — decisions the spec did not cover

These were judgement calls. None contradicts the spec; each is reversible.

**1. `chordTypes.js` owns the whole chord-type record, not just the prose.**
The spec lists intervals and suffixes under the music-logic section and
descriptions under `chordTypes.js`. Splitting them would have meant two places
that must agree about which seven types exist — and the first time one gained a
type the other lacked, `chordName` would emit a label the guide could not
explain. So `CHORD_TYPES` carries `{id, name, suffix, intervals, description}`
and `music.js` imports it. Both files exist as specified; the split is by *what
a chord type is* versus *what you do with it*.

**2. An injectable `rng`, defaulting to `Math.random`.**
Every function that picks or shuffles takes `rng` as an argument. The existing
tile-merge variants call `Math.random()` inline (`drop.jsx:266`), which is fine
for a board only ever checked by eye, but the spelling and distractor rules have
to be provable. A seeded generator in the test file is what turns "the octave
twin shows up about 60% of the time" into a test. Callers that pass nothing get
`Math.random`, so the screen code is unaffected.

**3. Generated single notes are spelled with sharps.**
The pool is chromatic, so accidentals come up — but MIDI 61 is both C#4 and Db4
and the spec does not say which. Sharps, matching `midiDisplayName` in
`src/sam/lib/vexflowHelpers.js`, which is SAM's existing answer to the same
question. Chords are unaffected: their spelling comes from the letter-stacking
rule, which is why `Ebm` correctly gives `Gb` and not `F#`.

**4. Chord placement octave is chosen by staff centre, not fixed.**
The spec gives pitch ranges for single notes but not for chords. Each chord is
built at whichever of two candidate root octaves puts its midpoint closest to
the staff's middle line (B4 treble, D3 bass), so a low-rooted triad does not
sink off the bottom and a high-rooted seventh does not climb five ledger lines
off the top. Deterministic, so the same chord always looks the same and its
shape can be learned. Candidates are octaves 3–4 for treble and 2–3 for bass.

**5. Chords are weighted by miss tally only, not by ledger distance.**
The weighting section of the spec is written about pitches. A chord is placed
where it fits the staff, so there is no "harder position" to weight for — but
`1 + 2 × misses` still applies to the chord label, which is the half that
matters here.

**6. `parseChordLabel` and `describeChordDifference` landed in Step 1.**
Both are pure music logic with no React, and the spec specifies the three-branch
difference rule precisely (different root → different note count → first
differing notehead). Putting them here leaves Step 3 as rendering only. Trivially
movable if you would rather they sat with the screen.

### Step 1 — observations worth a decision later

Neither blocks anything. Flagging rather than acting.

**Five chords carry a double accidental.** All are correct spellings, and all
arise on augmented or diminished chords with an altered root:
`Baug → F##`, `F#aug → C##`, `C#aug → G##`, `Ebdim → Bbb`, `Abdim → Ebb`.
`C#maj7` spells `C# E# G# B#` and `Abm7` spells `Ab Cb Eb Gb` for the same
reason. These are right, but they are unusual to read, and Step 2 will need to
confirm VexFlow 4.2.2 draws `##` and `bb` accidentals from a key string such as
`f##/5`. If they prove ugly on the stave, the cheapest fix is dropping augmented
and diminished from the accidental roots — a data change in `ROOTS`, not a rule
change.

**A single sharp answer can be a giveaway.** ~~The spec's note-distractor rule
gives neighbours spelled natural at their staff position…~~ **Closed by
Amendment 1 during Step 2.** See below.

### Step 2 — amendments applied

**Amendment 1: the distractor rule.** The note rule now has two branches. When
the answer carries an accidental, one wrong answer is the same letter and octave
spelled natural (F#4 puts F4 on screen), and at least one other wrong answer
also carries an accidental. When the answer is a plain natural, about half the
time one wrong answer carries an accidental anyway — otherwise the tell simply
inverts. Leftover slots are filled as before: octave twin at ~60%, then staff
neighbours. `noteDistractors` in `music.js` rewritten; four tests added covering
both branches; the distractor section of the technical spec rewritten to match,
so spec and code agree.

Both required takes are provably satisfiable for the declared pools — every
accidental in either pool has its natural twin and at least one octave twin in
the same pool — and the tests assert it for every pitch in both clefs, so a
later range change that quietly reopened the tell would fail the suite.

**Amendment 2: the step split.** Registration moved from Step 4 to Step 2 so
this step ends with something openable. Step 3 is now the real screen, Step 4 is
scoring and persistence only. Step list above updated.

### Step 2 — decisions the spec did not cover

**7. Stave geometry is fixed pixels behind a viewBox, not measured.**
~~The vertical room is set for the worst case in the pools — two ledger lines
above and below…~~ **Wrong, and it clipped C2. Superseded by decision 13.**

**8. Format width 44 against a 168-wide stave.**
This is what puts the note just after the clef with a small gap, per the spec's
warning: the note is never x-shifted after layout, because an accidental
modifier does not travel with an x-shift and would end up floating out by the
clef where it reads as a key signature. The number was chosen by reasoning from
`getFormatWidth` in `vexflowHelpers.js` (which subtracts ~100 for a clef and a
time signature) and has NOT been checked by eye — it is the most likely thing in
Step 2 to need a nudge.

**9. The voice is non-strict.**
`voice.setStrict(false)` so the tick count need not fill a bar. There is no bar
here — there is no time signature for it to be measured against.

**10. A readable fallback when VexFlow is absent.**
The CDN script can fail (offline, blocked, CDN down). `BareStave` renders a
one-line message rather than throwing, so the answer text and the Next button
below it still work. It does not retry: VexFlow is a synchronous script tag, so
it is either present at first render or it is not, and the message says to
reload.

**11. The scaffold screen prints the spelled notes, and has a fourth mode.**
Beyond the stave, the answer and Next, the scaffold shows the notes spelled out
(`B4 · D#5 · F##5`) and offers a "Double ♯♭" mode that steps through the five
chords needing a double accidental, alternating clef. Both exist only to make
Step 2 verifiable: without the spelling there is no way to tell an F## from a G
by eye, and the five chords are 5 of 84 so reaching them at random would take a
hundred presses. Both are marked TEMPORARY and go in Step 3. The mode builds its
prompt from the same `chordNotes` / `chordName` / `chordRootOctave` the real
generator uses, so what is drawn is what the game would draw.

**12. Sight Reader is registered as a plain variant, in build order.**
Appended to `VARIANTS` with `status: "current"`, following the registry's own
instruction to keep entries in the order they were built. It is not a tile-merge
variant and the registry does not care — which is the property that made this
the cheap place to put it.

### Step 2 — the C2 clipping fix (supersedes decision 7)

Verification found low bass notes clipped: C2 drew with the bottom half of its
notehead cut off. The cause was the viewBox, not the card — the card has no
fixed height and nothing in the tree sets `overflow: hidden`, so the note was
being cut by the SVG's own frame rather than by its container. Decision 7 had
guessed "about two ledger lines either side" and put the stave high in the
window: with `STAVE_Y` 58 the top line landed at 98 and the bottom line at 138,
leaving 98px of dead space above and only 20px below. C2 sits 20px below the
bottom line, so its notehead centre was exactly on the edge.

**13. The window is derived from the pools and the stave is centred in it.**

`deriveOvershootSteps()` in `BareStave.jsx` walks everything the renderer can be
asked to draw — every pitch in both pools **and** all eighty-four chords in both
clefs — and measures the furthest any of them reaches past the five lines, in
diatonic steps. It runs once at module load and is pure. Widening a pool in
`music.js` moves the window on its own; nobody has to remember.

What it currently yields:

| | reaches above the top line | reaches below the bottom line |
|---|---|---|
| Treble pool | 4 steps (C6) | 3 steps (B3) |
| Bass pool | 3 steps (D4) | **4 steps (C2)** |
| Chords, either clef | 2 steps | 2 steps |
| **Worst case** | **4** | **4** |

Chords were never the problem and never close to it. The pools are the binding
constraint, and the two clefs are mirror images of each other.

**One symmetric value across both clefs**, not one per clef and not separate
above/below figures. Taking the single worst case costs a few pixels and buys
the thing that matters: identical geometry for treble and bass, so the stave
does not jump when the clef changes between prompts — which in a drill that
alternates clef constantly would be more distracting than the wasted pixels.
Equal space above and below is also what makes "centred" true by construction.

**Measured from the stave, not from VexFlow's constants.** The stave is drawn at
`y = 0` and the viewBox is framed afterwards around `stave.getYForLine(0)` and
`getYForLine(4)`. VexFlow reserves blank space above the five lines
(`space_above_staff_ln`), so the y handed to `new VF.Stave()` is not where the
top line lands — and rather than hardcode that offset, the frame reads the real
positions back. Pixels-per-step falls out of the same measurement: the staff
spans eight diatonic steps from bottom line to top line, so `stepPx` is the line
span over eight rather than an assumed 10px line spacing. Nothing in the
geometry now depends on a VexFlow default staying put.

The one number that is still a constant is `GLYPH_MARGIN_PX` (16), the allowance
for a notehead's own height plus an accidental's ascender and descender. That is
a property of the glyphs, not of the pitch pools, so deriving it would be
false precision.

Net effect: 36px above the top line and 36px below the bottom line, against the
26px that C2 and C6 actually need. The card is also shorter than before, because
the 98px of dead space above the stave is gone.

**14. A boundary-pitch control on the scaffold (temporary).** *Removed in Step 3
along with the rest of the scaffold.*
An "Edges" mode stepping through the four pool extremes — the lowest and highest
note in each clef. The four are read off `CLEF_RANGES` rather than typed out, so
they follow a pool change too. Ordered to alternate clef on every press (treble
low, bass low, treble high, bass high), which is what makes the "does the stave
jump when the clef changes" check a matter of holding Next down and watching the
lines rather than a matter of trust. Goes in Step 3 with the rest of the
scaffold.


### Step 3 — decisions the spec did not cover

**15. The phone fold: the missed list and the chord guide go below it.**
Asked for explicitly, so here is the honest arithmetic rather than a silent
shrink. On the smallest phone in regular use (375×667), the sticky app header
takes 68px and the Games tab's back-button-and-title row another ~92px, leaving
roughly 507px of visible content at scroll top. The layout costs about:

| | height |
|---|---|
| Two toggle groups | ~52px |
| Stave card | ~260px |
| Four tiles (2 rows of 64 + gap) | ~152px |
| Scoreboard (one line) | ~40px |

Toggles, stave and tiles come to ~464px and always fit together, which is the
requirement — reading the note and answering it never needs a scroll. The
scoreboard lands right at the fold on a 667-tall phone and comfortably above it
on anything taller. **The missed list and the chord guide are below the fold on
a phone, deliberately**: the guide is reference material rather than part of the
loop, and the missed list is something to review between rounds, not while
answering. Neither is shrunk; both are simply further down.

Two things were done to buy that fit rather than shrinking anything: the
scoreboard is a single line in StatsBar's wording (`Accuracy 83% · Correct 5/6 ·
Streak 3`) instead of a block of figures, and the missed list is wrapping chips
rather than six rows, so six entries cost one or two lines.

**16. The stave is capped at 360px wide, which never bites on a phone.**
A phone's content column is at most ~342px inside the card, so the cap is
inactive on every handset — the stave is exactly as large as it was in Step 2.
It exists for tablet and desktop, where the SVG would otherwise scale to the
app's full 896px column and stand ~580px tall for a single notehead.

**17. No `<h2>` for the screen title.**
The house heading idiom is `<h2 className="text-lg sm:text-xl font-medium mb-3
sm:mb-4">`, but `GamesPage` already renders the variant's name as exactly that
`<h2>` in the header above an open variant, so a second one would print "Sight
Reader" twice. The idiom is followed where a heading is actually warranted — the
"Most missed" sub-section uses a subordinate `<h3 className="text-sm
font-medium">` so it does not compete with the title the tab supplies.

**18. Accuracy is computed locally, to the rule `practiceScoring` uses.**
`practiceScoring.js` is deliberately not imported yet (Step 4). The local
computation is `asked === 0 ? null : Math.round((correct * 100) / asked)`,
displayed as "—" when null — which is `accuracyOf` and `formatAccuracy`'s
behaviour exactly, including multiplying by 100 before dividing so it rounds the
way Postgres does. Step 4 substitutes
`accuracyOf({ hits: correct, misses: asked - correct, notesPlayed: asked })`
with no visible change.

**19. Timers are held in a ref and the redraw is read through another.**
A pending advance is cleared on unmount, and cleared again whenever a toggle
redraws, so a timer armed before a toggle change cannot fire a prompt for the
old settings. The timer calls `drawNextRef.current()` rather than a captured
`drawNext`, and that ref is reassigned every render — the same "always fresh"
idiom as `ScoreRenderer`'s `lyricEditRef` — so a 1500ms advance draws with the
toggles and the miss tally as they stand when it fires.

**20. The in-session miss tally feeds the weighting immediately.**
`missTally` is passed into `makePrompt` on every draw, so a note or chord you
keep missing is asked more often within the session. That is `music.js`'s
weighting doing the work; the screen only keeps the count. Making it survive a
reload is Step 4.

**21. Keyboard 1–4 is one window listener, and ignores modified presses.**
Attached once for the life of the component and reading the current prompt
through a ref, rather than re-bound on every prompt. `Cmd`/`Ctrl`/`Alt`
combinations are left alone, since `Cmd-1` switches browser tabs and is not the
game's to take. The shortcut number is shown in the corner of each tile only at
`sm` and above, where there is a keyboard to use it.

**22. The correct tile is outlined, never filled, when you got it wrong.**
Filled success means "you found it"; outlined success (`ring-2 ring-success` on
a plain card) means "this was the answer". Keeping those visually distinct
matters because both appear at the same moment on a wrong answer. A ring rather
than a thicker border, so nothing shifts by a pixel when the state changes.

### Step 4 — decisions the spec did not cover

**23. The missed list shows the PERSISTED tally, not the session's.**
Asked for a call, and this is it — the same way you leaned. Two reasons. It is
the list the weighting acts on, so showing anything else would put a list on
screen that disagrees with which prompts keep coming back, and "what am I
actually bad at" is the question worth answering anyway. It is also the simpler
build: the in-memory tally is seeded from disk and accumulates, so there is one
tally rather than two that could drift.

The cost is that accuracy and the missed list now span different things, four
lines apart. So both name their scope on screen — "This session" on the
scoreboard, "all time" on the missed list. `PracticeFigures.jsx` is the reason
that mattered enough to spend words on: SAM once showed "Today:" beside
"Total:" where one meant every song and the other meant this song, and neither
figure could be read.

**24. An empty tally is stored as no save at all.**
The save effect calls `clearSave` when the tally is empty rather than writing
`{version: 1, missTally: {}}`. One rule — the stored tally mirrors the
in-memory one, and nothing is how you store nothing — and it makes Reset
genuinely remove the key rather than leave a husk that means the same thing.

**25. Entries are sanitised; the envelope is rejected whole.**
`gameStorage`'s own doctrine is that a half-trusted BOARD is worse than no
board, because a half-drawn position is unplayable. A tally is not like that. A
save whose version or shape is wrong is discarded entirely, but within a valid
save a single corrupt count is dropped on its own — losing one label's weighting
rather than months of accumulated misses.

**26. Saved from one effect, not from each mutator.**
`useEffect` on `missTally`, following the reasoning `drop.jsx` gives for its own
save effect: one place cannot fall out of step with the mutators, and a future
way of changing the tally is persisted without anyone remembering to add a call.

**27. Reset asks twice.**
It throws away every miss ever recorded, which is not recoverable. The first tap
arms it and the button reads "Tap again to clear everything" for four seconds. A
second tap rather than a `window.confirm`, because this is a phone and a modal
for a practice game is heavier than the thing it guards. It also sits below the
chord guide, out of reach of a thumb working the tiles.

**28. Reset draws its next prompt with no tally at all.**
Rather than with the tally it is about to discard, so the very next question is
already unweighted.

### Step 5 — decisions the spec did not cover

**29. Only the question narrows; the tiles stay wide.**
Asked for explicitly, and it is the decision the whole mode rests on. Focus
prompts call the same `noteDistractors` and `chordDistractors` as every other
mode, so a twelve-entry list still puts wrong answers from the full pool on
screen. A short list feeding the tiles would train four memorised positions
instead of the staff.

**30. Weighting inside the list is by misses only.**
`1 + 2 × (times missed)`, and NOT the ledger-distance factor `pitchWeight`
applies. Two reasons. The list is already the hand-picked selection that the
ledger factor exists to make for you, so applying it again re-ranks a deliberate
choice. And it ranks across kinds: a note four steps off the staff scores 9.8
where every chord scores 1, so the chords in a mixed list would all but vanish.
This is the reading of "the existing miss weighting still applies within the
list" — the miss factor, not the whole weight function.

**31. The list validates in `music.js`, not in the screen.**
`focusEntryError` returns a SENTENCE rather than a boolean, because both callers
want to say what is wrong: the test names the bad entry, and the screen logs it.
The screen never learns what a note name or a chord quality looks like.

**32. A bad entry is dropped at runtime and fatal in the suite.**
A typo should not take the screen down mid-practice, so `validFocusEntries`
filters and `console.error`s the reason. That alone would be "fails silently at
runtime", which is exactly what was ruled out — so `focusList.test.js` checks
every entry against the clef and pool rules, and a typo fails the suite.

**33. Note names in the list must be spelled with sharps.**
Validation checks membership of the clef's pool by NAME, not by pitch, and the
pools are sharp-spelled. So "Gb3" is rejected even though that pitch is in
range. Chord ROOTS still use flats (Bb, Eb, Ab), because that is how the game
already names them and how a player meets them. Both are stated in the focus
list's header comment, and both have a test.

**34. `SegmentedControl` gained two optional disabled props.**
`disabled` greys a group; a fourth element on an option tuple greys one option.
Focus needs both — its own button while the list is empty, and the clef group
while it is active. The alternative was a local copy of the control inside the
game, which would have meant two versions of the same toolbar styling drifting
apart. Both props default to off, so `NumericSettings.jsx`, the only other
caller, renders identically. **This breaks the Step 4 claim that nothing under
`src/sam/` was modified**, and it is the only such edit: additive, and the full
suite is unchanged at 1776 passing.

**35. Focus ignores the clef toggle, and the toggle says so.**
Greyed rather than hidden. A control that vanishes and comes back as the mode
changes is harder to read than one that is visibly out of play, and the clef
group is where the eye goes to ask "which clef am I being shown".

**36. An empty focus list falls back to Mix in two places.**
The screen never selects Focus without entries, and `makePrompt` treats
`mode: "focus"` with an empty list as Mix anyway. The second is redundant by
construction — and a prompt that cannot be drawn is a blank screen, which is too
expensive a thing to leave resting on one caller getting it right.

### Step 4 — a finding: `bestAccuracy` has no input here

The spec asked for `accuracyOf`, `bestAccuracy` and `formatAccuracy`. Two of the
three are wired. **`bestAccuracy` is not, and I do not think it should be.**

Its signature is `bestAccuracy(values)` — "best of a list of accuracies, ignoring
nulls". Sight Reader holds exactly one accuracy at a time and keeps no history of
accuracies to pick a best from. The two ways to give it an input are both bad:

- **Invent a history of session accuracies.** That contradicts the rule two
  paragraphs above it in the same spec — session accuracy is in-memory only and
  resets on reload — and it would need somewhere to live.
- **Take a high-water mark of the running average.** After one correct answer
  accuracy is 100%, so "best" would read 100% forever for anyone whose first
  answer was right. A statistic that is almost always 100% is not a statistic.

Calling it on a one-element array purely to have called it would be worse than
not calling it, because it would imply a history on screen that does not exist.

**If you want it used, it needs a feature to be useful on.** The two that would
earn it: a best-accuracy-per-clef or per-mode breakdown (`bestAccuracy([treble,
bass])`), or a persisted per-sitting history so "best session so far" means
something. Both are additions rather than wiring, so they are yours to call.

### The build is complete

Four steps, two amendments, one clipping bug found in verification and fixed —
plus Step 5, Focus mode, added 2026-09-25.

| File | Lines | What it is |
|---|---|---|
| `src/games/sightReader/music.js` | 684 | All the music logic. Pure |
| `src/games/sightReader/chordTypes.js` | 105 | The seven chord types |
| `src/games/sightReader/music.test.js` | 777 | 72 tests |
| `src/games/sightReader/BareStave.jsx` | 225 | One stave, one clef, one note or chord |
| `src/games/variants/sightReader.jsx` | 561 | The screen |
| `src/games/variants.js` | +8 | One import, one registry entry |
| `src/games/sightReader/focusList.js` | 90 | Step 5: the focus list, and how to edit it |
| `src/games/sightReader/focusList.test.js` | 205 | Step 5: 21 tests |
| `src/sam/components/SegmentedControl.jsx` | +14 | Step 5: two optional disabled props |

One file under `src/sam/` was modified, in Step 5: `SegmentedControl.jsx` gained
two optional disabled props (decision 34). `practiceScoring.js` and
`vexflowHelpers.js` are imported and untouched, and `ScoreRenderer.jsx`,
`scoreRender.js` and `ScrollEngine.jsx` were never opened for writing.
`gameStorage.js` is used as-is. No database work: no migration, no table, no MCP
tool, no platform conformance step.

Console output during normal play: none. The single `console.error` fires only
when a write to storage fails.
