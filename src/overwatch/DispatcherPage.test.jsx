import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import DispatcherPage from "./DispatcherPage";
import * as api from "./overwatchApi";

jest.mock("./overwatchApi", () => ({ ...jest.requireActual("./overwatchApi"), getDispatcher: jest.fn(),
  getDispatcherHistory: jest.fn(), actOnSignal: jest.fn() }));

// Invented data only.
const S1 = "2e0f6bc8-e59a-4b75-94e1-cb3d9f5cf217";
const S2 = "ea5b14e5-f844-4ee6-aa82-582db920b974";
const S3 = "1a3a749e-ee5b-41be-a8e2-a3fb0835463a";
const S4 = "91028d22-1b10-471d-bf00-faec48574022";
const INBOX = "306d5c06-32f6-482e-8af4-f664c61de588";
const S5 = "a4b5c6d7-4444-4d5e-8f60-3b4c5d6e7f80";
const N1 = "6b9c1d7e-1111-4a2b-9c3d-0e1f2a3b4c5d";
const N2 = "b5c6d7e8-5555-4e6f-9071-4c5d6e7f8091";
const R1 = "7c0d2e8f-2222-4b3c-8d4e-1f2a3b4c5d6e";
const T1 = "8d1e3f90-3333-4c4d-9e5f-2a3b4c5d6e7f";
const DELIVERY = {
  window: { start: "05:00", end: "20:00" },
  pace: { max_pops_per_hour: 3 },
  defaults: { low: "hold", normal: "inbox", high: "pop", urgent: "pop" },
  overrides: [
    { label: "DJ is too chatty", match: { app: "dj" }, effect: { decision: "inbox" } },
    { label: "Old mute", match: { app: "ken" }, effect: { decision: "hold" }, when: { ends_at: "2026-11-01T17:00:00Z" } },
  ],
};
const NO_HISTORY = { notifications: [], signals: [], next: null };
const EMPTY = { signals: [], history: NO_HISTORY, reminders: [], steps: [], executionNames: {}, delivery: null, appNames: {} };

const renderPage = () => render(<MemoryRouter><DispatcherPage /></MemoryRouter>);

test("empty: no rules, four sections in order, no buttons that act, its own icon", async () => {
  api.getDispatcher.mockResolvedValue(EMPTY);
  const { container } = renderPage();
  expect(await screen.findByRole("heading", { level: 2 })).toHaveTextContent("Dispatcher");
  expect(container.querySelector("h2 svg.lucide-radio")).not.toBeNull();
  expect(container.querySelector("h2 svg.lucide-bell-ring")).toBeNull();
  expect(container.firstChild.className).toContain("isolate");
  expect(screen.getByText("The active Overwatch plan has no delivery rules.")).toBeInTheDocument();
  const titles = screen.getAllByRole("button").map((b) => b.textContent);
  expect(titles[0]).toBe("Queued (0)");
  expect(titles[1]).toMatch(/^Unprocessed – next run (tomorrow )?\d{1,2}:00 [AP]M \(0\)$/);
  expect(titles.slice(2)).toEqual(["Held (0)", "History (0 shown)"]);
  expect(screen.getByText("Nothing is scheduled to be sent.")).toBeInTheDocument();
  expect(screen.getByText("Nothing is waiting for the dispatcher.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "History (0 shown)" }));
  expect(screen.getByText("Nothing sent yet.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
  expect(screen.getAllByRole("button").every((b) => b.hasAttribute("aria-expanded"))).toBe(true);
  expect(screen.queryByText(/pop/i)).not.toBeInTheDocument();
});

test("populated: queued, unprocessed, held and history read in plain words", async () => {
  api.getDispatcher.mockResolvedValue({
    signals: [
      { id: S3, title: "Held one", app: "dj", severity: "low", state: "held", reason: "low signals are held",
        created_at: "2026-11-05T15:00:00Z", decided_at: "2026-11-05T15:00:05Z" },
      { id: S4, title: "Waiting one", app: "ken", severity: "high", state: "queued", created_at: "2026-11-05T16:30:00Z" },
    ],
    history: {
      notifications: [
        { id: N2, title: "High one", app: "ken", channel: "alfred_push", delivery_status: "sent",
          started_by: "task:claude-hourly-notifications", signal_id: S5, link: null, created_at: "2026-11-05T17:00:05Z" },
        { id: N1, title: "Sleep check-in done", app: "arnold", channel: "inbox_item", delivery_status: "sent",
          started_by: "task:claude-hourly-notifications", signal_id: S1, link: `/${INBOX}`, created_at: "2026-11-05T16:10:34Z" },
      ],
      signals: [
        { id: S2, title: "Sleep check-in logged", app: "arnold", severity: "normal", state: "merged", merged_into: S3,
          inbox_id: INBOX, created_at: "2026-11-05T15:12:26Z", decided_at: "2026-11-05T15:12:35Z" },
        { id: S1, reason: "normal signals default to inbox" },
        { id: S5, reason: "high signals default to pop" },
      ],
      next: null,
    },
    reminders: [{ id: R1, text: "Call the bank", due_at: "2026-11-06T17:00:00Z", state: "scheduled" }],
    steps: [{ id: T1, text: "Slot 2 — Heel-elevated air squats", state: "scheduled", due_at: "2026-11-05T18:00:00Z",
      execution_id: "ex1" }],
    executionNames: { ex1: "Micro Workout Rotation" },
    delivery: DELIVERY,
    appNames: { arnold: "Arnold", dj: "DJ", ken: "Ken" },
  });
  renderPage();
  expect(await screen.findByText("Notifications from 5:00 AM to 8:00 PM Pacific.")).toBeInTheDocument();
  expect(screen.getByText("At most 3 notifications an hour, no daily limit, no minimum gap.")).toBeInTheDocument();
  expect(screen.getByText("By default Low: hold · Normal: inbox · High: notify · Urgent: notify.")).toBeInTheDocument();
  const rules = screen.getByRole("region", { name: "Delivery rules" });
  expect(within(rules).getByText("Exceptions")).toBeInTheDocument();
  expect(within(rules).getByText("DJ: inbox instead of a notification")).toBeInTheDocument();
  expect(within(rules).getByText("In force · DJ is too chatty")).toBeInTheDocument();
  expect(within(rules).getByText("Ken: held. Ended Nov 1, 9:00 AM")).toBeInTheDocument();
  expect(within(rules).getByText("Ended · Old mute")).toBeInTheDocument();

  const icon = (card) => card.querySelector("svg").getAttribute("class");
  const queued = screen.getByRole("region", { name: "Queued (2)" });
  expect(within(queued).getByRole("link", { name: "Micro Workout Rotation" })).toHaveAttribute("href", "/schedule/execution/ex1");
  expect(within(queued).getByText("Sends Thu, Nov 5, 10:00 AM")).toBeInTheDocument();
  expect(within(queued).getByText("Slot 2 — Heel-elevated air squats")).toBeInTheDocument();
  expect(within(queued).getByRole("link", { name: "Call the bank" })).toHaveAttribute("href", `/${R1}`);
  within(queued).getAllByRole("article").forEach((c) => expect(icon(c)).toContain("lucide-bell-ring"));

  const waiting = screen.getByRole("region", { name: /^Unprocessed – next run/ });
  expect(within(waiting).getByRole("link", { name: "Waiting one" })).toHaveAttribute("href", `/${S4}`);
  expect(icon(within(waiting).getByRole("article"))).toContain("lucide-hourglass");

  const held = screen.getByRole("region", { name: "Held (1)" });
  expect(within(held).getByText("Held")).toBeInTheDocument();
  expect(within(held).getByText("Dispatcher: low signals are held")).toBeInTheDocument();
  expect(icon(within(held).getByRole("article"))).toContain("lucide-ban");

  fireEvent.click(screen.getByRole("button", { name: "History (3 shown)" }));
  const history = screen.getByRole("region", { name: "History (3 shown)" });
  expect(within(history).queryByRole("button", { name: "Show older" })).toBeNull();
  const cards = within(history).getAllByRole("article");
  expect(within(cards[0]).getByRole("link", { name: "High one" })).toHaveAttribute("href", `/${N2}`);
  expect(within(cards[0]).getByText("Dispatcher: high signals default to notification")).toBeInTheDocument();
  expect(icon(cards[0])).toContain("lucide-bell-ring");
  expect(within(cards[1]).getByRole("link", { name: "Sleep check-in done" })).toHaveAttribute("href", `/${INBOX}`);
  expect(within(cards[1]).getByText("Sent Thu, Nov 5, 8:10 AM")).toBeInTheDocument();
  expect(within(cards[1]).getByText("Started by Claude hourly notifications")).toBeInTheDocument();
  expect(within(cards[1]).getByText("Dispatcher: normal signals default to inbox")).toBeInTheDocument();
  expect(icon(cards[1])).toContain("lucide-inbox");
  expect(within(cards[2]).getByText("Not sent Thu, Nov 5, 7:12 AM")).toBeInTheDocument();
  expect(within(cards[2]).queryByText("Thu, Nov 5, 7:12 AM")).toBeNull();
  expect(within(cards[2]).getByText("Dispatcher: an item already exists in the Inbox")).toBeInTheDocument();
  expect(within(cards[2]).getByRole("link", { name: "Sleep check-in logged" })).toHaveAttribute("href", `/${INBOX}`);
  expect(icon(cards[2])).toContain("lucide-ban");

  expect(screen.queryByText(/^Open /)).not.toBeInTheDocument();
  cards.forEach((c) => expect(within(c).queryByText(/^Dispatcher:?$/)).toBeNull());
  expect(document.querySelector("[class*='border-l-']")).toBeNull();
  expect(screen.queryByText(/\bpop/i)).not.toBeInTheDocument();
});

const sent = (i) => ({ id: `n-${String(i).padStart(3, "0")}`, title: `Sent ${i}`, app: "x", channel: "alfred_push",
  delivery_status: "sent", created_at: new Date(Date.UTC(2026, 10, 5, 12, 0, 0) - i * 60000).toISOString() });

test("Show older appends the next page past the oldest card, then disappears on the last page", async () => {
  const first = Array.from({ length: 50 }, (_, i) => sent(i));
  const cursor = { at: first[49].created_at, id: first[49].id };
  api.getDispatcher.mockResolvedValue({ ...EMPTY, history: { notifications: first, signals: [], next: cursor } });
  api.getDispatcherHistory.mockResolvedValue({ notifications: [first[49], sent(50), sent(51)], signals: [], next: null });
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "History (50 shown)" }));
  fireEvent.click(screen.getByRole("button", { name: "Show older" }));
  expect(api.getDispatcherHistory).toHaveBeenCalledWith(cursor);
  const history = await screen.findByRole("region", { name: "History (52 shown)" });
  const titles = within(history).getAllByRole("article").map((a) => within(a).getByRole("link").textContent);
  expect(titles.slice(48)).toEqual(["Sent 48", "Sent 49", "Sent 50", "Sent 51"]);
  expect(within(history).queryByRole("button", { name: "Show older" })).toBeNull();
});

const ACTIONS = {
  ...EMPTY,
  signals: [
    { id: S4, title: "Waiting one", app: "ken", severity: "high", state: "queued", created_at: "2026-11-05T16:30:00Z" },
    { id: S3, title: "Held one", app: "dj", severity: "low", state: "held", reason: "low signals are held",
      created_at: "2026-11-05T15:00:00Z", decided_at: "2026-11-05T15:00:05Z" },
  ],
  reminders: [{ id: R1, text: "Call the bank", due_at: "2026-11-06T17:00:00Z", state: "scheduled" }],
};

test("⋯ is on Unprocessed and Held cards only, above the link, and opens the actions", async () => {
  api.getDispatcher.mockResolvedValue(ACTIONS);
  renderPage();
  const waiting = await screen.findByRole("region", { name: /^Unprocessed – next run/ });
  const queued = screen.getByRole("region", { name: "Queued (1)" });
  expect(within(queued).queryByRole("button", { name: /^Actions for/ })).toBeNull();
  const more = within(waiting).getByRole("button", { name: "Actions for Waiting one" });
  expect(more.className).toContain("z-10");
  expect(more.querySelector("svg").getAttribute("class")).toContain("lucide-ellipsis");
  expect(within(screen.getByRole("region", { name: "Held (1)" })).getByRole("button", { name: "Actions for Held one" }))
    .toBeInTheDocument();
  fireEvent.click(more);
  const dialog = screen.getByRole("dialog", { name: "Actions for Waiting one" });
  expect(within(dialog).getByRole("button", { name: "Hold" })).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.actOnSignal).not.toHaveBeenCalled();
});

test("hold moves the card to Held; send now moves it to History, by you, with no reload", async () => {
  api.getDispatcher.mockResolvedValue(ACTIONS);
  api.actOnSignal.mockResolvedValueOnce({ state: "held" })
    .mockResolvedValueOnce({ state: "delivered", as: "notification", inbox_id: INBOX });
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Actions for Waiting one" }));
  fireEvent.click(screen.getByRole("button", { name: "Hold" }));
  const held = await screen.findByRole("region", { name: "Held (2)" });
  expect(within(held).getByRole("link", { name: "Waiting one" })).toBeInTheDocument();
  expect(within(held).getByText(/^Held by you · /)).toBeInTheDocument();
  expect(within(held).queryByText("Dispatcher: held by Alex")).toBeNull();
  expect(within(held).getByText("Dispatcher: low signals are held")).toBeInTheDocument();
  expect(api.actOnSignal).toHaveBeenCalledWith(S4, "hold", null);

  fireEvent.click(within(held).getByRole("button", { name: "Actions for Waiting one" }));
  expect(screen.queryByRole("button", { name: "Hold" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Send now as a notification" }));
  expect(await screen.findByRole("region", { name: "Held (1)" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "History (1 shown)" }));
  const history = screen.getByRole("region", { name: "History (1 shown)" });
  expect(within(history).getByRole("link", { name: "Waiting one" })).toHaveAttribute("href", `/${INBOX}`);
  expect(within(history).getByText(/^Sent .* · by you$/)).toBeInTheDocument();
  expect(api.getDispatcher).toHaveBeenCalledTimes(1);
});

test("an action's error stays in the dialog and the card stays put", async () => {
  api.getDispatcher.mockResolvedValue(ACTIONS);
  api.actOnSignal.mockRejectedValueOnce(new Error("The signal is sent, so it cannot be dropped. Only a queued or held signal can."));
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Actions for Held one" }));
  fireEvent.click(screen.getByRole("button", { name: "Drop" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Already sent. Nothing changed.");
  expect(screen.getByRole("region", { name: "Held (1)" })).toBeInTheDocument();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

test("a failed read says so", async () => {
  api.getDispatcher.mockRejectedValue(new Error("Could not load the signals. Please try again."));
  renderPage();
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the signals. Please try again.");
});
