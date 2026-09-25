// The focus list, and Focus mode's prompts.
//
// The list is edited by hand between practice sessions, so the job here is that
// a typo in it fails the suite rather than quietly costing a question. The
// second job is the rule that makes Focus worth having: the QUESTIONS narrow to
// the list, the WRONG ANSWERS do not.

import { FOCUS_LIST } from "./focusList";
import {
  CLEF_RANGES,
  ROOTS,
  chordName,
  focusEntryError,
  focusLabel,
  makeFocusPrompt,
  makePrompt,
  parseNoteName,
  pitchPool,
  validFocusEntries,
} from "./music";
import { CHORD_TYPE_IDS } from "./chordTypes";

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

describe("FOCUS_LIST", () => {
  test("every entry is usable", () => {
    for (const entry of FOCUS_LIST) {
      expect([focusLabel(entry), focusEntryError(entry)]).toEqual([
        focusLabel(entry),
        null,
      ]);
    }
    expect(validFocusEntries(FOCUS_LIST)).toHaveLength(FOCUS_LIST.length);
  });

  test("every note falls inside its own clef's pool", () => {
    for (const entry of FOCUS_LIST.filter((e) => e.kind === "note")) {
      const names = pitchPool(entry.clef).map((p) => p.name);
      expect(names).toContain(entry.name);
      expect(parseNoteName(entry.name)).not.toBeNull();
    }
  });

  test("every chord names a real root and quality", () => {
    for (const entry of FOCUS_LIST.filter((e) => e.kind === "chord")) {
      expect(ROOTS).toContain(entry.root);
      expect(CHORD_TYPE_IDS).toContain(entry.quality);
    }
  });

  test("C4 is listed under both clefs, deliberately", () => {
    const c4 = FOCUS_LIST.filter((e) => e.kind === "note" && e.name === "C4");
    expect(c4.map((e) => e.clef).sort()).toEqual(["bass", "treble"]);
  });
});

describe("focusEntryError", () => {
  const good = { kind: "note", clef: "treble", name: "E4" };

  test("a valid note and a valid chord pass", () => {
    expect(focusEntryError(good)).toBeNull();
    expect(
      focusEntryError({ kind: "chord", clef: "bass", root: "Bb", quality: "minor7" })
    ).toBeNull();
  });

  test("a missing or unknown clef is rejected", () => {
    expect(focusEntryError({ ...good, clef: undefined })).toMatch(/clef/);
    expect(focusEntryError({ ...good, clef: "alto" })).toMatch(/clef/);
  });

  test("a pitch outside the clef's own pool is rejected", () => {
    // C2 is fine in bass and out of range in treble (pool starts at B3).
    expect(focusEntryError({ kind: "note", clef: "bass", name: "C2" })).toBeNull();
    expect(focusEntryError({ kind: "note", clef: "treble", name: "C2" })).toMatch(
      new RegExp(CLEF_RANGES.treble.poolLo)
    );
  });

  test("a flat-spelled note is rejected even when the pitch is in range", () => {
    expect(focusEntryError({ kind: "note", clef: "treble", name: "Gb4" })).toMatch(
      /outside the treble pool/
    );
    expect(focusEntryError({ kind: "note", clef: "treble", name: "F#4" })).toBeNull();
  });

  test("bad kinds, names, roots and qualities are rejected", () => {
    expect(focusEntryError({ ...good, kind: "scale" })).toMatch(/kind/);
    expect(focusEntryError({ ...good, name: "H4" })).toMatch(/note name/);
    expect(
      focusEntryError({ kind: "chord", clef: "bass", root: "Db", quality: "major" })
    ).toMatch(/root/);
    expect(
      focusEntryError({ kind: "chord", clef: "bass", root: "C", quality: "sus4" })
    ).toMatch(/quality/);
  });
});

describe("validFocusEntries", () => {
  test("drops bad entries and reports each one", () => {
    const dropped = [];
    const kept = validFocusEntries(
      [
        { kind: "note", clef: "treble", name: "E4" },
        { kind: "note", clef: "treble", name: "C2" },
        null,
      ],
      (entry, reason) => dropped.push(reason)
    );
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(2);
  });

  test("a non-array is an empty list, not a throw", () => {
    expect(validFocusEntries(undefined)).toEqual([]);
  });
});

describe("makeFocusPrompt", () => {
  const labels = FOCUS_LIST.map(focusLabel);

  test("asks only about the list, and takes the clef from the entry", () => {
    const rng = seededRng(4242);
    for (let i = 0; i < 300; i++) {
      const prompt = makeFocusPrompt({ focusList: FOCUS_LIST, rng });
      expect(labels).toContain(prompt.label);
      // By LABEL rather than by identity: C4 is listed under both clefs, so a
      // label alone does not name one entry.
      const clefs = FOCUS_LIST.filter((e) => focusLabel(e) === prompt.label).map(
        (e) => e.clef
      );
      expect(clefs).toContain(prompt.clef);
      expect(prompt.options).toContain(prompt.label);
      expect(new Set(prompt.options).size).toBe(4);
    }
  });

  test("wrong answers are NOT limited to the list", () => {
    const rng = seededRng(99);
    const seen = new Set();
    for (let i = 0; i < 300; i++) {
      for (const option of makeFocusPrompt({ focusList: FOCUS_LIST, rng }).options) {
        seen.add(option);
      }
    }
    const outside = [...seen].filter((o) => !labels.includes(o));
    expect(outside.length).toBeGreaterThan(10);
  });

  test("a missed entry comes up more often", () => {
    const list = [
      { kind: "note", clef: "treble", name: "E4" },
      { kind: "note", clef: "treble", name: "F5" },
    ];
    const rng = seededRng(17);
    let missed = 0;
    for (let i = 0; i < 400; i++) {
      const prompt = makeFocusPrompt({ focusList: list, missTally: { F5: 4 }, rng });
      if (prompt.label === "F5") missed++;
    }
    expect(missed).toBeGreaterThan(280); // weight 9 against 1
  });

  test("chords are placed on the entry's clef and named correctly", () => {
    const list = [{ kind: "chord", clef: "bass", root: "Bb", quality: "minor7" }];
    const prompt = makeFocusPrompt({ focusList: list, rng: seededRng(8) });
    expect(prompt.label).toBe(chordName("Bb", "minor7"));
    expect(prompt.clef).toBe("bass");
    expect(prompt.chord).toEqual({ root: "Bb", quality: "minor7", octave: expect.any(Number) });
    expect(prompt.event.notes.map((n) => n.name)).toEqual(["Bb2", "Db3", "F3", "Ab3"]);
  });
});

describe("makePrompt — focus mode", () => {
  test("routes to the focus list", () => {
    const rng = seededRng(55);
    const list = [{ kind: "note", clef: "bass", name: "C2" }];
    for (let i = 0; i < 20; i++) {
      // clefMode is deliberately wrong for the entry: focus ignores it.
      const prompt = makePrompt({ mode: "focus", clefMode: "treble", focusList: list, rng });
      expect(prompt.label).toBe("C2");
      expect(prompt.clef).toBe("bass");
    }
  });

  test("an empty focus list behaves as mix rather than throwing", () => {
    const rng = seededRng(66);
    let chords = 0;
    for (let i = 0; i < 100; i++) {
      const prompt = makePrompt({ mode: "focus", focusList: [], rng });
      expect(prompt.options).toContain(prompt.label);
      if (prompt.chord) chords++;
    }
    expect(chords).toBeGreaterThan(20);
  });
});
