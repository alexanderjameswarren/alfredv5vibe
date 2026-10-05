import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import PendingReminder from "./PendingReminder";
import { getReminderSummary } from "../utils/remindersApi";

jest.mock("../utils/remindersApi", () => ({
  ...jest.requireActual("../utils/remindersApi"),
  getReminderSummary: jest.fn(),
}));
jest.mock("../supabaseClient", () => ({ supabase: {} }));

it("shows each scheduled reminder in Pacific time, ahead of any sent one", async () => {
  getReminderSummary.mockResolvedValue({
    scheduled: [{ id: "r1", due_at: "2026-10-01T16:00:00Z" }],
    lastSent: { id: "r0", sent_at: "2026-09-30T14:36:00Z" },
  });
  render(<PendingReminder intentId="int1" />);
  expect(await screen.findByText("Reminder: Thu, Oct 1, 9:00 AM PT")).toBeInTheDocument();
  expect(screen.queryByText(/Reminder sent/)).not.toBeInTheDocument();
  expect(getReminderSummary).toHaveBeenCalledWith({ inboxId: null, intentId: "int1" });
});

it("with nothing scheduled, shows the last sent one, muted", async () => {
  getReminderSummary.mockResolvedValue({
    scheduled: [],
    lastSent: { id: "r0", due_at: "2026-09-30T14:35:00Z", sent_at: "2026-09-30T14:36:00Z" },
  });
  render(<PendingReminder inboxId="in1" />);
  const line = await screen.findByText("Reminder sent: Wed, Sep 30, 7:36 AM PT");
  expect(line.parentElement).toHaveClass("opacity-70");
});

it("renders nothing when there is neither, or the read fails", async () => {
  getReminderSummary.mockResolvedValue({ scheduled: [], lastSent: null });
  const { container } = render(<PendingReminder inboxId="in1" />);
  await Promise.resolve();
  expect(container).toBeEmptyDOMElement();

  jest.spyOn(console, "error").mockImplementation(() => {});
  getReminderSummary.mockRejectedValue(new Error("boom"));
  const second = render(<PendingReminder inboxId="in2" />);
  await Promise.resolve();
  expect(second.container).toBeEmptyDOMElement();
});
