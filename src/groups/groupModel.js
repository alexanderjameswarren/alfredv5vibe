// Groups (Restructure P5): pure helpers over the loaded lists. No React, no storage.
// A member row names an item or an intention by id with no foreign key, so every
// reader goes through liveMembers, which leaves out deleted and archived records
// and removed members (removedAt set: the group's removal history, migration 149).

export const FALLBACK_GROUP_ICON = "Boxes";
export const NAME_JOINER = " + ";

const byId = (rows = []) => new Map(rows.map((r) => [r.id, r]));

/** A group's live members in position order: [{ member, memberType, record, name }]. */
export function liveMembers(groupId, { members = [], items = [], intents = [] }) {
  const itemsById = byId(items);
  const intentsById = byId(intents);
  return members
    .filter((m) => m.groupId === groupId && !m.removedAt)
    .sort((a, b) => a.position - b.position || String(a.id).localeCompare(String(b.id)))
    .map((member) => {
      const record =
        member.memberType === "item" ? itemsById.get(member.memberId) : intentsById.get(member.memberId);
      if (!record || record.archived) return null;
      const name = member.memberType === "item" ? record.name : record.text;
      return { member, memberType: member.memberType, record, name: name || "" };
    })
    .filter(Boolean);
}

/** The name built from live members, e.g. "Rice + Beans + Salsa". Never stored. */
export function derivedGroupName(groupId, lists) {
  return liveMembers(groupId, lists)
    .map((m) => m.name.trim())
    .filter(Boolean)
    .join(NAME_JOINER);
}

/** The typed name, or the derived one when the name is null or blank. */
export function groupDisplayName(group, lists) {
  const typed = group?.name?.trim();
  return typed || derivedGroupName(group?.id, lists);
}

/** Non-archived groups that hold this item ("item") or intention ("intention"). */
export function groupsForRecord(memberType, recordId, { groups = [], members = [] }) {
  const ids = new Set(
    members
      .filter((m) => m.memberType === memberType && m.memberId === recordId && !m.removedAt)
      .map((m) => m.groupId)
  );
  return groups.filter((g) => ids.has(g.id) && !g.archived);
}

/**
 * A group's removal history, newest first: [{ member, name, record }]. `record` is
 * null when the item or intention is gone; the name then falls back to "Unavailable".
 */
export function removedMembers(groupId, { members = [], items = [], intents = [] }) {
  const itemsById = byId(items);
  const intentsById = byId(intents);
  return members
    .filter((m) => m.groupId === groupId && m.removedAt)
    .sort((a, b) => String(b.removedAt).localeCompare(String(a.removedAt)))
    .map((member) => {
      const record =
        (member.memberType === "item" ? itemsById.get(member.memberId) : intentsById.get(member.memberId)) || null;
      const name = record ? (member.memberType === "item" ? record.name : record.text) : null;
      return { member, record, name: name || "Unavailable" };
    });
}

/** The group's own intention (at most one is not archived; intents_one_per_group). */
export function groupIntention(groupId, intents = []) {
  return intents.find((i) => i.groupId === groupId && !i.archived) || null;
}

export function groupTypeOf(group, groupTypes = []) {
  return groupTypes.find((t) => t.id === group?.groupTypeId) || null;
}

export function groupIcon(group, groupTypes) {
  return groupTypeOf(group, groupTypes)?.icon || FALLBACK_GROUP_ICON;
}

/**
 * For a separately group (project, series): whether any member has a running
 * (active, not paused) execution — on a member intention, on an intention of a
 * member item, or carrying a member item in item_ids. Together groups: false.
 */
export function hasRunningMember(group, { groupTypes = [], members = [], items = [], intents = [], activeExecutions = [] }) {
  if (groupTypeOf(group, groupTypes)?.executionMode !== "separately") return false;
  const live = liveMembers(group.id, { members, items, intents });
  const intentIds = new Set(live.filter((m) => m.memberType === "intention").map((m) => m.record.id));
  const itemIds = new Set(live.filter((m) => m.memberType === "item").map((m) => m.record.id));
  for (const i of intents) if (i.itemId && itemIds.has(i.itemId)) intentIds.add(i.id);
  return activeExecutions.some(
    (x) => x.status !== "paused" && (intentIds.has(x.intentId) || (x.itemIds || []).some((id) => itemIds.has(id)))
  );
}
