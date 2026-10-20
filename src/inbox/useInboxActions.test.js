import { useInboxActions, processInboxPayload, processFailedMessage } from "./useInboxActions";
import { storage } from "../utils/storage";
import { supabase } from "../supabaseClient";

jest.mock("../supabaseClient", () => ({ supabase: { rpc: jest.fn() } }));
jest.mock("../utils/storage", () => ({ storage: { set: jest.fn() } }));
jest.mock("../utils/remindersApi", () => ({
  cancelRemindersForDiscard: jest.fn().mockResolvedValue(undefined),
  restoreRemindersAfterDiscard: jest.fn().mockResolvedValue(undefined),
}));

const INBOX = { id: "inbox-1", capturedText: "Apply to Acme", sourceType: "manual", sourceApp: null, outcome: [] };

function setup(row = INBOX) {
  const settle = jest.fn().mockResolvedValue({ moved: false });
  const deps = {
    user: { id: "u1" },
    inboxItems: [row],
    allInboxItems: [row],
    setAllInboxItems: jest.fn(),
    items: [],
    setItems: jest.fn(),
    intents: [],
    setIntents: jest.fn(),
    events: [],
    setEvents: jest.fn(),
    refreshReminderIndex: jest.fn(),
    withLoading: (_label, fn) => fn(),
    offerUndoFor: jest.fn(),
    watchStatus: jest.fn(() => settle),
  };
  return { a: useInboxActions(deps), deps, settle };
}

/** The inbox row written by discard, from storage.set's calls. */
const inboxWrite = () => storage.set.mock.calls.find(([key]) => key.startsWith("inbox:"))[1];
/** What a state setter's updater makes of an empty list (or of `prev`). */
const applied = (setter, prev = []) => setter.mock.calls[0][0](prev);

const ITEM = { createItem: true, itemData: { name: "Acme", elements: [], tags: [] }, createIntention: false };
const INTENT = { createItem: false, createIntention: true, intentionData: { text: "Apply", tags: [] } };
const BOTH = { ...ITEM, createIntention: true, intentionData: { text: "Apply", tags: [] } };
const WITH_EVENT = { ...INTENT, intentionData: { ...INTENT.intentionData, createEvent: true, eventDate: "2026-10-20" } };

const SAVED = {
  inbox: { ...INBOX, archived: true, archive_reason: "processed", outcome: [{ table: "items", id: "i1" }] },
  item: { id: "i1", name: "Acme", status: "someday" },
  intent: null,
  event: null,
  collection_item: null,
  reminders_moved: 0,
  outcome: [{ table: "items", id: "i1" }],
};

beforeEach(() => {
  supabase.rpc.mockReset();
  supabase.rpc.mockResolvedValue({ data: SAVED, error: null });
  storage.set.mockReset();
  storage.set.mockImplementation(async (_key, value) => value);
  jest.spyOn(window, "alert").mockImplementation(() => {});
});

describe("processInboxPayload", () => {
  it("links the intention to the new item", () => {
    const p = processInboxPayload(BOTH);
    expect(p.item.name).toBe("Acme");
    expect(p.intent.item_id).toBe(p.item.id);
  });

  it("adds an event only with a date", () => {
    expect(processInboxPayload(INTENT).event).toBeUndefined();
    expect(processInboxPayload(WITH_EVENT).event.time).toBe("2026-10-20");
  });

  it("is empty when nothing is created", () => {
    expect(processInboxPayload({ createItem: false, createIntention: false })).toEqual({});
  });

  it("sends the picked app, null for No app, nothing on one tap", () => {
    expect(processInboxPayload(ITEM, { sourceApp: "jobs" }).source_app).toBe("jobs");
    expect(processInboxPayload(ITEM, { sourceApp: "" }).source_app).toBeNull();
    expect("source_app" in processInboxPayload(ITEM)).toBe(false);
  });
});

describe("handleInboxSave", () => {
  it("makes one call and no separate writes", async () => {
    const { a } = setup();
    await a.handleInboxSave("inbox-1", BOTH, { sourceApp: "jobs" });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = supabase.rpc.mock.calls[0];
    expect(fn).toBe("process_inbox_item");
    expect(args.p_inbox_id).toBe("inbox-1");
    expect(args.p_payload.source_app).toBe("jobs");
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("updates the screen from the returned rows on success, with no Undo", async () => {
    const { a, deps } = setup();
    await a.handleInboxSave("inbox-1", ITEM);
    expect(applied(deps.setItems)).toEqual([SAVED.item]);
    expect(applied(deps.setAllInboxItems, [INBOX])[0]).toMatchObject({ archived: true, archiveReason: "processed" });
    expect(deps.setIntents).not.toHaveBeenCalled();
    expect(deps.refreshReminderIndex).toHaveBeenCalled();
    expect(deps.offerUndoFor).not.toHaveBeenCalled();
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("watches status when an event was created", async () => {
    const intent = { id: "t1", text: "Apply", item_id: null, status: "someday" };
    supabase.rpc.mockResolvedValue({ data: { ...SAVED, item: null, intent, event: { id: "e1" } }, error: null });
    const { a, deps, settle } = setup();
    await a.handleInboxSave("inbox-1", WITH_EVENT);
    expect(deps.watchStatus).toHaveBeenCalledWith({ intents: [{ id: "t1", text: "Apply", itemId: null, status: "someday" }], items: [] });
    expect(settle).toHaveBeenCalled();
  });

  it("changes nothing and shows an error when the call fails", async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { code: "22007", message: "invalid date" } });
    const { a, deps } = setup();
    await a.handleInboxSave("inbox-1", WITH_EVENT);
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining("Nothing was saved"));
    for (const set of [deps.setItems, deps.setIntents, deps.setEvents, deps.setAllInboxItems]) {
      expect(set).not.toHaveBeenCalled();
    }
    expect(deps.offerUndoFor).not.toHaveBeenCalled();
  });

  it("refuses a second Process of a filed capture", async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { code: "55000", message: "already archived" } });
    const { a, deps } = setup();
    await a.handleInboxSave("inbox-1", ITEM);
    expect(window.alert).toHaveBeenCalledWith("That capture has already been filed. Nothing was changed.");
    expect(deps.setAllInboxItems).not.toHaveBeenCalled();
  });
});

describe("processFailedMessage", () => {
  it("includes the database's reason", () => {
    expect(processFailedMessage({ message: "boom" })).toMatch(/still in your inbox\.\n\nboom$/);
  });
});

describe("discardInboxItem", () => {
  it("keeps the app and writes no outcome", async () => {
    const { a } = setup({ ...INBOX, sourceApp: "jobs" });
    await a.discardInboxItem("inbox-1");
    const row = inboxWrite();
    expect(row.archiveReason).toBe("discarded");
    expect(row.sourceApp).toBe("jobs");
    expect(row.outcome).toEqual([]);
  });
});
