import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import CompletedOnDialog from "./CompletedOnDialog";

const today = "2026-10-17";

test("any past day saves; the picker's only bound is today", async () => {
  const onSave = jest.fn().mockResolvedValue(true);
  render(<CompletedOnDialog initialDate="2026-10-09" today={today} onSave={onSave} onCancel={() => {}} />);
  const input = screen.getByLabelText("Completed on");
  expect(input).not.toHaveAttribute("min");
  expect(input).toHaveAttribute("max", today);
  fireEvent.change(input, { target: { value: "2026-09-01" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith("2026-09-01"));
});

test("a future day is refused, with the reason", () => {
  const onSave = jest.fn();
  render(<CompletedOnDialog initialDate="2026-10-09" today={today} onSave={onSave} onCancel={() => {}} />);
  fireEvent.change(screen.getByLabelText("Completed on"), { target: { value: "2026-10-20" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent("It cannot be completed in the future.");
  expect(onSave).not.toHaveBeenCalled();
});

test("Cancel saves nothing", () => {
  const onSave = jest.fn();
  const onCancel = jest.fn();
  render(<CompletedOnDialog initialDate="2026-10-09" today={today} onSave={onSave} onCancel={onCancel} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalled();
  expect(onSave).not.toHaveBeenCalled();
});
