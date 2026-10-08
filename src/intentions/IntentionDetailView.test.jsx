import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import IntentionDetailView from "./IntentionDetailView";

jest.mock("../inbox/PendingReminder", () => () => null);
jest.mock("../executions/PreviousExecutions", () => () => null);

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

test("Linked Item badge names the intention its run belongs to, even another one", () => {
  render(
    <IntentionDetailView
      intention={{ id: "i1", text: "Water plants", status: "active", itemId: "it1" }}
      intents={[
        { id: "i1", text: "Water plants", itemId: "it1" },
        { id: "i2", text: "SomeDay test 4", itemId: "it1" },
      ]}
      events={[]}
      executions={[{ id: "x", intentId: "i2", itemIds: ["it1"], status: "active" }]}
      contexts={[]}
      items={[{ id: "it1", name: "Plants" }]}
      getIntentDisplay={(i) => i.text}
      onOpenExecution={jest.fn()}
      onBack={jest.fn()}
    />,
  );
  expect(screen.getByText("SomeDay test 4")).toBeTruthy();
  expect(screen.queryByText("Execution")).toBeNull();
});

test("title pill: Closed with live events opens the sheet; nothing saved yet", () => {
  const { onSetStatus } = renderDetail();
  fireEvent.click(screen.getByRole("button", { name: /^Status:/ }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Closed" }));
  expect(screen.getByRole("dialog", { name: "Live events" })).toBeTruthy();
  expect(onSetStatus).not.toHaveBeenCalled();
});

test("title pill: a running execution refuses with its reason", () => {
  const { onSetStatus } = renderDetail({ executions: [{ id: "x", intentId: "i1" }] });
  fireEvent.click(screen.getByRole("button", { name: /^Status:/ }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Background" }));
  expect(screen.getByRole("alert").textContent).toMatch(/execution is in progress/);
  expect(onSetStatus).not.toHaveBeenCalled();
});
