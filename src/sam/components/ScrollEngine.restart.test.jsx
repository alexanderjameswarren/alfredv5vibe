// When the scroll restarts, and with how long a lead-in (sam_tempo, 2026-10-27).
// The real engine, driven frame by frame; only VexFlow drawing is stubbed.

import React from "react";
import { render, act } from "@testing-library/react";

jest.mock("../lib/scoreRender", () => ({
  playClick: () => {},
  // Four beats a measure, 300px apart per measure, the first 30px in.
  renderCopy: (VF, ctx, measures, c, xStart, w, durations, starts) => {
    const beatMeta = [];
    measures.forEach((m, mi) => {
      for (let b = 0; b < 4; b++) {
        const x = xStart + mi * 300 + 30 + b * 60;
        beatMeta.push({
          meas: m.number, beat: b + 1, musicalBeatInCopy: starts[mi] + b, beatPos: starts[mi] + b,
          allMidi: [60], rhMidi: [60], lhMidi: [],
          trebleNote: { getAbsoluteX: () => x, getXShift: () => 0 },
        });
      }
    });
    return { beatMeta, geometry: [], labelEls: [] };
  },
}));
jest.mock("../lib/vexflowHelpers", () => ({ getMeasureWidth: () => 300, colorBeatEls: () => {} }));
jest.mock("../lib/fingeringOverlay", () => ({ drawFingeringOverlay: () => {} }));
jest.mock("../lib/synthVoice", () => ({ playNote: () => {}, midiToFreq: () => 440, getMasterBus: () => null }));

const { default: ScrollEngine } = require("./ScrollEngine");

const MEASURES = [1, 2].map((number) => ({ number, timeSignature: { beats: 4, beatType: 4 } }));

let clock = 0;
let frames = [];
let events = [];
const ext = { current: null };
const atWrap = { current: false };
const onScrollStart = jest.fn();
const onLoopCount = jest.fn();

beforeEach(() => {
  clock = 1000;
  frames = [];
  events = [];
  ext.current = null;
  atWrap.current = false;
  onScrollStart.mockClear();
  onLoopCount.mockClear();
  window.Vex = {
    Flow: {
      Renderer: Object.assign(
        function Renderer() { return { resize() {}, getContext: () => ({ scale() {} }) }; },
        { Backends: { SVG: 1 } }
      ),
    },
  };
  jest.spyOn(performance, "now").mockImplementation(() => clock);
  window.requestAnimationFrame = (cb) => frames.push(cb);
  window.cancelAnimationFrame = () => {};
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  delete window.Vex;
});

function engine(props) {
  return (
    <ScrollEngine
      measures={MEASURES} bpm={60} playbackState="playing" measureWidth={300} loop
      scrollStateExtRef={ext} onScrollStart={onScrollStart} onLoopCount={onLoopCount}
      continueAtWrapRef={atWrap}
      onBeatEvents={(e) => { events = e; }}
      {...props}
    />
  );
}

// Run frames, 16ms apart, until `done` is true.
function runUntil(done, limitMs = 60000) {
  const end = clock + limitMs;
  act(() => {
    while (!done() && clock < end) {
      clock += 16;
      const due = frames.splice(0);
      due.forEach((cb) => cb(clock));
    }
  });
}

// How long the current run's approach to its start beat lasts, in ms.
function leadInMs(startIdx = 0) {
  const s = ext.current;
  return (events[startIdx].xPx - s.targetX - s.originPx) / s.pxPerMs;
}

test("clearing the resume bar mid-run does not restart the scroll", () => {
  const { rerender } = render(engine({ firstPassStart: 1 }));
  expect(onScrollStart).toHaveBeenCalledTimes(1);
  expect(leadInMs(4)).toBeGreaterThanOrEqual(3000);
  rerender(engine({ firstPassStart: 0 }));
  expect(onScrollStart).toHaveBeenCalledTimes(1);
});

test("Resume still restarts, from the bar it is given", () => {
  const { rerender } = render(engine({ firstPassStart: 0 }));
  rerender(engine({ firstPassStart: 1, playbackState: "paused" }));
  rerender(engine({ firstPassStart: 1, playbackState: "playing" }));
  expect(onScrollStart).toHaveBeenCalledTimes(2);
  expect(leadInMs(4)).toBeGreaterThanOrEqual(3000);
});

const wrapped = () => onLoopCount.mock.calls.some(([n]) => n === 1);

test("a rung tempo signalled at the wrap carries on with no new lead-in", () => {
  const { rerender } = render(engine({ bpm: 60 }));
  runUntil(wrapped);
  // Late on purpose: a busy main thread must not bring the lead-in back.
  runUntil(() => false, 1000);
  atWrap.current = true;
  rerender(engine({ bpm: 72 }));
  expect(onScrollStart).toHaveBeenCalledTimes(2);
  // Only the stave padding before the first beat: well under one beat at 72.
  expect(leadInMs()).toBeLessThan(60000 / 72);
  expect(atWrap.current).toBe(false);
});

test("a tempo change with no signal still gets the full lead-in, even at the wrap", () => {
  const { rerender } = render(engine({ bpm: 60 }));
  runUntil(wrapped);
  rerender(engine({ bpm: 72 }));
  expect(leadInMs()).toBeGreaterThanOrEqual(3000);
});

test("a signal left over across a pause never skips the lead-in on Resume", () => {
  const { rerender } = render(engine({ bpm: 60 }));
  runUntil(wrapped);
  atWrap.current = true;
  rerender(engine({ bpm: 60, playbackState: "paused" }));
  rerender(engine({ bpm: 60, playbackState: "playing" }));
  expect(leadInMs()).toBeGreaterThanOrEqual(3000);
  expect(atWrap.current).toBe(false);
});
