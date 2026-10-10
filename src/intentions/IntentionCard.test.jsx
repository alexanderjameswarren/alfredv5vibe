import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import IntentionCard from "./IntentionCard";
import * as notesApi from "../notes/notesApi";
import { _resetCardNotesCache } from "../notes/useCardExecutionNotes";

jest.mock("../notes/notesApi", () => ({ listNotesForExecutions: jest.fn(), onNotesChanged: jest.fn() }));

beforeEach(() => {
  _resetCardNotesCache();
  notesApi.listNotesForExecutions.mockResolvedValue([]);
});

function renderCard(intent, props = {}) {
  const handlers = { onStartNow: jest.fn(), onSchedule: jest.fn(), onViewDetail: jest.fn() };
  render(
    <IntentionCard
      intent={{ id: "i1", text: "Water plants", ...intent }}
      contexts={[]}
      items={[]}
      getIntentDisplay={(i) => i.text}
      showScheduling
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

test("row: Start Now first, then Schedule, and a status pill", () => {
  renderCard({ status: "active" });
  const labels = screen.getAllByRole("button").map((b) => b.textContent);
  expect(labels.indexOf("Start Now")).toBeLessThan(labels.indexOf("Schedule"));
  expect(screen.getByText("Active")).toBeTruthy();
});

test("row: the context name carries its folder icon", () => {
  renderCard({ status: "active", contextId: "c1" }, { contexts: [{ id: "c1", name: "Home" }] });
  const chip = screen.getByText("Home");
  expect(chip.querySelector("svg")).not.toBeNull();
});

test("row: Schedule opens a picker set to today without opening the detail", () => {
  const { onSchedule, onViewDetail } = renderCard({ status: "active" });
  fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
  expect(onViewDetail).not.toHaveBeenCalled();
  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  expect(screen.getByDisplayValue(ymd)).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Schedule" })[1]);
  expect(onSchedule).toHaveBeenCalledWith("i1", ymd);
});

test("row: closed disables Start Now and Schedule with a reason", () => {
  renderCard({ status: "closed" });
  for (const name of ["Start Now", "Schedule"]) {
    expect(screen.getByRole("button", { name }).disabled).toBe(true);
  }
  expect(screen.getByRole("button", { name: "Start Now" }).title).toMatch(/closed/);
  // Disabled Schedule drops the brown fill, so it cannot read as live.
  expect(screen.getByRole("button", { name: "Schedule" }).className).toMatch(/disabled:bg-secondary/);
  fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
  expect(document.querySelector('input[type="date"]')).toBeNull();
});

test("edit form: When offers Doesn't repeat / Repeat, and no raw date fields", () => {
  renderCard({ status: "active" }, { isEditing: true, onCancel: jest.fn() });
  expect(document.querySelector('input[type="date"]')).toBeNull();
  expect(screen.queryByText("Target Start Date")).toBeNull();
  expect(screen.getByRole("button", { name: "Doesn't repeat" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "Repeat" }).className).not.toMatch(/success/);
});

test("edit form: Doesn't repeat saves once with no stop date; the target start date is kept", () => {
  const onUpdate = jest.fn();
  renderCard(
    {
      status: "active",
      recurrenceConfig: { type: "fixed", frequency: "daily", interval: 1 },
      endDate: "2026-12-01",
      targetStartDate: "2026-10-01",
    },
    { isEditing: true, onCancel: jest.fn(), onUpdate },
  );
  expect(screen.getByText(/Ends .*December 1/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Doesn't repeat" }));
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  expect(onUpdate.mock.calls[0][1]).toMatchObject({
    recurrenceConfig: { type: "once" },
    endDate: null,
    targetStartDate: "2026-10-01",
  });
});

test("edit form: Remove end date keeps the repeat", () => {
  const onUpdate = jest.fn();
  renderCard(
    { status: "active", recurrenceConfig: { type: "fixed", frequency: "daily", interval: 1 }, endDate: "2026-12-01" },
    { isEditing: true, onCancel: jest.fn(), onUpdate },
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove end date" }));
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  expect(onUpdate.mock.calls[0][1]).toMatchObject({ endDate: null, recurrenceConfig: { frequency: "daily" } });
});

test("add form has no scheduling in its footer", () => {
  renderCard({ id: null, status: undefined }, { isEditing: true, onCancel: jest.fn() });
  expect(screen.queryByRole("button", { name: /Do Today|Schedule/ })).toBeNull();
});

test("edit form: the chosen status goes out with Save only", () => {
  const onUpdate = jest.fn();
  renderCard({ status: "active" }, { isEditing: true, onCancel: jest.fn(), editableStatus: true, onUpdate });
  fireEvent.click(screen.getByRole("radio", { name: "Closed" }));
  expect(onUpdate).not.toHaveBeenCalled();
  expect(screen.queryByRole("radio", { name: "Someday" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  expect(onUpdate.mock.calls[0][1].status).toBe("closed");
});

test("edit form: an unchanged status is not sent", () => {
  const onUpdate = jest.fn();
  renderCard({ status: "active" }, { isEditing: true, onCancel: jest.fn(), editableStatus: true, onUpdate });
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  expect("status" in onUpdate.mock.calls[0][1]).toBe(false);
});

test("row: 'last done' shows only once completed, beside last updated", () => {
  const { unmount } = render(
    <IntentionCard intent={{ id: "i1", text: "t", status: "active", updatedAt: "2026-10-09T12:00:00Z", lastCompletedAt: "2026-10-05T12:00:00Z" }} contexts={[]} items={[]} getIntentDisplay={(i) => i.text} />,
  );
  expect(screen.getByText(/last done: Oct 5, 2026 · last updated: Oct 9, 2026/)).toBeTruthy();
  unmount();
  renderCard({ status: "active", updatedAt: "2026-10-09T12:00:00Z", lastCompletedAt: null });
  expect(screen.queryByText(/last done/)).toBeNull();
  expect(screen.getByText(/last updated/)).toBeTruthy();
});

test("row: an open execution's notes show as one-line note lines", async () => {
  notesApi.listNotesForExecutions.mockResolvedValue([{ id: "n", executionId: "x", body: "halfway there" }]);
  const onViewDetail = jest.fn();
  renderCard({ status: "active" }, { executions: [{ id: "x", intentId: "i1", status: "active" }], onViewDetail });
  const line = await screen.findByText("halfway there");
  expect(line.className).toMatch(/truncate/);
  expect(line.closest("button")).toBeNull();
});

test("edit mode on an existing intention: Save, Cancel and Archive only", () => {
  renderCard({ status: "active" }, { isEditing: true, onArchive: jest.fn(), onCancel: jest.fn() });
  expect(screen.queryByRole("button", { name: "Do Today" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Schedule/ })).toBeNull();
  for (const name of ["Save Changes", "Cancel", "Archive"]) {
    expect(screen.getByRole("button", { name })).toBeTruthy();
  }
});
