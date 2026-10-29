import test from "node:test";
import assert from "node:assert/strict";
import * as ps from "./plan-scope.mjs";

const PROMPT = `Run tag: proj-abc-s9-k7wf
Window: the proj-abc worktree
Estimated run: 15m

Scope of this step:
- create: .claude/hooks/plan-guard.mjs, scripts/lib/plan-scope.mjs
- update: extension/ (bridge files), \`docs/x.md\`
- delete: nothing
- deploy: mcp, sf:ApexClass:Foo
- SQL: wb_rules, public.inbox_items

# Task`;

const record = (scope, runTag = "proj-abc-s9-k7wf") => ({ run_tag: runTag, found: true, scope: { ...ps.emptyScope(), ...scope } });

test("parseScope reads the block and the estimate", () => {
  const p = ps.parseScope(PROMPT);
  assert.equal(p.found, true);
  assert.deepEqual(p.scope.create, [".claude/hooks/plan-guard.mjs", "scripts/lib/plan-scope.mjs"]);
  assert.deepEqual(p.scope.update, ["extension/", "docs/x.md"]);
  assert.deepEqual(p.scope.delete, []);
  assert.deepEqual(p.scope.deploy, ["mcp", "sf:ApexClass:Foo"]);
  assert.deepEqual(p.scope.sql, ["wb_rules", "inbox_items"]);
  assert.equal(p.estimate, "15m");
});

test("parseScope: no block, and indented lines", () => {
  assert.equal(ps.parseScope("Run tag: a-s1-abcd\nDo it.").found, false);
  const p = ps.parseScope("  Scope of this step:\n  - create: nothing\n  - update: a.md\n  - SQL: none");
  assert.equal(p.found, true);
  assert.deepEqual(p.scope.update, ["a.md"]);
  assert.deepEqual(p.scope.sql, []);
});

test("judgeWrite: create and update are separate, folders cover, progress is implied", () => {
  const r = record({ create: ["scripts/lib/new.mjs"], update: ["extension/", "docs/x.md"] });
  assert.equal(ps.judgeWrite(r, "scripts/lib/new.mjs", false), null);
  // A file this step created may be edited afterwards.
  assert.equal(ps.judgeWrite(r, "scripts/lib/new.mjs", true), null);
  assert.equal(ps.judgeWrite(r, "extension/lib/page.js", true), null);
  assert.equal(ps.judgeWrite(r, "docs/progress-proj-abc.md", true), null);
  assert.match(ps.judgeWrite(r, "docs/y.md", true), /undeclared update/);
  assert.match(ps.judgeWrite(r, "docs/x2.md", false), /undeclared create/);
  // Declared as an update, but the file does not exist: that is a create.
  assert.match(ps.judgeWrite(r, "extension/new.js", false), /undeclared create/);
});

test("judgeWrite: a prompt with no scope block allows nothing", () => {
  const none = { run_tag: "proj-abc-s9-k7wf", found: false, scope: ps.emptyScope() };
  assert.match(ps.judgeWrite(none, "docs/progress-proj-abc.md", true), /no scope block/);
});

test("judgeDelete: only declared paths", () => {
  const r = record({ delete: ["supabase/migrations/_pending_x.sql"] });
  assert.equal(ps.judgeDelete(r, ["supabase/migrations/_pending_x.sql"]), null);
  assert.match(ps.judgeDelete(r, ["src/App.js"]), /undeclared delete.*src\/App\.js/);
});

test("deleteParts finds rm, del, Remove-Item and git rm", () => {
  assert.deepEqual(ps.deleteParts("git status; rm -f a.txt"), ["rm -f a.txt"]);
  assert.deepEqual(ps.deleteParts("git rm b.txt"), ["git rm b.txt"]);
  assert.deepEqual(ps.deleteParts("Remove-Item c.txt", "powershell"), ["Remove-Item c.txt"]);
  assert.deepEqual(ps.deleteParts('grep -n "rm" x.txt'), []);
  assert.deepEqual(ps.deleteParts("npm run build"), []);
});

test("deployTargets and judgeDeploy", () => {
  assert.deepEqual(ps.deployTargets("npx supabase functions deploy mcp --no-verify-jwt"), ["mcp"]);
  assert.deepEqual(ps.deployTargets("supabase functions deploy"), ["(all functions)"]);
  assert.deepEqual(ps.deployTargets("supabase db push"), ["db push"]);
  assert.deepEqual(ps.deployTargets("sf project deploy start --metadata ApexClass:Foo -o uat"), ["sf:ApexClass:Foo"]);
  assert.deepEqual(ps.deployTargets("sf project deploy start --source-dir force-app"), ["sf:force-app"]);
  assert.equal(ps.deployTargets("git status"), null);
  const r = record({ deploy: ["mcp"] });
  assert.equal(ps.judgeDeploy(r, "supabase functions deploy mcp"), null);
  assert.match(ps.judgeDeploy(r, "supabase functions deploy clip-capture"), /undeclared deploy.*clip-capture/);
  assert.match(ps.judgeDeploy(record({}), "supabase functions deploy mcp"), /undeclared deploy/);
});

test("sqlTables: the tables a script touches", () => {
  const sql = `-- drop table not_this;
create table if not exists public.wb_x (id int references other_t(id));
alter table only "wb_rules" add column y int;
insert into inbox_items (a) values (1);
update wb_tags set a = 1 where b = 2;
delete from public.clips where true;
create index on wb_y (a);
grant select on table wb_z to authenticated;
truncate wb_w;
drop table if exists wb_old;
select * from for_update_only for update;`;
  assert.deepEqual(ps.sqlTables(sql).sort(), ["clips", "inbox_items", "wb_old", "wb_rules", "wb_tags", "wb_w", "wb_x", "wb_y", "wb_z"]);
});

test("judgeWrite checks the tables of a SQL file", () => {
  const r = record({ create: ["supabase/migrations/_pending_x.sql"], sql: ["wb_rules"] });
  const ok = "alter table wb_rules add column a int;";
  assert.equal(ps.judgeWrite(r, "supabase/migrations/_pending_x.sql", false, ok), null);
  assert.match(ps.judgeWrite(r, "supabase/migrations/_pending_x.sql", false, "drop table clips;"), /SQL touches clips/);
});
