import { leadInPx } from "./leadIn";
import { SCROLL_GEOMETRY } from "./samConstants";

// 4/4 at measure width 500: 625 display px per bar, so 156.25 px per beat.
const PX_PER_BEAT = 156.25;
const msPerBeat = (bpm) => 60000 / bpm;
const base = (w) => w * SCROLL_GEOMETRY.leadInPct;

test("adds whole beats until 3 s at 120 BPM", () => {
  // base 90px = 0.576 beats = 288ms; 6 beats more = 3288ms
  const r = leadInPx({ viewportWidth: 360, pxPerBeat: PX_PER_BEAT, msPerBeat: msPerBeat(120) });
  expect(r.extraBeats).toBe(6);
  expect(r.px).toBeCloseTo(base(360) + 6 * PX_PER_BEAT);
  expect(r.wallMs).toBeCloseTo(3288);
});

test("never shorter than the base", () => {
  // base 2000px = 12.8 beats = 6.4 s at 120 BPM
  const r = leadInPx({ viewportWidth: 8000, pxPerBeat: PX_PER_BEAT, msPerBeat: msPerBeat(120) });
  expect(r.extraBeats).toBe(0);
  expect(r.px).toBe(base(8000));
});

test("an exact fit adds no extra beat", () => {
  // base exactly 1 beat at 60 BPM = 1000ms; 2 more beats = 3000ms
  const r = leadInPx({ viewportWidth: PX_PER_BEAT * 4, pxPerBeat: PX_PER_BEAT, msPerBeat: 1000 });
  expect(r.extraBeats).toBe(2);
  expect(r.wallMs).toBeCloseTo(3000);
});

test("uses wall time at the audio rate", () => {
  // 100 BPM at rate 0.5 scrolls like 50 BPM: 1200ms per wall beat
  const slow = leadInPx({ viewportWidth: 360, pxPerBeat: PX_PER_BEAT, msPerBeat: msPerBeat(100), rate: 0.5 });
  const full = leadInPx({ viewportWidth: 360, pxPerBeat: PX_PER_BEAT, msPerBeat: msPerBeat(100) });
  expect(slow.extraBeats).toBeLessThan(full.extraBeats);
  expect(slow.wallMs).toBeGreaterThanOrEqual(3000);
  expect(slow.wallMs - 1200).toBeLessThan(3000);
});

test("bad inputs fall back to the base", () => {
  expect(leadInPx({ viewportWidth: 400, pxPerBeat: 0, msPerBeat: 500 }).px).toBe(base(400));
});
