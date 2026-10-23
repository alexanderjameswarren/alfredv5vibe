import React, { createContext, useContext, useMemo } from "react";
import { GroupTypeIcon } from "../shared/ObjectIcon";
import { groupDisplayName, groupsForRecord, groupTypeOf } from "./groupModel";

// Restructure P5 step 12. Alfred provides the loaded groups once, so any card or
// header can show "the groups this record is in" without new props on every list.
// Outside a provider (tests, other apps) there are no groups and nothing shows.
const GroupsContext = createContext(null);

export function GroupsProvider({ itemGroups = [], groupTypes = [], groupMembers = [], items = [], intents = [], onOpenGroup, children }) {
  const value = useMemo(
    () => ({ lists: { groups: itemGroups, groupTypes, members: groupMembers, items, intents }, onOpenGroup }),
    [itemGroups, groupTypes, groupMembers, items, intents, onOpenGroup],
  );
  return <GroupsContext.Provider value={value}>{children}</GroupsContext.Provider>;
}

/**
 * The live groups a record is a live member of, as chips: [{ id, name, icon }].
 * `records`: [{ memberType: "item" | "intention", id }]; a merged row passes its
 * item and its intentions. Pure, for tests.
 */
export function chipsFor(records, { groups = [], groupTypes = [], members = [], items = [], intents = [] }) {
  const seen = new Map();
  for (const r of records) {
    if (!r?.id) continue;
    for (const g of groupsForRecord(r.memberType, r.id, { groups, members })) {
      if (seen.has(g.id)) continue;
      seen.set(g.id, {
        id: g.id,
        name: groupDisplayName(g, { members, items, intents }) || "Untitled group",
        icon: groupTypeOf(g, groupTypes)?.icon,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A group by id, as a chip, if it is live: for executions and events that carry group_id. */
export function chipForGroup(groupId, { groups = [], groupTypes = [], members = [], items = [], intents = [] }) {
  const g = groups.find((x) => x.id === groupId && !x.archived);
  if (!g) return null;
  return { id: g.id, name: groupDisplayName(g, { members, items, intents }) || "Untitled group", icon: groupTypeOf(g, groupTypes)?.icon };
}

/** Chips for records, plus how to open one. Empty outside a provider. */
export function useRecordGroups(records) {
  const ctx = useContext(GroupsContext);
  if (!ctx) return { chips: [], onOpenGroup: null };
  return { chips: chipsFor(records, ctx.lists), onOpenGroup: ctx.onOpenGroup };
}

/** The group an execution or event belongs to: its own group_id, else its intention's groups. */
export function useExecutionGroups({ groupId, intentId, itemIds = [] }) {
  const ctx = useContext(GroupsContext);
  if (!ctx) return { chips: [], onOpenGroup: null };
  const own = groupId ? chipForGroup(groupId, ctx.lists) : null;
  const chips = own
    ? [own]
    : chipsFor(
        [{ memberType: "intention", id: intentId }, ...itemIds.map((id) => ({ memberType: "item", id }))],
        ctx.lists,
      );
  return { chips, onOpenGroup: ctx.onOpenGroup };
}

/** One line of group chips: type icon and name, each opening its group. Nothing when empty. */
export function GroupChips({ chips = [], onOpenGroup, className = "" }) {
  if (chips.length === 0) return null;
  return (
    <div className={`flex flex-wrap items-center gap-1.5 mt-1 ${className}`} aria-label="Groups">
      {chips.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenGroup?.(c.id);
          }}
          disabled={!onOpenGroup}
          title={`Open group: ${c.name}`}
          className="inline-flex items-center gap-1 max-w-full text-xs bg-secondary hover:bg-muted text-foreground px-2 py-0.5 rounded transition-colors"
        >
          <GroupTypeIcon icon={c.icon} className="w-3.5 h-3.5" />
          <span className="truncate">{c.name}</span>
        </button>
      ))}
    </div>
  );
}

/** The chip line for records, from the provider. */
export function RecordGroupChips({ records, className }) {
  const { chips, onOpenGroup } = useRecordGroups(records);
  return <GroupChips chips={chips} onOpenGroup={onOpenGroup} className={className} />;
}
