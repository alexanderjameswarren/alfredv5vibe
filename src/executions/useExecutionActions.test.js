// A completed (closed) execution is read only: no writer touches it.
import { useExecutionActions, withActive, closedAtFor } from "./useExecutionActions";
import { storage } from "../utils/storage";
import * as chainApi from "../utils/notificationStepsApi";

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
