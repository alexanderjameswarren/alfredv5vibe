import {
  liveMembers,
  derivedGroupName,
  groupDisplayName,
  groupsForRecord,
  groupIntention,
  groupIcon,
  hasRunningMember,
  memberRunState,
  removedMembers,
} from "./groupModel";

const items = [
  { id: "rice", name: "Rice" },
  { id: "beans", name: "Beans" },
  { id: "salsa", name: "Salsa" },
  { id: "old", name: "Old slaw", archived: true },
];
const intents = [
  { id: "i-chips", text: "Buy chips" },
  { id: "i-rice", text: "Cook rice", itemId: "rice" },
];
const m = (id, groupId, memberType, memberId, position) => ({ id, groupId, memberType, memberId, position });
const members = [
  m("m3", "g1", "item", "salsa", 3),
  m("m1", "g1", "item", "rice", 1),
  m("m4", "g1", "item", "old", 4),
  m("m2", "g1", "item", "beans", 2),
  m("m5", "g1", "intention", "i-chips", 5),
  m("m6", "g1", "item", "gone", 6),
  m("m7", "g2", "item", "rice", 1),
];
const lists = { members, items, intents };

describe("liveMembers", () => {
  it("orders by position and leaves out archived and deleted members", () => {
    expect(liveMembers("g1", lists).map((x) => x.member.id)).toEqual(["m1", "m2", "m3", "m5"]);
  });

  it("names intentions by their text", () => {
    expect(liveMembers("g1", lists).at(-1)).toMatchObject({ memberType: "intention", name: "Buy chips" });
  });
});

describe("derived name", () => {
  it("joins live members with ' + '", () => {
    expect(derivedGroupName("g1", lists)).toBe("Rice + Beans + Salsa + Buy chips");
  });

  it("follows a renamed member", () => {
    const renamed = { ...lists, items: items.map((i) => (i.id === "beans" ? { ...i, name: "Black beans" } : i)) };
    expect(derivedGroupName("g1", renamed)).toBe("Rice + Black beans + Salsa + Buy chips");
  });

  it("drops a member once it is archived", () => {
    const archived = { ...lists, items: items.map((i) => (i.id === "salsa" ? { ...i, archived: true } : i)) };
    expect(derivedGroupName("g1", archived)).toBe("Rice + Beans + Buy chips");
  });

  it("uses a typed name, and derives when it is null or blank", () => {
    expect(groupDisplayName({ id: "g2", name: "Taco night" }, lists)).toBe("Taco night");
    expect(groupDisplayName({ id: "g2", name: null }, lists)).toBe("Rice");
    expect(groupDisplayName({ id: "g2", name: "  " }, lists)).toBe("Rice");
  });

  it("is empty for a group with no live members", () => {
    expect(derivedGroupName("g9", lists)).toBe("");
  });
});

describe("removed members", () => {
  it("leave the list, the derived name and the item-to-groups lookup", () => {
    const one = { members: [{ ...m("x", "g5", "item", "rice", 1), removedAt: "t" }], items, intents };
    expect(liveMembers("g5", one)).toEqual([]);
    expect(derivedGroupName("g5", one)).toBe("");
    expect(groupsForRecord("item", "rice", { groups: [{ id: "g5" }], members: one.members })).toEqual([]);
  });

  it("are listed newest first in the history", () => {
    const history = removedMembers("g1", {
      ...lists,
      members: [
        { ...m("r1", "g1", "item", "rice", 1), removedAt: "2026-10-20T00:00:00Z" },
        { ...m("r2", "g1", "item", "gone", 2), removedAt: "2026-10-21T00:00:00Z" },
        m("live", "g1", "item", "beans", 3),
      ],
    });
    expect(history.map((h) => [h.member.id, h.name])).toEqual([["r2", "Unavailable"], ["r1", "Rice"]]);
  });
});

describe("groupsForRecord", () => {
  const groups = [{ id: "g1" }, { id: "g2" }, { id: "g3", archived: true }];
  const withArchived = [...members, m("m8", "g3", "item", "rice", 1)];

  it("finds every live group an item is in", () => {
    expect(groupsForRecord("item", "rice", { groups, members: withArchived }).map((g) => g.id)).toEqual(["g1", "g2"]);
  });

  it("keeps items and intentions apart", () => {
    expect(groupsForRecord("intention", "rice", { groups, members })).toEqual([]);
    expect(groupsForRecord("intention", "i-chips", { groups, members }).map((g) => g.id)).toEqual(["g1"]);
  });
});

describe("groupIntention and groupIcon", () => {
  it("picks the group's non-archived intention", () => {
    const list = [{ id: "a", groupId: "g1", archived: true }, { id: "b", groupId: "g1" }, { id: "c" }];
    expect(groupIntention("g1", list).id).toBe("b");
    expect(groupIntention("g2", list)).toBeNull();
  });

  it("falls back to Boxes", () => {
    expect(groupIcon({ groupTypeId: "t1" }, [{ id: "t1", icon: "UtensilsCrossed" }])).toBe("UtensilsCrossed");
    expect(groupIcon({ groupTypeId: "nope" }, [])).toBe("Boxes");
  });
});

describe("hasRunningMember", () => {
  const groupTypes = [
    { id: "proj", executionMode: "separately" },
    { id: "menu", executionMode: "together" },
  ];
  const project = { id: "g1", groupTypeId: "proj" };
  const base = { groupTypes, ...lists };

  it("sees a running execution on a member intention", () => {
    expect(hasRunningMember(project, { ...base, activeExecutions: [{ intentId: "i-chips", status: "active" }] })).toBe(true);
  });

  it("sees one on a member item's intention or in item_ids", () => {
    expect(hasRunningMember(project, { ...base, activeExecutions: [{ intentId: "i-rice", status: "active" }] })).toBe(true);
    expect(hasRunningMember(project, { ...base, activeExecutions: [{ itemIds: ["beans"], status: "active" }] })).toBe(true);
  });

  it("ignores paused executions, archived members and together groups", () => {
    expect(hasRunningMember(project, { ...base, activeExecutions: [{ intentId: "i-chips", status: "paused" }] })).toBe(false);
    expect(hasRunningMember(project, { ...base, activeExecutions: [{ itemIds: ["old"], status: "active" }] })).toBe(false);
    expect(
      hasRunningMember({ id: "g1", groupTypeId: "menu" }, { ...base, activeExecutions: [{ intentId: "i-chips", status: "active" }] })
    ).toBe(false);
  });

  it("memberRunState: running wins over paused; paused alone; nothing; never on a menu", () => {
    const run = (status, x = { intentId: "i-chips" }) => ({ ...x, status });
    expect(memberRunState(project, { ...base, openExecutions: [run("paused"), run("active", { itemIds: ["beans"] })] })).toBe("active");
    expect(memberRunState(project, { ...base, openExecutions: [run("paused", { intentId: "i-rice" })] })).toBe("paused");
    expect(memberRunState(project, { ...base, openExecutions: [run("active", { intentId: "elsewhere" })] })).toBeNull();
    expect(memberRunState({ id: "g1", groupTypeId: "menu" }, { ...base, openExecutions: [run("active")] })).toBeNull();
  });
});
