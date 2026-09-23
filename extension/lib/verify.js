// Checking that a sequence of tile captures is actually a picture of the page.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
//
// Step 6's first version asked Chrome for the whole page in one
// `Page.captureScreenshot` with `captureBeyondViewport`. On two ordinary pages
// (~1905 x 10400 and ~1905 x 10294) the tail of the returned bitmap was a REPEAT
// OF THE TOP of the page — the last slices showed the opening photo and the site
// header again instead of the article's end and the footer. A ~5994-tall page had
// been fine. Nothing in the slicing was wrong: the tile counts and the 191px last
// tile matched the planner exactly. The bitmap Chrome handed back was wrong
// inside.
//
// Tiles are now captured one at a time, which should remove the cause. But
// "should" is not "does", and the clip had claimed a COMPLETE screenshot while
// showing the top of the page twice. That is the part that must never happen
// again, whatever Chrome does.
//
// ---------------------------------------------------------------------------
// THE CHECK, AND WHY IT IS THE OVERLAP
// ---------------------------------------------------------------------------
//
// Consecutive tiles share TILE_OVERLAP rows. On a sound capture those rows are
// the same pixels photographed twice, so they differ only by JPEG noise —
// measured at 0.46 and 0.54 mean absolute difference on real slices. If the page
// moved between captures, or Chrome returned a region other than the one asked
// for, the bands will not match.
//
// ⚠️ THIS ONLY WORKS BECAUSE EACH TILE IS A SEPARATE CAPTURE. Slicing one bitmap
// made the check worthless: two slices cut from the same bitmap have identical
// overlaps by construction, wrap and all, so the old design could not have
// detected its own failure. The verification and the per-tile capture are one
// change, not two.

import { TILE_OVERLAP } from "./plan.js";

/** Sample every Nth pixel across the band. Enough signal, a fraction of the work. */
const SAMPLE_STRIDE = 4;

/**
 * Mean absolute difference between two equally-sized RGBA buffers, alpha ignored.
 * 0 is identical; JPEG noise on the same pixels lands under 1.
 */
function meanAbsDiff(a, b) {
  if (a.length !== b.length) return null;
  let sum = 0;
  let n = 0;
  // 4 bytes per pixel; step whole pixels so the channels stay aligned.
  for (let i = 0; i < a.length; i += 4 * SAMPLE_STRIDE) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    n += 3;
  }
  return n === 0 ? null : sum / n;
}

/** Decode a blob and pull out a horizontal band as RGBA bytes. */
async function band(blob, which, overlap) {
  const bitmap = await createImageBitmap(blob);
  try {
    const h = Math.min(overlap, bitmap.height);
    if (h <= 0) return null;
    const top = which === "bottom" ? bitmap.height - h : 0;
    const canvas = new OffscreenCanvas(bitmap.width, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, top, bitmap.width, h, 0, 0, bitmap.width, h);
    return {
      data: ctx.getImageData(0, 0, bitmap.width, h).data,
      width: bitmap.width,
      height: bitmap.height,
    };
  } finally {
    bitmap.close();
  }
}

/**
 * Measure how well each tile follows on from the one before it.
 *
 * @param {Blob[]} blobs tiles in page order
 * @param {number} overlap rows they are supposed to share
 * @returns {Promise<{diffs:(number|null)[], sizes:{width:number,height:number}[], allIdentical:boolean}>}
 *   `diffs[i]` compares tile i with tile i+1, so it is one shorter than `blobs`.
 */
export async function measureTileSequence(blobs, overlap = TILE_OVERLAP) {
  const sizes = [];
  const diffs = [];

  // Exact byte equality across every tile. Unambiguous when it happens — it would
  // mean Chrome ignored the clip's y offset and returned the same region every
  // time — and the overlap check cannot see it, because identical images have
  // perfectly matching overlaps.
  let allIdentical = blobs.length > 1;
  if (allIdentical) {
    const first = new Uint8Array(await blobs[0].arrayBuffer());
    for (let i = 1; i < blobs.length && allIdentical; i++) {
      const other = new Uint8Array(await blobs[i].arrayBuffer());
      if (other.length !== first.length) allIdentical = false;
      else {
        for (let k = 0; k < first.length; k++) {
          if (first[k] !== other[k]) { allIdentical = false; break; }
        }
      }
    }
  }

  let previousBottom = null;
  for (let i = 0; i < blobs.length; i++) {
    const topBand = await band(blobs[i], "top", overlap);
    sizes.push(topBand ? { width: topBand.width, height: topBand.height } : { width: 0, height: 0 });
    if (i > 0) diffs.push(previousBottom && topBand ? meanAbsDiff(previousBottom.data, topBand.data) : null);
    const bottomBand = await band(blobs[i], "bottom", overlap);
    previousBottom = bottomBand;
  }

  return { diffs, sizes, allIdentical };
}
