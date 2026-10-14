import React from "react";
import { render, screen } from "@testing-library/react";
import StatusEventsSheet, { sheetWording } from "./StatusEventsSheet";
import { formatEventDate } from "../utils/eventDates";

const event = { id: "e", time: "2026-10-10" };
// Built with the component's own helper: a fixed weekday turned into "Today" on the day.
const shown = formatEventDate("2026-10-10");
const noop = () => {};

test("closing offers archive and cancel only — no Keep", () => {
  render(<StatusEventsSheet status="closed" event={event} onArchive={noop} onKeep={noop} onCancel={noop} />);
  expect(screen.getByText(`Scheduled for ${shown}. Closing archives that date.`)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Close and archive the date" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Keep/ })).toBeNull();
});

test("parking may keep the date", () => {
  render(<StatusEventsSheet status="background" event={event} onArchive={noop} onKeep={noop} onCancel={noop} />);
  expect(screen.getByRole("button", { name: "Archive the date" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Keep the date" })).toBeTruthy();
});

test("counts an event and reminders together", () => {
  render(<StatusEventsSheet status="background" event={event} reminderCount={2} onArchive={noop} onKeep={noop} onCancel={noop} />);
  expect(screen.getByText(`1 scheduled event (${shown}) and 2 reminders.`)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Archive the date and cancel the reminders" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Keep them" })).toBeTruthy();
});

test("a row closing several events names them all", () => {
  expect(sheetWording("closed", "Oct 20", 1, 2)).toEqual({
    summary: "2 scheduled events (from Oct 20) and 1 reminder. Closing archives the dates and cancels the reminder.",
    archive: "Close, archive the dates and cancel the reminder",
    keep: "Keep them",
  });
});

test("takes a title", () => {
  render(<StatusEventsSheet status="closed" title='Close "Fan"' event={event} onArchive={noop} onCancel={noop} />);
  expect(screen.getByText('Close "Fan"')).toBeTruthy();
});

test("reminders with no event still ask", () => {
  expect(sheetWording("background", "", 1)).toEqual({
    summary: "1 reminder pending.",
    archive: "Cancel the reminder",
    keep: "Keep the reminder",
  });
  expect(sheetWording("closed", "", 2)).toMatchObject({
    summary: "2 reminders pending. Closing cancels them.",
    archive: "Close and cancel the reminders",
  });
});
