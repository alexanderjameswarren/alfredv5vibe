// Pure geometry and pure decisions. No DOM, no Chrome APIs, no canvas — so all of
// it is unit-tested in plain Node (lib/plan.test.mjs), which matters because
// these are the calculations that decide whether a page is fully captured or
// quietly clipped short.
//
// Spec: docs/technical-spec-clipboard.md decision 2 and section 4.4.

/** Never wider than this, and never upscaled. */
export const TARGET_WIDTH = 1280;

/** Each slice is at most this tall. */
export const TILE_HEIGHT = 900;

/**
 * Rows shared between consecutive slices, so a line of text sitting exactly on
 * a cut appears whole in at least one of the two.
 *
 * It does a second job now: because each tile is captured separately, this band
 * is the only place two captures can be compared, and comparing them is how a
 * broken capture is caught. See verify.js.
 */
export const TILE_OVERLAP = 50;

/** Spec 3.2 / 4.1: two-digit numbering, at most 24 slices. */
export const MAX_TILES = 24;

/** CDP's Page.captureScreenshot takes quality as 0-100, not 0-1. */
export const JPEG_QUALITY_PERCENT = 80;

/**
 * The tallest scaled image MAX_TILES can cover.
 *
 * 24 tiles at 900 with 50 shared between neighbours is 24*850 + 50 = 20450, not
 * 24*900: every tile after the first contributes only `TILE_HEIGHT - OVERLAP` of
 * new page.
 */
export const MAX_SCALED_HEIGHT = MAX_TILES * (TILE_HEIGHT - TILE_OVERLAP) + TILE_OVERLAP;

/**
 * How different two overlap bands may be and still count as the same pixels.
 *
 * Mean absolute difference per channel byte, 0-255. Measured on real q80 slices
 * cut from ONE bitmap: 0.46 and 0.54. Two SEPARATE captures of the same region
 * will differ by a little more, so this is set well clear of that while staying
 * far below a genuine content jump, which runs into the tens.
 */
export const OVERLAP_MAX_DIFF = 12;

/**
 * How the page maps onto output pixels.
 *
 * ⚠️ NOTE WHAT THIS NO LONGER DOES. It used to clip the requested HEIGHT so one
 * giant capture stayed within Chrome's limits. Captures are now per tile, so
 * nothing asks Chrome for a tall region and the clipping here is only about how
 * many tiles we are willing to keep.
 *
 * @param {number} contentWidth  CSS pixels, from Page.getLayoutMetrics
 * @param {number} contentHeight CSS pixels
 */
export function planCapture(contentWidth, contentHeight) {
  if (!(contentWidth > 0) || !(contentHeight > 0)) {
    throw new Error(`planCapture: bad content size ${contentWidth}x${contentHeight}`);
  }
  // Never upscale a narrow page: enlarging adds bytes and no detail.
  const scale = Math.min(1, TARGET_WIDTH / contentWidth);

  const fullScaledHeight = contentHeight * scale;
  const truncated = fullScaledHeight > MAX_SCALED_HEIGHT;

  return {
    scale,
    contentWidth,
    contentHeight,
    /** What the whole page would be, scaled. */
    fullScaledHeight: Math.round(fullScaledHeight),
    /** What we will actually cover, scaled. */
    scaledHeight: Math.round(Math.min(fullScaledHeight, MAX_SCALED_HEIGHT)),
    expectedWidth: Math.round(contentWidth * scale),
    /** True when the page is taller than MAX_TILES can hold. */
    truncated,
  };
}

/**
 * Where to cut, top to bottom, in OUTPUT pixels.
 *
 * The last tile is whatever is left rather than a full-height one clamped to the
 * bottom, which keeps duplicated pixels down to the overlap.
 *
 * ⚠️ THERE IS NO "DROP A TRAILING SLIVER" GUARD, AND ADDING ONE WOULD BE DEAD
 * CODE. It is the obvious next thought — a final tile no taller than the overlap
 * would sit wholly inside its predecessor and waste a whole image block on
 * nothing new — but the arithmetic makes it unreachable. Reaching iteration
 * `top = k*step` at all requires the previous tile not to have finished the
 * page, i.e. `(k-1)*step + tileHeight < totalHeight`, which rearranges to
 * `totalHeight - k*step > overlap`. That is exactly the negation of the sliver
 * condition. Measured: totalHeight 1751 gives a final tile of 51, and 1750 stops
 * a tile earlier, so the smallest last tile this can produce is `overlap + 1`.
 *
 * @returns {{top:number,height:number}[]} in page order
 */
export function planTiles(totalHeight, tileHeight = TILE_HEIGHT, overlap = TILE_OVERLAP, maxTiles = MAX_TILES) {
  if (!(totalHeight > 0)) throw new Error("planTiles: totalHeight must be > 0");
  if (!(tileHeight > 0)) throw new Error("planTiles: tileHeight must be > 0");
  if (!(overlap >= 0) || overlap >= tileHeight) {
    throw new Error("planTiles: overlap must be >= 0 and < tileHeight");
  }

  const step = tileHeight - overlap;
  const tiles = [];
  for (let top = 0; top < totalHeight; top += step) {
    const height = Math.min(tileHeight, totalHeight - top);
    tiles.push({ top, height });
    if (top + height >= totalHeight) break;
    if (tiles.length >= maxTiles) break;
  }
  return tiles;
}

/**
 * The CDP clip for one tile, in CSS pixels.
 *
 * Tiles are planned in OUTPUT space and Chrome wants CSS space, so each edge is
 * divided back through the scale. The height is clamped against `contentHeight`
 * because that division is floating point and a rounding error at the bottom of
 * a long page would ask Chrome for a row that does not exist.
 *
 * @param {{top:number,height:number}} tile output-space tile from planTiles
 * @param {object} plan from planCapture
 */
export function cssClipForTile(tile, plan) {
  const y = tile.top / plan.scale;
  const rawHeight = tile.height / plan.scale;
  const height = Math.min(rawHeight, plan.contentHeight - y);
  if (!(height > 0)) {
    throw new Error(`cssClipForTile: tile at ${tile.top} is past the bottom of the page`);
  }
  return {
    x: 0,
    y,
    width: plan.contentWidth,
    height,
    scale: plan.scale,
  };
}

/**
 * The first tile that does not follow on from the one before it.
 *
 * `diffs[i]` is how different tile i's bottom overlap band is from tile i+1's top
 * overlap band. On a sound capture those are the same pixels twice and the
 * difference is JPEG noise. A big difference means the page moved, or Chrome
 * returned something other than the region asked for — either way the sequence
 * stops being a faithful picture of the page from that point on.
 *
 * @returns {number} index of the first untrustworthy tile, or -1 if all are sound
 */
export function firstIncoherentTile(diffs, threshold = OVERLAP_MAX_DIFF) {
  for (let i = 0; i < diffs.length; i++) {
    // null means the comparison could not be made; treat that as sound rather
    // than throwing away a tile on a measurement we failed to take.
    if (typeof diffs[i] === "number" && diffs[i] > threshold) return i + 1;
  }
  return -1;
}

/** `slice-01.jpg` … matching what the server and the tools expect. */
export function sliceName(index1Based) {
  return `slice-${String(index1Based).padStart(2, "0")}.jpg`;
}
