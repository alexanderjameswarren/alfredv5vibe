import { intentionRowFromTriage } from "./triageRows";
import { toSnakeCase } from "./caseConvert";

// Written because "is Details actually being saved?" could not be answered by a
// test — the mapping lived inside a 12,900-line component. It can now.

const base = {
  id: "intent-1",
  userId: "user-1",
  sourceInboxId: "inbox-1",
  createdAt: "2026-09-24T10:00:00.000Z",
};

describe("intentionRowFromTriage — the Details column", () => {
  it("writes a typed value verbatim", () => {
    const row = intentionRowFromTriage({
      ...base,
      intentionData: {
        text: "Replace the vent fan motor",
        description: "Model number is behind the grille. Check a motor fits first.",
      },
    });
    expect(row.description).toBe("Model number is behind the grille. Check a motor fits first.");
  });

  it("keeps newlines, because Details is a long-text field", () => {
    const row = intentionRowFromTriage({
      ...base,
      intentionData: { text: "x", description: "First line.\n\nSecond line." },
    });
    expect(row.description).toBe("First line.\n\nSecond line.");
  });

  it("trims the outside without touching the inside", () => {
    const row = intentionRowFromTriage({
      ...base,
      intentionData: { text: "x", description: "  keep  the   middle  " },
    });
    expect(row.description).toBe("keep  the   middle");
  });

  it("is null when nothing was written, which is the column's contract", () => {
    // Migration 069 rejected `not null default ''` precisely so that "no details"
    // and "details deliberately emptied" are not the same value.
    expect(intentionRowFromTriage({ ...base, intentionData: { text: "x" } }).description).toBeNull();
    expect(
      intentionRowFromTriage({ ...base, intentionData: { text: "x", description: "" } }).description,
    ).toBeNull();
    expect(
      intentionRowFromTriage({ ...base, intentionData: { text: "x", description: "   \n  " } })
        .description,
    ).toBeNull();
  });

  it("survives the old inbox card, which sends no description at all", () => {
    const row = intentionRowFromTriage({ ...base, intentionData: { text: "x" } });
    // Present as null, not absent: an absent key would leave the column untouched
    // on an update path rather than explicitly empty.
    expect(row).toHaveProperty("description", null);
  });

  it("reaches Postgres as `description`, unchanged by the case converter", () => {
    // The last link in the chain: storage.set writes toSnakeCase(row). An
    // already-snake key has to pass through, and nothing may drop it.
    const row = intentionRowFromTriage({
      ...base,
      intentionData: { text: "x", description: "the details" },
    });
    expect(toSnakeCase(row).description).toBe("the details");
  });
});

describe("intentionRowFromTriage — the rest of the row", () => {
  it("maps every field the triage form sends", () => {
    const row = intentionRowFromTriage({
      ...base,
      intentionData: {
        text: "Stretch daily",
        description: "Five minutes.",
        contextId: "ctx-1",
        recurrenceConfig: { frequency: "daily", interval: 1 },
        endDate: "2026-12-31",
        targetStartDate: null,
        tags: ["mobility"],
      },
    });
    expect(row).toEqual({
      id: "intent-1",
      user_id: "user-1",
      text: "Stretch daily",
      description: "Five minutes.",
      createdAt: "2026-09-24T10:00:00.000Z",
      isIntention: true,
      isItem: false,
      archived: false,
      itemId: null,
      contextId: "ctx-1",
      recurrenceConfig: { frequency: "daily", interval: 1 },
      targetStartDate: null,
      endDate: "2026-12-31",
      tags: ["mobility"],
      sourceInboxId: "inbox-1",
    });
  });

  it("always records which capture it came from", () => {
    // Migration 068's column, and the reason triage archives instead of deleting.
    const row = intentionRowFromTriage({ ...base, intentionData: { text: "x" } });
    expect(row.sourceInboxId).toBe("inbox-1");
  });

  it("links the item this triage just created", () => {
    const row = intentionRowFromTriage({
      ...base,
      intentionData: { text: "x" },
      createdItemId: "item-new",
    });
    expect(row.itemId).toBe("item-new");
    expect(row.isItem).toBe(true);
  });

  it("lets an explicitly chosen existing item win", () => {
    // The order the inbox detail page relies on: it sends null whenever its New
    // Item section is on, so that the new item is what gets linked.
    const row = intentionRowFromTriage({
      ...base,
      intentionData: { text: "x", itemId: "item-chosen" },
      createdItemId: "item-new",
    });
    expect(row.itemId).toBe("item-chosen");
  });

  it("is not an item when there is no item", () => {
    const row = intentionRowFromTriage({ ...base, intentionData: { text: "x" } });
    expect(row.isItem).toBe(false);
    expect(row.itemId).toBeNull();
  });

  it("starts unarchived", () => {
    expect(intentionRowFromTriage({ ...base, intentionData: { text: "x" } }).archived).toBe(false);
  });

  it("defaults the absent to null and tags to an empty array", () => {
    const row = intentionRowFromTriage({ ...base, intentionData: { text: "x" } });
    expect(row.recurrenceConfig).toBeNull();
    expect(row.targetStartDate).toBeNull();
    expect(row.endDate).toBeNull();
    expect(row.tags).toEqual([]);
  });

  it("does not carry the form's own fields into the row", () => {
    // createEvent and eventDate drive the EVENT, not this row.
    const row = intentionRowFromTriage({
      ...base,
      intentionData: { text: "x", createEvent: true, eventDate: "2026-09-26" },
    });
    expect(row).not.toHaveProperty("createEvent");
    expect(row).not.toHaveProperty("eventDate");
  });
});
