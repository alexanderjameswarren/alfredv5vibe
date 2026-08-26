/**
 * Tests for addOrMergeMembers.
 *
 * The Supabase client is mocked at the module boundary. What is under test is
 * the merge decision table and the handling of addMembers' `ignoreDuplicates`
 * race, not PostgREST.
 */

jest.mock("../supabaseClient", () => {
  const state = { members: [], failOn: null, racedInsert: null };
  const result = (data, error = null) => Promise.resolve({ data, error });

  function from(table) {
    if (table !== "collection_items") {
      return {
        select: () => ({ eq: () => ({ in: () => result([]) }) }),
        insert: () => ({ select: () => result([]) }),
      };
    }
    const api = {
      // loadMembers / nextPosition / the race re-read
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () =>
              result(
                state.members.length
                  ? [{ position: Math.max(...state.members.map((m) => m.position)) }]
                  : [],
              ),
            then: undefined,
          }),
          in: (_col, ids) =>
            result(state.members.filter((m) => ids.includes(m.item_id))),
          // loadMembers awaits .order(...) directly
        }),
      }),
      upsert: (rows) => ({
        select: () => {
          if (state.failOn === "upsert") return result(null, { message: "upsert boom" });
          const insertedRows = [];
          for (const row of rows) {
            const clash =
              state.members.some((m) => m.item_id === row.item_id) ||
              (state.racedInsert && state.racedInsert.includes(row.item_id));
            if (clash) {
              // ignoreDuplicates: silently skipped. If this was a race, the
              // other writer's row is now visible.
              if (state.racedInsert && state.racedInsert.includes(row.item_id)) {
                if (!state.members.some((m) => m.item_id === row.item_id)) {
                  state.members.push({
                    id: `raced-${row.item_id}`,
                    collection_id: row.collection_id,
                    item_id: row.item_id,
                    quantity: "9 raced",
                    position: 99,
                  });
                }
              }
              continue;
            }
            const stored = { id: `new-${row.item_id}`, ...row };
            state.members.push(stored);
            insertedRows.push(stored);
          }
          return result(insertedRows);
        },
      }),
      update: (patch) => ({
        eq: () => ({
          eq: () => ({
            select: () => {
              if (state.failOn === "update")
                return result(null, { message: "update boom" });
              const target = state.members[state.members.length - 1];
              if (!target) return result([]);
              return result([{ ...target, ...patch }]);
            },
          }),
        }),
      }),
    };
    return api;
  }

  return { supabase: { from }, __state: state };
});

// loadMembers awaits the builder returned by .order(); give it a thenable.
jest.mock("./caseConvert", () => jest.requireActual("./caseConvert"));

const { supabase, __state } = require("../supabaseClient");

// Rebuild the select chain so `.order()` is awaitable, matching PostgREST.
const originalFrom = supabase.from;
supabase.from = (table) => {
  const api = originalFrom(table);
  if (table !== "collection_items") return api;
  return {
    ...api,
    select: () => ({
      eq: () => {
        const rows = __state.members
          .slice()
          .sort((a, b) => a.position - b.position);
        const builder = {
          order: (_col, opts) => {
            if (opts && opts.ascending === false) {
              return {
                limit: () =>
                  Promise.resolve({
                    data: rows.length
                      ? [{ position: Math.max(...rows.map((r) => r.position)) }]
                      : [],
                    error: null,
                  }),
              };
            }
            return Promise.resolve({ data: rows, error: null });
          },
          in: (_col, ids) =>
            Promise.resolve({
              data: __state.members.filter((m) => ids.includes(m.item_id)),
              error: null,
            }),
        };
        return builder;
      },
    }),
  };
};

const { addOrMergeMembers } = require("./collectionMembers");

const member = (itemId, quantity, position = 0) => ({
  id: `m-${itemId}`,
  collection_id: "c1",
  item_id: itemId,
  quantity,
  position,
});

beforeEach(() => {
  __state.members = [];
  __state.failOn = null;
  __state.racedInsert = null;
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("addOrMergeMembers — contract", () => {
  it("returns { data, error } and never throws on a missing collectionId", async () => {
    const res = await addOrMergeMembers("", [{ itemId: "i1" }]);
    expect(res.error).toBeTruthy();
    expect(res.data).toBeNull();
    expect(res).toHaveProperty("inserted", []);
    expect(res).toHaveProperty("merged", []);
    expect(res).toHaveProperty("unchanged", []);
  });

  it("treats an empty entry list as a no-op success", async () => {
    const res = await addOrMergeMembers("c1", []);
    expect(res).toMatchObject({ data: [], error: null, inserted: [], merged: [] });
  });

  it("rejects an entry with no itemId rather than writing a null row", async () => {
    const res = await addOrMergeMembers("c1", [{ quantity: "2" }]);
    expect(res.error).toMatch(/itemId/);
    expect(res.data).toBeNull();
  });

  it("reports a write failure instead of throwing", async () => {
    __state.failOn = "upsert";
    const res = await addOrMergeMembers("c1", [{ itemId: "i1", quantity: "1" }]);
    expect(res.error).toBeTruthy();
    expect(res.data).toBeNull();
  });
});

describe("addOrMergeMembers — the merge decision table", () => {
  it("inserts an item that is not present", async () => {
    const res = await addOrMergeMembers("c1", [{ itemId: "i1", quantity: "6" }]);
    expect(res.error).toBeNull();
    expect(res.inserted).toEqual(["i1"]);
    expect(res.merged).toEqual([]);
  });

  it("takes the new quantity when the existing one is empty", async () => {
    __state.members = [member("i1", null)];
    const res = await addOrMergeMembers("c1", [{ itemId: "i1", quantity: "3" }]);
    expect(res.merged).toEqual(["i1"]);
    expect(res.data[0].quantity).toBe("3");
  });

  it("leaves the existing quantity alone when the new one is empty", async () => {
    __state.members = [member("i1", "6")];
    const res = await addOrMergeMembers("c1", [{ itemId: "i1" }]);
    expect(res.merged).toEqual([]);
    expect(res.unchanged).toEqual(["i1"]);
  });

  it("treats an all-whitespace quantity as empty", async () => {
    __state.members = [member("i1", "6")];
    const res = await addOrMergeMembers("c1", [{ itemId: "i1", quantity: "   " }]);
    expect(res.unchanged).toEqual(["i1"]);
  });

  it("concatenates two different quantities with ' + ', without arithmetic", async () => {
    __state.members = [member("i1", "6")];
    const res = await addOrMergeMembers("c1", [{ itemId: "i1", quantity: "3" }]);
    expect(res.data[0].quantity).toBe("6 + 3");
  });

  it("concatenates incompatible units rather than summing them", async () => {
    __state.members = [member("i1", "2 cans")];
    const res = await addOrMergeMembers("c1", [{ itemId: "i1", quantity: "1 lb" }]);
    expect(res.data[0].quantity).toBe("2 cans + 1 lb");
  });

  it("does not double identical text", async () => {
    __state.members = [member("i1", "2 cans")];
    const res = await addOrMergeMembers("c1", [{ itemId: "i1", quantity: "2 cans" }]);
    expect(res.merged).toEqual([]);
    expect(res.unchanged).toEqual(["i1"]);
  });

  it("ignores surrounding whitespace when comparing for identity", async () => {
    __state.members = [member("i1", "2 cans")];
    const res = await addOrMergeMembers("c1", [{ itemId: "i1", quantity: "  2 cans " }]);
    expect(res.unchanged).toEqual(["i1"]);
  });
});

describe("addOrMergeMembers — repeats inside one call", () => {
  it("merges two entries for the same item before writing", async () => {
    const res = await addOrMergeMembers("c1", [
      { itemId: "i1", quantity: "6" },
      { itemId: "i1", quantity: "3" },
    ]);
    expect(res.inserted).toEqual(["i1"]);
    // One row, not two, and the quantities combined.
    expect(res.data).toHaveLength(1);
    expect(res.data[0].quantity).toBe("6 + 3");
  });

  it("collapses a repeat against an existing member too", async () => {
    __state.members = [member("i1", "1")];
    const res = await addOrMergeMembers("c1", [
      { itemId: "i1", quantity: "2" },
      { itemId: "i1", quantity: "3" },
    ]);
    expect(res.data[0].quantity).toBe("1 + 2 + 3");
  });
});

describe("addOrMergeMembers — the ignoreDuplicates race", () => {
  it("merges into a row inserted concurrently instead of dropping the quantity", async () => {
    // i1 is absent at read time, but another writer inserts it with "9 raced"
    // before our upsert lands, so ON CONFLICT DO NOTHING skips ours.
    __state.racedInsert = ["i1"];
    const res = await addOrMergeMembers("c1", [{ itemId: "i1", quantity: "3" }]);
    expect(res.error).toBeNull();
    expect(res.inserted).toEqual([]);
    expect(res.merged).toEqual(["i1"]);
    expect(res.data[0].quantity).toBe("9 raced + 3");
  });
});
