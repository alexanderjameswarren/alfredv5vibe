// Cutting the screenshot into JPEG slices, in the service worker.
//
// Spec decision 2: the SERVER NEVER TOUCHES AN IMAGE. The spike proved
// server-side slicing killed the edge function, so all of it happens here, in
// the browser, where `OffscreenCanvas` is free and there is no CPU budget to
// blow.

import { planTiles, sliceName, TARGET_WIDTH, JPEG_QUALITY } from "./plan.js";

/**
 * base64 PNG -> one JPEG Blob per slice, in page order.
 *
 * @param {string} base64Png as CDP returns it, with no data: prefix
 * @returns {Promise<{ slices: {name:string, blob:Blob}[], width:number, height:number }>}
 */
export async function sliceScreenshot(base64Png) {
  // atob gives a string of char codes; Uint8Array.from maps it to bytes. There is
  // no fetch("data:...") here on purpose — it works, but it turns a local
  // decode into a request the service worker has to be alive for.
  const bytes = Uint8Array.from(atob(base64Png), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));

  try {
    // The capture was already asked for at the right scale, so this is normally
    // a no-op. It stays because "normally" is not "always": if a future Chrome
    // ignores `clip.scale`, silently shipping 1920-wide slices would push them
    // past the size at which Claude shrinks images and undo the whole reason for
    // slicing (decision 2).
    const outWidth = Math.min(TARGET_WIDTH, bitmap.width);
    const ratio = outWidth / bitmap.width;
    const outHeight = Math.round(bitmap.height * ratio);

    const tiles = planTiles(outHeight);
    const slices = [];

    for (let i = 0; i < tiles.length; i++) {
      const { top, height } = tiles[i];
      const canvas = new OffscreenCanvas(outWidth, height);
      const ctx = canvas.getContext("2d");
      // JPEG has no alpha. Without this, any transparent pixel in the PNG
      // composites against black and a page with a transparent header renders
      // with a black band.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, outWidth, height);
      // Source rectangle in BITMAP space, destination in OUTPUT space, so the
      // scale (when there is one) happens per tile and no full-size intermediate
      // canvas is ever allocated.
      ctx.drawImage(
        bitmap,
        0, top / ratio, bitmap.width, height / ratio,
        0, 0, outWidth, height,
      );
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
      slices.push({ name: sliceName(i + 1), blob });
    }

    return { slices, width: outWidth, height: outHeight };
  } finally {
    // Frees the decoded bitmap now rather than at the next GC. A tall page is
    // tens of megabytes and the service worker may be killed before a GC runs.
    bitmap.close();
  }
}
