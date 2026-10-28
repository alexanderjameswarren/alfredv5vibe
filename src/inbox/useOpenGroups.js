import { useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import { groupDisplayName } from "../groups/groupModel";

/**
 * The groups a capture can be suggested into (Overwatch 8c, migration 184): Alex's groups of
 * any type that are not closed and not archived, each with its type's label and icon and its
 * display name (a group with no typed name is named from its live members, as everywhere else).
 * Read when the inbox list or detail page opens. On a failed read the list is empty and the
 * suggestion is shown without a picker rather than wrongly.
 */
export async function loadOpenGroups() {
  const [groups, types] = await Promise.all([
    supabase.from("item_groups").select("id, name, group_type_id, context_id, status")
      .eq("archived", false).neq("status", "closed"),
    supabase.from("group_types").select("id, label_singular, icon"),
  ]);
  if (groups.error || types.error) throw new Error("Could not load the groups.");
  const rows = groups.data || [];
  const unnamed = rows.filter((g) => !g.name?.trim()).map((g) => g.id);
  let lists = { members: [], items: [], intents: [] };
  if (unnamed.length) {
    const members = await supabase.from("item_group_members").select("id, group_id, member_type, member_id, position")
      .in("group_id", unnamed).is("removed_at", null);
    const m = (members.data || []).map((r) => ({
      id: r.id, groupId: r.group_id, memberType: r.member_type, memberId: r.member_id, position: r.position,
    }));
    const ids = (type) => m.filter((r) => r.memberType === type).map((r) => r.memberId);
    const [items, intents] = await Promise.all([
      ids("item").length ? supabase.from("items").select("id, name, archived").in("id", ids("item")) : { data: [] },
      ids("intention").length ? supabase.from("intents").select("id, text, archived").in("id", ids("intention")) : { data: [] },
    ]);
    lists = { members: m, items: items.data || [], intents: intents.data || [] };
  }
  const typeById = new Map((types.data || []).map((t) => [t.id, t]));
  return rows.map((g) => {
    const type = typeById.get(g.group_type_id);
    return {
      id: g.id,
      name: groupDisplayName(g, lists) || `Unnamed ${(type?.label_singular || "group").toLowerCase()}`,
      typeLabel: type?.label_singular || "Group",
      typeIcon: type?.icon || null,
      contextId: g.context_id || null,
      status: g.status,
    };
  });
}

export default function useOpenGroups() {
  const [groups, setGroups] = useState([]);
  useEffect(() => {
    let live = true;
    loadOpenGroups()
      .then((rows) => live && setGroups(rows))
      .catch(() => live && setGroups([]));
    return () => { live = false; };
  }, []);
  return groups;
}
