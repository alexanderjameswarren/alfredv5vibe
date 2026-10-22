import {
  ARCHIVE_PAGE_SIZE,
  inboxIdOfRecord,
  liveInboxQuery,
  mergeInboxRefresh,
  olderArchivedCountQuery,
  olderArchivedPageQuery,
  recentArchivedQuery,
  warnIfCapped,
} from "./inboxQueries";

// A query builder that records every call, in order.
function recorder() {
  const calls = [];
  const q = new Proxy({}, {
    get: (_t, name) => (...args) => {
      calls.push([name, ...args]);
      return q;
    },
  });
  return { db: q, calls };
}

const NOW = new Date("2026-10-21T12:00:00.000Z");
const CUTOFF = "2026-10-14T12:00:00.000Z";

describe("inbox queries", () => {
  it("the live inbox excludes archived rows, keeping NULL as live", () => {
    const { db, calls } = recorder();
    liveInboxQuery(db);
    expect(calls).toEqual([["from", "inbox"], ["select", "*"], ["not", "archived", "is", true]]);
  });

  it("recently archived is the window by triaged_at", () => {
    const { db, calls } = recorder();
    recentArchivedQuery(db, NOW);
    expect(calls).toContainEqual(["eq", "archived", true]);
    expect(calls).toContainEqual(["gte", "triaged_at", CUTOFF]);
  });

  it("older rows include the unstamped, sorted by updated_at after the stamped", () => {
    const { db, calls } = recorder();
    olderArchivedPageQuery(db, 50, NOW);
    expect(calls).toContainEqual(["or", `triaged_at.lt.${CUTOFF},triaged_at.is.null`]);
    const orders = calls.filter(([n]) => n === "order").map(([, col, opts]) => [col, opts]);
    expect(orders).toEqual([
      ["triaged_at", { ascending: false, nullsFirst: false }],
      ["updated_at", { ascending: false }],
      ["id", { ascending: true }],
    ]);
  });

  it("pages 50 at a time", () => {
    const { db, calls } = recorder();
    olderArchivedPageQuery(db, 100, NOW);
    expect(calls).toContainEqual(["range", 100, 100 + ARCHIVE_PAGE_SIZE - 1]);
    expect(ARCHIVE_PAGE_SIZE).toBe(50);
  });

  it("the count is a head-only exact count over the same rows", () => {
    const { db, calls } = recorder();
    olderArchivedCountQuery(db, NOW);
    expect(calls).toContainEqual(["select", "id", { count: "exact", head: true }]);
    expect(calls).toContainEqual(["or", `triaged_at.lt.${CUTOFF},triaged_at.is.null`]);
  });
});

describe("warnIfCapped", () => {
  it("names the table at exactly 1000 rows, and only then", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    warnIfCapped("items", new Array(999).fill({}));
    expect(warn).not.toHaveBeenCalled();
    warnIfCapped("items", new Array(1000).fill({}));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("items returned exactly 1000 rows"));
    warn.mockRestore();
  });
});

describe("mergeInboxRefresh", () => {
  const old = { id: "old", archived: true, triagedAt: "2026-09-01T00:00:00.000Z", createdAt: "a" };
  const gone = { id: "gone", archived: false, createdAt: "b" };
  const live = { id: "live", archived: false, createdAt: "c" };

  it("keeps paged-in older rows, drops live rows the refresh no longer has", () => {
    expect(mergeInboxRefresh([live], [old, gone], NOW).map((r) => r.id)).toEqual(["old", "live"]);
  });

  it("lets the refresh win for a row it has", () => {
    const back = { ...old, archived: false };
    expect(mergeInboxRefresh([back], [old], NOW)).toEqual([back]);
  });
});

describe("inboxIdOfRecord", () => {
  it("finds the capture behind an inbox row, a clip or a reminder", () => {
    expect(inboxIdOfRecord({ table: "inbox", row: { id: "i1" } })).toBe("i1");
    expect(inboxIdOfRecord({ table: "clips", row: { inbox_id: "i2" } })).toBe("i2");
    expect(inboxIdOfRecord({ table: "reminders", row: { inbox_id: null } })).toBeNull();
    expect(inboxIdOfRecord({ table: "items", row: { id: "x" } })).toBeNull();
    expect(inboxIdOfRecord(null)).toBeNull();
  });
});
