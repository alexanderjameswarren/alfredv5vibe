// remindersApi: the filters each write sends, against a recording PostgREST mock.

jest.mock("../supabaseClient", () => {
  const log = [];
  const next = { data: [{ id: "r1" }], error: null };
  const chain = (entry) => {
    const c = {};
    for (const k of ["select", "eq", "gt", "order", "update"]) {
      c[k] = (...args) => {
        entry.push([k, ...args]);
        return c;
      };
    }
    c.then = (res) => res(next);
    return c;
  };
  return {
    __log: log,
    __next: next,
    supabase: {
      from: (table) => {
        const entry = [["from", table]];
        log.push(entry);
        return chain(entry);
      },
    },
  };
});

const mock = require("../supabaseClient");
const api = require("./remindersApi");

const last = () => mock.__log[mock.__log.length - 1];
const calls = (k) => last().filter((c) => c[0] === k);

beforeEach(() => {
  mock.__log.length = 0;
  mock.__next.error = null;
});

it("moves every reminder on the capture to the intention", async () => {
  await api.moveRemindersToIntention("in1", "int1");
  expect(calls("update")).toEqual([["update", { intent_id: "int1", inbox_id: null }]]);
  expect(calls("eq")).toEqual([["eq", "inbox_id", "in1"]]);
});

it("discard cancels only scheduled ones, as inbox_discarded", async () => {
  await api.cancelRemindersForDiscard("in1");
  expect(calls("update")[0][1]).toEqual({ state: "cancelled", cancel_reason: "inbox_discarded" });
  expect(calls("eq")).toEqual([["eq", "inbox_id", "in1"], ["eq", "state", "scheduled"]]);
});

it("restore re-arms only discard-cancelled reminders still in the future", async () => {
  const now = new Date("2026-09-30T12:00:00Z");
  await api.restoreRemindersAfterDiscard("in1", now);
  expect(calls("update")[0][1]).toEqual({ state: "scheduled", cancel_reason: null });
  expect(calls("eq")).toEqual([
    ["eq", "inbox_id", "in1"],
    ["eq", "state", "cancelled"],
    ["eq", "cancel_reason", "inbox_discarded"],
  ]);
  expect(calls("gt")).toEqual([["gt", "due_at", "2026-09-30T12:00:00.000Z"]]);
});

it("reads scheduled reminders for an intention, soonest first", async () => {
  await api.getPendingReminders({ intentId: "int1" });
  expect(calls("eq")).toEqual([["eq", "state", "scheduled"], ["eq", "intent_id", "int1"]]);
  expect(calls("order")).toEqual([["order", "due_at", { ascending: true }]]);
  expect(await api.getPendingReminders({})).toEqual([]);
});

it("throws on a database error", async () => {
  mock.__next.error = { message: "boom" };
  await expect(api.cancelRemindersForDiscard("in1")).rejects.toThrow(/boom/);
});

it("indexes the soonest reminder per inbox row and intention, from one scheduled read", async () => {
  await api.getScheduledReminders();
  expect(calls("eq")).toEqual([["eq", "state", "scheduled"]]);
  const idx = api.indexReminders([
    { inbox_id: "in1", intent_id: null, due_at: "A" },
    { inbox_id: "in1", intent_id: null, due_at: "B" },
    { inbox_id: null, intent_id: "int1", due_at: "C" },
  ]);
  expect(idx).toEqual({ byInbox: { in1: "A" }, byIntent: { int1: "C" } });
});

it("short label: time today, weekday otherwise, both Pacific", () => {
  const now = new Date("2026-09-30T20:00:00Z"); // Wed 1:00 PM PT
  expect(api.formatReminderShort("2026-09-30T14:17:00Z", now)).toBe("7:17 AM");
  expect(api.formatReminderShort("2026-10-01T14:17:00Z", now)).toBe("Thu 7:17 AM");
  // 06:00Z Oct 1 is still Sep 30 in Pacific.
  expect(api.formatReminderShort("2026-10-01T06:00:00Z", now)).toBe("11:00 PM");
});

it("an item's reminder is its source capture's", () => {
  const idx = api.indexReminders([{ inbox_id: "in1", intent_id: null, due_at: "A" }]);
  expect(api.itemReminderDueAt({ id: "it1", sourceInboxId: "in1" }, idx)).toBe("A");
  expect(api.itemReminderDueAt({ id: "it2", sourceInboxId: "in9" }, idx)).toBeNull();
  expect(api.itemReminderDueAt({ id: "it3" }, idx)).toBeNull();
});

it("archived capture tap: item, else intention (direct or via event), else null", () => {
  const items = [{ id: "it1", sourceInboxId: "in1" }];
  const intents = [{ id: "int2", sourceInboxId: "in2" }];
  const events = [{ id: "ev3", sourceInboxId: "in3", intentId: "int3" }];
  const all = { items, intents, events };
  expect(api.archivedCaptureTarget("in1", all)).toEqual({ kind: "item", id: "it1" });
  expect(api.archivedCaptureTarget("in2", all)).toEqual({ kind: "intention", id: "int2" });
  expect(api.archivedCaptureTarget("in3", all)).toEqual({ kind: "intention", id: "int3" });
  expect(api.archivedCaptureTarget("in4", all)).toBeNull();
});

it("formats in Pacific time with daylight saving", () => {
  expect(api.formatPacific("2026-10-01T16:00:00Z")).toBe("Thu, Oct 1, 9:00 AM PT");
  expect(api.formatPacific("2026-12-01T17:30:00Z")).toBe("Tue, Dec 1, 9:30 AM PT");
});
