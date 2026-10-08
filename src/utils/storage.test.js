// storage: status never rides on a whole-record UPDATE; patch sends only what it is given.

jest.mock("../supabaseClient", () => {
  const log = [];
  const state = { updateRows: [{ id: "x" }] };
  const chain = (entry) => {
    const c = {};
    for (const k of ["select", "eq", "update", "insert", "maybeSingle"]) {
      c[k] = (...args) => {
        entry.push([k, ...args]);
        return c;
      };
    }
    c.then = (res) => {
      const isUpdate = entry.some((e) => e[0] === "update");
      const single = entry.some((e) => e[0] === "maybeSingle");
      const rows = isUpdate ? state.updateRows : [{ id: "x" }];
      return res({ data: single ? rows[0] || null : rows, error: null });
    };
    return c;
  };
  return {
    __log: log,
    __state: state,
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
const { storage, withoutStatus, writeError } = require("./storage");

const sent = (entry, k) => entry.find((c) => c[0] === k)?.[1];

beforeEach(() => {
  mock.__log.length = 0;
  mock.__state.updateRows = [{ id: "x" }];
});

test("withoutStatus strips only on items and intents", () => {
  const row = { id: "a", status: "someday", status_changed_at: "t", name: "n" };
  expect(withoutStatus("items", row)).toEqual({ id: "a", name: "n" });
  expect(withoutStatus("intents", row)).toEqual({ id: "a", name: "n" });
  expect(withoutStatus("events", row)).toBe(row);
});

test("set on an existing intent does not send status", async () => {
  await storage.set("intent:x", { id: "x", text: "t", status: "someday", statusChangedAt: "t" });
  const update = sent(mock.__log[0], "update");
  expect(update).toEqual({ id: "x", text: "t" });
});

test("set that falls through to INSERT keeps status", async () => {
  mock.__state.updateRows = [];
  await storage.set("item:x", { id: "x", name: "n", status: "active" });
  const insert = sent(mock.__log[1], "insert");
  expect(insert).toEqual({ id: "x", name: "n", status: "active" });
});

test("writeError names the one-live-event rule for that violation only", () => {
  storage.lastError = { code: "23505", message: 'duplicate key value violates unique constraint "events_one_live_per_intent"' };
  expect(writeError("Scheduling").message).toBe(
    "Scheduling: this intention already has a live event. Reschedule or archive it first.",
  );
  storage.lastError = { code: "23505", message: 'duplicate key value violates unique constraint "executions_one_open_per_intent"' };
  expect(writeError("Starting").message).toBe(
    "Starting: this intention already has an open execution. Continue or finish it first.",
  );
  storage.lastError = { code: "42501", message: "permission denied" };
  expect(writeError("Scheduling").message).toBe("Scheduling was not saved.");
  storage.lastError = null;
});

test("patch sends only the given fields", async () => {
  await storage.patch("intent:x", { status: "background" });
  expect(sent(mock.__log[0], "update")).toEqual({ status: "background" });
  expect(mock.__log[0]).toContainEqual(["eq", "id", "x"]);
});
