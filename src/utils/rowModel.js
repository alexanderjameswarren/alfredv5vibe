// One row per thing (Restructure P4): an item and its intentions are one row;
// an intention with no item on the page is a row of its own. Pure.
import { itemActionTarget } from "./runNow";
import { filterByStatus, liveEventsFor, statusCounts, statusOf, withTag } from "./status";
import { sortRows } from "./sortOrders";
import { matchesQuery } from "./search";

const unique = (values) => [...new Set(values)];

/**
 * The intention an item's row shows schedule and repeat for: the one Run Now
 * would pick (open run, then recurring with the earliest live event, then newest
 * one-off). Null when every intention is closed: the row is then "Not scheduled".
 */
export function pickIntentionForItem(itemId, intents, events, openExecutions) {
  return itemActionTarget(itemId, intents, events, openExecutions)?.intent || null;
}

/**
 * Rows for a list. `items` and `intents` are what the page shows; an intention
 * whose item is not in `items` stays its own row. `itemsWithoutIntents: false`
 * leaves out items with no intention (the Intentions list).
 * Each row: { key, kind, item, intent, intents, event, open, status, tags }.
 */
export function buildRows({ items = [], intents = [], events = [], openExecutions = [], itemsWithoutIntents = true }) {
  const live = intents.filter((i) => !i.archived);
  const itemIds = new Set(items.map((i) => i.id));
  const rows = [];

  for (const item of items) {
    const own = live.filter((i) => i.itemId === item.id);
    if (own.length === 0 && !itemsWithoutIntents) continue;
    const intent = own.length ? pickIntentionForItem(item.id, own, events, openExecutions) : null;
    rows.push({
      key: `item:${item.id}`,
      kind: "item",
      item,
      intent,
      intents: own,
      ...attributes(intent, events, openExecutions),
      // A merged row's chip is the item's; the intention shows only in the schedule line.
      status: statusOf(item),
      tags: unique([...(item.tags || []), ...own.flatMap((i) => i.tags || [])]),
      name: item.name,
      createdAt: item.createdAt,
      updatedAt: latest([item, ...own].map((r) => r.updatedAt)),
    });
  }

  for (const intent of live) {
    if (intent.itemId && itemIds.has(intent.itemId)) continue;
    rows.push({
      key: `intent:${intent.id}`,
      kind: "intention",
      item: null,
      intent,
      intents: [intent],
      ...attributes(intent, events, openExecutions),
      status: statusOf(intent),
      tags: intent.tags || [],
      name: intent.text,
      createdAt: intent.createdAt,
      updatedAt: intent.updatedAt,
    });
  }
  return rows;
}

const latest = (dates) => dates.filter(Boolean).sort().pop() || null;

// For sortRows. `updated` on an item row is the latest change to the item or
// any of its intentions, and is the date the row's card shows.
export const ROW_ACCESSORS = {
  title: (r) => r.name,
  created: (r) => r.createdAt,
  updated: (r) => r.updatedAt,
};

/** What a search matches on a row: the item's fields and every intention's text. */
export function rowSearchFields(row, itemFields) {
  return [...(row.item ? itemFields(row.item) : []), ...row.intents.map((i) => i.text)];
}

/** True while the row's item or any of its intentions has an open (active or paused) run. */
export function hasOpenRun(row, openExecutions) {
  const ids = new Set(row.intents.map((i) => i.id));
  return openExecutions.some((x) => ids.has(x.intentId) || (row.item && x.itemIds?.includes(row.item.id)));
}

/**
 * One list's filters, sort and counts. Rows with an open run are left out: they
 * show in the In progress section instead. Every other row follows the chosen
 * sort exactly (bug a). Each filter's counts apply every other filter: status
 * counts under search and tag, tag counts (`tagCountRows`, for TagFilter) under
 * search and status. Merged rows count once. `total` is the list before filters.
 */
export function listRows({ rows, openExecutions = [], search = "", itemFields, filterTag = null, statuses, sortKey, sortDir }) {
  const listed = rows.filter((row) => !hasOpenRun(row, openExecutions));
  const searched = listed.filter((row) => matchesQuery(search, ...rowSearchFields(row, itemFields)));
  const tagged = withTag(searched, filterTag);
  return {
    visibleRows: sortRows(filterByStatus(tagged, statuses), sortKey, ROW_ACCESSORS, sortDir),
    statusCounts: statusCounts(tagged),
    tagCountRows: filterByStatus(searched, statuses),
    total: listed.length,
  };
}

function attributes(intent, events, openExecutions) {
  if (!intent) return { event: null, open: null };
  return {
    event: liveEventsFor(events, intent.id)[0] || null,
    open: openExecutions.find((x) => x.intentId === intent.id) || null,
  };
}
