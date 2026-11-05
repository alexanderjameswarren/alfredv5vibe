import {
  appendHistory, deliveryWords, dispatcherView, newestFirst, timeKey, historyRows, insideWindow, mergedRow, nextRunLabel, pacificClock, pacificTime,
  queuedRows, reasonWords, reminderRow, sentRow, signalRow, summaryLine, twelveHour,
} from "./dispatcherModel";

// Invented data only.
const DELIVERY = {
  window: { start: "05:00", end: "20:00" },
  pace: { max_pops_per_hour: 3, max_pops_per_day: null, min_gap_minutes: 0 },
  defaults: { low: "hold", normal: "inbox", high: "pop", urgent: "pop" },
};
const UUID = "2e0f6bc8-e59a-4b75-94e1-cb3d9f5cf217";
const INBOX = "306d5c06-32f6-482e-8af4-f664c61de588";
const at = (pacific) => new Date(`2026-11-05T${pacific}:00-08:00`);

test("pacific times, 12-hour", () => {
  expect(pacificTime("2026-11-05T16:10:34Z")).toBe("Thu, Nov 5, 8:10 AM");
  expect(pacificTime(null)).toBe("");
  expect(pacificClock(new Date("2026-11-05T16:10:34Z"))).toBe("08:10");
  expect(twelveHour("05:00")).toBe("5:00 AM");
  expect(twelveHour("20:00")).toBe("8:00 PM");
  expect(twelveHour("12:30")).toBe("12:30 PM");
  expect(twelveHour("00:00")).toBe("12:00 AM");
});

test("next run: next top of the hour from 5 AM to 7 PM, else tomorrow 5 AM", () => {
  expect(nextRunLabel(at("09:15"))).toBe("10:00 AM");
  expect(nextRunLabel(at("04:59"))).toBe("5:00 AM");
  expect(nextRunLabel(at("00:10"))).toBe("5:00 AM");
  expect(nextRunLabel(at("18:30"))).toBe("7:00 PM");
  expect(nextRunLabel(at("19:00"))).toBe("tomorrow 5:00 AM");
  expect(nextRunLabel(at("23:45"))).toBe("tomorrow 5:00 AM");
});

test("inside the window: end exclusive; none without a window", () => {
  expect(insideWindow(DELIVERY, at("05:00"))).toBe(true);
  expect(insideWindow(DELIVERY, at("20:00"))).toBe(false);
  expect(insideWindow(DELIVERY, at("04:59"))).toBe(false);
  expect(insideWindow({}, new Date())).toBeNull();
  expect(insideWindow({ window: { start: "22:00", end: "06:00" } }, at("23:00"))).toBe(true);
});

test("rules in plain words: 12-hour, notification, notify", () => {
  expect(deliveryWords(DELIVERY)).toEqual({
    window: "Notifications from 5:00 AM to 8:00 PM Pacific.",
    pace: "At most 3 notifications an hour, no daily limit, no minimum gap.",
    defaults: "By default Low: hold · Normal: inbox · High: notify · Urgent: notify.",
  });
  expect(deliveryWords({ pace: { max_pops_per_day: 6, min_gap_minutes: 20 } })).toEqual({
    window: "No delivery window set.",
    pace: "No hourly limit, 6 a day, at least 20 minutes apart.",
    defaults: "No default decisions set.",
  });
  expect(deliveryWords(null)).toBeNull();
});

test("queued: scheduled reminders and step timers with a send time, soonest first; waiting steps left out", () => {
  const rows = queuedRows(
    [{ id: "r1", text: "Call the bank", state: "scheduled", due_at: "2026-11-06T17:00:00Z", intent_id: INBOX }],
    [{ id: "s1", execution_id: "ex1", text: "Slot 2", state: "scheduled", due_at: "2026-11-05T17:00:00Z" },
      { id: "s2", execution_id: "ex1", text: "Slot 3", state: "waiting", due_at: null }],
    { ex1: "Micro Workout Rotation" },
  );
  expect(rows.map((r) => r.id)).toEqual(["s1", "r1"]);
  expect(rows[0]).toMatchObject({ kind: "notify", title: "Micro Workout Rotation", path: "/schedule/execution/ex1",
    note: "Slot 2", meta: ["Step timer", "Sends Thu, Nov 5, 9:00 AM"] });
  expect(rows[1]).toMatchObject({ kind: "notify", title: "Call the bank", path: `/${INBOX}`,
    meta: ["Reminder", "Sends Fri, Nov 6, 9:00 AM"] });
  expect(reminderRow({ id: UUID, text: "x", due_at: "2026-11-06T17:00:00Z" }).path).toBe(`/${UUID}`);
});

test("unprocessed and held signal rows", () => {
  const queued = signalRow({ id: UUID, title: "t", app: "warren_buffet", severity: "high", state: "queued",
    details: { inbox_id: INBOX }, created_at: "2026-11-05T16:10:28Z" });
  expect(queued).toMatchObject({ kind: "pending", path: `/${INBOX}`, status: "", dispatcher: "",
    meta: ["Money", "High", "Raised Thu, Nov 5, 8:10 AM"] });
  const held = signalRow({ id: UUID, title: "t", app: "dj", severity: "low", state: "held", reason: "low signals are held",
    created_at: "2026-11-05T16:00:00Z", decided_at: "2026-11-05T17:00:00Z" }, { dj: "DJ" });
  expect(held).toMatchObject({ kind: "notsent", path: `/${UUID}`, status: "Held", dispatcher: "low signals are held",
    meta: ["DJ", "Low", "Held Thu, Nov 5, 9:00 AM"] });
});

test("reasons read notification, not pop", () => {
  expect(reasonWords("high signals default to pop")).toBe("high signals default to notification");
  expect(reasonWords("3 pops this hour; Pop limit")).toBe("3 notifications this hour; notification limit");
  expect(reasonWords("max_pops_per_hour")).toBe("max_pops_per_hour");
  expect(reasonWords(null)).toBe("");
});

test("sent rows: how, who, and the dispatcher's reason when a signal sent it", () => {
  const signals = { [UUID]: { id: UUID, reason: "normal signals default to inbox" } };
  const disp = sentRow({ id: "n1", title: "Sleep check-in done", app: "arnold", channel: "inbox_item", delivery_status: "sent",
    started_by: "task:claude-hourly-notifications", signal_id: UUID, link: `/${INBOX}`, created_at: "2026-11-05T16:10:34Z" },
  signals, { arnold: "Arnold" });
  expect(disp).toMatchObject({ kind: "inbox", path: `/${INBOX}`, status: "Sent Thu, Nov 5, 8:10 AM",
    dispatcher: "normal signals default to inbox", meta: ["Arnold", "Inbox item", "Started by task:claude-hourly-notifications"] });
  const popped = sentRow({ id: "n3", channel: "alfred_push", signal_id: "s9" }, { s9: { reason: "high signals default to pop" } });
  expect(popped).toMatchObject({ kind: "notify", dispatcher: "high signals default to notification" });
  const direct = sentRow({ id: "n2", title: "Alfred", app: "alfred", channel: "alfred_push", delivery_status: "no_subscription",
    started_by: null, link: "https://x", created_at: "2026-11-05T16:10:34Z" });
  expect(direct).toMatchObject({ kind: "notify", path: "/n2", dispatcher: "",
    meta: ["Alfred", "Notification, no device to send to", "Started by not recorded"] });
});

test("merged rows and the history order", () => {
  const merged = { id: UUID, title: "Sleep check-in done", app: "arnold", state: "merged", inbox_id: INBOX,
    created_at: "2026-11-05T15:12:26Z", decided_at: "2026-11-05T15:12:35Z" };
  expect(mergedRow(merged)).toMatchObject({ kind: "notsent", path: `/${INBOX}`, status: "Not sent",
    dispatcher: "an item already exists in the Inbox", meta: ["Arnold", "Thu, Nov 5, 7:12 AM"] });
  const rows = historyRows(
    [{ id: "n1", title: "a", app: "x", channel: "alfred_push", created_at: "2026-11-05T16:00:00Z" },
      { id: "n2", title: "b", app: "x", channel: "alfred_push", created_at: "2026-11-05T14:00:00Z" }],
    [merged, { id: "q1", state: "queued", title: "q", app: "x" }],
  );
  expect(rows.map((r) => r.id)).toEqual(["n1", UUID, "n2"]);
});

test("history order: to the microsecond whatever the fraction width, then id; pages append without repeats", () => {
  expect(timeKey("2026-11-05T16:00:00.5+00:00")).toBe(timeKey("2026-11-05T16:00:00.500000+00:00"));
  expect(timeKey("2026-11-05T16:00:00.000002+00:00") > timeKey("2026-11-05T16:00:00.000001Z")).toBe(true);
  expect(timeKey("2026-11-05T16:00:00Z")).toBe(timeKey("2026-11-05T08:00:00-08:00"));
  expect(timeKey(null)).toBe("");
  const rows = [{ id: "a", at: "2026-11-05T16:00:00.5+00:00" }, { id: "c", at: "2026-11-05T16:00:00.500000+00:00" },
    { id: "b", at: "2026-11-05T16:00:01Z" }];
  expect(rows.sort(newestFirst).map((r) => r.id)).toEqual(["b", "c", "a"]);
  expect(appendHistory([{ id: "1" }, { id: "2" }], [{ id: "2" }, { id: "3" }]).map((r) => r.id)).toEqual(["1", "2", "3"]);
});

test("the one-line summary", () => {
  expect(summaryLine({ queued: 1, unprocessed: 0, held: 2, pops: 1 })).toBe("1 queued · 0 unprocessed · 2 held · 1 notification today");
  expect(summaryLine()).toBe("0 queued · 0 unprocessed · 0 held · 0 notifications today");
});

test("the whole view", () => {
  const view = dispatcherView({ signals: [{ id: UUID, title: "t", app: "dj", state: "held" },
    { id: "q", title: "q", app: "dj", state: "queued" }], notifications: [], reminders: [], steps: [], delivery: DELIVERY },
  { now: at("08:00") });
  expect(view.inside).toBe(true);
  expect(view.nextRun).toBe("9:00 AM");
  expect(view.held).toHaveLength(1);
  expect(view.unprocessed).toHaveLength(1);
  expect(view.queued).toEqual([]);
});
