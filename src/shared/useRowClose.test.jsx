import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import useRowClose, { closeTargets, closeBlocked, CloseRowButton, CLOSE_BLOCKED } from "./useRowClose";
import { getReminderSummary } from "../utils/remindersApi";
import { getTodayDate } from "../utils/eventDates";

jest.mock("../utils/remindersApi", () => ({ getReminderSummary: jest.fn() }));

const today = getTodayDate();
const item = { id: "fan", name: "Vent fan", status: "active" };
const open = { id: "a", itemId: "fan", status: "active" };
const done = { id: "b", itemId: "fan", status: "closed" };
const row = { key: "item:fan", name: "Vent fan", item, intents: [open, done], status: "active" };

beforeEach(() => getReminderSummary.mockResolvedValue({ scheduled: [] }));

describe("closeTargets", () => {
  it("closes the item and its intentions not yet closed", () => {
    expect(closeTargets(row)).toEqual({ item, intents: [open] });
  });

  it("skips an item already closed", () => {
    expect(closeTargets({ ...row, item: { ...item, status: "closed" } }).item).toBeNull();
  });
});

describe("closeBlocked", () => {
  it("is blocked by an open run of any intention", () => {
    expect(closeBlocked(row, [{ intentId: "b", status: "paused" }])).toBe(true);
  });

  it("is blocked by a run carrying the item", () => {
    expect(closeBlocked(row, [{ intentId: "other", itemIds: ["fan"], status: "active" }])).toBe(true);
  });

  it("is free otherwise", () => {
    expect(closeBlocked(row, [{ intentId: "other", status: "active" }])).toBe(false);
  });
});

function Harness({ events = [], executions = [], onCloseRecords, theRow = row }) {
  const { closeProps, sheet } = useRowClose({ events, executions, onCloseRecords });
  const props = closeProps(theRow);
  return (
    <>
      {props.onClose && <CloseRowButton {...props} />}
      {sheet}
    </>
  );
}

const confirmIn = (dialog) => within(dialog).getByRole("button", { name: "Close" });

describe("useRowClose", () => {
  it("always asks: a reason first, then it closes with reason, note, Closed on and the picked intention", async () => {
    const onCloseRecords = jest.fn();
    render(<Harness onCloseRecords={onCloseRecords} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText('Close "Vent fan"')).toBeInTheDocument();
    expect(confirmIn(dialog)).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Won't do" }));
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), { target: { value: "not needed" } });
    fireEvent.click(confirmIn(dialog));
    await waitFor(() =>
      expect(onCloseRecords).toHaveBeenCalledWith({
        item, intentIds: ["a"], label: "Vent fan", reason: "wont_do", note: "not needed", closedOn: today, pickedIntentId: "a",
      }),
    );
  });

  it("shows what closing archives when a live event is today or later", async () => {
    render(<Harness onCloseRecords={jest.fn()} events={[{ id: "e", intentId: "a", time: today, archived: false }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(await screen.findByText(/Closing archives that date/)).toBeInTheDocument();
  });

  it("Closed on defaults to a past live date; Completed is preselected once one is done", async () => {
    const past = "2026-01-05";
    const doneBefore = { ...row, intents: [{ ...open, lastCompletedAt: "2026-01-01T12:00:00Z" }, done] };
    render(<Harness onCloseRecords={jest.fn()} theRow={doneBefore} events={[{ id: "e", intentId: "a", time: past, archived: false }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: "Completed" })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getByText(/Closed on: .*January 5/)).toBeInTheDocument();
  });

  it("asks when reminders are pending, and Cancel closes nothing", async () => {
    getReminderSummary.mockResolvedValue({ scheduled: [{ id: "r" }] });
    const onCloseRecords = jest.fn();
    render(<Harness onCloseRecords={onCloseRecords} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onCloseRecords).not.toHaveBeenCalled();
  });

  it("is disabled while a run is open", () => {
    render(<Harness onCloseRecords={jest.fn()} executions={[{ intentId: "a", status: "active" }]} />);
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    // The card prints CLOSE_BLOCKED; no tooltip repeats it.
    expect(screen.getByRole("button", { name: "Close" })).not.toHaveAttribute("title");
    expect(CLOSE_BLOCKED).toBe("Finish the execution first");
  });

  it("offers no Close on a row whose chip reads Closed", () => {
    // The item is closed; its open intention does not bring Close back.
    const closedItem = { ...row, item: { ...item, status: "closed" }, status: "closed" };
    const closedIntention = { key: "intent:b", name: "b", item: null, intents: [done], status: "closed" };
    const { rerender } = render(<Harness onCloseRecords={jest.fn()} theRow={closedItem} />);
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    rerender(<Harness onCloseRecords={jest.fn()} theRow={closedIntention} />);
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("closes just the item when every intention is already closed", async () => {
    const onCloseRecords = jest.fn();
    render(<Harness onCloseRecords={onCloseRecords} theRow={{ ...row, intents: [done] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Completed" }));
    fireEvent.click(confirmIn(dialog));
    await waitFor(() =>
      expect(onCloseRecords).toHaveBeenCalledWith(expect.objectContaining({ item, intentIds: [], reason: "done", pickedIntentId: null })),
    );
  });
});
