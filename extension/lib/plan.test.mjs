// Plain Node test for the capture/slice geometry. Run:
//
//   node extension/lib/plan.test.mjs
//
// Not under src/, so CRA's jest never sees it — deliberate, because this is
// extension code and has nothing to do with the React app's suite.

import assert from "node:assert/strict";
import {
  planCapture,
  planTiles,
  sliceName,
  TARGET_WIDTH,
  TILE_HEIGHT,
  TILE_OVERLAP,
  MAX_TILES,
  MAX_SCALED_HEIGHT,
} from "./plan.js";

let pass = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

// --- constants -------------------------------------------------------------

test("MAX_SCALED_HEIGHT accounts for the overlap, not 24*900", () => {
  assert.equal(MAX_SCALED_HEIGHT, 24 * 850 + 50);
  assert.equal(MAX_SCALED_HEIGHT, 20450);
});

// --- planCapture -----------------------------------------------------------

test("a 1920-wide page scales to 1280", () => {
  const p = planCapture(1920, 5994);
  assert.equal(p.scale, 1280 / 1920);
  assert.equal(p.expectedWidth, 1280);
  assert.equal(p.expectedHeight, Math.round(5994 * (1280 / 1920)));
  assert.equal(p.truncated, false);
  assert.equal(p.captureHeight, 5994, "short enough: capture the whole page");
});

test("a narrow page is never upscaled", () => {
  const p = planCapture(800, 2000);
  assert.equal(p.scale, 1, "scale is capped at 1");
  assert.equal(p.expectedWidth, 800);
  assert.equal(p.expectedHeight, 2000);
  assert.equal(p.truncated, false);
});

test("exactly at the cap is not truncated", () => {
  // Pick a height whose scaled value lands exactly on MAX_SCALED_HEIGHT.
  const width = 1280;
  const p = planCapture(width, MAX_SCALED_HEIGHT);
  assert.equal(p.truncated, false);
  assert.equal(p.captureHeight, MAX_SCALED_HEIGHT);
});

test("one pixel past the cap truncates, and clips the request", () => {
  const p = planCapture(1280, MAX_SCALED_HEIGHT + 1);
  assert.equal(p.truncated, true);
  assert.equal(p.captureHeight, MAX_SCALED_HEIGHT, "asks for no more than it can keep");
  assert.equal(p.expectedHeight, MAX_SCALED_HEIGHT);
});

test("a very tall wide page asks for far less than its full height", () => {
  // 1920 x 60000 would be a ~40000px-tall texture after scaling; Chrome would
  // likely refuse. The plan must cut the REQUEST, not just the result.
  const p = planCapture(1920, 60000);
  assert.equal(p.truncated, true);
  assert.equal(p.expectedHeight, MAX_SCALED_HEIGHT);
  assert.ok(p.captureHeight < 60000);
  // Unscaled height needed for 20450 scaled rows at 2/3 scale = 30675.
  assert.equal(p.captureHeight, Math.floor(MAX_SCALED_HEIGHT / (1280 / 1920)));
});

test("planCapture refuses a zero or negative size", () => {
  assert.throws(() => planCapture(0, 100));
  assert.throws(() => planCapture(100, 0));
  assert.throws(() => planCapture(-5, 100));
});

// --- planTiles -------------------------------------------------------------

test("a page shorter than one tile is a single tile", () => {
  const t = planTiles(500);
  assert.deepEqual(t, [{ top: 0, height: 500 }]);
});

test("a page exactly one tile tall is a single tile", () => {
  const t = planTiles(900);
  assert.deepEqual(t, [{ top: 0, height: 900 }]);
});

test("consecutive tiles overlap by exactly TILE_OVERLAP", () => {
  const t = planTiles(4160);
  for (let i = 1; i < t.length; i++) {
    const prevBottom = t[i - 1].top + t[i - 1].height;
    assert.equal(prevBottom - t[i].top, TILE_OVERLAP, `tiles ${i - 1}/${i} overlap`);
  }
});

test("the 4160px case matches the numbers proved by the Step 2 script", () => {
  // Same source the local slicer produced tiles for: 1600x5200 scaled to
  // 1280x4160. Five tiles, the last one short.
  const t = planTiles(4160);
  assert.deepEqual(t, [
    { top: 0, height: 900 },
    { top: 850, height: 900 },
    { top: 1700, height: 900 },
    { top: 2550, height: 900 },
    { top: 3400, height: 760 },
  ]);
});

test("tiles cover the page with no gap", () => {
  for (const h of [901, 1000, 1751, 4160, 9000, 20450]) {
    const t = planTiles(h);
    assert.equal(t[0].top, 0, `h=${h} starts at 0`);
    for (let i = 1; i < t.length; i++) {
      const prevBottom = t[i - 1].top + t[i - 1].height;
      assert.ok(t[i].top < prevBottom, `h=${h}: no gap before tile ${i}`);
    }
    const last = t[t.length - 1];
    assert.equal(last.top + last.height, h, `h=${h} reaches the bottom`);
  }
});

test("the smallest possible last tile is overlap + 1, never smaller", () => {
  // The interesting boundary, and the reason planTiles has no sliver guard: a
  // final tile can never be short enough to sit wholly inside its predecessor.
  // 1750 is covered exactly by two tiles; 1751 forces a third, which starts at
  // 1700 (one step on) and is therefore 51 tall — one more than the overlap.
  assert.deepEqual(planTiles(1750), [
    { top: 0, height: 900 },
    { top: 850, height: 900 },
  ]);
  const t = planTiles(1751);
  assert.equal(t.length, 3);
  assert.deepEqual(t[2], { top: 1700, height: TILE_OVERLAP + 1 });
});

test("every tile after the first adds new page beyond the overlap", () => {
  // The property the absent sliver guard would have protected, asserted directly
  // across a wide range instead.
  for (const h of [901, 1000, 1751, 1780, 2600, 4160, 9000, 20450]) {
    const t = planTiles(h);
    for (let i = 1; i < t.length; i++) {
      assert.ok(
        t[i].height > TILE_OVERLAP,
        `h=${h}: tile ${i} is ${t[i].height}px, not more than the ${TILE_OVERLAP}px overlap`,
      );
    }
  }
});

test("a trailing remainder taller than the overlap gets its own tile", () => {
  const t = planTiles(1800);
  assert.equal(t.length, 3);
  assert.equal(t[2].top + t[2].height, 1800);
});

test("never more than MAX_TILES", () => {
  const t = planTiles(500000);
  assert.equal(t.length, MAX_TILES);
});

test("a page at exactly MAX_SCALED_HEIGHT needs exactly MAX_TILES", () => {
  const t = planTiles(MAX_SCALED_HEIGHT);
  assert.equal(t.length, MAX_TILES);
  const last = t[t.length - 1];
  assert.equal(last.top + last.height, MAX_SCALED_HEIGHT, "and reaches the bottom");
});

test("planTiles refuses nonsense", () => {
  assert.throws(() => planTiles(0));
  assert.throws(() => planTiles(1000, 0));
  assert.throws(() => planTiles(1000, 900, 900), /overlap/);
  assert.throws(() => planTiles(1000, 900, -1), /overlap/);
});

// --- names -----------------------------------------------------------------

test("slice names are two-digit and 1-based", () => {
  assert.equal(sliceName(1), "slice-01.jpg");
  assert.equal(sliceName(9), "slice-09.jpg");
  assert.equal(sliceName(10), "slice-10.jpg");
  assert.equal(sliceName(24), "slice-24.jpg");
});

test("planCapture and planTiles agree on the cap", () => {
  // The whole point of MAX_SCALED_HEIGHT: a capture planned at the cap must
  // slice into exactly MAX_TILES, no more.
  const p = planCapture(TARGET_WIDTH, 999999);
  const t = planTiles(p.expectedHeight);
  assert.equal(t.length, MAX_TILES);
  assert.equal(p.truncated, true);
});

console.log(`\n${pass} passed${process.exitCode ? ", SOME FAILED" : ""}\n`);
