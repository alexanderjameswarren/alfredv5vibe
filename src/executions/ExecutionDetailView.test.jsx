import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import ExecutionDetailView, { DELETE_EXECUTION_CONFIRM } from "./ExecutionDetailView";
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

const PLACEHOLDER = "Add notes about this execution...";
const confirmComplete = () =>
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Complete" }));
const note = (o) => ({ id: "n", userId: "me", targetType: "intention", targetId: "i1", createdAt: "2026-10-01T12:00:00Z", ...o });

beforeEach(() => {
  api.currentUserId.mockResolvedValue("me");
  api.listExecutionNotes.mockResolvedValue([]);
  api.listNotesForExecutions.mockResolvedValue([]);
  api.onNotesChanged.mockReturnValue(() => {});
  api.listNotesForTargets.mockResolvedValue([]);
  api.saveNote.mockImplementation(async (a) => (a.body.trim() ? note({ id: "saved", body: a.body.trim(), executionId: a.executionId }) : null));
});

function renderRun(status = "active", extra = {}) {
  const h = {
    onViewContext: jest.fn(),
    onViewIntention: jest.fn(),
    onViewItem: jest.fn(),
    onComplete: jest.fn(),
  };
  render(
    <ExecutionDetailView
      execution={{ id: "x", status, contextId: "c1", intentId: "i1", itemIds: ["it1"], elements: [] }}
      intent={{ id: "i1", text: "Water plants", itemId: "it1" }}
      event={{ id: "e1", time: "2026-10-08" }}
      items={[{ id: "it1", name: "Plant list" }]}
      contexts={[{ id: "c1", name: "Home" }]}
      getIntentDisplay={(i) => i.text}
      onPause={jest.fn()}
      onMakeActive={jest.fn()}
      onCancel={jest.fn()}
      onBack={jest.fn()}
      {...h}
      {...extra}
    />,
  );
  return h;
}

test("links save the typed note to the notes table first", async () => {
  const h = renderRun();
  fireEvent.change(await screen.findByPlaceholderText(PLACEHOLDER), { target: { value: "draft" } });
  fireEvent.click(screen.getByTitle("Open context: Home"));
  expect(h.onViewContext).toHaveBeenCalledWith("c1");
  await waitFor(() =>
    expect(api.saveNote).toHaveBeenCalledWith({
      id: undefined, body: "draft", targetType: "intention", targetId: "i1", executionId: "x",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Open intention: Water plants" }));
  expect(h.onViewIntention).toHaveBeenCalledWith("i1");
  fireEvent.click(screen.getByRole("button", { name: "Open item: Plant list" }));
  expect(h.onViewItem).toHaveBeenCalledWith("it1");
});

test("blur then leaving inserts the note once", async () => {
  renderRun();
  const box = await screen.findByPlaceholderText(PLACEHOLDER);
  fireEvent.change(box, { target: { value: "once" } });
  fireEvent.blur(box);
  fireEvent.click(screen.getByTitle("Open context: Home"));
  await waitFor(() => expect(api.saveNote).toHaveBeenCalledTimes(1));
  await new Promise((r) => setTimeout(r, 20));
  expect(api.saveNote).toHaveBeenCalledTimes(1);
});

test("my note is in the box; another person's note on this run is in the list, read only", async () => {
  const mine = note({ id: "a", body: "mine", executionId: "x" });
  const theirs = note({ id: "b", userId: "friend", body: "theirs", executionId: "x" });
  api.listExecutionNotes.mockResolvedValue([mine, theirs]);
  api.listNotesForTargets.mockResolvedValue([mine, theirs]);
  renderRun();
  expect(await screen.findByDisplayValue("mine")).toBeTruthy();
  const row = (await screen.findByText("theirs")).closest("li");
  expect(within(row).getByText("· shared")).toBeTruthy();
  expect(within(row).queryByRole("button", { name: /Edit note|Delete note/ })).toBeNull();
  // No link back to this same execution.
  expect(within(row).queryByTitle(/Open the execution/)).toBeNull();
  // My note is only in the box, never repeated in the list.
  await waitFor(() => expect(screen.queryAllByText("mine").filter((el) => el.closest("li"))).toHaveLength(0));
});

test("notes sit below the steps: box first, then earlier notes with icon links", async () => {
  api.listNotesForTargets.mockResolvedValue([
    note({ id: "p", body: "use less water", executionId: "old" }),
    note({ id: "q", body: "about the list", targetType: "item", targetId: "it1" }),
  ]);
  const h = renderRun("active", { onOpenExecution: jest.fn() });
  const earlier = await screen.findByText("use less water");
  expect(api.listNotesForTargets).toHaveBeenCalledWith({ itemIds: ["it1"], intentionIds: ["i1"] });
  // The box comes before the list.
  const box = screen.getByPlaceholderText(PLACEHOLDER);
  expect(box.compareDocumentPosition(earlier) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const row = earlier.closest("li");
  fireEvent.click(within(row).getByRole("button", { name: "Open intention: Water plants" }));
  expect(h.onViewIntention).toHaveBeenCalledWith("i1");
  expect(within(row).getByTitle(/Open the execution this note was written in/)).toBeTruthy();
  const itemRow = screen.getByText("about the list").closest("li");
  fireEvent.click(within(itemRow).getByRole("button", { name: "Open item: Plant list" }));
  expect(h.onViewItem).toHaveBeenCalledWith("it1");
});

test("Complete asks for a note only, saves it, then completes", async () => {
  const h = renderRun();
  await screen.findByPlaceholderText(PLACEHOLDER);
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  const dialog = screen.getByRole("dialog", { name: "Complete execution" });
  expect(dialog.querySelectorAll("textarea, input, select")).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "went well" } });
  confirmComplete();
  await waitFor(() => expect(h.onComplete).toHaveBeenCalled());
  expect(api.saveNote).toHaveBeenCalledWith(expect.objectContaining({ body: "went well", executionId: "x" }));
});

test("Complete without a note writes nothing", async () => {
  const h = renderRun();
  await screen.findByPlaceholderText(PLACEHOLDER);
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  confirmComplete();
  await waitFor(() => expect(h.onComplete).toHaveBeenCalled());
  expect(api.saveNote).not.toHaveBeenCalled();
});

test("a failed note save keeps the dialog open and does not complete", async () => {
  api.saveNote.mockRejectedValue(new Error("nope"));
  const h = renderRun();
  await screen.findByPlaceholderText(PLACEHOLDER);
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "x" } });
  confirmComplete();
  expect(await screen.findByText(/The note was not saved/)).toBeTruthy();
  expect(h.onComplete).not.toHaveBeenCalled();
});

test("Delete Execution asks first; declining deletes nothing", () => {
  const onCancel = jest.fn();
  const confirm = jest.spyOn(window, "confirm");
  render(
    <ExecutionDetailView
      execution={{ id: "x", status: "active", itemIds: [], elements: [] }}
      items={[]}
      contexts={[]}
      getIntentDisplay={() => ""}
      onCancel={onCancel}
      onComplete={jest.fn()}
      onPause={jest.fn()}
      onMakeActive={jest.fn()}
      onBack={jest.fn()}
    />,
  );
  const del = screen.getByRole("button", { name: "Delete Execution" });
  expect(del.className).toMatch(/text-destructive/);
  expect(del.className).toMatch(/border-destructive/);
  expect(del.className).not.toMatch(/bg-destructive /);
  confirm.mockReturnValueOnce(false);
  fireEvent.click(del);
  expect(onCancel).not.toHaveBeenCalled();
  confirm.mockReturnValueOnce(true);
  fireEvent.click(del);
  expect(onCancel).toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledWith(DELETE_EXECUTION_CONFIRM);
  confirm.mockRestore();
});

test("Complete is brown, Pause amber outline, Make Active teal", () => {
  renderRun("active");
  expect(screen.getByRole("button", { name: "Complete" }).className).toMatch(/bg-primary/);
  expect(screen.getByRole("button", { name: "Pause" }).className).toMatch(/border-warning bg-warning-light/);
});

test("a completed run is read only, apart from notes", async () => {
  api.listExecutionNotes.mockResolvedValue([note({ id: "m", body: "my note", executionId: "x" })]);
  const onToggleElement = jest.fn();
  const onUpdateElement = jest.fn();
  const onBack = jest.fn();
  render(
    <ExecutionDetailView
      execution={{
        id: "x", status: "closed", closedAt: "2026-10-05T12:00:00Z", intentId: "i1", itemIds: ["it1"],
        elements: [{ name: "Step one", displayType: "step" }, { name: "Step two", displayType: "step", isCompleted: true }],
      }}
      intent={{ id: "i1", text: "Water plants", itemId: "it1" }}
      items={[{ id: "it1", name: "Plant list" }]}
      contexts={[]}
      getIntentDisplay={(i) => i.text}
      onToggleElement={onToggleElement}
      onUpdateElement={onUpdateElement}
      onEditItem={jest.fn()}
      onComplete={jest.fn()}
      onPause={jest.fn()}
      onMakeActive={jest.fn()}
      onCancel={jest.fn()}
      onBack={onBack}
    />,
  );
  expect(screen.getByText(/Completed .* · read only/)).toBeTruthy();
  for (const name of ["Complete", "Pause", "Make Active", "Delete Execution", "Start", "Reset", "Edit item"]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
  }
  for (const box of screen.getAllByTestId("element-check")) fireEvent.click(box);
  expect(onToggleElement).not.toHaveBeenCalled();
  expect(onUpdateElement).not.toHaveBeenCalled();

  // Notes: the same layout as a running one; my one note stays editable.
  const box = await screen.findByDisplayValue("my note");
  fireEvent.change(box, { target: { value: "my note, later" } });
  fireEvent.blur(box);
  await waitFor(() =>
    expect(api.saveNote).toHaveBeenCalledWith({ id: "m", body: "my note, later", targetType: "intention", targetId: "i1", executionId: "x" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(onBack).toHaveBeenCalled();
});

test("a paused run keeps its notes box and is navigable", async () => {
  renderRun("paused");
  expect(screen.getByRole("button", { name: "Make Active" }).className).toMatch(/bg-success/);
  expect(screen.getByRole("button", { name: "Open intention: Water plants" })).toBeTruthy();
  expect(await screen.findByPlaceholderText(PLACEHOLDER)).toBeTruthy();
});
