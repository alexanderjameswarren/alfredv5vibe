// One row per thing (Restructure P4): an item and its intentions are one row;
// an intention with no item on the page is a row of its own. Pure.
import { itemActionTarget } from "./runNow";
import { filterByStatus, liveEventsFor, statusCounts, statusOf, withTag } from "./status";
import { sortRows } from "./sortOrders";
import { matchesQuery } from "./search";
import { toLocalDateString } from "./eventDates";
import { groupDisplayName, groupIntention, groupTypeOf, liveMembers } from "../groups/groupModel";

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
  // A group's own intention (P5 step 13) is never a row: it shows as the group.
  const live = intents.filter((i) => !i.archived && !i.groupId);
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
      // The item's own covers its intentions (executions_last_completed).
      lastCompletedAt: item.lastCompletedAt || null,
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
      lastCompletedAt: intent.lastCompletedAt || null,
    });
  }
  return rows;
}

/**
 * Restructure P5: one row per live group, for the same lists. A group has no tags
 * of its own: it carries its live members' tags (for the tag filter) and their
 * names (for search). `groups` is what the page shows; archived ones are left out.
 * `ownIntent`, `event` and `open`: the group's own intention, its live date and open run.
 */
export function buildGroupRows({ groups = [], groupTypes = [], members = [], items = [], intents = [], events = [], openExecutions = [] }) {
  return groups
    .filter((g) => !g.archived)
    .map((group) => {
      const live = liveMembers(group.id, { members, items, intents });
      const ownIntent = groupIntention(group.id, intents);
      return {
        key: `group:${group.id}`,
        kind: "group",
        group,
        type: groupTypeOf(group, groupTypes),
        item: null,
        intent: null,
        intents: [],
        ownIntent,
        ...attributes(ownIntent, events, openExecutions),
        status: statusOf(group),
        tags: unique(live.flatMap((m) => m.record.tags || [])),
        name: groupDisplayName(group, { members, items, intents }),
        memberNames: live.map((m) => m.name),
        memberCount: live.length,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
        lastCompletedAt: group.lastCompletedAt || null,
      };
    });
}

const latest = (dates) => dates.filter(Boolean).sort().pop() || null;

// For sortRows. `updated` on an item row is the latest change to the item or
// any of its intentions, and is the date the row's card shows. "Last done" has
// its own order, `sortByLastDone`.
export const ROW_ACCESSORS = {
  title: (r) => r.name,
  created: (r) => r.createdAt,
  updated: (r) => r.updatedAt,
  done: (r) => r.lastCompletedAt,
};

/**
 * "Last done" (Restructure P5). Never done counts as the OLDEST: last when
 * newest first, first when oldest first. A tie on the day puts a group before
 * items, then name, so a cooked menu sits directly above its recipes.
 */
export function sortByLastDone(rows, dir = "desc") {
  // The local day, as the row shows it.
  const day = (r) => (r.lastCompletedAt ? toLocalDateString(new Date(r.lastCompletedAt)) : "");
  return [...rows].sort((a, b) => {
    const da = day(a);
    const db = day(b);
    if (da !== db) return (da < db ? -1 : 1) * (dir === "asc" ? 1 : -1);
    const ga = a.kind === "group" ? 0 : 1;
    const gb = b.kind === "group" ? 0 : 1;
    if (ga !== gb) return ga - gb;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

/**
 * What a search matches on a row: the item's fields and every intention's text;
 * on a group row, its name (typed or derived) and its live members' names.
 */
export function rowSearchFields(row, itemFields) {
  if (row.kind === "group") return [row.name, ...(row.memberNames || [])];
  return [...(row.item ? itemFields(row.item) : []), ...row.intents.map((i) => i.text)];
}

/**
 * The section's tabs (Restructure P5): All, one per group type present, then
 * Items and intentions. None at all when there are no group rows. Counts are of `rows`.
 */
export function rowTabs(rows) {
  const groupRows = rows.filter((r) => r.kind === "group");
  if (groupRows.length === 0) return [];
  const types = [];
  for (const r of groupRows) {
    const id = r.type?.id || "none";
    if (!types.some((t) => t.id === id)) types.push({ id, label: r.type?.labelPlural || "Groups", icon: r.type?.icon });
  }
  return [
    { key: "all", label: "All", count: rows.length },
    ...types.map((t) => ({
      key: `type:${t.id}`,
      label: t.label,
      icon: t.icon,
      count: groupRows.filter((r) => (r.type?.id || "none") === t.id).length,
    })),
    { key: "items", label: "Items and intentions", count: rows.filter((r) => r.kind !== "group").length },
  ];
}

/** The rows a tab shows. */
export function rowsForTab(rows, tab) {
  if (!tab || tab === "all") return rows;
  if (tab === "items") return rows.filter((r) => r.kind !== "group");
  const id = tab.slice("type:".length);
  return rows.filter((r) => r.kind === "group" && (r.type?.id || "none") === id);
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
  const shown = filterByStatus(tagged, statuses);
  return {
    visibleRows: sortKey === "done" ? sortByLastDone(shown, sortDir) : sortRows(shown, sortKey, ROW_ACCESSORS, sortDir),
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
