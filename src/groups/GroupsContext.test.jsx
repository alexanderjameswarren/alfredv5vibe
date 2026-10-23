import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { chipsFor, chipForGroup, GroupsProvider, RecordGroupChips } from "./GroupsContext";
import ExecutionBadge from "../executions/ExecutionBadge";
import HomeScreen from "../schedule/HomeScreen";
import { buildGroupRows } from "../utils/rowModel";

const lists = {
  groups: [
    { id: "g1", groupTypeId: "menu", name: null },
    { id: "g2", groupTypeId: "proj", name: "Kitchen remodel" },
    { id: "g3", groupTypeId: "menu", name: "Archived menu", archived: true },
  ],
  groupTypes: [{ id: "menu", icon: "UtensilsCrossed" }, { id: "proj", icon: "SquareKanban" }],
  members: [
    { id: "a", groupId: "g1", memberType: "item", memberId: "rice", position: 1 },
    { id: "b", groupId: "g1", memberType: "item", memberId: "beans", position: 2 },
    { id: "c", groupId: "g2", memberType: "intention", memberId: "order", position: 1 },
    { id: "d", groupId: "g3", memberType: "item", memberId: "rice", position: 1 },
    { id: "e", groupId: "g2", memberType: "item", memberId: "rice", position: 2, removedAt: "t" },
  ],
  items: [{ id: "rice", name: "Rice" }, { id: "beans", name: "Beans" }],
  intents: [{ id: "order", text: "Order tiles" }],
};

test("chips: live groups of live memberships only, named and iconed, once each", () => {
  expect(chipsFor([{ memberType: "item", id: "rice" }], lists)).toEqual([{ id: "g1", name: "Rice + Beans", icon: "UtensilsCrossed" }]);
  expect(chipsFor([{ memberType: "item", id: "rice" }, { memberType: "item", id: "beans" }], lists)).toHaveLength(1);
  expect(chipsFor([{ memberType: "intention", id: "order" }], lists).map((c) => c.name)).toEqual(["Kitchen remodel"]);
  expect(chipsFor([{ memberType: "item", id: "nothing" }], lists)).toEqual([]);
  expect(chipForGroup("g3", lists)).toBeNull();
  expect(chipForGroup("g2", lists)).toMatchObject({ name: "Kitchen remodel" });
});

function withGroups(ui, onOpenGroup = jest.fn()) {
  render(
    <GroupsProvider itemGroups={lists.groups} groupTypes={lists.groupTypes} groupMembers={lists.members} items={lists.items} intents={lists.intents} onOpenGroup={onOpenGroup}>
      {ui}
    </GroupsProvider>,
  );
  return onOpenGroup;
}

test("a record's chip line opens the group; nothing when it is in none", () => {
  const onOpenGroup = withGroups(
    <>
      <RecordGroupChips records={[{ memberType: "item", id: "rice" }]} />
      <RecordGroupChips records={[{ memberType: "item", id: "nothing" }]} />
    </>,
  );
  expect(screen.getAllByLabelText("Groups")).toHaveLength(1);
  fireEvent.click(screen.getByTitle("Open group: Rice + Beans"));
  expect(onOpenGroup).toHaveBeenCalledWith("g1");
});

test("outside a provider there are no chips", () => {
  render(<RecordGroupChips records={[{ memberType: "item", id: "rice" }]} />);
  expect(screen.queryByLabelText("Groups")).not.toBeInTheDocument();
});

test("a running execution card shows its own group, else its intention's, as a plain line like its context", () => {
  const props = { intents: lists.intents, contexts: [], getIntentDisplay: (i) => i.text, onOpen: jest.fn() };
  const { container } = render(
    <GroupsProvider itemGroups={lists.groups} groupTypes={lists.groupTypes} groupMembers={lists.members} items={lists.items} intents={lists.intents} onOpenGroup={jest.fn()}>
      <ExecutionBadge exec={{ id: "x1", status: "active", groupId: "g1", itemIds: ["rice"] }} {...props} />
      <ExecutionBadge exec={{ id: "x2", status: "paused", intentId: "order" }} {...props} />
    </GroupsProvider>,
  );
  const lines = [...container.querySelectorAll("[data-group-line]")].map((p) => p.textContent);
  expect(lines).toEqual(["Rice + Beans", "Kitchen remodel"]);
  // No pill, no button: the card itself opens the run.
  expect(screen.queryByTitle(/Open group/)).not.toBeInTheDocument();
});

test("Home lists pinned groups, and only when there are some", () => {
  const base = {
    executionTab: "active", setExecutionTab: jest.fn(), activeExecutions: [], pausedExecutions: [], allLiveExecutions: [],
    todayEvents: [], visibleTodayEvents: [], pinnedCollections: [], pinnedContexts: [], intents: [], contexts: [], items: [],
    getIntentDisplay: (i) => i.text, searchFor: () => "", setSearchFor: () => () => {}, homeSort: { sortKey: "time", sortDir: "asc" },
    membersOf: () => [],
  };
  const rows = buildGroupRows({ groups: [{ id: "g2", groupTypeId: "proj", name: "Kitchen remodel", pinned: true }], groupTypes: lists.groupTypes, members: [], items: [], intents: [] });
  const onOpenGroup = jest.fn();
  const { rerender } = render(<HomeScreen {...base} pinnedGroupRows={rows} onOpenGroup={onOpenGroup} />);
  expect(screen.getByText("Pinned Groups")).toBeInTheDocument();
  expect(screen.getByLabelText("Pinned")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Kitchen remodel"));
  expect(onOpenGroup).toHaveBeenCalledWith("g2");
  rerender(<HomeScreen {...base} pinnedGroupRows={[]} onOpenGroup={onOpenGroup} />);
  expect(screen.queryByText("Pinned Groups")).not.toBeInTheDocument();
});
