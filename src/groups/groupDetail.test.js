import { groupTitle, memberRows, recentRemovals } from "./groupDetail";

const items = [
  { id: "rice", name: "Rice" },
  { id: "beans", name: "Beans" },
  { id: "salsa", name: "Salsa" },
];
const intents = [
  { id: "cook-rice", text: "Cook rice", itemId: "rice" },
  { id: "chips", text: "Buy chips" },
];
const m = (id, memberType, memberId, position, extra = {}) => ({ id, groupId: "g", memberType, memberId, position, ...extra });
const members = [
  m("m3", "intention", "chips", 3),
  m("m1", "item", "beans", 1),
  m("m2", "item", "rice", 2),
  m("m0", "item", "salsa", 1, { removedAt: "2026-10-22T09:00:00Z" }),
];
const lists = { members, items, intents };

test("the title is the typed name, else the derived name, else the type's word", () => {
  expect(groupTitle({ id: "g", name: "Taco night" }, lists)).toBe("Taco night");
  expect(groupTitle({ id: "g", name: null }, lists)).toBe("Beans + Rice + Buy chips");
  expect(groupTitle({ id: "empty", name: null }, lists, { labelSingular: "Menu" })).toBe("Untitled menu");
});

test("members are standard rows in position order, removed ones hidden", () => {
  const rows = memberRows("g", lists);
  expect(rows.map((r) => r.name)).toEqual(["Beans", "Rice", "Buy chips"]);
  // An item row carries its own intentions, as on the context page.
  expect(rows[1]).toMatchObject({ kind: "item", intent: { id: "cook-rice" } });
  expect(rows[2]).toMatchObject({ kind: "intention", intent: { id: "chips" } });
});

test("recently removed: newest first, one line per member, none that are back", () => {
  const history = [
    ...members,
    m("r1", "item", "salsa", 4, { removedAt: "2026-10-21T09:00:00Z" }),
    m("r2", "item", "beans", 5, { removedAt: "2026-10-22T10:00:00Z" }), // beans is live again
  ];
  expect(recentRemovals("g", { ...lists, members: history }).map((r) => r.member.id)).toEqual(["m0"]);
});
