import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import IntentionsScreen from "./IntentionsScreen";

jest.mock("../utils/remindersApi", () => ({ reminderBadge: () => null, getReminderSummary: jest.fn() }));

const liveIntentions = [
  { id: "a", text: "A", status: "active", tags: ["bug", "restructure"] },
  { id: "b", text: "B", status: "active", tags: ["bug"] },
  { id: "c", text: "C", status: "closed", tags: ["bug"] },
];

function renderScreen(props = {}) {
  return render(
    <IntentionsScreen
      liveIntentions={liveIntentions}
      intentionsStatus={{ selected: ["someday", "active"], toggle: () => {} }}
      validEvents={[]}
      allLiveExecutions={[]}
      reminderIndex={{ byIntent: {} }}
      contexts={[]}
      items={[]}
      activeCollections={[]}
      filterTag={null}
      setFilterTag={() => {}}
      tagsCollapsedFor={() => false}
      toggleTagsFor={() => () => {}}
      searchFor={() => ""}
      setSearchFor={() => () => {}}
      intentionsSort={{ sortKey: "title", sortDir: "asc", setSort: () => {} }}
      getIntentDisplay={(i) => i.text}
      openAddPage={() => {}}
      viewIntentionDetail={() => {}}
      closeRecords={jest.fn()}
      {...props}
    />,
  );
}

test("tag chips count only rows the status chips let through", () => {
  renderScreen({ intentionsStatus: { selected: ["closed"], toggle: () => {} } });
  expect(screen.getByRole("button", { name: /^bug \(1\)$/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /restructure/ })).toBeNull();
});

test("tag and status counts follow the search", () => {
  renderScreen({ searchFor: () => "A" });
  expect(screen.getByRole("button", { name: "bug (1)" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Active (1)" })).toBeInTheDocument();
});

test("an item and its intentions are one row, reading the item's status, opening item detail", () => {
  const viewItemDetail = jest.fn();
  renderScreen({
    items: [
      { id: "fan", name: "Vent fan", status: "someday", tags: [] },
      { id: "lonely", name: "No intention", status: "active", tags: [] },
    ],
    liveIntentions: [
      { id: "x", text: "Vent fan", itemId: "fan", status: "active", tags: [] },
      { id: "y", text: "Vent fan again", itemId: "fan", status: "active", tags: [] },
    ],
    viewItemDetail,
  });
  expect(screen.getAllByText("Vent fan")).toHaveLength(1);
  expect(screen.queryByText("No intention")).toBeNull();
  expect(screen.getByRole("button", { name: "Someday (1)" })).toBeInTheDocument();
  fireEvent.click(screen.getByText("Vent fan"));
  expect(viewItemDetail).toHaveBeenCalledWith("fan", "intentions");
});

test("rows close rather than archive", () => {
  renderScreen();
  expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(2);
  expect(screen.queryByTitle(/Archive this intention/)).toBeNull();
});

test("Last modified orders by the date the card shows, scheduled rows included", () => {
  const { container } = renderScreen({
    intentionsSort: { sortKey: "updated", sortDir: "desc", setSort: () => {} },
    liveIntentions: [
      { id: "old", text: "Old but scheduled", status: "active", tags: [], updatedAt: "2026-10-01T00:00:00Z" },
      { id: "new", text: "Newest", status: "active", tags: [], updatedAt: "2026-10-12T00:00:00Z" },
    ],
    validEvents: [{ id: "e", intentId: "old", time: "2026-10-14", archived: false }],
  });
  const titles = within(container).getAllByText(/Old but scheduled|Newest/).map((n) => n.textContent);
  expect(titles).toEqual(["Newest", "Old but scheduled"]);
});

test("a running intention is in the In progress section, not the list or its counts", () => {
  renderScreen({
    searchFor: () => "zzz",
    allLiveExecutions: [{ id: "x", intentId: "a", status: "active", itemIds: [] }],
  });
  expect(screen.getByText("In progress (1)")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Active (0)" })).toBeInTheDocument();
});

test("no In progress section when nothing runs", () => {
  renderScreen();
  expect(screen.queryByText(/In progress \(/)).toBeNull();
});

test("item rows carry the context label", () => {
  renderScreen({
    contexts: [{ id: "c1", name: "Kitchen" }],
    items: [{ id: "fan", name: "Vent fan", status: "active", contextId: "c1", tags: [] }],
    liveIntentions: [{ id: "x", text: "Vent fan", itemId: "fan", status: "closed", tags: [] }],
    intentionsStatus: { selected: ["active"], toggle: () => {} },
  });
  expect(screen.getByText("Kitchen")).toBeInTheDocument();
});
