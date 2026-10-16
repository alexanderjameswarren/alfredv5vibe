import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import IntervalRecurrenceDialog from "./IntervalRecurrenceDialog";

test("typing 3 into a cleared box gives 3, not 31", () => {
  const onDone = jest.fn();
  render(<IntervalRecurrenceDialog onDone={onDone} onCancel={() => {}} />);
  const box = screen.getByLabelText("How many");
  fireEvent.change(box, { target: { value: "" } });
  expect(screen.getByText("Required")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
  fireEvent.change(box, { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(onDone).toHaveBeenCalledWith({ type: "interval", every: 3, unit: "days" }, null);
});

test("reads as one phrase: after last completion", () => {
  render(<IntervalRecurrenceDialog onDone={() => {}} onCancel={() => {}} />);
  expect(screen.getByText("after last completion")).toBeInTheDocument();
  expect(screen.queryByText("after done")).toBeNull();
});
