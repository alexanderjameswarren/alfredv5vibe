import React from "react";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import GroupDetailScreen from "./GroupDetailScreen";
import { currentUserId, listNotesForTargets } from "../notes/notesApi";

jest.mock("../notes/notesApi", () => ({
  currentUserId: jest.fn(),
  listNotesForTargets: jest.fn(),
  listExecutionNotes: jest.fn(),
  onNotesChanged: () => () => {},
  saveNote: jest.fn(),
  deleteNote: jest.fn(),
}));

// CRA resets mock implementations before each test.
beforeEach(() => {
  currentUserId.mockResolvedValue("u");
  listNotesForTargets.mockResolvedValue([]);
});
// The standard rows are tested where they live; here only which rows, in order.
jest.mock("../shared/RowList", () => ({ rows }) => (
  <ol aria-label="member rows">{rows.map((r) => <li key={r.key}>{r.name}</li>)}</ol>
));

const group = { id: "g", groupTypeId: "menu", contextId: "recipes", name: null, status: "someday", description: "Tuesday dinner" };
const groupTypes = [{ id: "menu", labelSingular: "Menu", labelPlural: "Menus", icon: "UtensilsCrossed" }];
const contexts = [{ id: "recipes", name: "Recipes" }];
const items = [{ id: "rice", name: "Rice" }, { id: "beans", name: "Beans" }];
const members = [
  { id: "m2", groupId: "g", memberType: "item", memberId: "rice", position: 2 },
  { id: "m1", groupId: "g", memberType: "item", memberId: "beans", position: 1 },
  { id: "m0", groupId: "g", memberType: "item", memberId: "rice", position: 3, removedAt: "2026-10-01T09:00:00Z" },
  { id: "m9", groupId: "g", memberType: "item", memberId: "gone", position: 4, removedAt: "2026-10-22T09:00:00Z" },
];

function renderPage(extra = {}) {
  const props = {
    group, groupTypes, groupMembers: members, contexts, items, intents: [], events: [], executions: [],
    onBack: jest.fn(), onEdit: jest.fn(), onArchive: jest.fn(), onRestore: jest.fn(), onOpenHistory: jest.fn(),
    onViewContextDetail: jest.fn(), onOpenExecution: jest.fn(), rowListProps: {}, ...extra,
  };
  render(<GroupDetailScreen {...props} />);
  return props;
}

// The notes load is async; each test lets it land so nothing updates after it ends.
const notesLoaded = () => screen.findByText("No notes yet");

test("header: derived title, status, context link; members in order", async () => {
  const props = renderPage();
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Beans + Rice");
  expect(screen.getByText("Someday")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Recipes/ }));
  expect(props.onViewContextDetail).toHaveBeenCalledWith("recipes");
  expect(within(screen.getByRole("list", { name: "member rows" })).getAllByRole("listitem").map((li) => li.textContent))
    .toEqual(["Beans", "Rice"]);
  await waitFor(() => expect(listNotesForTargets).toHaveBeenCalledWith({ itemIds: [], intentionIds: [], groupIds: ["g"] }));
  await notesLoaded();
});

test("only Edit and Archive; Archive asks first", async () => {
  const props = renderPage();
  await notesLoaded();
  expect(screen.queryByRole("button", { name: /Start Now|Schedule|Log Execution|Close/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(props.onEdit).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  expect(props.onArchive).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Archive" }));
  expect(props.onArchive).toHaveBeenCalledTimes(1);
});

test("recently removed lists what is not back, and links to the history", async () => {
  const props = renderPage();
  await notesLoaded();
  const panel = screen.getByRole("region", { name: "Recently removed" });
  // rice is live again, so only the unavailable one is listed, with no Put back.
  expect(within(panel).getByText("Unavailable")).toBeInTheDocument();
  expect(within(panel).queryByRole("button", { name: /Put back/ })).not.toBeInTheDocument();
  fireEvent.click(within(panel).getByRole("button", { name: "View removal history" }));
  expect(props.onOpenHistory).toHaveBeenCalled();
});

test("a live group shows no archived marker", async () => {
  renderPage();
  await notesLoaded();
  expect(screen.queryByText("Archived")).not.toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

test("an archived group says so and offers Restore as its only action", async () => {
  const onUnarchive = jest.fn();
  const archivedMembers = [...members, { id: "m8", groupId: "g", memberType: "item", memberId: "beans", position: 5, removedAt: "2026-10-22T11:00:00Z" }];
  render(
    <GroupDetailScreen
      group={{ ...group, archived: true }} groupTypes={groupTypes} groupMembers={archivedMembers} contexts={contexts}
      items={[...items, { id: "salt", name: "Salt" }]} intents={[]} events={[]} executions={[]}
      onBack={jest.fn()} onEdit={jest.fn()} onArchive={jest.fn()} onRestore={jest.fn()} onOpenHistory={jest.fn()}
      onViewContextDetail={jest.fn()} onOpenExecution={jest.fn()} onUnarchive={onUnarchive} rowListProps={{}}
    />,
  );
  expect(screen.getByText("Archived")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("This menu is archived.");
  for (const name of ["Archive", "Edit"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Put back/ })).not.toBeInTheDocument();
  expect(await screen.findByText(/notes cannot be added/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  expect(onUnarchive).toHaveBeenCalled();
});

test("no own intention yet: Recent executions reads None yet", async () => {
  renderPage();
  await notesLoaded();
  expect(within(screen.getByRole("region", { name: "Recent executions" })).getByText("None yet")).toBeInTheDocument();
});
