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
  cssClipForTile,
  firstIncoherentTile,
  describeScreenshot,
  sliceName,
  TARGET_WIDTH,
  TILE_HEIGHT,
  TILE_OVERLAP,
  MAX_TILES,
  MAX_SCALED_HEIGHT,
  OVERLAP_MAX_DIFF,
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
  assert.equal(p.scaledHeight, Math.round(5994 * (1280 / 1920)));
  assert.equal(p.fullScaledHeight, p.scaledHeight, "nothing dropped");
  assert.equal(p.truncated, false);
});

test("a narrow page is never upscaled", () => {
  const p = planCapture(800, 2000);
  assert.equal(p.scale, 1, "scale is capped at 1");
  assert.equal(p.expectedWidth, 800);
  assert.equal(p.scaledHeight, 2000);
  assert.equal(p.truncated, false);
});

test("exactly at the cap is not truncated", () => {
  const p = planCapture(1280, MAX_SCALED_HEIGHT);
  assert.equal(p.truncated, false);
  assert.equal(p.scaledHeight, MAX_SCALED_HEIGHT);
});

test("one pixel past the cap truncates and covers only what 24 tiles hold", () => {
  const p = planCapture(1280, MAX_SCALED_HEIGHT + 1);
  assert.equal(p.truncated, true);
  assert.equal(p.scaledHeight, MAX_SCALED_HEIGHT);
  assert.equal(p.fullScaledHeight, MAX_SCALED_HEIGHT + 1, "and says how tall it really was");
});

test("a very tall page covers the cap and reports the real height", () => {
  const p = planCapture(1920, 60000);
  assert.equal(p.truncated, true);
  assert.equal(p.scaledHeight, MAX_SCALED_HEIGHT);
  assert.equal(p.fullScaledHeight, Math.round(60000 * (1280 / 1920)));
});

// --- the pages that actually failed ----------------------------------------

test("the two pages that wrapped are not themselves over any cap", () => {
  // Recorded because it rules out the first theory. Neither page is anywhere
  // near the 24-slice cap, so the wrap had nothing to do with OUR limits — it
  // was inside the single bitmap Chrome returned. Hence per-tile capture.
  for (const [w, h, tiles] of [[1905, 10404, 9], [1905, 10294, 9]]) {
    const p = planCapture(w, h);
    assert.equal(p.truncated, false, `${w}x${h} is within the cap`);
    assert.equal(planTiles(p.scaledHeight).length, tiles, `${w}x${h} plans ${tiles} tiles`);
  }
  // And the one that worked, for contrast.
  assert.equal(planTiles(planCapture(1920, 5994).scaledHeight).length, 5);
});

// --- cssClipForTile --------------------------------------------------------

test("a tile's CSS clip maps back through the scale", () => {
  const p = planCapture(1905, 10404);
  const tiles = planTiles(p.scaledHeight);
  const clip = cssClipForTile(tiles[1], p);
  assert.equal(clip.x, 0);
  assert.equal(clip.width, 1905, "full page width; the scale shrinks the output");
  assert.equal(clip.scale, p.scale);
  assert.ok(Math.abs(clip.y - 850 / p.scale) < 1e-9, "second tile starts one step down");
  assert.ok(Math.abs(clip.height - 900 / p.scale) < 1e-9);
});

test("no clip ever asks for a row past the bottom of the page", () => {
  for (const [w, h] of [[1905, 10404], [1905, 10294], [1920, 5994], [800, 2000], [1280, 901]]) {
    const p = planCapture(w, h);
    for (const t of planTiles(p.scaledHeight)) {
      const c = cssClipForTile(t, p);
      assert.ok(c.height > 0, `${w}x${h}: positive height`);
      assert.ok(c.y + c.height <= h + 1e-6, `${w}x${h}: clip ends at or before ${h}, got ${c.y + c.height}`);
    }
  }
});

test("every tile's clip is small enough that no single capture is tall", () => {
  // The whole point of per-tile capture: the tallest thing Chrome is ever asked
  // for. At 2/3 scale a 900-row tile is 1350 CSS px — nowhere near the ~10,000
  // that wrapped.
  const p = planCapture(1905, 10404);
  const heights = planTiles(p.scaledHeight).map((t) => cssClipForTile(t, p).height);
  assert.ok(Math.max(...heights) < 1400, `tallest clip was ${Math.max(...heights)} CSS px`);
});

// --- firstIncoherentTile ---------------------------------------------------

test("a sound sequence has no incoherent tile", () => {
  assert.equal(firstIncoherentTile([0.4, 0.6, 0.5, 0.48]), -1);
});

test("the first bad join names the tile AFTER it", () => {
  // diffs[2] compares tile index 2 with tile index 3, so tile 3 is the first
  // one that cannot be trusted.
  assert.equal(firstIncoherentTile([0.4, 0.6, 99, 0.5]), 3);
});

test("a join exactly at the threshold is still sound", () => {
  assert.equal(firstIncoherentTile([OVERLAP_MAX_DIFF]), -1);
  assert.equal(firstIncoherentTile([OVERLAP_MAX_DIFF + 0.01]), 1);
});

test("an unmeasurable join is not treated as a failure", () => {
  // Throwing a tile away over a measurement we failed to take would lose real
  // content for no reason.
  assert.equal(firstIncoherentTile([null, null]), -1);
  assert.equal(firstIncoherentTile([null, 99]), 2);
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
  const t = planTiles(p.scaledHeight);
  assert.equal(t.length, MAX_TILES);
  assert.equal(p.truncated, true);
});

// --- describeScreenshot: the cap must never be blamed wrongly ---------------

const REAL = {
  pageWidth: 1905, pageHeight: 6047, slicesPlanned: 5, slicesKept: 2,
  firstBadTile: 2, badJoin: 47.2, joins: [0.5, 0.6, 47.2], capHit: false, failure: null,
};

test("a join failure never mentions the 24-slice cap", () => {
  const note = describeScreenshot(REAL);
  // /cap/i would match "capture", which the message legitimately contains.
  // The thing that must never appear is the CLAIM about the cap.
  assert.ok(!/slice cap/i.test(note), "must not blame the cap: " + note);
  assert.ok(!/24/.test(note), "must not mention 24 slices: " + note);
  assert.ok(!/taller than/i.test(note), "must not claim the page was too tall: " + note);
  assert.match(note, /slice 3 did not continue from slice 2/i);
  assert.match(note, /47\.2/);
  assert.match(note, /2 of 5/);
  assert.match(note, /THE TEXT IS COMPLETE/);
});

test("the real pages that were mis-blamed are described without the cap", () => {
  // 6047 and 6562 px plan 5 and 6 slices. Both were told they had overrun a
  // 24-slice cap. Neither came close.
  for (const [h, planned, kept, bad] of [[6047, 5, 2, 2], [6562, 6, 1, 1]]) {
    const note = describeScreenshot({
      ...REAL, pageHeight: h, slicesPlanned: planned, slicesKept: kept, firstBadTile: bad,
    });
    assert.ok(!/slice cap/i.test(note), h + "px must not blame the cap");
    assert.ok(!/taller than/i.test(note), h + "px must not claim it was too tall");
  }
});

test("the cap IS named when the cap was really hit", () => {
  const note = describeScreenshot({
    ...REAL, firstBadTile: -1, badJoin: null, pageHeight: 40000, capHit: true,
  });
  assert.match(note, /24-slice cap/);
  assert.match(note, /40000px tall/);
});

test("both causes at once are both reported", () => {
  const note = describeScreenshot({ ...REAL, pageHeight: 40000, capHit: true });
  assert.match(note, /did not continue/);
  assert.match(note, /24-slice cap/);
});

test("a complete screenshot says so and gives the worst join", () => {
  const note = describeScreenshot({
    ...REAL, slicesKept: 5, firstBadTile: -1, badJoin: null, joins: [0.4, 0.61, 0.5, 0.48],
  });
  assert.ok(note.startsWith("Complete: 5 slices"), note);
  assert.match(note, /worst 0\.61/);
  assert.ok(!/INCOMPLETE/.test(note));
});

test("no screenshot at all points at the text", () => {
  const note = describeScreenshot({ ...REAL, failure: "Chrome returned an empty screenshot." });
  assert.ok(note.startsWith("NO SCREENSHOT"), note);
  assert.match(note, /answer from page_text/);
});


console.log(`\n${pass} passed${process.exitCode ? ", SOME FAILED" : ""}\n`);
