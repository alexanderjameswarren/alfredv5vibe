import { runNowTargetForItem, isDueBy, hasFutureLiveEvent } from "./runNow";

const daily = { type: "fixed", frequency: "daily", interval: 1 };
const once = { type: "once" };
const intent = (id, over = {}) => ({ id, itemId: "item-1", archived: false, ...over });
const event = (id, intentId, time, over = {}) => ({ id, intentId, time, archived: false, ...over });

describe("runNowTargetForItem", () => {
  test("none live -> null", () => {
    const intents = [intent("a", { archived: true, recurrenceConfig: daily }), intent("b", { itemId: "other" })];
    expect(runNowTargetForItem("item-1", intents, [])).toBeNull();
  });

  test("recurring beats a newer one-off", () => {
    const intents = [
      intent("rec", { recurrenceConfig: daily, createdAt: "2026-09-10" }),
      intent("one", { recurrenceConfig: once, createdAt: "2026-10-01" }),
    ];
    const t = runNowTargetForItem("item-1", intents, [event("e1", "rec", "2026-10-07")]);
    expect(t.intent.id).toBe("rec");
    expect(t.event.id).toBe("e1");
  });

  test("several recurring -> earliest live event", () => {
    const intents = [intent("r1", { recurrenceConfig: daily }), intent("r2", { recurrenceConfig: daily }), intent("r3", { recurrenceConfig: daily })];
    const events = [
      event("x", "r1", "2026-10-09"),
      event("y", "r2", "2026-10-06"),
      event("z", "r2", "2026-10-01", { archived: true }),
    ];
    const t = runNowTargetForItem("item-1", intents, events);
    expect(t.intent.id).toBe("r2");
    expect(t.event.id).toBe("y");
  });

  test("only one-offs -> newest", () => {
    const intents = [
      intent("old", { recurrenceConfig: once, createdAt: "2026-09-12T10:00:00Z" }),
      intent("new", { recurrenceConfig: once, createdAt: "2026-10-01T10:00:00Z" }),
    ];
    expect(runNowTargetForItem("item-1", intents, []).intent.id).toBe("new");
  });

  test("legacy recurrence string counts as recurring", () => {
    const intents = [intent("leg", { recurrence: "daily" }), intent("one", { recurrenceConfig: once, createdAt: "2026-10-01" })];
    expect(runNowTargetForItem("item-1", intents, []).intent.id).toBe("leg");
  });
});

describe("isDueBy", () => {
  test("today and earlier are due; later and missing are not", () => {
    expect(isDueBy(event("e", "i", "2026-10-06"), "2026-10-06")).toBe(true);
    expect(isDueBy(event("e", "i", "2026-10-01"), "2026-10-06")).toBe(true);
    expect(isDueBy(event("e", "i", "2026-10-07"), "2026-10-06")).toBe(false);
    expect(isDueBy(null, "2026-10-06")).toBe(false);
  });
});

describe("hasFutureLiveEvent", () => {
  const today = "2026-10-06";

  test("future live event -> true", () => {
    expect(hasFutureLiveEvent("i", [event("f", "i", "2026-10-08")], "done", today)).toBe(true);
  });

  test("ignores the just-archived event, still live in a stale list", () => {
    expect(hasFutureLiveEvent("i", [event("done", "i", "2026-10-07")], "done", today)).toBe(false);
  });

  test("ignores archived, past, today, and other intentions", () => {
    const events = [
      event("a", "i", "2026-10-09", { archived: true }),
      event("b", "i", "2026-10-05"),
      event("c", "i", today),
      event("d", "other", "2026-10-09"),
    ];
    expect(hasFutureLiveEvent("i", events, "done", today)).toBe(false);
  });
});
