// One row per thing (Restructure P4): an item and its intentions are one row;
// an intention with no item on the page is a row of its own. Pure.
import { itemActionTarget } from "./runNow";
import { liveEventsFor, statusOf } from "./status";

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

/**
 * Rows in order of what is happening now, as rankByActivity orders intentions:
 * open run (active, then paused), scheduled (soonest first), unscheduled,
 * background, closed. Stable within a group.
 */
export function rankRows(rows) {
  const tier = (row) => {
    if (row.open) return row.open.status === "paused" ? 1 : 0;
    if (row.status === "closed") return 5;
    if (row.status === "background") return 4;
    return row.event ? 2 : 3;
  };
  return rows
    .map((row, i) => ({ row, i, t: tier(row), d: String(row.event?.time || "") }))
    .sort((a, b) => a.t - b.t || (a.t === 2 ? a.d.localeCompare(b.d) : 0) || a.i - b.i)
    .map(({ row }) => row);
}

function attributes(intent, events, openExecutions) {
  if (!intent) return { event: null, open: null };
  return {
    event: liveEventsFor(events, intent.id)[0] || null,
    open: openExecutions.find((x) => x.intentId === intent.id) || null,
  };
}
