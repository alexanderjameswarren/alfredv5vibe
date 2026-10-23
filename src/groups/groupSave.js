// Saving the group create/edit page (Restructure P5). `storage` and `newId` are
// passed in so the logic is testable without Supabase.

/**
 * The type a new group in this context starts with: the context's default, else
 * the first type by name. Types are shared across contexts (migration 150).
 */
export function defaultTypeId(contextId, { contexts = [], groupTypes = [] }) {
  const ctx = contexts.find((c) => c.id === contextId);
  if (ctx?.defaultGroupTypeId && groupTypes.some((t) => t.id === ctx.defaultGroupTypeId)) {
    return ctx.defaultGroupTypeId;
  }
  return sortTypes(groupTypes)[0]?.id || null;
}

/** Group types in name order, for every picker. */
export function sortTypes(groupTypes = []) {
  return [...groupTypes].sort((a, b) => String(a.labelSingular).localeCompare(String(b.labelSingular)));
}

/** The item_groups row the form writes. A blank name is null: derived at read time. */
export function groupRow(draft) {
  return {
    groupTypeId: draft.groupTypeId,
    contextId: draft.contextId || null,
    name: draft.name?.trim() || null,
    description: draft.description?.trim() || null,
    pinned: Boolean(draft.pinned),
  };
}

/**
 * What the member list needs written. `drafts` is the list on screen, in order:
 * [{ id?, memberType, memberId }], `id` set for rows already saved.
 * Positions are 1..n in screen order; only changed ones move.
 */
export function planMembers(existing, drafts, newId) {
  const live = existing.filter((m) => !m.removedAt);
  const keep = new Set(drafts.filter((d) => d.id).map((d) => d.id));
  // Removed, not deleted (migration 149): the row stays as the group's history.
  const removes = live.filter((m) => !keep.has(m.id)).map((m) => m.id);
  const inserts = [];
  const moves = [];
  const order = drafts.map((d, i) => {
    const position = i + 1;
    if (!d.id) {
      const id = newId();
      inserts.push({ id, memberType: d.memberType, memberId: d.memberId, position });
      return id;
    }
    if (live.find((m) => m.id === d.id)?.position !== position) moves.push({ id: d.id, position });
    return d.id;
  });
  return { removes, inserts, moves, order };
}

/**
 * Create (group null) or edit a group and its members.
 * Create is all-or-nothing: if a member write fails the new group is deleted
 * (its members go with it by cascade) and the error is thrown.
 * @returns {{ group, members }} the saved group and its members in order.
 */
export async function saveGroup({ group, draft, existingMembers = [] }, { storage, newId }) {
  const creating = !group;
  const id = creating ? newId() : group.id;
  const saved = await storage.set(`group:${id}`, { id, ...groupRow(draft) });
  if (!saved) throw new Error(creating ? "The group was not created." : "The group was not saved.");

  const plan = planMembers(creating ? [] : existingMembers, draft.members || [], newId);
  const written = [];
  const removed = [];
  try {
    const removedAt = new Date().toISOString();
    for (const memberId of plan.removes) {
      const row = await storage.patch(`group_member:${memberId}`, { removedAt });
      if (!row) throw new Error("A member was not removed.");
      removed.push(row);
    }
    for (const m of plan.inserts) {
      const row = await storage.set(`group_member:${m.id}`, { ...m, groupId: id });
      if (!row) throw new Error("A member was not added.");
      written.push(row);
    }
    for (const m of plan.moves) {
      const row = await storage.patch(`group_member:${m.id}`, { position: m.position });
      if (!row) throw new Error("The new order was not saved.");
      written.push(row);
    }
  } catch (e) {
    if (creating) {
      await storage.delete(`group:${id}`);
      throw new Error(`${e.message} Nothing was saved.`);
    }
    throw e;
  }

  const byId = new Map([...existingMembers, ...written].map((r) => [r.id, r]));
  return { group: saved, members: plan.order.map((mid) => byId.get(mid)), removed };
}

/**
 * Put a removed member back: a NEW live row at the end (as a collection's Put back
 * does), the removed row left as it is so the history keeps every removal.
 * Refused when the same item or intention is already a live member.
 */
export async function restoreMember(member, groupMembers, { storage, newId }) {
  const live = groupMembers.filter((m) => m.groupId === member.groupId && !m.removedAt);
  if (live.some((m) => m.memberType === member.memberType && m.memberId === member.memberId)) {
    throw new Error("It is already in the group.");
  }
  const id = newId();
  const position = live.reduce((max, m) => Math.max(max, m.position), 0) + 1;
  const row = await storage.set(`group_member:${id}`, {
    id,
    groupId: member.groupId,
    memberType: member.memberType,
    memberId: member.memberId,
    position,
  });
  if (!row) throw new Error("It was not put back.");
  return row;
}
