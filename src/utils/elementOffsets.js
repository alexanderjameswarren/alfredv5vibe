/**
 * `offsetMinutes` on item elements — notification chains, Phase 2.
 *
 * Pure functions — no side effects, no app imports, no React. In their own
 * module so the tests exercise these rather than a copy of them; Alfred.jsx
 * imports from here.
 *
 * The value is the delay BEFORE a step, in minutes, measured from the previous
 * step's completion. Meaningful only on `displayType: "step"`, and dropped when
 * a row changes type — the same treatment `collectable` gets on bullets.
 *
 * ⚠ ON DISK IT IS `offset_minutes`. `elements` is a jsonb column and
 * storage.toSnakeCase recurses into arrays, so a key held as `offsetMinutes` in
 * React state is written as `offset_minutes` and converted back on read. That
 * is the same split that already forces `displayType || display_type` and
 * `itemId || item_id` in the normalisers, and it is why this reads both
 * spellings rather than trusting the one shape.
 */

/**
 * Read an element's offset in either key case.
 *
 * @returns {number|undefined} The offset, or undefined when it has none.
 */
export function readOffsetMinutes(el) {
  if (!el || typeof el !== "object") return undefined;
  const raw = el.offsetMinutes ?? el.offset_minutes;
  return Number.isFinite(raw) ? raw : undefined;
}

/**
 * The spread every element normaliser applies to carry an offset through.
 *
 * Deliberately NOT the truthiness test `collectable` uses: 0 is a legitimate
 * offset ("immediately after the previous step") and `el.offsetMinutes ? …`
 * would silently drop it.
 *
 * Every normaliser must apply this LAST, in the same position, or the
 * dirty-check comparison — a JSON.stringify of both sides — sees a different
 * key order and reports an unedited form as dirty.
 */
export function offsetPatch(el) {
  const offsetMinutes = readOffsetMinutes(el);
  return offsetMinutes === undefined ? {} : { offsetMinutes };
}

/**
 * Is the element at `index` the first step in the list?
 *
 * Step one is scheduled when the execution starts, so its offset is never read.
 * This drives a muted "at start" note NEXT TO the minutes input, never in place
 * of it: the value stays authorable at position one, so a step created at the
 * top can be given a gap and carry it when dragged down. Hiding the input there
 * would make the value unauthorable and leave a blank on the drag — which would
 * defeat the reason the offset lives on the element rather than on the item.
 *
 * The stored value is never cleared by position. That is the deliberate dead
 * data the spec calls for, and it is what makes moving a step in and out of
 * first place preserve what it was authored with.
 *
 * Headers and bullets are skipped: they are never scheduled, so a step below a
 * header is still step one.
 */
export function isFirstStep(elements, index) {
  if (!Array.isArray(elements) || !elements[index]) return false;
  const typeOf = (el) => el.displayType || el.display_type || "step";
  if (typeOf(elements[index]) !== "step") return false;
  return !elements.some((el, i) => i < index && typeOf(el) === "step");
}
