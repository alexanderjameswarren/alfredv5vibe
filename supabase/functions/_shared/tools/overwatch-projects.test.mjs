// Handler tests for overwatch-projects.ts.
// Run: node --experimental-strip-types --test supabase/functions/_shared/tools/overwatch-projects.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTool, settingsFor, withSettings } from "./test-platform.mjs";

const m = await loadTool("overwatch-projects.ts");
const LINK_SETTINGS = settingsFor("project_links", ["id", "user_id", "from_group_id", "to_group_id", "kind", "note",
  "created_by", "created_at"]);

function fakeDb(answer = () => ({ data: [], error: null, count: 0 }), rpcAnswer = () => ({ data: [], error: null })) {
  const calls = [];
  const builder = (table) => {
    const b = new Proxy({}, {
      get: (_t, k) => {
        if (k === "then") return (res) => res(answer(table, calls));
        if (k === "maybeSingle") return () => Promise.resolve(answer(table, calls));
        return (...a) => { calls.push([table, k, ...a]); return b; };
      },
    });
    return b;
  };
  return withSettings({
    calls,
    from: (t) => builder(t),
    rpc: (name, params) => { calls.push(["rpc", name, params]); return Promise.resolve(rpcAnswer(name, params)); },
  }, [LINK_SETTINGS]);
}

test("get_project_plans asks for active Projects by default, and clamps with a note", async () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ group_id: `g${i}`, steps_used: i }));
  const db = fakeDb(undefined, () => ({ data: rows, error: null }));
  const out = await m.getProjectPlansTool.handler({}, { db });
  assert.deepEqual(db.calls[0], ["rpc", "overwatch_project_progress", { p_status: ["active"], p_group_ids: null }]);
  assert.equal(out.data.length, 20);
  assert.equal(out.meta.total, 25);
  assert.equal(out.meta.truncated, true);
  assert.match(out.meta.notes[0], /other 5/);
});

const HISTORY = [
  { group_id: "g1", kind: "initial", estimate: 40, steps_added: null },
  { group_id: "g1", kind: "scope_increase", estimate: 44, steps_added: 4 },
  { group_id: "g1", kind: "re_estimate", estimate: 50, steps_added: null },
  { group_id: "g1", kind: "scope_decrease", estimate: 48, steps_added: -2 },
];

test("estimateSummary: original, original plus scope changes, final", () => {
  assert.deepEqual(m.estimateSummary(HISTORY), { original_estimate: 40, scope_adjusted_estimate: 42, final_steps: null });
  assert.equal(m.estimateSummary([...HISTORY, { group_id: "g1", kind: "final", estimate: 47, steps_added: null }]).final_steps, 47);
  assert.deepEqual(m.estimateSummary([]), { original_estimate: null, scope_adjusted_estimate: null, final_steps: null });
});

test("get_project_plans adds original and scope-adjusted estimates to each row", async () => {
  const db = fakeDb((t) => ({ data: t === "project_estimates" ? HISTORY : [], error: null }),
    () => ({ data: [{ group_id: "g1", effort_estimate: 48 }, { group_id: "g2", effort_estimate: null }], error: null }));
  const out = await m.getProjectPlansTool.handler({}, { db });
  assert.equal(out.data[0].original_estimate, 40);
  assert.equal(out.data[0].scope_adjusted_estimate, 42);
  assert.equal(out.data[1].original_estimate, null);
  assert.ok(db.calls.some(([t, k, a, b]) => t === "project_estimates" && k === "in" && a === "group_id" && b.join() === "g1,g2"));
});

test("record_project_estimate passes the rpc params and checks each kind's inputs", async () => {
  const db = fakeDb(undefined, () => ({ data: { kind: "scope_increase", estimate: 48 }, error: null }));
  await m.recordProjectEstimateTool.handler({ group_id: "g1", kind: "scope_increase", reason: " step 22 ", steps_added: 4, at_step: 22 }, { db });
  assert.deepEqual(db.calls[0], ["rpc", "record_project_estimate", { p_group_id: "g1", p_kind: "scope_increase",
    p_reason: "step 22", p_estimate: null, p_cli_estimate: null, p_steps_added: 4, p_at_step: 22 }]);

  const bad = (a, re) => assert.rejects(() => m.recordProjectEstimateTool.handler({ group_id: "g1", reason: "r", ...a }, { db }), re);
  await bad({ kind: "initial" }, /needs cli_estimate/);
  await bad({ kind: "scope_increase", steps_added: -1 }, /greater than 0/);
  await bad({ kind: "scope_decrease", steps_added: 2 }, /less than 0/);
  await bad({ kind: "re_estimate", cli_estimate: 30, steps_added: 2 }, /only for scope_increase/);
  await bad({ kind: "initial", cli_estimate: 2.5 }, /whole number/);
  await bad({ kind: "guess" }, /kind must be one of/);
  await assert.rejects(() => m.recordProjectEstimateTool.handler({ group_id: "g1", kind: "final" }, { db }), /reason is required/);

  const dup = fakeDb(undefined, () => ({ data: null, error: { code: "23505", message: "duplicate key" } }));
  await assert.rejects(() => m.recordProjectEstimateTool.handler({ group_id: "g1", kind: "initial", reason: "r", cli_estimate: 30 }, { db: dup }),
    /already has its initial estimate/);
});

test("get_project_estimates returns each project's summary and history", async () => {
  const db = fakeDb((t) => ({ data: t === "project_estimates" ? HISTORY : [{ group_id: "g1", effort_estimate: 48 }], error: null }));
  const [g1, g2] = await m.getProjectEstimatesTool.handler({ group_ids: ["g1", "g2", "g1"] }, { db });
  assert.equal(g1.current_estimate, 48);
  assert.equal(g1.scope_adjusted_estimate, 42);
  assert.equal(g1.history.length, 4);
  assert.deepEqual([g2.group_id, g2.current_estimate, g2.history.length], ["g2", null, 0]);
  await assert.rejects(() => m.getProjectEstimatesTool.handler({}, { db }), /group_ids is required/);
  await assert.rejects(() => m.getProjectEstimatesTool.handler({ group_ids: Array.from({ length: 21 }, (_, i) => `g${i}`) }, { db }),
    /at most 20/);
});

test("get_project_plans: status all, a list, group ids; bad values refused", async () => {
  const db = fakeDb();
  await m.getProjectPlansTool.handler({ status: "all", group_ids: ["g1"] }, { db });
  assert.deepEqual(db.calls[0][2], { p_status: null, p_group_ids: ["g1"] });
  await m.getProjectPlansTool.handler({ status: ["someday", "background"] }, { db });
  assert.deepEqual(db.calls[1][2].p_status, ["someday", "background"]);
  await assert.rejects(() => m.getProjectPlansTool.handler({ status: "parked" }, { db }), /status must be one of/);
  await assert.rejects(() => m.getProjectPlansTool.handler({ limit: 0 }, { db }), /limit must be/);
});

test("planPatch keeps only what was passed, null clears, and checks each field", () => {
  assert.deepEqual(m.planPatch("t", { where_now: " Step 13 ", next_step: null }), { where_now: "Step 13", next_step: null });
  assert.deepEqual(m.planPatch("t", { waiting_on_kind: "project", waiting_on_group_id: "g2" }),
    { waiting_on_kind: "project", waiting_on_group_id: "g2" });
  assert.throws(() => m.planPatch("t", {}), /nothing to change/);
  assert.throws(() => m.planPatch("t", { project_code: "Overwatch Q4N" }), /project_code must match/);
  assert.throws(() => m.planPatch("t", { effort_estimate: 40 }), /nothing to change/);
  assert.throws(() => m.planPatch("t", { target_date: "next week" }), /YYYY-MM-DD/);
  assert.throws(() => m.planPatch("t", { waiting_on_kind: "bob" }), /waiting_on_kind must be one of/);
  assert.throws(() => m.planPatch("t", { hurdle_kind: "fear" }), /hurdle_kind must be one of/);
  assert.throws(() => m.planPatch("t", { where_now: "  " }), /one line of text/);
});

test("update_project_plan upserts on group_id and reports the guard's refusal", async () => {
  const db = fakeDb(() => ({ data: { group_id: "g1", where_now: "x" }, error: null }));
  const out = await m.updateProjectPlanTool.handler({ group_id: "g1", where_now: "x" }, { db });
  assert.equal(out.group_id, "g1");
  const up = db.calls.find(([, k]) => k === "upsert");
  assert.deepEqual(up[2], { group_id: "g1", where_now: "x" });
  assert.deepEqual(up[3], { onConflict: "group_id" });

  const refused = fakeDb(() => ({ data: null, error: { code: "23514", message: "project_plans refused: group m1 is not one of your Project groups" } }));
  await assert.rejects(() => m.updateProjectPlanTool.handler({ group_id: "m1", where_now: "x" }, { db: refused }), /not one of your Project groups/);
  await assert.rejects(() => m.updateProjectPlanTool.handler({ where_now: "x" }, { db }), /group_id is required/);
});

// --- every code a Project has had (switchboard_prod-w3k spec 9) ---

test("get_project_plans returns each Project's codes, oldest first", async () => {
  const CODES = [
    { group_id: "g1", project_code: "switchboard2-h8r", source: "plan" },
    { group_id: "g1", project_code: "switchboard_prodrepo-w3k", source: "side" },
    { group_id: "g2", project_code: "other-a1", source: "plan" },
  ];
  const db = fakeDb((t) => ({ data: t === "project_codes" ? CODES : [], error: null }),
    () => ({ data: [{ group_id: "g1" }, { group_id: "g3" }], error: null }));
  const out = await m.getProjectPlansTool.handler({}, { db });
  assert.deepEqual(out.data[0].codes, [
    { project_code: "switchboard2-h8r", source: "plan" }, { project_code: "switchboard_prodrepo-w3k", source: "side" }]);
  assert.deepEqual(out.data[1].codes, []);
  assert.ok(db.calls.some(([t, k, a, b]) => t === "project_codes" && k === "in" && a === "group_id" && b.join() === "g1,g3"));
});

test("codesToAdd: a list of 1 to 20 codes, duplicates dropped; anything else refused", () => {
  assert.deepEqual(m.codesToAdd("t", undefined), []);
  assert.deepEqual(m.codesToAdd("t", ["a-b1", "a-b1", "c_d-e2"]), ["a-b1", "c_d-e2"]);
  assert.throws(() => m.codesToAdd("t", []), /1 to 20 project codes/);
  assert.throws(() => m.codesToAdd("t", "a-b1"), /1 to 20 project codes/);
  assert.throws(() => m.codesToAdd("t", ["Not A Code"]), /1 to 20 project codes/);
  assert.throws(() => m.codesToAdd("t", Array.from({ length: 21 }, (_, i) => `c${i}`)), /1 to 20 project codes/);
});

test("update_project_plan add_project_codes alone adds side codes and leaves the plan alone", async () => {
  const db = fakeDb((t) => ({ data: t === "project_codes" ? [{ group_id: "g1", project_code: "old-a1", source: "plan" }] : null, error: null }));
  const out = await m.updateProjectPlanTool.handler({ group_id: "g1", add_project_codes: ["repo-w3k", "old-a1"] }, { db });
  assert.equal(db.calls.some(([t, k]) => t === "project_plans" && k === "upsert"), false);
  const ins = db.calls.find(([t, k]) => t === "project_codes" && k === "insert");
  assert.deepEqual(ins[2], [{ group_id: "g1", project_code: "repo-w3k", source: "side" }]);
  assert.deepEqual(out, { group_id: "g1", project_codes_added: ["repo-w3k"], project_codes_already_held: ["old-a1"] });
});

test("update_project_plan with plan fields and codes changes both", async () => {
  const db = fakeDb((t) => ({ data: t === "project_plans" ? { group_id: "g1", where_now: "x" } : [], error: null }));
  const out = await m.updateProjectPlanTool.handler({ group_id: "g1", where_now: "x", add_project_codes: ["repo-w3k"] }, { db });
  assert.ok(db.calls.some(([t, k]) => t === "project_plans" && k === "upsert"));
  assert.equal(out.where_now, "x");
  assert.deepEqual(out.project_codes_added, ["repo-w3k"]);
});

test("update_project_plan refuses a code another Project holds, naming it, and writes nothing", async () => {
  const db = fakeDb((t) => ({
    data: t === "project_codes" ? [{ group_id: "g9", project_code: "taken-a1", source: "plan" }]
      : t === "item_groups" ? [{ id: "g9", name: "Other Project" }] : null,
    error: null,
  }));
  await assert.rejects(() => m.updateProjectPlanTool.handler({ group_id: "g1", where_now: "x", add_project_codes: ["taken-a1"] }, { db }),
    /taken-a1 belongs to Other Project \(g9\).*Nothing was changed/);
  assert.equal(db.calls.some(([, k]) => k === "upsert" || k === "insert"), false);
});

test("get_project_links filters by kind and by either end", async () => {
  const db = fakeDb();
  await m.getProjectLinksTool.handler({ kind: "no_parallel", group_id: "g1" }, { db });
  assert.ok(db.calls.some(([, k, a, b]) => k === "eq" && a === "kind" && b === "no_parallel"));
  assert.ok(db.calls.some(([, k, a]) => k === "or" && a === "from_group_id.eq.g1,to_group_id.eq.g1"));
  await assert.rejects(() => m.getProjectLinksTool.handler({ group_id: "g1),(x" }, { db }), /not a group id/);
  await assert.rejects(() => m.getProjectLinksTool.handler({ kind: "blocks" }, { db }), /kind must be one of/);
});

test("create_project_link inserts, defaults created_by to alex, and names a duplicate", async () => {
  const db = fakeDb(() => ({ data: { id: "l1" }, error: null }));
  await m.createProjectLinkTool.handler({ from_group_id: "g1", to_group_id: "g2", kind: "depends_on", note: " why " }, { db });
  const ins = db.calls.find(([, k]) => k === "insert")[2];
  assert.deepEqual(ins, { from_group_id: "g1", to_group_id: "g2", kind: "depends_on", note: "why", created_by: "alex" });

  const dup = fakeDb(() => ({ data: null, error: { code: "23505", message: "duplicate key" } }));
  await assert.rejects(() => m.createProjectLinkTool.handler({ from_group_id: "g1", to_group_id: "g2", kind: "depends_on" }, { db: dup }),
    /already exists/);
  await assert.rejects(() => m.createProjectLinkTool.handler({ from_group_id: "g1", to_group_id: "g1", kind: "depends_on" }, { db }),
    /cannot link to itself/);
  await assert.rejects(() => m.createProjectLinkTool.handler({ from_group_id: "g1", to_group_id: "g2", kind: "depends_on", created_by: "bob" }, { db }),
    /created_by must be one of/);
});
