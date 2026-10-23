// Restructure P5 step 14: cooking a menu.
import { useExecutionActions } from "./useExecutionActions";
import { storage } from "../utils/storage";
import { getTodayDate } from "../utils/eventDates";
import { moveCookRecipes } from "./menuHistory";
import { saveNote } from "../notes/notesApi";

jest.mock("../notes/notesApi", () => ({ saveNote: jest.fn(), completionsChanged: jest.fn() }));
jest.mock("./menuHistory", () => ({ moveCookRecipes: jest.fn(async () => {}) }));
jest.mock("../utils/storage", () => ({
  storage: { set: jest.fn(), delete: jest.fn(), patch: jest.fn(), get: jest.fn() },
  writeError: (what) => new Error(what),
}));
jest.mock("../utils/notificationStepsApi", () => ({
  createNotificationSteps: jest.fn(async () => []),
  completeNotificationStep: jest.fn(async () => ({ complete: [], schedule: [], rowsSeen: 0 })),
  untickNotificationStep: jest.fn(async () => ({ patches: [], rowsSeen: 0 })),
  cancelNotificationSteps: jest.fn(async () => []),
  resumeNotificationSteps: jest.fn(async () => []),
}));

const today = getTodayDate();
const menu = { id: "g", groupTypeId: "menu", name: "P5 Test Menu", contextId: "c", status: "active" };
const groupTypes = [{ id: "menu", executionMode: "together" }];
const groupMembers = [
  { id: "m1", groupId: "g", memberType: "item", memberId: "rice", position: 1 },
  { id: "m2", groupId: "g", memberType: "item", memberId: "dal", position: 2 },
  { id: "m3", groupId: "g", memberType: "intention", memberId: "shop", position: 3 },
];
const items = [
  { id: "rice", name: "Spanish Rice", contextId: "c", elements: [{ name: "Rinse", displayType: "step" }] },
  { id: "dal", name: "Red Lentil Dal", contextId: "c", elements: [] },
];

// A tiny state store, so the lists the hook writes can be read back.
function harness({ intents = [], events = [], active = [], paused = [], activeExecution = null } = {}) {
  const state = { intents, events, active, paused, activeExecution, groups: [menu], items };
  const set = (key) => (v) => { state[key] = typeof v === "function" ? v(state[key]) : v; };
  const actions = () =>
    useExecutionActions({
      user: { id: "u" },
      view: "group-detail",
      setView: jest.fn(),
      items,
      intents: state.intents,
      setIntents: set("intents"),
      events: state.events,
      setEvents: set("events"),
      activeExecution: state.activeExecution,
      setActiveExecution: set("activeExecution"),
      activeExecutions: state.active,
      setActiveExecutions: set("active"),
      pausedExecutions: state.paused,
      setPausedExecutions: set("paused"),
      previousView: "home",
      setPreviousView: jest.fn(),
      goToExecution: jest.fn(),
      triggerRecurrence: jest.fn(),
      clearCompletedFromCollection: jest.fn(),
      withLoading: async (_label, fn) => fn(),
      watchStatus: () => async () => ({ moved: false, restore: async () => {} }),
      setItems: set("items"),
      notify: jest.fn(),
      offerUndoFor: (_message, fn) => { state.undo = fn; },
      itemGroups: state.groups,
      setItemGroups: set("groups"),
      groupTypes,
      groupMembers,
    });
  return { state, actions };
}

const written = (prefix) => storage.set.mock.calls.filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);

beforeEach(() => {
  jest.clearAllMocks();
  storage.set.mockImplementation(async (_, v) => v);
  storage.patch.mockImplementation(async (key, fields) => ({ id: key.split(":")[1], ...fields }));
  storage.delete.mockResolvedValue(true);
  storage.get.mockResolvedValue(null);
});

test("Start Now: makes the intention and today's date, then the menu run and one run per recipe", async () => {
  const h = harness();
  await h.actions().startMenuNow("g");
  const [intent] = written("intent:");
  const [event] = written("event:");
  const runs = written("execution:");
  expect(intent).toMatchObject({ groupId: "g", text: "P5 Test Menu" });
  expect(event).toMatchObject({ intentId: intent.id, time: today, itemIds: [] });
  expect(runs[0]).toMatchObject({ intentId: intent.id, eventId: event.id, groupId: "g", itemIds: [], status: "active" });
  // Recipes only (the intention member is listed, not executed); no intention, no event.
  expect(runs.slice(1).map((r) => [r.itemIds, r.intentId, r.eventId, r.groupId, r.parentExecutionId])).toEqual([
    [["rice"], null, null, "g", runs[0].id],
    [["dal"], null, null, "g", runs[0].id],
  ]);
  expect(runs[1].elements[0]).toMatchObject({ name: "Rinse", isCompleted: false, sourceItemId: "rice" });
  expect(h.state.activeExecution.id).toBe(runs[0].id);
  expect(h.state.active).toHaveLength(3);
});

test("Start Now reuses the intention and moves a future date to today; an open run is continued", async () => {
  const own = { id: "o", groupId: "g", status: "active", contextId: "c" };
  const future = { id: "e", intentId: "o", time: "2099-01-01", archived: false };
  const h = harness({ intents: [own], events: [future] });
  await h.actions().startMenuNow("g");
  expect(written("intent:")).toHaveLength(0);
  expect(written("event:")[0]).toMatchObject({ id: "e", time: today });
  expect(written("execution:")[0]).toMatchObject({ eventId: "e", priorEventDate: "2099-01-01" });

  jest.clearAllMocks();
  const open = { id: "run", intentId: "o", groupId: "g", status: "paused" };
  const again = harness({ intents: [own], events: [future], paused: [open] });
  await again.actions().startMenuNow("g");
  expect(storage.set).not.toHaveBeenCalled();
});

test("a failed recipe save deletes the runs already made", async () => {
  storage.set.mockImplementation(async (k, v) => (k.startsWith("execution:") && v.itemIds?.[0] === "dal" ? null : v));
  const h = harness({ intents: [{ id: "o", groupId: "g", status: "active" }], events: [{ id: "e", intentId: "o", time: today, archived: false }] });
  await expect(h.actions().startMenuNow("g")).rejects.toThrow(/Red Lentil Dal/);
  expect(storage.delete.mock.calls.map(([k]) => k.split(":")[0])).toEqual(["execution", "execution"]);
});

const own = { id: "o", groupId: "g", status: "active", recurrenceConfig: { type: "once" } };
const menuRun = { id: "mr", intentId: "o", eventId: "e", groupId: "g", status: "active", itemIds: [], elements: [] };
const rice = { id: "r1", intentId: null, eventId: null, groupId: "g", parentExecutionId: "mr", itemIds: ["rice"], status: "active", elements: [{ name: "Rinse", isCompleted: false }] };
const dal = { id: "r2", intentId: null, eventId: null, groupId: "g", parentExecutionId: "mr", itemIds: ["dal"], status: "active", outcome: "skipped", elements: [] };
const cooking = () =>
  harness({ intents: [own], events: [{ id: "e", intentId: "o", time: today, archived: false }], active: [menuRun, rice, dal], activeExecution: menuRun });

test("Complete closes the menu and every recipe at once, skipped ones as skipped; the menu's intention stays open", async () => {
  const h = cooking();
  await h.actions().closeExecution("done", { completedOn: today });
  const closed = Object.fromEntries(written("execution:").map((r) => [r.id, r]));
  expect(closed.mr).toMatchObject({ status: "closed", outcome: "done" });
  expect(closed.r1).toMatchObject({ status: "closed", outcome: "done", closedAt: closed.mr.closedAt });
  expect(closed.r2).toMatchObject({ status: "closed", outcome: "skipped" });
  expect(storage.patch.mock.calls.some(([k]) => k === "intent:o")).toBe(false);
  expect(h.state.active).toEqual([]);
  // The menu and recipes are re-read for their last-done dates.
  expect(storage.get.mock.calls.map(([k]) => k)).toEqual(expect.arrayContaining(["group:g", "item:rice", "item:dal"]));
});

test("Delete removes the recipe runs too, and the date and intention Start Now made", async () => {
  const startedAt = "2026-10-23T17:00:00.000Z";
  const made = { ...own, createdAt: startedAt };
  const h = harness({
    intents: [made],
    events: [{ id: "e", intentId: "o", time: today, archived: false, createdAt: startedAt }],
    active: [{ ...menuRun, startedAt }, rice, dal],
    activeExecution: { ...menuRun, startedAt },
  });
  // The date is "untouched" when it is startedAt's local day.
  h.state.events[0].time = new Date(startedAt).toLocaleDateString("en-CA");
  await h.actions().closeExecution("cancelled");
  expect(storage.delete.mock.calls.map(([k]) => k)).toEqual(["execution:r1", "execution:r2", "execution:mr", "event:e", "intent:o"]);
  expect(h.state.active).toEqual([]);
});

test("Pause and Continue move the whole menu", async () => {
  const h = cooking();
  await h.actions().pauseExecution();
  expect(h.state.paused.map((r) => r.id).sort()).toEqual(["mr", "r1", "r2"]);
  expect(h.state.active).toEqual([]);
  h.state.activeExecution = h.state.paused.find((r) => r.id === "mr");
  await h.actions().makeExecutionActive();
  expect(h.state.active.map((r) => r.id).sort()).toEqual(["mr", "r1", "r2"]);
});

test("a completed menu: Delete is one delete (its recipe runs cascade); a new date moves them with it", async () => {
  const done = { ...menuRun, status: "closed", outcome: "done", closedAt: "2026-10-20T12:00:00.000Z" };
  const h = harness({ intents: [own], activeExecution: done });
  await h.actions().deleteClosedExecution();
  expect(storage.delete.mock.calls).toEqual([["execution:mr"]]);
  expect(storage.get.mock.calls.map(([k]) => k)).toEqual(expect.arrayContaining(["group:g", "item:rice", "item:dal"]));

  const moved = harness({ intents: [own], activeExecution: done });
  await moved.actions().changeCompletionDate("2026-10-19");
  expect(moveCookRecipes).toHaveBeenCalledWith(done, new Date(2026, 9, 19, 12, 0).toISOString());
});

test("Log Execution: the menu run and one closed run per recipe, unticked as skipped, on the live date", async () => {
  const live = { id: "e", intentId: "o", time: today, archived: false };
  const h = harness({ intents: [own], events: [live] });
  expect(await h.actions().logMenuDone("g", { completedOn: "2026-10-21", doneIds: ["rice"], note: "Good" })).toBe(true);
  const runs = written("execution:");
  const menuLog = runs[0];
  expect(menuLog).toMatchObject({ intentId: "o", eventId: "e", groupId: "g", itemIds: [], status: "closed", outcome: "done" });
  expect(runs.slice(1).map((r) => [r.itemIds[0], r.outcome, r.parentExecutionId, r.closedAt])).toEqual([
    ["rice", "done", menuLog.id, menuLog.closedAt],
    ["dal", "skipped", menuLog.id, menuLog.closedAt],
  ]);
  expect(saveNote).toHaveBeenCalledWith(expect.objectContaining({ body: "Good", targetType: "group", targetId: "g", executionId: menuLog.id }));
  expect(written("event:")[0]).toMatchObject({ id: "e", archived: true });
  // Undo: one delete takes the cook; the date comes back.
  storage.delete.mockClear();
  await h.state.undo();
  expect(storage.delete.mock.calls).toEqual([[`execution:${menuLog.id}`]]);
  expect(storage.set).toHaveBeenLastCalledWith("event:e", live);
});

test("Log Execution with no date makes an archived one that day, and none of the menu's intention when it exists", async () => {
  const h = harness({ intents: [own] });
  await h.actions().logMenuDone("g", { completedOn: "2026-10-21", doneIds: [] });
  expect(written("event:")[0]).toMatchObject({ intentId: "o", time: "2026-10-21", archived: true });
  expect(written("intent:")).toHaveLength(0);
});

test("a recipe's step ticks on its own run; skip and unskip save the outcome", async () => {
  const h = cooking();
  await h.actions().toggleExecutionElement(0, rice);
  expect(written("execution:")[0]).toMatchObject({ id: "r1", elements: [expect.objectContaining({ isCompleted: true })] });
  expect(h.state.activeExecution).toBe(menuRun);
  await h.actions().setRecipeSkipped(rice, true);
  expect(storage.patch).toHaveBeenLastCalledWith("execution:r1", { outcome: "skipped" });
  await h.actions().setRecipeSkipped(dal, false);
  expect(storage.patch).toHaveBeenLastCalledWith("execution:r2", { outcome: null });
});
