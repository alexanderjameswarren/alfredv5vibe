/**
 * The inbox's source tabs — Alfred Clipboard, Step 21b.
 *
 * Pure — no React — so the ordering, the visibility rule and the fallback are testable
 * without rendering anything.
 *
 * ── Why tabs, after pills ────────────────────────────────────────────────────
 *
 * Step 21 reused `TagFilter` for this, which worked and read wrong: the source pills sat
 * directly above cards carrying real tag pills, so two different things looked
 * identical. A tab says "this is a view of one list"; a pill says "this is a property of
 * these rows". The source filter is the first of those.
 */

import { SOURCE_GLYPHS } from "../CaptureMeta";

export const ALL_SOURCES = "all";

/**
 * Every source, in the order the tabs are always drawn.
 *
 * ⚠️ FIXED, AND NOT SORTED BY ANYTHING. This is the one place it differs from the tag
 * pills, which sort alphabetically because a tag vocabulary grows and you arrive looking
 * for a name. There are six sources and they never change, so the row can be learned by
 * position — and a row that reorders itself as counts change is a row you have to read
 * every time. Most frequent first, roughly, with the two rare ones last.
 */
export const SOURCE_ORDER = ["manual", "mcp", "clipboard", "task", "cli", "email"];

/**
 * The tabs to draw for a given set of captures.
 *
 * "All" is always present and always first, so there is always a way back. A source tab
 * appears only while that source has items — CLI and Email usually have none, and a tab
 * reading "(0)" is a control that does nothing.
 *
 * @param {Array} inboxItems      The live inbox rows.
 * @param {Function} sourceLabel  Names a source type. Injected rather than imported so
 *   this module holds no opinion about wording.
 * @returns {Array<{key: string, label: string, count: number, icon: Function}>}
 */
export function sourceTabsFor(inboxItems, sourceLabel) {
  const rows = Array.isArray(inboxItems) ? inboxItems : [];
  const counts = {};
  for (const row of rows) {
    // An unrecognised source_type folds onto `manual`, exactly as its icon and its label
    // do — so an unknown value is counted somewhere rather than creating a tab nobody
    // can name.
    const key = SOURCE_ORDER.includes(row?.sourceType) ? row.sourceType : "manual";
    counts[key] = (counts[key] || 0) + 1;
  }

  const tabs = [
    { key: ALL_SOURCES, label: "All", count: rows.length, icon: undefined },
  ];
  for (const key of SOURCE_ORDER) {
    if (!counts[key]) continue;
    tabs.push({ key, label: sourceLabel(key), count: counts[key], icon: SOURCE_GLYPHS[key] });
  }
  return tabs;
}

/**
 * Which tab is actually selected, given what the user last chose.
 *
 * ⚠️ DERIVED, NOT STORED. Process the last Claude item and the Claude tab disappears —
 * so a stored selection would leave the list filtered to a source with no tab to unset
 * it, which is the "silently emptied with no visible cause" trap `TagFilter` documents
 * at length.
 *
 * Deriving also means an Undo puts the selection back: the row returns, the tab returns,
 * and the filter the user set is still the filter they get. Storing it and clearing it on
 * empty would lose that.
 */
export function effectiveSource(chosen, tabs) {
  if (!chosen || chosen === ALL_SOURCES) return ALL_SOURCES;
  return tabs.some((t) => t.key === chosen) ? chosen : ALL_SOURCES;
}

/** Does this capture belong under the selected tab? */
export function matchesSource(inboxItem, source) {
  if (!source || source === ALL_SOURCES) return true;
  const key = SOURCE_ORDER.includes(inboxItem?.sourceType) ? inboxItem.sourceType : "manual";
  return key === source;
}
