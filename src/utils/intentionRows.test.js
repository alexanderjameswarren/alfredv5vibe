import { intentionRowFromTriage, intentionUpdateRow, detailsForStorage } from "./intentionRows";
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


// ── The EDIT path, and the bug it was hiding ─────────────────────────────────
//
// `updateIntent` builds an explicit whitelist of columns. `description` was missing
// from it, which made Details silently unwritable from the intention edit screen:
// typed, reported saved, and gone, with no error anywhere. A whitelist fails that
// way once per new column, which is why it is under test now.

const existing = {
  id: "intent-1",
  userId: "user-1",
  text: "Replace the vent fan motor",
  description: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  isIntention: true,
  isItem: false,
  archived: false,
  itemId: null,
  contextId: "ctx-home",
  recurrenceConfig: null,
  targetStartDate: null,
  endDate: null,
  tags: ["home"],
  collectionId: null,
};

describe("intentionUpdateRow — Details", () => {
  it("writes a typed value", () => {
    const row = intentionUpdateRow(existing, { description: "Model number is behind the grille." });
    expect(row.description).toBe("Model number is behind the grille.");
  });

  it("is IN the row at all, which is the whole bug", () => {
    // Before Step 17c the key was absent, so the UPDATE never named the column and
    // the write was a no-op that looked like a success.
    expect(Object.keys(intentionUpdateRow(existing, {}))).toContain("description");
  });

  it("clears the column when the box is emptied on purpose", () => {
    const withDetails = { ...existing, description: "something" };
    expect(intentionUpdateRow(withDetails, { description: null }).description).toBeNull();
  });

  it("keeps what is there when the edit does not mention it", () => {
    // Every other writer of an intention — archiving, scheduling, re-linking an
    // item — sends a patch without `description`, and must not wipe it.
    const withDetails = { ...existing, description: "keep me" };
    expect(intentionUpdateRow(withDetails, { archived: true }).description).toBe("keep me");
    expect(intentionUpdateRow(withDetails, { text: "New name" }).description).toBe("keep me");
  });

  it("reads an absent column as null rather than undefined", () => {
    // An intention predating migration 069 has no value at all. undefined would drop
    // the key from the row and quietly reintroduce the original bug.
    const { description, ...noColumn } = existing;
    expect(intentionUpdateRow(noColumn, {}).description).toBeNull();
  });

  it("survives the case converter as `description`", () => {
    const row = intentionUpdateRow(existing, { description: "the details" });
    expect(toSnakeCase(row).description).toBe("the details");
  });
});

describe("intentionUpdateRow — everything else it must not break", () => {
  it("leaves an untouched row untouched", () => {
    expect(intentionUpdateRow(existing, {})).toEqual(existing);
  });

  it("applies only the fields the patch names", () => {
    const row = intentionUpdateRow(existing, { text: "Renamed", tags: ["home", "repair"] });
    expect(row.text).toBe("Renamed");
    expect(row.tags).toEqual(["home", "repair"]);
    expect(row.contextId).toBe("ctx-home");
    expect(row.createdAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("treats null as a deliberate clear, not as absent", () => {
    // Unlinking an item, or removing a context, both send null.
    const linked = { ...existing, itemId: "item-1", contextId: "ctx-home" };
    const row = intentionUpdateRow(linked, { itemId: null, contextId: null });
    expect(row.itemId).toBeNull();
    expect(row.contextId).toBeNull();
  });

  it("can archive", () => {
    expect(intentionUpdateRow(existing, { archived: true }).archived).toBe(true);
  });

  it("defaults the missing booleans and tags rather than passing undefined", () => {
    const sparse = { id: "i", userId: "u", text: "x", createdAt: "t" };
    const row = intentionUpdateRow(sparse, {});
    expect(row.isIntention).toBe(false);
    expect(row.isItem).toBe(false);
    expect(row.archived).toBe(false);
    expect(row.tags).toEqual([]);
    expect(row.collectionId).toBeNull();
  });

  it("does not invent an id or an owner", () => {
    const row = intentionUpdateRow(existing, { id: "hacked", userId: "someone-else" });
    expect(row.id).toBe("intent-1");
    expect(row.userId).toBe("user-1");
  });
});

describe("detailsForStorage", () => {
  it("is the one rule both writers use", () => {
    expect(detailsForStorage("the details")).toBe("the details");
    expect(detailsForStorage("  trimmed  ")).toBe("trimmed");
    expect(detailsForStorage("")).toBeNull();
    expect(detailsForStorage("   \n ")).toBeNull();
    expect(detailsForStorage(null)).toBeNull();
    expect(detailsForStorage(undefined)).toBeNull();
  });

  it("agrees with what the triage path stores", () => {
    const viaTriage = intentionRowFromTriage({
      id: "i",
      userId: "u",
      sourceInboxId: "inbox-1",
      createdAt: "t",
      intentionData: { text: "x", description: "  same rule  " },
    }).description;
    expect(viaTriage).toBe(detailsForStorage("  same rule  "));
  });
});
