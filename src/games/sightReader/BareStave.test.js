import { OVERSHOOT_STEPS, frameMarginPx } from "./BareStave";
import {
  CLEF_RANGES,
  ROOTS,
  chordNotes,
  chordRootOctave,
  diatonicOf,
  pitchPool,
} from "./music";
import { CHORD_TYPE_IDS } from "./chordTypes";

// VexFlow's default line spacing is 10px, so one diatonic step is 5px.
const STEP_PX = 5;
// An accidental glyph reaches about 1.5 spaces from its notehead centre (a
// flat's ascender is the tallest); a notehead about half a space.
const GLYPH_REACH_PX = 15;

function drawable(clef) {
  const names = pitchPool(clef).map((p) => p.name);
  for (const root of ROOTS) {
    for (const quality of CHORD_TYPE_IDS) {
      const octave = chordRootOctave(root, quality, clef);
      for (const n of chordNotes(root, quality, octave)) names.push(n.name);
    }
  }
  return names;
}

describe.each(["treble", "bass"])("%s stave frame", (clef) => {
  const top = diatonicOf(CLEF_RANGES[clef].staffHi);
  const bottom = diatonicOf(CLEF_RANGES[clef].staffLo);
  const positions = drawable(clef).map(diatonicOf);
  const highest = Math.max(...positions);
  const lowest = Math.min(...positions);

  test("pool ends are the declared range", () => {
    const pool = pitchPool(clef).map((p) => diatonicOf(p.name));
    expect(Math.max(...pool)).toBe(diatonicOf(CLEF_RANGES[clef].poolHi));
    expect(Math.min(...pool)).toBe(diatonicOf(CLEF_RANGES[clef].poolLo));
  });

  test("highest and lowest notes, with accidentals, fit the frame", () => {
    const margin = frameMarginPx(STEP_PX);
    expect((highest - top) * STEP_PX + GLYPH_REACH_PX).toBeLessThanOrEqual(margin);
    expect((bottom - lowest) * STEP_PX + GLYPH_REACH_PX).toBeLessThanOrEqual(margin);
    expect(Math.max(highest - top, bottom - lowest)).toBeLessThanOrEqual(OVERSHOOT_STEPS);
  });
});
