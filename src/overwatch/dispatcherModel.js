import { isRecordId, recordPath, executionPath } from "../viewPaths";
import { appDisplayName } from "./appNames";

// The Dispatcher screen's pure logic (notification_routing-d7v, spec section 10). Read only.

const TZ = "America/Los_Angeles";

// The hourly dispatcher task runs at :00 from 5 AM to 7 PM Pacific.
const FIRST_RUN_HOUR = 5;
const LAST_RUN_HOUR = 19;

export const SECTIONS = [
  { id: "queued", title: "Queued", empty: "Nothing is scheduled to be sent." },
  { id: "unprocessed", title: "Unprocessed", empty: "Nothing is waiting for the dispatcher." },
  { id: "held", title: "Held", empty: "Nothing held." },
  { id: "history", title: "History", empty: "Nothing sent yet." },
];

const SEVERITY_WORDS = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };
const DEFAULT_WORDS = { hold: "hold", inbox: "inbox", pop: "notify" };
const CHANNEL_WORDS = { alfred_push: "Notification", inbox_item: "Inbox item", claude_push: "Claude app notification" };
const FAILED_WORDS = { failed: "failed", no_subscription: "no device to send to", pending: "still sending" };

/** "Thu, Nov 5, 8:10 AM" in Pacific, or "" for no time. */
export function pacificTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(d);
}

/** { hour, minute } on the Pacific clock. */
function pacificHM(now) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  return { hour: get("hour"), minute: get("minute") };
}

/** "HH:MM" on the Pacific clock. */
export function pacificClock(now = new Date()) {
  const { hour, minute } = pacificHM(now);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** "05:00" -> "5:00 AM", "20:00" -> "8:00 PM". */
export function twelveHour(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  if (Number.isNaN(h)) return String(hhmm);
  const suffix = h < 12 ? "AM" : "PM";
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m || 0).padStart(2, "0")} ${suffix}`;
}

/** The hourly dispatcher's next run: "10:00 AM", or "tomorrow 5:00 AM" after the last run of the day. */
export function nextRunLabel(now = new Date()) {
  const { hour } = pacificHM(now);
  if (hour < FIRST_RUN_HOUR) return twelveHour(`${FIRST_RUN_HOUR}:00`);
  if (hour < LAST_RUN_HOUR) return twelveHour(`${hour + 1}:00`);
  return `tomorrow ${twelveHour(`${FIRST_RUN_HOUR}:00`)}`;
}

/** Whether now is inside the delivery window (end exclusive), or null when the plan has no window. */
export function insideWindow(delivery, now = new Date()) {
  const w = delivery?.window;
  if (!w?.start || !w?.end) return null;
  const t = pacificClock(now);
  return w.start <= w.end ? t >= w.start && t < w.end : t >= w.start || t < w.end;
}

/** The active rules in plain words: { window, pace, defaults }, or null when the plan has no delivery section. */
export function deliveryWords(delivery) {
  if (!delivery || typeof delivery !== "object") return null;
  const w = delivery.window;
  const window = w?.start && w?.end
    ? `Notifications from ${twelveHour(w.start)} to ${twelveHour(w.end)} Pacific.`
    : "No delivery window set.";
  const p = delivery.pace || {};
  const pace = [
    p.max_pops_per_hour ? `At most ${p.max_pops_per_hour} notifications an hour` : "No hourly limit",
    (p.max_per_day_all ?? p.max_pops_per_day) ? `${p.max_per_day_all ?? p.max_pops_per_day} a day` : "no daily limit",
    p.min_gap_minutes ? `at least ${p.min_gap_minutes} minutes apart` : "no minimum gap",
  ].join(", ") + ".";
  const d = delivery.defaults || {};
  const defaults = ["low", "normal", "high", "urgent"]
    .filter((s) => d[s]).map((s) => `${SEVERITY_WORDS[s]}: ${DEFAULT_WORDS[d[s]] || d[s]}`).join(" · ");
  return { window, pace, defaults: defaults ? `By default ${defaults}.` : "No default decisions set." };
}

const KIND_WORDS = { nudge: "nudges", flag: "flags", info: "updates", encouragement: "encouragements", failure: "failures" };
const DAY_WORDS = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const DECISION_EFFECTS = {
  notify: "always a notification", inbox: "inbox instead of a notification", hold: "held", drop: "dropped",
};

/** "Nov 12, 3:00 PM" in Pacific. */
function pacificShort(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return String(iso);
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    .format(at);
}

const andList = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Who an override is for: "High and Urgent Arnold", "DJ failures", or "Everything". */
function overrideWho(match, appNames) {
  const m = match || {};
  const parts = [];
  if (Array.isArray(m.severity)) parts.push(andList(m.severity.map((s) => SEVERITY_WORDS[s] || s)));
  if (m.app) parts.push(appDisplayName(m.app, appNames));
  if (m.job) parts.push(`(${m.job})`);
  if (m.subject_key) parts.push(m.subject_key.endsWith("*") ? `${m.subject_key.slice(0, -1)}…` : m.subject_key);
  if (Array.isArray(m.kind)) parts.push(andList(m.kind.map((k) => KIND_WORDS[k] || k)));
  if (m.started_by) parts.push(`started by ${m.started_by}`);
  return parts.length ? parts.join(" ") : "Everything";
}

/** What an override does, as a list of short phrases. */
function overrideEffects(effect) {
  const e = effect || {};
  const out = [];
  if (e.decision) out.push(DECISION_EFFECTS[e.decision] || e.decision);
  if (typeof e.severity === "string") out.push(`treated as ${SEVERITY_WORDS[e.severity] || e.severity}`);
  if (e.severity === 1) out.push("one step more important");
  if (e.severity === -1) out.push("one step less important");
  const p = e.pace || {};
  if (p.exempt) out.push("no hourly or daily limit");
  if (p.max_per_hour != null) out.push(`at most ${p.max_per_hour} an hour`);
  if (p.max_per_day != null) out.push(`at most ${p.max_per_day} a day`);
  if (p.min_gap_minutes != null) out.push(`at least ${p.min_gap_minutes} minutes apart`);
  if (e.window?.ignore) out.push("any hour");
  else if (e.window?.start) out.push(`from ${twelveHour(e.window.start)} to ${twelveHour(e.window.end)}`);
  if (e.bundle === "never") out.push("never bundled");
  if (e.bundle === "always") out.push("always bundled");
  if (e.merge === false) out.push("never added to an open item");
  if (e.priority === "before") out.push("first when the limit is reached");
  if (e.priority === "after") out.push("last when the limit is reached");
  return out;
}

/** When an override holds: "Mon and Fri", "9:00 AM to 5:00 PM", "from …", "until …". */
function overrideWhen(when) {
  const w = when || {};
  const out = [];
  if (Array.isArray(w.days_of_week)) out.push(andList(w.days_of_week.map((x) => DAY_WORDS[x] || x)));
  if (w.time_from && w.time_to) out.push(`${twelveHour(w.time_from)} to ${twelveHour(w.time_to)}`);
  if (w.starts_at) out.push(`from ${pacificShort(w.starts_at)}`);
  if (w.ends_at) out.push(`until ${pacificShort(w.ends_at)}`);
  return out;
}

/**
 * Each override in plain words, for the rules card: { label, text, status } where status is "in force",
 * "not yet" or "ended". E.g. "Arnold notifications: any hour, until Nov 12, 3:00 PM".
 */
export function overrideLines(overrides, appNames = {}, now = new Date()) {
  if (!Array.isArray(overrides)) return [];
  return overrides.map((o) => {
    const effects = overrideEffects(o.effect);
    // An override about how notifications go (not which outcome) reads as "<who> notifications".
    const aboutNotifications = !o.effect?.decision && o.effect?.severity === undefined;
    const who = overrideWho(o.match, appNames);
    const subject = aboutNotifications ? `${who} notifications` : who;
    const ends = o.when?.ends_at && Date.parse(o.when.ends_at) <= now.getTime();
    const starts = o.when?.starts_at && Date.parse(o.when.starts_at) > now.getTime();
    const when = ends ? [] : overrideWhen(o.when);
    const text = `${subject}: ${[...effects, ...when].join(", ")}`;
    return {
      label: o.label,
      text: ends ? `${text}. Ended ${pacificShort(o.when.ends_at)}` : text,
      status: ends ? "ended" : starts ? "not yet" : "in force",
    };
  });
}

const inboxPathOf = (id) => (isRecordId(id) ? recordPath(id) : null);
const inboxIdOf = (s) => s.inbox_id || s.details?.inbox_id || null;

/** A stored reason in plain words, for display only: "pop" reads "notification". */
export function reasonWords(reason) {
  return String(reason || "").replace(/\bpop(s?)\b/gi, "notification$1");
}

// Each card's icon says what happened or will happen: notify, inbox, notsent or pending.

/** A signal still waiting for the dispatcher, or one it held. The card opens its inbox item, else the signal. */
export function signalRow(s, appNames = {}) {
  const held = s.state === "held";
  return {
    id: s.id,
    kind: held ? "notsent" : "pending",
    title: s.title,
    path: inboxPathOf(inboxIdOf(s)) || recordPath(s.id),
    status: held ? "Held" : "",
    meta: [appDisplayName(s.app, appNames), SEVERITY_WORDS[s.severity] || s.severity,
      held && s.decided_at ? `Held ${pacificTime(s.decided_at)}` : `Raised ${pacificTime(s.created_at)}`],
    dispatcher: held ? reasonWords(s.reason) : "",
    note: "",
  };
}

/** A scheduled reminder, as a Queued row. The card opens what it is for, else the reminder. */
export function reminderRow(r) {
  return {
    id: r.id,
    kind: "notify",
    sortAt: r.due_at,
    title: r.text,
    path: inboxPathOf(r.inbox_id || r.intent_id) || recordPath(r.id),
    status: "",
    meta: ["Reminder", `Sends ${pacificTime(r.due_at)}`],
    dispatcher: "",
    note: "",
  };
}

/** A step timer with a fire time, as a Queued row: the card opens the execution. */
export function stepRow(st, executionNames = {}) {
  return {
    id: st.id,
    kind: "notify",
    sortAt: st.due_at,
    title: executionNames[st.execution_id] || "Execution",
    path: st.execution_id ? executionPath(st.execution_id) : recordPath(st.id),
    status: "",
    meta: ["Step timer", `Sends ${pacificTime(st.due_at)}`],
    dispatcher: "",
    note: st.text,
  };
}

/** Queued: reminders and step timers with a known send time, soonest first. Waiting steps are left out. */
export function queuedRows(reminders, steps, executionNames = {}) {
  const rows = [
    ...(reminders || []).filter((r) => r.state === "scheduled" && r.due_at).map(reminderRow),
    ...(steps || []).filter((st) => st.state === "scheduled" && st.due_at).map((st) => stepRow(st, executionNames)),
  ];
  return rows.sort((a, b) => String(a.sortAt).localeCompare(String(b.sortAt)));
}

/** A sent row from claude_notifications; a dispatcher send carries the signal's reason. The card opens its link. */
export function sentRow(n, signalsById = {}, appNames = {}) {
  const how = CHANNEL_WORDS[n.channel] || n.channel;
  const problem = FAILED_WORDS[n.delivery_status];
  const signal = n.signal_id ? signalsById[n.signal_id] : null;
  const link = typeof n.link === "string" && n.link.startsWith("/") && !n.link.startsWith("//") ? n.link : null;
  return {
    id: n.id,
    kind: n.channel === "inbox_item" ? "inbox" : "notify",
    sortAt: n.created_at,
    title: n.title,
    path: link || recordPath(n.id),
    status: `Sent ${pacificTime(n.created_at)}`,
    meta: [appDisplayName(n.app, appNames), problem ? `${how}, ${problem}` : how, `Started by ${n.started_by || "not recorded"}`],
    dispatcher: reasonWords(signal?.reason),
    note: "",
  };
}

/** A merged signal: not sent, because the inbox already held an item for it. The card opens that item. */
export function mergedRow(s, appNames = {}) {
  // created_at, not decided_at: History pages on it, and decided_at can be null.
  const at = s.created_at;
  return {
    id: s.id,
    kind: "notsent",
    sortAt: at,
    title: s.title,
    path: inboxPathOf(inboxIdOf(s)) || recordPath(s.id),
    status: "Not sent",
    meta: [appDisplayName(s.app, appNames), pacificTime(at)],
    dispatcher: "an item already exists in the Inbox",
    note: "",
  };
}

/**
 * A timestamp as a fixed-width string that sorts to the microsecond, whatever fraction width
 * PostgREST returned ("…:34.5+00:00" and "…:34.123456+00:00" both work). "" when unreadable.
 */
export function timeKey(iso) {
  const m = String(iso || "").match(/^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$/);
  if (!m) return "";
  const ms = Date.parse(m[1] + (m[3] || "Z"));
  if (Number.isNaN(ms)) return "";
  return String(ms / 1000).padStart(12, "0") + (m[2] || "").padEnd(6, "0").slice(0, 6);
}

/** History order, the same as the read's: time newest first, then id descending. Takes { at | sortAt, id }. */
export function newestFirst(a, b) {
  const ka = timeKey(a.at ?? a.sortAt);
  const kb = timeKey(b.at ?? b.sortAt);
  if (ka !== kb) return ka < kb ? 1 : -1;
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}

/** History: sent rows and merged signals together, newest first. */
export function historyRows(notifications, signals, appNames = {}) {
  const byId = Object.fromEntries((signals || []).map((s) => [s.id, s]));
  const rows = [
    ...(notifications || []).map((n) => sentRow(n, byId, appNames)),
    ...(signals || []).filter((s) => s.state === "merged").map((s) => mergedRow(s, appNames)),
  ];
  return rows.sort(newestFirst);
}

/** An older page appended under the cards already shown; a card already shown is not added again. */
export function appendHistory(rows, older) {
  const seen = new Set(rows.map((r) => r.id));
  return [...rows, ...older.filter((r) => !seen.has(r.id))];
}

/** The Overwatch tab's one line: "1 queued · 0 unprocessed · 2 held · 3 notifications today". */
export function summaryLine({ queued = 0, unprocessed = 0, held = 0, pops = 0 } = {}) {
  return `${queued} queued · ${unprocessed} unprocessed · ${held} held · ${pops} ${pops === 1 ? "notification" : "notifications"} today`;
}

/** Everything the page renders, from the raw reads. */
export function dispatcherView(data, { now = new Date(), appNames = {} } = {}) {
  const signals = data.signals || [];
  return {
    rules: deliveryWords(data.delivery),
    overrides: overrideLines(data.delivery?.overrides, appNames, now),
    inside: insideWindow(data.delivery, now),
    nextRun: nextRunLabel(now),
    queued: queuedRows(data.reminders, data.steps, data.executionNames || {}),
    unprocessed: signals.filter((s) => s.state === "queued").map((s) => signalRow(s, appNames)),
    held: signals.filter((s) => s.state === "held").map((s) => signalRow(s, appNames)),
    history: historyRows(data.history?.notifications, data.history?.signals, appNames),
    historyNext: data.history?.next || null,
  };
}
