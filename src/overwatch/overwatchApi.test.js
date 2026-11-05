// Invented data only. The fake client logs each query and answers it through mockRespond(table, ops).
let mockLog = [];
let mockRespond = () => ({ data: [], error: null });

jest.mock("../supabaseClient", () => {
  const from = (table) => {
    const ops = [];
    mockLog.push({ table, ops });
    const finish = () => Promise.resolve(mockRespond(table, ops));
    const b = new Proxy({}, {
      get: (_t, k) => {
        if (k === "then") return (res, rej) => finish().then(res, rej);
        if (k === "maybeSingle") return () => { ops.push([k]); return finish(); };
        return (...a) => { ops.push([k, ...a]); return b; };
      },
    });
    return b;
  };
  const rpc = (fn, params) => {
    mockLog.push({ table: `rpc:${fn}`, ops: [["params", params]] });
    return Promise.resolve(mockRespond(`rpc:${fn}`, []));
  };
  return { supabase: { from, rpc } };
});

const api = require("./overwatchApi");
const has = (q, ...op) => q.ops.some((o) => JSON.stringify(o) === JSON.stringify(op));

beforeEach(() => {
  mockLog = [];
  mockRespond = () => ({ data: [], error: null });
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

test("notes: the latest nightly, and a weekly from the last 7 days", async () => {
  mockRespond = (_t, ops) => ({ data: { id: ops.find((o) => o[0] === "eq")[2] }, error: null });
  const out = await api.getNotes("2026-10-26");
  expect(out).toEqual({ nightly: { id: "nightly" }, weekly: { id: "weekly" } });
  const [nightly, weekly] = mockLog;
  expect(nightly.table).toBe("overwatch_notes");
  expect(has(nightly, "order", "for_date", { ascending: false })).toBe(true);
  expect(has(weekly, "gte", "for_date", "2026-10-20")).toBe(true);
});

test("notes: none is null; an error is a plain sentence", async () => {
  mockRespond = () => ({ data: null, error: null });
  expect(await api.getNotes("2026-10-26")).toEqual({ nightly: null, weekly: null });
  mockRespond = () => ({ data: null, error: { message: "boom" } });
  await expect(api.getNotes("2026-10-26")).rejects.toThrow("Could not load tonight's note. Please try again.");
});

test("latest runs: newest real nightly and weekly, skipping duplicates and open runs", async () => {
  mockRespond = () => ({
    data: [
      { id: "r0", job: "nightly", status: "running" },
      { id: "r1", job: "nightly", status: "ok", details: { duplicate_of: "r2" } },
      { id: "r2", job: "nightly", status: "partial", details: {} },
      { id: "w1", job: "weekly", status: "failed", details: {} },
    ],
    error: null,
  });
  const out = await api.getLatestRuns();
  expect([out.nightly.id, out.weekly.id]).toEqual(["r2", "w1"]);
  const q = mockLog[0];
  expect(q.table).toBe("platform_runs");
  expect(has(q, "eq", "app", "overwatch")).toBe(true);
  expect(has(q, "in", "job", ["nightly", "weekly"])).toBe(true);
  mockRespond = () => ({ data: [], error: null });
  expect(await api.getLatestRuns()).toEqual({ nightly: null, weekly: null });
});

test("one note by id; the run that wrote a note, skipping open and duplicate runs", async () => {
  mockRespond = () => ({ data: { id: "n1" }, error: null });
  expect(await api.getNote("n1")).toEqual({ id: "n1" });
  expect(has(mockLog[0], "eq", "id", "n1")).toBe(true);
  mockLog = [];
  mockRespond = () => ({ data: [
    { id: "a", status: "running" }, { id: "b", status: "ok", details: { duplicate_of: "c" } }, { id: "c", status: "partial" },
  ], error: null });
  expect((await api.getRunForNote({ period: "weekly", for_date: "2026-10-26" })).id).toBe("c");
  expect(has(mockLog[0], "eq", "job", "weekly")).toBe(true);
  expect(has(mockLog[0], "eq", "details->>local_date", "2026-10-26")).toBe(true);
});

test("projects: progress rpc, then estimates, live members, waited-on names and the plan", async () => {
  mockRespond = (t) => ({
    "rpc:overwatch_project_progress": { data: [{ group_id: "g1", waiting_on_group_id: "g2" }], error: null },
    project_estimates: { data: [{ group_id: "g1", kind: "initial" }], error: null },
    item_group_members: { data: [{ group_id: "g1" }], error: null },
    item_groups: { data: [{ id: "g2", name: "Other" }], error: null },
    overwatch_plans: { data: { id: "p1", settings: { stall_days: 5 } }, error: null },
    group_types: { data: { icon: "SquareKanban" }, error: null },
  }[t]);
  const out = await api.getProjects();
  expect(out).toEqual({
    projects: [{ group_id: "g1", waiting_on_group_id: "g2" }],
    estimates: [{ group_id: "g1", kind: "initial" }],
    memberGroupIds: ["g1"],
    groupNames: { g2: "Other" },
    settings: { stall_days: 5 },
    projectIcon: "SquareKanban",
  });
  expect(has(mockLog.find((q) => q.table === "group_types"), "eq", "kind", "project")).toBe(true);
  const members = mockLog.find((q) => q.table === "item_group_members");
  expect(has(members, "is", "removed_at", null)).toBe(true);
  expect(has(members, "in", "member_type", ["item", "intention"])).toBe(true);
  expect(has(mockLog.find((q) => q.table === "overwatch_plans"), "eq", "active", true)).toBe(true);
});

test("projects: none active reads only the plan and the icon", async () => {
  mockRespond = (t) => (t === "overwatch_plans" || t === "group_types" ? { data: null, error: null } : { data: [], error: null });
  const out = await api.getProjects();
  expect([out.projects, out.settings, out.projectIcon]).toEqual([[], {}, "SquareKanban"]);
  expect(mockLog.map((q) => q.table)).toEqual(["rpc:overwatch_project_progress", "overwatch_plans", "group_types"]);
});

test("quiet: the view, the profiles' rhythms and ease_off watch items", async () => {
  mockRespond = (t) => ({ data: [{ t }], error: null });
  const out = await api.getQuiet();
  expect(out).toEqual({ lastActivity: [{ t: "overwatch_app_last_activity" }], profiles: [{ t: "app_profiles" }],
    watch: [{ t: "overwatch_watch" }] });
  expect(has(mockLog.find((q) => q.table === "overwatch_watch"), "eq", "kind", "ease_off")).toBe(true);
  mockRespond = (t) => (t === "app_profiles" ? { data: null, error: { message: "x" } } : { data: [], error: null });
  await expect(api.getQuiet()).rejects.toThrow("Could not load the apps' profiles");
});

test("one Pacific day of activity: a UTC window either side, then filtered to the day", async () => {
  mockRespond = () => ({ data: [
    { id: "late", occurred_at: "2026-10-26T06:30:00Z" }, // Oct 25, 11:30 pm Pacific
    { id: "in", occurred_at: "2026-10-26T18:00:00Z" },
    { id: "next", occurred_at: "2026-10-27T08:00:00Z" }, // Oct 27, 1 am Pacific
  ], error: null });
  expect((await api.getActivityDay("2026-10-26")).map((r) => r.id)).toEqual(["in"]);
  // A nightly row belongs to the day in its source_ref, whenever it was stamped.
  mockRespond = () => ({ data: [
    { id: "n24", occurred_at: "2026-10-25T18:39:58Z", source: "nightly", source_ref: "sam:2026-10-24" },
    { id: "n25", occurred_at: "2026-10-25T19:00:00Z", source: "nightly", source_ref: "sam:2026-10-25" },
  ], error: null });
  expect((await api.getActivityDay("2026-10-24")).map((r) => r.id)).toEqual(["n24"]);
  const q = mockLog[0];
  expect(has(q, "gte", "occurred_at", "2026-10-25T00:00:00Z")).toBe(true);
  expect(has(q, "lt", "occurred_at", "2026-10-28T00:00:00Z")).toBe(true);
  expect(has(q, "order", "occurred_at", { ascending: false })).toBe(true);
});

test("ideas: someday Projects and parked active ones, with added date and context", async () => {
  mockRespond = (t) => ({
    "rpc:overwatch_project_progress": { data: [
      { group_id: "s1", group_status: "someday", context_id: "c1" },
      { group_id: "p1", group_status: "active", hurdle_kind: "time", context_id: null },
      { group_id: "a1", group_status: "active", hurdle_kind: null },
    ], error: null },
    item_groups: { data: [{ id: "s1", created_at: "2026-10-03T00:00:00Z" }], error: null },
    contexts: { data: [{ id: "c1", name: "Home", app_id: "alfred" }], error: null },
  }[t]);
  const out = await api.getIdeas();
  expect(out.map((i) => [i.group_id, i.created_at, i.context?.name ?? null]))
    .toEqual([["s1", "2026-10-03T00:00:00Z", "Home"], ["p1", null, null]]);
  expect(mockLog[0].ops[0][1]).toEqual({ p_status: ["someday", "active"] });
});

test("idea records: Alfred's live items and intentions, idea-tagged ones elsewhere, and their group memberships", async () => {
  mockRespond = (t, ops) => {
    if (t === "contexts") return { data: [{ id: "ca", name: "Alfred" }, { id: "ch", name: "Home" }], error: null };
    if (t === "item_group_members") return { data: [{ member_id: "i1" }], error: null };
    const tagged = ops.some((o) => o[0] === "contains");
    if (t === "items") return { data: tagged ? [{ id: "i9", name: "Pond", context_id: "ch" }] : [{ id: "i1", name: "A" }], error: null };
    return { data: tagged ? [] : [{ id: "n1", text: "B" }], error: null };
  };
  const out = await api.getIdeaRecords();
  expect(out.alfredContextId).toBe("ca");
  expect(out.records.map((r) => [r.id, r.name, r.type])).toEqual([["i1", "A", "item"], ["i9", "Pond", "item"], ["n1", "B", "intention"]]);
  expect(out.groupedIds).toEqual(["i1"]);
  const items = mockLog.filter((q) => q.table === "items");
  expect(has(items[0], "eq", "context_id", "ca")).toBe(true);
  expect(has(items[1], "contains", "tags", ["idea"])).toBe(true);
  expect(has(items[0], "in", "status", ["active", "someday"])).toBe(true);
  expect(has(mockLog.find((q) => q.table === "item_group_members"), "is", "removed_at", null)).toBe(true);
});

test("apps are read fresh: id, name, icon, path", async () => {
  mockRespond = () => ({ data: [{ id: "sports", name: "Sports", icon: "Trophy", path: null }], error: null });
  expect(await api.getApps()).toEqual([{ id: "sports", name: "Sports", icon: "Trophy", path: null }]);
  expect(mockLog[0].table).toBe("apps");
});

test("open friction and the plan's settings", async () => {
  mockRespond = (t) => (t === "overwatch_plans"
    ? { data: { settings: { friction_trigger_count: 3 } }, error: null }
    : { data: [{ id: "f1" }], error: null });
  expect(await api.getOpenFriction()).toEqual({ entries: [{ id: "f1" }], settings: { friction_trigger_count: 3 } });
  expect(has(mockLog.find((q) => q.table === "process_friction"), "eq", "status", "open")).toBe(true);
});

test("needs you: Overwatch's untriaged, unarchived items, newest first", async () => {
  mockRespond = () => ({ data: [{ id: "i1" }], error: null });
  expect(await api.getNeedsYou()).toEqual([{ id: "i1" }]);
  const q = mockLog[0];
  expect(q.table).toBe("inbox");
  expect(has(q, "eq", "source_app", "overwatch")).toBe(true);
  expect(has(q, "is", "triaged_at", null)).toBe(true);
  expect(has(q, "eq", "archived", false)).toBe(true);
  expect(has(q, "order", "created_at", { ascending: false })).toBe(true);
});

test("dispatcher summary: scheduled reminders and step timers, waiting and held signals, notifications on the day", async () => {
  const counts = { reminders: 1, notification_steps: 2, claude_notifications: 3 };
  mockRespond = (t, ops) => {
    if (t !== "signals") return { count: counts[t], error: null };
    const state = ops.find((o) => o[0] === "eq" && o[1] === "state");
    return { count: state[2] === "queued" ? 4 : 5, error: null };
  };
  expect(await api.getDispatcherSummary("2026-11-05")).toEqual({ queued: 3, unprocessed: 4, held: 5, pops: 3 });
  const q = (t) => mockLog.find((l) => l.table === t);
  expect(has(q("claude_notifications"), "eq", "channel", "alfred_push")).toBe(true);
  expect(has(q("claude_notifications"), "eq", "local_date", "2026-11-05")).toBe(true);
  expect(has(q("notification_steps"), "not", "due_at", "is", null)).toBe(true);
  expect(has(q("reminders"), "select", "id", { count: "exact", head: true })).toBe(true);
  mockRespond = () => ({ count: null, error: { message: "boom" } });
  await expect(api.getDispatcherSummary("2026-11-05")).rejects.toThrow("Could not load the dispatcher's reminders");
});

test("dispatcher: signals, log, reminders, step timers, the plan's delivery rules and app names; reads only", async () => {
  mockRespond = (t) => {
    if (t === "overwatch_plans") return { data: { settings: { delivery: { window: { start: "05:00", end: "20:00" } } } }, error: null };
    if (t === "apps") return { data: [{ id: "dj", name: "DJ" }], error: null };
    if (t === "notification_steps") return { data: [{ id: "s1", execution_id: "e1" }, { id: "s2", execution_id: "e2" },
      { id: "s3", execution_id: "e3" }], error: null };
    if (t === "executions") return { data: [{ id: "e1", intent_id: "i1" }, { id: "e2", group_id: "g1" },
      { id: "e3", item_ids: ["it1"] }], error: null };
    if (t === "intents") return { data: [{ id: "i1", text: "Morning stretch" }], error: null };
    if (t === "item_groups") return { data: [{ id: "g1", name: "Dinner menu" }], error: null };
    if (t === "items") return { data: [{ id: "it1", name: "Micro Workout Rotation" }], error: null };
    return { data: [{ id: `${t}-1` }], error: null };
  };
  const out = await api.getDispatcher();
  expect(out.signals).toEqual([{ id: "signals-1" }]);
  expect(out.history.notifications).toEqual([{ id: "claude_notifications-1" }]);
  expect(out.history.next).toBeNull();
  expect(out.reminders).toEqual([{ id: "reminders-1" }]);
  expect(out.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  expect(out.executionNames).toEqual({ e1: "Morning stretch", e2: "Dinner menu", e3: "Micro Workout Rotation" });
  expect(out.delivery).toEqual({ window: { start: "05:00", end: "20:00" } });
  expect(out.appNames).toEqual({ dj: "DJ" });
  const q = (t) => mockLog.find((l) => l.table === t);
  expect(has(q("signals"), "in", "state", ["queued", "held"])).toBe(true);
  expect(has(q("claude_notifications"), "order", "created_at", { ascending: false })).toBe(true);
  expect(has(q("claude_notifications"), "order", "id", { ascending: false })).toBe(true);
  expect(has(q("claude_notifications"), "limit", 51)).toBe(true);
  expect(has(q("reminders"), "eq", "state", "scheduled")).toBe(true);
  expect(has(q("notification_steps"), "eq", "state", "scheduled")).toBe(true);
  expect(has(q("notification_steps"), "not", "due_at", "is", null)).toBe(true);
  const writes = ["insert", "update", "upsert", "delete"];
  expect(mockLog.some((l) => l.ops.some((o) => writes.includes(o[0])) || l.table.startsWith("rpc:"))).toBe(false);
});

test("dispatcher: no plan means no rules; an error is a plain sentence", async () => {
  mockRespond = (t) => (t === "overwatch_plans" ? { data: null, error: null } : { data: [], error: null });
  expect((await api.getDispatcher()).delivery).toBeNull();
  mockRespond = (t) => (t === "reminders" ? { data: null, error: { message: "boom" } } : { data: [], error: null });
  await expect(api.getDispatcher()).rejects.toThrow("Could not load the reminders. Please try again.");
});

// A fake History store: applies the cursor, order and limit the read asks for, as Postgres would.
const { timeKey } = require("./dispatcherModel");
function historyStore(tables) {
  return (t, ops) => {
    if (t === "signals" && ops.some((o) => o[0] === "in")) return { data: [], error: null };
    const cut = ops.find((o) => o[0] === "or")?.[1]
      .match(/^created_at\.lt\."(.+?)",and\(created_at\.eq\."(.+?)",id\.lt\.(.+)\)$/);
    const after = (r) => !cut || timeKey(r.created_at) < timeKey(cut[1])
      || (timeKey(r.created_at) === timeKey(cut[2]) && r.id < cut[3]);
    const rows = tables[t].filter(after).sort((a, b) =>
      timeKey(b.created_at).localeCompare(timeKey(a.created_at)) || (a.id < b.id ? 1 : -1));
    return { data: rows.slice(0, ops.find((o) => o[0] === "limit")[1]), error: null };
  };
}

test("history pages: 50 at a time, newest first, every card once, ties on the same time included", async () => {
  // 130 rows across both sources; groups of 6 share one instant, written with different fraction widths.
  const stamp = (i) => {
    const base = new Date(Date.UTC(2026, 10, 5, 12) - Math.floor(i / 6) * 1000).toISOString().slice(0, 19);
    return i % 2 ? `${base}.5+00:00` : `${base}.500000+00:00`;
  };
  const ids = Array.from({ length: 130 }, (_, i) => `${(i * 37 % 130).toString(16).padStart(4, "0")}-id`);
  const claude_notifications = ids.filter((_, i) => i % 3).map((id) => ({ id, channel: "alfred_push",
    created_at: stamp(ids.indexOf(id)) }));
  const signals = ids.filter((_, i) => !(i % 3)).map((id) => ({ id, state: "merged", created_at: stamp(ids.indexOf(id)) }));
  mockRespond = historyStore({ claude_notifications, signals });

  const pages = [];
  let page = await api.getDispatcherHistory();
  pages.push(page);
  while (page.next) { page = await api.getDispatcherHistory(page.next); pages.push(page); }
  expect(pages.map((p) => p.notifications.length + p.signals.length)).toEqual([50, 50, 30]);
  expect(pages.map((p) => !!p.next)).toEqual([true, true, false]);

  const shown = pages.flatMap((p) => [...p.notifications, ...p.signals]
    .sort((a, b) => timeKey(b.created_at).localeCompare(timeKey(a.created_at)) || (a.id < b.id ? 1 : -1)));
  expect(shown.map((r) => r.id)).toHaveLength(130);
  expect(new Set(shown.map((r) => r.id)).size).toBe(130);
  const all = [...claude_notifications, ...signals].sort((a, b) =>
    timeKey(b.created_at).localeCompare(timeKey(a.created_at)) || (a.id < b.id ? 1 : -1));
  expect(shown.map((r) => r.id)).toEqual(all.map((r) => r.id));

  const second = mockLog.filter((l) => l.ops.some((o) => o[0] === "or"))[0];
  const last = [...pages[0].notifications, ...pages[0].signals].sort((a, b) =>
    timeKey(a.created_at).localeCompare(timeKey(b.created_at)) || (a.id < b.id ? -1 : 1))[0];
  expect(pages[0].next).toEqual({ at: last.created_at, id: last.id });
  expect(has(second, "or", `created_at.lt."${last.created_at}",and(created_at.eq."${last.created_at}",id.lt.${last.id})`)).toBe(true);
});

test("history: a sent row's reason comes from its signal; an error is a plain sentence", async () => {
  mockRespond = (t, ops) => {
    if (t === "claude_notifications") return { data: [{ id: "n1", signal_id: "s1", created_at: "2026-11-05T16:00:00Z" }], error: null };
    if (ops.some((o) => o[0] === "in")) return { data: [{ id: "s1", reason: "high signals default to pop" }], error: null };
    return { data: [], error: null };
  };
  const out = await api.getDispatcherHistory();
  expect(out).toEqual({ notifications: [{ id: "n1", signal_id: "s1", created_at: "2026-11-05T16:00:00Z" }],
    signals: [{ id: "s1", reason: "high signals default to pop" }], next: null });
  mockRespond = (t) => (t === "signals" ? { data: null, error: { message: "boom" } } : { data: [], error: null });
  await expect(api.getDispatcherHistory()).rejects.toThrow("Could not load the merged signals. Please try again.");
});

test("first line of a capture", () => {
  expect(api.firstLine("\n  Overwatch: overdue — 2026-10-25 \nMissed")).toBe("Overwatch: overdue — 2026-10-25");
  expect(api.firstLine(null)).toBe("");
});
