import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ItemDetailView from "./ItemDetailView";

jest.mock("../inbox/PendingReminder", () => () => null);

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
