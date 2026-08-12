// Error / warning split in the document validator.
//
// The contract this pins down: a duration-sum mismatch must NOT block an
// import (it is routed through the M8 approval gate instead), while anything
// that makes a document unstorable or self-contradictory must still be a hard
// reject. Getting this backwards either blocks every round trip of an
// already-mangled song, or lets genuinely broken documents into the database.

import { validateSongDocument } from "./songSchema";

const note = (midi, name) => ({ midi, name });

function doc(measures) {
  return { title: "T", measures };
}

// A well-formed 4/4 measure: four quarter notes in each hand.
function fullMeasure(number = 1) {
  const q = (midi, name) => ({ duration: "q", notes: [note(midi, name)] });
  return {
    number,
    timeSignature: { beats: 4, beatType: 4 },
    rh: [q(72, "C5"), q(74, "D5"), q(76, "E5"), q(77, "F5")],
    lh: [q(48, "C3"), q(50, "D3"), q(52, "E3"), q(53, "F3")],
  };
}

describe("errors — these still block the import", () => {
  test("structural failure is an error", () => {
    const bad = doc([{ number: 1, timeSignature: { beats: 4, beatType: 4 }, rh: [] }]); // no lh
    const { valid, errors, warnings } = validateSongDocument(bad);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
    expect(warnings).toEqual([]);
  });

  test("legacy beats[] is an error", () => {
    const m = fullMeasure();
    const { valid, errors } = validateSongDocument(doc([{ ...m, beats: [] }]));
    expect(valid).toBe(false);
    expect(errors.join(" ")).toMatch(/beats/);
  });

  test("inline lyric is an error", () => {
    const m = fullMeasure();
    m.rh[0] = { ...m.rh[0], lyric: "la" };
    const { valid, errors } = validateSongDocument(doc([m]));
    expect(valid).toBe(false);
    expect(errors.join(" ")).toMatch(/lyric/);
  });

  test("midi/name disagreement is an error, not a warning", () => {
    const m = fullMeasure();
    m.rh[0] = { duration: "q", notes: [note(72, "D5")] }; // 72 is C5
    const { valid, errors } = validateSongDocument(doc([m]));
    expect(valid).toBe(false);
    expect(errors.join(" ")).toMatch(/does not agree/);
  });
});

describe("warnings — these no longer block", () => {
  test("an overlong hand is a warning and the document stays valid", () => {
    const m = fullMeasure();
    m.rh.push({ duration: "h", notes: [note(79, "G5")] }); // 4 + 2 = 6 beats
    const { valid, errors, warnings } = validateSongDocument(doc([m]));

    expect(valid).toBe(true);
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      kind: "overflow",
      measureIndex: 0,
      measureNumber: 1,
      hand: "rh",
      beats: 6,
      expected: 4,
    });
    expect(warnings[0].message).toMatch(/sum to 6 beats/);
  });

  test("a short hand warns as truncated", () => {
    const m = fullMeasure();
    m.lh.pop(); // 3 beats
    const { valid, warnings } = validateSongDocument(doc([m]));
    expect(valid).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ kind: "truncated", hand: "lh", beats: 3, expected: 4 });
  });

  test("both hands wrong in one measure produce two warnings", () => {
    const m = fullMeasure();
    m.rh.push({ duration: "q", notes: [] });
    m.lh.push({ duration: "q", notes: [] });
    const { valid, warnings } = validateSongDocument(doc([m]));
    expect(valid).toBe(true);
    expect(warnings.map((w) => w.hand)).toEqual(["rh", "lh"]);
  });

  test("a tuplet measure is still exempt entirely", () => {
    const m = fullMeasure();
    m.rh = [
      { duration: "8", notes: [note(72, "C5")], tuplet: { actual: 3, normal: 2 } },
      { duration: "8", notes: [note(74, "D5")], tuplet: { actual: 3, normal: 2 } },
      { duration: "8", notes: [note(76, "E5")], tuplet: { actual: 3, normal: 2 } },
    ];
    const { valid, errors, warnings } = validateSongDocument(doc([m]));
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("a clean document warns about nothing", () => {
    const { valid, errors, warnings } = validateSongDocument(doc([fullMeasure()]));
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("errors and warnings coexist — an error still blocks", () => {
    const m = fullMeasure();
    m.rh[0] = { duration: "q", notes: [note(72, "D5")] }; // bad midi/name
    m.lh.pop(); // and a short hand
    const { valid, errors, warnings } = validateSongDocument(doc([m]));
    expect(valid).toBe(false);
    expect(errors.join(" ")).toMatch(/does not agree/);
    expect(warnings).toHaveLength(1);
  });
});
