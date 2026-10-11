import { useInboxActions } from "./useInboxActions";
import { storage } from "../utils/storage";

jest.mock("../utils/storage", () => ({ storage: { set: jest.fn() } }));
jest.mock("../utils/remindersApi", () => ({
  moveRemindersToIntention: jest.fn().mockResolvedValue(undefined),
  cancelRemindersForDiscard: jest.fn().mockResolvedValue(undefined),
  restoreRemindersAfterDiscard: jest.fn().mockResolvedValue(undefined),
}));

const INBOX = { id: "inbox-1", capturedText: "Apply to Acme", sourceType: "manual", sourceApp: null, outcome: [] };

function actions(row = INBOX) {
  const setAllInboxItems = jest.fn();
  const a = useInboxActions({
    user: { id: "u1" },
    inboxItems: [row],
    allInboxItems: [row],
    setAllInboxItems,
    contexts: [],
    items: [],
    setItems: jest.fn(),
    intents: [],
    setIntents: jest.fn(),
    events: [],
    setEvents: jest.fn(),
    refreshReminderIndex: jest.fn(),
    addItemsToCollection: jest.fn(),
    withLoading: (_label, fn) => fn(),
    offerUndoFor: jest.fn(),
    watchStatus: () => async () => {},
  });
  return a;
}

/** The value written to the inbox row, from storage.set's calls. */
const inboxWrite = () => storage.set.mock.calls.find(([key]) => key.startsWith("inbox:"))[1];

const ITEM = { createItem: true, itemData: { name: "Acme", elements: [], tags: [] }, createIntention: false };
const INTENT = { createItem: false, createIntention: true, intentionData: { text: "Apply", tags: [] } };
const BOTH = { ...ITEM, createIntention: true, intentionData: { text: "Apply", tags: [] } };

beforeEach(() => {
  storage.set.mockReset();
  storage.set.mockImplementation(async (_key, value) => value);
  jest.spyOn(window, "alert").mockImplementation(() => {});
});

describe("handleInboxSave outcome and app", () => {
  it("records an item", async () => {
    await actions().handleInboxSave("inbox-1", ITEM);
    const row = inboxWrite();
    expect(row.archiveReason).toBe("processed");
    expect(row.outcome).toEqual([{ table: "items", id: expect.any(String) }]);
  });

  it("records an intention", async () => {
    await actions().handleInboxSave("inbox-1", INTENT);
    expect(inboxWrite().outcome).toEqual([{ table: "intents", id: expect.any(String) }]);
  });

  it("records both, item first", async () => {
    await actions().handleInboxSave("inbox-1", BOTH);
    expect(inboxWrite().outcome.map((o) => o.table)).toEqual(["items", "intents"]);
  });

  it("records an event", async () => {
    const withEvent = { ...INTENT, intentionData: { ...INTENT.intentionData, createEvent: true, eventDate: "2026-10-20" } };
    await actions().handleInboxSave("inbox-1", withEvent);
    expect(inboxWrite().outcome.map((o) => o.table)).toEqual(["intents", "events"]);
  });

  it("archives with [] when nothing is created", async () => {
    await actions().handleInboxSave("inbox-1", { createItem: false, createIntention: false });
    expect(inboxWrite().outcome).toEqual([]);
  });

  it("saves the picked app", async () => {
    await actions().handleInboxSave("inbox-1", ITEM, { sourceApp: "jobs" });
    expect(inboxWrite().sourceApp).toBe("jobs");
  });

  it("clears the app for No app", async () => {
    await actions({ ...INBOX, sourceApp: "jobs" }).handleInboxSave("inbox-1", ITEM, { sourceApp: null });
    expect(inboxWrite().sourceApp).toBeNull();
  });

  it("keeps the app on one tap", async () => {
    await actions({ ...INBOX, sourceApp: "jobs" }).handleInboxSave("inbox-1", ITEM);
    expect(inboxWrite().sourceApp).toBe("jobs");
  });

  it("does not archive when a record fails", async () => {
    storage.set.mockImplementation(async (key, value) => (key.startsWith("item:") ? false : value));
    await actions().handleInboxSave("inbox-1", ITEM);
    expect(storage.set.mock.calls.some(([key]) => key.startsWith("inbox:"))).toBe(false);
  });
});

describe("discardInboxItem", () => {
  it("keeps the app and writes no outcome", async () => {
    await actions({ ...INBOX, sourceApp: "jobs" }).discardInboxItem("inbox-1");
    const row = inboxWrite();
    expect(row.archiveReason).toBe("discarded");
    expect(row.sourceApp).toBe("jobs");
    expect(row.outcome).toEqual([]);
  });
});
