import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import SchedulePopover from "./SchedulePopover";

function openAt(left, viewport = 390) {
  window.innerWidth = viewport;
  render(<SchedulePopover label="Schedule" initialDate="2026-10-07" onPick={() => {}} />);
  const button = screen.getByRole("button", { name: "Schedule" });
  button.parentElement.getBoundingClientRect = () => ({ left, right: left + 100 });
  fireEvent.click(button);
  return screen.getByDisplayValue("2026-10-07").closest("[data-align]").dataset.align;
}

test("a button on the left of a phone opens rightward", () => {
  expect(openAt(16)).toBe("left");
});

test("a button near the right edge opens leftward", () => {
  expect(openAt(280)).toBe("right");
});

test("date-only by default", () => {
  const onPick = jest.fn();
  render(<SchedulePopover label="Schedule" initialDate="2026-10-07" onPick={onPick} />);
  fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
  expect(screen.getByText("Schedule for")).toBeTruthy();
  expect(screen.queryByLabelText("Time")).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Schedule" })[1]);
  expect(onPick).toHaveBeenCalledWith("2026-10-07");
});

test("validate: an error shows inside, the popover stays open, and editing clears it", () => {
  const onPick = jest.fn();
  render(
    <SchedulePopover label="Schedule" initialDate="2026-10-07" onPick={onPick} validate={(d) => (d < "2026-10-08" ? "Too early" : null)} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Schedule" })[1]);
  expect(screen.getByRole("alert").textContent).toBe("Too early");
  expect(screen.getByDisplayValue("2026-10-07")).toBeTruthy();
  expect(onPick).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-10-09" } });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Schedule" })[1]);
  expect(onPick).toHaveBeenCalledWith("2026-10-09");
});

test("time mode: its own label, a time input, onPick(date, time)", () => {
  const onPick = jest.fn();
  render(
    <SchedulePopover
      label="Add reminder"
      fieldLabel="Remind me at"
      confirmLabel="Set reminder"
      initialDate="2026-10-07"
      initialTime="14:00"
      onPick={onPick}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add reminder" }));
  expect(screen.getByText("Remind me at")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Time"), { target: { value: "09:30" } });
  fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
  expect(onPick).toHaveBeenCalledWith("2026-10-07", "09:30");
});
