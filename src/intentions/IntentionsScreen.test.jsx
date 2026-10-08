import React from "react";
import { render, screen } from "@testing-library/react";
import IntentionsScreen from "./IntentionsScreen";

jest.mock("../utils/remindersApi", () => ({ reminderBadge: () => null }));

const liveIntentions = [
  { id: "a", text: "A", status: "active", tags: ["bug", "restructure"] },
  { id: "b", text: "B", status: "active", tags: ["bug"] },
  { id: "c", text: "C", status: "closed", tags: ["bug"] },
];

test("tag chips count only rows the status chips let through", () => {
  render(
    <IntentionsScreen
      liveIntentions={liveIntentions}
      intentionStatusCounts={{ someday: 0, active: 2, background: 0, closed: 1 }}
      intentionsStatus={{ selected: ["closed"], toggle: () => {} }}
      visibleIntentions={[]}
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
      intentionsSort={{ sortKey: "name", sortDir: "asc", setSort: () => {} }}
      getIntentDisplay={(i) => i.text}
      openAddPage={() => {}}
    />,
  );
  expect(screen.getByRole("button", { name: /^bug \(1\)$/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /restructure/ })).toBeNull();
});
