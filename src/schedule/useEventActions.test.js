import { useEventActions } from "./useEventActions";
import { storage } from "../utils/storage";
import { getTodayDate } from "../utils/eventDates";

jest.mock("../utils/storage", () => ({
  storage: { set: jest.fn(), get: jest.fn(), delete: jest.fn() },
  writeError: (what) => new Error(what),
}));
jest.mock("../notes/notesApi", () => ({ completionsChanged: jest.fn() }));
let mockOpenRows = [];
jest.mock("../supabaseClient", () => {
  const q = { select: () => q, eq: () => q, is: () => q, limit: () => Promise.resolve({ data: mockOpenRows, error: null }) };
  return { supabase: { from: () => q } };
});

const today = getTodayDate();
const daysFrom = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function setup(intent, events = []) {
  storage.get.mockResolvedValue(intent);
  storage.set.mockImplementation(async (_, v) => v);
  return useEventActions({
    user: { id: "u" },
    events,
    setEvents: jest.fn(),
    intents: [intent],
    withLoading: (_, fn) => fn(),
    offerUndoFor: jest.fn(),
  });
}

const daily = { id: "i", status: "active", recurrenceConfig: { type: "fixed", frequency: "daily", interval: 1 } };

beforeEach(() => {
  jest.clearAllMocks();
  mockOpenRows = [];
});

function archiveSetup(intent, event) {
  const offerUndoFor = jest.fn();
  storage.get.mockResolvedValue(intent);
  storage.delete.mockResolvedValue(true);
  storage.set.mockImplementation(async (_, v) => v);
  const actions = useEventActions({
    user: { id: "u" },
    events: [event],
    setEvents: jest.fn(),
    intents: [intent],
    withLoading: (_, fn) => fn(),
    offerUndoFor,
  });
  return { actions, offerUndoFor };
}

const written = (prefix) => storage.set.mock.calls.filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);

test("Skip on a repeat writes a skipped execution, the next date, and Undo takes both back", async () => {
  const event = { id: "e", intentId: "i", time: today, archived: false };
  const { actions, offerUndoFor } = archiveSetup(daily, event);
  await actions.updateEvent("e", { archived: true });
  const [exec] = written("execution:");
  expect(exec).toMatchObject({ eventId: "e", intentId: "i", status: "closed", outcome: "skipped" });
  const [next] = written("event:").filter((e) => e.id !== "e");
  expect(next.time).toBe(daysFrom(1));
  expect(offerUndoFor.mock.calls[0][0]).toMatch(/^Skipped /);
  await offerUndoFor.mock.calls[0][1]();
  expect(storage.delete).toHaveBeenCalledWith(`event:${next.id}`);
  expect(storage.delete).toHaveBeenCalledWith(`execution:${exec.id}`);
  expect(storage.set).toHaveBeenLastCalledWith("event:e", event);
});

test("Undo removes the skip before anything else, and stops if it cannot", async () => {
  const event = { id: "e", intentId: "i", time: today, archived: false };
  const { actions, offerUndoFor } = archiveSetup(daily, event);
  await actions.updateEvent("e", { archived: true });
  const [exec] = written("execution:");
  storage.delete.mockResolvedValueOnce(false);
  storage.set.mockClear();
  await expect(offerUndoFor.mock.calls[0][1]()).rejects.toThrow(/Removing the skip/);
  expect(storage.delete).toHaveBeenCalledTimes(1);
  expect(storage.delete).toHaveBeenCalledWith(`execution:${exec.id}`);
  expect(storage.set).not.toHaveBeenCalled();
});

test("archiving a one-time date writes no execution", async () => {
  const once = { id: "i", status: "active", recurrenceConfig: { type: "once" } };
  const { actions, offerUndoFor } = archiveSetup(once, { id: "e", intentId: "i", time: today, archived: false });
  await actions.updateEvent("e", { archived: true });
  expect(written("execution:")).toHaveLength(0);
  expect(offerUndoFor.mock.calls[0][0]).toMatch(/^Archived /);
});

test("Skip refuses while an execution is open", async () => {
  mockOpenRows = [{ id: "x" }];
  const { actions } = archiveSetup(daily, { id: "e", intentId: "i", time: today, archived: false });
  await expect(actions.updateEvent("e", { archived: true })).rejects.toThrow(/before skipping/);
  expect(storage.set).not.toHaveBeenCalled();
});

test("a daily run whose event was yesterday makes today's event, not tomorrow's", async () => {
  const yesterday = { id: "e", intentId: "i", time: daysFrom(-1), archived: true };
  const next = await setup(daily, [yesterday]).triggerRecurrence("i", yesterday);
  expect(next.time).toBe(today);
});

test("a date passed in is used as given", async () => {
  const event = { id: "e", intentId: "i", time: today, archived: true };
  const next = await setup(daily, [event]).triggerRecurrence("i", event, { nextDate: daysFrom(5) });
  expect(next.time).toBe(daysFrom(5));
});

test("nothing past the end date", async () => {
  const event = { id: "e", intentId: "i", time: today, archived: true };
  const next = await setup({ ...daily, endDate: today }, [event]).triggerRecurrence("i", event);
  expect(next).toBeNull();
});

test("skipping an interval repeat counts from the skipped date", async () => {
  const interval = { id: "i", status: "active", recurrenceConfig: { type: "interval", every: 3, unit: "days" } };
  const event = { id: "e", intentId: "i", time: daysFrom(-1), archived: true };
  const next = await setup(interval, [event]).triggerRecurrence("i", event, { skipped: true });
  expect(next.time).toBe(daysFrom(2));
});
