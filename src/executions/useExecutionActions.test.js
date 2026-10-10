// A completed (closed) execution is read only: no writer touches it.
import { useExecutionActions } from "./useExecutionActions";
import { storage } from "../utils/storage";
import * as chainApi from "../utils/notificationStepsApi";

jest.mock("../utils/storage", () => ({
  storage: { set: jest.fn(), delete: jest.fn(), patch: jest.fn() },
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
