import { saveGroup, planMembers, groupRow, defaultTypeId, restoreMember } from "./groupSave";
import { groupDisplayName } from "./groupModel";

// An in-memory storage with the same contract as utils/storage: set/patch return
// the row or false, delete returns true or false.
function fakeStorage({ failSetOn } = {}) {
  const rows = new Map();
  const log = [];
  return {
    rows,
    log,
    async set(key, value) {
      log.push(["set", key]);
      if (failSetOn && key.startsWith(failSetOn)) return false;
      rows.set(key, { ...rows.get(key), ...value });
      return rows.get(key);
    },
    async patch(key, fields) {
      log.push(["patch", key, fields]);
      if (!rows.has(key)) return false;
      rows.set(key, { ...rows.get(key), ...fields });
      return rows.get(key);
    },
    async delete(key) {
      log.push(["delete", key]);
      if (key.startsWith("group:")) {
        const id = key.slice(6);
        for (const [k, v] of rows) if (k.startsWith("group_member:") && v.groupId === id) rows.delete(k);
      }
      return rows.delete(key);
    },
  };
}

const ids = () => {
  let n = 0;
  return () => `id${++n}`;
};
const draftOf = (members, extra = {}) => ({ groupTypeId: "menu", contextId: "recipes", name: "", members, ...extra });
const m = (memberType, memberId, id) => ({ id, memberType, memberId });

test("create writes the group and its members in order", async () => {
  const storage = fakeStorage();
  const { group, members } = await saveGroup(
    { group: null, draft: draftOf([m("item", "rice"), m("item", "beans"), m("intention", "chips")]) },
    { storage, newId: ids() },
  );
  expect(group).toMatchObject({ id: "id1", name: null, groupTypeId: "menu", contextId: "recipes", pinned: false });
  expect(members.map((x) => [x.memberId, x.position, x.groupId])).toEqual([
    ["rice", 1, "id1"],
    ["beans", 2, "id1"],
    ["chips", 3, "id1"],
  ]);
});

test("create leaves nothing behind when a member write fails", async () => {
  const storage = fakeStorage({ failSetOn: "group_member:id3" });
  await expect(
    saveGroup({ group: null, draft: draftOf([m("item", "rice"), m("item", "beans")]) }, { storage, newId: ids() }),
  ).rejects.toThrow("Nothing was saved.");
  expect([...storage.rows.keys()]).toEqual([]);
});

test("reorder moves only the rows whose position changed", async () => {
  const existing = [
    { id: "a", memberType: "item", memberId: "rice", position: 1 },
    { id: "b", memberType: "item", memberId: "beans", position: 2 },
    { id: "c", memberType: "item", memberId: "salsa", position: 3 },
  ];
  const storage = fakeStorage();
  existing.forEach((x) => storage.rows.set(`group_member:${x.id}`, { ...x, groupId: "g" }));
  const { members } = await saveGroup(
    { group: { id: "g" }, draft: draftOf([m("item", "salsa", "c"), m("item", "rice", "a"), m("item", "beans", "b")]), existingMembers: existing },
    { storage, newId: ids() },
  );
  expect(members.map((x) => [x.id, x.position])).toEqual([["c", 1], ["a", 2], ["b", 3]]);
  expect(storage.log.filter((l) => l[0] === "patch").map((l) => l[1])).toEqual([
    "group_member:c", "group_member:a", "group_member:b",
  ]);
});

test("removing a member marks it removed and renumbers the rest", () => {
  const existing = [
    { id: "a", position: 1 },
    { id: "b", position: 2 },
    { id: "c", position: 3 },
    { id: "old", position: 1, removedAt: "2026-10-01" },
  ];
  expect(planMembers(existing, [m("item", "x", "a"), m("item", "z", "c")], ids())).toEqual({
    removes: ["b"],
    inserts: [],
    moves: [{ id: "c", position: 2 }],
    order: ["a", "c"],
  });
});

test("a removed member keeps its row, with removedAt set", async () => {
  const existing = [{ id: "a", memberType: "item", memberId: "rice", position: 1 }];
  const storage = fakeStorage();
  storage.rows.set("group_member:a", { ...existing[0], groupId: "g" });
  const { members, removed } = await saveGroup(
    { group: { id: "g" }, draft: draftOf([]), existingMembers: existing },
    { storage, newId: ids() },
  );
  expect(members).toEqual([]);
  expect(removed[0]).toMatchObject({ id: "a", removedAt: expect.any(String) });
  expect(storage.rows.get("group_member:a").removedAt).toEqual(expect.any(String));
  expect(storage.log.some((l) => l[0] === "delete")).toBe(false);
});

test("re-adding a removed member writes a new live row", () => {
  const existing = [{ id: "old", memberType: "item", memberId: "rice", position: 1, removedAt: "t" }];
  const plan = planMembers(existing, [m("item", "rice")], ids());
  expect(plan.inserts).toEqual([{ id: "id1", memberType: "item", memberId: "rice", position: 1 }]);
  expect(plan.removes).toEqual([]);
});

test("Put back adds a new live row at the end and keeps the removal", async () => {
  const storage = fakeStorage();
  const removedRow = { id: "old", groupId: "g", memberType: "item", memberId: "rice", position: 1, removedAt: "t" };
  storage.rows.set("group_member:old", removedRow);
  const members = [removedRow, { id: "b", groupId: "g", memberType: "item", memberId: "beans", position: 2 }];
  const back = await restoreMember(removedRow, members, { storage, newId: ids() });
  expect(back).toEqual({ id: "id1", groupId: "g", memberType: "item", memberId: "rice", position: 3 });
  expect(storage.rows.get("group_member:old")).toEqual(removedRow);
  expect(storage.log.some((l) => l[0] === "patch")).toBe(false);
});

test("Put back refuses a member already live", async () => {
  const removedRow = { id: "old", groupId: "g", memberType: "item", memberId: "rice", position: 1, removedAt: "t" };
  const live = { id: "n", groupId: "g", memberType: "item", memberId: "rice", position: 4 };
  await expect(
    restoreMember(removedRow, [removedRow, live], { storage: fakeStorage(), newId: ids() }),
  ).rejects.toThrow("already in the group");
});

test("an edit that fails is reported, not swallowed", async () => {
  const storage = fakeStorage();
  storage.rows.set("group:g", { id: "g" });
  await expect(
    saveGroup({ group: { id: "g" }, draft: draftOf([m("item", "x", "gone")]), existingMembers: [] }, { storage, newId: ids() }),
  ).rejects.toThrow("The new order was not saved.");
  expect(storage.rows.has("group:g")).toBe(true);
});

test("clearing the name stores null, so the derived name shows", async () => {
  expect(groupRow({ name: "   ", groupTypeId: "t" }).name).toBeNull();
  expect(groupRow({ name: " Taco night ", groupTypeId: "t" }).name).toBe("Taco night");
  const storage = fakeStorage();
  const { group } = await saveGroup({ group: { id: "g" }, draft: draftOf([], { name: "" }) }, { storage, newId: ids() });
  const lists = { members: [{ groupId: "g", memberType: "item", memberId: "rice", position: 1 }], items: [{ id: "rice", name: "Rice" }] };
  expect(groupDisplayName(group, lists)).toBe("Rice");
});

test("the type defaults to the context's default, then its first type", () => {
  const groupTypes = [{ id: "proj", contextId: "alfred" }, { id: "menu", contextId: "recipes" }, { id: "menu2", contextId: "recipes" }];
  expect(defaultTypeId("recipes", { contexts: [{ id: "recipes", defaultGroupTypeId: "menu2" }], groupTypes })).toBe("menu2");
  expect(defaultTypeId("recipes", { contexts: [{ id: "recipes" }], groupTypes })).toBe("menu");
  expect(defaultTypeId("home", { contexts: [], groupTypes })).toBe("proj");
});
