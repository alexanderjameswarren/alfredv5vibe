import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import ItemDetailView from "./ItemDetailView";
import * as notesApi from "../notes/notesApi";
import { DELETE_NOTE_CONFIRM } from "../notes/NoteTimeline";
import { storage } from "../utils/storage";

jest.mock("../inbox/PendingReminder", () => () => null);
jest.mock("../notes/notesApi", () => ({
  currentUserId: jest.fn(),
  listNotesForTargets: jest.fn(),
  listRecentCompletions: jest.fn(),
  listRecentSkips: jest.fn(),
  countRecentExecutions: jest.fn(),
  listExecutionNotes: jest.fn(),
  listNotesForExecutions: jest.fn(),
  saveNote: jest.fn(),
  deleteNote: jest.fn(),
  onNotesChanged: jest.fn(),
}));

beforeEach(() => {
  notesApi.currentUserId.mockResolvedValue("me");
  notesApi.listNotesForTargets.mockResolvedValue([]);
  notesApi.listRecentCompletions.mockResolvedValue([]);
  notesApi.listRecentSkips.mockResolvedValue([]);
  notesApi.listExecutionNotes.mockResolvedValue([]);
  notesApi.listNotesForExecutions.mockResolvedValue([]);
  notesApi.onNotesChanged.mockReturnValue(() => {});
  notesApi.deleteNote.mockResolvedValue();
});

const at = "2026-10-01T12:00:00Z";

function renderItem(item, props = {}) {
  const handlers = {
    onStartNow: jest.fn(),
    onScheduleItem: jest.fn(),
    onOpenAddIntention: jest.fn(),
    onSetStatus: jest.fn(),
    onClone: jest.fn(),
    onAddToCollection: jest.fn(),
    onUpdateItem: jest.fn(),
    onBack: jest.fn(),
  };
  render(
    <ItemDetailView
      item={{ id: "it1", name: "Water plants", ...item }}
      intents={[]}
      events={[]}
      contexts={[]}
      items={[]}
      getIntentDisplay={(i) => i.text}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}


test("notes: one timeline across the item and both its intentions, recent completions by item", async () => {
  notesApi.listNotesForTargets.mockResolvedValue([
    { id: "a", userId: "me", targetType: "intention", targetId: "i1", body: "from one", createdAt: at },
    { id: "b", userId: "me", targetType: "intention", targetId: "i2", executionId: "x", body: "from two", createdAt: at },
    { id: "c", userId: "me", targetType: "item", targetId: "it1", body: "on item", createdAt: at },
  ]);
  const onOpenExecution = jest.fn();
  const onViewIntentionDetail = jest.fn();
  renderItem({ status: "active", contextId: "c1" }, {
    intents: [{ id: "i1", text: "Water", itemId: "it1" }, { id: "i2", text: "Feed", itemId: "it1" }],
    contexts: [{ id: "c1", name: "Home" }],
    onOpenExecution,
    onViewIntentionDetail,
    onViewContextDetail: jest.fn(),
  });
  expect(screen.getByTitle("Open context: Home")).toBeTruthy();
  expect(await screen.findByText("from one")).toBeTruthy();
  expect(screen.getByText("from two")).toBeTruthy();
  // Sources are icon links: the intention by name; the item itself (this page) is left out.
  const fromTwo = screen.getByText("from two").closest("li");
  fireEvent.click(within(fromTwo).getByRole("button", { name: "Open intention: Feed" }));
  expect(onViewIntentionDetail).toHaveBeenCalledWith("i2");
  expect(within(screen.getByText("on item").closest("li")).queryByRole("button", { name: /Open item/ })).toBeNull();
  expect(screen.queryByText(/on the item/)).toBeNull();
  // One grouped list: a single bordered container, dividers, no border per note.
  const list = screen.getByText("from one").closest("ul");
  expect(list.className).toMatch(/bg-card border border-border rounded-lg divide-y/);
  expect(screen.getByText("from one").closest("li").className).not.toMatch(/border/);
  // The execution icon opens the run the note was written in.
  const full = { id: "x", status: "closed" };
  const get = jest.spyOn(storage, "get").mockResolvedValue(full);
  fireEvent.click(within(fromTwo).getByTitle(/Open the execution this note was written in/));
  await waitFor(() => expect(onOpenExecution).toHaveBeenCalledWith(full));
  expect(get).toHaveBeenCalledWith("execution:x");
  get.mockRestore();
  expect(notesApi.listNotesForTargets).toHaveBeenCalledWith({ itemIds: ["it1"], intentionIds: ["i1", "i2"] });
  expect(notesApi.listRecentCompletions).toHaveBeenCalledWith({ itemId: "it1", intentId: null, limit: 5 });
});

test("open execution card picks up a note saved after the page opened", async () => {
  const listeners = [];
  notesApi.onNotesChanged.mockImplementation((fn) => {
    listeners.push(fn);
    return () => {};
  });
  renderItem({ status: "active" }, {
    intents: [{ id: "i1", text: "Water", itemId: "it1" }],
    executions: [{ id: "x", intentId: "i1", itemIds: ["it1"], status: "paused" }],
    onOpenExecution: jest.fn(),
  });
  await waitFor(() => expect(notesApi.listExecutionNotes).toHaveBeenCalledWith("x"));
  notesApi.listExecutionNotes.mockResolvedValue([{ id: "late", body: "late note" }]);
  listeners.forEach((fn) => fn({ id: "late", executionId: "x" }));
  const shown = await screen.findAllByText("late note");
  expect(shown.some((el) => el.closest("[data-state]")?.getAttribute("data-state") === "paused")).toBe(true);
});

test("notes: my note can be edited and deleted (after a confirm); a shared one cannot", async () => {
  notesApi.listNotesForTargets.mockResolvedValue([
    { id: "m", userId: "me", targetType: "item", targetId: "it1", body: "mine", createdAt: at },
    { id: "s", userId: "friend", targetType: "item", targetId: "it1", body: "theirs", createdAt: at },
  ]);
  notesApi.saveNote.mockImplementation(async ({ id, body }) => ({ id, userId: "me", targetType: "item", body, createdAt: at }));
  renderItem({ status: "active" });
  await screen.findByText("theirs");
  expect(screen.getByText(/· shared/)).toBeTruthy();
  const note = (text) => screen.getByText(text).closest("li");
  expect(within(note("theirs")).queryByRole("button")).toBeNull();

  fireEvent.click(within(note("mine")).getByRole("button", { name: "Edit note" }));
  const save = screen.getByRole("button", { name: "Save" });
  expect(save.className).toMatch(/bg-primary/);
  expect(save.querySelector("svg")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Cancel" }).className).toMatch(/bg-secondary/);
  fireEvent.change(screen.getByLabelText("Edit note text"), { target: { value: "mine, edited" } });
  fireEvent.click(save);
  expect(await screen.findByText("mine, edited")).toBeTruthy();
  expect(notesApi.saveNote).toHaveBeenCalledWith({ id: "m", body: "mine, edited" });

  const confirm = jest.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  const del = () => within(note("mine, edited")).getByRole("button", { name: "Delete note" });
  expect(del().className).toMatch(/text-destructive/);
  fireEvent.click(del());
  expect(notesApi.deleteNote).not.toHaveBeenCalled();
  fireEvent.click(del());
  await waitFor(() => expect(screen.queryByText("mine, edited")).toBeNull());
  expect(notesApi.deleteNote).toHaveBeenCalledWith("m");
  expect(confirm).toHaveBeenCalledWith(DELETE_NOTE_CONFIRM);
  confirm.mockRestore();
});

test("notes: adding a general note targets the item; an archived item has no input", async () => {
  notesApi.saveNote.mockImplementation(async (a) => ({ id: "new", userId: "me", targetType: "item", body: a.body, createdAt: at }));
  const { unmount } = render(
    <ItemDetailView item={{ id: "it1", name: "W", status: "closed" }} intents={[]} events={[]} contexts={[]} items={[]} getIntentDisplay={(i) => i.text} onBack={jest.fn()} />,
  );
  fireEvent.change(screen.getByLabelText("New note"), { target: { value: "general" } });
  fireEvent.click(screen.getByRole("button", { name: "Add note" }));
  expect(await screen.findByText("general")).toBeTruthy();
  expect(notesApi.saveNote).toHaveBeenCalledWith({ body: "general", targetType: "item", targetId: "it1" });
  unmount();
  render(
    <ItemDetailView item={{ id: "it1", name: "W", archived: true }} intents={[]} events={[]} contexts={[]} items={[]} getIntentDisplay={(i) => i.text} onBack={jest.fn()} />,
  );
  expect(screen.queryByLabelText("New note")).toBeNull();
  expect(screen.getByText(/archived, so notes cannot be added/)).toBeTruthy();
  await screen.findByText("None yet");
});

test("row, in order: Start Now, Schedule, Log Execution, Add to Collection, Clone, Edit, Archive, then ⋯", () => {
  renderItem({ status: "active" }, { onCompleteItem: jest.fn() });
  const names = screen.getAllByRole("button").map((b) => b.textContent.trim() || b.getAttribute("aria-label"));
  const row = ["Start Now", "Schedule", "Log Execution", "Add to Collection", "Clone", "Edit", "Archive", "More actions"];
  expect(names.filter((n) => row.includes(n))).toEqual([
    "Start Now",
    "Schedule",
    "Log Execution",
    "Add to Collection",
    "Clone",
    "Edit",
    "Archive",
    "More actions",
  ]);
});

test("Copy: a small icon after the name, name, description and link, no toast", async () => {
  const writeText = jest.fn().mockResolvedValue();
  Object.assign(navigator, { clipboard: { writeText } });
  const onNotify = jest.fn();
  renderItem({ status: "active", description: "Front and back" }, { onNotify });
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await screen.findByRole("button", { name: "Copied" });
  expect(writeText).toHaveBeenCalledWith("Water plants\n\nFront and back\n\nhttps://alfredv5vibe.vercel.app/it1");
  expect(onNotify).not.toHaveBeenCalled();
});

test("menu: Create Intention, after everything that fits", () => {
  renderItem({ status: "active" });
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Create Intention"]);
});

test("Skip only when the picked intention repeats and has a live date", () => {
  const daily = { type: "fixed", frequency: "daily", interval: 1 };
  const { unmount } = render(
    <ItemDetailView
      item={{ id: "it1", name: "Water plants", status: "active" }}
      intents={[{ id: "i1", itemId: "it1", status: "active", recurrenceConfig: daily }]}
      events={[{ id: "e1", intentId: "i1", time: "2099-01-01" }]}
      contexts={[]}
      items={[]}
      getIntentDisplay={(i) => i.text}
      onUpdateEvent={jest.fn()}
      onUpdateItem={jest.fn()}
      onBack={jest.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
  unmount();
  renderItem({ status: "active" }, { onUpdateEvent: jest.fn() });
  expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
});

test("Log Execution on an item opens 'Log execution' and records through onCompleteItem", async () => {
  const onCompleteItem = jest.fn().mockResolvedValue(true);
  renderItem({ status: "active" }, { onCompleteItem });
  fireEvent.click(screen.getByRole("button", { name: "Log Execution" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Log execution" })).getByRole("button", { name: "Log" }));
  await waitFor(() => expect(onCompleteItem).toHaveBeenCalledWith("it1", expect.objectContaining({ note: "" })));
});

test("Log Execution and Skip are hidden while the picked intention has an execution in progress", () => {
  const daily = { type: "fixed", frequency: "daily", interval: 1 };
  renderItem(
    { status: "active" },
    {
      onCompleteItem: jest.fn(),
      onUpdateEvent: jest.fn(),
      intents: [{ id: "i1", itemId: "it1", status: "active", recurrenceConfig: daily }],
      events: [{ id: "e1", intentId: "i1", time: "2099-01-01" }],
      executions: [{ id: "x", intentId: "i1", eventId: "e1", status: "active" }],
    },
  );
  expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Log Execution" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
});

test("Schedule creates for the item on the picked date", () => {
  const { onScheduleItem } = renderItem({ status: "active" });
  fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Schedule" })[1]);
  expect(onScheduleItem).toHaveBeenCalledWith(expect.objectContaining({ id: "it1" }), expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), undefined);
});

test("closed: Start Now, Schedule and the Create Intention row are disabled; Clone is not", () => {
  renderItem({ status: "closed" });
  expect(screen.getByRole("button", { name: "Start Now" }).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Schedule" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  expect(screen.getByRole("menuitem", { name: "Create Intention" }).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Clone" }).disabled).toBe(false);
  expect(screen.getByText("This item is Closed. Set it to Active to use it.")).toBeTruthy();
});

test("an intention mid-run wins: the item reads Continue and opens that run", () => {
  const run = { id: "x", intentId: "busy", status: "active" };
  const onOpenExecution = jest.fn();
  renderItem(
    { status: "active" },
    {
      intents: [
        { id: "some", itemId: "it1", status: "someday", createdAt: "2026-10-08" },
        { id: "busy", itemId: "it1", status: "active", createdAt: "2026-10-01" },
      ],
      events: [{ id: "e1", intentId: "busy", time: "2026-10-08" }],
      executions: [run],
      onOpenExecution,
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(onOpenExecution).toHaveBeenCalledWith(run);
  expect(screen.getByRole("button", { name: "Reschedule" }).disabled).toBe(true);
});

test("Schedule passes the targeted intention through", () => {
  const { onScheduleItem } = renderItem(
    { status: "active" },
    { intents: [{ id: "only", itemId: "it1", status: "active" }] },
  );
  fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Schedule" })[1]);
  expect(onScheduleItem.mock.calls[0][2]).toBe("only");
});

test("edit form: status waits for Save", async () => {
  const { onSetStatus, onUpdateItem } = renderItem({ status: "active" }, { startInEditMode: true });
  fireEvent.click(screen.getByRole("radio", { name: "Background" }));
  expect(onSetStatus).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSetStatus).toHaveBeenCalledWith("it1", "background"));
  expect(onUpdateItem.mock.calls[0][1].status).toBeUndefined();
});

test("edit form: Closed then Save opens Close; its Cancel leaves the form open with the changes", async () => {
  const onCloseRecords = jest.fn();
  const { onUpdateItem } = renderItem({ status: "active" }, { startInEditMode: true, onCloseRecords });
  fireEvent.change(screen.getByDisplayValue("Water plants"), { target: { value: "Water plants twice" } });
  fireEvent.click(screen.getByRole("radio", { name: "Closed" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const dialog = await screen.findByRole("dialog", { name: "Close" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog", { name: "Close" })).toBeNull();
  expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  expect(screen.getByDisplayValue("Water plants twice")).toBeTruthy();
  expect(onUpdateItem).not.toHaveBeenCalled();
  expect(onCloseRecords).not.toHaveBeenCalled();
});

test("a running execution sits under In progress, as on every other screen", () => {
  renderItem({ status: "active" }, { executions: [{ id: "x", intentId: "a", status: "active", itemIds: ["it1"] }] });
  expect(screen.getByText("In progress (1)")).toBeTruthy();
  expect(screen.queryByText(/^Executions \(/)).toBeNull();
});

test("related intentions close rather than archive", () => {
  renderItem(
    { status: "active" },
    {
      onCloseRecords: jest.fn(),
      onViewIntentionDetail: jest.fn(),
      intents: [
        { id: "a", text: "First", itemId: "it1", status: "active", tags: [] },
        { id: "b", text: "Second", itemId: "it1", status: "active", tags: [] },
      ],
    },
  );
  expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(2);
  expect(screen.queryByTitle(/Archive this intention/)).toBeNull();
});

test("an intention with an open run shows only under In progress, and the counts skip it", () => {
  renderItem(
    { status: "active" },
    {
      onCloseRecords: jest.fn(),
      intents: [
        { id: "a", text: "First", itemId: "it1", status: "active", tags: [] },
        { id: "b", text: "Second", itemId: "it1", status: "active", tags: [] },
      ],
      executions: [{ id: "x", intentId: "b", status: "paused", itemIds: ["it1"] }],
    },
  );
  expect(screen.getByText("Related Intentions (1)")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Active (1)" })).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
});

// Restructure P5 step 12, bug mvjx4363b4bn4gezrys.
describe("archived item", () => {
  it("shows the Archived pill and Restore as the only action", () => {
    const { onUpdateItem } = renderItem({ archived: true, status: "active" });
    expect(screen.getByText("Archived")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("This item is archived.");
    for (const name of [/Start Now/, /^Schedule/, /^Edit$/, /^Archive$/, /Log Execution/]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(onUpdateItem).toHaveBeenCalledWith("it1", { archived: false });
  });

  it("never opens the edit form, even when asked to start in it", () => {
    renderItem({ archived: true }, { startInEditMode: true });
    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});

describe("item groups in the header", () => {
  it("links each live group the item is in, after the context", () => {
    const { GroupsProvider } = require("../groups/GroupsContext");
    const onOpenGroup = jest.fn();
    render(
      <GroupsProvider
        itemGroups={[{ id: "g1", name: "Taco night", groupTypeId: "menu" }, { id: "g2", name: "Old", archived: true }]}
        groupTypes={[{ id: "menu", icon: "UtensilsCrossed" }]}
        groupMembers={[
          { id: "m1", groupId: "g1", memberType: "item", memberId: "it1", position: 1 },
          { id: "m2", groupId: "g2", memberType: "item", memberId: "it1", position: 1 },
        ]}
        onOpenGroup={onOpenGroup}
      >
        <ItemDetailView
          item={{ id: "it1", name: "Rice", contextId: "c1" }}
          intents={[]}
          events={[]}
          contexts={[{ id: "c1", name: "Recipes" }]}
          items={[]}
          getIntentDisplay={(i) => i.text}
          onViewContextDetail={jest.fn()}
          onBack={jest.fn()}
        />
      </GroupsProvider>,
    );
    const links = within(screen.getByLabelText("Linked records")).getAllByRole("button").map((b) => b.getAttribute("title"));
    expect(links).toEqual(["Open context: Recipes", "Open group: Taco night"]);
    fireEvent.click(screen.getByRole("button", { name: "Open group: Taco night" }));
    expect(onOpenGroup).toHaveBeenCalledWith("g1");
  });
});
