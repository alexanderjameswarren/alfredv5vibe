**The shared Switchboard rules load at session start** (from the switchboard repo's
`rules/SWITCHBOARD-RULES.md`, installed to `%LOCALAPPDATA%\Switchboard\rules\` and
printed by the session-rules hook): git, files you did not touch, the thread
protocol, claims, blocks, the guards, the plan guard, Salesforce, Edit and Write
only, reports into Alfred, and working fast. **This file adds alfred-v5's own
rules.** It never loosens a shared one.

## Git in alfred-v5

- Claims, clip, the guards and the git commands run from the installed copy in
  `%LOCALAPPDATA%\Switchboard` (`claims.cmd`, `clip.cmd`, the user-level hooks,
  `%LOCALAPPDATA%\Switchboard\git\`). Their code lives in
  `C:\Users\Alex\projects\switchboard`, and a change to any of them is made there,
  not here. If Switchboard isn't installed, the guards block everything and say so.
- A push can trigger a deploy, which is why committing and pushing are Alex's alone.
  A prompt that says "commit", "commit directly to main" or "commit and push" still
  doesn't authorise it: do the work, leave it uncommitted, and say in the report that
  you didn't commit, and why. Don't ask for permission to commit.
- A prompt that says "run gitsync first" still means: check whether it's needed,
  and if it is, stop and ask. After a git step, start by checking its effect
  read-only, for example `git merge-base --is-ancestor main HEAD`.
- Files you didn't touch include tool artefacts: mention them, don't tidy them.

## Worktrees and project codes here

- **Step 0, before a worktree exists.** Alex runs `gitnewtree <project-code>`, which
  refuses until main is committed and pushed, then branches from `origin/main`,
  copies the machine-local files, runs `scripts/prebuild.js` so the generated schema
  files exist, and opens the worktree in VS Code. `claude --worktree <name>` skips
  the Step 0 check and prebuild, so a worktree made that way can't build, deploy a
  function or pass the SAM tests until prebuild is run by hand. If you're asked to
  start a worktree and main has unpushed commits, say so first.
- A project code may contain underscores (`parallel_threads`); the separators in a
  run tag are always hyphens. A run tag's project code is everything before the
  step segment: `claims-wq7-s7d-u3rb` → `claims-wq7`.
- A `UserPromptSubmit` hook blocks a prompt that landed in the wrong window. If Alex
  says a prompt was rejected as the wrong window, he pastes it into the right one;
  don't work around it.
- When a claim fails, don't start on the part that did claim. `status` and `check`
  need no permission: use `check` freely while planning.
- `yield` releases a file only when it is unchanged from main and claimed on its own,
  not through a folder; it checks this itself.

## Database steps, just in time

At the step that needs a database item (`db:table:<name>`, `db:fn:<name>`,
`db:deploy`), not before. A plan lists each with the step that needs it. New SQL is
written under `_pending_<owner>_<purpose>.sql` until step 5.

1. `claims.cmd check` the `db:table:*`, `db:fn:*` and `db:deploy` you need.
2. Stop and ask Alex to run `gitsync` in this worktree, so it has everything
   already live.
3. **Drift check.** After the sync, look at what came in. If any migration or
   function change touches the same tables or the same function, stop and
   re-plan that step — your plan was written against an older schema.
4. Ask Alex to confirm, then claim the items (or `reserve` them with their step at
   planning). **Claim them at this step, every time**; a `db:` claim is never
   carried over. Claiming `db:deploy` raises Alex's permission prompt; the rest are
   silent.
5. **Number the migration now**, not earlier: run
   `claims.cmd number-migration supabase/migrations/_pending_<owner>_<purpose>.sql`
   on its own. It prints the number and claims it (`db:migration:NNN`). Write
   the numbered file, delete the `_pending_` one, queue it. Never pick a number
   by hand.
6. Deploy. Migrations you queue with `scripts/sql-queue.mjs` for him to approve
   by a link; function deploys you run yourself, holding `db:deploy`. A function
   deploy is refused from a worktree missing main's commits; when it is, stop and
   ask Alex for a gitsync rather than deploying from elsewhere. Run
   `check_platform_conformance` where the platform contract requires it.
7. Verify.
8. Stop and ask Alex to run `gitpush` in **Checkpoint** mode for this worktree,
   naming the migration and function paths. Checkpoint puts only those paths into
   main, so half-finished front-end work is not pushed with them, and it releases
   the `db:` claims itself, by default all of them.
9. Check with `claims.cmd status` that they went. If one is still held, release
   it — `db:` claims are the one thing you do release. `status` warns about any
   held for more than an hour; one held across steps once blocked another thread's
   deploy for thirteen hours.

`supabase/schema-snapshot.sql` is regenerated automatically by gitpush whenever a commit or merge carries a migration newer than the snapshot — main Push and Finish (same commit) and worktree Checkpoint and Finish (merge commit, regenerated in main) — and `npm run schema:snapshot` refreshes it by hand. Threads never edit it.

## All SQL lives in supabase/migrations/

ALL SQL goes in supabase/migrations/, numbered in sequence, with one exception
below. That includes schema changes, backfills, data repairs and one-off diagnostic
queries. Never create SQL under docs/. Name the file so its purpose is obvious from
the list, e.g. 031_backfill_sam_session_events.sql. You queue it; Alex approves it by
a link. Never apply one yourself, and never assume one has been applied.

**The exception: verification and test scripts live in `supabase/tests/<project>/`,
never in `supabase/migrations/`.** That means verification queries, test scripts and
test cleanups. Such a file in migrations would break any replay of the folder, and
gitpush's snapshot check would count it as a migration that never changes the schema.
Number them in run order (`1_verify.sql`, `2_failure_test.sql`), make each one
runnable whole (no "select this part"), and claim them like any other file.

**A test script returns its checks as a result row, from a block that undoes itself.**
Never a deliberate final error: the runner would record that as a failed run. The
block raises its own error inside an inner `begin ... exception`, keeps the results in
a variable, hands them on with `set_config`, and ends with `select current_setting(...)`.

### Queue SQL, don't hand it over

Migrations, data changes and test scripts go through the queue, not to Alex for the SQL
editor:

```
node scripts/sql-queue.mjs <file.sql> --describe "<one sentence>" [--expect <n,unknown,...>] [--test]
```

- **`--describe`, always.** One plain sentence: what it inserts, updates, deletes or
  creates, in which table, and roughly how many rows.
- **`--expect` for inserts, updates and deletes.** One value for each, in order: the
  row count, or `unknown` said explicitly when it can't be known. A wrong number
  disables Approve. Schema changes need none. A do block gives no count, so say what
  it changes in `--describe`.
- **`--test` for verification and test scripts.** One run, undone, with no Approve. It
  takes no `--expect`.

Report the action id it prints, and stop. Claude reviews it and issues the link; the
run id comes back to Claude, not to you. **Queued is not applied.**

**The SQL editor is the fallback, for two things only:** what the runner can't run (it
refuses at queue time and says why: `create index concurrently`, an index on an
existing table, an update or delete with no `where`, and the like), and anything
holding a secret such as a password, which never goes in the queue. Then give Alex the
file and say which of the two it is.

Every migration that creates a table, view or function grants it explicitly in the same file, and gives anon nothing. See Rule 2b in `.claude/skills/mcp-platform/SKILL.md`.

### Do not pick the number until the last moment

**Write new SQL under a temporary name first:**

```
supabase/migrations/_pending_<owner>_<purpose>.sql
```

for example `supabase/migrations/_pending_inbox-ui_add_filter_column.sql`. Claim
that path like any other file and work in it.

**Give it its real number only when you are about to queue it, and only
after `gitsync`.** At that point, and not before, run
`claims.cmd number-migration <the _pending_ file>` on its own: it gives the next
number past every checkout, every number already issued and every number claimed,
and claims it for you. Write the numbered file and delete the `_pending_` one. The
guard allows that delete because you hold the claim on it. Never take a number from
a folder listing: 197 to 220 were numbered that way, and two threads both took 219.

**Why.** Claims cannot catch this one. Two threads each decide the next migration
is `084`, and because the two files have *different names* — `084_add_filter.sql`
and `084_backfill_tags.sql` — nothing conflicts, nothing is claimed twice, and the
guard has nothing to object to. Both land, the sequence has two `084`s, and which
one ran first is now unknowable. Numbering last, after a sync that shows every
number already taken, is the only point at which the answer is actually correct.

The temporary name sorts away from the numbered files and says whose it is, so a
`_pending_` file sitting in `git status` is a visible loose end rather than a
mystery. Renumber before asking Alex for a commit — a `_pending_` file has no
business in history.

supabase/migrations/ now holds three kinds of file, and the MOVED header on each
says which: schema changes that must be applied in order; one-off data repairs
and backfills, applied once; and read-only diagnostics and verification queries
that are never "applied" at all. Do not treat the folder as a sequence to run end
to end, and do not assume a numbered file was ever run — only a run id, or Alex
saying so, shows that it was. Files 001-030 are schema changes; 031-056 are mixed, and
were renumbered from docs/ on 2026-09-18.

## Supabase verification queries

Most checks now go through `--test` above, or Claude's `get_sql_read`. When you do
ask me to run more than one SELECT query in the Supabase SQL Editor,
combine them into a single query that returns one JSON object, so I can run it
once and paste back a single result. Use this pattern:

select json_build_object(
  'descriptive_name_1', (select json_agg(t) from (<query 1>) t),
  'descriptive_name_2', (select json_agg(t) from (<query 2>) t)
) as result;

Rules:
- Give each section a descriptive key that says what it checks.
- Wrap every query in the (select json_agg(t) from (...) t) form, even if it returns one row.
- Do not end inner queries with a semicolon.
- This applies only to read-only SELECT checks. Migrations and anything that
  changes data stay as separate statements.

## Tests and build in alfred-v5

**Run tests with:**

```
CI=true npx react-scripts test --watchAll=false
node --test "scripts/lib/*.test.mjs"
```

The first is the app suite. The second is the scripts that stay in alfred-v5:
inventory, schema snapshot, sql-queue and not-an-artist. It runs under `node --test`,
needs no `npm install`, and is not picked up by the first. Run both at the end.
Tests for claims, the hooks, clip and the git commands live in the switchboard
repo and run there. Function tests run with
`node --experimental-strip-types --test <file>`.

Never plain `npx jest`. While working, run only the test files related to the
change; run the full suite once, at the end.

`package.json` overrides jest's `testMatch` with globs that contain no
`<rootDir>`. Do not "tidy" that back to the CRA default: with `<rootDir>` in it,
a worktree path under `.claude/` survives normalisation as an escape and the
suite finds no tests at all. The reason is in `jestNote` beside it.
