/**
 * Reading a capture's clip metadata — Alfred Clipboard, Step 19.
 *
 * Pure — no React, no Supabase — in its own module so the tests exercise these
 * rather than a reproduction of their shape.
 *
 * An inbox row from the Chrome extension or the CLI is a lightweight POINTER at a
 * `public.clips` row, which holds the page text, the links and the screenshot
 * slices. These are the decisions the detail page has to make before it can show
 * any of that, and each of them has a wrong answer that looks right.
 */

/**
 * The clip id an inbox row points at, or null.
 *
 * ⚠️ Reads BOTH key cases. `source_metadata` is a jsonb column, and
 * `storage.toCamelCase` recurses into it — so a row that arrived through
 * `loadData` has `sourceMetadata.clipId` while the same row read straight from
 * Postgres has `source_metadata.clip_id`. Reading one spelling and assuming it
 * holds in the other is the mistake that has already cost this codebase a failed
 * backfill.
 */
export function clipIdFor(inboxItem) {
  const meta = inboxItem?.sourceMetadata ?? inboxItem?.source_metadata;
  if (!meta || typeof meta !== "object") return null;
  const id = meta.clipId ?? meta.clip_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Is this capture one that HAS a clip to show?
 *
 * Keyed on the clip id rather than on `source_type`, deliberately. The two
 * sources that mint clips are `clipboard` and `cli`, but a row's source is a
 * label while the id is the thing that can actually be fetched — and the one
 * disagreement that matters, a clipboard row whose metadata never recorded an id,
 * should render as "nothing to show" rather than as a failed fetch.
 */
export function hasClip(inboxItem) {
  return clipIdFor(inboxItem) !== null;
}

/**
 * What the capture mode means, resolved.
 *
 * ⚠️ A MISSING MODE MEANS 'full', AND THAT IS A FACT RATHER THAN A GUESS. Clips
 * saved before capture modes existed recorded none, and the visible-screen mode
 * did not exist then — every one of them went through the full-page path. The
 * absence is resolved here, once, exactly as `get_recent_clips` resolves it, so
 * the two readers cannot drift apart.
 */
export function captureModeFor(inboxItem) {
  const meta = inboxItem?.sourceMetadata ?? inboxItem?.source_metadata;
  const mode = meta?.captureMode ?? meta?.capture_mode;
  return mode === "visible" ? "visible" : "full";
}

/** The note the extension recorded about this screenshot, or null. */
export function screenshotNoteFor(inboxItem) {
  const meta = inboxItem?.sourceMetadata ?? inboxItem?.source_metadata;
  const note = meta?.screenshotNote ?? meta?.screenshot_note;
  return typeof note === "string" && note.trim() ? note.trim() : null;
}

/**
 * Should the screenshot carry a caveat, and what should it say?
 *
 * Two situations, and the second is the one that gets forgotten:
 *
 *   INCOMPLETE — `screenshot_truncated`. The slices do not cover the whole page.
 *   VISIBLE ONLY — `capture_mode: 'visible'`. A photograph of the screen, on
 *     purpose. Not truncated, not broken, and still not the page — so it needs
 *     saying just as much. `get_clip_slices` learned this the hard way: it
 *     surfaced its note only when the truncated flag was set, which left the
 *     everyday visible capture with nothing at all to say so.
 *
 * Returns null when the screenshot is a complete full-page one, which needs no
 * commentary.
 *
 * @param {object} inboxItem
 * @param {object|null} clip - The clips row, for `screenshotTruncated`.
 * @returns {{kind: string, text: string}|null}
 */
export function screenshotCaveat(inboxItem, clip) {
  const note = screenshotNoteFor(inboxItem);
  const truncated = Boolean(clip?.screenshotTruncated ?? clip?.screenshot_truncated);
  const visibleOnly = captureModeFor(inboxItem) === "visible";

  if (!truncated && !visibleOnly) return null;

  if (truncated) {
    return {
      kind: "incomplete",
      // NEVER GUESS A CAUSE. The extension records the real reason; when it did
      // not — clips predating the note — say only what is certain.
      text: note
        ? `This screenshot does not show the whole page. ${note}`
        : "This screenshot does not show the whole page. The reason was not recorded for this clip. The page text below is unaffected.",
    };
  }

  return {
    kind: "visible-only",
    text: note || "This is the visible screen only, not the whole page.",
  };
}

/**
 * The page text is long enough to be worth collapsing.
 *
 * A threshold on BOTH lines and characters, because the two failure shapes are
 * different: a recipe is thirty short lines, and an article is three enormous
 * ones. Either alone would leave the other uncollapsed.
 */
export const COLLAPSE_LINES = 6;
const COLLAPSE_CHARS = 400;

export function needsShowAll(text) {
  if (typeof text !== "string") return false;
  return text.split("\n").length > COLLAPSE_LINES || text.length > COLLAPSE_CHARS;
}

/**
 * The links, cleaned up for display.
 *
 * Three things happen here, and all three are about not showing a list that is
 * worse than no list:
 *
 *   * rows without an href are dropped — there is nothing to open;
 *   * duplicates by href collapse, keeping the FIRST label, because that is the
 *     one nearest the top of the page and so the one most likely to name the
 *     destination rather than say "read more";
 *   * a row with no text falls back to its href, so it is never a blank line.
 *
 * Deduplication is NOT truncation: the capture function's own `links_truncated`
 * flag reports the 1,000-link cap, and this does not touch it.
 */
export function displayLinks(links) {
  if (!Array.isArray(links)) return [];
  const seen = new Set();
  const out = [];
  for (const link of links) {
    const href = typeof link?.href === "string" ? link.href.trim() : "";
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const text = typeof link?.text === "string" ? link.text.trim() : "";
    out.push({ href, text: text || href });
  }
  return out;
}
