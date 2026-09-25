import {
  computeBaseline,
  isEnriched,
  canProcessInOneTap,
  triageDataForOneTap,
  copyTextForTask,
  listTitleFor,
  taskTitleFor,
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

  it("pre-fills Details from the suggestion", () => {
    const b = computeBaseline(row({ suggestedIntentDescription: "Ask for Dave, mornings only." }));
    expect(b.intentDescription).toBe("Ask for Dave, mornings only.");
  });

  it("leaves Details empty when none was suggested, never the captured text", () => {
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

  it("sends the suggested Details as the intention's description", () => {
    const data = triageDataForOneTap(
      row({ suggestIntent: true, suggestedIntentDescription: "Ask for Dave." }),
    );
    expect(data.intentionData.description).toBe("Ask for Dave.");
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


describe("listTitleFor", () => {
  it("titles an enriched row by its suggested ITEM name", () => {
    // What it will become, not what was said — and what Process is about to create, so
    // the title and the action agree.
    expect(
      listTitleFor(row({ suggestedItemText: "Duck mole tacos", suggestedIntentText: "Cook it" })),
    ).toBe("Duck mole tacos");
  });

  it("falls to the suggested INTENTION name when there is no item", () => {
    expect(listTitleFor(row({ suggestedIntentText: "Retire ai-enrich" }))).toBe("Retire ai-enrich");
  });

  it("falls to the captured text when an enriched row suggests no name", () => {
    expect(listTitleFor(row())).toBe("Retire the ai-enrich edge function");
  });

  it("ignores a blank suggestion rather than showing an empty title", () => {
    expect(listTitleFor(row({ suggestedItemText: "   " }))).toBe(
      "Retire the ai-enrich edge function",
    );
  });

  it("keeps the captured text on an UNENRICHED row, whatever it carries", () => {
    // Nothing has researched it, so there is no suggestion to prefer.
    expect(
      listTitleFor(row({ aiStatus: "not_started", suggestedItemText: "should not be used" })),
    ).toBe("Retire the ai-enrich edge function");
  });

  it("survives junk", () => {
    expect(listTitleFor(null)).toBe("");
    expect(listTitleFor({})).toBe("");
  });
});

// ── Task titles — Clipboard Step 22 ──────────────────────────────────────────
//
// A task row is the one row not titled by its own words. The text is the task's OUTPUT,
// written for a Claude session to pick up, and the first fifty characters of it are the
// least identifying part — two runs of the same weekly task read identically and are not
// the same row.
describe("taskTitleFor", () => {
  const task = (meta, over = {}) =>
    row({
      sourceType: "task",
      aiStatus: "not_started",
      capturedText: "Sales are up. Three artists to look at. Also the Tuesday set ran long.",
      sourceMetadata: meta,
      ...over,
    });

  it("names the task and dates the run", () => {
    expect(taskTitleFor(task({ taskName: "Weekly DJ review", runDate: "2026-09-25" }))).toBe(
      "Weekly DJ review · Sep 25",
    );
  });

  it("reads the snake_case keys too", () => {
    // `storage.toCamelCase` recurses into jsonb, so a row that came through React state
    // carries `taskName` while the column holds `task_name`. Reading both costs one `||`
    // against a title that silently falls back to a paragraph if a raw row ever arrives.
    expect(taskTitleFor(task({ task_name: "Weekly DJ review", run_date: "2026-09-25" }))).toBe(
      "Weekly DJ review · Sep 25",
    );
  });

  it("reads source_metadata under its snake_case name as well", () => {
    const raw = {
      sourceType: "task",
      source_metadata: { task_name: "Inbox sweep", run_date: "2026-01-02" },
    };
    expect(taskTitleFor(raw)).toBe("Inbox sweep · Jan 2");
  });

  it("writes the date WITHOUT a year, and in local time", () => {
    // Field by field, not `new Date("2026-01-01")` — that is UTC midnight and renders as
    // December 31st in every negative-offset zone.
    expect(taskTitleFor(task({ taskName: "Sweep", runDate: "2026-01-01" }))).toBe(
      "Sweep · Jan 1",
    );
  });

  it("gives just the name when there is no run date", () => {
    // `run_date` is optional in `create_inbox_item`; `task_name` is not.
    expect(taskTitleFor(task({ taskName: "Weekly DJ review" }))).toBe("Weekly DJ review");
  });

  it("ignores a malformed run date rather than printing Invalid Date", () => {
    for (const bad of ["25/09/2026", "2026-9-5", "soon", "", null, 20260925]) {
      expect(taskTitleFor(task({ taskName: "Sweep", runDate: bad }))).toBe("Sweep");
    }
  });

  it("is null for a task with no name, so the captured text can take over", () => {
    expect(taskTitleFor(task({ runDate: "2026-09-25" }))).toBeNull();
    expect(taskTitleFor(task({ taskName: "   " }))).toBeNull();
    expect(taskTitleFor(task(undefined))).toBeNull();
  });

  it("is null for anything that is not a task", () => {
    // The metadata is not consulted on an mcp row even if it happens to carry a name.
    expect(taskTitleFor(row({ sourceMetadata: { taskName: "Weekly DJ review" } }))).toBeNull();
    expect(taskTitleFor(null)).toBeNull();
  });
});

describe("listTitleFor, on a task", () => {
  it("uses the task title", () => {
    expect(
      listTitleFor(
        row({
          sourceType: "task",
          aiStatus: "not_started",
          capturedText: "Sales are up. Three artists to look at.",
          sourceMetadata: { taskName: "Weekly DJ review", runDate: "2026-09-25" },
        }),
      ),
    ).toBe("Weekly DJ review · Sep 25");
  });

  it("BEATS an enrichment's suggested name", () => {
    // 🛑 The order matters. A task can be enriched later, and once it is, the suggestion
    // would win and the run would lose the only thing that told it apart from last
    // week's.
    expect(
      listTitleFor(
        row({
          sourceType: "task",
          aiStatus: "enriched",
          suggestedItemText: "Look at three artists",
          sourceMetadata: { taskName: "Weekly DJ review", runDate: "2026-09-25" },
        }),
      ),
    ).toBe("Weekly DJ review · Sep 25");
  });

  it("falls back to the captured text when task_name is missing", () => {
    const task = row({ sourceType: "task", aiStatus: "not_started", capturedText: "DJ sync: 21" });
    expect(listTitleFor(task)).toBe("DJ sync: 21");
  });
});
