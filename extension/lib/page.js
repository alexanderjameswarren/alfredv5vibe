// Reading the page: what can be clipped, the text and links, and the full-page
// screenshot.

/**
 * Why this tab cannot be clipped, as a sentence for the popup, or null.
 *
 * Checked BEFORE anything else happens, because the alternative is a confusing
 * failure halfway through: `chrome.scripting.executeScript` and
 * `chrome.debugger.attach` are both refused on these pages, and the errors they
 * raise ("Cannot access contents of the page", "Cannot attach to this target")
 * do not tell you the reason is the URL.
 */
export function blockedReason(url) {
  if (!url) return "Chrome did not report an address for this tab.";

  // Chrome's own pages and other extensions' pages. Extensions are refused
  // access to these by design and no permission changes that.
  const scheme = url.split(":")[0].toLowerCase();
  if (["chrome", "chrome-extension", "chrome-untrusted", "devtools", "edge", "about", "view-source", "file"].includes(scheme)) {
    return `This is a ${scheme}: page. Chrome does not let extensions read its own pages, other extensions' pages, or local files, so there is nothing to clip. Open a normal http:// or https:// page and try again.`;
  }

  // The Web Store is specifically walled off, even though it is https.
  if (/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url)) {
    return "Chrome blocks extensions from reading the Chrome Web Store. Nothing to clip here.";
  }

  // The built-in PDF viewer renders into a plugin, not the DOM: innerText comes
  // back empty and there are no <a> elements, so a "successful" clip would save
  // an empty page. Refused with the reason instead.
  if (/\.pdf($|[?#])/i.test(url)) {
    return "This looks like a PDF in Chrome's built-in viewer. Its text is not in the page, so a clip would save nothing. Save the PDF and attach it to Claude directly, or open the publisher's HTML version.";
  }

  return null;
}

/**
 * The injected reader.
 *
 * ⚠️ THIS FUNCTION IS SERIALISED AND RUN IN THE PAGE, NOT HERE. It gets no
 * closure over this module: no imports, no outer constants, nothing but its own
 * body. Anything it needs must be defined inside it.
 *
 * Capture everything, process nothing (spec decision 1): the WHOLE body's text
 * and EVERY link, with no attempt at finding "the main content". A clipped job
 * board is many postings and Claude is told to expect that.
 */
function readPage() {
  const links = [];
  for (const a of document.querySelectorAll("a[href]")) {
    // `a.href` is the resolved absolute address, unlike getAttribute("href").
    const href = a.href;
    if (!href) continue;
    // javascript: is not an address — it is a button wearing a link's clothes.
    // Dropping it is the one filter here, and it exists so these do not eat the
    // 1,000-link budget that real links need.
    if (href.toLowerCase().startsWith("javascript:")) continue;
    links.push({ text: (a.innerText || a.textContent || "").trim().slice(0, 300), href });
  }
  return {
    title: document.title || "",
    url: location.href,
    // innerText and not textContent: innerText respects layout, so it reads in
    // the order a person sees and skips script/style bodies. textContent would
    // hand Claude a wall including hidden markup.
    text: document.body ? document.body.innerText || "" : "",
    links,
  };
}

/** Run readPage in the tab. Throws with a readable message on refusal. */
export async function extractPage(tabId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId }, func: readPage });
  } catch (e) {
    throw new Error(
      `Could not read the page: ${e.message}. This usually means Chrome will not let an ` +
        `extension touch this tab — a Chrome page, the Web Store, or a tab that has not ` +
        `finished loading. Reload the page and try again.`,
    );
  }
  const page = results?.[0]?.result;
  if (!page || typeof page.text !== "string") {
    throw new Error("The page returned nothing readable. Reload it and try again.");
  }
  return page;
}

/**
 * Measure the page, then photograph it ONE TILE AT A TIME.
 *
 * `chrome.tabs.captureVisibleTab` can only ever give the visible viewport, which
 * is the one thing this must not do — the point is the whole page. CDP's
 * `Page.captureScreenshot` with `captureBeyondViewport` is the only route, and it
 * needs the `debugger` permission.
 *
 * ---------------------------------------------------------------------------
 * 🛑 WHY ONE CALL PER TILE AND NOT ONE CALL FOR THE PAGE
 * ---------------------------------------------------------------------------
 *
 * Asking for the whole page in one capture is the obvious thing and it was the
 * first version. It produced WRONG PICTURES on ordinary pages: on a 1905 x 10404
 * article and a 1905 x 10294 job board, the tail of the returned bitmap was a
 * repeat of the TOP of the page — the last slices showed the opening photo and
 * the site header again instead of the end of the article and the footer. A
 * 1920 x 5994 page had been fine.
 *
 * The slicing was not at fault: tile counts and the 191px final tile matched the
 * planner exactly, so the bitmap Chrome returned was wrong inside it. The
 * pattern — fine at ~6000 rows, wrapped at ~10300 — is what exceeding an internal
 * surface or texture limit looks like, and `clip.scale` does not save you from it
 * because the limit applies to what Chrome COMPOSITES, not to what it hands back.
 *
 * Each tile here is about 900 output rows, so no single capture comes anywhere
 * near any such limit. It costs one CDP round trip per tile instead of one per
 * page, which is a few hundred milliseconds nobody will notice.
 *
 * Two things fall out of it for free:
 *   - Chrome encodes the JPEG, so no bitmap is ever decoded, resized or
 *     re-encoded in the service worker. The canvas slicer is gone.
 *   - Separate captures can be CHECKED AGAINST EACH OTHER at their overlap,
 *     which is the only reason the failure above is now detectable at all.
 *     See verify.js.
 *
 * ⚠️ MEASURING AND CAPTURING SHARE ONE DEBUGGER SESSION. Each attach puts
 * Chrome's "…is debugging this browser" banner up, so a second round trip would
 * flash it twice for one clip. One attach, every command, one detach — in a
 * `finally`, so a throw cannot leave the banner up.
 *
 * @param {number} tabId
 * @param {object} geometry injected so this module holds no opinion about
 *   arithmetic and the arithmetic stays testable without Chrome:
 *   `{ planCapture, planTiles, cssClipForTile, sliceName, jpegQualityPercent }`
 * @param {(done:number,total:number)=>void} [onProgress]
 */
export async function captureTiles(tabId, geometry, onProgress) {
  const { planCapture, planTiles, cssClipForTile, sliceName, jpegQualityPercent } = geometry;
  const target = { tabId };
  let attached = false;
  try {
    try {
      await chrome.debugger.attach(target, "1.3");
      attached = true;
    } catch (e) {
      // The overwhelmingly common cause, and worth naming rather than passing
      // Chrome's wording through: only one debugger client per tab.
      if (/already attached/i.test(e.message)) {
        throw new Error(
          "Chrome will not let two debuggers watch one tab, and DevTools is open on this one. " +
            "Close DevTools for this tab and clip again.",
        );
      }
      throw new Error(`Could not attach to the tab to screenshot it: ${e.message}`);
    }

    const metrics = await chrome.debugger.sendCommand(target, "Page.getLayoutMetrics");
    // cssContentSize is the CSS-pixel figure, and CSS pixels are what `clip` is
    // measured in. `contentSize` is the older field and can come back in DEVICE
    // pixels on a high-DPI screen, which would ask for a region the wrong size
    // and silently capture a fraction of the page. Prefer the explicit one.
    const raw = metrics?.cssContentSize ?? metrics?.contentSize;
    if (!raw?.width || !raw?.height) throw new Error("Chrome did not report the page size.");
    const contentSize = { width: Math.ceil(raw.width), height: Math.ceil(raw.height) };

    const plan = planCapture(contentSize.width, contentSize.height);
    const tiles = planTiles(plan.scaledHeight);

    const captured = [];
    for (let i = 0; i < tiles.length; i++) {
      const clip = cssClipForTile(tiles[i], plan);
      const shot = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
        format: "jpeg",
        quality: jpegQualityPercent,
        captureBeyondViewport: true,
        clip,
      });
      if (!shot?.data) {
        throw new Error(`Chrome returned an empty screenshot for slice ${i + 1}.`);
      }
      const bytes = Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0));
      captured.push({
        name: sliceName(i + 1),
        blob: new Blob([bytes], { type: "image/jpeg" }),
        expected: tiles[i],
        clip,
      });
      if (onProgress) onProgress(i + 1, tiles.length);
    }

    return { tiles: captured, plan, contentSize };
  } finally {
    if (attached) {
      // Swallowed on purpose: if detaching fails the tiles may still be good, and
      // throwing here would replace a usable result with a banner complaint.
      try {
        await chrome.debugger.detach(target);
      } catch (e) {
        console.warn("[Alfred Clipboard] could not detach the debugger:", e.message);
      }
    }
  }
}
