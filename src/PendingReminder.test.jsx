import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import PendingReminder from "./PendingReminder";
import { getPendingReminders } from "./utils/remindersApi";

jest.mock("./utils/remindersApi", () => ({
  ...jest.requireActual("./utils/remindersApi"),
  getPendingReminders: jest.fn(),
}));
jest.mock("./supabaseClient", () => ({ supabase: {} }));

it("shows each pending reminder in Pacific time", async () => {
  getPendingReminders.mockResolvedValue([{ id: "r1", due_at: "2026-10-01T16:00:00Z" }]);
  render(<PendingReminder intentId="int1" />);
  expect(await screen.findByText("Reminder: Thu, Oct 1, 9:00 AM PT")).toBeInTheDocument();
  expect(getPendingReminders).toHaveBeenCalledWith({ inboxId: null, intentId: "int1" });
});

it("renders nothing when there is none, or the read fails", async () => {
  getPendingReminders.mockResolvedValue([]);
  const { container } = render(<PendingReminder inboxId="in1" />);
  await Promise.resolve();
  expect(container).toBeEmptyDOMElement();

  jest.spyOn(console, "error").mockImplementation(() => {});
  getPendingReminders.mockRejectedValue(new Error("boom"));
  const second = render(<PendingReminder inboxId="in2" />);
  await Promise.resolve();
  expect(second.container).toBeEmptyDOMElement();
});
