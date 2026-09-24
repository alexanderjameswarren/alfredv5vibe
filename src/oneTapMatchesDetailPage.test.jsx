import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import InboxDetailView from "./InboxDetailView";
import { triageDataForOneTap } from "./utils/inboxSuggestions";

// ── The guarantee this file exists for ───────────────────────────────────────
//
// The inbox list's Process files a capture in ONE TAP from its suggestions. The detail
// page files whatever is on screen after you have looked at it. Both go through
// `handleInboxSave`, so both create the same kinds of record — but "one tap" is only
// trustworthy if it means EXACTLY "open it and press Process without changing
// anything".
//
// So that is what this asserts, against the real page rather than a description of it:
// render the detail page, press Process untouched, and compare what it emitted with
// what `triageDataForOneTap` produces from the same row. A future edit to either side
// that changes one and not the other fails here.

const CONTEXTS = [{ id: "ctx-alfred", name: "Alfred" }];
const ITEMS = [{ id: "item-1", name: "Vent fan" }];

/** What the detail page sends when Process is pressed with nothing edited. */
function fromDetailPage(inboxItem) {
  const onProcess = jest.fn();
  const { unmount } = render(
    <InboxDetailView
      inboxItem={inboxItem}
      contexts={CONTEXTS}
      items={ITEMS}
      tagPool={[]}
      onProcess={onProcess}
      onDiscard={jest.fn()}
      onBack={jest.fn()}
      onDirtyChange={jest.fn()}
      renderRecurrence={() => null}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Process/ }));
  expect(onProcess).toHaveBeenCalledTimes(1);
  const [id, data] = onProcess.mock.calls[0];
  unmount();
  return { id, data };
}

const row = (over) => ({
  id: "inbox-1",
  capturedText: "Retire the ai-enrich edge function",
  sourceType: "mcp",
  aiStatus: "enriched",
  ...over,
});

// Every shape the list's Process button can appear on. If a case is missing here, the
// list can file it differently from the page and nothing would say so.
const CASES = {
  "an item only": { suggestItem: true },
  "an intention only": { suggestIntent: true },
  "both": { suggestItem: true, suggestIntent: true },
  "an item with a name, description, context and tags": {
    suggestItem: true,
    suggestedItemText: "ai-enrich retirement",
    suggestedItemDescription: "Delete the function and its key.",
    suggestedContextId: "ctx-alfred",
    suggestedTags: ["ui", "bug"],
  },
  "an item with elements in the enrichment's vocabulary": {
    suggestItem: true,
    suggestedItemElements: [
      { text: "Shopping", type: "header" },
      { text: "Onions", type: "bullet", collectable: true },
      { text: "Rest", type: "step", offset_minutes: 30 },
    ],
  },
  "an intention with a date": { suggestIntent: true, suggestedEventDate: "2026-10-01" },
  "an intention linked to an existing item": { suggestIntent: true, suggestedItemId: "item-1" },
  "both, where a suggested existing item must lose to the new one": {
    suggestItem: true,
    suggestIntent: true,
    suggestedItemId: "item-1",
  },
  "a re-enriched row": {
    aiStatus: "re_enriched",
    suggestItem: true,
    suggestIntent: true,
    suggestedContextId: "ctx-alfred",
  },
  "a row whose suggested collection must be ignored": {
    suggestItem: true,
    suggestedCollectionId: "col-1",
  },
};

describe("one-tap Process files exactly what the detail page would", () => {
  for (const [name, suggestions] of Object.entries(CASES)) {
    it(name, () => {
      const inboxItem = row(suggestions);
      const { id, data } = fromDetailPage(inboxItem);
      expect(id).toBe(inboxItem.id);
      expect(triageDataForOneTap(inboxItem)).toEqual(data);
    });
  }

  it("covers every case the list can offer Process on", () => {
    // A reminder rather than a check: the list shows Process when a row is enriched and
    // suggests an item or an intention, and the cases above are the combinations of
    // those. Adding a suggestion field to either surface means adding a case.
    expect(Object.keys(CASES).length).toBeGreaterThanOrEqual(10);
  });
});
