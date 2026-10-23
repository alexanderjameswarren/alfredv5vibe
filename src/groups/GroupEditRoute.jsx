import React, { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { groupDetailPath, groupEditPath, groupHistoryPath, groupRouteFromPath, VIEW_TO_PATH } from "../viewPaths";
import { storage } from "../utils/storage";
import { uid } from "../utils/flattenElements";
import { groupDisplayName } from "./groupModel";
import { restoreMember, saveGroup } from "./groupSave";
import GroupEditScreen from "./GroupEditScreen";
import GroupHistoryScreen from "./GroupHistoryScreen";
import GroupDetailScreen from "./GroupDetailScreen";

// Replace rows by id, adding new ones: the realtime echo of the same write is a no-op.
const upsert = (prev, rows) => [...prev.filter((r) => !rows.some((x) => x.id === r.id)), ...rows];

/**
 * The group pages: `/groups/new/context/:contextId`, `/groups/edit/:groupId`,
 * `/groups/history/:groupId` and `/groups/detail/:groupId` (the bare
 * /groups/detail shows `selectedGroupId`, the group last opened, which is where
 * Back from a member's page lands). Rendered only once Alfred's data has
 * loaded, so a missing context or group is really gone: it goes to the
 * contexts list, as a stale address does.
 */
export default function GroupEditRoute({
  view,
  currentPath,
  contexts,
  items,
  intents,
  events = [],
  executions = [],
  groupTypes,
  itemGroups,
  groupMembers,
  setItemGroups,
  setGroupMembers,
  selectedGroupId,
  setSelectedGroupId,
  openContext,
  setUnsavedChanges,
  // Step 13: useGroupActions' writers, and closeRecords for Close.
  groupActions,
  onCloseRecords,
  // Step 14: Start Now and (14b) Log Execution on a menu.
  onStartGroupNow,
  onLogMenu,
  onOpenExecution,
  rowListProps,
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const route =
    groupRouteFromPath(currentPath) ||
    (view === "group-detail" && selectedGroupId ? { view: "group-detail", groupId: selectedGroupId } : null);
  // Archived groups are still found, so archiving from here leaves by `leave`
  // rather than by the missing-group redirect racing it.
  const group = route?.groupId ? itemGroups.find((g) => g.id === route.groupId) : null;
  const context = route?.view === "group-new" ? contexts.find((c) => c.id === route.contextId) : null;
  const missing = !route || (route.view === "group-new" ? !context : !group);

  useEffect(() => {
    if (missing) navigate(VIEW_TO_PATH.contexts, { replace: true });
  }, [missing, navigate]);
  // An archived group is not editable (bug mvjx4363b4bn4gezrys): its edit address shows the group.
  const editingArchived = route?.view === "group-edit" && Boolean(group?.archived);
  useEffect(() => {
    if (editingArchived) navigate(groupDetailPath(group.id), { replace: true });
  }, [editingArchived]); // eslint-disable-line react-hooks/exhaustive-deps
  // Remember the group shown, for the bare /groups/detail Back returns to.
  const shownId = route?.view === "group-detail" ? group?.id : null;
  useEffect(() => {
    if (shownId && shownId !== selectedGroupId) setSelectedGroupId(shownId);
  }, [shownId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (missing || editingArchived) return null;
  const inApp = { state: { fromApp: true } };

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
        // In-app: Back to the page it came from; cold: open the group.
        onBack={() => (location.state?.fromApp ? navigate(-1) : navigate(groupDetailPath(group.id), { replace: true }))}
        onRestore={handleRestore}
        archived={Boolean(group.archived)}
      />
    );
  }

  // `then` is where to go after: the detail page leaves the way it came, the edit
  // page goes to the context (Back to an archived group's detail would be a dead end).
  // Archive and Restore take the group's own intention with them (step 13).
  const handleArchive = (then) => groupActions.archiveGroup(group.id, then);
  // Restore from the group's own page: un-archive in place.
  const handleUnarchive = () => groupActions.unarchiveGroup(group.id);

  if (route.view === "group-detail") {
    return (
      <GroupDetailScreen
        key={group.id}
        group={group}
        groupTypes={groupTypes}
        groupMembers={groupMembers}
        contexts={contexts}
        items={items}
        intents={intents}
        events={events}
        executions={executions}
        onBack={() => leave(group.contextId)}
        onEdit={() => navigate(groupEditPath(group.id), inApp)}
        onArchive={() => handleArchive(() => leave(group.contextId))}
        onRestore={handleRestore}
        onOpenHistory={() => navigate(groupHistoryPath(group.id), inApp)}
        onViewContextDetail={openContext}
        onOpenExecution={onOpenExecution}
        onUnarchive={handleUnarchive}
        onSchedule={groupActions.scheduleGroup}
        onSetStatus={groupActions.setGroupStatus}
        onCloseRecords={onCloseRecords}
        onStartNow={onStartGroupNow}
        onLogMenu={onLogMenu}
        rowListProps={rowListProps}
      />
    );
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
      onArchive={group && !group.archived ? () => handleArchive(() => openContext(group.contextId)) : null}
      onOpenHistory={group ? () => navigate(groupHistoryPath(group.id), inApp) : null}
      onDirtyChange={setUnsavedChanges}
    />
  );
}
