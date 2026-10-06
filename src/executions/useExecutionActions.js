import { storage } from "../utils/storage";
import { uid, flattenElements } from "../utils/flattenElements";
import { getTodayDate } from "../utils/eventDates";
import { getRecurrenceConfig } from "../utils/recurrence";
import { runNowTargetForItem, isDueBy } from "../utils/runNow";
import {
  createNotificationSteps,
  completeNotificationStep,
  untickNotificationStep,
  cancelNotificationSteps,
  resumeNotificationSteps,
} from "../utils/notificationStepsApi";

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
}) {
  async function activate(eventId) {
    const event = events.find((e) => e.id === eventId);
    if (!event) return;
    return withLoading('Starting execution...', async () => {
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
          startedAt: new Date().toISOString(),
          status: "active",
          notes: "",
          elements: [],
          completedItemIds: [],
          progress: [],
        };
        await storage.set(`execution:${execution.id}`, execution);
        await startNotificationChain(execution);
        setActiveExecution(execution);
        setActiveExecutions((prev) => [execution, ...prev]);
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
        startedAt: new Date().toISOString(),
        status: "active",
        notes: "",
        elements: itemElements,
        progress: [],
      };

      await storage.set(`execution:${execution.id}`, execution);
      await startNotificationChain(execution);
      setActiveExecution(execution);
      setActiveExecutions((prev) => [execution, ...prev]);
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

  async function closeExecution(outcome) {
    if (!activeExecution) return;
    return withLoading('Completing...', async () => {
      // Cancel = Delete: just remove active execution, don't archive anything
      if (outcome === "cancelled") {
        // Cancel the chain BEFORE deleting the execution: afterwards the rows
        // would be orphans referencing a row that no longer exists. The
        // dispatcher's join to active executions would hide them, but leaving
        // live-looking rows behind for a run that never happened is not a
        // state worth defending.
        await endNotificationChain(activeExecution.id);
        await storage.delete(`execution:${activeExecution.id}`);
        setActiveExecutions((prev) => prev.filter((e) => e.id !== activeExecution.id));
        setActiveExecution(null);
        setView(previousView);
        return;
      }

      const closed = {
        ...activeExecution,
        closedAt: new Date().toISOString(),
        outcome,
        status: "closed",
      };

      // Archive the execution (notes and elements are preserved via spread)
      await storage.set(`execution:${closed.id}`, closed);
      await endNotificationChain(closed.id);

      // Archive the event
      const event = events.find((e) => e.id === activeExecution.eventId);
      if (event) {
        const archivedEvent = { ...event, archived: true };
        await storage.set(`event:${event.id}`, archivedEvent);
        setEvents(events.map((e) => (e.id === event.id ? archivedEvent : e)));
      }

      // Handle recurrence: archive one-time intents, or create next event for recurring
      const intent = intents.find((i) => i.id === activeExecution.intentId);
      if (intent) {
        const config = getRecurrenceConfig(intent);
        if (config.type === "once") {
          // One-time: archive intent on done (existing behavior)
          if (outcome === "done") {
            const archivedIntent = { ...intent, archived: true };
            await storage.set(`intent:${intent.id}`, archivedIntent);
            setIntents(intents.map((i) => (i.id === intent.id ? archivedIntent : i)));
          }
        } else {
          // Recurring: calculate and create next event
          await triggerRecurrence(intent.id, event);
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

      setActiveExecutions((prev) => prev.filter((e) => e.id !== activeExecution.id));
      setActiveExecution(null);
      setView(previousView);
    });
  }

  async function cancelExecutionForEvent(eventId) {
    const exec =
      activeExecutions.find((e) => e.eventId === eventId) ||
      pausedExecutions.find((e) => e.eventId === eventId);
    if (!exec) return;
    return withLoading('Cancelling...', async () => {
      await storage.delete(`execution:${exec.id}`);
      setActiveExecutions((prev) => prev.filter((e) => e.id !== exec.id));
      setPausedExecutions((prev) => prev.filter((e) => e.id !== exec.id));
      if (activeExecution && activeExecution.id === exec.id) {
        setActiveExecution(null);
      }
    });
  }

  async function pauseExecution() {
    if (!activeExecution) return;
    return withLoading('Pausing...', async () => {
      const paused = { ...activeExecution, status: "paused" };
      await storage.set(`execution:${paused.id}`, paused);
      setActiveExecutions((prev) => prev.filter((e) => e.id !== activeExecution.id));
      setPausedExecutions((prev) => [paused, ...prev]);
      setActiveExecution(null);
      setView("home");
    });
  }

  async function makeExecutionActive() {
    if (!activeExecution) return;
    return withLoading('Resuming...', async () => {
      const activated = { ...activeExecution, status: "active" };
      await storage.set(`execution:${activated.id}`, activated);
      // Pausing writes no rows — the dispatcher filters on execution status, so
      // a paused chain is already silent. Only resuming needs to act, so that a
      // due time that passed during the pause does not fire for a moment gone by.
      await rescheduleNotificationChain(activated.id);
      setPausedExecutions((prev) => prev.filter((e) => e.id !== activeExecution.id));
      setActiveExecutions((prev) => [activated, ...prev]);
      setActiveExecution(activated);
    });
  }

  async function toggleExecutionElement(elementIndex) {
    if (!activeExecution) return;
    const updatedElements = [...activeExecution.elements];
    const el = updatedElements[elementIndex];
    updatedElements[elementIndex] = {
      ...el,
      isCompleted: !el.isCompleted,
      completedAt: !el.isCompleted ? new Date().toISOString() : null,
      inProgress: false,
    };
    const updated = { ...activeExecution, elements: updatedElements };

    // Optimistic: update UI immediately
    setActiveExecution(updated);
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

  async function updateExecutionElement(elementIndex, fields) {
    if (!activeExecution) return;
    const updatedElements = [...activeExecution.elements];
    updatedElements[elementIndex] = { ...updatedElements[elementIndex], ...fields };
    const updated = { ...activeExecution, elements: updatedElements };

    // Optimistic: update UI immediately
    setActiveExecution(updated);
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

  async function updateExecutionNotes(notes) {
    if (!activeExecution) return;
    const updated = { ...activeExecution, notes };
    await storage.set(`execution:${updated.id}`, updated);
    setActiveExecution(updated);
    setActiveExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );
    setPausedExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );
  }

  async function toggleCollectionItem(itemId) {
    if (!activeExecution) return;
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

  async function startNowFromItem(itemId) {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;

    // Attach to a live intention for this item rather than minting a one-off
    // beside it — a one-off left the recurring intention behind and its
    // recurrence silently died.
    const target = runNowTargetForItem(item.id, intents, events);
    if (target) {
      if (isDueBy(target.event, getTodayDate())) {
        const running = [...activeExecutions, ...pausedExecutions].find(
          (e) => e.eventId === target.event.id,
        );
        if (running) {
          setPreviousView(view);
          goToExecution(running);
          return;
        }
        return activate(target.event.id);
      }
      return startNowFromIntention(target.intent.id);
    }

    return withLoading('Starting execution...', async () => {
      // Create intention linked to this item
      const newIntent = {
        id: uid(),
        user_id: user.id,
        text: item.name,
        createdAt: new Date().toISOString(),
        isIntention: true,
        isItem: false,
        archived: false,
        itemId: item.id,
        contextId: item.contextId || null,
        recurrenceConfig: { type: "once" },
      };
      const savedIntent = await storage.set(`intent:${newIntent.id}`, newIntent);
      setIntents((prev) => [...prev, savedIntent || newIntent]);

      // Create event for today
      const newEvent = {
        id: uid(),
        user_id: user.id,
        intentId: newIntent.id,
        time: getTodayDate(),
        itemIds: [item.id],
        contextId: item.contextId || null,
        archived: false,
        createdAt: new Date().toISOString(),
      };
      const savedEvent = await storage.set(`event:${newEvent.id}`, newEvent);
      setEvents((prev) => [...prev, savedEvent || newEvent]);

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
        startedAt: new Date().toISOString(),
        status: "active",
        notes: "",
        elements: itemElements,
        progress: [],
      };

      await storage.set(`execution:${execution.id}`, execution);
      await startNotificationChain(execution);
      setActiveExecution(execution);
      setActiveExecutions((prev) => [execution, ...prev]);
      setPreviousView(view);
      goToExecution(execution);
    });
  }

  async function startNowFromIntention(intentId) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return;
    return withLoading('Starting execution...', async () => {
      // Find linked item if any
      const linkedItem = intent.itemId
        ? items.find((i) => i.id === intent.itemId)
        : null;

      // Create event for today
      const newEvent = {
        id: uid(),
        user_id: user.id,
        intentId: intent.id,
        time: getTodayDate(),
        itemIds: linkedItem ? [linkedItem.id] : [],
        contextId: intent.contextId || null,
        collectionId: intent.collectionId || null,
        archived: false,
        createdAt: new Date().toISOString(),
      };
      const savedEvent = await storage.set(`event:${newEvent.id}`, newEvent);
      setEvents((prev) => [...prev, savedEvent || newEvent]);

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
          startedAt: new Date().toISOString(),
          status: "active",
          notes: "",
          elements: [],
          completedItemIds: [],
          progress: [],
        };
        await storage.set(`execution:${execution.id}`, execution);
        await startNotificationChain(execution);
        setActiveExecution(execution);
        setActiveExecutions((prev) => [execution, ...prev]);
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
        startedAt: new Date().toISOString(),
        status: "active",
        notes: "",
        elements: itemElements,
        progress: [],
      };

      await storage.set(`execution:${execution.id}`, execution);
      await startNotificationChain(execution);
      setActiveExecution(execution);
      setActiveExecutions((prev) => [execution, ...prev]);
      setPreviousView(view);
      goToExecution(execution);
    });
  }

  return {
    activate,
    closeExecution,
    cancelExecutionForEvent,
    pauseExecution,
    makeExecutionActive,
    toggleExecutionElement,
    updateExecutionElement,
    updateExecutionNotes,
    toggleCollectionItem,
    startNowFromItem,
    startNowFromIntention,
  };
}
