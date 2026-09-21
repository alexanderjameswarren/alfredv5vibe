// The seven chord types Sight Reader drills, and how to explain each one to
// somebody who does not know what a third or a fifth is.
//
// ONE TABLE, not two. The spec lists the intervals under the music-logic
// section and the descriptions under this file, but splitting them would mean
// two places that have to agree about which seven types exist — and the first
// time a type was added to one and not the other, `chordName` would produce a
// label the guide could not explain. So the whole record for a chord type lives
// here and `music.js` imports it. This file is the vocabulary; music.js is what
// you do with it.
//
// `suffix` deliberately matches the spellings the MusicXML importer already
// uses (`KIND_TEXT_TO_SUFFIX`, src/sam/lib/songParser.js:100-107) — "m", "dim",
// "aug", "7", "maj7", "m7". The importer reads chord symbols out of XML and
// cannot be called with pitches, so there is nothing to share in code, but a
// chord named "Dm7" here and "Dm7" there is worth having for free.
//
// `intervals` are half-steps above the root, and their COUNT is the number of
// notes in the chord. `music.js` stacks them at letter distances 0, 2, 4, 6 —
// root, third, fifth, seventh — so a four-interval type is a seventh chord and
// a three-interval type is a triad. Adding a type with a different shape (a
// sixth, a ninth) would need that stacking rule revisited, not just a row here.

export const CHORD_TYPES = [
  {
    id: "major",
    name: "Major",
    suffix: "",
    intervals: [0, 4, 7],
    description:
      "The plain, settled-sounding chord. Three notes: the root, the note four half-steps above it, and the note seven half-steps above it.",
  },
  {
    id: "minor",
    name: "Minor",
    suffix: "m",
    intervals: [0, 3, 7],
    description:
      "The same as major, except the middle note sits one half-step lower. That single change is what makes it sound sad rather than bright.",
  },
  {
    id: "diminished",
    name: "Diminished",
    suffix: "dim",
    intervals: [0, 3, 6],
    description:
      "Minor, with the top note also pulled down a half-step. Both upper notes are squeezed inward, so it sounds tense and unfinished.",
  },
  {
    id: "augmented",
    name: "Augmented",
    suffix: "aug",
    intervals: [0, 4, 8],
    description:
      "Major, with the top note pushed up a half-step instead. Stretched outward, so it sounds unsettled and floating.",
  },
  {
    id: "dominant7",
    name: "Dominant seventh",
    suffix: "7",
    intervals: [0, 4, 7, 10],
    description:
      "A major chord with a fourth note added on top, ten half-steps above the root. It sounds like it wants to move somewhere — the usual chord just before you land home.",
  },
  {
    id: "major7",
    name: "Major seventh",
    suffix: "maj7",
    intervals: [0, 4, 7, 11],
    description:
      "A major chord with a fourth note added eleven half-steps above the root, one half-step short of the octave. Calm and lush.",
  },
  {
    id: "minor7",
    name: "Minor seventh",
    suffix: "m7",
    intervals: [0, 3, 7, 10],
    description:
      "A minor chord with that same lower fourth note on top. Mellow and relaxed — the everyday chord of jazz and soul.",
  },
];

// Lookup by id, built once. Reaching for a type by id is what every caller
// does; nobody scans the array.
const BY_ID = new Map(CHORD_TYPES.map((t) => [t.id, t]));

/**
 * The chord type with this id.
 *
 * Throws rather than returning undefined: every caller here is passing an id it
 * got from this module in the first place, so an unknown one is a typo in the
 * code rather than bad user input, and a thrown name is far easier to chase
 * than an `undefined.intervals` three frames later.
 *
 * @param {string} id
 * @returns {{id: string, name: string, suffix: string, intervals: number[], description: string}}
 */
export function chordTypeOf(id) {
  const type = BY_ID.get(id);
  if (!type) throw new Error(`Unknown chord type: ${id}`);
  return type;
}

/** Every chord type id, in guide order. */
export const CHORD_TYPE_IDS = CHORD_TYPES.map((t) => t.id);
