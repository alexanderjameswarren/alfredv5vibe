import { storage, writeError } from "../utils/storage";
import { uid } from "../utils/flattenElements";
import { formatEventDate } from "../utils/eventDates";
import { liveEventsFor, statusOf, statusOptionsFor, statusPatch, STATUS_LABELS } from "../utils/status";
import { cancelRemindersForStatus, restoreRemindersAfterStatus } from "../utils/remindersApi";
import { statusUndoWhat } from "../intentions/useIntentionActions";
import { groupDisplayName, groupIntention, liveMembers } from "./groupModel";

/**
 * The group's own intention as first written (Restructure P5 step 13): named after
 * the group at that moment, in its context, one-off. The database links its events
 * to the group and freezes the members (events_group_freeze).
 */
export function newGroupIntention(group, lists, { id, userId, now = new Date() }) {
  return {
    id,
    user_id: userId,
    text: groupDisplayName(group, lists) || "Untitled group",
    groupId: group.id,
    contextId: group.contextId || null,
    isIntention: true,
    archived: false,
    recurrenceConfig: { type: "once" },
    createdAt: now.toISOString(),
  };
}

/** The archived own intention Restore brings back: the newest one, if no live one exists. */
export function intentionToRestore(groupId, intents = []) {
  if (groupIntention(groupId, intents)) return null;
  return (
    intents
      .filter((i) => i.groupId === groupId && i.archived)
      .sort((a, b) => String(b.archivedAt || b.updatedAt || "").localeCompare(String(a.archivedAt || a.updatedAt || "")))[0] || null
  );
}

/**
 * Group writers (Restructure P5 step 13): schedule through the group's own
 * intention, status, archive and restore. Close goes through closeRecords with
 * `group`. Holds no state; everything comes from Alfred.
 */
export function useGroupActions({
  user,
  itemGroups,
  setItemGroups,
  groupMembers,
  items,
  intents,
  setIntents,
  events,
  setEvents,
  withLoading,
  offerUndoFor,
  watchStatus,
  moveToPlanner,
  refreshReminderIndex,
}) {
  const lists = { members: groupMembers, items, intents };
  const findGroup = (id) => itemGroups.find((g) => g.id === id);
  const replace = (setter, row) => setter((prev) => prev.map((r) => (r.id === row.id ? row : r)));

  // First Schedule creates the intention; later ones reuse it, and a live date is moved.
  async function scheduleGroup(groupId, date) {
    const group = findGroup(groupId);
    if (!group) return;
    const own = groupIntention(groupId, intents);
    if (own && liveEventsFor(events, own.id)[0]) return moveToPlanner(own.id, date);
    return withLoading("Scheduling...", async () => {
      let intent = own;
      let created = null;
      if (!intent) {
        const row = newGroupIntention(group, lists, { id: uid(), userId: user.id });
        created = await storage.set(`intent:${row.id}`, row);
        if (!created) throw new Error("The group's intention was not saved.");
        setIntents((prev) => [...prev, created]);
        intent = created;
      }
      // The recipes the event will freeze, and the group: the triggers may move them to Active.
      const memberItems = liveMembers(groupId, lists).filter((m) => m.memberType === "item").map((m) => m.record);
      const settle = watchStatus({
        intents: own ? [own] : [],
        items: memberItems,
        groups: [group],
        refreshIntentIds: created ? [created.id] : [],
      });
      const event = {
        id: uid(),
        user_id: user.id,
        intentId: intent.id,
        time: date,
        itemIds: [],
        contextId: intent.contextId || null,
        archived: false,
        createdAt: new Date().toISOString(),
      };
      const savedEvent = await storage.set(`event:${event.id}`, event);
      if (!savedEvent) throw writeError("Scheduling");
      setEvents((prev) => [...prev, savedEvent]);
      const flip = await settle({ announce: false });

      // Undo deletes what was never seen: the date, and the intention if this made it.
      offerUndoFor(`Scheduled for ${formatEventDate(date)}.${flip?.moved ? " Moved to Active." : ""}`, async () => {
        if (!(await storage.delete(`event:${event.id}`))) throw writeError("Undo");
        setEvents((prev) => prev.filter((e) => e.id !== event.id));
        if (created) {
          if (!(await storage.delete(`intent:${created.id}`))) throw writeError("Removing the intention");
          setIntents((prev) => prev.filter((i) => i.id !== created.id));
        }
        await flip?.restore();
      });
    });
  }

  /**
   * The status chip on the group page (never Closed: that is the Close pop-up).
   * The own intention follows where its status allows, so a reopened group can be
   * scheduled again. `archiveEvents`: the one question's answer, for the own
   * intention's live dates and reminders. Undo puts all of it back.
   */
  async function setGroupStatus(groupId, status, { archiveEvents = false } = {}) {
    const group = findGroup(groupId);
    if (!group) return;
    const own = groupIntention(groupId, intents);
    return withLoading("Saving...", async () => {
      const saved = await storage.patch(`group:${groupId}`, statusPatch(status));
      if (!saved) throw new Error("Status was not saved.");
      replace(setItemGroups, saved);

      let intentBefore = null;
      if (own && statusOf(own) !== status && statusOptionsFor(statusOf(own)).includes(status)) {
        const moved = await storage.patch(`intent:${own.id}`, statusPatch(status));
        if (!moved) throw new Error("Its intention's status was not saved.");
        replace(setIntents, moved);
        intentBefore = own;
      }

      const archivedEvents = [];
      let cancelledReminders = [];
      if (archiveEvents && own) {
        for (const event of liveEventsFor(events, own.id)) {
          if (!(await storage.set(`event:${event.id}`, { ...event, archived: true }))) throw writeError("Archiving its date");
          replace(setEvents, { ...event, archived: true });
          archivedEvents.push(event);
        }
        try {
          cancelledReminders = await cancelRemindersForStatus(own.id);
        } catch (err) {
          console.error("[Reminders] cancel on group status change failed:", err);
          window.alert(`Moved to ${STATUS_LABELS[status]}, but its reminders could not be cancelled and may still fire.`);
        }
        refreshReminderIndex?.();
      }

      const restorable = (s) => Boolean(s) && s !== "someday";
      if (!restorable(group.status) && archivedEvents.length === 0 && cancelledReminders.length === 0) return;
      offerUndoFor(`Moved to ${STATUS_LABELS[status]}${statusUndoWhat(archivedEvents.length, cancelledReminders.length)}.`, async () => {
        if (restorable(group.status)) {
          const back = await storage.patch(`group:${groupId}`, statusPatch(group.status, group));
          if (!back) throw writeError("Restoring the status");
          replace(setItemGroups, back);
        }
        if (intentBefore && restorable(intentBefore.status)) {
          const back = await storage.patch(`intent:${own.id}`, statusPatch(intentBefore.status, intentBefore));
          if (!back) throw writeError("Restoring its intention");
          replace(setIntents, back);
        }
        for (const event of archivedEvents) {
          if (!(await storage.set(`event:${event.id}`, event))) throw writeError("Restoring its event");
          replace(setEvents, event);
        }
        if (cancelledReminders.length) {
          await restoreRemindersAfterStatus(cancelledReminders);
          refreshReminderIndex?.();
        }
      });
    });
  }

  // Archive takes the own intention and its live dates with it; its reminders follow
  // the intention (reminders_follow_intent_archive). Undo brings back exactly those.
  async function archiveGroup(groupId, then) {
    const group = findGroup(groupId);
    if (!group) return;
    const own = groupIntention(groupId, intents);
    const name = groupDisplayName(group, lists) || "group";
    return withLoading("Archiving...", async () => {
      const archived = await storage.patch(`group:${groupId}`, { archived: true });
      if (!archived) throw new Error("The group was not archived.");
      replace(setItemGroups, archived);
      const archivedEvents = [];
      if (own) {
        const gone = await storage.patch(`intent:${own.id}`, { archived: true });
        if (!gone) throw writeError("Archiving its intention");
        replace(setIntents, gone);
        for (const event of liveEventsFor(events, own.id)) {
          if (!(await storage.set(`event:${event.id}`, { ...event, archived: true }))) throw writeError("Archiving its date");
          replace(setEvents, { ...event, archived: true });
          archivedEvents.push(event);
        }
        refreshReminderIndex?.();
      }
      offerUndoFor(`Archived "${name}".`, async () => {
        const back = await storage.patch(`group:${groupId}`, { archived: false });
        if (!back) throw new Error("Restoring the group was not saved.");
        replace(setItemGroups, back);
        if (own) {
          const intentBack = await storage.patch(`intent:${own.id}`, { archived: false });
          if (!intentBack) throw writeError("Restoring its intention");
          replace(setIntents, intentBack);
          for (const event of archivedEvents) {
            if (!(await storage.set(`event:${event.id}`, event))) throw writeError("Restoring its date");
            replace(setEvents, event);
          }
          refreshReminderIndex?.();
        }
      });
      then?.();
    });
  }

  // Restore from the group's page: the group and its own intention (its future
  // reminders re-arm with it). Dates stay archived: schedule again.
  async function unarchiveGroup(groupId) {
    const toRestore = intentionToRestore(groupId, intents);
    return withLoading("Restoring...", async () => {
      const back = await storage.patch(`group:${groupId}`, { archived: false });
      if (!back) throw new Error("The group was not restored.");
      replace(setItemGroups, back);
      if (toRestore) {
        const intentBack = await storage.patch(`intent:${toRestore.id}`, { archived: false });
        if (!intentBack) throw writeError("Restoring its intention");
        replace(setIntents, intentBack);
        refreshReminderIndex?.();
      }
    });
  }

  return { scheduleGroup, setGroupStatus, archiveGroup, unarchiveGroup };
}
