import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import StatusFilterChips from "./StatusFilterChips";

const counts = { someday: 3, active: 5, background: 12, closed: 0 };

test("every chip shows its count, on or off", () => {
  render(<StatusFilterChips counts={counts} selected={["someday", "active"]} onToggle={() => {}} />);
  const pressed = (name) => screen.getByRole("button", { name }).getAttribute("aria-pressed");
  expect(pressed("Background (12)")).toBe("false");
  expect(pressed("Closed (0)")).toBe("false");
  expect(pressed("Active (5)")).toBe("true");
});

test("tapping a chip reports its status", () => {
  const onToggle = jest.fn();
  render(<StatusFilterChips counts={counts} selected={[]} onToggle={onToggle} />);
  fireEvent.click(screen.getByRole("button", { name: "Someday (3)" }));
  expect(onToggle).toHaveBeenCalledWith("someday");
});
