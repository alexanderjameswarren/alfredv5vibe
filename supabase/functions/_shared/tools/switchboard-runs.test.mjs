// Handler tests for switchboard-runs.ts (sb3_pages-h6v B3).
//
// Run:
//   node --experimental-strip-types --test supabase/functions/_shared/tools/switchboard-runs.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { cpSync, mkdtempSync } from "node:fs";

// As test-platform.mjs's loadTool, plus one thing: the copy lives in a temp folder, so its import of the shared
// runContract.js is pointed back at the real file (the one copy of the rules the pages use).
const SHARED = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT = resolve(SHARED, "../../../src/switchboard/runs/runContract.js");
async function load() {
  const dir = mkdtempSync(join(tmpdir(), "mcp-runs-"));
  cpSync(SHARED, join(dir, "_shared"), { recursive: true, filter: (s) => !s.endsWith(".test.mjs") });
  const p = join(dir, "_shared", "platform.ts");
  const src = readFileSync(p, "utf-8").split("\n").filter((l) => !/^import .*"jsr:/.test(l)).join("\n");
  writeFileSync(p, src.replace("export function defineTool<", "function realDefineTool<") + "\nexport const defineTool = (o) => o;\n");
  const t = join(dir, "_shared", "tools", "switchboard-runs.ts");
  const tool = readFileSync(t, "utf-8");
  assert.ok(tool.includes('"../../../../src/switchboard/runs/runContract.js"'), "the tool imports the shared runContract.js");
  writeFileSync(t, tool.replace('"../../../../src/switchboard/runs/runContract.js"', JSON.stringify(pathToFileURL(CONTRACT).href)));
  return await import(pathToFileURL(t).href);
}
const m = await load();

const REQ_ID = "26f0cc8f-6ef0-4f14-81da-a915ad086e5b";
const PRE_ID = "11111111-2222-4333-8444-555555555555";
const REVIEW_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** rpc answers `reply`; a read of switchboard_run_requests answers `row` (the corrected request's page and base page). */
function fakeDb(reply = { data: { ok: true }, error: null }, row = { page: "dataop", base_page: "dataop" }) {
  const calls = [];
  return {
    calls,
    rpc(name, params) { calls.push([name, params]); return Promise.resolve(reply); },
    from(table) {
      const b = { select: () => b, eq: () => b, maybeSingle: () => { calls.push(["read", table]); return Promise.resolve({ data: row, error: null }); } };
      return b;
    },
  };
}
const rpcs = (db) => db.calls.filter((c) => c[0] !== "read");
const run = (tool, args, db = fakeDb()) => tool.handler(args, { db }).then((out) => ({ out, db }));
const refusal = async (tool, args, pattern) => {
  const db = fakeDb();
  await assert.rejects(tool.handler(args, { db }), pattern);
  return db;
};

const DATAOP = () => ({
  page: "dataop", project_code: "demo-x1y", headline: "UPDATES 45 GIFTS", client: "demo",
  orgs: [{ alias: "demo-prod", org_type: "production", role: "target" }, { alias: "demo-sb", org_type: "sandbox", role: "rehearsal" }],
  problem: { label: "P1", sentence: "45 gifts point at the wrong campaign." }, side_effects: "None.",
  operation: { kind: "update", object: "Gift__c", field: "Campaign__c", value: "Spring" },
  selected_by: { kind: "ids", text: "45 listed ids" }, counts: { expected: 45, total: 45 },
  // s28 (O17): an Id list's Ids are the query labelled "records".
  details: { queries: [{ label: "records", soql: "SELECT Id FROM Gift__c WHERE Id IN ('a0B000000000001AAA')" }] },
  undo: { level: "standard", mechanics: "Sets each campaign back." },
  steps: [{ code: "still_match_backup" }, { code: "login_can_write" }, { code: "automation_unchanged" }, { code: "type_count" },
    { code: "write" }, { code: "read_back" }, { code: "save_results" }],
});

const REVIEW = () => ({
  repo: "demo", commit: "abc1234", base_commit: "0000000",
  files: [{ path: "classes/A.cls", status: "modified", old_text: "a\nb\n", new_text: "a\nc\n", problem_labels: ["P1"] }],
  findings: { fixed_by_cli: [], for_you: [{ id: "F1", text: "Check this." }] },
  notes: [{ file: "classes/A.cls", start_line: 2, end_line: 2, problem_label: "P1", text: "Changed b to c." }],
});

test("tiers and declared tables", () => {
  assert.equal(m.queueSwitchboardRunRequestTool.tier, 2);
  assert.equal(m.correctSwitchboardRunRequestTool.tier, 2);
  assert.equal(m.issueSwitchboardRunLinkTool.tier, 2);
  assert.equal(m.recordSwitchboardCodeReviewTool.tier, 2);
  assert.ok(m.queueSwitchboardRunRequestTool.tables.writes.includes("switchboard_run_samples"));
});

test("queue: a good request reaches switchboard_queue_run_request unchanged, pre_check_request_id included", async () => {
  const r = { ...DATAOP(), pre_check_request_id: PRE_ID.toUpperCase() };
  const { out, db } = await run(m.queueSwitchboardRunRequestTool, { request: r });
  assert.deepEqual(out, { ok: true });
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0][0], "switchboard_queue_run_request");
  assert.equal(db.calls[0][1].p_request.pre_check_request_id, PRE_ID);
  assert.ok(!("evidence" in db.calls[0][1].p_request) && !("sample" in db.calls[0][1].p_request));
});

test("queue: runContract's rules refuse first, naming each problem; the database is never called", async () => {
  const r = DATAOP();
  delete r.side_effects;
  r.problem = { label: "P1" };
  const db = await refusal(m.queueSwitchboardRunRequestTool, { request: r }, /refused before the database \(2 problems\): .*Add the problem.*Add side_effects/);
  assert.equal(db.calls.length, 0);
  const bad = { ...DATAOP(), steps: [{ code: "count_listed" }] };
  await refusal(m.queueSwitchboardRunRequestTool, { request: bad }, /count_listed doesn't belong on a dataop page/);
});

test("queue (s28): pretend and allows pass through to the database unchanged; undo_of.request_id is lower-cased", async () => {
  const allows = {
    mode: "frozen", kinds: [{ kind: "edited gift", limit: 1, reason: "r" }],
    integrations: { allowed: false, reason: "paused" }, failure_tolerance: { rows: 0, reason: "all or none" },
  };
  const r = { ...DATAOP(), simulation: true, pretend: { scenario: "count_ok" }, allows };
  const { db } = await run(m.queueSwitchboardRunRequestTool, { request: r });
  assert.deepEqual(db.calls[0][1].p_request.pretend, { scenario: "count_ok" });
  assert.deepEqual(db.calls[0][1].p_request.allows, allows);
  const undo = { ...DATAOP(), page: "undo", counts: { expected: 45, undo_up_to: 45 }, steps: [{ code: "skip_edited" }, { code: "write" }],
    undo_of: { run_tag: "demo-x1y-s1-ab12", request_id: PRE_ID.toUpperCase() } };
  const u = await run(m.queueSwitchboardRunRequestTool, { request: undo });
  assert.equal(u.db.calls[0][1].p_request.undo_of.request_id, PRE_ID);
});

test("queue (s28): runContract refuses a bad pretend, a bad allows, an Id list with no records query, and request_id off an undo", async () => {
  await refusal(m.queueSwitchboardRunRequestTool, { request: { ...DATAOP(), simulation: true, pretend: true } }, /Fix pretend: \{"scenario"/);
  await refusal(m.queueSwitchboardRunRequestTool, { request: { ...DATAOP(), pretend: { scenario: "ok" } } }, /Fix pretend: it needs simulation true/);
  await refusal(m.queueSwitchboardRunRequestTool, { request: { ...DATAOP(), allows: { mode: "still" } } }, /Fix allows.mode/);
  await refusal(m.queueSwitchboardRunRequestTool, { request: { ...DATAOP(), details: {} } }, /exactly one entry labelled "records"/);
  await refusal(m.queueSwitchboardRunRequestTool, { request: { ...DATAOP(), undo_of: { run_tag: "x", request_id: PRE_ID } } }, /only an undo names/);
});

test("queue: the chat never supplies evidence or a sample; pre_check_request_id only on a data operation, a uuid", async () => {
  await refusal(m.queueSwitchboardRunRequestTool, { request: { ...DATAOP(), evidence: [] } }, /leave evidence out/);
  await refusal(m.queueSwitchboardRunRequestTool, { request: { ...DATAOP(), sample: {} } }, /leave the sample out/);
  await refusal(m.queueSwitchboardRunRequestTool, { request: { ...DATAOP(), page: "precheck", pre_check_request_id: PRE_ID } }, /only a data operation/);
  await refusal(m.queueSwitchboardRunRequestTool, { request: { ...DATAOP(), pre_check_request_id: "nope" } }, /pre_check_request_id` must be a UUID/);
  await refusal(m.queueSwitchboardRunRequestTool, { request: { ...DATAOP(), page: "correction" } }, /correct_switchboard_run_request/);
  await refusal(m.queueSwitchboardRunRequestTool, {}, /`request` must be the run request object/);
});

test("the database's refusal comes back word for word; an operational error is not called a refusal", async () => {
  const message = "switchboard_queue_run_request: the data operation differs from what its pre-check checked: the field. Queue it as the pre-check checked it, or run a new pre-check. No link was issued.";
  for (const code of ["23514", "55000", "P0002", "28000", "22023", "22P02"]) {
    const db = fakeDb({ data: null, error: { code, message } });
    await assert.rejects(m.queueSwitchboardRunRequestTool.handler({ request: DATAOP() }, { db }),
      (e) => e.message === `queue_switchboard_run_request: refused: ${message}`);
  }
  const db = fakeDb({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
  await assert.rejects(m.queueSwitchboardRunRequestTool.handler({ request: DATAOP() }, { db }), (e) => !/refused/.test(e.message) && /57014/.test(e.message));
});

test("correct: the page's correction rules run first (steps within what the edit reruns), then the database", async () => {
  const changed = { reason: "Wrong value.", items: [{ what: "Value", old: "Spring", new: "Summer" }] };
  const r = { ...DATAOP(), operation: { ...DATAOP().operation, value: "Summer" },
    steps: [{ code: "create_test" }, { code: "rehearse_operation" }, { code: "rehearse_undo" }, { code: "delete_test" }] };
  const { db } = await run(m.correctSwitchboardRunRequestTool, { request_id: REQ_ID, edit_kind: "value", request: r, changed });
  assert.deepEqual(rpcs(db)[0], ["switchboard_correct_run_request", { p_request_id: REQ_ID, p_edit_kind: "value", p_request: r, p_changed: changed }]);
  const wrong = { ...r, steps: [{ code: "count_listed" }] };
  const none = await refusal(m.correctSwitchboardRunRequestTool, { request_id: REQ_ID, edit_kind: "value", request: wrong, changed },
    /a value edit doesn't run count_listed again/);
  assert.equal(rpcs(none).length, 0);
  // A wording edit keeps the request's own page and steps.
  const w = await run(m.correctSwitchboardRunRequestTool, { request_id: REQ_ID, edit_kind: "wording", request: { ...DATAOP(), headline: "NEW WORDS" }, changed });
  assert.equal(rpcs(w.db).length, 1);
});

test("correct: the base page's own rules apply: a wording edit while on the correction page; an undo's counts", async () => {
  const changed = { reason: "Clearer words.", items: [{ what: "Headline", old: "a", new: "b" }] };
  // The request is on its correction page (reruns waiting); Claude echoes page: correction.
  const onCorrection = fakeDb(undefined, { page: "correction", base_page: "dataop" });
  await m.correctSwitchboardRunRequestTool.handler({ request_id: REQ_ID, edit_kind: "wording",
    request: { ...DATAOP(), page: "correction", headline: "NEW WORDS" }, changed }, { db: onCorrection });
  assert.equal(rpcs(onCorrection).length, 1);
  // An undo of an upsert: its counts are the undo's (up to N), never the upsert's update + create sum.
  const undo = { ...DATAOP(), page: "undo", operation: { kind: "upsert", object: "Gift__c", external_id: "Ext__c" },
    undo_of: { run_tag: "demo-x1y-s5-ab12" }, counts: { expected: 45, undo_up_to: 45 },
    steps: [{ code: "create_test" }, { code: "rehearse_operation" }, { code: "rehearse_undo" }, { code: "delete_test" }] };
  const asUndo = fakeDb(undefined, { page: "undo", base_page: "undo" });
  await m.correctSwitchboardRunRequestTool.handler({ request_id: REQ_ID, edit_kind: "value", request: undo, changed }, { db: asUndo });
  assert.equal(rpcs(asUndo).length, 1);
  // ...and a data operation's own rules still hold under a correction: an upsert's counts must add up.
  const badUpsert = { ...undo, page: "dataop", counts: { total: 45, update: 10, create: 10 } };
  await assert.rejects(m.correctSwitchboardRunRequestTool.handler({ request_id: REQ_ID, edit_kind: "value", request: badUpsert, changed },
    { db: fakeDb() }), /upsert's update and create must add up/);
  // pre_check_request_id echoed in capitals is normalised, as the queue stores it.
  const pre = fakeDb();
  await m.correctSwitchboardRunRequestTool.handler({ request_id: REQ_ID, edit_kind: "wording",
    request: { ...DATAOP(), pre_check_request_id: PRE_ID.toUpperCase() }, changed }, { db: pre });
  assert.equal(rpcs(pre)[0][1].p_request.pre_check_request_id, PRE_ID);
});

test("correct: object and operation need a new request; unknown kinds, a missing reason and evidence are refused", async () => {
  const changed = { reason: "r", items: [{ what: "w", old: "a", new: "b" }] };
  await refusal(m.correctSwitchboardRunRequestTool, { request_id: REQ_ID, edit_kind: "object", request: DATAOP(), changed }, /needs a new request through diagnosis/);
  await refusal(m.correctSwitchboardRunRequestTool, { request_id: REQ_ID, edit_kind: "colour", request: DATAOP(), changed }, /edit_kind` must be one of/);
  await refusal(m.correctSwitchboardRunRequestTool, { request_id: REQ_ID, edit_kind: "wording", request: DATAOP(), changed: { items: changed.items } }, /Add changed.reason/);
  await refusal(m.correctSwitchboardRunRequestTool, { request_id: REQ_ID, edit_kind: "wording", request: { ...DATAOP(), evidence: [] }, changed }, /no evidence or sample/);
  await refusal(m.correctSwitchboardRunRequestTool, { request_id: "x", edit_kind: "wording", request: DATAOP(), changed }, /request_id` must be a UUID/);
});

test("issue: the link comes back whole; a review link names its review", async () => {
  const link = { link_id: REQ_ID, url: "https://alfred.example/run/" + "a".repeat(64), headline: "H", version: 1 };
  const { out, db } = await run(m.issueSwitchboardRunLinkTool, { request_id: REQ_ID }, fakeDb({ data: link, error: null }));
  assert.deepEqual(out, link);
  assert.deepEqual(db.calls[0], ["switchboard_issue_run_link", { p_request_id: REQ_ID, p_review_id: null }]);
  const r = await run(m.issueSwitchboardRunLinkTool, { request_id: REQ_ID, review_id: REVIEW_ID });
  assert.equal(r.db.calls[0][1].p_review_id, REVIEW_ID);
  await refusal(m.issueSwitchboardRunLinkTool, { request_id: REQ_ID, review_id: "x" }, /review_id` must be a UUID/);
});

test("record review: codeReviewProblems first (a note off the changed lines), then the database; Alex's side refused", async () => {
  const { db } = await run(m.recordSwitchboardCodeReviewTool, { request_id: REQ_ID, review: REVIEW() });
  assert.equal(db.calls[0][0], "switchboard_record_code_review");
  const off = REVIEW();
  off.notes[0] = { ...off.notes[0], start_line: 1, end_line: 1 };
  const none = await refusal(m.recordSwitchboardCodeReviewTool, { request_id: REQ_ID, review: off }, /aren't changed lines/);
  assert.equal(none.calls.length, 0);
  await refusal(m.recordSwitchboardCodeReviewTool, { request_id: REQ_ID, review: { ...REVIEW(), commit: "xyz" } }, /Add commit/);
  await refusal(m.recordSwitchboardCodeReviewTool, { request_id: REQ_ID, review: { ...REVIEW(), status: "reviewed" } }, /only Alex's answer/);
});
