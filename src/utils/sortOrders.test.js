// Shared list-sort orders.
//
// samSort.test.js already covers these conventions through SAM's three orders.
// What is pinned here is what the PROMOTION changed or newly exposed: accessor
// lookup by arbitrary key, direction defaults driven by a caller's option list,
// and the stored-preference reader — which is the one piece that has to survive
// hostile input, because it reads whatever is in localStorage from any build.

import {
  compareValues,
  comparatorFor,
  defaultDirectionFor,
  sortRows,
  readStoredSort,
  writeStoredSort,
} from "./sortOrders";

const OPTIONS = [
  { value: "time", label: "Scheduled date", defaultDir: "asc" },
  { value: "created", label: "Created", defaultDir: "desc" },
  { value: "title", label: "Name", defaultDir: "asc" },
];

const GET = {
  title: (r) => r.title,
  time: (r) => r.time,
  created: (r) => r.created,
};

const row = (title, time, created) => ({ title, time, created });

beforeEach(() => window.localStorage.clear());

describe("compareValues — missing last, in both directions", () => {
  it.each([["asc"], ["desc"]])("puts a missing value after a present one (%s)", (dir) => {
    expect(compareValues("", "2026-01-01", dir)).toBe(1);
    expect(compareValues("2026-01-01", "", dir)).toBe(-1);
  });

  it("treats two missing values as equal, so the tiebreaker decides", () => {
    expect(compareValues("", "", "asc")).toBe(0);
  });
});

describe("comparatorFor — accessor lookup by key", () => {
  // The promotion's one behavioural change: SAM's version hardcoded
  // `key === "added" ? get.added : get.played`, which allowed exactly two
  // non-title fields.
  it("sorts on any key present in the accessor bag", () => {
    const rows = [row("b", "2026-03-01", "x"), row("a", "2026-01-01", "y")];
    expect(sortRows(rows, "time", GET, "asc").map((r) => r.title)).toEqual(["a", "b"]);
  });

  it("supports more than two non-title fields", () => {
    const rows = [row("b", "2026-03-01", "2026-09-09"), row("a", "2026-01-01", "2026-01-01")];
    expect(sortRows(rows, "created", GET, "desc").map((r) => r.title)).toEqual(["b", "a"]);
  });

  it("falls back to title order for a key with no accessor", () => {
    const rows = [row("b"), row("a")];
    expect(sortRows(rows, "nonexistent", GET, "desc").map((r) => r.title)).toEqual(["a", "b"]);
  });
});

describe("comparatorFor — the tiebreaker", () => {
  it("breaks ties by title, so no two rows compare equal", () => {
    const rows = [row("c", "2026-01-01"), row("a", "2026-01-01"), row("b", "2026-01-01")];
    expect(sortRows(rows, "time", GET, "asc").map((r) => r.title)).toEqual(["a", "b", "c"]);
  });

  it("keeps the tiebreaker A→Z even when the sort is descending", () => {
    const rows = [row("c", "2026-01-01"), row("a", "2026-01-01"), row("b", "2026-01-01")];
    expect(sortRows(rows, "time", GET, "desc").map((r) => r.title)).toEqual(["a", "b", "c"]);
  });

  it("applies direction to title only when title IS the key", () => {
    const rows = [row("a"), row("b")];
    expect(sortRows(rows, "title", GET, "desc").map((r) => r.title)).toEqual(["b", "a"]);
  });

  it("does not mutate the caller's array", () => {
    const rows = [row("b"), row("a")];
    const before = [...rows];
    sortRows(rows, "title", GET, "asc");
    expect(rows).toEqual(before);
  });
});

describe("defaultDirectionFor — driven by the caller's options", () => {
  it("reads the direction off the option list it is given", () => {
    expect(defaultDirectionFor("time", OPTIONS)).toBe("asc");
    expect(defaultDirectionFor("created", OPTIONS)).toBe("desc");
  });

  it("falls back to descending for an unknown key", () => {
    expect(defaultDirectionFor("nope", OPTIONS)).toBe("desc");
  });

  it("falls back to descending when given no options at all", () => {
    expect(defaultDirectionFor("time")).toBe("desc");
  });
});

describe("readStoredSort — survives whatever is in storage", () => {
  const KEY = "alfred.sort.test";

  it("returns the page default when nothing is stored", () => {
    expect(readStoredSort(KEY, OPTIONS, "time")).toEqual({ key: "time", dir: "asc" });
  });

  it("round-trips a written preference", () => {
    writeStoredSort(KEY, { key: "created", dir: "asc" });
    expect(readStoredSort(KEY, OPTIONS, "time")).toEqual({ key: "created", dir: "asc" });
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["a JSON primitive", '"created"'],
    ["null", "null"],
  ])("falls back on %s", (_label, raw) => {
    window.localStorage.setItem(KEY, raw);
    expect(readStoredSort(KEY, OPTIONS, "time")).toEqual({ key: "time", dir: "asc" });
  });

  // The case that actually happens: options change between releases and a
  // preference outlives the field that produced it.
  it("falls back when the stored key is no longer offered", () => {
    writeStoredSort(KEY, { key: "retired-field", dir: "asc" });
    expect(readStoredSort(KEY, OPTIONS, "time")).toEqual({ key: "time", dir: "asc" });
  });

  it("repairs a bad direction while keeping a valid key", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ key: "created", dir: "sideways" }));
    expect(readStoredSort(KEY, OPTIONS, "time")).toEqual({ key: "created", dir: "desc" });
  });
});

describe("storage being unavailable is not fatal", () => {
  // Private browsing and disabled storage throw on access rather than
  // returning null. A sort preference must not take the page down.
  it("reads a default and writes silently when localStorage throws", () => {
    const real = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("denied");
      },
    });
    try {
      expect(readStoredSort("k", OPTIONS, "time")).toEqual({ key: "time", dir: "asc" });
      expect(() => writeStoredSort("k", { key: "time", dir: "asc" })).not.toThrow();
    } finally {
      Object.defineProperty(window, "localStorage", real);
    }
  });
});

describe("the order does not depend on the order rows arrived in", () => {
  // This is what fixes Schedule. Its list was a bare alias over an unordered
  // SELECT, further mutated by local appends and realtime inserts, so the same
  // rows could render differently in two sessions. A total order — every
  // comparator falling through to the title tiebreaker — makes the output a
  // function of the rows alone.
  //
  // Sorting one list once proves nothing about that. Permuting the input does.
  const EVENTS = [
    { title: "Dentist", time: "2026-09-01", created: "2026-08-01T10:00:00Z" },
    { title: "Groceries", time: "2026-09-01", created: "2026-08-02T10:00:00Z" },
    { title: "Anniversary", time: "2026-09-01", created: "2026-08-03T10:00:00Z" },
    { title: "Tax return", time: "2026-08-30", created: "2026-08-04T10:00:00Z" },
    { title: "Oil change", time: null, created: "2026-08-05T10:00:00Z" },
  ];

  const permutations = (xs) =>
    xs.length <= 1
      ? [xs]
      : xs.flatMap((x, i) =>
          permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])
        );

  it.each([["time", "asc"], ["time", "desc"], ["created", "desc"], ["title", "asc"]])(
    "sorting by %s %s gives one answer for all 120 input orders",
    (key, dir) => {
      const answers = new Set(
        permutations(EVENTS).map((perm) =>
          sortRows(perm, key, GET, dir).map((r) => r.title).join("|")
        )
      );
      expect(answers.size).toBe(1);
    }
  );

  it("keeps the three same-date rows in a fixed order, not their arrival order", () => {
    // Without the tiebreaker these three tie on `time` and sort stability would
    // leave whichever order Postgres happened to return.
    const forwards = sortRows(EVENTS, "time", GET, "asc").map((r) => r.title);
    const backwards = sortRows([...EVENTS].reverse(), "time", GET, "asc").map((r) => r.title);
    expect(forwards).toEqual(backwards);
    expect(forwards.slice(1, 4)).toEqual(["Anniversary", "Dentist", "Groceries"]);
  });

  it("puts a row with no scheduled date last in both directions", () => {
    expect(sortRows(EVENTS, "time", GET, "asc").at(-1).title).toBe("Oil change");
    expect(sortRows(EVENTS, "time", GET, "desc").at(-1).title).toBe("Oil change");
  });
});
