/**
 * Repeating a block of elements — the authoring picker's logic. Phase 7.
 *
 * Pure: no React, no Supabase, no dates. It takes an elements array and returns
 * a new one.
 *
 * ── On reusing the recurrence helpers ──────────────────────────────────────
 *
 * The spec says to reuse the pure date helpers in `src/utils/recurrence.js`.
 * There is nothing here to reuse them for: repeating a block is array surgery
 * plus minute arithmetic, and involves no dates at all. `addDays` and
 * `addMonths` are also module-private there. Exporting helpers in order to not
 * use them would be worse than saying so.
 *
 * The modal chrome IS copied from `CustomRecurrenceDialog`, which is the part
 * that makes it look native.
 *
 * ── What generation produces ───────────────────────────────────────────────
 *
 * Ordinary elements. Nothing about a generated element is special once it
 * exists — no marker, no new key, no separate storage shape. The picker is an
 * authoring convenience, and after it runs the item is indistinguishable from
 * one typed by hand. That is what keeps expansion, the dispatcher and
 * `notification_steps` untouched by this phase.
 */

/** Units offered by the picker. Everything is stored as minutes underneath. */
export const OFFSET_UNITS = [
  { id: "minutes", label: "minutes", minutes: 1 },
  { id: "hours", label: "hours", minutes: 60 },
  { id: "days", label: "days", minutes: 1440 },
];

const unitById = (id) => OFFSET_UNITS.find((u) => u.id === id) || OFFSET_UNITS[0];

/** A value plus a unit, as whole minutes. */
export function toMinutes(value, unitId) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * unitById(unitId).minutes);
}

/**
 * Minutes as the largest unit that divides them exactly.
 *
 * 360 becomes 6 hours, not 360 minutes — the whole point of the unit selector
 * is that nobody should have to know an hour is 60. 90 stays 90 minutes,
 * because "1.5 hours" is not a thing this input accepts.
 */
export function splitMinutes(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return { value: n === 0 ? 0 : "", unitId: "minutes" };
  for (const unit of [...OFFSET_UNITS].reverse()) {
    if (n % unit.minutes === 0) return { value: n / unit.minutes, unitId: unit.id };
  }
  return { value: n, unitId: "minutes" };
}

// " 7 of 20" at the end of a name. Tolerates extra spaces; anchored so
// "Take 2 of 3 tablets" in the middle of a sentence is left alone.
const NUMBERING = /\s+\d+\s+of\s+\d+\s*$/i;

/** Does this name already end in generated numbering? */
export function hasNumbering(name) {
  return typeof name === "string" && NUMBERING.test(name);
}

/**
 * The name without its trailing numbering.
 *
 * Applied before re-numbering, or repeating a numbered block would compound:
 * "Take dose 7 of 20 2 of 3".
 */
export function stripNumbering(name) {
  if (typeof name !== "string") return "";
  return name.replace(NUMBERING, "").trim();
}

const typeOf = (el) => el.displayType || el.display_type || "step";
const isStep = (el) => typeOf(el) !== "header" && typeOf(el) !== "bullet";

/**
 * Which elements a block covers, for the preview.
 *
 * The preview exists because the block is chosen as "this row, plus N more"
 * rather than by dragging a selection. Naming the rows is what makes that
 * unambiguous.
 */
export function describeBlock(elements, startIndex, blockLength) {
  const list = Array.isArray(elements) ? elements : [];
  const block = list.slice(startIndex, startIndex + blockLength);
  return {
    rows: block.map((el) => ({ name: el.name || "(unnamed)", type: typeOf(el) })),
    stepCount: block.filter(isStep).length,
    truncated: startIndex + blockLength > list.length,
    numberedNames: block.filter((el) => hasNumbering(el.name)).map((el) => el.name),
  };
}

/**
 * Repeat a contiguous block in place.
 *
 * `times` is the TOTAL number of occurrences, not the number of extra copies:
 * "every 6 hours, 20 times" means twenty doses. The source block becomes
 * occurrence one and the range is replaced, so running it twice does not
 * silently double.
 *
 * Numbering is **per pass**, not per row across the whole run. A block of one
 * gives "Take dose 1 of 20" … "20 of 20"; a block of four gives "Pull 1 of 3",
 * "Legs 1 of 3", … "Pull 2 of 3". One rule, and it is the useful answer for
 * both shapes.
 *
 * Only step elements are numbered. Numbering exists because a list of identical
 * names is unreadable in the editor and useless in a notification, and only
 * steps produce notifications.
 *
 * @param {object}  o
 * @param {Array}   o.elements       The item's current elements.
 * @param {number}  o.startIndex     First row of the block.
 * @param {number}  o.blockLength    How many rows the block covers.
 * @param {number}  o.times          Total occurrences, including the original.
 * @param {number}  [o.offsetMinutes] Gap written onto every generated step.
 * @param {boolean} [o.autoNumber]   Append " N of times" to step names.
 */
export function repeatBlock({
  elements,
  startIndex,
  blockLength,
  times,
  offsetMinutes,
  autoNumber = false,
}) {
  const list = Array.isArray(elements) ? [...elements] : [];
  const start = Math.max(0, Math.min(startIndex, list.length));
  const length = Math.max(1, Math.min(blockLength, list.length - start));
  const passes = Math.max(1, Math.floor(times));

  const block = list.slice(start, start + length);
  if (block.length === 0) return list;

  const generated = [];
  for (let pass = 0; pass < passes; pass += 1) {
    for (const el of block) {
      const copy = { ...el };
      if (isStep(copy)) {
        // "Generation should write a real value on every element" — including
        // the first, whose offset is ignored at position one but becomes live
        // the moment it is dragged down. See Phase 2.
        if (Number.isFinite(offsetMinutes)) copy.offsetMinutes = offsetMinutes;
        if (autoNumber) {
          copy.name = `${stripNumbering(copy.name)} ${pass + 1} of ${passes}`.trim();
        }
      }
      generated.push(copy);
    }
  }

  return [...list.slice(0, start), ...generated, ...list.slice(start + length)];
}
