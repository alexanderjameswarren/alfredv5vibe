import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import useStopRepeat, { canStop } from "./useStopRepeat";
import { getReminderSummary } from "../utils/remindersApi";
import { getTodayDate } from "../utils/eventDates";

jest.mock("../utils/remindersApi", () => ({ getReminderSummary: jest.fn() }));

const today = getTodayDate();
const rec = { id: "rec", recurrenceConfig: { type: "fixed", frequency: "daily", interval: 1 } };

function Harness({ events = [], onStopRepeat }) {
  const { request, sheet } = useStopRepeat({ events, onStopRepeat });
  return (
    <>
      <button onClick={() => request(rec)}>Stop</button>
      {sheet}
    </>
  );
}

beforeEach(() => getReminderSummary.mockResolvedValue({ scheduled: [] }));

test("canStop: a repeat with no end or a future end; not once, not ended", () => {
  expect(canStop(rec, "2026-10-19")).toBe(true);
  expect(canStop({ ...rec, endDate: "2026-10-20" }, "2026-10-19")).toBe(true);
  expect(canStop({ ...rec, endDate: "2026-10-19" }, "2026-10-19")).toBe(false);
  expect(canStop({ id: "o", recurrenceConfig: { type: "once" } }, "2026-10-19")).toBe(false);
});

test("nothing pending: stops at once, no question", async () => {
  const onStopRepeat = jest.fn();
  render(<Harness onStopRepeat={onStopRepeat} />);
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(onStopRepeat).toHaveBeenCalledWith("rec", { archiveEvents: false }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a live date ahead: one question; archive or keep", async () => {
  const onStopRepeat = jest.fn();
  render(<Harness onStopRepeat={onStopRepeat} events={[{ id: "e", intentId: "rec", time: today, archived: false }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(await screen.findByText("Stop repeating")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Archive this event" }));
  await waitFor(() => expect(onStopRepeat).toHaveBeenCalledWith("rec", { archiveEvents: true }));
});

test("a past-due live event asks too", async () => {
  render(<Harness onStopRepeat={jest.fn()} events={[{ id: "e", intentId: "rec", time: "2000-01-01", archived: false }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(await screen.findByRole("button", { name: "Keep this event" })).toBeInTheDocument();
});

test("pending reminders ask too; Cancel stops nothing", async () => {
  getReminderSummary.mockResolvedValue({ scheduled: [{ id: "r" }] });
  const onStopRepeat = jest.fn();
  render(<Harness onStopRepeat={onStopRepeat} />);
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await screen.findByText("Stop repeating");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onStopRepeat).not.toHaveBeenCalled();
});
