import {
  statusOf,
  statusCounts,
  filterByStatus,
  rankByStatus,
  statusOptionsFor,
  toggleStatusFilter,
  flippedToActive,
  carriedItems,
  closedBlockTitle,
  recordActions,
  rankByActivity,
  withTag,
  mergeStatuses,
  liveEventsFor,
  readStoredStatusFilter,
  writeStoredStatusFilter,
  DEFAULT_STATUS_FILTER,
} from "./status";

const rows = [
  { id: "a", status: "active" },
  { id: "b", status: "background" },
  { id: "c" },
  { id: "d", status: "closed" },
  { id: "e", status: "someday" },
];

test("missing status reads as someday", () => {
  expect(statusOf({})).toBe("someday");
  expect(statusOf({ status: "bogus" })).toBe("someday");
});

test("counts cover every status, zero included", () => {
  expect(statusCounts(rows)).toEqual({ someday: 2, active: 1, background: 1, closed: 1 });
  expect(statusCounts([])).toEqual({ someday: 0, active: 0, background: 0, closed: 0 });
});

test("filter keeps only selected statuses", () => {
  expect(filterByStatus(rows, DEFAULT_STATUS_FILTER).map((r) => r.id)).toEqual(["a", "c", "e"]);
});

test("background and closed sink, order otherwise kept", () => {
  expect(rankByStatus(rows).map((r) => r.id)).toEqual(["a", "c", "e", "b", "d"]);
});

test("someday is offered only while the row is someday", () => {
  expect(statusOptionsFor("someday")).toContain("someday");
  expect(statusOptionsFor("active")).not.toContain("someday");
  expect(statusOptionsFor("closed")).toEqual(["active", "background", "closed"]);
});

test("toggle adds in canonical order and removes", () => {
  expect(toggleStatusFilter(["active"], "someday")).toEqual(["someday", "active"]);
  expect(toggleStatusFilter(["someday", "active"], "active")).toEqual(["someday"]);
});

test("flippedToActive finds someday or background rows now active", () => {
  const before = [{ id: "a", status: "someday" }, { id: "b", status: "background" }, { id: "c", status: "active" }, { id: "d", status: "closed" }];
  const fresh = [{ id: "a", status: "active" }, { id: "b", status: "active" }, { id: "c", status: "active" }, { id: "d", status: "closed" }];
  expect(flippedToActive(before, fresh).map((r) => r.id)).toEqual(["a", "b"]);
});

test("a background row the execution trigger leaves alone is no flip", () => {
  const before = [{ id: "a", status: "background" }, { id: "b", status: "someday" }];
  const fresh = [{ id: "a", status: "background" }, { id: "b", status: "active" }];
  expect(flippedToActive(before, fresh).map((r) => r.id)).toEqual(["b"]);
});

test("carriedItems takes the intention's item and carried ids, skipping gaps", () => {
  const items = [null, { id: "own" }, { id: "x" }, { id: "other" }];
  expect(carriedItems({ itemId: "own" }, ["x"], items).map((i) => i.id)).toEqual(["own", "x"]);
  expect(carriedItems({ itemId: null }, null, items)).toEqual([]);
  expect(carriedItems(undefined, ["x"], items).map((i) => i.id)).toEqual(["x"]);
});

test("recordActions: labels follow open execution and live event", () => {
  const intent = { id: "i" };
  const ev = { id: "e", intentId: "i", time: "2026-10-12" };
  expect(recordActions(intent, [], [])).toMatchObject({ primaryLabel: "Start Now", scheduleLabel: "Schedule", liveDate: null });
  expect(recordActions(intent, [ev], [])).toMatchObject({ primaryLabel: "Start Now", scheduleLabel: "Reschedule", liveDate: "2026-10-12" });
  expect(recordActions(intent, [ev], [{ id: "x", intentId: "i" }]).primaryLabel).toBe("Continue");
  expect(recordActions(intent, [ev], [{ id: "x", intentId: "i", status: "active" }]).moveBlocked).toMatch(/Pause or cancel/);
  expect(recordActions(intent, [ev], [{ id: "x", intentId: "i", status: "paused" }]).moveBlocked).toBeNull();
  expect(recordActions(intent, [{ ...ev, archived: true }], [{ id: "x", intentId: "j" }])).toMatchObject({ primaryLabel: "Start Now", scheduleLabel: "Schedule" });
});

test("rankByActivity: running, paused, scheduled soonest, unscheduled, background, closed", () => {
  const intents = [
    { id: "closed", status: "closed" },
    { id: "some", status: "someday" },
    { id: "late", status: "active" },
    { id: "bg", status: "background" },
    { id: "paused", status: "active" },
    { id: "soon", status: "active" },
    { id: "run", status: "active" },
  ];
  const events = [
    { id: "e1", intentId: "late", time: "2026-10-20" },
    { id: "e2", intentId: "soon", time: "2026-10-09" },
    { id: "e3", intentId: "bg", time: "2026-10-01" },
  ];
  const open = [{ intentId: "paused", status: "paused" }, { intentId: "run", status: "active" }];
  expect(rankByActivity(intents, events, open).map((i) => i.id)).toEqual([
    "run", "paused", "soon", "late", "some", "bg", "closed",
  ]);
});

test("withTag narrows to a tag, or passes everything with none", () => {
  const rows = [{ id: "a", tags: ["bug"] }, { id: "b" }, { id: "c", tags: ["ui"] }];
  expect(withTag(rows, "bug").map((r) => r.id)).toEqual(["a"]);
  expect(withTag(rows, null)).toBe(rows);
  expect(statusCounts(withTag([{ status: "closed", tags: ["x"] }, { status: "active" }], "x"))).toEqual({
    someday: 0, active: 0, background: 0, closed: 1,
  });
});

test("closedBlockTitle names the kind only when closed", () => {
  expect(closedBlockTitle({ status: "closed" }, "item")).toBe("This item is closed. Set it to Active to use it.");
  expect(closedBlockTitle({ status: "background" }, "item")).toBeNull();
});

test("mergeStatuses copies status fields only, same object when unchanged", () => {
  const state = [{ id: "a", status: "someday", text: "keep" }, { id: "b", status: "active", statusChangedAt: "t" }];
  const out = mergeStatuses(state, [{ id: "a", status: "active", statusChangedAt: "t2" }, { id: "b", status: "active", statusChangedAt: "t" }]);
  expect(out[0]).toEqual({ id: "a", status: "active", statusChangedAt: "t2", text: "keep" });
  expect(out[1]).toBe(state[1]);
});

test("liveEventsFor skips archived and other intents, earliest first", () => {
  const events = [
    { id: 1, intentId: "i", time: "2026-10-09", archived: false },
    { id: 2, intentId: "i", time: "2026-10-01", archived: false },
    { id: 3, intentId: "i", time: "2026-09-01", archived: true },
    { id: 4, intentId: "j", time: "2026-09-01", archived: false },
  ];
  expect(liveEventsFor(events, "i").map((e) => e.id)).toEqual([2, 1]);
});

test("stored filter round-trips and falls back to the default", () => {
  window.localStorage.clear();
  expect(readStoredStatusFilter("p")).toEqual(DEFAULT_STATUS_FILTER);
  writeStoredStatusFilter("p", ["background"]);
  expect(readStoredStatusFilter("p")).toEqual(["background"]);
  window.localStorage.setItem("alfred.status.p", "not json");
  expect(readStoredStatusFilter("p")).toEqual(DEFAULT_STATUS_FILTER);
});
