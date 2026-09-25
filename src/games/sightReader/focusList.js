// THE FOCUS LIST — the hand-picked notes and chords Sight Reader's Focus mode
// asks about. Alex rewrites this file from time to time to match whatever he is
// currently learning in SAM, so it is written to be read cold: everything you
// need to edit it correctly is in this comment.
//
// WHAT THIS ARRAY IS FOR
//
// Sight Reader has four modes: Notes, Chords, Mix and Focus. The first three
// ask about everything the game knows — every pitch in a clef's pool, all
// eighty-four chords. Focus asks ONLY about the entries below. It is the mode
// for "these twelve things are what I am working on this month".
//
// Editing this array is the whole interface. Nothing else needs changing: the
// Focus button appears when the array has entries and is greyed out when it is
// empty, and the game falls back to Mix.
//
// Only the QUESTION narrows. The four answer tiles still draw their wrong
// answers from the full pool of pitches and chords, so a short list here does
// not turn into four memorised tile positions.
//
// THE TWO KINDS OF ENTRY
//
// A NOTE — one pitch on one stave:
//
//   { kind: "note", clef: "treble", name: "F5" }
//
//   `name` is a pitch with its octave, spelled the way the game spells it:
//   a letter A-G, an optional "#", then the octave number. C4 is middle C.
//   ACCIDENTALS ARE SHARPS, never flats — write "F#3", not "Gb3". The game's
//   pitch pools are spelled with sharps, and a flat name is rejected as not
//   being in the pool even when the pitch itself is in range.
//
// A CHORD — one chord, placed automatically wherever it sits best on that
// stave:
//
//   { kind: "chord", clef: "bass", root: "Bb", quality: "minor7" }
//
//   `root` is one of the twelve the game uses: C, D, E, F, G, A, B, F#, C#,
//   Bb, Eb, Ab. Chord roots, unlike note names, DO use flats — that is how a
//   player meets them. `quality` is one of the seven ids in ./chordTypes.js:
//   "major", "minor", "diminished", "augmented", "dominant7", "major7",
//   "minor7". Chords carry no octave: the game places each one on the stave
//   for you.
//
// CLEF IS REQUIRED ON EVERY ENTRY, both kinds. Focus mode ignores the Treble /
// Bass / Both toggle entirely — the toggle is greyed out while Focus is active
// — because a list that names its own clef per entry is the point. The only
// two values are "treble" and "bass".
//
// WHICH PITCHES ARE VALID
//
// Each clef has its own range, and a note must fall inside the range of the
// clef it is listed under (CLEF_RANGES in ./music.js is the source of truth;
// these are those values):
//
//   treble: B3 up to C6
//   bass:   C2 up to D4
//
// THE SAME PITCH MAY LEGITIMATELY APPEAR UNDER BOTH CLEFS. C4 below is listed
// twice on purpose. It sits one ledger line BELOW the treble stave and one
// ledger line ABOVE the bass stave, so it is two different reading problems
// that happen to sound the same, and drilling one does not drill the other.
//
// A TYPO HERE FAILS THE TEST SUITE, not the game: ./focusList.test.js checks
// every entry against the rules above. If the game ever meets a bad entry at
// runtime it drops that one entry and carries on rather than taking the screen
// down — so run the tests after editing, and do not rely on noticing a missing
// question.

export const FOCUS_LIST = [
  // The treble edges: the bottom line (E4) and the two positions below it, then
  // the top line (F5) and the two above it.
  { kind: "note", clef: "treble", name: "C4" },
  { kind: "note", clef: "treble", name: "D4" },
  { kind: "note", clef: "treble", name: "E4" },
  { kind: "note", clef: "treble", name: "F5" },
  { kind: "note", clef: "treble", name: "G5" },
  { kind: "note", clef: "treble", name: "A5" },

  // The same three problems at each end of the bass stave: G2 is its bottom
  // line, A3 its top.
  { kind: "note", clef: "bass", name: "E2" },
  { kind: "note", clef: "bass", name: "F2" },
  { kind: "note", clef: "bass", name: "G2" },
  { kind: "note", clef: "bass", name: "A3" },
  { kind: "note", clef: "bass", name: "B3" },
  // Deliberately the same pitch as the treble C4 above — one ledger line below
  // the treble stave, one above the bass stave.
  { kind: "note", clef: "bass", name: "C4" },
];
