import {
  computeBaseline,
  isEnriched,
  canProcessInOneTap,
  triageDataForOneTap,
  copyTextForTask,
} from "./inboxSuggestions";

const row = (over = {}) => ({
  id: "inbox-1",
  capturedText: "Retire the ai-enrich edge function",
  sourceType: "mcp",
  aiStatus: "enriched",
  ...over,
});

describe("isEnriched", () => {
  it("counts both enrichment states", () => {
    expect(isEnriched(row({ aiStatus: "enriched" }))).toBe(true);
    expect(isEnriched(row({ aiStatus: "re_enriched" }))).toBe(true);
  });

  it("is false for anything else, including nothing", () => {
    expect(isEnriched(row({ aiStatus: "not_started" }))).toBe(false);
    expect(isEnriched(row({ aiStatus: "in_progress" }))).toBe(false);
    expect(isEnriched(row({ aiStatus: undefined }))).toBe(false);
    expect(isEnriched(null)).toBe(false);
  });
});

describe("canProcessInOneTap", () => {
  it("allows an enriched row suggesting an item, or an intention, or both", () => {
    expect(canProcessInOneTap(row({ suggestItem: true }))).toBe(true);
    expect(canProcessInOneTap(row({ suggestIntent: true }))).toBe(true);
    expect(canProcessInOneTap(row({ suggestItem: true, suggestIntent: true }))).toBe(true);
  });

  it("refuses an UNENRICHED row even when it somehow carries suggestions", () => {
    // Process files the suggestions. On an unenriched row there are none to speak of,
    // and filing the capture's own text as an item's name is a trap, not a shortcut.
    expect(canProcessInOneTap(row({ aiStatus: "not_started", suggestItem: true }))).toBe(false);
  });

  it("refuses a row that suggests neither an item nor an intention", () => {
    // Those are the only two things triage creates. A row suggesting only a context or
    // a tag has nothing for them to land on, so Process would archive it having
    // created nothing at all.
    expect(canProcessInOneTap(row({ suggestedContextId: "ctx-1" }))).toBe(false);
    expect(canProcessInOneTap(row({ suggestedTags: ["ui"] }))).toBe(false);
    expect(canProcessInOneTap(row())).toBe(false);
  });

  it("refuses a task, which is never enriched", () => {
    expect(canProcessInOneTap(row({ sourceType: "task", aiStatus: "not_started" }))).toBe(false);
  });
});

describe("computeBaseline", () => {
  it("falls back to the captured text for both names", () => {
    const b = computeBaseline(row());
    expect(b.itemName).toBe("Retire the ai-enrich edge function");
    expect(b.intentText).toBe("Retire the ai-enrich edge function");
  });

  it("prefers a suggested name over the captured text", () => {
    const b = computeBaseline(row({ suggestedItemText: "ai-enrich retirement" }));
    expect(b.itemName).toBe("ai-enrich retirement");
  });

  it("normalises suggested elements into the app's vocabulary", () => {
    const b = computeBaseline(row({ suggestedItemElements: [{ text: "Onions", type: "bullet" }] }));
    expect(b.elements).toEqual([
      { name: "Onions", displayType: "bullet", quantity: "", description: "" },
    ]);
  });

  it("starts Details empty, because nothing suggests one", () => {
    expect(computeBaseline(row()).intentDescription).toBe("");
  });
});

describe("triageDataForOneTap", () => {
  it("sends an item built from the suggestions", () => {
    const data = triageDataForOneTap(
      row({
        suggestItem: true,
        suggestedItemText: "  ai-enrich retirement  ",
        suggestedItemDescription: "Delete the function and its key.",
        suggestedContextId: "ctx-alfred",
        suggestedTags: ["ui"],
      }),
    );
    expect(data.createItem).toBe(true);
    expect(data.itemData).toEqual({
      name: "ai-enrich retirement",
      description: "Delete the function and its key.",
      contextId: "ctx-alfred",
      elements: [],
      tags: ["ui"],
    });
    expect(data.createIntention).toBe(false);
    expect(data.intentionData).toBeNull();
  });

  it("sends an intention built from the suggestions, with a date as an event", () => {
    const data = triageDataForOneTap(
      row({ suggestIntent: true, suggestedIntentText: "Do it", suggestedEventDate: "2026-10-01" }),
    );
    expect(data.intentionData).toMatchObject({
      text: "Do it",
      createEvent: true,
      eventDate: "2026-10-01",
    });
  });

  it("never sends a recurrence, because nothing suggests one in the right shape", () => {
    // `suggested_intent_recurrence` holds a WORD ('daily'), not the recurrenceConfig
    // object the app stores. Translating it here would invent a rule the detail page
    // does not apply either.
    const data = triageDataForOneTap(
      row({ suggestIntent: true, suggestedIntentRecurrence: "daily" }),
    );
    expect(data.intentionData.recurrenceConfig).toBeNull();
    expect(data.intentionData.endDate).toBeNull();
    expect(data.intentionData.targetStartDate).toBeNull();
  });

  it("lets the item it is about to create beat a suggested existing one", () => {
    // handleInboxSave resolves `intentionData.itemId || createdItemId`, so a value here
    // would WIN over the item this same triage creates.
    const data = triageDataForOneTap(
      row({ suggestItem: true, suggestIntent: true, suggestedItemId: "item-old" }),
    );
    expect(data.intentionData.itemId).toBeNull();
  });

  it("passes a suggested existing item through when no new item is being made", () => {
    const data = triageDataForOneTap(row({ suggestIntent: true, suggestedItemId: "item-old" }));
    expect(data.intentionData.itemId).toBe("item-old");
  });

  it("never files a collection, because the detail page cannot either", () => {
    // One tap must not do something the careful path cannot.
    const data = triageDataForOneTap(row({ suggestItem: true, suggestedCollectionId: "col-1" }));
    expect(data.addToCollection).toBe(false);
    expect(data.collectionData).toBeNull();
  });

  it("sends no item links, since Attach this Item no longer exists", () => {
    expect(triageDataForOneTap(row({ suggestItem: true })).itemItemLinks).toEqual([]);
  });

  it("shares one context and one tag set between both records", () => {
    const data = triageDataForOneTap(
      row({
        suggestItem: true,
        suggestIntent: true,
        suggestedContextId: "ctx-alfred",
        suggestedTags: ["ui", "bug"],
      }),
    );
    expect(data.itemData.contextId).toBe("ctx-alfred");
    expect(data.intentionData.contextId).toBe("ctx-alfred");
    expect(data.itemData.tags).toEqual(["ui", "bug"]);
    expect(data.intentionData.tags).toEqual(["ui", "bug"]);
  });
});

describe("copyTextForTask", () => {
  it("carries the row's id on its own last line", () => {
    // The point of the button: pasting the text alone would leave a Claude session with
    // no way to archive the row afterwards.
    const text = copyTextForTask(row({ id: "abc-123", capturedText: "DJ sync found 21" }));
    expect(text).toBe("DJ sync found 21\n\nAlfred inbox item: abc-123");
    expect(text.split("\n").pop()).toBe("Alfred inbox item: abc-123");
  });

  it("trims the capture so the id line is where it looks", () => {
    expect(copyTextForTask(row({ id: "x", capturedText: "  text  \n\n" }))).toBe(
      "text\n\nAlfred inbox item: x",
    );
  });
});
