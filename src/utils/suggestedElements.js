/**
 * The ONE normaliser for enrichment-suggested item elements.
 *
 * Pure — no React, no app imports — in its own module so the tests exercise this
 * rather than a copy of it, and so there is exactly one copy to begin with.
 *
 * ── What it converts, and why a conversion is needed at all ──────────────────
 *
 * Two vocabularies describe the same element:
 *
 *   the ENRICHMENT writes  { text, type }        — what claude.ai's
 *                                                  alfred-enrich skill produces
 *                                                  into inbox.suggested_item_elements
 *   the APP holds          { name, displayType } — what the element editor edits
 *                                                  and what items.elements stores
 *
 * So a suggestion cannot be handed to the editor as it arrives. It also cannot
 * be converted blindly: `suggested_item_elements` is a jsonb column with no
 * shape constraint, and a row written by something that already speaks the app's
 * vocabulary must pass through untouched. Hence the `el.name ?` test — presence
 * of `name` IS the signal that this element needs nothing done to it.
 *
 * ── ⚠️ WHY THIS IS A MODULE AND NOT AN INLINE MAP ───────────────────────────
 *
 * It used to be written out four times inside `InboxCard`: once to seed state,
 * once in the effect that re-seeds when enrichment lands, once inside the
 * dirty-check comparison, once in Cancel's reset. All four had to agree
 * EXACTLY, including key order, because the dirty check compared
 * `JSON.stringify` of the live elements against a freshly normalised copy — two
 * spellings of the same element differ as strings, so a form nobody had touched
 * would report itself dirty and demand a confirm on the way out.
 *
 * Four copies of a function whose copies must be byte-identical is a bug with a
 * delay on it. This is that function, once.
 *
 * `offsetPatch` is applied LAST and nothing may be added after it, for the same
 * key-order reason — see its own note in elementOffsets.js.
 */

import { offsetPatch } from "./elementOffsets";

/**
 * Normalise one suggested element into the shape the element editor edits.
 *
 * @param {object} el - An element in either vocabulary.
 * @returns {object} The app-shaped element. Returned AS-IS when it already
 *   carries a `name`, which is what keeps an already-converted element stable
 *   across repeated normalisation.
 */
export function normaliseSuggestedElement(el) {
  if (el && el.name) return el;
  const source = el || {};
  return {
    name: source.text || "",
    displayType: source.type || "step",
    quantity: source.quantity || "",
    description: source.description || "",
    // Truthiness is right HERE and wrong for offsets: `collectable` is a flag
    // that is either set or absent, and an explicit `false` carries no more
    // information than its absence. `offsetMinutes` cannot be treated this way
    // because 0 is a real value — see offsetPatch.
    ...(source.collectable ? { collectable: true } : {}),
    ...offsetPatch(source),
  };
}

/**
 * Normalise a whole suggestion list.
 *
 * @param {Array|null|undefined} elements - `inbox.suggested_item_elements`, or
 *   nothing at all. A capture with no suggestions is the common case, so a
 *   nullish list is an empty result rather than an error.
 * @returns {Array<object>} A new array; the input is never mutated.
 */
export function normaliseSuggestedElements(elements) {
  if (!Array.isArray(elements)) return [];
  return elements.map(normaliseSuggestedElement);
}
