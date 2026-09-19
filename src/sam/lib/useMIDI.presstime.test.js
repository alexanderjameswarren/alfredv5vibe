// The chord's press time reaches the scorer (2026-09-19).
//
// A chord is delivered on a setTimeout `chordGroupMs` after its LAST key.
// Scoring used to measure the offset at that moment, so every event carried
// ~80 ms of built-in lateness — more whenever the main thread was busy, which
// is worst at a loop restart. useMIDI now stamps the arrival of the FIRST key
// of the chord and hands it over with the notes.

import { renderHook, act } from "@testing-library/react";
import useMIDI from "./useMIDI";

// One fake MIDI input we can push messages into.
function fakeAccess() {
  const input = { name: "Fake Piano", onmidimessage: null };
  return {
    access: { inputs: new Map([["a", input]]), onstatechange: null },
    send: (note) => input.onmidimessage({ data: [0x90, note, 100] }),
  };
}

const noteOn = (note) => ({ data: [0x90, note, 100] });

let clock;
beforeEach(() => {
  jest.useFakeTimers();
  clock = 1000;
  jest.spyOn(performance, "now").mockImplementation(() => clock);
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function mountWith(onChord) {
  const f = fakeAccess();
  navigator.requestMIDIAccess = jest.fn().mockResolvedValue(f.access);
  const hook = renderHook(() => useMIDI({ onChord, chordGroupMs: 80 }));
  await act(async () => { await Promise.resolve(); });
  return { ...f, hook, input: f.access.inputs.get("a") };
}

test("the chord carries when its FIRST key arrived, not when it flushed", async () => {
  const onChord = jest.fn();
  const { input } = await mountWith(onChord);

  clock = 2000;
  act(() => { input.onmidimessage(noteOn(60)); });
  clock = 2030;                       // the chord rolled by 30 ms
  act(() => { input.onmidimessage(noteOn(64)); });
  clock = 2110;                       // ...and flushes 80 ms after the last key
  act(() => { jest.advanceTimersByTime(80); });

  expect(onChord).toHaveBeenCalledTimes(1);
  const [notes, pressedAtMs] = onChord.mock.calls[0];
  expect(notes).toEqual([60, 64]);
  // The struck instant, not the flush instant 110 ms later.
  expect(pressedAtMs).toBe(2000);
});

test("each chord gets its own press time", async () => {
  const onChord = jest.fn();
  const { input } = await mountWith(onChord);

  clock = 3000;
  act(() => { input.onmidimessage(noteOn(60)); });
  act(() => { jest.advanceTimersByTime(80); });

  clock = 5000;
  act(() => { input.onmidimessage(noteOn(67)); });
  act(() => { jest.advanceTimersByTime(80); });

  expect(onChord.mock.calls.map((c) => c[1])).toEqual([3000, 5000]);
});

test("messages that are not a struck note leave the press time alone", async () => {
  const onChord = jest.fn();
  const { input } = await mountWith(onChord);

  clock = 4000;
  act(() => { input.onmidimessage({ data: [0x80, 60, 0] }); });   // note off
  act(() => { input.onmidimessage({ data: [0x90, 60, 0] }); });   // note on, velocity 0
  act(() => { input.onmidimessage({ data: [0xF8] }); });          // clock tick
  expect(onChord).not.toHaveBeenCalled();

  clock = 4200;
  act(() => { input.onmidimessage(noteOn(62)); });
  act(() => { jest.advanceTimersByTime(80); });
  expect(onChord.mock.calls[0][1]).toBe(4200);
});
