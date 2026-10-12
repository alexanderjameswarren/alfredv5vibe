import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import PendingReminder, { IntentionReminderLines } from "./PendingReminder";
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
    render(<PendingReminder inboxId="in1" editable />);
    fireEvent.click(await screen.findByRole("button", { name: /Cancel reminder/ }));
    await waitFor(() => expect(cancelReminder).toHaveBeenCalledWith("r1"));
    await waitFor(() => expect(getReminderSummary).toHaveBeenCalledTimes(2));
  });

  it("has no Add on the inbox page", async () => {
    getReminderSummary.mockResolvedValue({ scheduled: [], lastSent: null });
    const { container } = render(<PendingReminder inboxId="in1" editable />);
    await Promise.resolve();
    expect(screen.queryByRole("button", { name: "Add reminder" })).toBeNull();
    expect(container.querySelector("ul")).toBeNull();
  });
});

describe("IntentionReminderLines (P3)", () => {
  beforeEach(() => {
    jest.spyOn(window, "confirm").mockReturnValue(true);
    jest.spyOn(window, "alert").mockImplementation(() => {});
  });

  it("one compact line per reminder with a Cancel link, then Add", () => {
    render(
      <IntentionReminderLines
        intentId="int1"
        text="Call"
        scheduled={[{ id: "r1", due_at: "2026-10-01T16:00:00Z" }]}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText("Reminder · Thu, Oct 1, 9:00 AM PT")).toBeInTheDocument();
    const cancel = screen.getByRole("button", { name: "Cancel reminder: Thu, Oct 1, 9:00 AM PT" });
    expect(cancel).toHaveClass("text-destructive");
    expect(cancel).not.toHaveClass("border-destructive");
    expect(screen.getByRole("button", { name: "Add reminder" })).toBeInTheDocument();
    expect(screen.queryByText("Reminders")).toBeNull();
  });

  it("cancel confirms, cancels and tells the page", async () => {
    cancelReminder.mockResolvedValue([{ id: "r1" }]);
    const onChanged = jest.fn();
    render(
      <IntentionReminderLines intentId="int1" text="Call" scheduled={[{ id: "r1", due_at: "2026-10-01T16:00:00Z" }]} onChanged={onChanged} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Cancel reminder/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(cancelReminder).toHaveBeenCalledWith("r1");
  });

  it("Add opens the Remind me at popover; its Cancel closes it", () => {
    render(<IntentionReminderLines intentId="int1" text="Call" scheduled={[]} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add reminder" }));
    expect(screen.getByRole("dialog", { name: "Remind me at" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Add is disabled when the page's actions are, but lines and Cancel stay", () => {
    render(
      <IntentionReminderLines
        intentId="int1"
        text="Call"
        scheduled={[{ id: "r1", due_at: "2026-10-01T16:00:00Z" }]}
        onChanged={() => {}}
        disabledReason="Closed intentions cannot be scheduled"
      />,
    );
    const add = screen.getByRole("button", { name: "Add reminder" });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute("title", "Closed intentions cannot be scheduled");
    expect(screen.getByRole("button", { name: /Cancel reminder/ })).toBeEnabled();
  });

  it("adds at the next whole hour by default", async () => {
    createIntentionReminder.mockResolvedValue({ id: "r2" });
    const onChanged = jest.fn();
    render(<IntentionReminderLines intentId="int1" text="Call" scheduled={[]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Add reminder" }));
    expect(screen.getByLabelText("Time").value).toMatch(/^\d{2}:00$/);
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    await waitFor(() => expect(createIntentionReminder).toHaveBeenCalled());
    const { intentId, text, dueAt } = createIntentionReminder.mock.calls[0][0];
    expect(intentId).toBe("int1");
    expect(text).toBe("Call");
    expect(new Date(dueAt).getUTCMinutes()).toBe(0);
    expect(onChanged).toHaveBeenCalled();
  });

  it("refuses a time in the past", async () => {
    render(<IntentionReminderLines intentId="int1" text="Call" scheduled={[]} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add reminder" }));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2020-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Pick a time in the future.");
    expect(screen.getByRole("dialog", { name: "Remind me at" })).toBeInTheDocument();
    expect(screen.getByLabelText("Date")).toHaveValue("2020-01-01");
    expect(window.alert).not.toHaveBeenCalled();
    expect(createIntentionReminder).not.toHaveBeenCalled();
  });

  it("clears the past-time error when an input changes", () => {
    render(<IntentionReminderLines intentId="int1" text="Call" scheduled={[]} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add reminder" }));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2020-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "10:00" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
