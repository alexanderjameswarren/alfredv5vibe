import React, { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { groupEditPath, groupHistoryPath, groupRouteFromPath, VIEW_TO_PATH } from "../viewPaths";
import { storage } from "../utils/storage";
import { uid } from "../utils/flattenElements";
import { groupDisplayName } from "./groupModel";
import { restoreMember, saveGroup } from "./groupSave";
import GroupEditScreen from "./GroupEditScreen";
import GroupHistoryScreen from "./GroupHistoryScreen";

// Replace rows by id, adding new ones: the realtime echo of the same write is a no-op.
const upsert = (prev, rows) => [...prev.filter((r) => !rows.some((x) => x.id === r.id)), ...rows];

/**
 * `/groups/new/context/:contextId`, `/groups/edit/:groupId` and
 * `/groups/history/:groupId`. Rendered only
 * once Alfred's data has loaded, so a missing context or group is really gone:
 * it goes to the contexts list, as a bare or stale address does.
 */
export default function GroupEditRoute({
  currentPath,
  contexts,
  items,
  intents,
  groupTypes,
  itemGroups,
  groupMembers,
  setItemGroups,
  setGroupMembers,
  openContext,
  offerUndoFor,
  withLoading,
  setUnsavedChanges,
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const route = groupRouteFromPath(currentPath);
  // Archived groups are still found, so archiving from here leaves by `leave`
  // rather than by the missing-group redirect racing it.
  const group = route?.groupId ? itemGroups.find((g) => g.id === route.groupId) : null;
  const context = route?.view === "group-new" ? contexts.find((c) => c.id === route.contextId) : null;
  const missing = !route || (route.view === "group-new" ? !context : !group);

  useEffect(() => {
    if (missing) navigate(VIEW_TO_PATH.contexts, { replace: true });
  }, [missing, navigate]);
  if (missing) return null;

  // Back to where the page was opened from; cold, to the group's context.
  function leave(contextId) {
    setUnsavedChanges(false);
    if (location.state?.fromApp) navigate(-1);
    else if (contextId) openContext(contextId);
    else navigate(VIEW_TO_PATH.contexts, { replace: true });
  }

  async function handleSave(draft) {
    // Not withLoading: it alerts and swallows the error, and the page shows its own.
    const existingMembers = group ? groupMembers.filter((m) => m.groupId === group.id) : [];
    const saved = await saveGroup({ group, draft, existingMembers }, { storage, newId: uid });
    setItemGroups((prev) => upsert(prev, [saved.group]));
    setGroupMembers((prev) => upsert(prev, [...saved.members, ...saved.removed]));
    leave(saved.group.contextId);
  }

  async function handleRestore(member) {
    const back = await restoreMember(member, groupMembers, { storage, newId: uid });
    setGroupMembers((prev) => upsert(prev, [back]));
  }

  if (route.view === "group-history") {
    return (
      <GroupHistoryScreen
        groupName={groupDisplayName(group, { members: groupMembers, items, intents }) || "This group"}
        groupId={group.id}
        groupMembers={groupMembers}
        items={items}
        intents={intents}
        // In-app: Back to the edit page it came from; cold: open the edit page.
        onBack={() => (location.state?.fromApp ? navigate(-1) : navigate(groupEditPath(group.id), { replace: true }))}
        onRestore={handleRestore}
      />
    );
  }

  function handleArchive() {
    const name = groupDisplayName(group, { members: groupMembers, items, intents }) || "group";
    return withLoading("Archiving...", async () => {
      const archived = await storage.patch(`group:${group.id}`, { archived: true });
      if (!archived) throw new Error("The group was not archived.");
      setItemGroups((prev) => upsert(prev, [archived]));
      offerUndoFor(`Archived "${name}".`, async () => {
        const back = await storage.patch(`group:${group.id}`, { archived: false });
        if (!back) throw new Error("Restoring the group was not saved.");
        setItemGroups((prev) => upsert(prev, [back]));
      });
      leave(group.contextId);
    });
  }

  return (
    <GroupEditScreen
      key={route.groupId || route.contextId}
      group={group}
      initialContextId={context?.id}
      groupTypes={groupTypes}
      contexts={contexts}
      items={items}
      intents={intents}
      groupMembers={groupMembers}
      onSave={handleSave}
      onCancel={() => leave(group?.contextId || context?.id)}
      onArchive={group ? handleArchive : null}
      onOpenHistory={group ? () => navigate(groupHistoryPath(group.id), { state: { fromApp: true } }) : null}
      onDirtyChange={setUnsavedChanges}
    />
  );
}
