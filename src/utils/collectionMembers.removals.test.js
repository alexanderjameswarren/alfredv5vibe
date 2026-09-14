/**
 * Tests for the removal-history window: `since`, and a limit that can be
 * omitted entirely.
 *
 * The mock records the query chain rather than simulating PostgREST, because
 * what is under test IS the query: which bounds get applied, and — more to the
 * point — which do not. A count ceiling silently reappearing under a time
 * window is the exact failure this phase existed to remove, and it is invisible
 * in returned rows.
 */

jest.mock("../supabaseClient", () => {
  const calls = [];
  const state = { rows: [], error: null };

  function builder() {
    const b = {
      select: (...a) => (calls.push(["select", ...a]), b),
      eq: (...a) => (calls.push(["eq", ...a]), b),
      gte: (...a) => (calls.push(["gte", ...a]), b),
      order: (...a) => (calls.push(["order", ...a]), b),
      limit: (...a) => (calls.push(["limit", ...a]), b),
      then: (resolve, reject) =>
        Promise.resolve({ data: state.rows, error: state.error }).then(
          resolve,
          reject,
        ),
    };
    return b;
  }

  return {
    supabase: {
      from: (table) => (calls.push(["from", table]), builder()),
    },
    __calls: calls,
    __state: state,
  };
});

const { __calls, __state } = require("../supabaseClient");
const { loadRemovals, REMOVAL_MANUAL } = require("./collectionMembers");

/** Arguments of the one call to `name`, or undefined if it was never called. */
const callOf = (name) => __calls.find((c) => c[0] === name)?.slice(1);
const called = (name) => __calls.some((c) => c[0] === name);

beforeEach(() => {
  __calls.length = 0;
  __state.rows = [];
  __state.error = null;
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("loadRemovals — the `since` window", () => {
  it("adds a gte on removed_at", async () => {
    const at = new Date("2026-09-14T07:00:00.000Z");
    await loadRemovals("c1", { since: at });

    expect(callOf("gte")).toEqual(["removed_at", "2026-09-14T07:00:00.000Z"]);
  });

  it("accepts an ISO string as well as a Date", async () => {
    await loadRemovals("c1", { since: "2026-09-14T07:00:00.000Z" });

    expect(callOf("gte")).toEqual(["removed_at", "2026-09-14T07:00:00.000Z"]);
  });

  it("applies no gte when since is omitted", async () => {
    await loadRemovals("c1");

    expect(called("gte")).toBe(false);
  });

  it("rejects an unparseable since rather than querying on NaN", async () => {
    const res = await loadRemovals("c1", { since: "not a date" });

    expect(res.data).toBeNull();
    expect(res.error).toMatch(/since/);
    expect(called("from")).toBe(false);
  });

  it("still orders most-recent-first", async () => {
    await loadRemovals("c1", { since: new Date() });

    expect(callOf("order")).toEqual(["removed_at", { ascending: false }]);
  });
});

describe("loadRemovals — the limit, and being able to omit it", () => {
  it("applies NO limit when given null — the panel's case", async () => {
    // The whole point. A window bounded by time must not also be bounded by
    // count: a heavy shopping day can exceed any ceiling worth setting, and the
    // rows it hides are the older half of the SAME day.
    await loadRemovals("c1", { since: new Date(), limit: null });

    expect(called("limit")).toBe(false);
  });

  it("still defaults to 50 when the limit is simply not mentioned", async () => {
    // Omitting is not the same as passing null. The history view omits it and
    // must be unaffected by this phase.
    await loadRemovals("c1");

    expect(callOf("limit")).toEqual([50]);
  });

  it("still clamps a numeric limit to the 200 ceiling", async () => {
    await loadRemovals("c1", { limit: 5000 });
    expect(callOf("limit")).toEqual([200]);
  });

  it("still floors a numeric limit at 1", async () => {
    await loadRemovals("c1", { limit: 0 });
    expect(callOf("limit")).toEqual([1]);
  });

  it("honours an explicit numeric limit alongside since", async () => {
    await loadRemovals("c1", { since: new Date(), limit: 10 });
    expect(callOf("limit")).toEqual([10]);
    expect(called("gte")).toBe(true);
  });
});

describe("loadRemovals — what must not have changed", () => {
  it("still filters by reason when asked", async () => {
    // The panel passes REMOVAL_MANUAL so a bulk completion cannot flood it.
    await loadRemovals("c1", { since: new Date(), limit: null, reason: REMOVAL_MANUAL });

    const eqs = __calls.filter((c) => c[0] === "eq").map((c) => c.slice(1));
    expect(eqs).toContainEqual(["reason", "manual"]);
  });

  it("still scopes to the collection", async () => {
    await loadRemovals("c1", { since: new Date(), limit: null });

    const eqs = __calls.filter((c) => c[0] === "eq").map((c) => c.slice(1));
    expect(eqs).toContainEqual(["collection_id", "c1"]);
  });

  it("still rejects an unknown reason before querying", async () => {
    const res = await loadRemovals("c1", { reason: "nonsense" });

    expect(res.error).toMatch(/Unknown reason/);
    expect(called("from")).toBe(false);
  });

  it("still requires a collectionId and never throws", async () => {
    await expect(loadRemovals("")).resolves.toMatchObject({ data: null });
  });

  it("still reports a query failure rather than throwing", async () => {
    __state.error = { message: "boom" };
    const res = await loadRemovals("c1", { since: new Date(), limit: null });

    expect(res.data).toBeNull();
    expect(res.error).toBe("boom");
  });

  it("still returns camelCased rows, tags included", async () => {
    // Phase 6 wired tags through this same panel, and Put back reads them from
    // here to restore them.
    __state.rows = [
      {
        id: "r1",
        collection_id: "c1",
        item_id: "eggs",
        item_name: "Eggs",
        tags: ["tjs"],
        reason: "manual",
        removed_at: "2026-09-14T15:00:00.000Z",
      },
    ];

    const res = await loadRemovals("c1", { since: new Date(), limit: null });

    expect(res.data[0]).toMatchObject({
      itemId: "eggs",
      itemName: "Eggs",
      tags: ["tjs"],
      removedAt: "2026-09-14T15:00:00.000Z",
    });
  });
});

describe("both views carry quantity and tags", () => {
  // The panel and the history view are two CALLS to one function, not two
  // queries — `loadRemovals` selects "*", so both already carry every
  // snapshotted field. These pin that, because "the history view has its own
  // query" is an easy and wrong assumption to act on.
  const row = {
    id: "r1",
    collection_id: "c1",
    item_id: "eggs",
    item_name: "Eggs",
    quantity: "1 dozen",
    tags: ["tjs", "whole foods"],
    position: 0,
    reason: "manual",
    removed_at: "2026-09-14T15:00:00.000Z",
  };

  it("selects every column, so no field has to be added for display", () => {
    __state.rows = [row];
    return loadRemovals("c1").then(() => {
      expect(callOf("select")).toEqual(["*"]);
    });
  });

  it("the panel's call returns quantity and tags", async () => {
    __state.rows = [row];
    const res = await loadRemovals("c1", {
      reason: REMOVAL_MANUAL,
      since: new Date("2026-09-14T07:00:00.000Z"),
      limit: null,
    });

    expect(res.data[0].quantity).toBe("1 dozen");
    expect(res.data[0].tags).toEqual(["tjs", "whole foods"]);
  });

  it("the history view's call returns them too", async () => {
    __state.rows = [row];
    const res = await loadRemovals("c1", { limit: 50 });

    expect(res.data[0].quantity).toBe("1 dozen");
    expect(res.data[0].tags).toEqual(["tjs", "whole foods"]);
  });

  it("a row from before Migration B comes back without throwing", async () => {
    // Removals recorded before the tags column existed have no tags at all.
    __state.rows = [{ ...row, tags: undefined, quantity: null }];
    const res = await loadRemovals("c1", { limit: 50 });

    expect(res.error).toBeNull();
    expect(res.data[0].quantity).toBeNull();
    expect(res.data[0].tags).toBeUndefined();
  });
});

describe("the panel's window, end to end", () => {
  const { startOfPacificDay } = require("./localDay");

  it("asks for everything since Pacific midnight, with no ceiling", async () => {
    // The combination the collection panel actually passes. Asserted together
    // because either half alone still hides rows: a ceiling without a window
    // was the old bug, and a window with a ceiling is the same bug wearing a
    // different number.
    await loadRemovals("c1", {
      reason: REMOVAL_MANUAL,
      since: startOfPacificDay(),
      limit: null,
    });

    expect(called("limit")).toBe(false);
    expect(callOf("gte")[0]).toBe("removed_at");

    // And the boundary really is Pacific midnight, not the machine's.
    const iso = callOf("gte")[1];
    const shown = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
    expect(shown.replace(/^24/, "00")).toBe("00:00");
  });
});
