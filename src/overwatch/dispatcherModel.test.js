import {
  appendHistory, deliveryWords, dispatcherView, newestFirst, overrideLines, timeKey, historyRows, insideWindow, mergedRow, nextRunLabel, pacificClock, pacificTime,
  queuedRows, reasonWords, reminderRow, sentRow, signalRow, summaryLine, twelveHour, applyAction, actedRow, droppedRow, byHand,
  startedByWords, cardLink,
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
    details: { inbox_id: INBOX }, created_at: "2026-11-05T16:10:28Z", started_by: "task:wb-sync" });
  expect(queued).toMatchObject({ kind: "pending", path: `/${INBOX}`, status: "", dispatcher: "",
    meta: ["Money", "High", "Raised Thu, Nov 5, 8:10 AM", "Started by Wb sync"] });
  const held = signalRow({ id: UUID, title: "t", app: "dj", severity: "low", state: "held", reason: "low signals are held",
    created_at: "2026-11-05T16:00:00Z", decided_at: "2026-11-05T17:00:00Z", started_by: "task:dj-daily" }, { dj: "DJ" });
  expect(held).toMatchObject({ kind: "notsent", path: `/${UUID}`, status: "Held", dispatcher: "low signals are held",
    meta: ["DJ", "Low", "Held Thu, Nov 5, 9:00 AM", "Started by DJ daily"] });
});

test("a signal Alex held reads 'Held by you · <time>', with no dispatcher line", () => {
  const row = signalRow({ id: UUID, title: "t", app: "dj", severity: "low", state: "held", reason: "held by Alex",
    decided_by: "alex", created_at: "2026-11-06T16:00:00Z", decided_at: "2026-11-06T16:36:00Z", started_by: "chat" });
  expect(row.status).toBe("Held by you · Fri, Nov 6, 8:36 AM");
  expect(row.dispatcher).toBe("");
  expect(row.meta.filter(Boolean)).toEqual(["Dj", "Low", "Started by Claude"]);
});

test("started by, in plain words", () => {
  expect(startedByWords("alex")).toBe("you");
  expect(startedByWords("chat")).toBe("Claude");
  expect(startedByWords("task:arnold-morning-review")).toBe("Arnold morning review");
  expect(startedByWords("task:claude_hourly_notifications")).toBe("Claude hourly notifications");
  expect(startedByWords(null)).toBe("not recorded");
});

test("reasons read notification, not pop", () => {
  expect(reasonWords("high signals default to pop")).toBe("high signals default to notification");
  expect(reasonWords("3 pops this hour; Pop limit")).toBe("3 notifications this hour; notification limit");
  expect(reasonWords("max_pops_per_hour")).toBe("max_pops_per_hour");
  expect(reasonWords(null)).toBe("");
});

test("sent rows: how, who, and the dispatcher's reason when a signal sent it", () => {
  const signals = { [UUID]: { id: UUID, reason: "normal signals default to inbox", started_by: "task:arnold-morning-review" } };
  const disp = sentRow({ id: "n1", title: "Sleep check-in done", app: "arnold", channel: "inbox_item", delivery_status: "sent",
    started_by: "task:claude-hourly-notifications", signal_id: UUID, link: `/${INBOX}`, created_at: "2026-11-05T16:10:34Z" },
  signals, { arnold: "Arnold" });
  expect(disp).toMatchObject({ kind: "inbox", path: `/${INBOX}`, status: "Sent Thu, Nov 5, 8:10 AM",
    dispatcher: "normal signals default to inbox", meta: ["Arnold", "Inbox item", "Started by Arnold morning review"] });
  // The signal's own started_by, not who sent it.
  const handSent = sentRow({ id: "n4", channel: "alfred_push", started_by: "alex", signal_id: "s1" },
    { s1: { started_by: "chat", decided_by: "alex" } });
  expect(handSent.meta[2]).toBe("Started by Claude");
  const step = sentRow({ id: "n5", job: "step_timer", title: "Alfred", body: "Slot 2 — Heel-elevated air squats",
    channel: "alfred_push", started_by: "alex", created_at: "2026-11-06T16:33:00Z" });
  expect(step.title).toBe("Slot 2 — Heel-elevated air squats");
  expect(step.meta[2]).toBe("Started by you");
  const popped = sentRow({ id: "n3", channel: "alfred_push", signal_id: "s9" }, { s9: { reason: "high signals default to pop" } });
  expect(popped).toMatchObject({ kind: "notify", dispatcher: "high signals default to notification" });
  const direct = sentRow({ id: "n2", title: "Alfred", app: "alfred", channel: "alfred_push", delivery_status: "no_subscription",
    started_by: null, link: "https://x", created_at: "2026-11-05T16:10:34Z" });
  expect(direct).toMatchObject({ kind: "notify", path: "/n2", dispatcher: "",
    meta: ["Alfred", "Notification, no device to send to", "Started by not recorded"] });
});

test("merged rows and the history order", () => {
  const merged = { id: UUID, title: "Sleep check-in done", app: "arnold", state: "merged", inbox_id: INBOX,
    created_at: "2026-11-05T15:12:26Z", decided_at: "2026-11-05T15:12:35Z", started_by: "task:claude-hourly-notifications" };
  expect(mergedRow(merged)).toMatchObject({ kind: "notsent", path: `/${INBOX}`, status: "Not sent Thu, Nov 5, 7:12 AM",
    dispatcher: "an item already exists in the Inbox",
    meta: ["Arnold", "Started by Claude hourly notifications"] });
  const rows = historyRows(
    [{ id: "n1", title: "a", app: "x", channel: "alfred_push", created_at: "2026-11-05T16:00:00Z" },
      { id: "n2", title: "b", app: "x", channel: "alfred_push", created_at: "2026-11-05T14:00:00Z" }],
    [merged, { id: "q1", state: "queued", title: "q", app: "x" }],
  );
  expect(rows.map((r) => r.id)).toEqual(["n1", UUID, "n2"]);
});

test("history is newest first by when it happened: decided_at for signals, the send time for sends", () => {
  // Alex's test on Nov 6: B raised first and dropped 8:37, A sent 8:36, C dropped 8:39, a step at 8:33.
  const t = (hm) => `2026-11-06T16:${hm}:00Z`;
  const rows = historyRows(
    [{ id: "nA", title: "A", channel: "inbox_item", created_at: t("36") },
      { id: "nStep", job: "step_timer", title: "Alfred", body: "Squats", channel: "alfred_push", created_at: t("33") }],
    [{ id: "B", title: "B", state: "dropped", created_at: t("00"), decided_at: t("37") },
      { id: "C", title: "C", state: "dropped", created_at: t("38"), decided_at: t("39") }],
  );
  expect(rows.map((r) => r.title)).toEqual(["C", "B", "A", "Squats"]);
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

test("overrides in plain words, 12-hour Pacific times, ended ones marked ended", () => {
  const now = new Date("2026-11-06T18:00:00Z");
  const lines = overrideLines([
    { label: "Arnold any hour", match: { app: "arnold" }, effect: { window: { ignore: true } },
      when: { ends_at: "2026-11-12T23:00:00Z" } },
    { label: "DJ is too chatty", match: { app: "dj" }, effect: { decision: "inbox" } },
    { label: "Big ones", match: { severity: ["high", "urgent"] }, effect: { pace: { exempt: true } } },
    { label: "Mute Ken", match: { app: "ken", kind: ["failure"] }, effect: { decision: "hold" },
      when: { ends_at: "2026-11-05T17:00:00Z" } },
    { label: "Later", effect: { severity: -1 }, when: { starts_at: "2026-11-08T17:00:00Z", days_of_week: ["mon", "fri"],
      time_from: "09:00", time_to: "17:00" } },
  ], { arnold: "Arnold", dj: "DJ", ken: "Ken" }, now);
  expect(lines.map((l) => l.text)).toEqual([
    "Arnold notifications: any hour, until Nov 12, 3:00 PM",
    "DJ: inbox instead of a notification",
    "High and Urgent notifications: no hourly or daily limit",
    "Ken failures: held. Ended Nov 5, 9:00 AM",
    "Everything: one step less important, Mon and Fri, 9:00 AM to 5:00 PM, from Nov 8, 9:00 AM",
  ]);
  expect(lines.map((l) => l.status)).toEqual(["in force", "in force", "in force", "ended", "not yet"]);
  expect(lines.map((l) => l.text).join(" ")).not.toMatch(/\bpop/i);
  expect(overrideLines(undefined)).toEqual([]);
  expect(dispatcherView({ delivery: { ...DELIVERY, overrides: [{ label: "x", effect: { decision: "drop" } }] } }).overrides)
    .toEqual([{ label: "x", text: "Everything: dropped", status: "in force" }]);
});

test("the daily limit reads max_per_day_all first", () => {
  expect(deliveryWords({ ...DELIVERY, pace: { max_pops_per_hour: 3, max_pops_per_day: null, max_per_day_all: 8 } }).pace)
    .toBe("At most 3 notifications an hour, 8 a day, no minimum gap.");
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

const SENT_AT = "2026-11-06T16:20:00Z"; // 8:20 AM Pacific
const SIG = { id: UUID, title: "Bank sync failed", app: "warren_buffet", severity: "high", state: "queued",
  created_at: "2026-11-06T15:00:00Z", reason: null };

test("by you: History says when Alex decided it, the dispatcher's reason only when it did", () => {
  expect(byHand("alex")).toBe(true);
  expect(byHand("chat")).toBe(true);
  expect(byHand(null)).toBe(false);
  const n = { id: "n1", channel: "alfred_push", title: "t", link: `/${INBOX}`, created_at: SENT_AT, signal_id: UUID };
  expect(sentRow(n, { [UUID]: { reason: "sent now", decided_by: "alex" } }).status).toBe("Sent Fri, Nov 6, 8:20 AM · by you");
  expect(sentRow(n, { [UUID]: { reason: "sent now", decided_by: "alex" } }).dispatcher).toBe("");
  expect(sentRow(n, { [UUID]: { reason: "high signals default to pop" } }).status).toBe("Sent Fri, Nov 6, 8:20 AM");
  const dropped = droppedRow({ ...SIG, state: "dropped", decided_at: SENT_AT, decided_by: "chat", reason: "dropped by Alex" });
  expect(dropped.status).toBe("Dropped Fri, Nov 6, 8:20 AM · by you");
  expect(dropped.kind).toBe("notsent");
  expect(droppedRow({ ...SIG, state: "dropped", decided_at: SENT_AT, started_by: "chat" }).meta[2]).toBe("Started by Claude");
  expect(droppedRow({ ...SIG, state: "dropped", decided_at: SENT_AT, reason: "override 'mute': dropped" }).dispatcher)
    .toBe("override 'mute': dropped");
  const folded = mergedRow({ ...SIG, state: "merged", inbox_id: INBOX, decided_at: SENT_AT, decided_by: "alex" });
  expect(folded.status).toBe("Added to the open inbox item Fri, Nov 6, 8:20 AM · by you");
  expect(folded.path).toBe(`/${INBOX}`);
});

test("history includes dropped signals", () => {
  const rows = historyRows([], [{ ...SIG, state: "dropped", decided_at: SENT_AT }, { ...SIG, id: "m", state: "merged" }]);
  expect(rows.map((r) => r.status)).toEqual(expect.arrayContaining(["Not sent Fri, Nov 6, 7:00 AM", "Dropped Fri, Nov 6, 8:20 AM"]));
});

test("a reminder send is titled with the reminder's text", () => {
  const row = sentRow({ id: "n6", job: "reminder", title: "Alfred reminder", body: "Call the bank", channel: "alfred_push",
    started_by: "alex", created_at: SENT_AT });
  expect(row.title).toBe("Call the bank");
  expect(sentRow({ id: "n7", job: "reminder", title: "Alfred reminder", channel: "alfred_push" }).title).toBe("Alfred reminder");
});

test("task names use the app's own name", () => {
  const names = { dj: "DJ", sam: "SAM", ken: "Ken", warren_buffet: "Money", drive_mix: "Drive Mix", arnold: "Arnold" };
  expect(startedByWords("task:dj-weekly-review", names)).toBe("DJ weekly review");
  expect(startedByWords("task:sam-daily-review", names)).toBe("SAM daily review");
  expect(startedByWords("task:money-cleanup", names)).toBe("Money cleanup");
  expect(startedByWords("task:drive-mix-daily-refresh", names)).toBe("Drive Mix daily refresh");
  expect(startedByWords("task:ken-seed-check", names)).toBe("Ken seed check");
  expect(startedByWords("task:claude-hourly-notifications", names)).toBe("Claude hourly notifications");
  expect(droppedRow({ ...SIG, state: "dropped", decided_at: SENT_AT, started_by: "task:dj-daily" }, names).meta[2])
    .toBe("Started by DJ daily");
});

test("every card links /<id>: the long inbox and execution forms are shortened", () => {
  expect(cardLink("/inbox/detail/6847fee0-1a1b-421f-8c47-bb655693765a")).toBe("/6847fee0-1a1b-421f-8c47-bb655693765a");
  expect(cardLink("/schedule/execution/mw29j6q2c75vpw7pg5b")).toBe("/mw29j6q2c75vpw7pg5b");
  expect(cardLink(`/${INBOX}`)).toBe(`/${INBOX}`);
  expect(cardLink("//evil.example")).toBeNull();
  expect(cardLink("https://x")).toBeNull();
  const sent = sentRow({ id: "n8", channel: "alfred_push", link: "/schedule/execution/mw29j6q2c75vpw7pg5b", created_at: SENT_AT });
  expect(sent.path).toBe("/mw29j6q2c75vpw7pg5b");
  expect(queuedRows([], [{ id: "t1", state: "scheduled", due_at: SENT_AT, execution_id: "mw29j6q2c75vpw7pg5b", text: "Squats" }])[0].path)
    .toBe("/mw29j6q2c75vpw7pg5b");
});

test("after an action: held moves to Held, dropped and sent move to History, without a reload", () => {
  const data = { signals: [SIG, { ...SIG, id: "other", title: "Other" }], history: { notifications: [], signals: [] },
    reminders: [], steps: [] };
  const held = applyAction(data, UUID, { state: "held" }, SENT_AT);
  let view = dispatcherView(held, { now: new Date(SENT_AT) });
  expect(view.held.map((r) => r.id)).toEqual([UUID]);
  expect(view.unprocessed.map((r) => r.id)).toEqual(["other"]);

  const sent = applyAction(held, UUID, { state: "delivered", as: "notification", inbox_id: INBOX }, SENT_AT);
  view = dispatcherView(sent, { now: new Date(SENT_AT) });
  expect(view.held).toEqual([]);
  expect(view.history[0]).toMatchObject({ id: UUID, kind: "notify", path: `/${INBOX}`,
    status: "Sent Fri, Nov 6, 8:20 AM · by you" });

  const dropped = applyAction(data, "other", { state: "dropped" }, SENT_AT);
  view = dispatcherView(dropped, { now: new Date(SENT_AT) });
  expect(view.history[0].status).toBe("Dropped Fri, Nov 6, 8:20 AM · by you");
  expect(applyAction(data, "missing", { state: "held" })).toBe(data);
});

test("acted rows: an inbox send opens the item; a fold says it joined the open item", () => {
  const row = actedRow({ signal: SIG, result: { state: "delivered", as: "inbox", inbox_id: INBOX }, at: SENT_AT });
  expect(row).toMatchObject({ kind: "inbox", path: `/${INBOX}` });
  expect(row.meta[1]).toBe("Inbox item");
  expect(actedRow({ signal: SIG, result: { state: "merged", inbox_id: INBOX }, at: SENT_AT }).status)
    .toBe("Added to the open inbox item Fri, Nov 6, 8:20 AM · by you");
});
