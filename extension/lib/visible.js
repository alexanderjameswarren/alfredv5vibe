// The everyday capture: one photograph of what is on screen, with no banner.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS ALONGSIDE THE FULL-PAGE CAPTURE
// ---------------------------------------------------------------------------
//
// Photographing a whole page needs `chrome.debugger`, and attaching it makes
// Chrome show a "…is debugging this browser" bar across the top of the window.
// That is tolerable for a deliberate act and intolerable several times a day, so
// the default click uses `chrome.tabs.captureVisibleTab`, which needs no debugger
// and shows nothing.
//
// The trade is real and is not hidden: this gets the visible viewport and no
// more. The whole page's TEXT is captured either way — that is the part the
// clipboard is actually for — and `describeScreenshot` says in words that the
// picture is the screen rather than the page, so nothing downstream can mistake
// one for the other.

import { planTiles, sliceName, TARGET_WIDTH, JPEG_QUALITY_PERCENT } from "./plan.js";

/**
 * Photograph the visible viewport and cut it to the house slice rules.
 *
 * Usually one slice: a viewport is around 950 CSS pixels tall and scales to well
 * under the 900-pixel tile height. Taller windows get two, which is why it goes
 * through `planTiles` rather than assuming one.
 *
 * @param {number} windowId
 * @returns {Promise<{tiles:{name:string,blob:Blob}[], width:number, height:number}>}
 */
export async function captureVisible(windowId) {
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: "jpeg",
      quality: JPEG_QUALITY_PERCENT,
    });
  } catch (e) {
    throw new Error(
      `Chrome would not photograph the visible screen: ${e.message}. ` +
        `This usually means the tab lost focus mid-clip, or it is a page ` +
        `extensions may not read.`,
    );
  }
  if (!dataUrl) throw new Error("Chrome returned an empty screenshot of the visible screen.");

  // A data: URL, so the base64 starts after the comma.
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));

  try {
    // captureVisibleTab returns DEVICE pixels, so on a scaled display this comes
    // back wider than the CSS viewport. Scaling to TARGET_WIDTH handles both that
    // and an ordinary wide window in one step. Never upscale a narrow one.
    const outWidth = Math.min(TARGET_WIDTH, bitmap.width);
    const ratio = outWidth / bitmap.width;
    const outHeight = Math.round(bitmap.height * ratio);

    const tiles = [];
    for (const [i, tile] of planTiles(outHeight).entries()) {
      const canvas = new OffscreenCanvas(outWidth, tile.height);
      const ctx = canvas.getContext("2d");
      // JPEG has no alpha; without a ground, any transparent pixel composites
      // against black and a page with a transparent header gets a black band.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, outWidth, tile.height);
      ctx.drawImage(
        bitmap,
        0, tile.top / ratio, bitmap.width, tile.height / ratio,
        0, 0, outWidth, tile.height,
      );
      const blob = await canvas.convertToBlob({
        type: "image/jpeg",
        // convertToBlob wants 0-1; the CDP path wants 0-100. One constant, two
        // scales, converted here rather than kept as two constants that could drift.
        quality: JPEG_QUALITY_PERCENT / 100,
      });
      tiles.push({ name: sliceName(i + 1), blob });
    }

    return { tiles, width: outWidth, height: outHeight };
  } finally {
    // Frees the decoded bitmap now rather than at the next GC, which an MV3
    // service worker may never reach before it is shut down.
    bitmap.close();
  }
}
