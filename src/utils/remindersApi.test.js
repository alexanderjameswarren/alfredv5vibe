// remindersApi: the filters each write sends, against a recording PostgREST mock.

jest.mock("../supabaseClient", () => {
  const log = [];
  const next = { data: [{ id: "r1" }], error: null };
  const chain = (entry) => {
    const c = {};
    for (const k of ["select", "eq", "in", "gt", "order", "update"]) {
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

it("detail read: scheduled and sent for one intention, cancelled never asked for", async () => {
  mock.__next.data = [
    { id: "s2", state: "scheduled", due_at: "2026-10-02T00:00:00Z" },
    { id: "s1", state: "scheduled", due_at: "2026-10-01T00:00:00Z" },
    { id: "x1", state: "sent", due_at: "2026-09-29T00:00:00Z", sent_at: "2026-09-29T00:00:10Z" },
  ];
  const s = await api.getReminderSummary({ intentId: "int1" });
  expect(calls("in")).toEqual([["in", "state", ["scheduled", "sent"]]]);
  expect(calls("eq")).toEqual([["eq", "intent_id", "int1"]]);
  expect(s.scheduled.map((r) => r.id)).toEqual(["s1", "s2"]);
  expect(s.lastSent.id).toBe("x1");
  expect(await api.getReminderSummary({})).toEqual({ scheduled: [], lastSent: null });
  mock.__next.data = [{ id: "r1" }];
});

it("throws on a database error", async () => {
  mock.__next.error = { message: "boom" };
  await expect(api.cancelRemindersForDiscard("in1")).rejects.toThrow(/boom/);
});

it("list index: one read; soonest scheduled wins, else latest sent", async () => {
  await api.getListReminders();
  expect(calls("in")).toEqual([["in", "state", ["scheduled", "sent"]]]);
  const idx = api.indexReminders([
    { inbox_id: "in1", state: "sent", due_at: "2026-09-29T01:00:00Z", sent_at: "2026-09-29T01:00:05Z" },
    { inbox_id: "in1", state: "scheduled", due_at: "2026-10-02T00:00:00Z" },
    { inbox_id: "in1", state: "scheduled", due_at: "2026-10-01T00:00:00Z" },
    { intent_id: "int1", state: "sent", due_at: "2026-09-20T00:00:00Z", sent_at: "2026-09-20T00:00:05Z" },
    { intent_id: "int1", state: "sent", due_at: "2026-09-28T00:00:00Z", sent_at: "2026-09-28T00:00:05Z" },
  ]);
  expect(idx).toEqual({
    byInbox: { in1: { kind: "scheduled", at: "2026-10-01T00:00:00Z" } },
    byIntent: { int1: { kind: "sent", at: "2026-09-28T00:00:05Z" } },
  });
});

it("card badge: scheduled plain, sent muted with today / weekday / date", () => {
  const now = new Date("2026-09-30T20:00:00Z"); // Wed 1:00 PM PT
  expect(api.reminderBadge({ kind: "scheduled", at: "2026-10-01T14:17:00Z" }, now))
    .toEqual({ text: "Thu 7:17 AM", muted: false });
  expect(api.reminderBadge({ kind: "sent", at: "2026-09-30T14:36:00Z" }, now))
    .toEqual({ text: "Sent 7:36 AM", muted: true });
  expect(api.reminderBadge({ kind: "sent", at: "2026-09-28T14:36:00Z" }, now).text).toBe("Sent Mon 7:36 AM");
  expect(api.reminderBadge({ kind: "sent", at: "2026-09-20T14:36:00Z" }, now).text).toBe("Sent Sep 20");
  expect(api.reminderBadge(null, now)).toBeNull();
});

it("short label: time today, weekday otherwise, both Pacific", () => {
  const now = new Date("2026-09-30T20:00:00Z"); // Wed 1:00 PM PT
  expect(api.formatReminderShort("2026-09-30T14:17:00Z", now)).toBe("7:17 AM");
  expect(api.formatReminderShort("2026-10-01T14:17:00Z", now)).toBe("Thu 7:17 AM");
  // 06:00Z Oct 1 is still Sep 30 in Pacific.
  expect(api.formatReminderShort("2026-10-01T06:00:00Z", now)).toBe("11:00 PM");
});

it("an item's reminder is its source capture's", () => {
  const idx = api.indexReminders([{ inbox_id: "in1", state: "scheduled", due_at: "A" }]);
  expect(api.itemReminder({ id: "it1", sourceInboxId: "in1" }, idx)).toEqual({ kind: "scheduled", at: "A" });
  expect(api.itemReminder({ id: "it2", sourceInboxId: "in9" }, idx)).toBeNull();
  expect(api.itemReminder({ id: "it3" }, idx)).toBeNull();
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
