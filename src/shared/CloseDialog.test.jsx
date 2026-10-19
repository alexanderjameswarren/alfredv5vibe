import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import CloseDialog from "./CloseDialog";

const today = "2026-10-19";

function renderDialog(props = {}) {
  const onConfirm = jest.fn().mockResolvedValue(true);
  const onCancel = jest.fn();
  render(<CloseDialog title='Close "Run"' today={today} onConfirm={onConfirm} onCancel={onCancel} {...props} />);
  return { onConfirm, onCancel };
}

test("two-way choice, note, Closed on today; Close waits for a choice", async () => {
  const { onConfirm } = renderDialog();
  const close = screen.getByRole("button", { name: "Close" });
  expect(close).toBeDisabled();
  expect(screen.getByText(/Closed on: .*October 19/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "Completed" }));
  fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "ok" } });
  fireEvent.click(close);
  await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ reason: "done", note: "ok", closedOn: today }));
});

test("toggles: Completed in the brown tone, Won't do in tan, each with its icon", () => {
  renderDialog({ defaultReason: "done" });
  const done = screen.getByRole("radio", { name: "Completed" });
  const wont = screen.getByRole("radio", { name: "Won't do" });
  expect(done.className).toMatch(/bg-primary text-white/);
  expect(wont.className).toMatch(/border-primary\/40 .*bg-card text-foreground/);
  expect(done.querySelector("svg")).toBeTruthy();
  expect(wont.querySelector("svg")).toBeTruthy();
});

test("renders at the page root, outside the form that opened it", () => {
  const { container } = render(<div data-testid="form" />);
  renderDialog();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.querySelector('[role="dialog"]')).toBeTruthy();
});

test("Closed on takes any past day, never the future", async () => {
  const { onConfirm } = renderDialog({ defaultReason: "wont_do" });
  fireEvent.click(screen.getByRole("button", { name: "Change closed on" }));
  fireEvent.change(screen.getByLabelText("Closed on"), { target: { value: "2026-10-20" } });
  expect(screen.getByRole("alert")).toHaveTextContent("It cannot be closed in the future.");
  fireEvent.change(screen.getByLabelText("Closed on"), { target: { value: "2020-01-02" } });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ closedOn: "2020-01-02" })));
});

test("the events and reminders line, and the shared Cancel", () => {
  const { onCancel } = renderDialog({ pending: { future: [{ time: "2026-10-21" }], reminderCount: 2 } });
  expect(screen.getByText(/Closing archives the date and cancels the reminders/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalled();
});
