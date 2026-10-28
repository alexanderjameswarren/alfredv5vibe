// Handler tests for overwatch-portfolio.ts.
// Run: node --experimental-strip-types --test supabase/functions/_shared/tools/overwatch-portfolio.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTool, settingsFor, withSettings } from "./test-platform.mjs";

const m = await loadTool("overwatch-portfolio.ts");
const SETTINGS = [settingsFor("portfolios", ["id", "user_id", "name", "context_ids", "position", "archived", "created_at", "updated_at"])];
const PF = "11111111-2222-3333-4444-555555555555";
const PLAN = "22222222-2222-3333-4444-555555555555";
const SLICE = "33333333-2222-3333-4444-555555555555";

const TABLES = {
  portfolios: [{ id: PF, name: "Alfred ecosystem", context_ids: ["c1"], position: 0, archived: false }],
  portfolio_plans: [{ id: PLAN, portfolio_id: PF, active: true, theory: "Bugs first.\nThen tools.", review_by: null }],
  portfolio_lanes: [{ id: "L1", name: "Main", position: 1, note: null }, { id: "L2", name: "SAM", position: 2, note: null }],
  portfolio_slices: [
    { id: "S1", plan_id: PLAN, lane_id: "L1", position: 1, group_id: "g1", phases: "Phase 1", status: "in_progress" },
    { id: "S2", plan_id: PLAN, lane_id: "L2", position: 1, group_id: "g2", phases: null, status: "planned" },
  ],
  item_groups: [{ id: "g1", name: "Alpha", status: "active" }, { id: "g2", name: "Beta", status: "someday" }],
  project_plans: [{ group_id: "g1", project_code: "alpha-x1" }],
};

function fakeDb(answer = (t) => ({ data: TABLES[t] ?? [], error: null, count: (TABLES[t] ?? []).length }), rpc) {
  const calls = [];
  const builder = (table) => {
    const b = new Proxy({}, {
      get: (_t, k) => {
        if (k === "then") return (res) => res(answer(table, calls));
        return (...a) => { calls.push([table, k, ...a]); return b; };
      },
    });
    return b;
  };
  return withSettings({ calls, from: (t) => builder(t), rpc: async (...a) => { calls.push(["rpc", ...a]); return rpc(...a); } }, SETTINGS);
}
const saw = (db, table, k, ...a) => db.calls.some(([t, kk, ...aa]) => t === table && kk === k && JSON.stringify(aa) === JSON.stringify(a));

test("get_portfolio_plan: by name, lanes in order with their slices, names and codes, versions", async () => {
  const db = fakeDb();
  const r = await m.getPortfolioPlanTool.handler({ portfolio: "Alfred ecosystem" }, { db });
  assert.ok(saw(db, "portfolios", "eq", "name", "Alfred ecosystem"));
  assert.ok(saw(db, "portfolio_plans", "eq", "active", true));
  const { plan, versions } = r.data;
  assert.deepEqual(plan.lanes.map((l) => l.name), ["Main", "SAM"]);
  assert.deepEqual(plan.lanes[0].slices.map((s) => [s.id, s.group_name, s.project_code]), [["S1", "Alpha", "alpha-x1"]]);
  assert.equal(plan.lanes[1].slices[0].project_code, null);
  assert.equal(plan.lanes[0].slices[0].lane_id, undefined);
  assert.equal(versions.length, 1);
});

test("get_portfolio_plan: no plan yet, a named version, and refusals", async () => {
  const empty = fakeDb((t) => ({ data: t === "portfolios" ? TABLES.portfolios : [], error: null }));
  const r = await m.getPortfolioPlanTool.handler({ portfolio_id: PF }, { db: empty });
  assert.equal(r.data.plan, null);
  assert.match(r.meta.notes[0], /No plan for Alfred ecosystem yet/);
  const db = fakeDb();
  await m.getPortfolioPlanTool.handler({ plan_id: PLAN }, { db });
  assert.ok(saw(db, "portfolio_plans", "eq", "id", PLAN));
  await assert.rejects(m.getPortfolioPlanTool.handler({}, { db: fakeDb() }), /portfolio_id or portfolio/);
  await assert.rejects(m.getPortfolioPlanTool.handler({ portfolio_id: "x" }, { db: fakeDb() }), /must be an id/);
  const none = fakeDb(() => ({ data: [], error: null }));
  await assert.rejects(m.getPortfolioPlanTool.handler({ portfolio: "Nope" }, { db: none }), /no portfolio "Nope"/);
});

test("get_portfolios: active plan in brief, unarchived by default", async () => {
  const db = fakeDb();
  const r = await m.getPortfoliosTool.handler({}, { db });
  assert.ok(saw(db, "portfolios", "eq", "archived", false));
  const p = r.data[0];
  assert.equal(p.active_plan.theory_first_line, "Bugs first.");
  assert.deepEqual(p.active_plan.slices, { planned: 1, in_progress: 1, done: 0, paused: 0 });
  const all = fakeDb();
  await m.getPortfoliosTool.handler({ archived: "include" }, { db: all });
  assert.ok(!saw(all, "portfolios", "eq", "archived", false));
});

test("upsert_portfolio: create by name, change by id, refusals", async () => {
  let db = fakeDb(() => ({ data: TABLES.portfolios[0], error: null }));
  await m.upsertPortfolioTool.handler({ name: " Client work ", context_ids: ["a", "a", "b"] }, { db });
  assert.ok(saw(db, "portfolios", "upsert", { name: "Client work", context_ids: ["a", "b"] }, { onConflict: "user_id,name" }));
  db = fakeDb(() => ({ data: TABLES.portfolios[0], error: null }));
  await m.upsertPortfolioTool.handler({ id: PF, name: "Alfred", archived: true }, { db });
  assert.ok(saw(db, "portfolios", "update", { name: "Alfred", archived: true }));
  assert.ok(saw(db, "portfolios", "eq", "id", PF));
  await assert.rejects(m.upsertPortfolioTool.handler({ id: PF }, { db: fakeDb() }), /nothing to change/);
  await assert.rejects(m.upsertPortfolioTool.handler({ position: 1 }, { db: fakeDb() }), /name is required/);
  await assert.rejects(m.upsertPortfolioTool.handler({ name: "x", context_ids: "c1" }, { db: fakeDb() }), /context_ids must be a list/);
  const dup = fakeDb(() => ({ data: null, error: { code: "23505", message: "dup" } }));
  await assert.rejects(m.upsertPortfolioTool.handler({ id: PF, name: "Client work" }, { db: dup }), /already a portfolio named/);
});

const LANES = [{ name: "Main", position: 1, slices: [{ position: 1, group_id: "g1", status: "in_progress" }] }];

test("create_portfolio_plan: input checks before any call", () => {
  const T = "create_portfolio_plan";
  const ok = m.portfolioPlanInput(T, { portfolio_id: PF, theory: "t", reason: "r", lanes: LANES });
  assert.equal(ok.writtenBy, "alex");
  assert.deepEqual(ok.lanes[0].slices[0], { position: 1, group_id: "g1", phases: null, why: null, status: "in_progress", paused_reason: null });
  const bad = (lanes) => () => m.portfolioPlanInput(T, { portfolio_id: PF, theory: "t", reason: "r", lanes });
  assert.throws(bad([]), /lanes is required/);
  assert.throws(bad([{ name: "Main", position: 0 }]), /position must be a whole number/);
  assert.throws(bad([{ name: "Main", position: 1, slices: [{ position: 1, group_id: "g1", status: "paused" }] }]), /needs paused_reason/);
  assert.throws(bad([{ name: "Main", position: 1, slices: [{ position: 1, group_id: "g1", status: "stuck" }] }]), /status must be one of/);
  assert.throws(() => m.portfolioPlanInput(T, { portfolio_id: PF, reason: "r", lanes: LANES }), /theory is required/);
  assert.throws(() => m.portfolioPlanInput(T, { portfolio_id: PF, theory: "t", reason: "r", review_by: "soon", lanes: LANES }), /review_by/);
});

test("create_portfolio_plan: calls the function, returns the version with its lanes", async () => {
  const db = fakeDb(undefined, () => ({ data: { ...TABLES.portfolio_plans[0], lanes: 1, slices: 1 }, error: null }));
  const r = await m.createPortfolioPlanTool.handler({ portfolio_id: PF, theory: "t", reason: "r", written_by: "overwatch", lanes: LANES }, { db });
  const call = db.calls.find(([t]) => t === "rpc");
  assert.equal(call[1], "create_portfolio_plan");
  assert.equal(call[2].p_written_by, "overwatch");
  assert.equal(call[2].p_lanes[0].slices[0].group_id, "g1");
  assert.equal(r.id, PLAN);
  assert.equal(r.lanes[0].slices[0].group_name, "Alpha");
});

test("create_portfolio_plan: propose names what changes", async () => {
  const r = await m.createPortfolioPlanTool.propose({
    portfolio_id: PF, theory: "Bugs first.\nThen tools.", reason: "B is next",
    lanes: [{ name: "Main", position: 1, slices: [{ position: 1, group_id: "g2" }, { position: 2, group_id: "g1", phases: "Phase 1" }] },
      { name: "Client", position: 2, slices: [{ position: 1, group_id: "g3" }] }],
  }, { db: fakeDb() });
  assert.match(r.text, /NEW PLAN VERSION for Alfred ecosystem/);
  assert.match(r.text, /Theory: unchanged/);
  assert.match(r.text, /Lane renamed: SAM -> Client/);
  assert.match(r.text, /Slice moved between lanes: Beta, SAM -> Main/);
  assert.match(r.text, /Slice moved within Main: Alpha \(Phase 1\), place 1 -> 2/);
  assert.match(r.text, /Slice added: g3 in Client/);
});

test("describePlanChange: a first plan shows the whole theory and every slice's phases and status", () => {
  const names = new Map([["g1", "Alpha"], ["g2", "Beta"]]);
  const lines = m.describePlanChange(null, { theory: "Bugs first.\nThen tools.", lanes: [
    { name: "Main", position: 1, slices: [{ group_id: "g1", phases: "Phase 1", status: "in_progress" }, { group_id: "g2", phases: null }] },
    { name: "Side", position: 2, slices: [{ group_id: "g1", phases: "Phase 2", status: "paused", paused_reason: "waiting on Phase 1" }] },
    { name: "Empty", position: 3, slices: [] }] }, names);
  assert.deepEqual(lines, ["This becomes the portfolio's first plan.", "Theory:\nBugs first.\nThen tools.",
    "Lane Main:", "  1. Alpha (Phase 1): in_progress", "  2. Beta: planned",
    "Lane Side:", "  1. Alpha (Phase 2): paused (waiting on Phase 1)", "Lane Empty:", "  no slices"]);
});

test("describePlanChange: a renamed lane's slices have not moved; status changes are listed", () => {
  const names = new Map([["g1", "sam_xml_import-g4w"], ["g2", "Beta"]]);
  const lines = m.describePlanChange(
    { theory: "a", lanes: [
      { name: "Main", position: 1, slices: [{ group_id: "g2", phases: null, status: "in_progress" }] },
      { name: "Side", position: 2, slices: [{ group_id: "g1", phases: "Phase 2", status: "paused", paused_reason: "waiting on Phase 1" }] }] },
    { theory: "a", lanes: [
      { name: "Main", position: 1, slices: [{ group_id: "g2", phases: null, status: "done" }] },
      { name: "SAM", position: 2, slices: [{ group_id: "g1", phases: "Phase 2", status: "planned" }] }] },
    names);
  assert.deepEqual(lines, ["Theory: unchanged.", "Lane renamed: Side -> SAM.",
    "Status: Beta: in_progress -> done.",
    "Status: sam_xml_import-g4w (Phase 2): paused (waiting on Phase 1) -> planned."]);
});

test("describePlanChange: a slice moved out of a renamed lane names the old lane", () => {
  const lines = m.describePlanChange(
    { theory: "a", lanes: [{ name: "Main", position: 1, slices: [] },
      { name: "Side", position: 2, slices: [{ group_id: "g1", phases: null }, { group_id: "g2", phases: null }] }] },
    { theory: "a", lanes: [{ name: "Main", position: 1, slices: [{ group_id: "g1", phases: null }] },
      { name: "SAM", position: 2, slices: [] }] },
    new Map());
  assert.ok(lines.includes("Slice moved between lanes: g1, Side -> Main."));
  assert.ok(lines.includes("Slice removed: g2 from Side."));
});

test("describePlanChange: lanes added and removed, slices removed, theory text", () => {
  const names = new Map([["g1", "Alpha"]]);
  const lines = m.describePlanChange(
    { theory: "a", lanes: [{ name: "Main", position: 1, slices: [{ group_id: "g1", phases: null }] }, { name: "Old", position: 2, slices: [] }] },
    { theory: "b", lanes: [{ name: "Main", position: 1, slices: [] }, { name: "Old", position: 2, slices: [] }, { name: "New", position: 3, slices: [] }] },
    names);
  assert.ok(lines.includes("Theory, new text:\nb"));
  assert.ok(lines.includes("Lane added: New."));
  assert.ok(lines.includes("Slice removed: Alpha from Main."));
  assert.ok(!lines.some((l) => l.startsWith("Lane removed")));
});

test("update_portfolio_slice: status only, the lane's one in progress, refusals", async () => {
  const db = fakeDb(() => ({ data: { id: SLICE, status: "paused" }, error: null }));
  await m.updatePortfolioSliceTool.handler({ id: SLICE, status: "paused", paused_reason: "client first" }, { db });
  assert.ok(saw(db, "portfolio_slices", "update", { status: "paused", paused_reason: "client first" }));
  const db2 = fakeDb(() => ({ data: { id: SLICE }, error: null }));
  await m.updatePortfolioSliceTool.handler({ id: SLICE, status: "done" }, { db: db2 });
  assert.ok(saw(db2, "portfolio_slices", "update", { status: "done", paused_reason: null }));
  const busy = fakeDb(() => ({ data: null, error: { code: "23505", message: "portfolio_slices_one_in_progress" } }));
  await assert.rejects(m.updatePortfolioSliceTool.handler({ id: SLICE, status: "in_progress" }, { db: busy }), /already has a slice in progress/);
  await assert.rejects(m.updatePortfolioSliceTool.handler({ id: SLICE, status: "paused" }, { db: fakeDb() }), /needs paused_reason/);
  await assert.rejects(m.updatePortfolioSliceTool.handler({ id: SLICE, status: "done", paused_reason: "x" }, { db: fakeDb() }), /only for status paused/);
  const gone = fakeDb(() => ({ data: null, error: null }));
  await assert.rejects(m.updatePortfolioSliceTool.handler({ id: SLICE, status: "done" }, { db: gone }), /no slice/);
});
