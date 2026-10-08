import React from "react";
import { render, screen } from "@testing-library/react";
import StatusEventsSheet from "./StatusEventsSheet";

const event = { id: "e", time: "2026-10-10" };
const noop = () => {};

test("closing offers archive and cancel only — no Keep", () => {
  render(<StatusEventsSheet status="closed" event={event} onArchive={noop} onKeep={noop} onCancel={noop} />);
  expect(screen.getByText(/Scheduled for Saturday, October 10\./)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Close and archive the date" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Keep/ })).toBeNull();
});

test("parking may keep the date", () => {
  render(<StatusEventsSheet status="background" event={event} onArchive={noop} onKeep={noop} onCancel={noop} />);
  expect(screen.getByRole("button", { name: "Archive the date" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Keep the date" })).toBeTruthy();
});
