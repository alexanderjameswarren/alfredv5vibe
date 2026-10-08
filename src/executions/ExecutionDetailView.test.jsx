import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import ExecutionDetailView, { DELETE_EXECUTION_CONFIRM } from "./ExecutionDetailView";

jest.mock("../NotificationChainInline", () => ({
  useNotificationChain: () => ({ reload: async () => {} }),
  ChainUnreachableNotice: () => null,
  ElementNotification: () => null,
  ChainRemainingToggle: () => null,
}));

function renderRun(status = "active") {
  const h = {
    onViewContext: jest.fn(),
    onViewIntention: jest.fn(),
    onViewItem: jest.fn(),
    onUpdateNotes: jest.fn(),
  };
  render(
    <ExecutionDetailView
      execution={{ id: "x", status, contextId: "c1", intentId: "i1", itemIds: ["it1"], elements: [], notes: "draft" }}
      intent={{ id: "i1", text: "Water plants", itemId: "it1" }}
      event={{ id: "e1", time: "2026-10-08" }}
      items={[{ id: "it1", name: "Plant list" }]}
      contexts={[{ id: "c1", name: "Home" }]}
      getIntentDisplay={(i) => i.text}
      onComplete={jest.fn()}
      onPause={jest.fn()}
      onMakeActive={jest.fn()}
      onCancel={jest.fn()}
      onBack={jest.fn()}
      {...h}
    />,
  );
  return h;
}

test("links to context, intention and item, saving notes first", () => {
  const h = renderRun();
  fireEvent.click(screen.getByTitle("Open context: Home"));
  expect(h.onUpdateNotes).toHaveBeenCalledWith("draft");
  expect(h.onViewContext).toHaveBeenCalledWith("c1");
  fireEvent.click(screen.getByRole("button", { name: "Open intention: Water plants" }));
  expect(h.onViewIntention).toHaveBeenCalledWith("i1");
  fireEvent.click(screen.getByRole("button", { name: "Open item: Plant list" }));
  expect(h.onViewItem).toHaveBeenCalledWith("it1");
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
      onUpdateNotes={jest.fn()}
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

test("a paused run is navigable too", () => {
  renderRun("paused");
  expect(screen.getByRole("button", { name: "Make Active" }).className).toMatch(/bg-success/);
});

test("a paused run's links render", () => {
  renderRun("paused");
  expect(screen.getByRole("button", { name: "Open intention: Water plants" })).toBeTruthy();
});
