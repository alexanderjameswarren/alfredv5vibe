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

test("first line of a capture", () => {
  expect(api.firstLine("\n  Overwatch: overdue — 2026-10-25 \nMissed")).toBe("Overwatch: overdue — 2026-10-25");
  expect(api.firstLine(null)).toBe("");
});
