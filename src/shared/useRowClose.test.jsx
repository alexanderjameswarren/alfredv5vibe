import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

describe("useRowClose", () => {
  it("closes at once when nothing is pending", async () => {
    const onCloseRecords = jest.fn();
    render(<Harness onCloseRecords={onCloseRecords} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(onCloseRecords).toHaveBeenCalledWith({ item, intentIds: ["a"], label: "Vent fan" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks one question when a live event is today or later", async () => {
    const onCloseRecords = jest.fn();
    render(<Harness onCloseRecords={onCloseRecords} events={[{ id: "e", intentId: "a", time: today, archived: false }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText('Close "Vent fan"')).toBeInTheDocument();
    expect(onCloseRecords).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close and archive the date" }));
    expect(onCloseRecords).toHaveBeenCalledTimes(1);
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
    expect(screen.getByRole("button", { name: "Close" })).toHaveAttribute("title", CLOSE_BLOCKED);
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
    await waitFor(() => expect(onCloseRecords).toHaveBeenCalledWith({ item, intentIds: [], label: "Vent fan" }));
  });
});
