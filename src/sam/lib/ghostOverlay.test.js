// The pure comparison functions behind the ghost overlay.
//
// Drawing is judged by screenshot, but WHAT gets drawn is arithmetic and is
// tested here — a ghost in the wrong place, or a ghost that should not exist,
// makes the overlay lie about what the simplifier did.

import { handNotesWithBeats, removedRhNotes, lhUnchanged } from "./ghostOverlay";

const n = (midi, name) => ({ midi, name });
const ev = (duration, notes, extra) => ({ duration, notes, ...extra });

describe("handNotesWithBeats", () => {
  test("accumulates beat offsets across events", () => {
    const lh = [ev("q", [n(48, "C3")]), ev("8", [n(50, "D3")]), ev("8", [n(52, "E3")])];
    expect(handNotesWithBeats(lh)).toEqual([
      { beat: 0, midi: 48, name: "C3" },
      { beat: 1, midi: 50, name: "D3" },
      { beat: 1.5, midi: 52, name: "E3" },
    ]);
  });

  test("a chord puts every note at the same beat", () => {
    const lh = [ev("h", [n(48, "C3"), n(52, "E3"), n(55, "G3")])];
    expect(handNotesWithBeats(lh).map((x) => x.beat)).toEqual([0, 0, 0]);
  });

  test("rests advance the beat but contribute no notes", () => {
    const lh = [ev("q", []), ev("q", [n(48, "C3")])];
    expect(handNotesWithBeats(lh)).toEqual([{ beat: 1, midi: 48, name: "C3" }]);
  });

  test("tuplets scale by normal/actual, so a triplet group spans one beat", () => {
    const t = { actual: 3, normal: 2 };
    const lh = [
      ev("8", [n(48, "C3")], { tuplet: t }),
      ev("8", [n(50, "D3")], { tuplet: t }),
      ev("8", [n(52, "E3")], { tuplet: t }),
      ev("q", [n(53, "F3")]),
    ];
    const beats = handNotesWithBeats(lh).map((x) => Number(x.beat.toFixed(4)));
    expect(beats).toEqual([0, 0.3333, 0.6667, 1]);
  });

  test("an empty or missing hand yields nothing", () => {
    expect(handNotesWithBeats([])).toEqual([]);
    expect(handNotesWithBeats(undefined)).toEqual([]);
  });
});

describe("removedRhNotes", () => {
  test("reports parent notes the child dropped, with their event index", () => {
    const parent = { rh: [ev("q", [n(60, "C4"), n(64, "E4"), n(67, "G4")])] };
    const child = { rh: [ev("q", [n(67, "G4")])] };
    expect(removedRhNotes(parent, child)).toEqual([
      { index: 0, midi: 60, name: "C4" },
      { index: 0, midi: 64, name: "E4" },
    ]);
  });

  test("an untouched RH reports nothing — a kept note is not a ghost", () => {
    const m = { rh: [ev("q", [n(60, "C4"), n(64, "E4")])] };
    expect(removedRhNotes(m, m)).toEqual([]);
  });

  test("indices are the event's own, so ghosts land on the right event", () => {
    const parent = {
      rh: [ev("q", [n(60, "C4")]), ev("q", [n(62, "D4"), n(69, "A4")])],
    };
    const child = { rh: [ev("q", [n(60, "C4")]), ev("q", [n(69, "A4")])] };
    expect(removedRhNotes(parent, child)).toEqual([{ index: 1, midi: 62, name: "D4" }]);
  });

  test("a missing child event is skipped rather than realigned by guesswork", () => {
    const parent = { rh: [ev("q", [n(60, "C4")]), ev("q", [n(62, "D4")])] };
    const child = { rh: [ev("q", [n(60, "C4")])] };
    expect(removedRhNotes(parent, child)).toEqual([]);
  });
});

describe("lhUnchanged", () => {
  test("true when both hands agree on every beat and pitch", () => {
    const m = { lh: [ev("q", [n(48, "C3")]), ev("q", [n(55, "G3")])] };
    expect(lhUnchanged(m, JSON.parse(JSON.stringify(m)))).toBe(true);
  });

  test("false when quantization changed the onsets", () => {
    const parent = {
      lh: [ev("16", [n(48, "C3")]), ev("16", [n(52, "E3")]),
           ev("16", [n(55, "G3")]), ev("16", [n(52, "E3")])],
    };
    const child = { lh: [ev("q", [n(48, "C3")])] };
    expect(lhUnchanged(parent, child)).toBe(false);
  });

  test("false when a pitch changed at the same beat", () => {
    const parent = { lh: [ev("q", [n(48, "C3")])] };
    const child = { lh: [ev("q", [n(50, "D3")])] };
    expect(lhUnchanged(parent, child)).toBe(false);
  });

  test("an unchanged LH is what suppresses a halo on every notehead", () => {
    // Two of the four calibration songs never transform the LH. Without this
    // guard each would draw a halo around all 680 / 1127 of its LH notes to
    // say "nothing changed" — the layer would be pure noise.
    const m = { lh: [ev("8", [n(39, "Eb2")]), ev("8", [n(46, "Bb2")])] };
    expect(lhUnchanged(m, JSON.parse(JSON.stringify(m)))).toBe(true);
  });
});
