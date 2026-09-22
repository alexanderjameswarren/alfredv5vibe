// Held keys — practice mode's resume signal (2026-09-22).
//
// Note Off exists nowhere else in SAM: the scoring path has always thrown it
// away. Practice needs to know which keys are DOWN AT THE SAME MOMENT, so
// useMIDI now maintains a Set — but only while a listener is attached, which is
// only while a Practice run is in flight. The last test here is the one that
// matters most for Play: with no listener, nothing about the old path changes.

import { renderHook, act } from "@testing-library/react";
import useMIDI from "./useMIDI";

const noteOn = (note, velocity = 100) => ({ data: [0x90, note, velocity] });
const noteOff = (note) => ({ data: [0x80, note, 0] });
// Plenty of keyboards send this instead of a real Note Off.
const noteOnZero = (note) => ({ data: [0x90, note, 0] });
const sustain = (value) => ({ data: [0xB0, 64, value] });

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

async function mount(opts) {
  const input = { name: "Fake Piano", onmidimessage: null };
  const access = { inputs: new Map([["a", input]]), onstatechange: null };
  navigator.requestMIDIAccess = jest.fn().mockResolvedValue(access);
  const hook = renderHook(() => useMIDI({ chordGroupMs: 80, ...opts }));
  await act(async () => { await Promise.resolve(); });
  return { hook, input };
}

// The live Set is handed over, so a snapshot has to be taken at call time.
function heldSpy() {
  const seen = [];
  const fn = jest.fn((held) => seen.push([...held].sort((a, b) => a - b)));
  fn.seen = seen;
  fn.last = () => seen[seen.length - 1];
  return fn;
}

test("keys accumulate while down and leave on release", async () => {
  const onHeldKeys = heldSpy();
  const { input } = await mount({ onHeldKeys });

  act(() => { input.onmidimessage(noteOn(60)); });
  expect(onHeldKeys.last()).toEqual([60]);

  act(() => { input.onmidimessage(noteOn(67)); });
  act(() => { input.onmidimessage(noteOn(64)); });
  // Order of pressing does not matter — it is a set.
  expect(onHeldKeys.last()).toEqual([60, 64, 67]);

  act(() => { input.onmidimessage(noteOff(64)); });
  expect(onHeldKeys.last()).toEqual([60, 67]);

  act(() => { input.onmidimessage(noteOff(60)); });
  act(() => { input.onmidimessage(noteOff(67)); });
  expect(onHeldKeys.last()).toEqual([]);
});

test("a Note On with velocity 0 is a release, not a press", async () => {
  const onHeldKeys = heldSpy();
  const { input } = await mount({ onHeldKeys });

  act(() => { input.onmidimessage(noteOn(60)); });
  act(() => { input.onmidimessage(noteOnZero(60)); });
  expect(onHeldKeys.last()).toEqual([]);
});

test("the sustain pedal is ignored: held means fingers", async () => {
  const onHeldKeys = heldSpy();
  const { input } = await mount({ onHeldKeys });

  act(() => { input.onmidimessage(noteOn(60)); });
  act(() => { input.onmidimessage(sustain(127)); });   // pedal down
  act(() => { input.onmidimessage(noteOff(60)); });    // finger lifts, pedal still down

  // The pedal neither added a key nor kept one.
  expect(onHeldKeys.last()).toEqual([]);
  expect(onHeldKeys.seen).toEqual([[60], []]);
});

test("the listener fires AFTER the chord buffer, so a resume can cancel the group", async () => {
  // The ordering the resume depends on: by the time the listener runs, the key
  // that completed the chord is already in the buffer, so cancelling the group
  // from inside the listener removes it. The other order would let that key be
  // re-buffered and graded against the beat the run had just moved on to.
  const onChord = jest.fn();
  let cancel = null;
  const onHeldKeys = jest.fn(() => cancel());
  const { hook, input } = await mount({ onChord, onHeldKeys });
  cancel = hook.result.current.cancelPendingChord;

  act(() => { input.onmidimessage(noteOn(60)); });
  act(() => { jest.advanceTimersByTime(200); });

  expect(onHeldKeys).toHaveBeenCalled();
  expect(onChord).not.toHaveBeenCalled();
});

test("cancelPendingChord drops a group that has not flushed yet", async () => {
  const onChord = jest.fn();
  const { hook, input } = await mount({ onChord });

  act(() => { input.onmidimessage(noteOn(60)); });
  act(() => { hook.result.current.cancelPendingChord(); });
  act(() => { jest.advanceTimersByTime(200); });
  expect(onChord).not.toHaveBeenCalled();

  // And the next chord is unaffected — the buffer is clean, not broken.
  act(() => { input.onmidimessage(noteOn(64)); });
  act(() => { jest.advanceTimersByTime(80); });
  expect(onChord).toHaveBeenCalledWith([64], expect.any(Number));
});

test("resetHeldKeys clears a key whose release was lost", async () => {
  const onHeldKeys = heldSpy();
  const { hook, input } = await mount({ onHeldKeys });

  act(() => { input.onmidimessage(noteOn(60)); });
  act(() => { hook.result.current.resetHeldKeys(); });
  act(() => { input.onmidimessage(noteOn(64)); });

  expect(onHeldKeys.last()).toEqual([64]);
});

// --- Play's path is untouched -------------------------------------------------

test("with no listener attached, nothing about the old handler changes", async () => {
  const onChord = jest.fn();
  const { input } = await mount({ onChord });   // no onHeldKeys — this is Play

  act(() => { input.onmidimessage(noteOff(60)); });
  act(() => { input.onmidimessage(noteOnZero(62)); });
  act(() => { input.onmidimessage(sustain(127)); });
  act(() => { input.onmidimessage({ data: [0xF8] }); });
  act(() => { jest.advanceTimersByTime(200); });
  // None of those is a struck key, so none of them scores.
  expect(onChord).not.toHaveBeenCalled();

  clock = 2000;
  act(() => { input.onmidimessage(noteOn(60)); });
  act(() => { input.onmidimessage(noteOn(64)); });
  act(() => { jest.advanceTimersByTime(80); });
  expect(onChord).toHaveBeenCalledTimes(1);
  expect(onChord).toHaveBeenCalledWith([60, 64], 2000);
});
