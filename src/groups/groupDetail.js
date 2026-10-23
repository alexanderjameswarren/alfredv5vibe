// The group detail page's data (Restructure P5 step 10). Pure.
import { buildRows } from "../utils/rowModel";
import { groupDisplayName, liveMembers, removedMembers } from "./groupModel";

export const RECENT_REMOVALS = 5;

/** The page title: the typed name, else the derived one, else the type's word. */
export function groupTitle(group, lists, type) {
  return groupDisplayName(group, lists) || `Untitled ${(type?.labelSingular || "group").toLowerCase()}`;
}

/**
 * One standard row (rowModel) per live member, in position order. An item row
 * carries its own intentions, as on the context page; an intention row is itself.
 */
export function memberRows(groupId, { members = [], items = [], intents = [], events = [], openExecutions = [] }) {
  return liveMembers(groupId, { members, items, intents }).flatMap((m) =>
    m.memberType === "item"
      ? buildRows({ items: [m.record], intents: intents.filter((i) => i.itemId === m.record.id), events, openExecutions })
      : buildRows({ items: [], intents: [m.record], events, openExecutions }),
  );
}

/**
 * The "Recently removed" panel: the latest removals whose member is not in the
 * group again, newest first, as the collection page's panel leaves out put-back rows.
 */
export function recentRemovals(groupId, lists, limit = RECENT_REMOVALS) {
  const live = new Set(
    (lists.members || [])
      .filter((m) => m.groupId === groupId && !m.removedAt)
      .map((m) => `${m.memberType}:${m.memberId}`),
  );
  const seen = new Set();
  return removedMembers(groupId, lists)
    .filter((r) => {
      // One line per member: its latest removal.
      const key = `${r.member.memberType}:${r.member.memberId}`;
      if (live.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}
