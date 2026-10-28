import test from "node:test";
import assert from "node:assert/strict";
import {
  branchFromSubject,
  buildFinishSummary,
  parseSendSummaryArgs,
  classifyPaths,
  collectFinishSummary,
  migrationTables,
  parseNumstat,
  queueOverwatch,
  sendPlanLine,
  sendsFor,
  toolsIn,
} from "./finish-summary.mjs";

const NUMSTAT = [
  "12\t3\tsupabase/migrations/180_overwatch_platform_inventory.sql",
  "40\t0\tsupabase/functions/_shared/tools/overwatch-inventory.ts",
  "5\t1\tsupabase/functions/mcp/index.ts",
  "2\t0\tsupabase/functions/overwatch-ingest/ingest.test.mjs",
  "1\t1\t.claude/skills/overwatch/SKILL.md",
  "3\t2\tdocs/overwatch-nightly-task-prompt.md",
  "-\t-\tdocs/design-system/logo.png",
  "0\t9\tsupabase/functions/_shared/tools/gone.ts",
  "",
].join("\n");
const FILES = {
  "supabase/functions/_shared/tools/overwatch-inventory.ts": 'defineTool({\n  name: "get_open_work",\n  tables: { reads: [], writes: [] },\n  handler: 1 });',
  "supabase/functions/mcp/index.ts": 'const t = defineTool({\n  name: "get_items",\n  tables: { reads: [], writes: [] },\n  handler: 1 });',
};
const readFile = (p) => FILES[p] ?? null;

test("numstat: paths and the diff stat; a binary file counts no lines", () => {
  const { paths, diff_stat } = parseNumstat(NUMSTAT);
  assert.equal(paths.length, 8);
  assert.deepEqual(diff_stat, { files: 8, insertions: 63, deletions: 16 });
});

test("paths sorted into migrations, skills, functions and task prompts", () => {
  assert.deepEqual(classifyPaths(parseNumstat(NUMSTAT).paths), {
    migrations: ["supabase/migrations/180_overwatch_platform_inventory.sql"],
    skills: [".claude/skills/overwatch/SKILL.md"],
    functions: ["supabase/functions/mcp", "supabase/functions/overwatch-ingest"],
    task_prompts: ["docs/overwatch-nightly-task-prompt.md"],
  });
  assert.deepEqual(classifyPaths(["supabase/migrations/_pending_x_y.sql", "docs/history/dj-daily-task-prompt.md"]),
    { migrations: [], skills: [], functions: [], task_prompts: ["docs/history/dj-daily-task-prompt.md"] });
});

test("tools: the defineTool names in changed tool files that still exist; tests left out", () => {
  assert.deepEqual(toolsIn(parseNumstat(NUMSTAT).paths, readFile), ["get_items", "get_open_work"]);
});

test("the row, as overwatch-ingest's finish_summary takes it", () => {
  const row = buildFinishSummary({
    projectCode: "overwatch-q4n", branch: "worktree-overwatch-q4n", mergeCommit: "abc1234def",
    finishedAt: "2026-10-27T13:00:00-07:00", numstat: NUMSTAT, readFile,
  });
  assert.deepEqual(Object.keys(row).sort(), ["branch", "diff_stat", "finished_at", "functions", "merge_commit", "migrations",
    "paths", "project_code", "skills", "task_prompts", "tools"]);
  assert.equal(row.paths[0], ".claude/skills/overwatch/SKILL.md");
  assert.equal(row.tools.length, 2);
});

/** A git that answers from a table of "args" → stdout; anything else fails. */
const fakeGit = (answers) => (args) => {
  const key = args.join(" ");
  return key in answers ? { ok: true, stdout: answers[key] } : { ok: false, stdout: "" };
};

test("collect: the merge against its first parent", () => {
  const git = fakeGit({
    "rev-parse HEAD": "abc1234def5678",
    "show -s --format=%cI HEAD": "2026-10-27T13:00:00-07:00",
    "diff --numstat --no-renames HEAD^1 HEAD": NUMSTAT,
  });
  const { row } = collectFinishSummary({ git, readFile, projectCode: "overwatch-q4n", branch: "worktree-overwatch-q4n", base: "HEAD^1" });
  assert.deepEqual([row.merge_commit, row.finished_at, row.diff_stat.files], ["abc1234def5678", "2026-10-27T13:00:00-07:00", 8]);
});

test("collect: no base, an unreadable HEAD, or nothing changed give an error, not a row", () => {
  const ok = { "rev-parse HEAD": "abc1234", "show -s --format=%cI HEAD": "2026-10-27T13:00:00-07:00", "diff --numstat --no-renames a HEAD": "" };
  assert.match(collectFinishSummary({ git: fakeGit(ok), readFile, projectCode: "x", base: null }).error, /no base/);
  assert.match(collectFinishSummary({ git: fakeGit({}), readFile, projectCode: "x", base: "a" }).error, /could not read HEAD/);
  assert.match(collectFinishSummary({ git: fakeGit(ok), readFile, projectCode: "x", base: "a" }).error, /nothing changed/);
});

test("sends: inventory after every push into main; the summary on Finish only", () => {
  const env = {};
  assert.deepEqual(sendsFor({ mode: "c", result: "done", env }), { inventory: true, summary: false, reason: null });
  assert.deepEqual(sendsFor({ mode: "f", result: "done", env }), { inventory: true, summary: true, reason: null });
  assert.deepEqual(sendsFor({ mode: "f", result: "partial", env }), { inventory: true, summary: true, reason: null });
  assert.deepEqual(sendsFor({ mode: "p", result: "done", env }), { inventory: true, summary: false, reason: null });
});

test("sends: nothing when refused or cancelled, on Skip, when the push failed, or with the sender off", () => {
  for (const [mode, result, env] of [["c", "cancelled", {}], ["f", "failed", {}], ["p", "failed", {}], ["s", "done", {}],
    [null, "done", {}], ["c", "done", { OVERWATCH_SENDER: "off" }], ["f", "done", { OVERWATCH_SENDER: "off" }]]) {
    const s = sendsFor({ mode, result, env });
    assert.deepEqual([s.inventory, s.summary], [false, false], `${mode} ${result} ${JSON.stringify(env)}`);
  }
});

test("the plan line names the sends, or why there are none", () => {
  assert.match(sendPlanLine("c", {}), /^Send {4}the rebuilt inventory to Overwatch, through the outbox/);
  assert.match(sendPlanLine("f", {}), /inventory and a finish summary/);
  assert.equal(sendPlanLine("c", { OVERWATCH_SENDER: "off" }), "Send    nothing to Overwatch (OVERWATCH_SENDER=off).");
});

test("--send-summary: a commit and a project, or a plain error", () => {
  assert.equal(parseSendSummaryArgs(["--send"]), null);
  assert.deepEqual(parseSendSummaryArgs(["--send-summary", "1303FFD", "--project", "overwatch-q4n"]),
    { commit: "1303ffd", project: "overwatch-q4n" });
  assert.deepEqual(parseSendSummaryArgs(["--project", "overwatch-q4n", "--send-summary", "1303ffd"]),
    { commit: "1303ffd", project: "overwatch-q4n" });
  assert.match(parseSendSummaryArgs(["--send-summary"]).error, /needs a commit hash/);
  assert.match(parseSendSummaryArgs(["--send-summary", "main", "--project", "x"]).error, /needs a commit hash/);
  assert.match(parseSendSummaryArgs(["--send-summary", "1303ffd"]).error, /needs --project/);
  assert.match(parseSendSummaryArgs(["--send-summary", "1303ffd", "--project", "Bad Code"]).error, /needs --project/);
});

test("the branch from a merge subject", () => {
  assert.equal(branchFromSubject("Merge worktree-overwatch-q4n"), "worktree-overwatch-q4n");
  assert.equal(branchFromSubject("overwatch-q4n: checkpoint"), null);
});

test("queue: under the lock, then the sender; never throws", () => {
  const log = [];
  const lock = (fn) => { log.push("lock"); fn(); };
  const deps = { lock, queue: (file, ev) => log.push(`queue ${file} ${ev.length}`), kick: () => log.push("kick") };
  assert.deepEqual(queueOverwatch({ outboxFile: "/o.jsonl" }, [{ _kind: "inventory" }, { _kind: "finish_summary" }], deps),
    { queued: 2, error: null });
  assert.deepEqual(log, ["lock", "queue /o.jsonl 2", "kick"]);
  assert.match(queueOverwatch({}, [{}], deps).error, /no Overwatch outbox/);
  assert.deepEqual(queueOverwatch({ outboxFile: "/o" }, [], deps), { queued: 0, error: null });
  const broken = queueOverwatch({ outboxFile: "/o" }, [{}], { ...deps, queue: () => { throw new Error("disk full"); } });
  assert.deepEqual(broken, { queued: 0, error: "disk full" });
});

test("migrationTables: the tables a migration's SQL touches, not its file name", () => {
  const sql = `
    -- update public.not_this set x = 1   (a comment)
    begin;
    alter table public.inbox add column if not exists suggested_group_id text;
    create table if not exists public.portfolios (id uuid);
    CREATE UNIQUE INDEX portfolios_one ON public.portfolios (id);
    create or replace function public.process_inbox_item(p text) returns jsonb as $$
    begin
      insert into public.item_group_members (group_id) values ('g');
      update public.inbox i set archived = true where id = p;
      delete from only "public"."reminders" where false;
      perform 1 from public.items;
    end; $$;
    create trigger inbox_check before insert or update of suggested_group_id on public.inbox for each row execute function f();
    create policy owner_rows on public.portfolios for all using (true);
    select platform.register_table('public.portfolios');
    update platform.registry set notes = 'x';
    /* insert into public.not_this_either */
  `;
  assert.deepEqual(migrationTables(sql),
    ["inbox", "item_group_members", "platform.registry", "portfolios", "reminders"]);
  assert.deepEqual(migrationTables(""), []);
  assert.deepEqual(migrationTables(null), []);
});
