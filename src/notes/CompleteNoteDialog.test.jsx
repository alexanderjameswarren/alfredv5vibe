import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import CompleteNoteDialog from "./CompleteNoteDialog";

// 2026-10-16 is a Friday, 10-13 a Tuesday, 10-17 a Saturday, 10-18 a Sunday.
const today = "2026-10-16";
const completion = { today };
const next = { defaultDate: "2026-10-17", kind: "Every day", today, endDate: null };
const interval = {
  defaultDate: "2026-10-19",
  kind: "3 days after last completion",
  today,
  endDate: null,
  // completedOn + 3 days, never before today
  recompute: (on) => {
    const [y, m, d] = on.split("-").map(Number);
    const t = new Date(y, m - 1, d + 3);
    const s = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    return s < today ? today : s;
  },
};

const renderDialog = (props) =>
  render(<CompleteNoteDialog onComplete={jest.fn().mockResolvedValue(true)} onCancel={() => {}} {...props} />);

test("a one-off shows Completed on (today) and no Next", () => {
  renderDialog({ completion });
  expect(screen.getByText("Completed on: Friday, October 16")).toBeInTheDocument();
  expect(screen.queryByText(/^Next:/)).toBeNull();
});

test("Completed on: any past day, never ahead", () => {
  renderDialog({ completion });
  fireEvent.click(screen.getByRole("button", { name: "Change completed on" }));
  fireEvent.change(screen.getByLabelText("Completed on"), { target: { value: "2026-10-20" } });
  expect(screen.getByRole("alert")).toHaveTextContent("It cannot be completed in the future.");
  fireEvent.change(screen.getByLabelText("Completed on"), { target: { value: "2026-10-07" } });
  expect(screen.getByText("Completed on: Wednesday, October 7")).toBeInTheDocument();
});

test("the Completed on picker leaves every day up to today open: no lower bound, today as the upper", () => {
  renderDialog({ completion, next });
  fireEvent.click(screen.getByRole("button", { name: "Change completed on" }));
  const input = screen.getByLabelText("Completed on");
  expect(input).not.toHaveAttribute("min");
  expect(input).toHaveAttribute("max", today);
  expect(input).toHaveValue(today);
  // A week ago and today are inside the bounds the browser enforces.
  for (const day of ["2026-10-09", today]) expect(day <= input.getAttribute("max")).toBe(true);
});

test("while picking, the date shows once under one label", () => {
  renderDialog({ completion, next });
  fireEvent.click(screen.getByRole("button", { name: "Change completed on" }));
  expect(screen.queryByText(/^Completed on:/)).toBeNull();
  expect(screen.getAllByText("Completed on")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Change next" }));
  expect(screen.queryByText(/^Next:/)).toBeNull();
  expect(screen.getAllByText("Next")).toHaveLength(1);
});

test("completes with the note, the next date and the completion date", async () => {
  const onComplete = jest.fn().mockResolvedValue(true);
  renderDialog({ completion, next, onComplete });
  expect(screen.getByText("Next: Saturday, October 17")).toBeInTheDocument();
  expect(screen.getByText("Every day")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  await waitFor(() => expect(onComplete).toHaveBeenCalledWith("", "2026-10-17", today));
});

test("after completion: an earlier Completed on moves Next, clamped to today", () => {
  renderDialog({ completion, next: interval });
  expect(screen.getByText("Next: Monday, October 19")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Change completed on" }));
  fireEvent.change(screen.getByLabelText("Completed on"), { target: { value: "2026-10-14" } });
  expect(screen.getByText("Next: Saturday, October 17")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Change completed on" }));
  fireEvent.change(screen.getByLabelText("Completed on"), { target: { value: "2026-10-13" } });
  expect(screen.getByText("Next: Friday, October 16")).toBeInTheDocument();
});

test("a Next chosen by hand stays when Completed on changes", () => {
  renderDialog({ completion, next: interval });
  fireEvent.click(screen.getByRole("button", { name: "Change next" }));
  fireEvent.change(screen.getByLabelText("Next"), { target: { value: "2026-10-25" } });
  fireEvent.click(screen.getByRole("button", { name: "Change completed on" }));
  fireEvent.change(screen.getByLabelText("Completed on"), { target: { value: "2026-10-14" } });
  expect(screen.getByText("Next: Sunday, October 25")).toBeInTheDocument();
});

test("a changed Next is the one saved", async () => {
  const onComplete = jest.fn().mockResolvedValue(true);
  renderDialog({ completion, next, onComplete });
  fireEvent.click(screen.getByRole("button", { name: "Change next" }));
  fireEvent.change(screen.getByLabelText("Next"), { target: { value: "2026-10-18" } });
  expect(screen.getByText("Next: Sunday, October 18")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  await waitFor(() => expect(onComplete).toHaveBeenCalledWith("", "2026-10-18", today));
});

test("a Next before today is refused, with the reason, and the date is kept", async () => {
  const onComplete = jest.fn().mockResolvedValue(true);
  renderDialog({ completion, next, onComplete });
  fireEvent.click(screen.getByRole("button", { name: "Change next" }));
  fireEvent.change(screen.getByLabelText("Next"), { target: { value: "2026-10-10" } });
  expect(screen.getByRole("alert")).toHaveTextContent("Pick today or a later date.");
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  await waitFor(() => expect(onComplete).toHaveBeenCalledWith("", "2026-10-17", today));
});

test("a Next past the end of the repeat is refused", () => {
  renderDialog({ completion, next: { ...next, endDate: "2026-10-20" } });
  fireEvent.click(screen.getByRole("button", { name: "Change next" }));
  fireEvent.change(screen.getByLabelText("Next"), { target: { value: "2026-10-25" } });
  expect(screen.getByRole("alert")).toHaveTextContent("The repeat ends on Tuesday, October 20.");
});

test("an ended repeat says so and completes with no next date", async () => {
  const onComplete = jest.fn().mockResolvedValue(true);
  renderDialog({ completion, next: { ...next, defaultDate: null }, onComplete });
  expect(screen.getByText("Repeat has ended")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  await waitFor(() => expect(onComplete).toHaveBeenCalledWith("", null, today));
});

test("Cancel completes nothing", () => {
  const onComplete = jest.fn();
  const onCancel = jest.fn();
  render(<CompleteNoteDialog onComplete={onComplete} onCancel={onCancel} next={next} completion={completion} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalled();
  expect(onComplete).not.toHaveBeenCalled();
});
