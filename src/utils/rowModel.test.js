import { buildRows, pickIntentionForItem, rankRows, rowSearchFields, ROW_ACCESSORS } from "./rowModel";

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

  it("ranks open runs, then scheduled by date, then unscheduled, background, closed", () => {
    const rows = buildRows({
      items: [],
      intents: [
        intent("closed", null, { status: "closed" }),
        intent("bg", null, { status: "background" }),
        intent("none", null),
        intent("later", null),
        intent("sooner", null),
        intent("running", null),
      ],
      events: [event("e1", "later", "2026-10-20"), event("e2", "sooner", "2026-10-14")],
      openExecutions: [{ id: "x", intentId: "running", status: "active" }],
    });
    expect(rankRows(rows).map((r) => r.intent.id)).toEqual(["running", "sooner", "later", "none", "bg", "closed"]);
  });

  it("searches the item's fields and every intention's text", () => {
    const [row] = buildRows({ items: [item("fan")], intents: [intent("replace motor", "fan")] });
    expect(rowSearchFields(row, (i) => [i.name])).toEqual(["fan", "replace motor"]);
  });
});
