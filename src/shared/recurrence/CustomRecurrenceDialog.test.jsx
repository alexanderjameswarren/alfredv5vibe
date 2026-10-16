import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import CustomRecurrenceDialog from "./CustomRecurrenceDialog";

test("an empty Repeat every box says Required and blocks Done", () => {
  const onDone = jest.fn();
  render(<CustomRecurrenceDialog onDone={onDone} onCancel={() => {}} />);
  fireEvent.change(screen.getByLabelText("Repeat every"), { target: { value: "" } });
  expect(screen.getByText("Required")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Repeat every"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(onDone.mock.calls[0][0]).toMatchObject({ type: "fixed", frequency: "weekly", interval: 2 });
});

test("monthly on a day: the day box behaves the same", () => {
  const onDone = jest.fn();
  render(
    <CustomRecurrenceDialog
      initialConfig={{ type: "fixed", frequency: "monthly", interval: 1, dayOfMonth: 14 }}
      onDone={onDone}
      onCancel={() => {}}
    />,
  );
  const day = screen.getByLabelText("Day of the month");
  fireEvent.change(day, { target: { value: "" } });
  expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
  fireEvent.change(day, { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(onDone.mock.calls[0][0]).toMatchObject({ frequency: "monthly", dayOfMonth: 3 });
});
