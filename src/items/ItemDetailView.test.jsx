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

const ROW = ["Start Now", "Schedule", "Edit", "More actions"];

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
  expect(notesApi.listRecentCompletions).toHaveBeenCalledWith({ itemId: "it1", intentId: null, limit: 3 });
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

test("row: Start Now, Schedule, Edit, ⋯ — labels, no icon-only", () => {
  renderItem({ status: "active" });
  const names = screen.getAllByRole("button").map((b) => b.textContent || b.getAttribute("aria-label"));
  expect(names.filter((n) => ROW.includes(n))).toEqual([
    "Start Now",
    "Schedule",
    "Edit",
    "More actions",
  ]);
});

test("menu: Create Intention, Clone, Add to Collection, Archive", () => {
  renderItem({ status: "active" });
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual([
    "Create Intention",
    "Clone",
    "Add to Collection",
    "Archive",
  ]);
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
  expect(screen.getByRole("menuitem", { name: "Clone" }).disabled).toBe(false);
  expect(screen.getByText("This item is closed. Set it to Active to use it.")).toBeTruthy();
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
