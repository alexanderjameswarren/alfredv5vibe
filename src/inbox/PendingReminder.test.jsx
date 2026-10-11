import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import PendingReminder from "./PendingReminder";
import { getReminderSummary, cancelReminder, createIntentionReminder } from "../utils/remindersApi";

jest.mock("../utils/remindersApi", () => ({
  ...jest.requireActual("../utils/remindersApi"),
  getReminderSummary: jest.fn(),
  cancelReminder: jest.fn(),
  createIntentionReminder: jest.fn(),
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

describe("editable (Restructure P3)", () => {
  const PENDING = { scheduled: [{ id: "r1", due_at: "2026-10-01T16:00:00Z" }], lastSent: null };

  beforeEach(() => {
    jest.spyOn(window, "confirm").mockReturnValue(true);
    jest.spyOn(window, "alert").mockImplementation(() => {});
  });

  it("lists pending reminders with Cancel", async () => {
    getReminderSummary.mockResolvedValue(PENDING);
    render(<PendingReminder inboxId="in1" editable />);
    expect(await screen.findByText("Thu, Oct 1, 9:00 AM PT")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel reminder: Thu, Oct 1, 9:00 AM PT" })).toHaveClass("border-destructive");
  });

  it("cancels and reloads", async () => {
    getReminderSummary.mockResolvedValue(PENDING);
    cancelReminder.mockResolvedValue([{ id: "r1" }]);
    render(<PendingReminder intentId="int1" editable addText="Call" />);
    fireEvent.click(await screen.findByRole("button", { name: /Cancel reminder/ }));
    await waitFor(() => expect(cancelReminder).toHaveBeenCalledWith("r1"));
    await waitFor(() => expect(getReminderSummary).toHaveBeenCalledTimes(2));
  });

  it("shows only Add when there are none", async () => {
    getReminderSummary.mockResolvedValue({ scheduled: [], lastSent: { id: "r0", sent_at: "2026-09-30T14:36:00Z" } });
    render(<PendingReminder intentId="int1" editable addText="Call" />);
    expect(await screen.findByRole("button", { name: "Add reminder" })).toBeInTheDocument();
    expect(screen.queryByText("Reminders")).toBeNull();
    expect(screen.queryByText(/Reminder sent/)).toBeNull();
  });

  it("has no Add on the inbox page", async () => {
    getReminderSummary.mockResolvedValue({ scheduled: [], lastSent: null });
    const { container } = render(<PendingReminder inboxId="in1" editable />);
    await Promise.resolve();
    expect(screen.queryByRole("button", { name: "Add reminder" })).toBeNull();
    expect(container.querySelector("ul")).toBeNull();
  });

  it("adds at the next whole hour by default", async () => {
    getReminderSummary.mockResolvedValue({ scheduled: [], lastSent: null });
    createIntentionReminder.mockResolvedValue({ id: "r2" });
    render(<PendingReminder intentId="int1" editable addText="Call" />);
    fireEvent.click(await screen.findByRole("button", { name: "Add reminder" }));
    expect(screen.getByLabelText("Time").value).toMatch(/^\d{2}:00$/);
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    await waitFor(() => expect(createIntentionReminder).toHaveBeenCalled());
    const { intentId, text, dueAt } = createIntentionReminder.mock.calls[0][0];
    expect(intentId).toBe("int1");
    expect(text).toBe("Call");
    expect(new Date(dueAt).getUTCMinutes()).toBe(0);
  });

  it("refuses a time in the past", async () => {
    getReminderSummary.mockResolvedValue({ scheduled: [], lastSent: null });
    render(<PendingReminder intentId="int1" editable addText="Call" />);
    fireEvent.click(await screen.findByRole("button", { name: "Add reminder" }));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2020-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    expect(window.alert).toHaveBeenCalledWith("Pick a time in the future.");
    expect(createIntentionReminder).not.toHaveBeenCalled();
  });
});
