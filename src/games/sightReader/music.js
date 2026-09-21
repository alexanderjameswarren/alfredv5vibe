// Sight Reader's music logic. Pure: no React, no VexFlow, no DOM, no storage.
//
// Everything here is a function of its arguments and an injectable `rng`, which
// is what lets the spelling rules and the distractor rules be tested without
// rendering anything. VexFlow is a CDN global (public/index.html:44) and is
// therefore `undefined` under Jest, so nothing in this file may reach for it —
// the renderer consumes what this module produces, never the other way round.
//
// THE NOTE SHAPE IS SAM'S, NOT A NEW ONE. A note is `{ midi, name }`, exactly
// as stored in `sam_song_measures` and validated by sam-drill-format.schema.json:
// `midi` is (octave + 1) * 12 + step + alter, `name` matches
// ^[A-G](##|bb|#|b)?-?[0-9]$, and the two must agree. Generated prompts are
// never persisted, but they follow the shape anyway — that is what makes the
// phase-2 "only notes from songs I'm learning" mode a second source feeding the
// same renderer rather than a rewrite. `noteAccidental` and `toVexKeys` in
// src/sam/lib/vexflowHelpers.js already consume this shape and are what the
// renderer will use.
//
// A chord is several notes in one event, again as SAM already represents it:
// `{ duration: "w", notes: [Note, Note, Note] }`.

import { CHORD_TYPES, CHORD_TYPE_IDS, chordTypeOf } from "./chordTypes";

// ---------------------------------------------------------------------------
// Letters, octaves and the diatonic line
// ---------------------------------------------------------------------------
//
// Two coordinate systems, and keeping them straight is most of the work here.
//
//   MIDI       — what a pitch SOUNDS like. C4 = 60. Enharmonics collide:
//                C#4 and Db4 are both 61.
//   DIATONIC    — where a notehead SITS on the staff, counted in letters:
//                letterIndex + 7 * octave. C4 = 28, C#4 = 28 as well, because
//                an accidental does not move the notehead. Db4 = 29, because a
//                D sits on the next position up.
//
// Staff distance, ledger lines and "one step away" are all diatonic questions.
// Intervals and weighting-by-pitch are MIDI questions. Mixing them up is how
// you end up with D major spelled D-Gb-A.

const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];

// Same table as songSchema.js's STEP_SEMITONES, deliberately — this is the
// MusicXML <step> to semitone mapping and there is only one correct version.
const LETTER_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const ALTER_TO_ACCIDENTAL = { "-2": "bb", "-1": "b", 0: "", 1: "#", 2: "##" };
const ACCIDENTAL_TO_ALTER = { bb: -2, b: -1, "": 0, "#": 1, "##": 2 };

// The schema's own regex, plus a capture per part.
const NOTE_NAME_RE = /^([A-G])(##|bb|#|b)?(-?\d)$/;

const mod = (n, m) => ((n % m) + m) % m;

/** Diatonic index — the staff position, ignoring accidentals. C4 -> 28. */
function diatonicIndex(letter, octave) {
  return LETTERS.indexOf(letter) + 7 * octave;
}

const letterAt = (dia) => LETTERS[mod(dia, 7)];
const octaveAt = (dia) => Math.floor(dia / 7);

/** MIDI number for a spelled pitch, by the schema's own formula. */
function midiOf(letter, alter, octave) {
  return (octave + 1) * 12 + LETTER_SEMITONES[letter] + alter;
}

/**
 * Build a note in SAM's shape from its spelling.
 *
 * `midi` is derived from `name`'s three parts rather than passed in, so the two
 * cannot disagree — the one invariant the schema enforces semantically
 * (songSchema.js) and the one thing a hand-written note table gets wrong.
 *
 * @returns {{midi: number, name: string}}
 */
export function makeNote(letter, alter, octave) {
  const accidental = ALTER_TO_ACCIDENTAL[String(alter)];
  if (accidental === undefined) {
    throw new Error(`Alteration ${alter} is outside double-flat..double-sharp`);
  }
  return {
    midi: midiOf(letter, alter, octave),
    name: `${letter}${accidental}${octave}`,
  };
}

/**
 * Split a note name into its parts, or null if it is not a note name.
 *
 * @param {string} name e.g. "F#3"
 * @returns {{letter: string, alter: number, octave: number}|null}
 */
export function parseNoteName(name) {
  const m = NOTE_NAME_RE.exec(String(name ?? ""));
  if (!m) return null;
  return {
    letter: m[1],
    alter: ACCIDENTAL_TO_ALTER[m[2] || ""],
    octave: parseInt(m[3], 10),
  };
}

/** Letter + accidental with the octave dropped: "F#3" -> "F#". */
export function pitchClassName(name) {
  const parsed = parseNoteName(name);
  if (!parsed) return String(name);
  return `${parsed.letter}${ALTER_TO_ACCIDENTAL[String(parsed.alter)]}`;
}

/** Staff position of a named note. */
export function diatonicOf(name) {
  const parsed = parseNoteName(name);
  if (!parsed) throw new Error(`Not a note name: ${name}`);
  return diatonicIndex(parsed.letter, parsed.octave);
}

// ---------------------------------------------------------------------------
// Chords: roots, spelling, naming
// ---------------------------------------------------------------------------

// Twelve roots. Enough to cover every pitch class once, spelled the way a
// player actually meets them — F# and C# rather than Gb and Db, Bb/Eb/Ab rather
// than A#/D#/G#. Twelve roots times seven qualities is eighty-four chords out
// of about fifteen lines of data, none of which can be mistyped the way
// eighty-four hand-written rows can.
export const ROOTS = ["C", "D", "E", "F", "G", "A", "B", "F#", "C#", "Bb", "Eb", "Ab"];

// A root is a note name with the octave left off — "Bb", not "Bb4".
const ROOT_NAME_RE = /^([A-G])(##|bb|#|b)?$/;

function parseRootName(rootName) {
  const m = ROOT_NAME_RE.exec(String(rootName ?? ""));
  if (!m) throw new Error(`Not a chord root: ${rootName}`);
  return { letter: m[1], alter: ACCIDENTAL_TO_ALTER[m[2] || ""] };
}

/**
 * The notes of a chord, correctly spelled, with the root at `rootOctave`.
 *
 * SPELLING IS THE WHOLE POINT. D major is D-F#-A and never D-Gb-A: both sound
 * identical, but only one of them is a chord rather than three unrelated
 * noteheads, and reading the difference is the skill being drilled. So the
 * letters are stacked FIRST and the accidentals computed afterwards to hit the
 * target pitch:
 *
 *   1. Chord tones sit at letter distances 0, 2, 4, 6 from the root letter —
 *      root, third, fifth, seventh. That fixes the notehead positions, and with
 *      them the octave of each tone: the diatonic index carries the octave
 *      wrap, so a chord on A4 puts its third on C5 without any special case.
 *   2. For each tone, `naturalGap` is the half-step distance from the root
 *      LETTER to that tone's letter with both natural.
 *   3. The accidental is whatever closes the difference between that natural
 *      gap and the interval the quality actually wants:
 *          alter = rootAlter + interval - naturalGap
 *
 * That last line is exact, not approximate. Because letter distances 0, 2, 4, 6
 * always span less than an octave, `naturalGap` is the true upward distance
 * from root letter to tone letter, so the resulting MIDI number is
 * `rootMidi + interval` by construction. The test suite asserts that for all
 * eighty-four chords rather than trusting this paragraph.
 *
 * The normalisation below exists because `naturalGap` is taken modulo 12 and a
 * wrapped value would push `alter` out of the double-flat..double-sharp range.
 * For these seven qualities it never fires (also asserted in the tests) — it is
 * kept because a future quality with a wider interval would need it, and a
 * silent `undefined` accidental is a nastier failure than a no-op guard.
 *
 * @param {string} rootName one of ROOTS, e.g. "Bb"
 * @param {string} qualityId a chordTypes id, e.g. "dominant7"
 * @param {number} rootOctave octave of the root, e.g. 4
 * @returns {Array<{midi: number, name: string}>} low to high
 */
export function chordNotes(rootName, qualityId, rootOctave) {
  const root = parseRootName(rootName);
  const { intervals } = chordTypeOf(qualityId);
  const rootDia = diatonicIndex(root.letter, rootOctave);
  const rootLetterSemitone = LETTER_SEMITONES[root.letter];

  return intervals.map((interval, i) => {
    const dia = rootDia + i * 2; // 0, 2, 4, 6 letters above the root
    const toneLetter = letterAt(dia);
    const naturalGap = mod(LETTER_SEMITONES[toneLetter] - rootLetterSemitone, 12);

    let alter = root.alter + interval - naturalGap;
    while (alter > 2) alter -= 12;
    while (alter < -2) alter += 12;

    return makeNote(toneLetter, alter, octaveAt(dia));
  });
}

/**
 * The chord's name as it appears on an answer tile: root then quality suffix.
 * "C", "Dm", "F#dim", "Bbmaj7".
 */
export function chordName(rootName, qualityId) {
  return `${rootName}${chordTypeOf(qualityId).suffix}`;
}

/**
 * Read a chord name back into its parts, or null if it is not one of the
 * eighty-four. Needed to explain a wrong answer: the tile hands back a string,
 * and the explanation needs the chord behind it.
 *
 * Roots are matched LONGEST FIRST so "C#" is tried before "C" — otherwise
 * "C#maj7" would match root "C" with a leftover "#maj7" that no suffix claims,
 * and the label would come back unparseable. The suffix comparison is exact
 * equality against the remainder, so no equivalent ordering is needed there.
 *
 * @returns {{root: string, quality: string}|null}
 */
export function parseChordLabel(label) {
  const text = String(label ?? "");
  const roots = [...ROOTS].sort((a, b) => b.length - a.length);

  for (const root of roots) {
    if (!text.startsWith(root)) continue;
    const rest = text.slice(root.length);
    const type = CHORD_TYPES.find((t) => t.suffix === rest);
    if (type) return { root, quality: type.id };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Where a chord sits
// ---------------------------------------------------------------------------

// The middle line of each staff, in MIDI. Treble's middle line is B4, bass's is
// D3. A chord is placed at whichever candidate octave puts its midpoint closest
// to this, which keeps a low-rooted chord from sinking off the bottom and a
// high-rooted seventh from climbing five ledger lines off the top.
const CLEF_CENTRE = { treble: 71, bass: 50 };

// The two octaves worth trying per clef. Two is enough: one step either way
// covers every root, and offering more would let a chord drift further from the
// staff than the centre rule can pull it back.
const CLEF_ROOT_OCTAVES = { treble: [3, 4], bass: [2, 3] };

/**
 * The octave to build this chord at so it sits on or near the given staff.
 *
 * Ties keep the lower octave, because `CLEF_ROOT_OCTAVES` is in ascending order
 * and the comparison is strict. Deterministic on purpose — the same chord in
 * the same clef always looks the same, so a player can learn its shape.
 */
export function chordRootOctave(rootName, qualityId, clef) {
  const centre = CLEF_CENTRE[clef];
  const candidates = CLEF_ROOT_OCTAVES[clef];
  if (centre === undefined) throw new Error(`Unknown clef: ${clef}`);

  let best = null;
  let bestDistance = Infinity;
  for (const octave of candidates) {
    const notes = chordNotes(rootName, qualityId, octave);
    const midpoint = (notes[0].midi + notes[notes.length - 1].midi) / 2;
    const distance = Math.abs(midpoint - centre);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = octave;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Single-note pitch pools and difficulty weighting
// ---------------------------------------------------------------------------

// Pool is what may be asked; staff is where the five lines actually are.
// Everything between `staffLo` and `staffHi` sits on the staff; everything
// outside is on a ledger line or in the gap approaching one, and those are the
// notes worth drilling.
//
// The ranges are deliberately symmetric: each pool reaches four diatonic steps
// past the staff at one end and three at the other, so both clefs weight the
// same way.
export const CLEF_RANGES = {
  treble: { poolLo: "B3", poolHi: "C6", staffLo: "E4", staffHi: "F5" },
  bass: { poolLo: "C2", poolHi: "D4", staffLo: "G2", staffHi: "A3" },
};

/**
 * Every pitch this clef may ask about, chromatic and low to high.
 *
 * Chromatic rather than diatonic, so sharps come up: reading an accidental
 * against its notehead is half the exercise, and `name` already spells "F#3"
 * for the tile. Generated notes are spelled with SHARPS, matching
 * `midiDisplayName` in src/sam/lib/vexflowHelpers.js, which is SAM's existing
 * answer to the same "what do I call MIDI 61" question.
 */
export function pitchPool(clef) {
  const range = CLEF_RANGES[clef];
  if (!range) throw new Error(`Unknown clef: ${clef}`);

  const lo = parseNoteName(range.poolLo);
  const hi = parseNoteName(range.poolHi);
  const loMidi = midiOf(lo.letter, lo.alter, lo.octave);
  const hiMidi = midiOf(hi.letter, hi.alter, hi.octave);

  const pool = [];
  for (let midi = loMidi; midi <= hiMidi; midi++) {
    pool.push(sharpNoteFromMidi(midi));
  }
  return pool;
}

// MIDI -> note, always spelled with sharps. Same convention as vexflowHelpers.
function sharpNoteFromMidi(midi) {
  const SHARP_LETTERS = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"];
  const SHARP_ALTERS = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
  const pc = mod(midi, 12);
  return makeNote(SHARP_LETTERS[pc], SHARP_ALTERS[pc], Math.floor(midi / 12) - 1);
}

/**
 * How often this pitch should come up, relative to a note sitting on the staff.
 *
 * Two multiplied factors:
 *
 *   Ledger distance — `1 + 2.2 * (diatonic steps outside the staff)`. Measured
 *   in STAFF STEPS, not half-steps: C#4 and C4 are the same notehead position
 *   and equally hard to place. Four steps out scores 9.8, so the top and bottom
 *   of each pool come up about ten times as often as a note on a line, which is
 *   the whole reason the pools reach past the staff.
 *
 *   Past misses — `1 + 2 * (times missed)`. A note missed twice comes up five
 *   times as often as one never missed. This is the factor that survives a
 *   reload, because the miss tally is the persisted half of the game.
 *
 * @param {{name: string}} pitch
 * @param {string} clef
 * @param {Object<string, number>} missTally counts keyed by prompt label
 */
export function pitchWeight(pitch, clef, missTally = {}) {
  const range = CLEF_RANGES[clef];
  if (!range) throw new Error(`Unknown clef: ${clef}`);

  const dia = diatonicOf(pitch.name);
  const loDia = diatonicOf(range.staffLo);
  const hiDia = diatonicOf(range.staffHi);
  const stepsOutside = Math.max(0, loDia - dia, dia - hiDia);

  const missed = missTally[pitch.name] || 0;
  return (1 + 2.2 * stepsOutside) * (1 + 2 * missed);
}

// ---------------------------------------------------------------------------
// Picking and shuffling
// ---------------------------------------------------------------------------
//
// `rng` is injectable everywhere it is used, defaulting to Math.random. The
// existing tile-merge variants call Math.random directly (drop.jsx:266), which
// is fine for a board that is only ever verified by eye; the spelling and
// distractor rules here have to be provable, and a seeded generator in the test
// file is what makes "the octave twin shows up about 60% of the time" a test
// rather than a hope.

/** One item, chosen in proportion to its weight. */
export function weightedPick(items, weights, rng = Math.random) {
  const total = weights.reduce((sum, w) => sum + w, 0);
  // Degenerate input (empty, all-zero, NaN) falls back to uniform rather than
  // returning undefined — a prompt with no answer would take the screen down.
  if (!(total > 0)) return items[Math.floor(rng() * items.length)];

  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r < 0) return items[i];
  }
  return items[items.length - 1]; // floating-point guard
}

/** A shuffled copy. Fisher-Yates; never mutates the caller's array. */
export function shuffled(list, rng = Math.random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** N items picked without replacement. */
function sample(list, count, rng) {
  return shuffled(list, rng).slice(0, count);
}

// ---------------------------------------------------------------------------
// Distractors
// ---------------------------------------------------------------------------

const OPTION_COUNT = 4;

// How often the octave twin is offered. C3 against C4 is precisely the mistake
// the octave numbers exist to train, so it earns a majority of the slots — but
// not all of them, or its presence would itself become the tell.
const OCTAVE_TWIN_CHANCE = 0.6;

// How often a plain natural answer is given an accidental-carrying decoy
// anyway. Without it, closing the first tell just opens its mirror: four
// natural tiles would mean the answer is natural, and the player would again be
// reading the tiles instead of the staff.
const ACCIDENTAL_DECOY_CHANCE = 0.5;

/**
 * Three wrong answers for a single note.
 *
 * THE ACCIDENTAL MUST NEVER BE THE GIVEAWAY. An earlier version spelled every
 * distractor natural, so whenever the answer carried a sharp it was the only
 * tile that did and the round could be won without looking at the staff. The
 * rule now has two branches:
 *
 *   The answer carries an accidental — one wrong answer is the SAME letter and
 *   octave spelled natural (F#4 puts F4 on screen beside it), and at least one
 *   other wrong answer carries an accidental of its own. The natural twin is
 *   deliberate rather than cruel: noticing the sharp is the whole skill, so both
 *   spellings belong on screen at once.
 *
 *   The answer is a plain natural — about half the time one wrong answer
 *   carries an accidental anyway, for the mirror-tell reason above.
 *
 * Whatever is left over is filled the way it always was: the octave twin at
 * roughly 60%, then staff neighbours one to three steps away.
 *
 * Candidates are restricted to the clef's own pool, so a tile never offers a
 * note the game could not have asked in the first place. The pool is spelled
 * with sharps, which is why there is no accidental at an E or a B position —
 * `inPool` rejects "E#4" because the pool calls that pitch F4.
 *
 * The two required takes above are proven to be satisfiable for the declared
 * ranges (every accidental in either pool has both its natural twin and at
 * least one octave twin in the same pool) and the test suite asserts it for
 * every pitch, so a range change that broke the guarantee would fail loudly
 * rather than silently handing back a giveaway.
 */
export function noteDistractors(answer, clef, rng = Math.random) {
  const pool = pitchPool(clef);
  const byName = new Map(pool.map((p) => [p.name, p]));
  const inPool = (note) => note != null && byName.has(note.name);

  const { letter, alter, octave } = parseNoteName(answer.name);
  const answerDia = diatonicOf(answer.name);
  const answerHasAccidental = alter !== 0;

  const picked = [];
  const taken = new Set([answer.name]);

  const take = (note) => {
    if (!inPool(note) || taken.has(note.name)) return false;
    taken.add(note.name);
    picked.push(note.name);
    return true;
  };
  const full = () => picked.length >= OPTION_COUNT - 1;

  // The octave twin keeps the answer's accidental — F#4's twin is F#5, not F5.
  const octaveTwins = [
    makeNote(letter, alter, octave + 1),
    makeNote(letter, alter, octave - 1),
  ];

  // Pool notes near the answer that carry an accidental of their own. An octave
  // twin only qualifies when the answer itself is altered, because the twin of
  // a natural is another natural.
  const accidentalDecoys = () => {
    const out = [];
    if (answerHasAccidental) out.push(...octaveTwins);
    for (let step = -3; step <= 3; step++) {
      if (step === 0) continue;
      const dia = answerDia + step;
      out.push(makeNote(letterAt(dia), 1, octaveAt(dia)));
    }
    return out.filter(inPool);
  };

  const takeOneAccidental = () => {
    for (const candidate of shuffled(accidentalDecoys(), rng)) {
      if (take(candidate)) return true;
    }
    return false;
  };

  // --- Required, when the answer is altered --------------------------------
  if (answerHasAccidental) {
    take(makeNote(letter, 0, octave)); // the same notehead, spelled natural
    takeOneAccidental(); // ...so the answer is not the only altered tile
  } else if (rng() < ACCIDENTAL_DECOY_CHANCE) {
    takeOneAccidental();
  }

  // --- The rest, unchanged -------------------------------------------------
  if (!full() && rng() < OCTAVE_TWIN_CHANCE) {
    const usable = shuffled(octaveTwins.filter((t) => inPool(t) && !taken.has(t.name)), rng);
    if (usable.length) take(usable[0]);
  }

  // Neighbours, shuffled within each widening pass. The second pass only runs
  // if the pool edge starved the first.
  for (const maxStep of [3, 5]) {
    if (full()) break;
    const steps = [];
    for (let s = 1; s <= maxStep; s++) steps.push(s, -s);
    for (const step of shuffled(steps, rng)) {
      if (full()) break;
      const dia = answerDia + step;
      take(makeNote(letterAt(dia), 0, octaveAt(dia)));
    }
  }

  // Last resort: anything left in the pool. Unreachable for the declared
  // ranges, and here so that a future range change cannot produce a blank tile.
  for (const note of shuffled(pool, rng)) {
    if (full()) break;
    take(note);
  }

  return picked;
}

/**
 * Three wrong answers for a chord.
 *
 * One is the same root with a different quality — D against Dm is the hardest
 * and most useful confusion, because it is one notehead — and the other two are
 * different roots with the same quality. No duplicates are possible: the
 * same-root distractor differs in suffix, and the other-root ones differ in
 * root, and root names are distinct strings.
 */
export function chordDistractors(rootName, qualityId, rng = Math.random) {
  const otherQualities = CHORD_TYPE_IDS.filter((id) => id !== qualityId);
  const otherRoots = ROOTS.filter((r) => r !== rootName);

  const sameRoot = sample(otherQualities, 1, rng).map((id) => chordName(rootName, id));
  const sameQuality = sample(otherRoots, 2, rng).map((r) => chordName(r, qualityId));

  return [...sameRoot, ...sameQuality];
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const WHOLE_NOTE = "w";

/**
 * One single-note prompt.
 *
 * @returns {{clef: string, event: object, label: string, options: string[], chord: null}}
 */
export function makeNotePrompt({ clef, missTally = {}, rng = Math.random } = {}) {
  const pool = pitchPool(clef);
  const weights = pool.map((p) => pitchWeight(p, clef, missTally));
  const answer = weightedPick(pool, weights, rng);

  return {
    clef,
    event: { duration: WHOLE_NOTE, notes: [answer] },
    label: answer.name,
    options: shuffled([answer.name, ...noteDistractors(answer, clef, rng)], rng),
    chord: null,
  };
}

/**
 * One chord prompt.
 *
 * Chords carry no ledger-line weighting — a chord is placed where it fits the
 * staff, so there is no "harder position" to weight for. The miss tally still
 * applies, which is the half of the weighting that matters here: a chord type
 * you keep getting wrong comes back more often.
 */
export function makeChordPrompt({ clef, missTally = {}, rng = Math.random } = {}) {
  const candidates = [];
  for (const root of ROOTS) {
    for (const quality of CHORD_TYPE_IDS) {
      candidates.push({ root, quality, label: chordName(root, quality) });
    }
  }
  const weights = candidates.map((c) => 1 + 2 * (missTally[c.label] || 0));
  const { root, quality, label } = weightedPick(candidates, weights, rng);

  const octave = chordRootOctave(root, quality, clef);

  return {
    clef,
    event: { duration: WHOLE_NOTE, notes: chordNotes(root, quality, octave) },
    label,
    options: shuffled([label, ...chordDistractors(root, quality, rng)], rng),
    // Carried so a wrong answer can be explained without re-deriving anything.
    chord: { root, quality, octave },
  };
}

/**
 * One prompt of whichever kind the toggles ask for.
 *
 * @param {object} options
 * @param {"notes"|"chords"|"mix"} options.mode  "mix" is a 50/50 split
 * @param {"treble"|"bass"|"both"} options.clefMode  "both" is a 50/50 split
 */
export function makePrompt({
  mode = "mix",
  clefMode = "both",
  missTally = {},
  rng = Math.random,
} = {}) {
  const clef = clefMode === "both" ? (rng() < 0.5 ? "treble" : "bass") : clefMode;
  const wantsChord = mode === "chords" || (mode === "mix" && rng() < 0.5);

  return wantsChord
    ? makeChordPrompt({ clef, missTally, rng })
    : makeNotePrompt({ clef, missTally, rng });
}

// ---------------------------------------------------------------------------
// Explaining a wrong chord
// ---------------------------------------------------------------------------

/** "a half-step lower", "two half-steps higher", and so on. */
function describeGap(semitones) {
  const direction = semitones < 0 ? "lower" : "higher";
  const size = Math.abs(semitones);
  if (size === 1) return `a half-step ${direction}`;
  if (size === 2) return `a whole step ${direction}`;
  return `${size} half-steps ${direction}`;
}

/**
 * Why the picked chord is not the one on the staff, in one sentence.
 *
 * Computed rather than canned, in the spec's order of usefulness: a wrong root
 * is a different chord entirely and worth saying first; a wrong note count is
 * the triad/seventh confusion; anything left is a single notehead, which is the
 * case where naming the exact pitch teaches the most.
 *
 * Returns null when the pick was correct, or when the label is not one of the
 * eighty-four — the caller has nothing to explain either way.
 *
 * @param {{root: string, quality: string, octave: number}} correct  a prompt's `chord`
 * @param {string} pickedLabel  the tile that was pressed
 * @returns {string|null}
 */
export function describeChordDifference(correct, pickedLabel) {
  const picked = parseChordLabel(pickedLabel);
  if (!correct || !picked) return null;
  if (picked.root === correct.root && picked.quality === correct.quality) return null;

  const correctLabel = chordName(correct.root, correct.quality);
  // Both built at the same octave, so the comparison is about spelling rather
  // than about where each one happened to be placed.
  const correctNotes = chordNotes(correct.root, correct.quality, correct.octave);
  const pickedNotes = chordNotes(picked.root, picked.quality, correct.octave);

  if (picked.root !== correct.root) {
    return (
      `${correctLabel} is named after its lowest note, ${correct.root} — that is the note the ` +
      `chord is built on. ${pickedLabel} is built on ${picked.root} instead.`
    );
  }

  if (pickedNotes.length !== correctNotes.length) {
    if (correctNotes.length > pickedNotes.length) {
      const extra = pitchClassName(correctNotes[correctNotes.length - 1].name);
      return (
        `${correctLabel} has a fourth note on top — the ${extra} — that ${pickedLabel} does not.`
      );
    }
    return (
      `${pickedLabel} adds a fourth note on top. ${correctLabel} has only ` +
      `${correctNotes.length}, so there is nothing above the ` +
      `${pitchClassName(correctNotes[correctNotes.length - 1].name)}.`
    );
  }

  const i = correctNotes.findIndex((n, idx) => n.name !== pickedNotes[idx].name);
  if (i === -1) return null; // same notes under a different name; nothing to say
  const gap = pickedNotes[i].midi - correctNotes[i].midi;
  return (
    `${pickedLabel} wants ${pitchClassName(pickedNotes[i].name)} where the staff shows ` +
    `${pitchClassName(correctNotes[i].name)}, ${describeGap(gap)}.`
  );
}
