import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import IntentionDetailView from "./IntentionDetailView";
import * as notesApi from "../notes/notesApi";
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
});

function renderDetail(props = {}) {
  const handlers = {
    onUpdateIntention: jest.fn(),
    onSetStatus: jest.fn(),
    onArchiveIntention: jest.fn(),
    onStartNow: jest.fn(),
    onSchedule: jest.fn(),
    onBack: jest.fn(),
  };
  render(
    <IntentionDetailView
      intention={{ id: "i1", text: "Water plants", status: "active" }}
      events={[{ id: "e1", intentId: "i1", time: "2026-10-10" }]}
      contexts={[]}
      items={[]}
      getIntentDisplay={(i) => i.text}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

function editToClosedAndSave() {
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.click(screen.getByRole("radio", { name: "Closed" }));
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
}

test("edit: Save with Closed and live events asks first, saving nothing", () => {
  const { onUpdateIntention, onSetStatus } = renderDetail();
  editToClosedAndSave();
  expect(screen.getByRole("dialog", { name: "Live events" })).toBeTruthy();
  expect(onUpdateIntention).not.toHaveBeenCalled();
  expect(onSetStatus).not.toHaveBeenCalled();
});

test("edit: closing saves the fields, then the status with its date archived", async () => {
  const { onUpdateIntention, onSetStatus } = renderDetail();
  editToClosedAndSave();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close and archive the date" }));
  await waitFor(() => expect(onSetStatus).toHaveBeenCalledWith("i1", "closed", { archiveEvents: true }));
  expect(onUpdateIntention.mock.calls[0][1].status).toBeUndefined();
});

test("edit: cancelling the sheet keeps the form open with nothing saved", () => {
  const { onUpdateIntention } = renderDetail();
  editToClosedAndSave();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "Save Changes" })).toBeTruthy();
  expect(onUpdateIntention).not.toHaveBeenCalled();
});

test("page row: four buttons always; labels follow the live event and open execution", () => {
  const live = [{ id: "e1", intentId: "i1", time: "2026-10-10" }];
  const cases = [
    { events: [], executions: [], labels: ["Start Now", "Schedule"] },
    { events: live, executions: [], labels: ["Start Now", "Reschedule"] },
    { events: live, executions: [{ id: "x", intentId: "i1", eventId: "e1" }], labels: ["Continue", "Reschedule"] },
  ];
  for (const { events, executions, labels } of cases) {
    const onOpenExecution = jest.fn();
    const { unmount } = render(
      <IntentionDetailView
        intention={{ id: "i1", text: "Water plants", status: "active" }}
        events={events}
        executions={executions}
        contexts={[]}
        items={[]}
        getIntentDisplay={(i) => i.text}
        onStartNow={jest.fn()}
        onSchedule={jest.fn()}
        onOpenExecution={onOpenExecution}
        onArchiveIntention={jest.fn()}
        onBack={jest.fn()}
      />,
    );
    for (const name of [...labels, "Edit", "More actions"]) {
      expect(screen.getAllByRole("button", { name }).length).toBeGreaterThan(0);
    }
    if (executions.length) {
      fireEvent.click(screen.getAllByRole("button", { name: "Continue" })[0]);
      expect(onOpenExecution).toHaveBeenCalledWith(executions[0]);
    }
    unmount();
  }
});

test("Reschedule: disabled while the run is active, enabled once paused", () => {
  for (const [status, disabled] of [["active", true], ["paused", false]]) {
    const { unmount } = render(
      <IntentionDetailView
        intention={{ id: "i1", text: "Water plants", status: "active" }}
        events={[{ id: "e1", intentId: "i1", time: "2026-10-10" }]}
        executions={[{ id: "x", intentId: "i1", eventId: "e1", status }]}
        contexts={[]}
        items={[]}
        getIntentDisplay={(i) => i.text}
        onStartNow={jest.fn()}
        onSchedule={jest.fn()}
        onBack={jest.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Reschedule" }).disabled).toBe(disabled);
    expect(Boolean(screen.queryByText(/Pause or cancel it before moving the date/))).toBe(disabled);
    unmount();
  }
});

test("header: context pill and linked item are links; no Linked Item card", () => {
  const onViewContextDetail = jest.fn();
  const onViewItemDetail = jest.fn();
  renderDetail({
    intention: { id: "i1", text: "Water plants", status: "active", itemId: "it1", contextId: "c1" },
    contexts: [{ id: "c1", name: "Home" }],
    items: [{ id: "it1", name: "Plants" }],
    onViewContextDetail,
    onViewItemDetail,
  });
  fireEvent.click(screen.getByTitle("Open context: Home"));
  expect(onViewContextDetail).toHaveBeenCalledWith("c1");
  fireEvent.click(screen.getByRole("button", { name: "Open item: Plants" }));
  expect(onViewItemDetail).toHaveBeenCalledWith("it1");
  expect(screen.queryByText("Linked Item")).toBeNull();
});

test("title pill: Closed with live events opens the sheet; nothing saved yet", () => {
  const { onSetStatus } = renderDetail();
  fireEvent.click(screen.getByRole("button", { name: /^Status:/ }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Closed" }));
  expect(screen.getByRole("dialog", { name: "Live events" })).toBeTruthy();
  expect(onSetStatus).not.toHaveBeenCalled();
});

test("notes: timeline, recent completions and the open execution load for this intention", async () => {
  notesApi.listNotesForTargets.mockResolvedValueOnce([
    { id: "n1", userId: "me", body: "general", createdAt: "2026-10-01T12:00:00Z" },
  ]);
  notesApi.listRecentCompletions.mockResolvedValueOnce([
    { executionId: "c1", completedAt: "2026-10-02T12:00:00Z", notes: [{ id: "n2", userId: "me", body: "ran well" }] },
  ]);
  notesApi.listExecutionNotes.mockResolvedValueOnce([{ id: "n3", body: "so far" }]);
  renderDetail({ executions: [{ id: "x", intentId: "i1", status: "paused" }], onOpenExecution: jest.fn() });
  expect(await screen.findByText("general")).toBeTruthy();
  expect(await screen.findByText("ran well")).toBeTruthy();
  expect(await screen.findByText("so far")).toBeTruthy();
  expect(notesApi.listNotesForTargets).toHaveBeenCalledWith({ itemIds: [], intentionIds: ["i1"] });
  expect(notesApi.listRecentCompletions).toHaveBeenCalledWith({ itemId: null, intentId: "i1", limit: 3 });
  expect(screen.queryByText("Previous executions")).toBeNull();
});

test("recent completions: no 'No note' line; a row opens that execution; open-run notes sit inside its card", async () => {
  notesApi.listRecentCompletions.mockResolvedValueOnce([
    { executionId: "c1", completedAt: "2026-10-02T12:00:00Z", notes: [] },
  ]);
  notesApi.listExecutionNotes.mockResolvedValueOnce([{ id: "n3", body: "so far" }]);
  const full = { id: "c1", status: "closed", elements: [] };
  const get = jest.spyOn(storage, "get").mockResolvedValue(full);
  const onOpenExecution = jest.fn();
  renderDetail({ executions: [{ id: "x", intentId: "i1", status: "active" }], onOpenExecution });
  const row = await screen.findByTitle("Open this completed execution");
  expect(row.className).toMatch(/bg-card border border-border rounded-lg/);
  expect(row.querySelector(".lucide-chevron-right")).toBeNull();
  expect(screen.queryByText("No note")).toBeNull();
  fireEvent.click(row);
  await waitFor(() => expect(onOpenExecution).toHaveBeenCalledWith(full));
  expect(get).toHaveBeenCalledWith("execution:c1");
  const line = await screen.findByText("so far");
  expect(line.closest("[data-state]").getAttribute("data-state")).toBe("active");
  // A plain line led by the note icon, not a white inset box.
  expect(line.parentElement.querySelector("svg")).not.toBeNull();
  expect(line.closest(".bg-card")).toBeNull();
  get.mockRestore();
});

test("notes: a closed intention takes a note; an archived one hides the input", async () => {
  const { unmount } = render(
    <IntentionDetailView intention={{ id: "i1", text: "t", status: "closed" }} events={[]} contexts={[]} items={[]} getIntentDisplay={(i) => i.text} onBack={jest.fn()} />,
  );
  expect(screen.getByLabelText("New note")).toBeTruthy();
  unmount();
  render(
    <IntentionDetailView intention={{ id: "i1", text: "t", status: "closed", archived: true }} events={[]} contexts={[]} items={[]} getIntentDisplay={(i) => i.text} onBack={jest.fn()} />,
  );
  expect(screen.queryByLabelText("New note")).toBeNull();
  expect(screen.getByText(/archived, so notes cannot be added/)).toBeTruthy();
  await screen.findByText("No notes yet");
});

test("notes on this intention don't link back to it; their execution is an icon link", async () => {
  notesApi.listNotesForTargets.mockResolvedValue([
    { id: "n", userId: "me", targetType: "intention", targetId: "i1", executionId: "x", body: "ran long", createdAt: "2026-10-01T12:00:00Z" },
  ]);
  renderDetail({ onOpenExecution: jest.fn() });
  const row = (await screen.findByText("ran long")).closest("li");
  expect(within(row).queryByRole("button", { name: /Open intention/ })).toBeNull();
  expect(within(row).getByTitle(/Open the execution this note was written in/)).toBeTruthy();
  expect(within(row).queryByText(/during an execution/)).toBeNull();
});

test("title pill: a running execution refuses with its reason", () => {
  const { onSetStatus } = renderDetail({ executions: [{ id: "x", intentId: "i1" }] });
  fireEvent.click(screen.getByRole("button", { name: /^Status:/ }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Background" }));
  expect(screen.getByRole("alert").textContent).toMatch(/execution is in progress/);
  expect(onSetStatus).not.toHaveBeenCalled();
});
