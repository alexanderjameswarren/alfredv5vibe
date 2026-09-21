// Sight Reader's music logic.
//
// The interesting cases are not "does C major contain E" — they are the ones
// that make a flashcard silently wrong: an enharmonic spelled the lazy way, a
// name and a MIDI number that disagree, a set of four tiles that does not
// contain the answer, or a pitch pool that wanders outside the staff it was
// declared for.
//
// VexFlow is a CDN global and is `undefined` under Jest, so nothing here
// renders. That is the point of keeping this module pure.

import {
  CLEF_RANGES,
  ROOTS,
  chordDistractors,
  chordName,
  chordNotes,
  chordRootOctave,
  describeChordDifference,
  diatonicOf,
  makeChordPrompt,
  makeNote,
  makeNotePrompt,
  makePrompt,
  noteDistractors,
  parseChordLabel,
  parseNoteName,
  pitchClassName,
  pitchPool,
  pitchWeight,
  shuffled,
  weightedPick,
} from "./music";
import { CHORD_TYPES, CHORD_TYPE_IDS, chordTypeOf } from "./chordTypes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A seeded generator, so "the octave twin turns up about 60% of the time" is a
// test rather than a hope. mulberry32 — small, and good enough for counting.
function seededRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Derived independently of the module under test, from the schema's own
// formula: midi = (octave + 1) * 12 + step + alter. If this and `makeNote`
// ever disagree, one of them is wrong and the test should say so.
const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ALTERS = { bb: -2, b: -1, "": 0, "#": 1, "##": 2 };

function independentMidi(name) {
  const m = /^([A-G])(##|bb|#|b)?(-?\d)$/.exec(name);
  if (!m) return null;
  return (parseInt(m[3], 10) + 1) * 12 + STEP_SEMITONES[m[1]] + ALTERS[m[2] || ""];
}

// The schema's regex, verbatim from sam-drill-format.schema.json.
const SCHEMA_NAME_RE = /^[A-G](##|bb|#|b)?-?[0-9]$/;

const names = (notes) => notes.map((n) => n.name);

// Every root crossed with every quality — the whole eighty-four.
const ALL_CHORDS = ROOTS.flatMap((root) =>
  CHORD_TYPE_IDS.map((quality) => ({ root, quality }))
);

// ---------------------------------------------------------------------------
// Chord spelling — the reason this module exists
// ---------------------------------------------------------------------------

describe("chordNotes — enharmonic spelling", () => {
  test("D major is D-F#-A, never D-Gb-A", () => {
    expect(names(chordNotes("D", "major", 4))).toEqual(["D4", "F#4", "A4"]);
  });

  test("Eb minor spells with flats: Eb-Gb-Bb", () => {
    expect(names(chordNotes("Eb", "minor", 4))).toEqual(["Eb4", "Gb4", "Bb4"]);
  });

  test("the three spot-check chords from the spec", () => {
    expect(names(chordNotes("D", "major", 4))).toEqual(["D4", "F#4", "A4"]);
    expect(names(chordNotes("Bb", "dominant7", 4))).toEqual(["Bb4", "D5", "F5", "Ab5"]);
    expect(names(chordNotes("F#", "diminished", 4))).toEqual(["F#4", "A4", "C5"]);
  });

  test("a sharp root keeps sharp thirds: C# major is C#-E#-G#, not C#-F-G#", () => {
    // E# and F sound identical. Only one of them is a third above C#.
    expect(names(chordNotes("C#", "major", 4))).toEqual(["C#4", "E#4", "G#4"]);
  });

  test("double sharps appear where they are the correct spelling", () => {
    // B augmented stretches the fifth up a half-step from F#, which is F##.
    // Spelling it G would put two chord tones on the same staff position.
    expect(names(chordNotes("B", "augmented", 4))).toEqual(["B4", "D#5", "F##5"]);
  });

  test("the octave wraps by letter, so a chord on A crosses into the next one", () => {
    expect(names(chordNotes("A", "major", 4))).toEqual(["A4", "C#5", "E5"]);
    expect(names(chordNotes("B", "minor7", 3))).toEqual(["B3", "D4", "F#4", "A4"]);
  });

  test("every chord tone sits on its own staff position", () => {
    // Three or four noteheads, never two sharing a line. This is what the
    // letter-first stacking buys, and what an enharmonic shortcut destroys.
    for (const { root, quality } of ALL_CHORDS) {
      const positions = chordNotes(root, quality, 4).map((n) => diatonicOf(n.name));
      expect(new Set(positions).size).toBe(positions.length);
    }
  });
});

describe("chordNotes — invariants across all eighty-four chords", () => {
  test("the intervals are exactly what the quality declares", () => {
    for (const { root, quality } of ALL_CHORDS) {
      const notes = chordNotes(root, quality, 4);
      const { intervals } = chordTypeOf(quality);
      const offsets = notes.map((n) => n.midi - notes[0].midi);
      expect({ root, quality, offsets }).toEqual({ root, quality, offsets: intervals });
    }
  });

  test("midi and name always agree", () => {
    for (const { root, quality } of ALL_CHORDS) {
      for (const note of chordNotes(root, quality, 4)) {
        expect({ name: note.name, midi: note.midi }).toEqual({
          name: note.name,
          midi: independentMidi(note.name),
        });
      }
    }
  });

  test("every name is a name the SAM schema would accept", () => {
    for (const { root, quality } of ALL_CHORDS) {
      for (const note of chordNotes(root, quality, 4)) {
        expect(note.name).toMatch(SCHEMA_NAME_RE);
      }
    }
  });

  test("no accidental exceeds a double sharp or double flat", () => {
    // The ±12 normalisation in chordNotes is a guard for a wider interval
    // vocabulary; for these seven qualities it must never need to fire. If this
    // fails, the normalisation has silently moved a note by an octave and the
    // interval test above would be the one to trust.
    for (const { root, quality } of ALL_CHORDS) {
      for (const note of chordNotes(root, quality, 4)) {
        expect(Math.abs(parseNoteName(note.name).alter)).toBeLessThanOrEqual(2);
      }
    }
  });

  test("notes come back low to high", () => {
    for (const { root, quality } of ALL_CHORDS) {
      const midis = chordNotes(root, quality, 4).map((n) => n.midi);
      expect(midis).toEqual([...midis].sort((a, b) => a - b));
    }
  });
});

describe("chordName and parseChordLabel", () => {
  test("names read the way a tile should show them", () => {
    expect(chordName("C", "major")).toBe("C");
    expect(chordName("D", "minor")).toBe("Dm");
    expect(chordName("F#", "diminished")).toBe("F#dim");
    expect(chordName("Bb", "major7")).toBe("Bbmaj7");
    expect(chordName("Eb", "augmented")).toBe("Ebaug");
    expect(chordName("A", "dominant7")).toBe("A7");
    expect(chordName("C#", "minor7")).toBe("C#m7");
  });

  test("every one of the eighty-four round-trips", () => {
    // A sharp root must not parse as its natural ("C#maj7" is not C + "#maj7"),
    // and a flat root must not lose its flat ("Bb7" is not B + "b7").
    for (const { root, quality } of ALL_CHORDS) {
      expect(parseChordLabel(chordName(root, quality))).toEqual({ root, quality });
    }
  });

  test("the eighty-four labels are all distinct", () => {
    const labels = ALL_CHORDS.map(({ root, quality }) => chordName(root, quality));
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("anything else is null rather than a guess", () => {
    expect(parseChordLabel("H7")).toBeNull();
    expect(parseChordLabel("Cwhatever")).toBeNull();
    expect(parseChordLabel("")).toBeNull();
    expect(parseChordLabel(undefined)).toBeNull();
    expect(parseChordLabel("Db")).toBeNull(); // not one of the twelve roots
  });
});

// ---------------------------------------------------------------------------
// Where a chord is placed
// ---------------------------------------------------------------------------

describe("chordRootOctave", () => {
  test("puts a chord near the middle of its staff, in both clefs", () => {
    // The wrong octave would be twelve semitones off; anything under that is
    // proof the centre rule ran. The observed worst case is about eight.
    const centre = { treble: 71, bass: 50 };
    for (const clef of ["treble", "bass"]) {
      for (const { root, quality } of ALL_CHORDS) {
        const notes = chordNotes(root, quality, chordRootOctave(root, quality, clef));
        const midpoint = (notes[0].midi + notes[notes.length - 1].midi) / 2;
        expect(Math.abs(midpoint - centre[clef])).toBeLessThanOrEqual(9);
      }
    }
  });

  test("is deterministic — the same chord always looks the same", () => {
    expect(chordRootOctave("C", "major", "treble")).toBe(
      chordRootOctave("C", "major", "treble")
    );
    expect(chordRootOctave("C", "major", "treble")).toBe(4);
    expect(chordRootOctave("C", "major", "bass")).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Pitch pools and weighting
// ---------------------------------------------------------------------------

describe("pitchPool", () => {
  test.each(["treble", "bass"])("%s stays inside its declared range", (clef) => {
    const { poolLo, poolHi } = CLEF_RANGES[clef];
    const lo = independentMidi(poolLo);
    const hi = independentMidi(poolHi);
    const pool = pitchPool(clef);

    expect(pool.length).toBe(hi - lo + 1);
    expect(pool[0].name).toBe(poolLo);
    expect(pool[pool.length - 1].name).toBe(poolHi);
    for (const pitch of pool) {
      expect(pitch.midi).toBeGreaterThanOrEqual(lo);
      expect(pitch.midi).toBeLessThanOrEqual(hi);
    }
  });

  test.each(["treble", "bass"])("%s names agree with their midi and the schema", (clef) => {
    for (const pitch of pitchPool(clef)) {
      expect(pitch.name).toMatch(SCHEMA_NAME_RE);
      expect(pitch.midi).toBe(independentMidi(pitch.name));
    }
  });

  test("accidentals are spelled with sharps, as vexflowHelpers does", () => {
    const treble = pitchPool("treble").map((p) => p.name);
    expect(treble).toContain("C#4");
    expect(treble).toContain("F#4");
    expect(treble).not.toContain("Db4");
  });

  test("the pool is chromatic — no gaps", () => {
    const pool = pitchPool("bass");
    for (let i = 1; i < pool.length; i++) {
      expect(pool[i].midi - pool[i - 1].midi).toBe(1);
    }
  });
});

describe("pitchWeight", () => {
  test("a note on the staff weighs 1", () => {
    expect(pitchWeight({ name: "E4" }, "treble")).toBe(1); // bottom line
    expect(pitchWeight({ name: "F5" }, "treble")).toBe(1); // top line
    expect(pitchWeight({ name: "B4" }, "treble")).toBe(1); // middle line
    expect(pitchWeight({ name: "G2" }, "bass")).toBe(1);
    expect(pitchWeight({ name: "A3" }, "bass")).toBe(1);
  });

  test("four ledger steps out comes up about ten times as often", () => {
    expect(pitchWeight({ name: "C6" }, "treble")).toBeCloseTo(9.8);
    expect(pitchWeight({ name: "C2" }, "bass")).toBeCloseTo(9.8);
  });

  test("weight grows with distance off the staff", () => {
    const d5 = pitchWeight({ name: "D5" }, "treble"); // on the staff
    const a5 = pitchWeight({ name: "A5" }, "treble"); // two steps above
    const c6 = pitchWeight({ name: "C6" }, "treble"); // four steps above
    expect(d5).toBeLessThan(a5);
    expect(a5).toBeLessThan(c6);
  });

  test("an accidental does not change the weight — same notehead, same difficulty", () => {
    expect(pitchWeight({ name: "C6" }, "treble")).toBe(pitchWeight({ name: "C#6" }, "treble"));
  });

  test("misses multiply: missed twice is five times as likely", () => {
    const clean = pitchWeight({ name: "B4" }, "treble", {});
    const missed = pitchWeight({ name: "B4" }, "treble", { B4: 2 });
    expect(clean).toBe(1);
    expect(missed).toBe(5);
  });

  test("the miss tally compounds with ledger distance", () => {
    expect(pitchWeight({ name: "C6" }, "treble", { C6: 1 })).toBeCloseTo(9.8 * 3);
  });
});

// ---------------------------------------------------------------------------
// Picking and shuffling
// ---------------------------------------------------------------------------

describe("weightedPick", () => {
  test("respects the weights", () => {
    const rng = seededRng(7);
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 4000; i++) counts[weightedPick(["a", "b"], [9, 1], rng)] += 1;
    expect(counts.a / 4000).toBeGreaterThan(0.85);
    expect(counts.a / 4000).toBeLessThan(0.95);
  });

  test("falls back to uniform rather than undefined when weights are degenerate", () => {
    const rng = seededRng(3);
    expect(["a", "b"]).toContain(weightedPick(["a", "b"], [0, 0], rng));
  });
});

describe("shuffled", () => {
  test("keeps every element and does not mutate the caller's array", () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffled(input, seededRng(11));
    expect(input).toEqual([1, 2, 3, 4, 5]);
    expect([...out].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

// ---------------------------------------------------------------------------
// Distractors
// ---------------------------------------------------------------------------

describe("noteDistractors", () => {
  test("always three, all distinct, none equal to the answer", () => {
    const rng = seededRng(42);
    for (const clef of ["treble", "bass"]) {
      for (const answer of pitchPool(clef)) {
        for (let i = 0; i < 8; i++) {
          const wrong = noteDistractors(answer, clef, rng);
          expect(wrong).toHaveLength(3);
          expect(new Set(wrong).size).toBe(3);
          expect(wrong).not.toContain(answer.name);
        }
      }
    }
  });

  test("every distractor is a note the game could itself have asked", () => {
    const rng = seededRng(5);
    for (const clef of ["treble", "bass"]) {
      const poolNames = new Set(pitchPool(clef).map((p) => p.name));
      for (const answer of pitchPool(clef)) {
        for (const name of noteDistractors(answer, clef, rng)) {
          expect(poolNames.has(name)).toBe(true);
        }
      }
    }
  });

  test("the pool edges still yield three — this is where candidates run short", () => {
    const rng = seededRng(19);
    for (const name of ["B3", "C6"]) {
      const answer = pitchPool("treble").find((p) => p.name === name);
      for (let i = 0; i < 50; i++) {
        expect(noteDistractors(answer, "treble", rng)).toHaveLength(3);
      }
    }
  });

  test("the octave twin turns up roughly 60% of the time", () => {
    const rng = seededRng(2024);
    const answer = pitchPool("treble").find((p) => p.name === "C5");
    let withTwin = 0;
    const runs = 3000;
    for (let i = 0; i < runs; i++) {
      const wrong = noteDistractors(answer, "treble", rng);
      if (wrong.includes("C4") || wrong.includes("C6")) withTwin += 1;
    }
    expect(withTwin / runs).toBeGreaterThan(0.5);
    expect(withTwin / runs).toBeLessThan(0.7);
  });

  test("an altered answer always gets its own natural twin on a tile", () => {
    // F#4 must put F4 on screen. Noticing the sharp is the skill, so both
    // spellings of that notehead belong in front of the player at once.
    const rng = seededRng(303);
    for (const clef of ["treble", "bass"]) {
      for (const answer of pitchPool(clef)) {
        const { letter, alter, octave } = parseNoteName(answer.name);
        if (alter === 0) continue;
        const naturalTwin = makeNote(letter, 0, octave).name;
        for (let i = 0; i < 6; i++) {
          expect(noteDistractors(answer, clef, rng)).toContain(naturalTwin);
        }
      }
    }
  });

  test("an altered answer is never the only altered tile", () => {
    // The tell this rule exists to close: if the answer were the only tile
    // carrying an accidental, the round could be won without reading the staff.
    const rng = seededRng(404);
    for (const clef of ["treble", "bass"]) {
      for (const answer of pitchPool(clef)) {
        const { letter, alter, octave } = parseNoteName(answer.name);
        if (alter === 0) continue;
        const naturalTwin = makeNote(letter, 0, octave).name;
        for (let i = 0; i < 6; i++) {
          const wrong = noteDistractors(answer, clef, rng);
          const alteredOthers = wrong.filter(
            (n) => n !== naturalTwin && parseNoteName(n).alter !== 0
          );
          expect(alteredOthers.length).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  test("a natural answer gets an altered decoy about half the time", () => {
    // The mirror tell: without this, four natural tiles would mean a natural
    // answer and the player would be reading tiles again instead of the staff.
    const rng = seededRng(505);
    const answer = pitchPool("treble").find((p) => p.name === "G4");
    let withAccidental = 0;
    const runs = 3000;
    for (let i = 0; i < runs; i++) {
      const wrong = noteDistractors(answer, "treble", rng);
      if (wrong.some((n) => parseNoteName(n).alter !== 0)) withAccidental += 1;
    }
    expect(withAccidental / runs).toBeGreaterThan(0.4);
    expect(withAccidental / runs).toBeLessThan(0.6);
  });

  test("a natural answer is sometimes given an all-natural set, and sometimes not", () => {
    // Both branches must actually occur for every natural pitch in both pools,
    // or some note would carry a tell of its own.
    const rng = seededRng(606);
    for (const clef of ["treble", "bass"]) {
      for (const answer of pitchPool(clef)) {
        if (parseNoteName(answer.name).alter !== 0) continue;
        const outcomes = new Set();
        for (let i = 0; i < 60; i++) {
          const wrong = noteDistractors(answer, clef, rng);
          outcomes.add(wrong.some((n) => parseNoteName(n).alter !== 0));
        }
        expect(outcomes).toEqual(new Set([true, false]));
      }
    }
  });

  test("the octave twin keeps the accidental — F#4's twin is F#5, not F5", () => {
    const rng = seededRng(1);
    const answer = pitchPool("treble").find((p) => p.name === "F#4");
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      for (const n of noteDistractors(answer, "treble", rng)) seen.add(n);
    }
    expect(seen.has("F#5")).toBe(true);
    expect(seen.has("F#3")).toBe(false); // outside the treble pool
  });

  test("non-twin distractors are near neighbours on the staff", () => {
    const rng = seededRng(88);
    const answer = pitchPool("treble").find((p) => p.name === "C5");
    const answerDia = diatonicOf("C5");
    for (let i = 0; i < 200; i++) {
      for (const name of noteDistractors(answer, "treble", rng)) {
        const steps = Math.abs(diatonicOf(name) - answerDia);
        // Either the octave twin (seven steps) or within three staff steps.
        expect(steps === 7 || steps <= 3).toBe(true);
      }
    }
  });
});

describe("chordDistractors", () => {
  test("always three, all distinct, none equal to the answer", () => {
    const rng = seededRng(101);
    for (const { root, quality } of ALL_CHORDS) {
      const correct = chordName(root, quality);
      for (let i = 0; i < 4; i++) {
        const wrong = chordDistractors(root, quality, rng);
        expect(wrong).toHaveLength(3);
        expect(new Set(wrong).size).toBe(3);
        expect(wrong).not.toContain(correct);
      }
    }
  });

  test("one shares the root with a different quality, two share the quality", () => {
    const rng = seededRng(77);
    for (const { root, quality } of ALL_CHORDS) {
      for (let i = 0; i < 4; i++) {
        const parsed = chordDistractors(root, quality, rng).map(parseChordLabel);
        expect(parsed.every(Boolean)).toBe(true);
        const sameRoot = parsed.filter((p) => p.root === root && p.quality !== quality);
        const sameQuality = parsed.filter((p) => p.root !== root && p.quality === quality);
        expect(sameRoot).toHaveLength(1);
        expect(sameQuality).toHaveLength(2);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

describe("makeNotePrompt", () => {
  test("is a whole note, one notehead, with the answer among four options", () => {
    const rng = seededRng(31);
    for (let i = 0; i < 300; i++) {
      const prompt = makeNotePrompt({ clef: "treble", rng });
      expect(prompt.clef).toBe("treble");
      expect(prompt.event.duration).toBe("w");
      expect(prompt.event.notes).toHaveLength(1);
      expect(prompt.chord).toBeNull();
      expect(prompt.label).toBe(prompt.event.notes[0].name);
      expect(prompt.options).toHaveLength(4);
      expect(new Set(prompt.options).size).toBe(4);
      expect(prompt.options).toContain(prompt.label);
    }
  });

  test("the answer is not always in the same slot", () => {
    const rng = seededRng(64);
    const slots = new Set();
    for (let i = 0; i < 200; i++) {
      const prompt = makeNotePrompt({ clef: "bass", rng });
      slots.add(prompt.options.indexOf(prompt.label));
    }
    expect(slots).toEqual(new Set([0, 1, 2, 3]));
  });

  test("ledger-line notes really do come up more often", () => {
    const rng = seededRng(909);
    let offStaff = 0;
    const runs = 3000;
    const loDia = diatonicOf(CLEF_RANGES.treble.staffLo);
    const hiDia = diatonicOf(CLEF_RANGES.treble.staffHi);
    for (let i = 0; i < runs; i++) {
      const dia = diatonicOf(makeNotePrompt({ clef: "treble", rng }).label);
      if (dia < loDia || dia > hiDia) offStaff += 1;
    }
    // Seven of the twenty-six pool pitches sit off the staff, so uniform
    // picking would give about 27%. The weighting should push it well past.
    expect(offStaff / runs).toBeGreaterThan(0.6);
  });

  test("a missed note is asked more often", () => {
    const rng = seededRng(555);
    let asked = 0;
    for (let i = 0; i < 2000; i++) {
      if (makeNotePrompt({ clef: "treble", missTally: { B4: 40 }, rng }).label === "B4") {
        asked += 1;
      }
    }
    // B4 sits on the middle line and would otherwise be among the rarest.
    expect(asked / 2000).toBeGreaterThan(0.3);
  });
});

describe("makeChordPrompt", () => {
  test("is a whole note of three or four noteheads with four options", () => {
    const rng = seededRng(13);
    for (let i = 0; i < 300; i++) {
      const prompt = makeChordPrompt({ clef: "bass", rng });
      expect(prompt.event.duration).toBe("w");
      expect(prompt.event.notes.length).toBeGreaterThanOrEqual(3);
      expect(prompt.event.notes.length).toBeLessThanOrEqual(4);
      expect(prompt.options).toHaveLength(4);
      expect(new Set(prompt.options).size).toBe(4);
      expect(prompt.options).toContain(prompt.label);
    }
  });

  test("carries the chord it drew, so a wrong answer needs no re-derivation", () => {
    const rng = seededRng(17);
    for (let i = 0; i < 200; i++) {
      const prompt = makeChordPrompt({ clef: "treble", rng });
      expect(prompt.chord).toEqual({
        root: expect.any(String),
        quality: expect.any(String),
        octave: expect.any(Number),
      });
      expect(chordName(prompt.chord.root, prompt.chord.quality)).toBe(prompt.label);
      expect(names(chordNotes(prompt.chord.root, prompt.chord.quality, prompt.chord.octave)))
        .toEqual(names(prompt.event.notes));
    }
  });
});

describe("makePrompt", () => {
  test("mode notes never draws a chord, mode chords always does", () => {
    const rng = seededRng(21);
    for (let i = 0; i < 200; i++) {
      expect(makePrompt({ mode: "notes", clefMode: "treble", rng }).chord).toBeNull();
      expect(makePrompt({ mode: "chords", clefMode: "treble", rng }).chord).not.toBeNull();
    }
  });

  test("mix is roughly half and half", () => {
    const rng = seededRng(404);
    let chords = 0;
    for (let i = 0; i < 2000; i++) {
      if (makePrompt({ mode: "mix", clefMode: "treble", rng }).chord) chords += 1;
    }
    expect(chords / 2000).toBeGreaterThan(0.4);
    expect(chords / 2000).toBeLessThan(0.6);
  });

  test("a single clef is honoured; both draws each", () => {
    const rng = seededRng(88);
    for (let i = 0; i < 100; i++) {
      expect(makePrompt({ mode: "notes", clefMode: "bass", rng }).clef).toBe("bass");
    }
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      seen.add(makePrompt({ mode: "notes", clefMode: "both", rng }).clef);
    }
    expect(seen).toEqual(new Set(["treble", "bass"]));
  });

  test("whatever it draws, the answer is on a tile", () => {
    const rng = seededRng(2);
    for (let i = 0; i < 500; i++) {
      const prompt = makePrompt({ rng });
      expect(prompt.options).toHaveLength(4);
      expect(new Set(prompt.options).size).toBe(4);
      expect(prompt.options).toContain(prompt.label);
    }
  });
});

// ---------------------------------------------------------------------------
// Explaining a wrong chord
// ---------------------------------------------------------------------------

describe("describeChordDifference", () => {
  const correct = (root, quality, octave = 4) => ({ root, quality, octave });

  test("a right answer has nothing to explain", () => {
    expect(describeChordDifference(correct("D", "major"), "D")).toBeNull();
  });

  test("an unparseable pick has nothing to explain", () => {
    expect(describeChordDifference(correct("D", "major"), "nonsense")).toBeNull();
    expect(describeChordDifference(null, "D")).toBeNull();
  });

  test("a different root names the note the chord is built on", () => {
    const line = describeChordDifference(correct("D", "major"), "G");
    expect(line).toContain("named after its lowest note, D");
    expect(line).toContain("G is built on G");
  });

  test("a missing fourth note says what is on top", () => {
    // Dm7 is D-F-A-C; Dm is D-F-A.
    const line = describeChordDifference(correct("D", "minor7"), "Dm");
    expect(line).toContain("fourth note on top");
    expect(line).toContain("C");
  });

  test("an extra fourth note says the chord has only three", () => {
    const line = describeChordDifference(correct("D", "minor"), "Dm7");
    expect(line).toContain("adds a fourth note on top");
    expect(line).toContain("only 3");
  });

  test("otherwise it names the exact notehead that differs", () => {
    // D major is D-F#-A; D minor is D-F-A. One notehead, a half-step apart.
    const line = describeChordDifference(correct("D", "major"), "Dm");
    expect(line).toBe("Dm wants F where the staff shows F#, a half-step lower.");
  });

  test("and gets the direction right in the other direction too", () => {
    const line = describeChordDifference(correct("D", "minor"), "D");
    expect(line).toBe("D wants F# where the staff shows F, a half-step higher.");
  });

  test("a squeezed fifth reads as a fifth, not a third", () => {
    // Ddim is D-F-Ab against Dm's D-F-A: the first difference is the top note.
    const line = describeChordDifference(correct("D", "minor"), "Ddim");
    expect(line).toBe("Ddim wants Ab where the staff shows A, a half-step lower.");
  });

  test("every wrong pairing produces a sentence rather than a blank", () => {
    for (const { root, quality } of ALL_CHORDS) {
      for (const other of ALL_CHORDS) {
        if (other.root === root && other.quality === quality) continue;
        const line = describeChordDifference(
          correct(root, quality),
          chordName(other.root, other.quality)
        );
        expect(typeof line).toBe("string");
        expect(line.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

describe("note name helpers", () => {
  test("parseNoteName splits the three parts", () => {
    expect(parseNoteName("F#3")).toEqual({ letter: "F", alter: 1, octave: 3 });
    expect(parseNoteName("Bb4")).toEqual({ letter: "B", alter: -1, octave: 4 });
    expect(parseNoteName("C4")).toEqual({ letter: "C", alter: 0, octave: 4 });
    expect(parseNoteName("F##5")).toEqual({ letter: "F", alter: 2, octave: 5 });
    expect(parseNoteName("H4")).toBeNull();
  });

  test("pitchClassName drops the octave", () => {
    expect(pitchClassName("F#3")).toBe("F#");
    expect(pitchClassName("Bb4")).toBe("Bb");
    expect(pitchClassName("C4")).toBe("C");
  });

  test("makeNote derives midi from the spelling", () => {
    expect(makeNote("C", 0, 4)).toEqual({ midi: 60, name: "C4" });
    expect(makeNote("A", 0, 4)).toEqual({ midi: 69, name: "A4" });
    expect(makeNote("B", 1, 4)).toEqual({ midi: 72, name: "B#4" }); // sounds as C5
    expect(makeNote("C", -1, 5)).toEqual({ midi: 71, name: "Cb5" }); // sounds as B4
  });

  test("diatonicOf ignores accidentals — same notehead, same position", () => {
    expect(diatonicOf("C4")).toBe(diatonicOf("C#4"));
    expect(diatonicOf("D4") - diatonicOf("C4")).toBe(1);
    expect(diatonicOf("C5") - diatonicOf("C4")).toBe(7);
  });
});

describe("chordTypes", () => {
  test("seven types, ids and suffixes distinct", () => {
    expect(CHORD_TYPES).toHaveLength(7);
    expect(new Set(CHORD_TYPE_IDS).size).toBe(7);
    expect(new Set(CHORD_TYPES.map((t) => t.suffix)).size).toBe(7);
  });

  test("every type has a description written for a beginner", () => {
    for (const type of CHORD_TYPES) {
      expect(type.description.length).toBeGreaterThan(40);
      expect(type.name.length).toBeGreaterThan(0);
    }
  });

  test("suffixes match the spellings the MusicXML importer already uses", () => {
    // songParser.js:100-107 KIND_TEXT_TO_SUFFIX. Nothing shares code with it,
    // but a chord called "Dm7" there should be called "Dm7" here.
    const expected = {
      major: "",
      minor: "m",
      diminished: "dim",
      augmented: "aug",
      dominant7: "7",
      major7: "maj7",
      minor7: "m7",
    };
    for (const [id, suffix] of Object.entries(expected)) {
      expect(chordTypeOf(id).suffix).toBe(suffix);
    }
  });

  test("an unknown id throws rather than returning undefined", () => {
    expect(() => chordTypeOf("sus4")).toThrow(/Unknown chord type/);
  });
});
