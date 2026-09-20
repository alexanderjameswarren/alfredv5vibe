// Where the music ends, when rest bars follow it (2026-09-20).
//
// A looped snippet with rest measures used to bank its pass only at the loop
// teleport — a whole bar after the last note — so the pass counter and the
// plan line sat still while he was already resting.

import { restStartIndex, contentEndTime } from "./contentEnd";

// m.15 and m.16 are the music; 17 and 18 are appended rests, numbered past the
// snippet's end exactly as SamPlayer's activeMeasures builds them.
const MUSIC = [{ number: 15 }, { number: 16 }];
const REST = [{ number: 17 }, { number: 18 }];

// Two beats per bar, at 1000 ms each.
const evts = (measureNumbers) =>
  measureNumbers.flatMap((n, i) => [
    { meas: n, beat: 1, targetTimeMs: i * 2000, allMidi: [60] },
    { meas: n, beat: 2, targetTimeMs: i * 2000 + 1000, allMidi: [60] },
  ]);

describe("restStartIndex", () => {
  test("finds the first beat of the first appended rest bar", () => {
    const events = evts([15, 16, 17, 18]);
    // Four beats of music, so the rest begins at index 4.
    expect(restStartIndex(events, [...MUSIC, ...REST], 2, 8)).toBe(4);
  });

  test("one rest bar, the common case", () => {
    const events = evts([15, 16, 17]);
    expect(restStartIndex(events, [...MUSIC, REST[0]], 1, 6)).toBe(4);
  });

  test("null when no rest bars were appended: the credit stays at the teleport", () => {
    const events = evts([15, 16]);
    expect(restStartIndex(events, MUSIC, 0, 4)).toBeNull();
    expect(restStartIndex(events, MUSIC, undefined, 4)).toBeNull();
  });

  test("only the first copy is searched", () => {
    // Three copies of [15, 16, 17] — the looping layout.
    const one = [15, 16, 17];
    const events = evts([...one, ...one, ...one]);
    expect(restStartIndex(events, [...MUSIC, REST[0]], 1, 6)).toBe(4);
  });

  test("null rather than a wrong answer when the boundary makes no sense", () => {
    // Rest count covers everything: there is no music to finish.
    expect(restStartIndex(evts([17]), [REST[0]], 1, 2)).toBeNull();
    // A measure list that does not match the events.
    expect(restStartIndex(evts([15, 16]), [...MUSIC, { number: 99 }], 1, 4)).toBeNull();
    // Rubbish in, null out — never a throw.
    expect(restStartIndex(null, MUSIC, 1, 4)).toBeNull();
    expect(restStartIndex(evts([15]), null, 1, 2)).toBeNull();
    expect(restStartIndex(evts([15, 16]), [...MUSIC, { number: null }], 1, 4)).toBeNull();
  });
});

describe("contentEndTime", () => {
  test("normally the first rest beat's own target", () => {
    const events = evts([15, 16, 17]);
    // Rest bar starts at 4000; the last musical beat is at 3000 and its grace
    // expires at 3300, which is earlier.
    expect(contentEndTime(events, 4, 300)).toBe(4000);
  });

  test("waits for the last note's grace when a short final note outlasts the barline", () => {
    // An eighth at a fast tempo: the last beat sits 100 ms before the barline,
    // so its 300 ms window runs 200 ms past it. Crediting at the barline could
    // miss a hit the player was still allowed to land.
    const events = [
      { meas: 15, beat: 1, targetTimeMs: 0 },
      { meas: 15, beat: 1.5, targetTimeMs: 900 },
      { meas: 16, beat: 1, targetTimeMs: 1000 },
    ];
    expect(contentEndTime(events, 2, 300)).toBe(1200);
  });

  test("a zero window credits at the barline", () => {
    const events = evts([15, 16, 17]);
    expect(contentEndTime(events, 4, 0)).toBe(4000);
    expect(contentEndTime(events, 4, undefined)).toBe(4000);
  });

  test("null when the boundary beat is not there", () => {
    expect(contentEndTime(evts([15]), 9, 300)).toBeNull();
    expect(contentEndTime(null, 0, 300)).toBeNull();
  });

  test("a boundary with no music before it falls back to its own target", () => {
    const events = [{ meas: 17, beat: 1, targetTimeMs: 500 }];
    expect(contentEndTime(events, 0, 300)).toBe(500);
  });
});
