import { buildGroupRows, buildRows, listRows, pickIntentionForItem, rowSearchFields, rowTabs, rowsForTab, sortByLastDone, ROW_ACCESSORS } from "./rowModel";

const DAILY = { type: "fixed", frequency: "daily", interval: 1 };
const ONCE = { type: "once" };

const item = (id, extra = {}) => ({ id, name: id, status: "active", tags: [], ...extra });
const intent = (id, itemId, extra = {}) => ({
  id, itemId, text: id, status: "active", recurrenceConfig: ONCE, tags: [], createdAt: "2026-10-01", ...extra,
});
const event = (id, intentId, time, extra = {}) => ({ id, intentId, time, archived: false, ...extra });

describe("buildRows", () => {
  it("merges an item and its intention into one row", () => {
    const rows = buildRows({ items: [item("fan")], intents: [intent("fix", "fan")] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "item:fan", kind: "item", intent: { id: "fix" } });
  });

  it("keeps an intention with no item as its own row", () => {
    const rows = buildRows({ items: [], intents: [intent("call", null)] });
    expect(rows.map((r) => r.key)).toEqual(["intent:call"]);
    expect(rows[0].item).toBeNull();
  });

  it("keeps an intention whose item is not on the page as its own row", () => {
    const rows = buildRows({ items: [item("a")], intents: [intent("x", "elsewhere")] });
    expect(rows.map((r) => r.key)).toEqual(["item:a", "intent:x"]);
  });

  it("shows one row for an item with several intentions", () => {
    const rows = buildRows({
      items: [item("fan")],
      intents: [intent("a", "fan"), intent("b", "fan")],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].intents.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("ignores archived intentions", () => {
    const rows = buildRows({ items: [item("fan")], intents: [intent("a", "fan", { archived: true })] });
    expect(rows[0].intent).toBeNull();
  });

  it("leaves out items with no intention when asked", () => {
    const rows = buildRows({ items: [item("a"), item("b")], intents: [intent("x", "b")], itemsWithoutIntents: false });
    expect(rows.map((r) => r.key)).toEqual(["item:b"]);
  });

  it("carries the picked intention's live event and open run", () => {
    const rows = buildRows({
      items: [item("fan")],
      intents: [intent("a", "fan")],
      events: [event("e2", "a", "2026-10-20"), event("e1", "a", "2026-10-15"), event("old", "a", "2026-10-01", { archived: true })],
      openExecutions: [{ id: "x", intentId: "a", status: "paused" }],
    });
    expect(rows[0].event.id).toBe("e1");
    expect(rows[0].open.id).toBe("x");
  });

  it("unions item and intention tags", () => {
    const rows = buildRows({
      items: [item("fan", { tags: ["home"] })],
      intents: [intent("a", "fan", { tags: ["repair", "home"] })],
    });
    expect(rows[0].tags).toEqual(["home", "repair"]);
  });
});

describe("row status", () => {
  it("is the item's status on a merged row, not the intention's", () => {
    const rows = buildRows({ items: [item("fan", { status: "someday" })], intents: [intent("a", "fan", { status: "background" })] });
    expect(rows[0].status).toBe("someday");
    expect(rows[0].intent.id).toBe("a");
  });

  it("is the item's status when it has no intention", () => {
    expect(buildRows({ items: [item("fan", { status: "someday" })] })[0].status).toBe("someday");
  });

  it("is the intention's own status on an intention-only row", () => {
    expect(buildRows({ intents: [intent("a", null, { status: "background" })] })[0].status).toBe("background");
  });

  it("picks nothing when every intention is closed, and reads the item's status", () => {
    const rows = buildRows({
      items: [item("fan", { status: "active" })],
      intents: [intent("old", "fan", { status: "closed" }), intent("new", "fan", { status: "closed" })],
    });
    expect(rows[0].intent).toBeNull();
    expect(rows[0].intents).toHaveLength(2);
    expect(rows[0].status).toBe("active");
  });
});

describe("pickIntentionForItem: the Run Now rule", () => {
  it("prefers an intention with an open run", () => {
    const intents = [intent("rec", "fan", { recurrenceConfig: DAILY }), intent("run", "fan")];
    const open = [{ id: "x", intentId: "run", status: "active" }];
    expect(pickIntentionForItem("fan", intents, [], open).id).toBe("run");
  });

  it("then a recurring one, earliest live event first", () => {
    const intents = [
      intent("late", "fan", { recurrenceConfig: DAILY }),
      intent("soon", "fan", { recurrenceConfig: DAILY }),
      intent("oneoff", "fan", { createdAt: "2026-10-09" }),
    ];
    const events = [event("e1", "late", "2026-10-20"), event("e2", "soon", "2026-10-14")];
    expect(pickIntentionForItem("fan", intents, events, []).id).toBe("soon");
  });

  it("then the newest one-off", () => {
    const intents = [intent("a", "fan", { createdAt: "2026-10-01" }), intent("b", "fan", { createdAt: "2026-10-05" })];
    expect(pickIntentionForItem("fan", intents, [], []).id).toBe("b");
  });

  it("never a closed one while another is open", () => {
    const intents = [intent("done", "fan", { status: "closed", createdAt: "2026-10-09" }), intent("live", "fan")];
    expect(pickIntentionForItem("fan", intents, [], []).id).toBe("live");
  });
});

describe("row sort, rank and search", () => {
  it("dates an item row by its latest change, item or intention", () => {
    const [row] = buildRows({
      items: [item("fan", { updatedAt: "2026-10-01T00:00:00Z" })],
      intents: [intent("a", "fan", { updatedAt: "2026-10-05T00:00:00Z" })],
    });
    expect(ROW_ACCESSORS.updated(row)).toBe("2026-10-05T00:00:00Z");
    expect(ROW_ACCESSORS.title(row)).toBe("fan");
  });

  it("listRows: leaves rows with an open run out of the list and its counts", () => {
    const open = [
      { id: "x", intentId: "running", status: "active" },
      { id: "y", intentId: "other", itemIds: ["fan"], status: "paused" },
    ];
    const rows = buildRows({
      items: [item("fan")],
      intents: [intent("running", null), intent("idle", null)],
      openExecutions: open,
    });
    const out = listRows({
      rows, openExecutions: open, itemFields: (i) => [i.name], statuses: ["active"], sortKey: "title", sortDir: "asc",
    });
    expect(out.visibleRows.map((r) => r.key)).toEqual(["intent:idle"]);
    expect(out.statusCounts.active).toBe(1);
    expect(out.total).toBe(1);
  });

  it("listRows: Last modified orders by the date the card shows", () => {
    const rows = buildRows({
      items: [item("fan", { updatedAt: "2026-10-01" })],
      intents: [
        intent("a", "fan", { updatedAt: "2026-10-12" }),
        intent("b", null, { updatedAt: "2026-10-05" }),
      ],
      events: [event("e", "b", "2026-10-14")],
    });
    const { visibleRows } = listRows({
      rows, itemFields: (i) => [i.name], statuses: ["active", "someday"], sortKey: "updated", sortDir: "desc",
    });
    expect(visibleRows.map((r) => r.key)).toEqual(["item:fan", "intent:b"]);
  });

  it("listRows: each filter's counts apply the others", () => {
    const rows = buildRows({
      items: [item("fan", { tags: ["home"] })],
      intents: [intent("call", null, { tags: ["home"], status: "closed" }), intent("buy", null, { tags: ["shop"] })],
    });
    const out = listRows({
      rows, search: "a", itemFields: (i) => [i.name], filterTag: "home", statuses: ["active"], sortKey: "title", sortDir: "asc",
    });
    expect(out.statusCounts).toMatchObject({ active: 1, closed: 1 });
    expect(out.tagCountRows.map((r) => r.key)).toEqual(["item:fan"]);
  });

  it("searches the item's fields and every intention's text", () => {
    const [row] = buildRows({ items: [item("fan")], intents: [intent("replace motor", "fan")] });
    expect(rowSearchFields(row, (i) => [i.name])).toEqual(["fan", "replace motor"]);
  });
});

// Restructure P5 step 11: groups in the same list.
describe("a group's own intention (step 13)", () => {
  const own = { id: "o", groupId: "g", text: "Rice + Beans" };
  const live = { id: "e", intentId: "o", time: "2099-01-05", archived: false };

  it("is never an intention row", () => {
    expect(buildRows({ intents: [own, { id: "x", text: "Call" }] }).map((r) => r.key)).toEqual(["intent:x"]);
  });

  it("gives the group row its live date and open run", () => {
    const run = { id: "r", intentId: "o", status: "paused" };
    const [row] = buildGroupRows({ groups: [{ id: "g", groupTypeId: "menu" }], intents: [own], events: [live], openExecutions: [run] });
    expect(row).toMatchObject({ ownIntent: own, event: live, open: run, intents: [] });
    expect(buildGroupRows({ groups: [{ id: "g" }] })[0]).toMatchObject({ ownIntent: null, event: null, open: null });
  });

  it("a project row carries its members' run state (step 15)", () => {
    const [row] = buildGroupRows({
      groups: [{ id: "p", groupTypeId: "proj" }],
      groupTypes: [{ id: "proj", executionMode: "separately" }],
      members: [{ id: "m", groupId: "p", memberType: "intention", memberId: "bug", position: 1 }],
      intents: [{ id: "bug", text: "Bug A" }],
      openExecutions: [{ id: "x", intentId: "bug", status: "paused" }],
    });
    expect(row.memberRun).toBe("paused");
  });
});

describe("group rows", () => {
  const menuType = { id: "menu", labelPlural: "Menus", executionMode: "together" };
  const projType = { id: "proj", labelPlural: "Projects", executionMode: "separately" };
  const groupItems = [
    { id: "rice", name: "Rice", tags: ["side"] },
    { id: "beans", name: "Beans", tags: ["protein"] },
    { id: "gone", name: "Gone", tags: ["hidden"], archived: true },
  ];
  const members = [
    { id: "a", groupId: "g1", memberType: "item", memberId: "rice", position: 1 },
    { id: "b", groupId: "g1", memberType: "item", memberId: "beans", position: 2 },
    { id: "c", groupId: "g1", memberType: "item", memberId: "gone", position: 3 },
    { id: "d", groupId: "g1", memberType: "item", memberId: "salsa", position: 4, removedAt: "t" },
  ];
  const groups = [
    { id: "g1", groupTypeId: "menu", name: null, status: "active", updatedAt: "2026-10-02", lastCompletedAt: "2026-10-20" },
    { id: "g2", groupTypeId: "proj", name: "Kitchen remodel", status: "someday", updatedAt: "2026-10-05" },
    { id: "g3", groupTypeId: "menu", name: "Old", archived: true },
  ];
  const groupRows = () =>
    buildGroupRows({ groups, groupTypes: [menuType, projType], members, items: groupItems, intents: [] });
  const all = (sortKey = "updated", sortDir = "desc", extra = {}) =>
    listRows({
      rows: [
        ...buildRows({ items: [{ id: "pot", name: "Pot", updatedAt: "2026-10-03", lastCompletedAt: "2026-10-10" }] }),
        ...groupRows(),
      ],
      itemFields: (i) => [i.name],
      statuses: ["someday", "active", "background", "closed"],
      sortKey,
      sortDir,
      ...extra,
    });

  it("one row per live group, named and tagged from live members", () => {
    const [menu, project] = groupRows();
    expect(groupRows()).toHaveLength(2);
    expect(menu).toMatchObject({ kind: "group", name: "Rice + Beans", memberCount: 2, tags: ["side", "protein"] });
    expect(project).toMatchObject({ name: "Kitchen remodel", memberCount: 0, tags: [] });
  });

  it("search finds a group by its derived name or a member's name", () => {
    const names = (search) => all("title", "asc", { search }).visibleRows.map((r) => r.name);
    expect(names("rice + beans")).toEqual(["Rice + Beans"]);
    expect(names("beans")).toEqual(["Rice + Beans"]);
    expect(names("gone")).toEqual([]);
  });

  it("the tag filter matches a group through its live members' tags", () => {
    expect(all("title", "asc", { filterTag: "protein" }).visibleRows.map((r) => r.name)).toEqual(["Rice + Beans"]);
    expect(all("title", "asc", { filterTag: "hidden" }).visibleRows).toEqual([]);
  });

  it("status counts include groups", () => {
    expect(all().statusCounts).toMatchObject({ active: 1, someday: 2 });
  });

  it("sorts groups and items mixed, by Last modified and by Last done (never done = oldest)", () => {
    expect(all("updated", "desc").visibleRows.map((r) => r.name)).toEqual(["Kitchen remodel", "Pot", "Rice + Beans"]);
    expect(all("done", "desc").visibleRows.map((r) => r.name)).toEqual(["Rice + Beans", "Pot", "Kitchen remodel"]);
    // Oldest first: the never-done project comes first.
    expect(all("done", "asc").visibleRows.map((r) => r.name)).toEqual(["Kitchen remodel", "Pot", "Rice + Beans"]);
  });

  it("on the same Last done day a group comes before its items, then by name", () => {
    const sameDay = "2026-10-21T18:00:00";
    const rows = [
      { kind: "item", name: "Beans", lastCompletedAt: "2026-10-21T19:30:00" },
      { kind: "item", name: "Apple pie", lastCompletedAt: sameDay },
      { kind: "group", name: "Rice + Beans", lastCompletedAt: "2026-10-21T17:00:00" },
      { kind: "item", name: "Never" },
    ];
    expect(sortByLastDone(rows, "desc").map((r) => r.name)).toEqual(["Rice + Beans", "Apple pie", "Beans", "Never"]);
    expect(sortByLastDone(rows, "asc").map((r) => r.name)).toEqual(["Never", "Rice + Beans", "Apple pie", "Beans"]);
  });

  it("tabs: none without groups; All, one per type, Items and intentions, with counts", () => {
    expect(rowTabs(buildRows({ items: [item("pot")] }))).toEqual([]);
    const rows = all().visibleRows;
    expect(rowTabs(rows).map((t) => [t.key, t.label, t.count])).toEqual([
      ["all", "All", 3],
      ["type:proj", "Projects", 1],
      ["type:menu", "Menus", 1],
      ["items", "Items and intentions", 1],
    ]);
    expect(rowsForTab(rows, "type:menu").map((r) => r.name)).toEqual(["Rice + Beans"]);
    expect(rowsForTab(rows, "items").map((r) => r.name)).toEqual(["Pot"]);
  });
});
