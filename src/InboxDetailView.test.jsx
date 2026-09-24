import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import InboxDetailView from "./InboxDetailView";
import { intentionRowFromTriage } from "./utils/intentionRows";
import { toSnakeCase } from "./utils/caseConvert";

// The page is in its own module so these tests exercise IT, not a reproduction of
// its shape — the twin-site failure `useExecutionRoute` documents. What is pinned
// here is the contract with Alfred.jsx: what `onProcess` receives, when Process
// is allowed at all, and when the unsaved-changes guard is armed.

const CONTEXTS = [
  { id: "ctx-alfred", name: "Alfred" },
  { id: "ctx-home", name: "Home" },
  { id: "ctx-gone", name: "Retired", archived: true },
];

const ITEMS = [
  { id: "item-1", name: "Vent fan", contextId: "ctx-home" },
  { id: "item-2", name: "Duck mole", contextId: "ctx-home" },
];

function capture(overrides = {}) {
  return {
    id: "inbox-1",
    capturedText: "Bug: browser Back skips the unsaved-changes guard.",
    sourceType: "mcp",
    createdAt: "2026-09-24T08:40:00.000Z",
    ...overrides,
  };
}

function setup(overrides = {}, props = {}) {
  const onProcess = jest.fn();
  const onDiscard = jest.fn();
  const onBack = jest.fn();
  const onDirtyChange = jest.fn();
  const onSaveCaptureText = jest.fn().mockResolvedValue(true);
  const utils = render(
    <InboxDetailView
      inboxItem={capture(overrides)}
      contexts={CONTEXTS}
      items={ITEMS}
      tagPool={["bug", "routing"]}
      onProcess={onProcess}
      onDiscard={onDiscard}
      onBack={onBack}
      onDirtyChange={onDirtyChange}
      onSaveCaptureText={onSaveCaptureText}
      renderRecurrence={({ onChange }) => (
        <button onClick={() => onChange({ frequency: "daily", interval: 1 })}>
          stub: every day
        </button>
      )}
      {...props}
    />,
  );
  return { onProcess, onDiscard, onBack, onDirtyChange, onSaveCaptureText, ...utils };
}

const processButton = () => screen.getByRole("button", { name: /Process/ });

describe("the page, as the README orders it", () => {
  it("shows the source as a word, not as its database value", () => {
    setup();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.queryByText("mcp")).not.toBeInTheDocument();
  });

  it("shows the capture time", () => {
    // Asserted as a shape rather than a literal: `friendlyDate` renders in the
    // viewer's own timezone, so pinning "8:40 AM" would pass only where this was
    // written.
    setup();
    expect(screen.getByText(/at \d{1,2}:\d{2}\s?(AM|PM)/)).toBeInTheDocument();
  });

  it("names today as today", () => {
    setup({ createdAt: new Date().toISOString() });
    expect(screen.getByText(/^Today at /)).toBeInTheDocument();
  });

  it("always shows the original capture, whatever the toggles say", () => {
    setup();
    expect(screen.getByText(/Bug: browser Back skips/)).toBeInTheDocument();
  });

  it("offers Context first, and hides archived contexts", () => {
    setup();
    const select = screen.getByLabelText("Context");
    expect(select).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Alfred" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Retired" })).not.toBeInTheDocument();
  });

  it("has no Enrich, no Re-enrich and no Collection section", () => {
    setup({ suggestItem: true, suggestIntent: true });
    expect(screen.queryByText(/Enrich/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Collection/i)).not.toBeInTheDocument();
  });

  it("gives every footer button its icon-and-label pair", () => {
    setup();
    expect(processButton()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cancel/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Discard/ })).toBeInTheDocument();
  });
});

describe("the two toggles", () => {
  it("starts with both off when the capture suggests nothing", () => {
    setup();
    expect(screen.getByRole("button", { name: /New Item/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /New Intention/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // Neither section is rendered, so neither heading exists.
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("preselects each section from the enrichment", () => {
    setup({ suggestItem: true, suggestIntent: true });
    expect(screen.getByRole("button", { name: /New Item/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /New Intention/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("reveals and hides a section on its own", () => {
    setup();
    expect(screen.queryByText("Details")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /New Intention/ }));
    expect(screen.getByText("Details")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /New Intention/ }));
    expect(screen.queryByText("Details")).not.toBeInTheDocument();
  });
});

describe("Process", () => {
  it("is refused with neither section on, because nothing would be created", () => {
    const { onProcess } = setup();
    expect(processButton()).toBeDisabled();
    fireEvent.click(processButton());
    expect(onProcess).not.toHaveBeenCalled();
  });

  it("is refused while an open section has no name", () => {
    const { onProcess } = setup({ suggestItem: true, suggestedItemText: "  " });
    expect(processButton()).toBeDisabled();
    fireEvent.click(processButton());
    expect(onProcess).not.toHaveBeenCalled();
  });

  it("sends an item with the shared context and tags", () => {
    const { onProcess } = setup({
      suggestItem: true,
      suggestedItemText: "Browser Back skips the guard",
      suggestedItemDescription: "Seen on desktop Chrome.",
      suggestedContextId: "ctx-alfred",
      suggestedTags: ["bug", "routing"],
    });
    fireEvent.click(processButton());
    expect(onProcess).toHaveBeenCalledTimes(1);
    const [id, data] = onProcess.mock.calls[0];
    expect(id).toBe("inbox-1");
    expect(data.createItem).toBe(true);
    expect(data.itemData).toMatchObject({
      name: "Browser Back skips the guard",
      description: "Seen on desktop Chrome.",
      contextId: "ctx-alfred",
      tags: ["bug", "routing"],
    });
    expect(data.createIntention).toBe(false);
    expect(data.intentionData).toBeNull();
  });

  it("never asks for a collection, because collections are hidden here", () => {
    const { onProcess } = setup({ suggestItem: true, suggestedItemText: "Anything" });
    fireEvent.click(processButton());
    const [, data] = onProcess.mock.calls[0];
    expect(data.addToCollection).toBe(false);
    expect(data.collectionData).toBeNull();
  });

  it("sends no item links, because Attach this Item is not on this page", () => {
    const { onProcess } = setup({ suggestItem: true, suggestedItemText: "Anything" });
    fireEvent.click(processButton());
    expect(onProcess.mock.calls[0][1].itemItemLinks).toEqual([]);
  });

  it("sends the intention's Details as `description`, migration 069's column", () => {
    const { onProcess } = setup({ suggestIntent: true, suggestedIntentText: "Fix the guard" });
    fireEvent.click(screen.getByLabelText("Details"));
    fireEvent.change(screen.getByLabelText("Details"), {
      target: { value: "Check the back-stack in the routing thread." },
    });
    fireEvent.click(processButton());
    const [, data] = onProcess.mock.calls[0];
    expect(data.intentionData).toMatchObject({
      text: "Fix the guard",
      description: "Check the back-stack in the routing thread.",
    });
  });

  it("trims the names it sends", () => {
    const { onProcess } = setup({ suggestIntent: true, suggestedIntentText: "  Fix the guard  " });
    fireEvent.click(processButton());
    expect(onProcess.mock.calls[0][1].intentionData.text).toBe("Fix the guard");
  });

  it("does NOT navigate, so a failed process leaves the form where it is", () => {
    // onProcess archives the row on success and alerts on failure, and cannot
    // report which. The page lets the row's disappearance move it instead.
    const { onProcess, onBack } = setup({ suggestIntent: true, suggestedIntentText: "Fix it" });
    fireEvent.click(processButton());
    expect(onProcess).toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
  });
});

// ── Step 17b: Details, from the keystroke to the row Postgres is sent ─────────
//
// The two halves of the chain joined with NOTHING STUBBED between them. The page
// produces the triage data; the real row builder consumes it; the real case
// converter converts it. The only thing not exercised is the network call itself.
//
// This exists because "0 of 166 rows have a description" could not be told apart
// from "nobody typed any Details" by reading the code.
describe("Details reaches the database row", () => {
  function processWithDetails(details) {
    const { onProcess } = setup({ suggestIntent: true, suggestedIntentText: "Fix the guard" });
    fireEvent.change(screen.getByLabelText("Details"), { target: { value: details } });
    fireEvent.click(processButton());
    const [, triageData] = onProcess.mock.calls[0];
    const row = intentionRowFromTriage({
      id: "intent-1",
      userId: "user-1",
      intentionData: triageData.intentionData,
      createdItemId: null,
      sourceInboxId: "inbox-1",
      createdAt: "2026-09-24T10:00:00.000Z",
    });
    return { triageData, row, dbRow: toSnakeCase(row) };
  }

  it("carries typed Details all the way to `description`", () => {
    const { dbRow } = processWithDetails("Check the back-stack in the routing thread.");
    expect(dbRow.description).toBe("Check the back-stack in the routing thread.");
  });

  it("carries a multi-paragraph value intact", () => {
    // Built by joining, so the newlines in the assertion cannot drift from the
    // newlines in the input.
    const typed = ["First thought.", "", "Second thought."].join("\n");
    const { dbRow } = processWithDetails(typed);
    expect(dbRow.description).toBe(typed);
    expect(dbRow.description.split("\n")).toHaveLength(3);
  });

  it("writes null when Details was left alone, which is the correct result", () => {
    // The state Alex's SQL check most likely caught: a capture processed without
    // Details typed. Null here is right, and this test is what distinguishes that
    // from a value being dropped.
    const { onProcess } = setup({ suggestIntent: true, suggestedIntentText: "Fix the guard" });
    fireEvent.click(processButton());
    const [, triageData] = onProcess.mock.calls[0];
    expect(triageData.intentionData.description).toBe("");
    const row = intentionRowFromTriage({
      id: "i",
      userId: "u",
      intentionData: triageData.intentionData,
      sourceInboxId: "inbox-1",
      createdAt: "2026-09-24T10:00:00.000Z",
    });
    expect(row.description).toBeNull();
  });

  it("keeps the Details typed against the intention it was typed for", () => {
    // Both sections on: the item's Description and the intention's Details are
    // different fields and must not cross.
    const { onProcess } = setup({
      suggestItem: true,
      suggestedItemText: "The item",
      suggestedItemDescription: "the item description",
      suggestIntent: true,
      suggestedIntentText: "The intention",
    });
    fireEvent.change(screen.getByLabelText("Details"), { target: { value: "the intention details" } });
    fireEvent.click(processButton());
    const [, triageData] = onProcess.mock.calls[0];
    expect(triageData.itemData.description).toBe("the item description");
    expect(triageData.intentionData.description).toBe("the intention details");
  });
});

describe("When", () => {
  it("is Someday until something says otherwise", () => {
    setup({ suggestIntent: true, suggestedIntentText: "Fix it" });
    expect(screen.getByRole("button", { name: /Someday/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Pick a date/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("sends neither a date nor a repeat on Someday", () => {
    const { onProcess } = setup({ suggestIntent: true, suggestedIntentText: "Fix it" });
    fireEvent.click(processButton());
    expect(onProcess.mock.calls[0][1].intentionData).toMatchObject({
      createEvent: false,
      eventDate: null,
      recurrenceConfig: null,
      endDate: null,
      targetStartDate: null,
    });
  });

  it("starts on the date the enrichment proposed", () => {
    setup({ suggestIntent: true, suggestedIntentText: "Fix it", suggestedEventDate: "2026-09-26" });
    // Formatted from the parts, not through new Date(), so it cannot slip a day
    // in a negative-offset timezone.
    expect(screen.getByRole("button", { name: /Sat, Sep 26/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("turns a date into an event", () => {
    const { onProcess } = setup({ suggestIntent: true, suggestedIntentText: "Fix it" });
    fireEvent.click(screen.getByRole("button", { name: /Pick a date/ }));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-26" } });
    fireEvent.click(processButton());
    expect(onProcess.mock.calls[0][1].intentionData).toMatchObject({
      createEvent: true,
      eventDate: "2026-09-26",
      recurrenceConfig: null,
    });
  });

  it("sends a recurrence on Repeat, and no event", () => {
    const { onProcess } = setup({ suggestIntent: true, suggestedIntentText: "Stretch" });
    fireEvent.click(screen.getByRole("button", { name: /Repeat/ }));
    fireEvent.click(screen.getByRole("button", { name: /stub: every day/ }));
    fireEvent.click(processButton());
    expect(onProcess.mock.calls[0][1].intentionData).toMatchObject({
      recurrenceConfig: { frequency: "daily", interval: 1 },
      createEvent: false,
      eventDate: null,
    });
  });

  it("drops the date when the answer changes to Repeat", () => {
    // The three are one answer, not three fields, so switching must not leave a
    // stale event date to be filed alongside a repeat.
    const { onProcess } = setup({
      suggestIntent: true,
      suggestedIntentText: "Stretch",
      suggestedEventDate: "2026-09-26",
    });
    fireEvent.click(screen.getByRole("button", { name: /Repeat/ }));
    fireEvent.click(processButton());
    expect(onProcess.mock.calls[0][1].intentionData).toMatchObject({
      createEvent: false,
      eventDate: null,
    });
  });

  it("drops a repeat when the answer changes back to Someday", () => {
    const { onProcess } = setup({ suggestIntent: true, suggestedIntentText: "Stretch" });
    fireEvent.click(screen.getByRole("button", { name: /Repeat/ }));
    fireEvent.click(screen.getByRole("button", { name: /stub: every day/ }));
    fireEvent.click(screen.getByRole("button", { name: /Someday/ }));
    fireEvent.click(processButton());
    expect(onProcess.mock.calls[0][1].intentionData.recurrenceConfig).toBeNull();
  });
});

describe("linking an intention to an existing item", () => {
  it("passes the suggested item through as itemId", () => {
    // suggested_item_id is only reachable from the app through this control, so
    // dropping it would make the column unusable — hence it stays, though the
    // mockups do not show it.
    const { onProcess } = setup({
      suggestIntent: true,
      suggestedIntentText: "Replace the motor",
      suggestedItemId: "item-1",
    });
    fireEvent.click(processButton());
    expect(onProcess.mock.calls[0][1].intentionData.itemId).toBe("item-1");
  });

  it("yields to the new item when both are in play", () => {
    // The page says "the new item will be linked" and dims the picker, but
    // dimming hides a stale value rather than clearing it — and the triage
    // handler resolves `intentionData.itemId || createdItemId`, so anything sent
    // here would BEAT the item it just created. Sending null is what makes the
    // page's own promise true.
    const { onProcess } = setup({
      suggestItem: true,
      suggestedItemText: "Vent fan motor",
      suggestIntent: true,
      suggestedIntentText: "Replace the motor",
      suggestedItemId: "item-1",
    });
    fireEvent.click(processButton());
    expect(onProcess.mock.calls[0][1].intentionData.itemId).toBeNull();
  });

  it("seeds the picker's text with the item's name, not its id", () => {
    setup({ suggestIntent: true, suggestedIntentText: "x", suggestedItemId: "item-1" });
    expect(screen.getByDisplayValue("Vent fan")).toBeInTheDocument();
  });
});

describe("the element editor", () => {
  it("normalises the enrichment's element vocabulary once, for display", () => {
    setup({
      suggestItem: true,
      suggestedItemText: "Duck mole tacos",
      suggestedItemElements: [
        { text: "Shopping", type: "header" },
        { text: "Onions", type: "bullet", collectable: true },
      ],
    });
    expect(screen.getByDisplayValue("Shopping")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Onions")).toBeInTheDocument();
  });

  it("sends elements in the app's vocabulary, not the enrichment's", () => {
    const { onProcess } = setup({
      suggestItem: true,
      suggestedItemText: "Duck mole tacos",
      suggestedItemElements: [{ text: "Onions", type: "bullet", collectable: true }],
    });
    fireEvent.click(processButton());
    expect(onProcess.mock.calls[0][1].itemData.elements).toEqual([
      { name: "Onions", displayType: "bullet", quantity: "", description: "", collectable: true },
    ]);
  });

  it("adds an element", () => {
    setup({ suggestItem: true, suggestedItemText: "Recipe" });
    fireEvent.click(screen.getByRole("button", { name: "+ Add Element" }));
    expect(screen.getByPlaceholderText("Element name")).toBeInTheDocument();
  });

  it("offers Can buy on a bullet and not on a step", () => {
    setup({
      suggestItem: true,
      suggestedItemText: "Recipe",
      suggestedItemElements: [{ text: "Onions", type: "bullet" }],
    });
    expect(screen.getByText("Can buy")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Element type"), { target: { value: "step" } });
    expect(screen.queryByText("Can buy")).not.toBeInTheDocument();
  });

  it("drops the offset when a step stops being a step", () => {
    // An offset is a gap before a step; leaving one on a header would be a
    // scheduling instruction on a row that can never be scheduled.
    const { onProcess } = setup({
      suggestItem: true,
      suggestedItemText: "Recipe",
      suggestedItemElements: [{ text: "Rest the dough", type: "step", offsetMinutes: 30 }],
    });
    fireEvent.change(screen.getByLabelText("Element type"), { target: { value: "header" } });
    fireEvent.click(processButton());
    expect(onProcess.mock.calls[0][1].itemData.elements[0]).not.toHaveProperty("offsetMinutes");
  });
});

describe("the unsaved-changes guard", () => {
  it("reports clean on arrival, however the capture was suggested", () => {
    // The seed and the baseline are one object, which is what makes this true.
    // Two hand-written copies of "what this form started as" is what used to make
    // an untouched form ask whether to discard.
    const { onDirtyChange } = setup({
      suggestItem: true,
      suggestIntent: true,
      suggestedItemText: "An item",
      suggestedIntentText: "An intention",
      suggestedItemElements: [{ text: "Rest", type: "step", offset_minutes: 30 }],
      suggestedTags: ["bug"],
      suggestedContextId: "ctx-alfred",
      suggestedEventDate: "2026-09-26",
    });
    expect(onDirtyChange).toHaveBeenCalledWith(false, "this capture");
    expect(onDirtyChange).not.toHaveBeenCalledWith(true, "this capture");
  });

  it("arms on the first edit", () => {
    const { onDirtyChange } = setup({ suggestIntent: true, suggestedIntentText: "Fix it" });
    onDirtyChange.mockClear();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Fix it properly" } });
    expect(onDirtyChange).toHaveBeenCalledWith(true, "this capture");
  });

  it("arms on flipping a toggle, which changes what will be created", () => {
    const { onDirtyChange } = setup();
    onDirtyChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /New Item/ }));
    expect(onDirtyChange).toHaveBeenCalledWith(true, "this capture");
  });

  it("disarms again when the edit is undone", () => {
    const { onDirtyChange } = setup({ suggestIntent: true, suggestedIntentText: "Fix it" });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Fix it properly" } });
    onDirtyChange.mockClear();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Fix it" } });
    expect(onDirtyChange).toHaveBeenCalledWith(false, "this capture");
  });

  it("disarms on unmount, so a stale flag cannot block the next screen", () => {
    const { onDirtyChange, unmount } = setup({ suggestIntent: true, suggestedIntentText: "Fix it" });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Changed" } });
    onDirtyChange.mockClear();
    unmount();
    expect(onDirtyChange).toHaveBeenCalledWith(false);
  });
});

// -- Step 17b: correcting the capture text -------------------------------------
//
// Alex ruled this back in. Without it, retiring the inbox card in Step 18 would
// leave no way in the app to fix a typo in a capture.
describe("correcting the captured text", () => {
  const pencil = () => screen.getByRole("button", { name: "Edit capture text" });
  const saveText = () => screen.getByRole("button", { name: /Save text/ });

  it("shows the capture read-only until the pencil is pressed", () => {
    setup();
    expect(screen.queryByLabelText("Capture text")).not.toBeInTheDocument();
    fireEvent.click(pencil());
    expect(screen.getByLabelText("Capture text")).toBeInTheDocument();
  });

  it("hides the pencil when there is no handler for it", () => {
    setup({}, { onSaveCaptureText: undefined });
    expect(screen.queryByRole("button", { name: "Edit capture text" })).not.toBeInTheDocument();
  });

  it("seeds the editor with the text as it stands", () => {
    setup();
    fireEvent.click(pencil());
    expect(screen.getByLabelText("Capture text")).toHaveValue(
      "Bug: browser Back skips the unsaved-changes guard.",
    );
  });

  it("saves the corrected text on its own, without filing anything", async () => {
    const { onSaveCaptureText, onProcess } = setup();
    fireEvent.click(pencil());
    fireEvent.change(screen.getByLabelText("Capture text"), { target: { value: "Corrected." } });
    fireEvent.click(saveText());
    await waitFor(() => expect(onSaveCaptureText).toHaveBeenCalledWith("inbox-1", "Corrected."));
    // A typo fix is not a triage.
    expect(onProcess).not.toHaveBeenCalled();
  });

  it("refuses to save an empty capture", () => {
    const { onSaveCaptureText } = setup();
    fireEvent.click(pencil());
    fireEvent.change(screen.getByLabelText("Capture text"), { target: { value: "   " } });
    expect(saveText()).toBeDisabled();
    fireEvent.click(saveText());
    expect(onSaveCaptureText).not.toHaveBeenCalled();
  });

  it("stays open when the save fails, holding what was typed", async () => {
    const failing = jest.fn().mockResolvedValue(false);
    setup({}, { onSaveCaptureText: failing });
    fireEvent.click(pencil());
    fireEvent.change(screen.getByLabelText("Capture text"), { target: { value: "Corrected." } });
    fireEvent.click(saveText());
    await waitFor(() => expect(failing).toHaveBeenCalled());
    expect(screen.getByLabelText("Capture text")).toHaveValue("Corrected.");
  });

  it("throws the edit away on its own Cancel", () => {
    const { onSaveCaptureText } = setup();
    fireEvent.click(pencil());
    fireEvent.change(screen.getByLabelText("Capture text"), { target: { value: "Corrected." } });
    fireEvent.click(screen.getAllByRole("button", { name: /Cancel/ })[0]);
    expect(onSaveCaptureText).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Capture text")).not.toBeInTheDocument();
  });

  it("arms the unsaved-changes guard while the edit is unsaved", () => {
    // The one field on the old card that could be lost by navigating away.
    const { onDirtyChange } = setup();
    fireEvent.click(pencil());
    onDirtyChange.mockClear();
    fireEvent.change(screen.getByLabelText("Capture text"), { target: { value: "Corrected." } });
    expect(onDirtyChange).toHaveBeenCalledWith(true, "this capture");
  });

  it("warns that saving clears the suggestions, but only when there are some", () => {
    setup({ aiStatus: "enriched" });
    fireEvent.click(pencil());
    fireEvent.change(screen.getByLabelText("Capture text"), { target: { value: "Corrected." } });
    expect(screen.getByText(/clears/)).toBeInTheDocument();
  });

  it("says nothing about suggestions on a capture that was never enriched", () => {
    setup();
    fireEvent.click(pencil());
    fireEvent.change(screen.getByLabelText("Capture text"), { target: { value: "Corrected." } });
    expect(screen.queryByText(/clears/)).not.toBeInTheDocument();
  });

  it("writes the corrected text BEFORE filing, when both are pending", async () => {
    // "A triage in the same press files the corrected text rather than the text
    // being corrected."
    const order = [];
    const onSaveCaptureText = jest.fn(async () => {
      order.push("text");
      return true;
    });
    const { onProcess } = setup(
      { suggestIntent: true, suggestedIntentText: "Fix it" },
      { onSaveCaptureText },
    );
    onProcess.mockImplementation(() => order.push("process"));
    fireEvent.click(pencil());
    fireEvent.change(screen.getByLabelText("Capture text"), { target: { value: "Corrected." } });
    fireEvent.click(processButton());
    await waitFor(() => expect(onProcess).toHaveBeenCalled());
    expect(order).toEqual(["text", "process"]);
  });

  it("files nothing when the text save fails", async () => {
    const failing = jest.fn().mockResolvedValue(false);
    const { onProcess } = setup(
      { suggestIntent: true, suggestedIntentText: "Fix it" },
      { onSaveCaptureText: failing },
    );
    fireEvent.click(pencil());
    fireEvent.change(screen.getByLabelText("Capture text"), { target: { value: "Corrected." } });
    fireEvent.click(processButton());
    await waitFor(() => expect(failing).toHaveBeenCalled());
    expect(onProcess).not.toHaveBeenCalled();
  });

  it("moves a name that was still showing the capture verbatim", async () => {
    // A pre-filled name follows the correction; a name the user wrote is theirs.
    const { onSaveCaptureText, onProcess } = setup({ suggestIntent: true });
    expect(screen.getByLabelText("Name")).toHaveValue(
      "Bug: browser Back skips the unsaved-changes guard.",
    );
    fireEvent.click(pencil());
    fireEvent.change(screen.getByLabelText("Capture text"), { target: { value: "Corrected." } });
    fireEvent.click(saveText());
    // Waiting for the call is not enough: the state updates run in the promise
    // continuation after it. Wait for what should actually be true.
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Corrected."));
    expect(onSaveCaptureText).toHaveBeenCalled();
    fireEvent.click(processButton());
    expect(onProcess.mock.calls[0][1].intentionData.text).toBe("Corrected.");
  });

  it("leaves a name the user wrote alone", async () => {
    const { onSaveCaptureText } = setup({ suggestIntent: true });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My own wording" } });
    fireEvent.click(pencil());
    fireEvent.change(screen.getByLabelText("Capture text"), { target: { value: "Corrected." } });
    fireEvent.click(saveText());
    await waitFor(() => expect(onSaveCaptureText).toHaveBeenCalled());
    // The editor closing is the observable end of the save, and it happens in the
    // same continuation as the name decision — so once it has closed, the name has
    // been left alone or moved, and this assertion is not racing it.
    await waitFor(() => expect(screen.queryByLabelText("Capture text")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Name")).toHaveValue("My own wording");
  });

  it("does not report the rest of the form dirty after a text save", async () => {
    // The save clears the enrichment in the database, so `inboxItem` arrives back
    // with every suggestion nulled. A baseline that tracked the row would call a
    // form nobody had touched different from itself in a dozen places.
    const { onSaveCaptureText, onDirtyChange, rerender } = setup({
      suggestItem: true,
      suggestIntent: true,
      suggestedItemText: "An item",
      suggestedIntentText: "An intention",
      suggestedTags: ["bug"],
    });
    fireEvent.click(pencil());
    fireEvent.change(screen.getByLabelText("Capture text"), { target: { value: "Corrected." } });
    fireEvent.click(saveText());
    await waitFor(() => expect(screen.queryByLabelText("Capture text")).not.toBeInTheDocument());

    onDirtyChange.mockClear();
    // What Alfred hands back: the corrected text, and the enrichment gone.
    rerender(
      <InboxDetailView
        inboxItem={{
          ...capture(),
          capturedText: "Corrected.",
          aiStatus: "not_started",
          suggestItem: false,
          suggestIntent: false,
          suggestedItemText: null,
          suggestedIntentText: null,
          suggestedTags: [],
        }}
        contexts={CONTEXTS}
        items={ITEMS}
        tagPool={[]}
        onProcess={jest.fn()}
        onDiscard={jest.fn()}
        onBack={jest.fn()}
        onDirtyChange={onDirtyChange}
        onSaveCaptureText={onSaveCaptureText}
        renderRecurrence={() => null}
      />,
    );
    expect(onDirtyChange).not.toHaveBeenCalledWith(true, "this capture");
  });
});

describe("leaving", () => {
  it("goes back on Cancel, having cleared the guard first", () => {
    const { onBack, onDirtyChange, onProcess } = setup({
      suggestIntent: true,
      suggestedIntentText: "Fix it",
    });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Changed" } });
    onDirtyChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    // Cleared BEFORE onBack: Cancel is a deliberate abandonment and must not then
    // ask whether to abandon.
    expect(onDirtyChange).toHaveBeenCalledWith(false);
    expect(onBack).toHaveBeenCalled();
    expect(onProcess).not.toHaveBeenCalled();
  });

  it("discards by id, and leaves the navigating to the row disappearing", () => {
    const { onDiscard, onBack } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Discard/ }));
    expect(onDiscard).toHaveBeenCalledWith("inbox-1");
    expect(onBack).not.toHaveBeenCalled();
  });

  it("goes back on the Back link, through the guard", () => {
    const { onBack } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(onBack).toHaveBeenCalled();
  });
});
