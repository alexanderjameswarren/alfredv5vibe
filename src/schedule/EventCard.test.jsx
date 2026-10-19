import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import EventCard from "./EventCard";

jest.mock("../supabaseClient", () => ({ supabase: {} }));

function renderEvent(intentStatus) {
  render(
    <EventCard
      event={{ id: "e1", intentId: "i1", time: "2026-10-10" }}
      intent={{ id: "i1", text: "Water plants", status: intentStatus }}
      contexts={[]}
      onActivate={jest.fn()}
      onUpdate={jest.fn()}
      getIntentDisplay={(i) => i.text}
    />,
  );
}

test("Start is disabled with the reason on a closed intention's event", () => {
  renderEvent("closed");
  const start = screen.getByRole("button", { name: "Start" });
  expect(start.disabled).toBe(true);
  expect(start.title).toBe("This intention is closed. Set it to Active to use it.");
  expect(screen.getByText("This intention is closed. Set it to Active to use it.")).toBeTruthy();
});

test("edit form: the date is locked while its run is active, not when paused", () => {
  for (const [status, locked] of [["active", true], ["paused", false]]) {
    const { unmount, container } = render(
      <EventCard
        event={{ id: "e1", intentId: "i1", time: "2026-10-10" }}
        intent={{ id: "i1", text: "Water plants", status: "active" }}
        contexts={[]}
        executions={[{ id: "x", eventId: "e1", status }]}
        onActivate={jest.fn()}
        onUpdate={jest.fn()}
        getIntentDisplay={(i) => i.text}
      />,
    );
    fireEvent.click(screen.getByText("Water plants"));
    expect(container.querySelector('input[type="date"]').disabled).toBe(locked);
    unmount();
  }
});

test("edit form: a repeating date offers Skip, hidden while an execution is open; a one-time date keeps Archive Event", () => {
  const daily = { type: "fixed", frequency: "daily", interval: 1 };
  for (const [config, executions, skip, archive] of [
    [daily, [], true, false],
    [daily, [{ id: "x", eventId: "e1", intentId: "i1", status: "paused" }], false, false],
    [{ type: "once" }, [], false, true],
  ]) {
    const { unmount } = render(
      <EventCard
        event={{ id: "e1", intentId: "i1", time: "2026-10-10" }}
        intent={{ id: "i1", text: "Water plants", status: "active", recurrenceConfig: config }}
        contexts={[]}
        executions={executions}
        onActivate={jest.fn()}
        onUpdate={jest.fn()}
        getIntentDisplay={(i) => i.text}
      />,
    );
    fireEvent.click(screen.getByText("Water plants"));
    expect(Boolean(screen.queryByRole("button", { name: "Skip" }))).toBe(skip);
    expect(Boolean(screen.queryByRole("button", { name: "Archive Event" }))).toBe(archive);
    unmount();
  }
});

test("edit form: a date moved into the past is refused; an overdue date left alone still saves", () => {
  const onUpdate = jest.fn();
  const { container } = render(
    <EventCard
      event={{ id: "e1", intentId: "i1", time: "2020-01-10" }}
      intent={{ id: "i1", text: "Water plants", status: "active" }}
      contexts={[]}
      onActivate={jest.fn()}
      onUpdate={onUpdate}
      getIntentDisplay={(i) => i.text}
    />,
  );
  fireEvent.click(screen.getByText("Water plants"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onUpdate).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText("Water plants"));
  fireEvent.change(container.querySelector('input[type="date"]'), { target: { value: "2020-01-05" } });
  expect(screen.getByText("Pick today or a later date.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save" }).disabled).toBe(true);
});

test("edit form: teal Start Now leftmost; blocked by an open run", () => {
  for (const [executions, blocked] of [[[], false], [[{ id: "x", intentId: "i1", eventId: "other", status: "paused" }], true]]) {
    const onActivate = jest.fn();
    const { unmount } = render(
      <EventCard
        event={{ id: "e1", intentId: "i1", time: "2026-10-10" }}
        intent={{ id: "i1", text: "Water plants", status: "active" }}
        contexts={[]}
        executions={executions}
        onActivate={onActivate}
        onUpdate={jest.fn()}
        getIntentDisplay={(i) => i.text}
      />,
    );
    fireEvent.click(screen.getByText("Water plants"));
    const start = screen.getByRole("button", { name: "Start Now" });
    expect(screen.getAllByRole("button")[0]).toBe(start);
    expect(start.className).toMatch(/bg-success/);
    expect(start.disabled).toBe(blocked);
    if (!blocked) {
      fireEvent.click(start);
      expect(onActivate).toHaveBeenCalledWith("e1");
    }
    unmount();
  }
});

test("row Start and Continue are teal", () => {
  const { unmount } = render(
    <EventCard
      event={{ id: "e1", intentId: "i1", time: "2026-10-10" }}
      intent={{ id: "i1", text: "Water plants", status: "active" }}
      contexts={[]}
      executions={[{ id: "x", intentId: "i1", eventId: "e1", status: "paused" }]}
      onActivate={jest.fn()}
      onUpdate={jest.fn()}
      getIntentDisplay={(i) => i.text}
    />,
  );
  expect(screen.getByRole("button", { name: "Continue" }).className).toMatch(/bg-success/);
  unmount();
  renderEvent("active");
  expect(screen.getByRole("button", { name: "Start" }).className).toMatch(/bg-success/);
});

test("Start is live otherwise", () => {
  renderEvent("active");
  expect(screen.getByRole("button", { name: "Start" }).disabled).toBe(false);
});
