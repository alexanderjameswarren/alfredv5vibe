import { recordDestination, RECORD_SCREENS } from "./recordRoutes";

const res = (table, row) => ({ table, row: { id: "r1", ...row }, match_count: 1 });
const GENERIC = { kind: "generic" };

// Loaded state: ids listed are present; inbox rows keyed by id.
function makeLookup({ inbox = {}, items = [], intents = [], contexts = [], collections = [], targets = {} } = {}) {
  return {
    inbox: (id) => inbox[id] || null,
    item: (id) => items.includes(id),
    intention: (id) => intents.includes(id),
    context: (id) => contexts.includes(id),
    collection: (id) => collections.includes(id),
    archivedTarget: (id) => targets[id] || null,
  };
}

const loaded = makeLookup({
  inbox: { r1: { id: "r1", archived: false }, in1: { id: "in1", archived: false } },
  items: ["r1"],
  intents: ["r1", "it1"],
  contexts: ["r1"],
  collections: ["r1", "c1"],
});
const empty = makeLookup();

describe("recordDestination, rows loaded", () => {
  it.each([
    ["inbox", {}, { kind: "path", path: "/inbox/detail/r1" }],
    ["intents", {}, { kind: "path", path: "/intentions/detail/r1" }],
    ["executions", {}, { kind: "path", path: "/schedule/execution/r1" }],
    ["sam_songs", {}, { kind: "path", path: "/sam/songs/r1" }],
    ["items", {}, { kind: "item", id: "r1" }],
    ["contexts", {}, { kind: "context", id: "r1" }],
    ["item_collections", {}, { kind: "collection", id: "r1" }],
    ["clips", { inbox_id: "in1" }, { kind: "path", path: "/inbox/detail/in1" }],
    ["reminders", { inbox_id: "in1" }, { kind: "path", path: "/inbox/detail/in1" }],
    ["reminders", { intent_id: "it1" }, { kind: "path", path: "/intentions/detail/it1" }],
    ["notification_steps", { execution_id: "ex1" }, { kind: "path", path: "/schedule/execution/ex1" }],
    ["collection_items", { collection_id: "c1" }, { kind: "collection", id: "c1" }],
  ])("%s %j", (table, row, expected) => {
    expect(recordDestination(res(table, row), loaded)).toEqual(expected);
  });

  it("maps every table it lists", () => {
    expect(Object.keys(RECORD_SCREENS)).toHaveLength(11);
  });
});

describe("archived inbox", () => {
  const archived = (targets, extra = {}) =>
    makeLookup({ inbox: { r1: { id: "r1", archived: true } }, targets, ...extra });

  it("opens the item it became", () => {
    const l = archived({ r1: { kind: "item", id: "i9" } }, { items: ["i9"] });
    expect(recordDestination(res("inbox"), l)).toEqual({ kind: "item", id: "i9" });
  });

  it("opens the intention it became", () => {
    const l = archived({ r1: { kind: "intention", id: "t9" } }, { intents: ["t9"] });
    expect(recordDestination(res("inbox"), l)).toEqual({ kind: "path", path: "/intentions/detail/t9" });
  });

  it("no successor goes generic", () => {
    expect(recordDestination(res("inbox"), archived({}))).toEqual(GENERIC);
  });

  it("successor not loaded goes generic", () => {
    expect(recordDestination(res("inbox"), archived({ r1: { kind: "item", id: "i9" } }))).toEqual(GENERIC);
  });

  it("archived parent of a clip goes generic", () => {
    expect(recordDestination(res("clips", { inbox_id: "r1" }), archived({}))).toEqual(GENERIC);
  });
});

describe("not in state goes generic, never a list", () => {
  it.each([
    ["inbox", {}],
    ["intents", {}],
    ["items", {}],
    ["contexts", {}],
    ["item_collections", {}],
    ["clips", { inbox_id: "in1" }],
    ["reminders", { inbox_id: "in1", intent_id: "it1" }],
    ["collection_items", { collection_id: "c1" }],
  ])("%s %j", (table, row) => {
    expect(recordDestination(res(table, row), empty)).toEqual(GENERIC);
  });

  it("parent-screen tables with no parent id", () => {
    for (const t of ["clips", "reminders", "notification_steps", "collection_items"]) {
      expect(recordDestination(res(t, {}), loaded)).toEqual(GENERIC);
    }
  });
});

describe("other results", () => {
  it("unmapped table goes generic", () => {
    expect(recordDestination(res("dj_concerts", {}), loaded)).toEqual(GENERIC);
  });

  it("null goes missing", () => {
    expect(recordDestination(null, loaded)).toEqual({ kind: "missing" });
  });
});
