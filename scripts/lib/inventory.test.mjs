import test from "node:test";
import assert from "node:assert/strict";
import {
  appFor,
  appIdsFromMigrations,
  dedupeParts,
  edgeFunctionPart,
  isWorkDoc,
  lastChangedFromLog,
  openWork,
  parseDefineTools,
  projectFromSubject,
  registeredTools,
  screenParts,
  skillPart,
  snapshotObjects,
  snapshotParts,
  tableProblems,
  taskPromptPart,
  toolParts,
} from "./inventory.mjs";

const SNAPSHOT = [
  'CREATE TABLE IF NOT EXISTS "public"."items" (',
  'CREATE TABLE IF NOT EXISTS "platform"."registry" (',
  'CREATE OR REPLACE VIEW "public"."wb_true_cost" WITH ("security_invoker"=\'true\') AS',
].join("\n");
const OBJECTS = snapshotObjects(SNAPSHOT);

const tool = (props) => `export const t = defineTool({\n${props}\n  handler: async () => ({ x: "}" }),\n});\n`;
const problems = (src) => tableProblems(parseDefineTools(src), OBJECTS, "f.ts");

test("snapshot: public bare, platform qualified, views count", () => {
  assert.deepEqual([...OBJECTS].sort(), ["items", "platform.registry", "wb_true_cost"]);
});

test("reads name and tables, comments and tier between", () => {
  const src = tool(`  name: "get_x",\n  tier: 1,\n  // through an RPC\n  tables: {\n    reads: ["items", 'wb_true_cost'],\n    writes: [],\n  },`);
  const [t] = parseDefineTools(src);
  assert.equal(t.name, "get_x");
  assert.deepEqual(t.tables, { reads: ["items", "wb_true_cost"], writes: [] });
  assert.deepEqual(problems(src), []);
});

test("several calls, each with its line", () => {
  const src = tool('  name: "a",\n  tables: { reads: ["items"], writes: [] },') + tool('  name: "b",\n  tables: { reads: [], writes: ["items"] },');
  assert.deepEqual(parseDefineTools(src).map((t) => [t.name, t.line]), [["a", 1], ["b", 6]]);
});

test("missing tables", () => {
  assert.match(problems(tool('  name: "get_x",\n  tier: 1,'))[0], /get_x: no tables before the handler/);
});

test("tables after the handler counts as missing", () => {
  const src = 'defineTool({ name: "x", handler: async () => 1, tables: { reads: [], writes: [] } });';
  assert.match(problems(src)[0], /no tables before the handler/);
});

test("non-literal arrays and missing keys", () => {
  assert.match(problems(tool('  name: "x",\n  tables: { reads: READS, writes: [] },'))[0], /tables.reads is not a literal array/);
  assert.match(problems(tool('  name: "x",\n  tables: { reads: [name], writes: [] },'))[0], /not a literal array/);
  assert.match(problems(tool('  name: "x",\n  tables: TABLES,'))[0], /not an object literal/);
  assert.match(problems(tool('  name: "x",\n  tables: { reads: [] },'))[0], /tables.writes is missing/);
});

test("unknown table names", () => {
  const out = problems(tool('  name: "x",\n  tables: { reads: ["made_up"], writes: ["registry"] },'));
  assert.equal(out.length, 2);
  assert.match(out[0], /reads made_up, which is not in the schema snapshot/);
  assert.match(out[1], /writes registry/); // platform names need their schema
});

test('"*" only in reads', () => {
  assert.deepEqual(problems(tool('  name: "get_records",\n  tables: { reads: ["*", "platform.registry"], writes: [] },')), []);
  assert.match(problems(tool('  name: "x",\n  tables: { reads: [], writes: ["*"] },'))[0], /allowed only in reads/);
});

// ---------------------------------------------------------------------------
// The rebuild (Step 44)
// ---------------------------------------------------------------------------

const APPS = appIdsFromMigrations([
  "insert into public.apps (id, name) values\n  ('alfred', 'Alfred',\n 'x'), ('warren_buffet', 'Warren Buffet'),\n"
  + "  ('sam', 'Sam'), ('dj', 'DJ'), ('drive_mix', 'Drive Mix'), ('ken', 'Ken'), ('jobs', 'Jobs')\non conflict (id) do nothing;",
  "insert into public.apps (id, name, description) values ('overwatch', 'Overwatch', 'y') on conflict do nothing;",
]);
const LOG = new Map([["t.ts", { code: "abc-q1w", order: 0 }]]);

test("apps from migrations, and the name rules", () => {
  assert.deepEqual([...APPS].sort(), ["alfred", "dj", "drive_mix", "jobs", "ken", "overwatch", "sam", "warren_buffet"]);
  const cases = {
    get_wb_projects: "warren_buffet", "wb-planning": "warren_buffet", "/money/plan": "warren_buffet",
    get_drive_mix_pick: "drive_mix", get_dj_plays: "dj", get_sam_songs: "sam", "/sam/stats": "sam",
    record_ken_attempts: "ken", create_job_application: "jobs", get_project_plans: "overwatch",
    get_claim_blocks: "overwatch", activity: "overwatch", get_items: "alfred",
  };
  for (const [name, app] of Object.entries(cases)) assert.equal(appFor(name, APPS), app, name);
  assert.equal(appFor("arnold_sessions", new Set(["sam"])), null); // fallback alfred is not an app here
});

test("tools: registered only, * as reads_any, tier, app, last change", () => {
  const text = tool('  name: "get_sam_x",\n  tier: 1,\n  tables: { reads: ["*", "items"], writes: [] },')
    + tool('  name: "dry_run_x",\n  tables: { reads: [], writes: [] },');
  const { parts, problems: p } = toolParts([{ path: "t.ts", text }], registeredTools('registerTool(\n "get_sam_x",'), APPS, LOG);
  assert.equal(parts.length, 1);
  assert.deepEqual(p, []);
  const [t] = parts;
  assert.deepEqual([t.name, t.app_id, t.reads, t.reads_any, t.details.tier, t.last_changed_project, t.location],
    ["get_sam_x", "sam", ["items"], true, 1, "abc-q1w", "t.ts"]);
  assert.match(t.fingerprint, /^[0-9a-f]{16}$/);
});

test("tools: a registered tool with no defineTool is reported", () => {
  assert.match(toolParts([], new Set(["ghost"]), APPS).problems[0], /ghost has no defineTool/);
});

const TOOLS = new Map([
  ["get_inbox", { reads: ["inbox"], writes: [] }],
  ["log_friction", { reads: [], writes: ["process_friction"] }],
]);

test("skills: tools mentioned, their tables, the version line", () => {
  const s = skillPart(".claude/skills/overwatch/SKILL.md", "Skill version: 2026-10-27a\nCall get_inbox, then log_friction. Not get_inboxes.", TOOLS, APPS);
  assert.deepEqual([s.kind, s.name, s.app_id, s.details.version], ["skill", "overwatch", "overwatch", "2026-10-27a"]);
  assert.deepEqual(s.details.tools, ["get_inbox", "log_friction"]);
  assert.deepEqual([s.reads, s.writes], [["inbox"], ["process_friction"]]);
  assert.equal(skillPart(".claude/skills/ken/SKILL.md", "no line", TOOLS, APPS).details.version, null);
});

test("task prompts: PROMPT VERSION, history flag, app from the file name", () => {
  const p = taskPromptPart("docs/history/dj-daily-task-prompt.md", "### `PROMPT VERSION: 2026-10-25b`\nget_inbox", TOOLS, APPS);
  assert.deepEqual([p.kind, p.name, p.app_id, p.details.version, p.details.history], ["task_prompt", "docs/history/dj-daily-task-prompt.md", "dj", "2026-10-25b", true]);
});

test("edge functions: one part per folder, newest change across its files", () => {
  const log = new Map([["supabase/functions/wb-sync/a.ts", { code: "old-a1b", order: 5 }], ["supabase/functions/wb-sync/b.ts", { code: "new-c2d", order: 1 }]]);
  const f = edgeFunctionPart("supabase/functions/wb-sync",
    [{ path: "supabase/functions/wb-sync/b.ts", text: "b" }, { path: "supabase/functions/wb-sync/a.ts", text: "a" }], APPS, log);
  assert.deepEqual([f.name, f.app_id, f.last_changed_project, f.details.files], ["wb-sync", "warren_buffet", "new-c2d", ["a.ts", "b.ts"]]);
});

const SNAP = [
  'CREATE TABLE IF NOT EXISTS "public"."sam_songs" (\n    "id" "text"\n);',
  'CREATE TABLE IF NOT EXISTS "public"."activity" (\n    "id" "uuid"\n);',
  'CREATE TABLE IF NOT EXISTS "platform"."audit_log" (\n    "id" "uuid"\n);',
  'CREATE OR REPLACE VIEW "public"."wb_true_cost" WITH ("security_invoker"=\'true\') AS\n SELECT 1;',
  'CREATE OR REPLACE FUNCTION "public"."log_song"() RETURNS "trigger"\n    AS $$ begin insert into public.activity (id) values (1);',
  '  update platform.audit_log set id = id; on conflict do update set x = 1; end $$;',
  'ALTER FUNCTION "public"."log_song"() OWNER TO "postgres";',
  'CREATE OR REPLACE TRIGGER "log_song" AFTER INSERT ON "public"."sam_songs" FOR EACH ROW EXECUTE FUNCTION "public"."log_song"();',
  '',
].join("\n");

test("snapshot: tables and views, platform names qualified", () => {
  const tables = snapshotParts(SNAP, APPS).filter((p) => p.kind === "table");
  assert.deepEqual(tables.map((t) => [t.name, t.app_id, t.details.view]),
    [["sam_songs", "sam", false], ["activity", "overwatch", false], ["platform.audit_log", null, false], ["wb_true_cost", "warren_buffet", true]]);
});

test("snapshot: a trigger reads its table and writes what its function writes", () => {
  const [t] = snapshotParts(SNAP, APPS).filter((p) => p.kind === "trigger");
  assert.deepEqual([t.name, t.reads, t.writes, t.details.timing, t.details.function],
    ["sam_songs.log_song", ["sam_songs"], ["activity", "platform.audit_log"], "AFTER INSERT", "log_song"]);
});

test("screens: VIEW_TO_PATH and *_PATH constants, one part per route", () => {
  const src = 'export const VIEW_TO_PATH = {\n  home: "/",\n  // a comment\n  "inbox-detail": "/inbox/detail",\n  sam: "/sam",\n};\n'
    + 'export const SAM_PATH = "/sam";\nexport const MONEY_PATH = "/money";\n';
  const s = screenParts(src, APPS);
  assert.deepEqual(s.map((p) => [p.name, p.app_id]), [["/", "alfred"], ["/inbox/detail", "alfred"], ["/money", "warren_buffet"], ["/sam", "sam"]]);
  assert.deepEqual(s.find((p) => p.name === "/sam").details.from, ["view:sam", "SAM_PATH"]);
});

test("open work: which docs are read", () => {
  for (const f of ["docs/progress-overwatch-q4n.md", "docs/history/technical-spec-dj.md", "docs/review-x.md", "docs/history/phase7.2.1-progress.md", "docs/history/06-spec-audio-sync-redesign.md"]) {
    assert.equal(isWorkDoc(f), true, f);
  }
  for (const f of ["docs/overwatch-nightly-task-prompt.md", "docs/history/loose-ends.md", "docs/design-system/progress-x.md", "src/progress-x.md"]) {
    assert.equal(isWorkDoc(f), false, f);
  }
});

test("open work: boxes, deferred phases, not-fixed notes; code blocks skipped; project code from the name", () => {
  const text = [
    "- [x] Step 1: done",
    "- [ ] Step 2: to do",
    "  * [ ] nested, indented",
    "1. [ ] numbered",
    "### Phase 7: Inventory (deferred: needs tables)",
    "We deferred the colour change.",
    "- 2026-10-24, gitpush follow-up (not fixed here): folders",
    "```",
    "- [ ] inside a code block",
    "```",
  ].join("\n");
  const w = openWork("docs/progress-overwatch-q4n.md", text);
  assert.deepEqual(w.map((x) => [x.line, x.kind]), [[2, "checkbox"], [3, "checkbox"], [4, "checkbox"], [5, "deferred_phase"], [7, "not_fixed"]]);
  assert.equal(w[1].text, "* [ ] nested, indented");
  assert.equal(w[0].project_code, "overwatch-q4n");
  assert.equal(openWork("docs/phase7-progress.md", "- [ ] x")[0].project_code, null);
});

test("open work in history: no plain boxes; follow-ups, deferred and not fixed stay", () => {
  const text = [
    "- [ ] Step 9: never ticked",
    "- [ ] Follow-up: remove the touchui flag",
    "- [ ] Watch (no step needed): the next runs",
    "### Phase 8: Switchboard state (deferred, optional)",
    "- 2026-10-24, gitpush follow-up (not fixed here): folders",
  ].join("\n");
  assert.deepEqual(openWork("docs/history/progress-x-a1b.md", text).map((x) => [x.line, x.kind]),
    [[2, "checkbox"], [4, "deferred_phase"], [5, "not_fixed"]]);
});

test("open work: bullets under a Later heading, until a heading as high", () => {
  const text = [
    "## Steps",
    "- [x] done",
    "## 6. Later phase",
    "- CSV import from Wells Fargo",
    "  - sub-point, still later",
    "- [x] already done, so not open",
    "### Phase 3b (or later): history import",
    "1. numbered under the sub-heading",
    "plain prose is not a bullet",
    "## Notes",
    "- not later any more",
  ].join("\n");
  for (const file of ["docs/history/technical-spec-wb-q5k.md", "docs/technical-spec-wb-q5k.md"]) {
    assert.deepEqual(openWork(file, text).map((x) => [x.line, x.kind]),
      [[4, "deferred_phase"], [5, "deferred_phase"], [8, "deferred_phase"]], file);
  }
  assert.deepEqual(openWork("docs/history/progress-r.md", "## Later, not Phase 3\n- tags on groups").map((x) => x.line), [2]);
  assert.deepEqual(openWork("docs/history/p-progress.md", "## Notes for the human reading this later\n- x"), []);
});

test("git: project from a subject, the newest commit per file decides", () => {
  assert.equal(projectFromSubject("overwatch-q4n: checkpoint 2026-10-27"), "overwatch-q4n");
  assert.equal(projectFromSubject("Merge worktree-claims-wq7"), "claims-wq7");
  assert.equal(projectFromSubject("Fix the thing"), null);
  const log = "\x1eFix the thing\n\na.ts\n\x1eoverwatch-q4n: step\n\na.ts\nb.ts\n";
  const m = lastChangedFromLog(log);
  assert.deepEqual(m.get("a.ts"), { code: null, order: 0 }); // newest names no project: null, not the older one
  assert.deepEqual(m.get("b.ts"), { code: "overwatch-q4n", order: 1 });
});

test("duplicates are dropped and reported", () => {
  const r = dedupeParts([{ kind: "tool", name: "a" }, { kind: "skill", name: "a" }, { kind: "tool", name: "a" }]);
  assert.equal(r.parts.length, 2);
  assert.deepEqual(r.dropped, ["tool a"]);
});
