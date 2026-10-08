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
