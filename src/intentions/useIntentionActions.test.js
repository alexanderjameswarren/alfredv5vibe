import { useIntentionActions } from "./useIntentionActions";
import { storage } from "../utils/storage";
import { cancelRemindersForStatus, restoreRemindersAfterStatus } from "../utils/remindersApi";
import { getTodayDate } from "../utils/eventDates";

jest.mock("../utils/storage", () => ({
  storage: { patch: jest.fn(), set: jest.fn() },
  writeError: (what) => new Error(what),
}));
jest.mock("../utils/remindersApi", () => ({
  cancelRemindersForStatus: jest.fn(),
  restoreRemindersAfterStatus: jest.fn(),
}));

const today = getTodayDate();
const DAILY = { type: "fixed", frequency: "daily", interval: 1 };

function setup({ intents, items = [], events = [] }) {
  let undo = null;
  const actions = useIntentionActions({
    intents,
    setIntents: jest.fn(),
    items,
    setItems: jest.fn(),
    events,
    setEvents: jest.fn(),
    withLoading: (_, fn) => fn(),
    offerUndoFor: jest.fn((message, restore) => (undo = { message, restore })),
    refreshReminderIndex: jest.fn(),
  });
  return { actions, undo: () => undo };
}

beforeEach(() => {
  jest.clearAllMocks();
  storage.patch.mockImplementation(async (key, fields) => ({ id: key.split(":")[1], ...fields }));
  storage.set.mockImplementation(async (_, v) => v);
  cancelRemindersForStatus.mockResolvedValue([]);
  restoreRemindersAfterStatus.mockResolvedValue([]);
});

describe("closeRecords", () => {
  it("closes the item and intentions, and stops a recurring one today", async () => {
    const item = { id: "fan", status: "active" };
    const { actions } = setup({
      items: [item],
      intents: [
        { id: "rec", status: "active", recurrenceConfig: DAILY, endDate: null },
        { id: "one", status: "someday", recurrenceConfig: { type: "once" } },
      ],
    });
    await actions.closeRecords({ item, intentIds: ["rec", "one"], label: "Fan" });
    expect(storage.patch).toHaveBeenCalledWith("intent:rec", { status: "closed", endDate: today });
    expect(storage.patch).toHaveBeenCalledWith("intent:one", { status: "closed" });
    expect(storage.patch).toHaveBeenCalledWith("item:fan", { status: "closed" });
  });

  it("archives live events, cancels reminders, and says so", async () => {
    cancelRemindersForStatus.mockResolvedValue(["r1"]);
    const { actions, undo } = setup({
      intents: [{ id: "a", status: "active" }],
      events: [{ id: "e", intentId: "a", time: today, archived: false }],
    });
    await actions.closeRecords({ intentIds: ["a"], label: "Call" });
    expect(storage.set).toHaveBeenCalledWith("event:e", expect.objectContaining({ archived: true }));
    expect(undo().message).toBe('Closed "Call" and archived 1 event and cancelled 1 reminder.');
  });

  it("Undo restores status, end date, future events and reminders; not someday or past dates", async () => {
    cancelRemindersForStatus.mockResolvedValue(["r1"]);
    const item = { id: "fan", status: "someday" };
    const { actions, undo } = setup({
      items: [item],
      intents: [{ id: "rec", status: "active", recurrenceConfig: DAILY, endDate: "2099-01-01" }],
      events: [
        { id: "future", intentId: "rec", time: "2099-01-01", archived: false },
        { id: "past", intentId: "rec", time: "2000-01-01", archived: false },
      ],
    });
    await actions.closeRecords({ item, intentIds: ["rec"], label: "Fan" });
    storage.patch.mockClear();
    storage.set.mockClear();
    await undo().restore();
    expect(storage.patch).toHaveBeenCalledWith("intent:rec", { status: "active", endDate: "2099-01-01" });
    expect(storage.patch).not.toHaveBeenCalledWith("item:fan", expect.anything());
    expect(storage.set).toHaveBeenCalledWith("event:future", expect.objectContaining({ archived: false }));
    expect(storage.set).not.toHaveBeenCalledWith("event:past", expect.anything());
    expect(restoreRemindersAfterStatus).toHaveBeenCalledWith(["r1"]);
  });

  it("offers no Undo when everything was someday and nothing was pending", async () => {
    const { actions, undo } = setup({ intents: [{ id: "a", status: "someday", recurrenceConfig: { type: "once" } }] });
    await actions.closeRecords({ intentIds: ["a"], label: "Idea" });
    expect(undo()).toEqual({ message: 'Closed "Idea".', restore: null });
  });
});
