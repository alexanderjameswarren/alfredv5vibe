/**
 * Tests for collection tags: the remove-and-restore round trip,
 * `updateMemberTags`, and `loadCollectionTagPool`.
 *
 * A separate file from `collectionMembers.test.js` on purpose. That file's mock
 * is built tightly around `addOrMergeMembers` and models only
 * `collection_items`; these tests need `collection_item_removals` too, and
 * widening the older mock to carry both would put its 19 existing assertions at
 * risk for no gain. Two small honest mocks beat one large one.
 *
 * The leak regression — item tags must not reach a collection row — lives in
 * the other file, because it runs through `addOrMergeMembers` and needs that
 * mock.
 */

jest.mock("../supabaseClient", () => {
  const state = { members: [], removals: [], failOn: null };
  const done = (data, error = null) => Promise.resolve({ data, error });

  // A builder that resolves however the caller happens to finish the chain.
  // PostgREST lets you await after .eq(), .order() or .limit(); the code under
  // test uses all three shapes.
  function thenable(rowsFn) {
    const b = {
      eq: () => b,
      in: () => b,
      order: () => b,
      limit: (n) => {
        b.__limit = n;
        return b;
      },
      select: () => b,
      then: (resolve, reject) =>
        done(rowsFn(b.__limit)).then(resolve, reject),
    };
    return b;
  }

  function from(table) {
    const rows = () => (table === "collection_items" ? state.members : state.removals);

    return {
      select: () => {
        if (state.failOn === table) {
          const b = thenable(() => []);
          b.then = (resolve) => resolve({ data: null, error: { message: `${table} boom` } });
          return b;
        }
        return thenable((limit) => {
          const all = rows().slice();
          return limit ? all.slice(0, limit) : all;
        });
      },

      insert: (payload) => ({
        select: () => {
          const inserted = (Array.isArray(payload) ? payload : [payload]).map(
            (row, i) => ({ id: `r-${state.removals.length + i}`, ...row }),
          );
          state.removals.push(...inserted);
          return done(inserted);
        },
      }),

      upsert: (rowsIn) => ({
        select: () => {
          const inserted = [];
          for (const row of rowsIn) {
            if (state.members.some((m) => m.item_id === row.item_id)) continue;
            const stored = { id: `m-${row.item_id}`, ...row };
            state.members.push(stored);
            inserted.push(stored);
          }
          return done(inserted);
        },
      }),

      update: (patch) => {
        const b = {
          __eq: {},
          eq: (col, val) => {
            b.__eq[col] = val;
            return b;
          },
          select: () => {
            if (state.failOn === "update")
              return done(null, { message: "update boom" });
            const target = state.members.find(
              (m) => m.item_id === b.__eq.item_id && m.collection_id === b.__eq.collection_id,
            );
            if (!target) return done([]);
            Object.assign(target, patch); // mutate, so state reflects the write
            return done([target]);
          },
        };
        return b;
      },

      delete: () => {
        const b = {
          eq: () => b,
          in: (_col, ids) => {
            state.members = state.members.filter((m) => !ids.includes(m.id));
            return done(null);
          },
        };
        return b;
      },
    };
  }

  return { supabase: { from }, __state: state };
});

const { __state } = require("../supabaseClient");
const {
  removeMember,
  reAddRemoval,
  updateMemberTags,
  addMember,
  loadCollectionTagPool,
  loadRemovals,
} = require("./collectionMembers");

const member = (itemId, tags = [], quantity = null, position = 0) => ({
  id: `m-${itemId}`,
  collection_id: "c1",
  item_id: itemId,
  quantity,
  tags,
  position,
});

beforeEach(() => {
  __state.members = [];
  __state.removals = [];
  __state.failOn = null;
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("a tag survives remove and restore", () => {
  it("snapshots the tags onto the removal record", async () => {
    __state.members.push(member("eggs", ["tjs"], "1 dozen"));

    const res = await removeMember("c1", "eggs");

    expect(res.error).toBeNull();
    expect(__state.removals).toHaveLength(1);
    expect(__state.removals[0].tags).toEqual(["tjs"]);
    expect(__state.members).toHaveLength(0);
  });

  it("puts the tags back when the removal is restored", async () => {
    // The whole round trip, which is the point of the feature: take eggs off
    // the list by mistake, put them back, and they are still a Trader Joe's
    // item rather than an untagged orphan.
    __state.members.push(member("eggs", ["tjs"], "1 dozen"));

    await removeMember("c1", "eggs");
    const removal = (await loadRemovals("c1")).data[0];
    const res = await reAddRemoval(removal);

    expect(res.error).toBeNull();
    const restored = __state.members.find((m) => m.item_id === "eggs");
    expect(restored.tags).toEqual(["tjs"]);
    expect(restored.quantity).toBe("1 dozen");
  });

  it("restores several tags, not just the first", async () => {
    __state.members.push(member("milk", ["whole foods", "dairy"]));

    await removeMember("c1", "milk");
    const removal = (await loadRemovals("c1")).data[0];
    await reAddRemoval(removal);

    expect(__state.members[0].tags).toEqual(["whole foods", "dairy"]);
  });

  it("restores an untagged item as untagged, not as null", async () => {
    __state.members.push(member("bread"));

    await removeMember("c1", "bread");
    const removal = (await loadRemovals("c1")).data[0];
    await reAddRemoval(removal);

    expect(__state.members[0].tags).toEqual([]);
  });
});

describe("a fresh add is always untagged", () => {
  it("gives a new member an empty tags array", async () => {
    // Spec §11: tags are never applied when an item is added to a collection.
    const res = await addMember("c1", "flour", { quantity: "1 bag" });

    expect(res.error).toBeNull();
    expect(__state.members[0].tags).toEqual([]);
  });
});

describe("updateMemberTags", () => {
  it("replaces the tag list", async () => {
    __state.members.push(member("eggs", ["tjs"]));

    const res = await updateMemberTags("c1", "eggs", ["whole foods"]);

    expect(res.error).toBeNull();
    expect(__state.members[0].tags).toEqual(["whole foods"]);
  });

  it("clears the column when the last chip is removed", async () => {
    // An incoming [] means "the user removed the last tag" and must be written,
    // not treated as "nothing to do".
    __state.members.push(member("eggs", ["tjs"]));

    await updateMemberTags("c1", "eggs", []);

    expect(__state.members[0].tags).toEqual([]);
  });

  it("writes tags and nothing else", async () => {
    __state.members.push(member("eggs", ["tjs"], "1 dozen", 3));

    await updateMemberTags("c1", "eggs", ["whole foods"]);

    const row = __state.members[0];
    expect(row.quantity).toBe("1 dozen");
    expect(row.position).toBe(3);
  });

  it("deduplicates and drops blanks rather than storing them", async () => {
    __state.members.push(member("eggs"));

    await updateMemberTags("c1", "eggs", ["tjs", "tjs", "", null, 42]);

    expect(__state.members[0].tags).toEqual(["tjs"]);
  });

  it("reports a row that is no longer in the collection", async () => {
    const res = await updateMemberTags("c1", "ghost", ["tjs"]);

    expect(res.data).toBeNull();
    expect(res.error).toMatch(/no longer in this collection/);
  });

  it("requires both ids and never throws", async () => {
    await expect(updateMemberTags("", "eggs", [])).resolves.toMatchObject({
      data: null,
    });
    await expect(updateMemberTags("c1", "", [])).resolves.toMatchObject({
      data: null,
    });
  });
});

describe("loadCollectionTagPool", () => {
  it("unions tags from current members and removal history", async () => {
    __state.members.push(member("eggs", ["tjs"]));
    __state.removals.push({ tags: ["whole foods"] });

    const res = await loadCollectionTagPool("c1");

    expect(res.error).toBeNull();
    expect(res.data.sort()).toEqual(["tjs", "whole foods"]);
  });

  it("still offers a store tag after the list has been emptied", async () => {
    // The reason the removals half exists. Finish the shop, tick everything
    // off, and "tjs" must still be suggested next week instead of retyped.
    __state.removals.push({ tags: ["tjs"] }, { tags: ["tjs"] });
    expect(__state.members).toHaveLength(0);

    const res = await loadCollectionTagPool("c1");

    expect(res.data).toEqual(["tjs"]);
  });

  it("deduplicates across the two sources", async () => {
    __state.members.push(member("eggs", ["tjs"]));
    __state.removals.push({ tags: ["tjs"] });

    const res = await loadCollectionTagPool("c1");

    expect(res.data).toEqual(["tjs"]);
  });

  it("orders by frequency, ties alphabetical", async () => {
    __state.members.push(member("a", ["tjs"]), member("b", ["tjs"]));
    __state.removals.push({ tags: ["whole foods"] }, { tags: ["aldi"] });

    const res = await loadCollectionTagPool("c1");

    expect(res.data).toEqual(["tjs", "aldi", "whole foods"]);
  });

  it("caps the removal-history read", async () => {
    __state.removals = Array.from({ length: 900 }, (_, i) => ({
      tags: [`tag ${i}`],
    }));

    const res = await loadCollectionTagPool("c1");

    expect(res.data).toHaveLength(500);
  });

  it("returns a usable pool when one source fails", async () => {
    // A picker with fewer suggestions still lets you create a tag. A blocked
    // control does not.
    __state.members.push(member("eggs", ["tjs"]));
    __state.failOn = "collection_item_removals";

    const res = await loadCollectionTagPool("c1");

    expect(res.error).toBeNull();
    expect(res.data).toEqual(["tjs"]);
  });

  it("ignores rows with no tags", async () => {
    __state.members.push(member("eggs"), member("milk", ["tjs"]));
    __state.removals.push({ tags: null }, { tags: [] });

    const res = await loadCollectionTagPool("c1");

    expect(res.data).toEqual(["tjs"]);
  });

  it("requires a collectionId and never throws", async () => {
    await expect(loadCollectionTagPool("")).resolves.toMatchObject({
      data: null,
    });
  });
});
