import { intentionToRestore, newGroupIntention, useGroupActions } from "./useGroupActions";
import { storage } from "../utils/storage";
import { cancelRemindersForStatus, restoreRemindersAfterStatus } from "../utils/remindersApi";

jest.mock("../utils/storage", () => ({
  storage: { patch: jest.fn(), set: jest.fn(), delete: jest.fn() },
  writeError: (what) => new Error(what),
}));
jest.mock("../utils/remindersApi", () => ({ cancelRemindersForStatus: jest.fn(), restoreRemindersAfterStatus: jest.fn() }));
jest.mock("../notes/notesApi", () => ({ saveNote: jest.fn(), deleteNote: jest.fn(), completionsChanged: jest.fn() }));

const menu = { id: "g", groupTypeId: "menu", name: null, contextId: "c", status: "someday" };
const members = [
  { id: "m1", groupId: "g", memberType: "item", memberId: "rice", position: 1 },
  { id: "m2", groupId: "g", memberType: "item", memberId: "beans", position: 2 },
];
const items = [{ id: "rice", name: "Rice", status: "someday" }, { id: "beans", name: "Beans", status: "active" }];
const restore = jest.fn();

function setup({ intents = [], events = [], groups = [menu] } = {}) {
  let undo = null;
  const watched = [];
  const moveToPlanner = jest.fn();
  const actions = useGroupActions({
    user: { id: "u" },
    itemGroups: groups,
    setItemGroups: jest.fn(),
    groupMembers: members,
    items,
    intents,
    setIntents: jest.fn(),
    events,
    setEvents: jest.fn(),
    withLoading: (_, fn) => fn(),
    offerUndoFor: jest.fn((message, fn) => (undo = { message, restore: fn })),
    watchStatus: (rows) => {
      watched.push(rows);
      return async () => ({ moved: true, restore });
    },
    moveToPlanner,
    refreshReminderIndex: jest.fn(),
  });
  return { actions, undo: () => undo, watched, moveToPlanner };
}

const written = (prefix) => storage.set.mock.calls.filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);

beforeEach(() => {
  jest.clearAllMocks();
  storage.patch.mockImplementation(async (key, fields) => ({ id: key.split(":")[1], ...fields }));
  storage.set.mockImplementation(async (_, v) => v);
  storage.delete.mockResolvedValue(true);
  cancelRemindersForStatus.mockResolvedValue([]);
});

test("the own intention: the group's name at that moment, its context, one-off, linked", () => {
  const row = newGroupIntention(menu, { members, items, intents: [] }, { id: "o", userId: "u" });
  expect(row).toMatchObject({ id: "o", text: "Rice + Beans", groupId: "g", contextId: "c", recurrenceConfig: { type: "once" }, archived: false });
});

test("first Schedule creates the intention and a date with empty item_ids (the database freezes them)", async () => {
  const { actions, undo, watched } = setup();
  await actions.scheduleGroup("g", "2099-01-05");
  const [intent] = written("intent:");
  const [event] = written("event:");
  expect(intent.groupId).toBe("g");
  expect(event).toMatchObject({ intentId: intent.id, time: "2099-01-05", itemIds: [], contextId: "c" });
  // The group and its recipes are watched for the triggers' Someday -> Active.
  expect(watched[0].groups).toEqual([menu]);
  expect(watched[0].items.map((i) => i.id)).toEqual(["rice", "beans"]);
  expect(undo().message).toMatch(/^Scheduled for .*\. Moved to Active\.$/);
});

test("its Undo deletes the date, then the intention it made, then the statuses", async () => {
  const order = [];
  storage.delete.mockImplementation(async (k) => {
    order.push(k.split(":")[0]);
    return true;
  });
  restore.mockImplementation(async () => order.push("status"));
  const { actions, undo } = setup();
  await actions.scheduleGroup("g", "2099-01-05");
  await undo().restore();
  expect(order).toEqual(["event", "intent", "status"]);
});

test("a later Schedule reuses the intention; a live date is moved, not joined", async () => {
  const own = { id: "o", groupId: "g", status: "active", contextId: "c" };
  const fresh = setup({ intents: [own] });
  await fresh.actions.scheduleGroup("g", "2099-01-06");
  expect(written("intent:")).toHaveLength(0);
  expect(written("event:")[0].intentId).toBe("o");

  const moving = setup({ intents: [own], events: [{ id: "e", intentId: "o", time: "2099-01-01", archived: false }] });
  await moving.actions.scheduleGroup("g", "2099-01-07");
  expect(moving.moveToPlanner).toHaveBeenCalledWith("o", "2099-01-07");
});

test("status: the own intention follows; Background with the sheet's yes archives its date and reminders; Undo restores all", async () => {
  const group = { ...menu, status: "active" };
  const own = { id: "o", groupId: "g", status: "active" };
  const live = { id: "e", intentId: "o", time: "2099-01-01", archived: false };
  cancelRemindersForStatus.mockResolvedValue([{ id: "r" }]);
  const { actions, undo } = setup({ groups: [group], intents: [own], events: [live] });
  await actions.setGroupStatus("g", "background", { archiveEvents: true });
  expect(storage.patch).toHaveBeenCalledWith("group:g", { status: "background", closedReason: null });
  expect(storage.patch).toHaveBeenCalledWith("intent:o", { status: "background", closedReason: null });
  expect(written("event:")[0]).toMatchObject({ id: "e", archived: true });
  expect(undo().message).toBe("Moved to Background and archived 1 event and cancelled 1 reminder.");
  storage.patch.mockClear();
  await undo().restore();
  expect(storage.patch).toHaveBeenCalledWith("group:g", { status: "active", closedReason: null });
  expect(storage.patch).toHaveBeenCalledWith("intent:o", { status: "active", closedReason: null });
  expect(storage.set).toHaveBeenLastCalledWith("event:e", live);
  expect(restoreRemindersAfterStatus).toHaveBeenCalledWith([{ id: "r" }]);
});

test("reopening a closed group clears its reason and its intention's (bug: P5 Test Project kept wont_do)", async () => {
  const group = { ...menu, status: "closed", closedReason: "wont_do" };
  const own = { id: "o", groupId: "g", status: "closed", closedReason: "wont_do" };
  const { actions } = setup({ groups: [group], intents: [own] });
  await actions.setGroupStatus("g", "active");
  expect(storage.patch).toHaveBeenCalledWith("group:g", { status: "active", closedReason: null });
  expect(storage.patch).toHaveBeenCalledWith("intent:o", { status: "active", closedReason: null });
});

test("archive takes the own intention and its live date; Undo brings all three back", async () => {
  const own = { id: "o", groupId: "g", status: "active" };
  const live = { id: "e", intentId: "o", time: "2099-01-01", archived: false };
  const then = jest.fn();
  const { actions, undo } = setup({ intents: [own], events: [live] });
  await actions.archiveGroup("g", then);
  expect(storage.patch).toHaveBeenCalledWith("group:g", { archived: true });
  expect(storage.patch).toHaveBeenCalledWith("intent:o", { archived: true });
  expect(written("event:")[0]).toMatchObject({ archived: true });
  expect(then).toHaveBeenCalled();
  storage.patch.mockClear();
  await undo().restore();
  expect(storage.patch.mock.calls).toEqual([["group:g", { archived: false }], ["intent:o", { archived: false }]]);
  expect(storage.set).toHaveBeenLastCalledWith("event:e", live);
});

test("restore brings back the newest archived own intention, none when one is live", async () => {
  const old = { id: "old", groupId: "g", archived: true, archivedAt: "2026-10-01T00:00:00Z" };
  const last = { id: "last", groupId: "g", archived: true, archivedAt: "2026-10-20T00:00:00Z" };
  expect(intentionToRestore("g", [old, last])?.id).toBe("last");
  expect(intentionToRestore("g", [last, { id: "live", groupId: "g", archived: false }])).toBeNull();
  const { actions } = setup({ intents: [old, last] });
  await actions.unarchiveGroup("g");
  expect(storage.patch.mock.calls).toEqual([["group:g", { archived: false }], ["intent:last", { archived: false }]]);
});
