import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import GroupRowCard from "./GroupRowCard";

const base = { key: "group:g", group: { id: "g", status: "active" }, name: "Rice + Beans", memberCount: 2, event: null, open: null };

test("not scheduled: Schedule picks a date for the group; Close is offered; neither opens the group", () => {
  const onSchedule = jest.fn();
  const onClose = jest.fn();
  const onOpen = jest.fn();
  render(<GroupRowCard row={base} onOpen={onOpen} onSchedule={onSchedule} onClose={onClose} />);
  expect(screen.getByText("Not scheduled")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Date"), { target: { value: "2099-02-03" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Schedule" }));
  expect(onSchedule).toHaveBeenCalledWith("g", "2099-02-03");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
});

test("scheduled: the when line and Reschedule; a closed group cannot be scheduled", () => {
  const event = { id: "e", time: "2099-02-03", archived: false };
  const { rerender } = render(<GroupRowCard row={{ ...base, event }} onSchedule={jest.fn()} />);
  expect(screen.getByText(/^Scheduled · /)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reschedule" })).toBeInTheDocument();
  rerender(<GroupRowCard row={{ ...base, group: { id: "g", status: "closed" } }} onSchedule={jest.fn()} />);
  expect(screen.getByRole("button", { name: "Schedule" })).toBeDisabled();
});

test("buttons sit beside the text, as on item and intention rows", () => {
  const { container } = render(<GroupRowCard row={base} onSchedule={jest.fn()} onClose={jest.fn()} />);
  const actions = container.querySelector("[data-row-actions]");
  expect(actions).toHaveClass("shrink-0", "self-end", "sm:self-auto");
  expect(actions.parentElement).toHaveClass("flex-col", "sm:flex-row", "sm:items-center", "sm:justify-between");
});

test("a menu row starts its cook, or continues the open one", () => {
  const onStartNow = jest.fn();
  const onOpenExecution = jest.fn();
  const { rerender } = render(<GroupRowCard row={base} onStartNow={onStartNow} onOpenExecution={onOpenExecution} />);
  fireEvent.click(screen.getByRole("button", { name: "Start Now" }));
  expect(onStartNow).toHaveBeenCalledWith("g");
  const open = { id: "x", status: "active" };
  rerender(<GroupRowCard row={{ ...base, open }} onStartNow={onStartNow} onOpenExecution={onOpenExecution} />);
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(onOpenExecution).toHaveBeenCalledWith(open);
});

test("a project's marker: teal In progress, amber Paused, none otherwise", () => {
  const { container, rerender } = render(<GroupRowCard row={{ ...base, memberRun: "active" }} />);
  expect(screen.getByText("In progress")).toHaveClass("bg-success-light");
  rerender(<GroupRowCard row={{ ...base, memberRun: "paused" }} />);
  expect(screen.getByText("Paused")).toHaveClass("bg-warning-light");
  rerender(<GroupRowCard row={{ ...base, memberRun: null }} />);
  expect(container.querySelector("[data-member-run]")).toBeNull();
});

test("no handlers, no buttons (Home's pinned cards)", () => {
  render(<GroupRowCard row={base} />);
  expect(screen.queryByRole("button", { name: /Schedule|Close/ })).toBeNull();
});
