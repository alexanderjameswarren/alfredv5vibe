// M5 — one notehead per staff position.
//
// The continuation rule keeps same-pitch pairs in the DATA on purpose; this is
// the render layer collapsing them so VexFlow draws one notehead instead of two
// overlapping ones. The data must come through untouched — that is the whole
// point of fixing it here rather than upstream.

import { toVexKeys, tieEndpoints } from "./vexflowHelpers";

const note = (midi, name, tie) => (tie ? { midi, name, tie } : { midi, name });

describe("toVexKeys", () => {
  test("an ordinary chord is unchanged", () => {
    const notes = [note(60, "C4"), note(64, "E4"), note(67, "G4")];
    const { keys, heads, keyIndexFor } = toVexKeys(notes);
    expect(keys).toEqual(["c/4", "e/4", "g/4"]);
    expect(heads).toEqual(notes);
    expect(keyIndexFor).toEqual([0, 1, 2]);
  });

  test("Moonlight m60: C#4 + C#4:end collapses to one notehead", () => {
    const notes = [note(61, "C#4"), note(61, "C#4", "end")];
    const { keys, heads, keyIndexFor } = toVexKeys(notes);
    expect(keys).toEqual(["c#/4"]);
    expect(heads).toHaveLength(1);
    expect(keyIndexFor).toEqual([0, 0]);
  });

  test("Someone Like You m27: F#4 + F#4:end collapses too", () => {
    const { keys, keyIndexFor } = toVexKeys([
      note(66, "F#4"), note(66, "F#4", "end"),
    ]);
    expect(keys).toEqual(["f#/4"]);
    expect(keyIndexFor).toEqual([0, 0]);
  });

  test("the collapsed pair keeps its neighbours in a chord", () => {
    const { keys, keyIndexFor } = toVexKeys([
      note(57, "A3"), note(61, "C#4"), note(61, "C#4", "end"), note(64, "E4"),
    ]);
    expect(keys).toEqual(["a/3", "c#/4", "e/4"]);
    expect(keyIndexFor).toEqual([0, 1, 1, 2]);
  });

  test("an enharmonic pair is TWO noteheads, not one", () => {
    // C#4 and Db4 are both midi 61 but sit on different staff lines. Collapsing
    // on `midi` would lose a notehead; collapsing on the key string does not.
    const { keys, keyIndexFor } = toVexKeys([note(61, "C#4"), note(61, "Db4")]);
    expect(keys).toEqual(["c#/4", "db/4"]);
    expect(keyIndexFor).toEqual([0, 1]);
  });

  test("the same pitch in different octaves stays distinct", () => {
    const { keys } = toVexKeys([note(61, "C#4"), note(73, "C#5")]);
    expect(keys).toEqual(["c#/4", "c#/5"]);
  });

  test("three copies of one pitch still yield one notehead", () => {
    const { keys, keyIndexFor } = toVexKeys([
      note(61, "C#4"), note(61, "C#4", "end"), note(61, "C#4", "both"),
    ]);
    expect(keys).toEqual(["c#/4"]);
    expect(keyIndexFor).toEqual([0, 0, 0]);
  });

  test("the first copy is the head, so its accidental is the one drawn", () => {
    const first = note(61, "C#4");
    const { heads } = toVexKeys([first, note(61, "C#4", "end")]);
    expect(heads[0]).toBe(first);
  });

  test("does not mutate or copy the input notes", () => {
    const notes = [note(61, "C#4"), note(61, "C#4", "end")];
    const before = JSON.stringify(notes);
    toVexKeys(notes);
    expect(JSON.stringify(notes)).toBe(before);
  });

  test("empty and missing input are safe", () => {
    expect(toVexKeys([])).toEqual({ keys: [], heads: [], keyIndexFor: [] });
    expect(toVexKeys(undefined)).toEqual({ keys: [], heads: [], keyIndexFor: [] });
  });
});

describe("tieEndpoints", () => {
  const endpointsFor = (notes) => {
    const { keyIndexFor } = toVexKeys(notes);
    return tieEndpoints(notes, keyIndexFor);
  };

  test("a tie on a collapsed pair attaches to the surviving notehead", () => {
    // Moonlight m60. The arc from the previous measure must land on key 0 —
    // the notehead that is actually drawn.
    const { starts, ends } = endpointsFor([note(61, "C#4"), note(61, "C#4", "end")]);
    expect(starts).toEqual([]);
    expect(ends).toEqual([{ keyIdx: 0, midi: 61 }]);
  });

  test("a notehead can both receive and start a tie", () => {
    const { starts, ends } = endpointsFor([
      note(65, "F4", "end"), note(65, "F4", "start"),
    ]);
    expect(ends).toEqual([{ keyIdx: 0, midi: 65 }]);
    expect(starts).toEqual([{ keyIdx: 0, midi: 65 }]);
  });

  test("two copies carrying the same tie produce ONE endpoint", () => {
    // Feeding VexFlow's StaveTie the same index twice draws the arc twice.
    const { starts } = endpointsFor([
      note(65, "F4", "start"), note(65, "F4", "start"),
    ]);
    expect(starts).toEqual([{ keyIdx: 0, midi: 65 }]);
  });

  test("'both' counts as each direction once", () => {
    const { starts, ends } = endpointsFor([note(61, "C#4", "both")]);
    expect(starts).toEqual([{ keyIdx: 0, midi: 61 }]);
    expect(ends).toEqual([{ keyIdx: 0, midi: 61 }]);
  });

  test("indices track the collapse in a chord", () => {
    const notes = [
      note(57, "A3", "start"),
      note(61, "C#4"),
      note(61, "C#4", "end"),
      note(64, "E4", "start"),
    ];
    const { starts, ends } = endpointsFor(notes);
    expect(starts).toEqual([
      { keyIdx: 0, midi: 57 },
      { keyIdx: 2, midi: 64 },   // E4 shifted down from index 3 by the collapse
    ]);
    expect(ends).toEqual([{ keyIdx: 1, midi: 61 }]);
  });

  test("untied notes produce nothing", () => {
    const { starts, ends } = endpointsFor([note(60, "C4"), note(64, "E4")]);
    expect(starts).toEqual([]);
    expect(ends).toEqual([]);
  });
});
