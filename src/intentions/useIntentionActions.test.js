import { useIntentionActions } from "./useIntentionActions";
import { storage } from "../utils/storage";
import { cancelRemindersForStatus, restoreRemindersAfterStatus } from "../utils/remindersApi";
import { getTodayDate } from "../utils/eventDates";
import { saveNote, deleteNote, completionsChanged } from "../notes/notesApi";

jest.mock("../utils/storage", () => ({
  storage: { patch: jest.fn(), set: jest.fn(), get: jest.fn(), delete: jest.fn() },
  writeError: (what) => new Error(what),
}));
jest.mock("../notes/notesApi", () => ({ saveNote: jest.fn(), deleteNote: jest.fn(), completionsChanged: jest.fn() }));
jest.mock("../utils/remindersApi", () => ({
  cancelRemindersForStatus: jest.fn(),
  restoreRemindersAfterStatus: jest.fn(),
}));

const today = getTodayDate();
const DAILY = { type: "fixed", frequency: "daily", interval: 1 };

function setup({ intents, items = [], events = [] }) {
  let undo = null;
  const actions = useIntentionActions({
    user: { id: "u" },
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
  storage.get.mockResolvedValue(null);
  storage.delete.mockResolvedValue(true);
  saveNote.mockImplementation(async (n) => ({ id: "note1", ...n }));
});

describe("closeRecords: close reason", () => {
  const rec = { id: "rec", status: "active", recurrenceConfig: DAILY, endDate: null, contextId: "c" };
  const executionsWritten = () => storage.set.mock.calls.filter(([k]) => k.startsWith("execution:")).map(([, v]) => v);

  it("Completed with none done yet: a done execution on the live date, dated Closed on, carrying the note; no next event", async () => {
    const live = { id: "e", intentId: "rec", time: "2026-10-10", archived: false, itemIds: [] };
    const { actions } = setup({ intents: [rec], events: [live] });
    await actions.closeRecords({ intentIds: ["rec"], label: "Run", reason: "done", note: "finally", closedOn: "2026-10-10", pickedIntentId: "rec" });
    const [exec] = executionsWritten();
    expect(exec).toMatchObject({ eventId: "e", intentId: "rec", status: "closed", outcome: "done" });
    expect(exec.closedAt).toBe(new Date(2026, 9, 10, 12, 0).toISOString());
    expect(saveNote).toHaveBeenCalledWith(expect.objectContaining({ body: "finally", executionId: exec.id }));
    // Only the live event, archived: nothing new is scheduled.
    expect(storage.set.mock.calls.filter(([k]) => k.startsWith("event:")).map(([k]) => k)).toEqual(["event:e"]);
    expect(completionsChanged).toHaveBeenCalled();
  });

  it("Completed with no live date: a new archived event on Closed on carries it", async () => {
    const { actions } = setup({ intents: [rec] });
    await actions.closeRecords({ intentIds: ["rec"], label: "Run", reason: "done", closedOn: "2026-10-09", pickedIntentId: "rec" });
    const event = storage.set.mock.calls.find(([k]) => k.startsWith("event:"))[1];
    expect(event).toMatchObject({ intentId: "rec", time: "2026-10-09", archived: true });
    expect(executionsWritten()[0].eventId).toBe(event.id);
  });

  it("Completed when one is done already, or Won't do: a standalone note, no execution", async () => {
    const item = { id: "fan", status: "active" };
    for (const [intent, reason] of [[{ ...rec, lastCompletedAt: "2026-10-01T12:00:00Z" }, "done"], [rec, "wont_do"]]) {
      jest.clearAllMocks();
      saveNote.mockImplementation(async (n) => ({ id: "note1", ...n }));
      const { actions } = setup({ intents: [intent], items: [item] });
      await actions.closeRecords({ item, intentIds: ["rec"], label: "Fan", reason, note: "why", pickedIntentId: "rec" });
      expect(executionsWritten()).toHaveLength(0);
      expect(saveNote).toHaveBeenCalledWith({ body: "why", targetType: "item", targetId: "fan" });
    }
  });

  it("an item with no intention: Completed saves only a note on the item, never invents an intention", async () => {
    const item = { id: "fan", status: "active" };
    const { actions } = setup({ intents: [], items: [item] });
    await actions.closeRecords({ item, intentIds: [], label: "Fan", reason: "done", note: "done", pickedIntentId: null });
    expect(executionsWritten()).toHaveLength(0);
    expect(storage.set.mock.calls.some(([k]) => k.startsWith("intent:"))).toBe(false);
    expect(saveNote).toHaveBeenCalledWith({ body: "done", targetType: "item", targetId: "fan" });
  });

  it("Undo deletes what the close made first, and stops at a failed delete", async () => {
    const { actions, undo } = setup({ intents: [rec] });
    await actions.closeRecords({ intentIds: ["rec"], label: "Run", reason: "done", pickedIntentId: "rec" });
    const [exec] = executionsWritten();
    storage.patch.mockClear();
    storage.delete.mockResolvedValueOnce(false);
    await expect(undo().restore()).rejects.toThrow(/Removing the completion/);
    expect(storage.delete).toHaveBeenCalledWith(`execution:${exec.id}`);
    expect(storage.patch).not.toHaveBeenCalled();
  });

  it("Undo of a Won't do note deletes the note, then restores the status", async () => {
    const { actions, undo } = setup({ intents: [rec] });
    await actions.closeRecords({ intentIds: ["rec"], label: "Run", reason: "wont_do", note: "no", pickedIntentId: "rec" });
    await undo().restore();
    expect(deleteNote).toHaveBeenCalledWith("note1");
    expect(storage.patch).toHaveBeenLastCalledWith("intent:rec", { status: "active", endDate: null });
  });
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
