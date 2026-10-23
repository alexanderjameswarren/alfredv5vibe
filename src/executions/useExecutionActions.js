import { storage, writeError } from "../utils/storage";
import { completionsChanged, saveNote } from "../notes/notesApi";
import { uid, flattenElements } from "../utils/flattenElements";
import { getTodayDate, toLocalDateString } from "../utils/eventDates";
import { longDate } from "../utils/recurrenceDisplay";
import { getRecurrenceConfig } from "../utils/recurrence";
import { itemActionTarget, isDueBy } from "../utils/runNow";
import { carriedItems, closeFields, liveEventsFor, restoredCloseFields, CLOSE_REASON_SAVED } from "../utils/status";
import { groupIntention, liveMembers } from "../groups/groupModel";
import { newGroupIntention } from "../groups/useGroupActions";
import { isMenuRun, recipeOutcome, recipeRunsOf } from "../groups/menuRun";
import { moveCookRecipes } from "./menuHistory";
import {
  createNotificationSteps,
  completeNotificationStep,
  untickNotificationStep,
  cancelNotificationSteps,
  resumeNotificationSteps,
} from "../utils/notificationStepsApi";

// The realtime INSERT can land while a start is still awaiting, so the local add
// must not add the same run a second time (two "p4 test" cards, Restructure P4).
export function withActive(list, execution) {
  return list.some((x) => x.id === execution.id) ? list : [execution, ...list];
}

/**
 * closed_at for a completion on `completedOn` ("YYYY-MM-DD", local): now when it is
 * today (or not given), otherwise midday that day. Any past day is allowed: it may be
 * a backfill from before the execution was even started.
 */
const sameInstant = (a, b) => Boolean(a && b) && new Date(a).getTime() === new Date(b).getTime();

export function closedAtFor(completedOn, now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (!completedOn || completedOn >= today) return now.toISOString();
  const [y, m, d] = completedOn.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0).toISOString();
}

// Execution writers and the notification chain, moved out of Alfred.jsx unchanged.
// Holds no state: everything it reads or sets is Alfred's, passed in.
// The three string-to-element mappers (activate, startNowFromItem,
// startNowFromIntention) are deliberately left as three copies.
export function useExecutionActions({
  user,
  view,
  setView,
  items,
  intents,
  setIntents,
  events,
  setEvents,
  activeExecution,
  setActiveExecution,
  activeExecutions,
  setActiveExecutions,
  pausedExecutions,
  setPausedExecutions,
  previousView,
  setPreviousView,
  goToExecution,
  triggerRecurrence,
  clearCompletedFromCollection,
  withLoading,
  watchStatus,
  setItems,
  notify,
  offerUndoFor,
  // Restructure P5 step 14: cooking a menu.
  itemGroups = [],
  setItemGroups,
  groupTypes = [],
  groupMembers = [],
}) {
  const groupLists = { groups: itemGroups, groupTypes };
  // The open recipe runs of a menu run (they sit in the same active and paused lists).
  const recipeRunsFor = (menuRun) =>
    isMenuRun(menuRun, groupLists) ? recipeRunsOf(menuRun, [...activeExecutions, ...pausedExecutions]) : [];
  const replaceIn = (row) => (prev) => prev.map((e) => (e.id === row.id ? row : e));
  // A closed menu's recipes, for re-reading their last-done dates: as refreshMenuRecords takes runs.
  const menuRecipeIds = (menuRun) => [
    { itemIds: groupMembers.filter((m) => m.groupId === menuRun.groupId && m.memberType === "item").map((m) => m.memberId) },
  ];

  // The rows an execution insert can flip to active (088): its intention, that
  // intention's item, and every item it carries.
  function watchExecution(intent, itemIds = []) {
    return watchStatus({ intents: [intent], items: carriedItems(intent, itemIds, items) });
  }

  // A completed execution is read only: every write below refuses it (its
  // notes go through the notes table, not here).
  function writable(execution) {
    return Boolean(execution) && execution.status !== "closed";
  }

  // At most one open (active or paused) execution per intention.
  function openExecutionFor(intentId) {
    return [...activeExecutions, ...pausedExecutions].find((e) => e.intentId === intentId) || null;
  }

  // `priorEventDate`: the date Start Now moved this event from (Step 11), kept on the execution.
  async function activate(eventId, { priorEventDate = null } = {}) {
    const event = events.find((e) => e.id === eventId);
    if (!event) return;
    const prior = CLOSE_REASON_SAVED && priorEventDate ? { priorEventDate } : {};
    const open = openExecutionFor(event.intentId);
    if (open) {
      setPreviousView(view);
      goToExecution(open);
      return;
    }
    return withLoading('Starting execution...', async () => {
      const settle = watchExecution(
        intents.find((i) => i.id === event.intentId),
        event.itemIds,
      );
      // Collection-based execution
      if (event.collectionId) {
        const execution = {
          id: uid(),
          user_id: user.id,
          eventId,
          intentId: event.intentId,
          contextId: event.contextId,
          collectionId: event.collectionId,
          itemIds: [],
          ...prior,
          startedAt: new Date().toISOString(),
          status: "active",
          elements: [],
          completedItemIds: [],
          progress: [],
        };
        if (!(await storage.set(`execution:${execution.id}`, execution))) throw writeError("Starting");
        await settle();
        await startNotificationChain(execution);
        setActiveExecution(execution);
        setActiveExecutions((prev) => withActive(prev, execution));
        setPreviousView(view);
        goToExecution(execution);
        return;
      }

      // Item-based execution
      const itemElements = [];
      const getItem = (id) => items.find((i) => i.id === id) || null;
      if (event.itemIds && event.itemIds.length > 0) {
        for (const itemId of event.itemIds) {
          const item = items.find((i) => i.id === itemId);
          if (item && (item.elements || item.components)) {
            const rawEls = (item.elements || item.components).map((el) =>
              typeof el === "string"
                ? { name: el, displayType: "step", quantity: "", description: "" }
                : { ...el }
            );
            const flattened = await flattenElements(rawEls, getItem);
            const els = flattened.map((el) => ({
              ...el,
              isCompleted: false,
              completedAt: null,
              inProgress: false,
              startedAt: null,
              sourceItemId: el.sourceItemId || itemId,
            }));
            itemElements.push(...els);
          }
        }
      }

      const execution = {
        id: uid(),
        user_id: user.id,
        eventId,
        intentId: event.intentId,
        contextId: event.contextId,
        itemIds: event.itemIds,
        ...prior,
        startedAt: new Date().toISOString(),
        status: "active",
        elements: itemElements,
        progress: [],
      };

      if (!(await storage.set(`execution:${execution.id}`, execution))) throw writeError("Starting");
      await settle();
      await startNotificationChain(execution);
      setActiveExecution(execution);
      setActiveExecutions((prev) => withActive(prev, execution));
      setPreviousView(view);
      goToExecution(execution);
    });
  }

  // --- Notification chain (Phase 4) -----------------------------------------
  //
  // Every one of these is a background concern: a chain that fails to expand
  // must not stop an execution from starting, and a chain that fails to advance
  // must not stop a step being ticked. So each is wrapped and logged rather
  // than thrown — but logged loudly, because Phase 4 is verified by inspecting
  // rows and a silent no-op would look identical to an item with no offsets.
  //
  // Nothing here sends anything. The dispatcher is Phase 5.

  async function startNotificationChain(execution) {
    try {
      const rows = await createNotificationSteps(execution.id, execution.elements);
      if (rows.length > 0) {
        console.log(`[Chain] Expanded ${rows.length} notification step(s) for execution ${execution.id}`);
      }
    } catch (e) {
      console.error("[Chain] Failed to expand notification steps:", e);
    }
  }

  // Logged on EVERY tick, not only when something changed.
  //
  // The field failure was a chain that silently stopped advancing, and the
  // three ways that can happen — the advance was never called, the rows were
  // not visible, or the writes were refused — were indistinguishable from each
  // other and from "the chain is simply finished". Each now says which.
  async function advanceNotificationChain(execution, elementIndex) {
    try {
      const { complete, schedule, rowsSeen } = await completeNotificationStep(
        execution.id,
        execution.elements,
        elementIndex
      );
      if (rowsSeen === 0) {
        console.log(
          `[Chain] Element ${elementIndex}: no notification_steps rows visible for execution ${execution.id}. ` +
            `Either this item has no offsets, or the rows exist and RLS is hiding them.`
        );
        return;
      }
      console.log(
        `[Chain] Element ${elementIndex} (seq ${elementIndex + 1}): saw ${rowsSeen} row(s), ` +
          `completed ${complete.length}, scheduled ${schedule.length}.`
      );
    } catch (e) {
      console.error("[Chain] Failed to advance notification chain:", e, e.failures ?? "");
    }
  }

  async function retreatNotificationChain(execution, elementIndex) {
    try {
      const { patches, rowsSeen } = await untickNotificationStep(
        execution.id,
        execution.elements,
        elementIndex
      );
      console.log(
        `[Chain] Element ${elementIndex} un-ticked: saw ${rowsSeen} row(s), ` +
          `returned ${patches.length} to the chain.`
      );
    } catch (e) {
      console.error("[Chain] Failed to retreat notification chain:", e, e.failures ?? "");
    }
  }

  async function endNotificationChain(executionId) {
    try {
      const cancelled = await cancelNotificationSteps(executionId);
      if (cancelled.length > 0) {
        console.log(`[Chain] Cancelled ${cancelled.length} remaining step(s) for execution ${executionId}`);
      }
    } catch (e) {
      console.error("[Chain] Failed to cancel notification steps:", e);
    }
  }

  async function rescheduleNotificationChain(executionId) {
    try {
      const moved = await resumeNotificationSteps(executionId);
      if (moved.length > 0) {
        console.log(`[Chain] Resume: moved ${moved.length} overdue step(s) to now`);
      }
    } catch (e) {
      console.error("[Chain] Failed to reschedule notification steps on resume:", e);
    }
  }

  // From the completion pop-up (Step 7): `nextDate`, the next event's date (without
  // one, triggerRecurrence applies the shared rule itself); `completedOn`, the day it
  // was done ("YYYY-MM-DD"), which sets closed_at and so last_completed_at.
  async function closeExecution(outcome, { nextDate = null, completedOn = null } = {}) {
    if (!writable(activeExecution)) return;
    const recipeRuns = recipeRunsFor(activeExecution);
    return withLoading('Completing...', async () => {
      // Cancel = Delete: just remove active execution, don't archive anything
      if (outcome === "cancelled") {
        // A menu: its recipe runs go with it (Start Now made them all).
        for (const run of recipeRuns) {
          await endNotificationChain(run.id);
          if (!(await storage.delete(`execution:${run.id}`))) throw writeError("Deleting a recipe's execution");
          setActiveExecutions((prev) => prev.filter((e) => e.id !== run.id));
          setPausedExecutions((prev) => prev.filter((e) => e.id !== run.id));
        }
        // Cancel the chain BEFORE deleting the execution: afterwards the rows
        // would be orphans referencing a row that no longer exists. The
        // dispatcher's join to active executions would hide them, but leaving
        // live-looking rows behind for a run that never happened is not a
        // state worth defending.
        await endNotificationChain(activeExecution.id);
        if (!(await storage.delete(`execution:${activeExecution.id}`))) throw writeError("Deleting the execution");
        setActiveExecutions((prev) => prev.filter((e) => e.id !== activeExecution.id));
        setPausedExecutions((prev) => prev.filter((e) => e.id !== activeExecution.id));
        await restoreStartNow(activeExecution);
        setActiveExecution(null);
        setView(previousView);
        return;
      }

      const closed = {
        ...activeExecution,
        closedAt: closedAtFor(completedOn),
        outcome,
        status: "closed",
      };

      // A menu: every recipe closes at the same moment, done or skipped (step 14).
      for (const run of recipeRuns) {
        const done = { ...run, status: "closed", closedAt: closed.closedAt, outcome: recipeOutcome(run) };
        if (!(await storage.set(`execution:${run.id}`, done))) throw writeError("Completing a recipe");
        await endNotificationChain(run.id);
        setActiveExecutions((prev) => prev.filter((e) => e.id !== run.id));
        setPausedExecutions((prev) => prev.filter((e) => e.id !== run.id));
      }

      // Archive the execution (elements are preserved via spread; notes live in the notes table)
      await storage.set(`execution:${closed.id}`, closed);
      await endNotificationChain(closed.id);

      // Archive the event
      const event = events.find((e) => e.id === activeExecution.eventId);
      if (event) {
        const archivedEvent = { ...event, archived: true };
        await storage.set(`event:${event.id}`, archivedEvent);
        setEvents((prev) => prev.map((e) => (e.id === event.id ? archivedEvent : e)));
      }

      // Handle recurrence: close a done one-off, or create next event for recurring
      const intent = intents.find((i) => i.id === activeExecution.intentId);
      if (intent) {
        const config = getRecurrenceConfig(intent);
        if (config.type === "once") {
          // Closed, not archived: finishing is a reason to keep it. Its one
          // live event was the one just archived above.
          // A group's own intention stays open: the menu is cooked again (step 14).
          if (outcome === "done" && !intent.groupId) {
            // Automatic close: reason 'done', Closed on = the completion (Step 11 writes them).
            const closedIntent = await storage.patch(`intent:${intent.id}`, { status: "closed", ...closeFields("done", closed.closedAt) });
            if (closedIntent) setIntents((prev) => prev.map((i) => (i.id === intent.id ? closedIntent : i)));
          }
        } else {
          // Recurring: calculate and create next event
          await triggerRecurrence(intent.id, event, { nextDate });
        }
      }
      // The database has just written last_completed_at (trigger); show it now.
      if (outcome === "done") {
        await refreshCompletedRecords(closed);
        if (recipeRuns.length || closed.groupId) {
          await refreshMenuRecords(closed, recipeRuns);
          completionsChanged();
        }
      }

      // Remove completed items from collection. Only an affirmative completion
      // clears anything — cancel returns above, and pause never reaches here.
      //
      // We are already inside withLoading, which clears the overlay in its
      // finally and never rethrows, so there is no nested withLoading here and
      // the failure is read off the returned result rather than thrown.
      if (outcome === "done" && activeExecution.collectionId) {
        const completedIds = activeExecution.completedItemIds || [];
        if (completedIds.length > 0) {
          await clearCompletedFromCollection(
            activeExecution.collectionId,
            completedIds,
          );
        }
      }

      // Paused too: a paused run can be completed directly, and left in the
      // paused list it showed as a paused card until the next reload.
      setActiveExecutions((prev) => prev.filter((e) => e.id !== activeExecution.id));
      setPausedExecutions((prev) => prev.filter((e) => e.id !== activeExecution.id));
      setActiveExecution(null);
      setView(previousView);
    });
  }

  /**
   * Delete Execution puts back what Start Now changed (Step 11): the event it created
   * (deleted), or the date it moved, when the event is still on the day it was moved to
   * and that date is today or later; and a status it un-parked from Background. Events
   * that existed before are never removed. Stops at the first failed write.
   */
  async function restoreStartNow(execution) {
    const today = getTodayDate();
    const { priorEventDate, priorIntentStatus } = execution;
    const event = events.find((e) => e.id === execution.eventId);
    const startedOn = execution.startedAt ? toLocalDateString(new Date(execution.startedAt)) : null;
    const untouched = event && !event.archived && String(event.time).slice(0, 10) === startedOn;
    // Start Now made this event when it has the execution's startedAt as its createdAt,
    // to the millisecond (both written in one call); no scheduled event can match that.
    const madeByStartNow =
      untouched && event.createdAt && execution.startedAt &&
      new Date(event.createdAt).getTime() === new Date(execution.startedAt).getTime();
    if (madeByStartNow) {
      if (!(await storage.delete(`event:${event.id}`))) throw writeError("Removing today's event");
      setEvents((prev) => prev.filter((e) => e.id !== event.id));
      // A menu's own intention Start Now made (same millisecond stamp) goes too.
      const own = intents.find((i) => i.id === execution.intentId);
      if (own?.groupId && sameInstant(own.createdAt, execution.startedAt)) {
        if (!(await storage.delete(`intent:${own.id}`))) throw writeError("Removing the menu's intention");
        setIntents((prev) => prev.filter((i) => i.id !== own.id));
      }
    } else if (priorEventDate && priorEventDate >= today) {
      if (untouched) {
        const saved = await storage.set(`event:${event.id}`, { ...event, time: priorEventDate });
        if (!saved) throw writeError("Restoring its date");
        setEvents((prev) => prev.map((e) => (e.id === event.id ? saved : e)));
      }
    }
    if (priorIntentStatus === "background") {
      const intent = intents.find((i) => i.id === execution.intentId);
      if (intent && intent.status === "active") {
        const back = await storage.patch(`intent:${intent.id}`, { status: "background" });
        if (!back) throw writeError("Restoring the status");
        setIntents((prev) => prev.map((i) => (i.id === back.id ? back : i)));
      }
    }
  }

  async function cancelExecutionForEvent(eventId) {
    const exec =
      activeExecutions.find((e) => e.eventId === eventId) ||
      pausedExecutions.find((e) => e.eventId === eventId);
    if (!exec) return;
    return withLoading('Cancelling...', async () => {
      // Chain first, as closeExecution does: afterwards its rows would be orphans.
      await endNotificationChain(exec.id);
      await storage.delete(`execution:${exec.id}`);
      setActiveExecutions((prev) => prev.filter((e) => e.id !== exec.id));
      setPausedExecutions((prev) => prev.filter((e) => e.id !== exec.id));
      if (activeExecution && activeExecution.id === exec.id) {
        setActiveExecution(null);
      }
    });
  }

  async function pauseExecution() {
    if (!writable(activeExecution)) return;
    const recipeRuns = recipeRunsFor(activeExecution);
    return withLoading('Pausing...', async () => {
      const paused = { ...activeExecution, status: "paused" };
      await storage.set(`execution:${paused.id}`, paused);
      // A menu pauses as a whole.
      for (const run of recipeRuns) {
        const p = { ...run, status: "paused" };
        if (!(await storage.set(`execution:${run.id}`, p))) throw writeError("Pausing a recipe");
        setActiveExecutions((prev) => prev.filter((e) => e.id !== run.id));
        setPausedExecutions((prev) => [p, ...prev.filter((e) => e.id !== run.id)]);
      }
      setActiveExecutions((prev) => prev.filter((e) => e.id !== activeExecution.id));
      setPausedExecutions((prev) => [paused, ...prev]);
      setActiveExecution(null);
      setView("home");
    });
  }

  async function makeExecutionActive() {
    if (!writable(activeExecution)) return;
    const recipeRuns = recipeRunsFor(activeExecution);
    return withLoading('Resuming...', async () => {
      const activated = { ...activeExecution, status: "active" };
      await storage.set(`execution:${activated.id}`, activated);
      for (const run of recipeRuns) {
        const a = { ...run, status: "active" };
        if (!(await storage.set(`execution:${run.id}`, a))) throw writeError("Resuming a recipe");
        await rescheduleNotificationChain(run.id);
        setPausedExecutions((prev) => prev.filter((e) => e.id !== run.id));
        setActiveExecutions((prev) => withActive(prev.filter((e) => e.id !== run.id), a));
      }
      // Pausing writes no rows — the dispatcher filters on execution status, so
      // a paused chain is already silent. Only resuming needs to act, so that a
      // due time that passed during the pause does not fire for a moment gone by.
      await rescheduleNotificationChain(activated.id);
      setPausedExecutions((prev) => prev.filter((e) => e.id !== activeExecution.id));
      setActiveExecutions((prev) => withActive(prev, activated));
      setActiveExecution(activated);
    });
  }

  // `target`: a recipe's run inside a menu (step 14); the page's own execution otherwise.
  async function toggleExecutionElement(elementIndex, target = null) {
    const base = target || activeExecution;
    if (!writable(base)) return;
    const updatedElements = [...base.elements];
    const el = updatedElements[elementIndex];
    updatedElements[elementIndex] = {
      ...el,
      isCompleted: !el.isCompleted,
      completedAt: !el.isCompleted ? new Date().toISOString() : null,
      inProgress: false,
    };
    const updated = { ...base, elements: updatedElements };

    // Optimistic: update UI immediately
    if (!target) setActiveExecution(updated);
    setActiveExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );
    setPausedExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );

    // Persist — await to prevent refresh race condition
    try {
      await storage.set(`execution:${updated.id}`, updated);
    } catch (e) {
      console.error('[Execution] Failed to save element toggle:', e);
    }

    // Advance the chain only when the element is being marked COMPLETE. This
    // is a toggle, and un-ticking must not close a row or start a clock.
    // Re-ticking is safe: planCompletion only moves rows out of `waiting`, and
    // a row already terminal is left alone.
    if (!el.isCompleted) {
      await advanceNotificationChain(updated, elementIndex);
    } else {
      // Un-ticking RETREATS the chain. It used to do nothing, which left every
      // row the completion had armed still armed — so a notification would fire
      // for a step nobody had finished.
      await retreatNotificationChain(updated, elementIndex);
    }
  }

  async function updateExecutionElement(elementIndex, fields, target = null) {
    const base = target || activeExecution;
    if (!writable(base)) return;
    const updatedElements = [...base.elements];
    updatedElements[elementIndex] = { ...updatedElements[elementIndex], ...fields };
    const updated = { ...base, elements: updatedElements };

    // Optimistic: update UI immediately
    if (!target) setActiveExecution(updated);
    setActiveExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );
    setPausedExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );

    // Persist — await to prevent refresh race condition
    try {
      await storage.set(`execution:${updated.id}`, updated);
    } catch (e) {
      console.error('[Execution] Failed to save element update:', e);
    }
  }

  async function toggleCollectionItem(itemId) {
    if (!writable(activeExecution)) return;
    const completed = activeExecution.completedItemIds || [];
    const isCompleted = completed.includes(itemId);
    const updatedIds = isCompleted
      ? completed.filter((id) => id !== itemId)
      : [...completed, itemId];
    const updated = { ...activeExecution, completedItemIds: updatedIds };
    await storage.set(`execution:${updated.id}`, updated);
    setActiveExecution(updated);
    setActiveExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );
    setPausedExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );
  }

  // `targetIntentId`: item detail's pick, so the button and the action agree.
  async function startNowFromItem(itemId, targetIntentId) {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;

    // Attach to a live intention for this item rather than minting a one-off
    // beside it — a one-off left the recurring intention behind and its
    // recurrence silently died. One mid-run comes first (itemActionTarget).
    // That intention's own rule then continues, runs, moves or creates its one event.
    const intentId =
      targetIntentId ||
      itemActionTarget(item.id, intents, events, [...activeExecutions, ...pausedExecutions])?.intent.id;
    if (intentId) return startNowFromIntention(intentId);

    return withLoading('Starting execution...', async () => {
      // Only the item can be "moved" here; the intention is new, so it is
      // re-read for state but never announced.
      const newIntentId = uid();
      const settle = watchStatus({ items: [item], refreshIntentIds: [newIntentId] });
      // Create intention linked to this item
      const newIntent = {
        id: newIntentId,
        user_id: user.id,
        text: item.name,
        createdAt: new Date().toISOString(),
        isIntention: true,
        archived: false,
        itemId: item.id,
        contextId: item.contextId || null,
        recurrenceConfig: { type: "once" },
      };
      const savedIntent = await storage.set(`intent:${newIntent.id}`, newIntent);
      setIntents((prev) => [...prev, savedIntent || newIntent]);

      // Create event for today. Its createdAt is the execution's startedAt, to the
      // millisecond: how Delete Execution knows Start Now made it (restoreStartNow).
      const startedAt = new Date().toISOString();
      const newEvent = {
        id: uid(),
        user_id: user.id,
        intentId: newIntent.id,
        time: getTodayDate(),
        itemIds: [item.id],
        contextId: item.contextId || null,
        archived: false,
        createdAt: startedAt,
      };
      const savedEvent = await storage.set(`event:${newEvent.id}`, newEvent);
      if (!savedEvent) throw writeError("Today's event");
      setEvents((prev) => [...prev, savedEvent]);

      // Build execution inline (can't call activate — state hasn't updated yet)
      let itemElements = [];
      if (item.elements || item.components) {
        const rawEls = (item.elements || item.components).map((el) =>
          typeof el === "string"
            ? { name: el, displayType: "step", quantity: "", description: "" }
            : { ...el }
        );
        // Flatten item references
        const getItem = (id) => items.find((i) => i.id === id) || null;
        const flattened = await flattenElements(rawEls, getItem);
        itemElements = flattened.map((el) => ({
          ...el,
          isCompleted: false,
          completedAt: null,
          inProgress: false,
          startedAt: null,
          sourceItemId: el.sourceItemId || item.id,
        }));
      }

      const execution = {
        id: uid(),
        user_id: user.id,
        eventId: newEvent.id,
        intentId: newIntent.id,
        contextId: item.contextId || null,
        itemIds: [item.id],
        startedAt,
        status: "active",
        elements: itemElements,
        progress: [],
      };

      if (!(await storage.set(`execution:${execution.id}`, execution))) throw writeError("Starting");
      await settle();
      await startNotificationChain(execution);
      setActiveExecution(execution);
      setActiveExecutions((prev) => withActive(prev, execution));
      setPreviousView(view);
      goToExecution(execution);
    });
  }

  async function startNowFromIntention(intentId) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return;
    // One live event per intention: run that one, never add a second beside it.
    // An open execution is continued; a future date is moved to today first.
    const open = openExecutionFor(intentId);
    if (open) {
      setPreviousView(view);
      goToExecution(open);
      return;
    }
    const live = liveEventsFor(events, intentId)[0];
    if (live) {
      const today = getTodayDate();
      // What Start Now moves, recorded on the execution so Delete Execution can put it back.
      let priorEventDate = null;
      if (!isDueBy(live, today)) {
        const moved = await withLoading('Moving to today...', async () => {
          const saved = await storage.set(`event:${live.id}`, { ...live, time: today });
          if (!saved) throw writeError("Moving the event to today");
          setEvents((prev) => prev.map((e) => (e.id === live.id ? saved : e)));
          return true;
        });
        if (!moved) return;
        priorEventDate = String(live.time).slice(0, 10);
      }
      return activate(live.id, { priorEventDate });
    }
    // A new event un-parks a Background intention (088); recorded for Delete Execution.
    const priorIntentStatus = CLOSE_REASON_SAVED && intent.status === "background" ? { priorIntentStatus: "background" } : {};
    return withLoading('Starting execution...', async () => {
      // Find linked item if any
      const linkedItem = intent.itemId
        ? items.find((i) => i.id === intent.itemId)
        : null;
      const settle = watchExecution(intent, linkedItem ? [linkedItem.id] : []);

      // Create event for today. Its createdAt is the execution's startedAt, to the
      // millisecond: how Delete Execution knows Start Now made it (restoreStartNow).
      const startedAt = new Date().toISOString();
      const newEvent = {
        id: uid(),
        user_id: user.id,
        intentId: intent.id,
        time: getTodayDate(),
        itemIds: linkedItem ? [linkedItem.id] : [],
        contextId: intent.contextId || null,
        collectionId: intent.collectionId || null,
        archived: false,
        createdAt: startedAt,
      };
      const savedEvent = await storage.set(`event:${newEvent.id}`, newEvent);
      if (!savedEvent) throw writeError("Today's event");
      setEvents((prev) => [...prev, savedEvent]);

      // Collection-based execution
      if (intent.collectionId) {
        const execution = {
          id: uid(),
          user_id: user.id,
          eventId: newEvent.id,
          intentId: intent.id,
          contextId: intent.contextId || null,
          collectionId: intent.collectionId,
          itemIds: [],
          ...priorIntentStatus,
          startedAt,
          status: "active",
          elements: [],
          completedItemIds: [],
          progress: [],
        };
        if (!(await storage.set(`execution:${execution.id}`, execution))) throw writeError("Starting");
        await settle();
        await startNotificationChain(execution);
        setActiveExecution(execution);
        setActiveExecutions((prev) => withActive(prev, execution));
        setPreviousView(view);
        goToExecution(execution);
        return;
      }

      // Build execution elements from linked item
      let itemElements = [];
      if (linkedItem && (linkedItem.elements || linkedItem.components)) {
        const rawEls = (linkedItem.elements || linkedItem.components).map((el) =>
          typeof el === "string"
            ? { name: el, displayType: "step", quantity: "", description: "" }
            : { ...el }
        );
        const getItem = (id) => items.find((i) => i.id === id) || null;
        const flattened = await flattenElements(rawEls, getItem);
        itemElements = flattened.map((el) => ({
          ...el,
          isCompleted: false,
          completedAt: null,
          inProgress: false,
          startedAt: null,
          sourceItemId: el.sourceItemId || linkedItem.id,
        }));
      }

      const execution = {
        id: uid(),
        user_id: user.id,
        eventId: newEvent.id,
        intentId: intent.id,
        contextId: intent.contextId || null,
        itemIds: linkedItem ? [linkedItem.id] : [],
        ...priorIntentStatus,
        startedAt,
        status: "active",
        elements: itemElements,
        progress: [],
      };

      if (!(await storage.set(`execution:${execution.id}`, execution))) throw writeError("Starting");
      await settle();
      await startNotificationChain(execution);
      setActiveExecution(execution);
      setActiveExecutions((prev) => withActive(prev, execution));
      setPreviousView(view);
      goToExecution(execution);
    });
  }

  // A recipe's elements as a run starts them: flattened, nothing ticked.
  async function startingElements(item) {
    if (!item || !(item.elements || item.components)) return [];
    const rawEls = (item.elements || item.components).map((el) =>
      typeof el === "string" ? { name: el, displayType: "step", quantity: "", description: "" } : { ...el },
    );
    const flattened = await flattenElements(rawEls, (id) => items.find((i) => i.id === id) || null);
    return flattened.map((el) => ({
      ...el,
      isCompleted: false,
      completedAt: null,
      inProgress: false,
      startedAt: null,
      sourceItemId: el.sourceItemId || item.id,
    }));
  }

  // One recipe's run inside a menu run: no intention, no event, the menu run its parent.
  function recipeRunRow(recipe, menuRun, fields) {
    return {
      id: uid(),
      user_id: user.id,
      intentId: null,
      eventId: null,
      parentExecutionId: menuRun.id,
      groupId: menuRun.groupId,
      contextId: recipe.contextId || menuRun.contextId || null,
      itemIds: [recipe.id],
      startedAt: menuRun.startedAt,
      elements: [],
      progress: [],
      ...fields,
    };
  }

  // The menu's own intention, made (and put in state) when it has none. Returns { own, created }.
  async function ensureMenuIntention(group, now) {
    const existing = groupIntention(group.id, intents);
    if (existing) return { own: existing, created: null };
    const row = newGroupIntention(group, { members: groupMembers, items, intents }, { id: uid(), userId: user.id, now });
    const created = await storage.set(`intent:${row.id}`, row);
    if (!created) throw new Error("The menu's intention was not saved.");
    setIntents((prev) => [...prev, created]);
    return { own: created, created };
  }

  /**
   * Log Execution on a menu (step 14b): the menu's run and one closed run per recipe,
   * in one step, dated `completedOn`. Recipes in `doneIds` are done, the rest skipped.
   * On the live date (archived), else on a new archived one that day. The note is the
   * menu's. Undo deletes the menu run (its recipe runs cascade), puts the date back or
   * removes the new one, and removes an intention this made.
   */
  async function logMenuDone(groupId, { note = "", completedOn = null, doneIds = [] } = {}) {
    const group = itemGroups.find((g) => g.id === groupId);
    if (!group) return false;
    const existing = groupIntention(groupId, intents);
    if (existing && hasOpen(existing.id)) return false;
    let ok = false;
    await withLoading("Saving...", async () => {
      const day = completedOn || getTodayDate();
      const closedAt = closedAtFor(day);
      const { own, created: createdIntent } = await ensureMenuIntention(group, new Date());
      const recipes = liveMembers(groupId, { members: groupMembers, items, intents }).filter((m) => m.memberType === "item").map((m) => m.record);
      const live = liveEventsFor(events, own.id)[0] || null;
      let createdEvent = null;
      if (!live) {
        createdEvent = { id: uid(), user_id: user.id, intentId: own.id, time: day, itemIds: [], contextId: own.contextId || null, archived: true, createdAt: new Date().toISOString() };
        if (!(await storage.set(`event:${createdEvent.id}`, createdEvent))) throw writeError("Recording it");
      }
      const event = live || createdEvent;
      const menuRun = {
        id: uid(),
        user_id: user.id,
        eventId: event.id,
        intentId: own.id,
        groupId,
        contextId: group.contextId || own.contextId || null,
        itemIds: [],
        startedAt: closedAt,
        closedAt,
        status: "closed",
        outcome: "done",
        elements: [],
        progress: [],
      };
      if (!(await storage.set(`execution:${menuRun.id}`, menuRun))) throw writeError("Recording it");
      for (const recipe of recipes) {
        const run = recipeRunRow(recipe, menuRun, { status: "closed", closedAt, outcome: doneIds.includes(recipe.id) ? "done" : "skipped" });
        if (!(await storage.set(`execution:${run.id}`, run))) {
          await storage.delete(`execution:${menuRun.id}`);
          throw writeError(`Recording "${recipe.name}"`);
        }
      }
      if (note.trim()) await saveNote({ body: note, targetType: "group", targetId: groupId, executionId: menuRun.id });
      if (live) {
        const archived = { ...live, archived: true };
        await storage.set(`event:${live.id}`, archived);
        setEvents((prev) => prev.map((e) => (e.id === live.id ? archived : e)));
      } else {
        setEvents((prev) => [...prev, createdEvent]);
      }
      const recipeRuns = [{ itemIds: recipes.map((r) => r.id) }];
      await refreshMenuRecords(menuRun, recipeRuns);
      completionsChanged();
      offerUndoFor?.(`Logged a cook on ${longDate(day, getTodayDate())}.`, async () => {
        if (!(await storage.delete(`execution:${menuRun.id}`))) throw writeError("Removing the cook");
        if (live) {
          if (!(await storage.set(`event:${live.id}`, live))) throw writeError("Restoring its date");
          setEvents((prev) => prev.map((e) => (e.id === live.id ? live : e)));
        } else {
          if (!(await storage.delete(`event:${createdEvent.id}`))) throw writeError("Removing its date");
          setEvents((prev) => prev.filter((e) => e.id !== createdEvent.id));
        }
        if (createdIntent) {
          if (!(await storage.delete(`intent:${createdIntent.id}`))) throw writeError("Removing the intention");
          setIntents((prev) => prev.filter((i) => i.id !== createdIntent.id));
        }
        await refreshMenuRecords(menuRun, recipeRuns);
        completionsChanged();
      });
      ok = true;
    });
    return ok;
  }

  /**
   * Start Now on a menu (Restructure P5 step 14). Through the menu's own intention
   * (made if needed) and its one live event, as intention Start Now: an open run is
   * continued, a future date is moved to today (and put back by Delete), no date makes
   * one for today. Then the menu's run (item_ids empty) and one run per live recipe
   * (item_ids [recipe], no intention, no event): recipes' own intentions and events are
   * never touched. If a run fails to save, the runs already made are deleted and the
   * error shown (the date, like intention Start Now's, stays).
   */
  async function startMenuNow(groupId) {
    const group = itemGroups.find((g) => g.id === groupId);
    if (!group) return;
    const memberLists = { members: groupMembers, items, intents };
    const existing = groupIntention(groupId, intents);
    const open = existing ? openExecutionFor(existing.id) : null;
    if (open) {
      setPreviousView(view);
      goToExecution(open);
      return;
    }
    const live = existing ? liveEventsFor(events, existing.id)[0] || null : null;
    return withLoading("Starting execution...", async () => {
      const today = getTodayDate();
      const startedAt = new Date().toISOString();
      const made = [];
      // createdAt = startedAt when made here: how Delete knows to remove it.
      const { own, created: createdIntent } = await ensureMenuIntention(group, new Date(startedAt));
      const recipes = liveMembers(groupId, memberLists).filter((m) => m.memberType === "item").map((m) => m.record);
      const settle = watchStatus({
        intents: createdIntent ? [] : [own],
        items: recipes,
        groups: [group],
        refreshIntentIds: createdIntent ? [own.id] : [],
      });
      const prior = {};
      let event = live;
      if (live && !isDueBy(live, today)) {
        const saved = await storage.set(`event:${live.id}`, { ...live, time: today });
        if (!saved) throw writeError("Moving the event to today");
        setEvents((prev) => prev.map((e) => (e.id === live.id ? saved : e)));
        event = saved;
        if (CLOSE_REASON_SAVED) prior.priorEventDate = String(live.time).slice(0, 10);
      }
      if (!event) {
        // createdAt = startedAt: how Delete knows Start Now made it (restoreStartNow).
        const row = { id: uid(), user_id: user.id, intentId: own.id, time: today, itemIds: [], contextId: own.contextId || null, archived: false, createdAt: startedAt };
        event = await storage.set(`event:${row.id}`, row);
        if (!event) throw writeError("Today's event");
        setEvents((prev) => [...prev, event]);
        if (CLOSE_REASON_SAVED && own.status === "background") prior.priorIntentStatus = "background";
      }
      const menuRun = {
        id: uid(),
        user_id: user.id,
        eventId: event.id,
        intentId: own.id,
        groupId,
        contextId: group.contextId || own.contextId || null,
        itemIds: [],
        ...prior,
        startedAt,
        status: "active",
        elements: [],
        progress: [],
      };
      try {
        if (!(await storage.set(`execution:${menuRun.id}`, menuRun))) throw writeError("Starting");
        made.push(menuRun);
        for (const recipe of recipes) {
          const run = recipeRunRow(recipe, menuRun, { status: "active", elements: await startingElements(recipe) });
          if (!(await storage.set(`execution:${run.id}`, run))) throw writeError(`Starting "${recipe.name}"`);
          made.push(run);
        }
      } catch (e) {
        for (const run of made.reverse()) await storage.delete(`execution:${run.id}`);
        throw e;
      }
      await settle();
      for (const run of made) await startNotificationChain(run);
      setActiveExecutions((prev) => made.reduce((list, run) => withActive(list, run), prev));
      setActiveExecution(menuRun);
      setPreviousView(view);
      goToExecution(menuRun);
    });
  }

  /** Skip a recipe inside a menu run, or take the skip back, before the menu completes. */
  async function setRecipeSkipped(run, skipped) {
    if (!writable(run)) return;
    const saved = await storage.patch(`execution:${run.id}`, { outcome: skipped ? "skipped" : null });
    if (!saved) {
      notify?.("The skip was not saved.", { error: true });
      return;
    }
    setActiveExecutions(replaceIn(saved));
    setPausedExecutions(replaceIn(saved));
  }

  // After a menu completes: the menu and each recipe's last_completed_at (triggers).
  async function refreshMenuRecords(menuRun, recipeRuns) {
    if (setItemGroups && menuRun.groupId) {
      const fresh = await storage.get(`group:${menuRun.groupId}`);
      if (fresh) setItemGroups((prev) => prev.map((g) => (g.id === fresh.id ? fresh : g)));
    }
    if (!setItems) return;
    for (const id of new Set(recipeRuns.flatMap((r) => r.itemIds || []))) {
      const item = await storage.get(`item:${id}`);
      if (item) setItems((prev) => prev.map((i) => (i.id === item.id ? item : i)));
    }
  }

  /**
   * Re-read the intention and item(s) an execution counts for. Their
   * last_completed_at is written by the database (executions_last_completed), and
   * the list must not wait on a realtime message that may not come.
   */
  async function refreshCompletedRecords(execution, knownIntent = null) {
    const intent = knownIntent || intents.find((i) => i.id === execution.intentId);
    const itemIds = [...new Set([...(execution.itemIds || []), intent?.itemId].filter(Boolean))];
    const fresh = await storage.get(`intent:${execution.intentId}`);
    if (fresh) setIntents((prev) => prev.map((i) => (i.id === fresh.id ? fresh : i)));
    if (!setItems) return;
    for (const id of itemIds) {
      const item = await storage.get(`item:${id}`);
      if (item) setItems((prev) => prev.map((i) => (i.id === item.id ? item : i)));
    }
  }

  /**
   * A completed execution's one editable field: the day it was done (Step 7). Saved
   * at midday, as Complete does; the database then sets each record's
   * last_completed_at to its LATEST done execution, so an older edit never hides a
   * newer completion. Events and the next date do not move.
   */
  async function changeCompletionDate(completedOn) {
    const execution = activeExecution;
    if (!execution || execution.status !== "closed" || execution.outcome !== "done") return false;
    let ok = false;
    await withLoading("Saving...", async () => {
      const closedAt = closedAtFor(completedOn);
      // A menu's recipes move with it, so the cook stays one moment (step 14).
      if (isMenuRun(execution, groupLists)) await moveCookRecipes(execution, closedAt);
      const saved = await storage.patch(`execution:${execution.id}`, { closedAt });
      if (!saved) throw writeError("The completion date");
      setActiveExecution(saved);
      await refreshCompletedRecords(saved);
      if (isMenuRun(saved, groupLists)) await refreshMenuRecords(saved, menuRecipeIds(saved));
      completionsChanged();
      notify?.(`Completed on ${longDate(completedOn, getTodayDate())}.`);
      ok = true;
    });
    return ok;
  }

  /**
   * Delete a completed or skipped execution from the history (Step 9). Asked first, no
   * Undo. Its notes cascade; the 100 trigger recomputes last_completed_at on delete,
   * and the records are re-read. Events and statuses do not move. Back to the page it
   * was opened from.
   */
  async function deleteClosedExecution() {
    const execution = activeExecution;
    if (!execution || execution.status !== "closed") return false;
    let ok = false;
    await withLoading("Deleting...", async () => {
      // A menu's recipe runs go with it (parent_execution_id, on delete cascade).
      if (!(await storage.delete(`execution:${execution.id}`))) throw writeError("Deleting it");
      await refreshCompletedRecords(execution);
      if (isMenuRun(execution, groupLists)) await refreshMenuRecords(execution, menuRecipeIds(execution));
      completionsChanged();
      setActiveExecution(null);
      setView(previousView);
      ok = true;
    });
    return ok;
  }

  const hasOpen = (intentId) =>
    [...activeExecutions, ...pausedExecutions].some((x) => x.intentId === intentId);

  /**
   * Complete without an execution (Step 8): record that an intention was done on
   * `completedOn`, as completing an execution of it would. Writes a closed `done`
   * execution on the live event (or on a new event dated that day, inserted archived,
   * so nothing goes live), saves the note on it and archives the event. Then, as
   * closeExecution: a repeat gets its next event on `nextDate`; a one-time intention
   * is closed. Undo removes all of it, restores the status (not someday, which
   * status_guard refuses) and deletes `createdIntent` if this made one;
   * last_completed_at falls back by itself (the 100 trigger recomputes on delete).
   */
  async function recordDone(intent, { note = "", nextDate = null, completedOn = null }, createdIntent = null) {
    const intentId = intent.id;
    const day = completedOn || getTodayDate();
    const live = liveEventsFor(events, intentId)[0] || null;
    let event = live;
    // The execution (and a repeat's next event) insert can un-park the records (088).
    const settle = watchStatus?.({ intents: [intent], items: carriedItems(intent, intent.itemId ? [intent.itemId] : [], items) });
    let createdEvent = null;
    if (!event) {
      createdEvent = {
        id: uid(),
        user_id: user.id,
        intentId,
        time: day,
        itemIds: intent.itemId ? [intent.itemId] : [],
        contextId: intent.contextId || null,
        collectionId: intent.collectionId || null,
        archived: true,
        createdAt: new Date().toISOString(),
      };
      if (!(await storage.set(`event:${createdEvent.id}`, createdEvent))) throw writeError("Recording it");
      event = createdEvent;
    }
    const closedAt = closedAtFor(day);
    const execution = {
      id: uid(),
      user_id: user.id,
      eventId: event.id,
      intentId,
      contextId: intent.contextId || null,
      collectionId: intent.collectionId || null,
      itemIds: event.itemIds || [],
      startedAt: closedAt,
      closedAt,
      status: "closed",
      outcome: "done",
      elements: [],
      progress: [],
    };
    if (!(await storage.set(`execution:${execution.id}`, execution))) throw writeError("Recording it");
    if (note.trim()) {
      await saveNote({ body: note, targetType: "intention", targetId: intentId, executionId: execution.id });
    }
    if (live) {
      const archived = { ...live, archived: true };
      await storage.set(`event:${live.id}`, archived);
      setEvents((prev) => prev.map((e) => (e.id === live.id ? archived : e)));
    } else {
      setEvents((prev) => [...prev, createdEvent]);
    }

    let successor = null;
    const previousStatus = intent.status;
    const oneTime = getRecurrenceConfig(intent).type === "once";
    if (oneTime) {
      const closedIntent = await storage.patch(`intent:${intentId}`, { status: "closed", ...closeFields("done", closedAt) });
      if (closedIntent) setIntents((prev) => prev.map((i) => (i.id === intentId ? closedIntent : i)));
    } else {
      successor = await triggerRecurrence(intentId, event, { nextDate });
    }
    await refreshCompletedRecords(execution, intent);
    const flip = settle ? await settle({ announce: false }) : null;

    completionsChanged();
    offerUndoFor?.(`Logged an execution on ${longDate(day, getTodayDate())}.${flip?.moved ? " Moved to Active." : ""}`, async () => {
      // The execution goes first (its note cascades); each write that fails stops the
      // Undo there, so it never carries on past a half-undone state.
      if (!(await storage.delete(`execution:${execution.id}`))) throw writeError("Removing the execution");
      if (successor) {
        if (!(await storage.delete(`event:${successor.id}`))) throw writeError("Removing the next date");
        setEvents((prev) => prev.filter((e) => e.id !== successor.id));
      }
      if (live) {
        if (!(await storage.set(`event:${live.id}`, live))) throw writeError("Restoring its date");
        setEvents((prev) => prev.map((e) => (e.id === live.id ? live : e)));
      } else {
        if (!(await storage.delete(`event:${createdEvent.id}`))) throw writeError("Removing its date");
        setEvents((prev) => prev.filter((e) => e.id !== createdEvent.id));
      }
      if (createdIntent) {
        if (!(await storage.delete(`intent:${createdIntent.id}`))) throw writeError("Removing the intention");
        setIntents((prev) => prev.filter((i) => i.id !== createdIntent.id));
      } else if (oneTime && previousStatus && (CLOSE_REASON_SAVED || previousStatus !== "someday")) {
        // Closed -> someday is allowed inside the Undo window (Step 11's status_guard).
        const back = await storage.patch(`intent:${intentId}`, {
          status: previousStatus,
          ...restoredCloseFields(intent),
        });
        if (!back) throw writeError("Restoring the status");
        setIntents((prev) => prev.map((i) => (i.id === intentId ? back : i)));
      }
      await flip?.restore();
      await refreshCompletedRecords(execution, intent);
      completionsChanged();
    });
  }

  /** Complete an intention without an execution (Step 8). See recordDone. */
  async function markDone(intentId, options = {}) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent || hasOpen(intentId)) return false;
    let ok = false;
    await withLoading("Saving...", async () => {
      await recordDone(intent, options);
      ok = true;
    });
    return ok;
  }

  /**
   * Complete an item (Step 8): the intention Start Now would pick, or, when it has
   * none, a new one-time intention made exactly as Start Now makes it.
   */
  async function completeItem(itemId, options = {}) {
    const item = items.find((i) => i.id === itemId);
    if (!item) return false;
    const target = itemActionTarget(item.id, intents, events, [...activeExecutions, ...pausedExecutions])?.intent;
    if (target) return markDone(target.id, options);
    let ok = false;
    await withLoading("Saving...", async () => {
      const newIntent = {
        id: uid(),
        user_id: user.id,
        text: item.name,
        createdAt: new Date().toISOString(),
        isIntention: true,
        archived: false,
        itemId: item.id,
        contextId: item.contextId || null,
        recurrenceConfig: { type: "once" },
      };
      const saved = await storage.set(`intent:${newIntent.id}`, newIntent);
      if (!saved) throw writeError("Recording it");
      setIntents((prev) => [...prev, saved]);
      await recordDone(saved, options, saved);
      ok = true;
    });
    return ok;
  }

  return {
    activate,
    closeExecution,
    changeCompletionDate,
    deleteClosedExecution,
    markDone,
    completeItem,
    cancelExecutionForEvent,
    pauseExecution,
    makeExecutionActive,
    toggleExecutionElement,
    updateExecutionElement,
    toggleCollectionItem,
    startNowFromItem,
    startNowFromIntention,
    startMenuNow,
    setRecipeSkipped,
    logMenuDone,
  };
}
