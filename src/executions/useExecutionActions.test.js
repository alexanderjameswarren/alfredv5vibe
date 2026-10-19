// A completed (closed) execution is read only: no writer touches it.
import { useExecutionActions, withActive, closedAtFor } from "./useExecutionActions";
import { storage, writeError } from "../utils/storage";
import * as chainApi from "../utils/notificationStepsApi";
import * as notesApi from "../notes/notesApi";

jest.mock("../notes/notesApi", () => ({ saveNote: jest.fn(), completionsChanged: jest.fn() }));

jest.mock("../utils/storage", () => ({
  storage: { set: jest.fn(), delete: jest.fn(), patch: jest.fn(), get: jest.fn() },
  writeError: jest.fn(),
}));
jest.mock("../utils/notificationStepsApi", () => ({
  createNotificationSteps: jest.fn(),
  completeNotificationStep: jest.fn(),
  untickNotificationStep: jest.fn(),
  cancelNotificationSteps: jest.fn(),
  resumeNotificationSteps: jest.fn(),
}));

function actionsFor(execution, overrides = {}) {
  const noop = jest.fn();
  return useExecutionActions({
    user: { id: "u" },
    view: "execution-detail",
    setView: noop,
    items: [],
    intents: [{ id: "i1" }],
    setIntents: noop,
    events: [{ id: "e1", intentId: "i1" }],
    setEvents: noop,
    activeExecution: execution,
    setActiveExecution: noop,
    activeExecutions: [],
    setActiveExecutions: noop,
    pausedExecutions: [],
    setPausedExecutions: noop,
    previousView: "home",
    setPreviousView: noop,
    goToExecution: noop,
    triggerRecurrence: noop,
    clearCompletedFromCollection: noop,
    withLoading: async (_label, fn) => fn(),
    watchStatus: () => async () => {},
    ...overrides,
  });
}

const closedRun = {
  id: "x", intentId: "i1", eventId: "e1", status: "closed", outcome: "done",
  elements: [{ name: "a", isCompleted: false }], completedItemIds: [], collectionId: null,
};

test("every writer refuses a closed execution", async () => {
  const a = actionsFor(closedRun);
  await a.toggleExecutionElement(0);
  await a.updateExecutionElement(0, { inProgress: true });
  await a.toggleCollectionItem("it1");
  await a.pauseExecution();
  await a.makeExecutionActive();
  await a.closeExecution("done");
  await a.closeExecution("cancelled");
  expect(storage.set).not.toHaveBeenCalled();
  expect(storage.delete).not.toHaveBeenCalled();
  expect(storage.patch).not.toHaveBeenCalled();
  expect(chainApi.completeNotificationStep).not.toHaveBeenCalled();
  expect(chainApi.cancelNotificationSteps).not.toHaveBeenCalled();
});

test("completing or deleting a paused run drops it from the paused list", async () => {
  storage.set.mockResolvedValue({});
  storage.delete.mockResolvedValue(true);
  for (const outcome of ["done", "cancelled"]) {
    let paused = [{ id: "x" }, { id: "y" }];
    const setPausedExecutions = (f) => { paused = f(paused); };
    await actionsFor({ ...closedRun, status: "paused" }, { setPausedExecutions }).closeExecution(outcome);
    expect(paused.map((e) => e.id)).toEqual(["y"]);
  }
});

describe("Delete Execution puts back what Start Now changed (Step 11)", () => {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayStr = ymd(today);
  const later = ymd(new Date(today.getFullYear() + 1, 0, 5));
  const run = (extra) => ({ id: "x", intentId: "i1", eventId: "e1", status: "active", startedAt: today.toISOString(), elements: [], ...extra });

  beforeEach(() => {
    storage.delete.mockResolvedValue(true);
    storage.set.mockImplementation(async (_, v) => v);
    storage.patch.mockImplementation(async (k, f) => ({ id: k.split(":")[1], ...f }));
  });

  test("the moved date goes back while the event is still on the day it was moved to", async () => {
    await actionsFor(run({ priorEventDate: later }), { events: [{ id: "e1", intentId: "i1", time: todayStr }] }).closeExecution("cancelled");
    expect(storage.set).toHaveBeenCalledWith("event:e1", expect.objectContaining({ time: later }));
  });

  test("not when the event has moved since, or the old date has passed", async () => {
    await actionsFor(run({ priorEventDate: later }), { events: [{ id: "e1", intentId: "i1", time: "2099-01-01" }] }).closeExecution("cancelled");
    await actionsFor(run({ priorEventDate: "2000-01-01" }), { events: [{ id: "e1", intentId: "i1", time: todayStr }] }).closeExecution("cancelled");
    expect(storage.set).not.toHaveBeenCalled();
  });

  test("an event Start Now created is removed, so it reads Not scheduled again", async () => {
    const started = run({ priorIntentStatus: "background" });
    const made = { id: "e1", intentId: "i1", time: todayStr, createdAt: started.startedAt.replace("Z", "+00:00") };
    await actionsFor(started, { events: [made], intents: [{ id: "i1", status: "active" }] }).closeExecution("cancelled");
    expect(storage.delete).toHaveBeenCalledWith("event:e1");
    expect(storage.patch).toHaveBeenCalledWith("intent:i1", { status: "background" });
  });

  test("an event that existed before Start Now is never removed", async () => {
    const before = { id: "e1", intentId: "i1", time: todayStr, createdAt: "2026-10-01T09:00:00Z" };
    await actionsFor(run({}), { events: [before] }).closeExecution("cancelled");
    expect(storage.delete).not.toHaveBeenCalledWith("event:e1");
  });

  test("a status Start Now un-parked goes back to Background", async () => {
    await actionsFor(run({ priorIntentStatus: "background" }), { intents: [{ id: "i1", status: "active" }] }).closeExecution("cancelled");
    expect(storage.patch).toHaveBeenCalledWith("intent:i1", { status: "background" });
  });

  test("a failed delete stops before anything is restored", async () => {
    storage.delete.mockResolvedValueOnce(false);
    writeError.mockImplementation((what) => new Error(what));
    const withLoading = async (_l, fn) => fn();
    await expect(
      actionsFor(run({ priorEventDate: later }), { withLoading, events: [{ id: "e1", intentId: "i1", time: todayStr }] }).closeExecution("cancelled"),
    ).rejects.toThrow("Deleting the execution");
    expect(storage.set).not.toHaveBeenCalled();
  });
});

test("Start Now with no date: the event it makes carries the execution's startedAt as createdAt", async () => {
  storage.set.mockImplementation(async (_, v) => v);
  await actionsFor(null, { intents: [{ id: "i1", status: "active" }], events: [] }).startNowFromIntention("i1");
  const event = storage.set.mock.calls.find(([k]) => k.startsWith("event:"))[1];
  const exec = storage.set.mock.calls.find(([k]) => k.startsWith("execution:"))[1];
  expect(event.createdAt).toBe(exec.startedAt);
});

test("Start Now on a future date records the date it moved", async () => {
  storage.set.mockImplementation(async (_, v) => v);
  const future = "2099-01-05";
  await actionsFor(null, {
    intents: [{ id: "i1", status: "active" }],
    events: [{ id: "e1", intentId: "i1", time: future, archived: false, itemIds: [] }],
  }).startNowFromIntention("i1");
  const exec = storage.set.mock.calls.find(([k]) => k.startsWith("execution:"))[1];
  expect(exec.priorEventDate).toBe(future);
});

test("an open execution still writes", async () => {
  storage.set.mockResolvedValue({});
  await actionsFor({ ...closedRun, status: "active" }).pauseExecution();
  expect(storage.set).toHaveBeenCalled();
});

test("completing re-reads the intention and item, so the row's last done shows without a reload", async () => {
  storage.set.mockResolvedValue({});
  storage.patch.mockResolvedValue({ id: "i1", status: "closed" });
  storage.get.mockImplementation(async (key) =>
    key === "intent:i1" ? { id: "i1", itemId: "it1", lastCompletedAt: "2026-10-14T12:00:00Z" } : { id: "it1", lastCompletedAt: "2026-10-14T12:00:00Z" },
  );
  let intents = [{ id: "i1", itemId: "it1" }];
  let items = [{ id: "it1" }];
  await actionsFor(
    { ...closedRun, status: "active" },
    {
      intents,
      setIntents: (f) => { intents = typeof f === "function" ? f(intents) : f; },
      setItems: (f) => { items = typeof f === "function" ? f(items) : f; },
    },
  ).closeExecution("done", { completedOn: "2026-10-14" });
  expect(intents[0].lastCompletedAt).toBe("2026-10-14T12:00:00Z");
  expect(items[0].lastCompletedAt).toBe("2026-10-14T12:00:00Z");
});

test("changeCompletionDate: only a done execution's date, then the rows refresh and a toast confirms", async () => {
  const saved = { ...closedRun, closedAt: "2026-10-07T12:00:00Z" };
  storage.patch.mockResolvedValue(saved);
  storage.get.mockResolvedValue({ id: "i1", lastCompletedAt: "2026-10-09T12:00:00Z" });
  const notify = jest.fn();
  const setActiveExecution = jest.fn();
  let intents = [{ id: "i1" }];
  const a = actionsFor(closedRun, {
    intents,
    notify,
    setActiveExecution,
    setIntents: (f) => { intents = typeof f === "function" ? f(intents) : f; },
  });
  expect(await a.changeCompletionDate("2026-10-07")).toBe(true);
  expect(storage.patch).toHaveBeenCalledWith("execution:x", { closedAt: expect.any(String) });
  expect(setActiveExecution).toHaveBeenCalledWith(saved);
  // The database keeps the LATEST done date; the row shows what it says.
  expect(intents[0].lastCompletedAt).toBe("2026-10-09T12:00:00Z");
  expect(notify).toHaveBeenCalledWith(expect.stringMatching(/^Completed on /));
  storage.patch.mockClear();
  expect(await actionsFor({ ...closedRun, outcome: "skipped" }).changeCompletionDate("2026-10-07")).toBe(false);
  expect(await actionsFor({ ...closedRun, status: "active" }).changeCompletionDate("2026-10-07")).toBe(false);
  expect(storage.patch).not.toHaveBeenCalled();
});

test("deleteClosedExecution: deletes, re-reads last done, goes back; events and status untouched", async () => {
  storage.delete.mockResolvedValue(true);
  storage.get.mockResolvedValue({ id: "i1", status: "closed", lastCompletedAt: null });
  const setView = jest.fn();
  const setActiveExecution = jest.fn();
  let intents = [{ id: "i1", status: "closed", lastCompletedAt: "2026-10-09T12:00:00Z" }];
  const a = actionsFor(closedRun, {
    intents,
    setView,
    setActiveExecution,
    previousView: "intention-detail",
    setIntents: (f) => { intents = typeof f === "function" ? f(intents) : f; },
  });
  expect(await a.deleteClosedExecution()).toBe(true);
  expect(storage.delete).toHaveBeenCalledWith("execution:x");
  expect(intents[0]).toMatchObject({ status: "closed", lastCompletedAt: null });
  expect(setActiveExecution).toHaveBeenCalledWith(null);
  expect(setView).toHaveBeenCalledWith("intention-detail");
  expect(storage.set).not.toHaveBeenCalled();
  expect(storage.patch).not.toHaveBeenCalled();
  storage.delete.mockClear();
  expect(await actionsFor({ ...closedRun, status: "active" }).deleteClosedExecution()).toBe(false);
  expect(storage.delete).not.toHaveBeenCalled();
});

describe("markDone: complete a repeating intention without an execution", () => {
  const live = { id: "e1", intentId: "i1", time: "2026-10-20", archived: false, itemIds: ["it1"] };

  function setup(extra = {}) {
    let undo = null;
    let events = [live];
    const triggerRecurrence = jest.fn().mockResolvedValue({ id: "next" });
    const a = actionsFor(null, {
      intents: [{ id: "i1", itemId: "it1", contextId: "c1", status: "active", recurrenceConfig: { type: "fixed", frequency: "daily", interval: 1 } }],
      events,
      setEvents: (f) => { events = typeof f === "function" ? f(events) : f; },
      triggerRecurrence,
      offerUndoFor: (message, restore) => { undo = { message, restore }; },
      ...extra,
    });
    return { a, triggerRecurrence, undo: () => undo, events: () => events };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    storage.set.mockImplementation(async (_, v) => v);
    storage.delete.mockResolvedValue(true);
    storage.get.mockResolvedValue(null);
    notesApi.saveNote.mockResolvedValue({ id: "n" });
  });

  test("records a closed done execution on the live event, with the note, and makes the next event", async () => {
    const { a, triggerRecurrence, events } = setup();
    expect(await a.markDone("i1", { note: "felt good", nextDate: "2026-10-21", completedOn: "2026-10-15" })).toBe(true);
    const [key, execution] = storage.set.mock.calls.find(([k]) => k.startsWith("execution:"));
    expect(key).toMatch(/^execution:/);
    expect(execution).toMatchObject({ eventId: "e1", intentId: "i1", status: "closed", outcome: "done" });
    expect(execution.closedAt).toBe(new Date(2026, 9, 15, 12, 0).toISOString());
    expect(notesApi.saveNote).toHaveBeenCalledWith(expect.objectContaining({ body: "felt good", executionId: execution.id }));
    expect(events().find((e) => e.id === "e1").archived).toBe(true);
    expect(triggerRecurrence).toHaveBeenCalledWith("i1", live, { nextDate: "2026-10-21" });
  });

  test("logging an execution on a Background intention: one toast, and Undo puts Background back", async () => {
    const restore = jest.fn();
    const { a, undo } = setup({ watchStatus: () => async () => ({ moved: true, restore }) });
    await a.markDone("i1", { completedOn: "2026-10-15" });
    expect(undo().message).toMatch(/\. Moved to Active\.$/);
    await undo().restore();
    expect(restore).toHaveBeenCalled();
  });

  test("Undo stops at a failed delete and restores nothing else", async () => {
    const { a, undo } = setup();
    await a.markDone("i1", { completedOn: "2026-10-15" });
    storage.delete.mockResolvedValueOnce(false);
    storage.set.mockClear();
    writeError.mockImplementation((what) => new Error(what));
    await expect(undo().restore()).rejects.toThrow(/Removing the execution/);
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.set).not.toHaveBeenCalled();
  });

  test("says 'Logged an execution on …' and tells Recent completions to reload, on log and on Undo", async () => {
    const { a, undo } = setup();
    await a.markDone("i1", { completedOn: "2026-10-15" });
    expect(undo().message).toMatch(/^Logged an execution on Thursday, October 15/);
    expect(notesApi.completionsChanged).toHaveBeenCalledTimes(1);
    await undo().restore();
    expect(notesApi.completionsChanged).toHaveBeenCalledTimes(2);
  });

  test("Undo removes the execution and the next event, and brings the date back", async () => {
    const { a, undo, events } = setup();
    await a.markDone("i1", { completedOn: "2026-10-15" });
    storage.set.mockClear();
    await undo().restore();
    expect(storage.delete).toHaveBeenCalledWith("event:next");
    expect(storage.delete).toHaveBeenCalledWith(expect.stringMatching(/^execution:/));
    expect(storage.set).toHaveBeenCalledWith("event:e1", live);
    expect(events().find((e) => e.id === "e1").archived).toBe(false);
  });

  test("with no live event it records on a new event that is already archived", async () => {
    const { a } = setup({ events: [] });
    await a.markDone("i1", { completedOn: "2026-10-15" });
    const [, event] = storage.set.mock.calls.find(([k]) => k.startsWith("event:"));
    expect(event).toMatchObject({ intentId: "i1", time: "2026-10-15", archived: true });
  });

  test("a one-time intention is closed, and Undo reopens it", async () => {
    let intents = [{ id: "o1", status: "active", recurrenceConfig: { type: "once" } }];
    let undo = null;
    storage.patch.mockImplementation(async (key, fields) => ({ id: key.split(":")[1], ...fields }));
    const triggerRecurrence = jest.fn();
    const a = actionsFor(null, {
      intents,
      events: [],
      setIntents: (f) => { intents = typeof f === "function" ? f(intents) : f; },
      triggerRecurrence,
      offerUndoFor: (m, restore) => { undo = restore; },
    });
    expect(await a.markDone("o1", { completedOn: "2026-10-15" })).toBe(true);
    // The automatic close saves reason 'done' and Closed on = the Completed on day (Step 11).
    expect(storage.patch).toHaveBeenCalledWith("intent:o1", {
      status: "closed",
      closedReason: "done",
      statusChangedAt: new Date(2026, 9, 15, 12, 0).toISOString(),
    });
    expect(triggerRecurrence).not.toHaveBeenCalled();
    await undo();
    expect(storage.patch).toHaveBeenCalledWith("intent:o1", { status: "active", closedReason: null });
  });

  test("an item with no intention gets one, made as Start Now makes it; Undo deletes it", async () => {
    let intents = [];
    let undo = null;
    storage.patch.mockImplementation(async (key, fields) => ({ id: key.split(":")[1], ...fields }));
    const a = actionsFor(null, {
      items: [{ id: "it9", name: "Tile grout", contextId: "c1" }],
      intents,
      events: [],
      setIntents: (f) => { intents = typeof f === "function" ? f(intents) : f; },
      offerUndoFor: (m, restore) => { undo = restore; },
    });
    expect(await a.completeItem("it9", { completedOn: "2026-10-15" })).toBe(true);
    const [, created] = storage.set.mock.calls.find(([k]) => k.startsWith("intent:"));
    expect(created).toMatchObject({ text: "Tile grout", itemId: "it9", recurrenceConfig: { type: "once" } });
    expect(storage.patch).toHaveBeenCalledWith(`intent:${created.id}`, expect.objectContaining({ status: "closed", closedReason: "done" }));
    await undo();
    expect(storage.delete).toHaveBeenCalledWith(`intent:${created.id}`);
    expect(intents.find((i) => i.id === created.id)).toBeUndefined();
  });

  test("refused while the intention has an open execution", async () => {
    const { a } = setup({ activeExecutions: [{ id: "x", intentId: "i1", status: "active" }] });
    expect(await a.markDone("i1", {})).toBe(false);
    expect(storage.set).not.toHaveBeenCalled();
  });
});

test("closedAtFor: now for today, midday for any earlier day", () => {
  const now = new Date(2026, 9, 16, 9, 30);
  expect(closedAtFor(null, now)).toBe(now.toISOString());
  expect(closedAtFor("2026-10-16", now)).toBe(now.toISOString());
  expect(closedAtFor("2026-10-07", now)).toBe(new Date(2026, 9, 7, 12, 0).toISOString());
  expect(closedAtFor("2025-12-01", now)).toBe(new Date(2025, 11, 1, 12, 0).toISOString());
});

test("a run realtime already added is not added twice", () => {
  const run = { id: "x" };
  const list = [run, { id: "y" }];
  expect(withActive(list, { id: "x" })).toBe(list);
  expect(withActive([{ id: "y" }], run)).toEqual([run, { id: "y" }]);
});
