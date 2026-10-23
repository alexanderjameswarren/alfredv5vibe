import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import ExecutionDetailScreen from "./ExecutionDetailScreen";
import { GroupsProvider } from "../groups/GroupsContext";
import * as api from "../notes/notesApi";

jest.mock("../NotificationChainInline", () => ({
  useNotificationChain: () => ({ reload: async () => {} }),
  ChainUnreachableNotice: () => null,
  ElementNotification: () => null,
  ChainRemainingToggle: () => null,
}));
jest.mock("../notes/notesApi", () => ({
  currentUserId: jest.fn(),
  listExecutionNotes: jest.fn(),
  listNotesForExecutions: jest.fn(),
  listNotesForTargets: jest.fn(),
  saveNote: jest.fn(),
  deleteNote: jest.fn(),
  onNotesChanged: jest.fn(),
}));

// A finished cook's recipe runs are read by parent_execution_id.
let mockCookRows = [];
jest.mock("../supabaseClient", () => ({
  supabase: { from: () => ({ select: () => ({ in: async () => ({ data: mockCookRows, error: null }) }) }) },
}));

beforeEach(() => {
  api.currentUserId.mockResolvedValue("me");
  api.listExecutionNotes.mockResolvedValue([]);
  api.listNotesForExecutions.mockResolvedValue([]);
  api.listNotesForTargets.mockResolvedValue([]);
  api.onNotesChanged.mockReturnValue(() => {});
  api.saveNote.mockImplementation(async (n) => ({ id: "n", ...n }));
});

const menu = { id: "g", groupTypeId: "menu", name: "P5 Test Menu", contextId: "c" };
const groupTypes = [{ id: "menu", executionMode: "together", icon: "UtensilsCrossed" }];
const members = [
  { id: "m1", groupId: "g", memberType: "item", memberId: "rice", position: 1 },
  { id: "m2", groupId: "g", memberType: "item", memberId: "dal", position: 2 },
];
const items = [{ id: "rice", name: "Spanish Rice" }, { id: "dal", name: "Red Lentil Dal" }];
const own = { id: "o", groupId: "g", text: "Old menu name" };
const menuRun = { id: "mr", intentId: "o", eventId: "e", groupId: "g", contextId: "c", status: "active", itemIds: [], elements: [] };
const rice = { id: "r1", intentId: null, groupId: "g", parentExecutionId: "mr", itemIds: ["rice"], status: "active", elements: [] };
const dal = { id: "r2", intentId: null, groupId: "g", parentExecutionId: "mr", itemIds: ["dal"], status: "active", elements: [] };

function renderScreen(executionForRoute, extra = {}) {
  const props = {
    executionForRoute,
    intents: [own],
    events: [{ id: "e", intentId: "o", time: "2026-10-23" }],
    items,
    contexts: [{ id: "c", name: "Recipes" }],
    collections: [],
    setView: jest.fn(),
    getIntentDisplay: (i) => i.text,
    toggleExecutionElement: jest.fn(),
    updateExecutionElement: jest.fn(),
    closeExecution: jest.fn(),
    menuLists: { groups: [menu], groupTypes, members },
    recipeRuns: [rice, dal],
    setRecipeSkipped: jest.fn(),
    liveExecutions: [menuRun],
    onOpenExecution: jest.fn(),
    onViewContext: jest.fn(),
    ...extra,
  };
  render(
    <GroupsProvider itemGroups={[menu]} groupTypes={groupTypes} groupMembers={members} items={items} intents={[own]} onOpenGroup={jest.fn()}>
      <ExecutionDetailScreen {...props} />
    </GroupsProvider>,
  );
  return props;
}

test("a menu run: named after the menu, a section per recipe in member order, its note on the menu", async () => {
  renderScreen(menuRun);
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("P5 Test Menu");
  expect(within(screen.getByRole("navigation", { name: "Recipes" })).getAllByRole("button").map((b) => b.textContent)).toEqual([
    "Spanish Rice",
    "Red Lentil Dal",
  ]);
  // The hidden intention is never a link.
  expect(screen.queryByTitle(/Open intention/)).toBeNull();
  const box = await screen.findByLabelText("This execution's note");
  await waitFor(() => expect(box).not.toBeDisabled());
  fireEvent.change(box, { target: { value: "Dinner for four" } });
  fireEvent.blur(box);
  await waitFor(() =>
    expect(api.saveNote).toHaveBeenCalledWith(expect.objectContaining({ targetType: "group", targetId: "g", executionId: "mr" })),
  );
});

test("skipping a recipe goes through setRecipeSkipped", async () => {
  const props = renderScreen(menuRun);
  fireEvent.click(within(screen.getByRole("region", { name: "Spanish Rice" })).getByRole("button", { name: "Skip" }));
  expect(props.setRecipeSkipped).toHaveBeenCalledWith(rice, true);
  await screen.findByLabelText("This execution's note");
});

test("a finished cook shows its recipes read-only, marked done or skipped", async () => {
  mockCookRows = [
    { id: "r1", intent_id: null, group_id: "g", parent_execution_id: "mr", item_ids: ["rice"], status: "closed", outcome: "done", elements: [] },
    { id: "r2", intent_id: null, group_id: "g", parent_execution_id: "mr", item_ids: ["dal"], status: "closed", outcome: "skipped", elements: [] },
  ];
  renderScreen({ ...menuRun, status: "closed", outcome: "done", closedAt: "2026-10-23T18:00:00Z" }, { recipeRuns: [] });
  const rice$ = await screen.findByRole("region", { name: "Spanish Rice" });
  expect(within(rice$).getByText("Done")).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Red Lentil Dal" })).getByText("Skipped")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^(Skip|Unskip)$/ })).toBeNull();
  expect(screen.queryByText("No recipes in this menu.")).toBeNull();
  await screen.findByLabelText("Note on Spanish Rice");
});

test("an open recipe run is never shown alone: it points to its menu", () => {
  const props = renderScreen(rice);
  expect(screen.queryByRole("button", { name: "Complete" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open the menu" }));
  expect(props.onOpenExecution).toHaveBeenCalledWith(menuRun);
});
