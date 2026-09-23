// Pure geometry for capture and slicing. No DOM, no Chrome APIs, no canvas —
// so it can be unit-tested in plain Node (lib/plan.test.mjs), which matters
// because these are the off-by-one calculations that decide whether a page is
// fully captured or quietly clipped short.
//
// Spec: docs/technical-spec-clipboard.md decision 2 and section 4.4.

/** Never wider than this, and never upscaled. */
export const TARGET_WIDTH = 1280;

/** Each slice is at most this tall. */
export const TILE_HEIGHT = 900;

/**
 * Rows shared between consecutive slices, so a line of text sitting exactly on
 * a cut appears whole in at least one of the two.
 */
export const TILE_OVERLAP = 50;

/** Spec 3.2 / 4.1: two-digit numbering, at most 24 slices. */
export const MAX_TILES = 24;

export const JPEG_QUALITY = 0.8;

/**
 * The tallest scaled image MAX_TILES can cover.
 *
 * 24 tiles at 900 with 50 shared between neighbours is 24*850 + 50 = 20450, not
 * 24*900: every tile after the first contributes only `TILE_HEIGHT - OVERLAP` of
 * new page.
 */
export const MAX_SCALED_HEIGHT = MAX_TILES * (TILE_HEIGHT - TILE_OVERLAP) + TILE_OVERLAP;

/**
 * What to ask Chrome for.
 *
 * Two jobs, and the second is the one that stops Chrome refusing outright:
 *
 * 1. `scale` hands the downscale to the capture itself, so Chrome renders
 *    straight to ~1280 wide instead of producing a full-resolution bitmap we
 *    then shrink. The slicer afterwards only has to crop.
 * 2. `captureHeight` asks for no more page than 24 slices can hold. A tall page
 *    at full width can exceed Chrome's maximum texture size and fail with
 *    nothing useful in the error, and every pixel past the cap would be thrown
 *    away regardless.
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

  // Back into unscaled page pixels, because that is what the clip is expressed
  // in. floor, so rounding can never ask for a row past the bottom.
  const captureHeight = truncated
    ? Math.floor(MAX_SCALED_HEIGHT / scale)
    : contentHeight;

  return {
    scale,
    captureWidth: contentWidth,
    captureHeight,
    /** What the returned image should be, give or take Chrome's own rounding. */
    expectedWidth: Math.round(contentWidth * scale),
    expectedHeight: Math.round(captureHeight * scale),
    truncated,
  };
}

/**
 * Where to cut a scaled image, top to bottom.
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

/** `slice-01.jpg` … matching what the server and the tools expect. */
export function sliceName(index1Based) {
  return `slice-${String(index1Based).padStart(2, "0")}.jpg`;
}
