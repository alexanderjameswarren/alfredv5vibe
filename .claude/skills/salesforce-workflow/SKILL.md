---
name: "salesforce-workflow"
description: "Runs Salesforce client work (Team IMPACT, ActBlue, any client org) through Switchboard, from a claude.ai chat that drives the CLI. Use for ANY Salesforce change, however small - a query filter, deleting classes, a new field, a flow - and whenever Alex mentions a sandbox, a deploy, production, a scheduled job, or a client's Salesforce repo. Use it alongside cli-workflow, which still governs run tags, prompts, reports and the step format."
---

# Salesforce workflow (with Switchboard)

Skill version: 2026-11-12b

Client work is real work on someone else's system. Alex cares most about the
**code changes**: he must always be able to say exactly what changed, and nothing
reaches production that he has not seen and run himself.

This skill sits on top of **cli-workflow**. Run tags, the Window line, the scope
block, Send links, the copy-box rule, the step format, the report format and the
one-prompt-at-a-time rules all come from there. This skill adds what is different
for a Salesforce client repo.

## The hard rules

1. **Claude never touches production.** No deploy, no test run, no data, no
   scheduling. Production steps are Alex's, in his own terminal or in Setup, from
   steps this chat writes. The guard refuses anything aimed at production anyway.
2. **Claude never runs anonymous Apex, never writes records, and never schedules
   or aborts a job.** Claude reads records only through Switchboard reads by link
   (see "Salesforce reads"), never through a CLI. Scheduling is always a step for
   Alex (see "Scheduled jobs").
3. **One fix, one project code, one worktree, one branch.** Even two tiny fixes
   with no overlap get two worktrees, so each can be reviewed, deployed and rolled
   back on its own.
4. **Nothing is deployed until Alex has reviewed the change list.** The CLI makes
   the change and stops. The report carries the real change list (attached by
   clip, not written by Claude). Claude checks it against the expectations, then
   Alex checks the same thing in VS Code's Source Control panel. Only then does the
   deploy prompt go out. The one exception is the test-only loop (Stage 6): once
   the main change has passed this gate, rounds that change only test classes
   deploy without it, and the gate comes back for any non-test file and for the
   final change list before production.
5. **main matches production.** A fix's pull request is merged only after its
   production deploy has succeeded.
6. **Never commit, push or merge from the CLI.** Alex runs gitcom, gitpush and the
   pull-request merge (git by link, or his terminal as the fallback).

## Locations in client work

The client repo has no "MAIN" in the alfred-v5 sense, so name every location by
its folder:

- "<client> main VS Code window" (the client repo's main folder, for example
  `C:\Users\Alex\projects\team-impact`): every piece of main-folder work runs here,
  the CLI included. Alex opens it with a terminal step whose copy box is
  `Set-Location "<absolute repo path>"; code .`, then runs `claude` in that
  window's terminal. **Never a standalone terminal for the CLI.** Main-folder
  terminal steps say "<client> main VS Code window terminal".
- "<code> worktree terminal", "<code> worktree VS Code window", "<code> worktree CLI"
- **A Setup page** is opened by a terminal step, never "Chrome, production Setup":
  `sf org open --target-org <alias> --path <setup path>`, for example
  `--path /lightning/setup/ScheduledJobs/home`. The alias says which org, and the
  sign-in comes with it.

Every terminal step that must run in a particular folder starts its copy box with
`Set-Location "<absolute path>";` (cli-workflow's step format).

**Switchboard's commands** live in `%LOCALAPPDATA%\Switchboard\bin`, which is on
the user PATH: `sb`, `gitnewtree`, `gitcom`, `gitsync`, `gitpush`, `claims.cmd`
and `clip.cmd`. In PowerShell, plain `clip` is Windows' clipboard tool, so always
write `clip.cmd` and `claims.cmd` in full. Switchboard is not an npm package.

**After anything is installed** (sf, gh, Switchboard), a terminal opened earlier
cannot see it, and "not recognized" means exactly that. Put this at the start of
the next command's copy box (and if it still fails, restart VS Code):

```
$env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine');
```

## Stage 0: is the client set up?

Once per client, not per fix. Check before the first fix, as a pass or fail list.
**Two checks decide it; either one failing is a fail**, and nothing else starts:

- **A private GitHub remote:** `git remote -v` in the client repo's main folder
  names a GitHub repo, and that repo is private. **With no remote**, Alex creates
  the private repo and pushes main (`gh repo create <name> --private --source . --push`)
  before the diagnosis starts.
- **Finish mode `pr`** for the repo in Switchboard
  (`sb repo show "<absolute repo path>"`), so a fix reaches main only by a pull request merged after its
  production deploy.

The rest of the list:

- **Registered with Switchboard:** Alex runs `sb org show --client <client>`. If
  nothing is listed, setup is `sb client start <client> --adopt <folder>` (or
  `--repo <url>`), which Alex runs; it asks the setup questions. Claude writes the
  answers out for him in advance, each with a one-line reason.
- **No Salesforce MCP in the repo:** no `.mcp.json` naming an org, and no
  `mcp__salesforce-*` permissions or `enabledMcpjsonServers` in a tracked
  `.claude/settings*.json`. The guard and `--adopt` refuse the folder otherwise.
- **Permissions kept read-only:** a tracked `.claude/settings.local.json` should
  allow only read-only commands. Standing permissions for `sf project deploy`,
  `sf apex run`, `git commit` or anything naming the production alias are removed.
- **Worktrees excluded:** the repo's `.git\info\exclude` holds `.claude/worktrees/`
  when the repo keeps its own `.claude/` folder.
- **gh installed and signed in** when the repo's finish mode is `pr`.
- `sb org verify <sandbox alias>` says ok for both the org ID and isSandbox.
- **A claims file exists** (`sb client start` creates it; for an older client,
  Alex runs `claims.cmd init` in the client repo's main folder).
- **Production login (Alex only):** Alex runs
  `sf org login web --alias <production alias> --instance-url https://login.salesforce.com`
  if needed, then `sf org display --target-org <production alias>` and confirms
  the instance URL has no `--` and no `.sandbox`, and the org ID is not the
  sandbox's. Feedback is pass or fail, never the output: it shows a token.

## Stage 1: is the sandbox fresh enough?

Ask before every fix, and decide with Alex:

1. **Last refresh date:** the Sandboxes page, opened with
   `sf org open --target-org <production alias> --path /lightning/setup/DataManagementCreateTestInstance/home`,
   then the sandbox's "Last Refresh" date.
2. **Has production changed since?** Anyone else deploying or configuring.
3. **Who else uses it?** The sandbox page's "Last Refresh By" and the client's
   team. A refresh wipes everyone's unfinished work in that sandbox.

Recommend a refresh when it is older than about a month, or when production code
or configuration that the fix touches has changed since. A refresh:

- needs Alex to confirm nobody has work in progress there, and that he is in the
  sandbox's Sandbox Access group (or he locks himself out);
- gives the sandbox a **new org ID**: afterwards `sf org logout` the old alias,
  log in again, and run `sb org verify`. If the org ID no longer matches the
  Switchboard entry, stop and ask in the Switchboard thread how to update it;
- is followed by a retrieve into the client repo's main folder and a review:
  `Set-Location "<absolute repo path>"; sf project retrieve start --source-dir force-app --target-org <alias>`
  (the <client> main VS Code window terminal), then
  the change list **for code first** (classes, triggers, lwc, aura, pages,
  components), then everything else. Code that changed means production and the
  repo disagree: stop and look before committing. Admin-only changes (reports,
  settings, sites) are committed as "Refresh from <sandbox>", by a gitcom link.

**Git steps follow cli-workflow's "Git by link"** throughout this skill: gitcom,
gitsync, gitnewtree and gitpush go to Alex as a `queue_switchboard_git` link, one
per reply, and the reply ends there. The terminal command is the fallback, given
as a step in the step format.

Use `git --no-pager -c core.safecrlf=false diff --stat` for the change list, so
line-ending warnings and the pager do not get in the way.

## Stage 2: start the fix

A fix normally comes from a diagnosis thread (sf-diagnose), which stays the hub:
it starts in its own new thread, from the kickoff text that thread wrote (problem
numbers, definition, approval record, Drive path, and any fix it depends on).
**One thread per project code, always.** **One fix is what ships and rolls back
together**; a fix with ordered parts (code deployed and verified, then a data
update) runs them as stages in this one thread.

**A fix that depends on another starts with a gate check**: its first prompt is
read-only and confirms the prerequisite fix is in production (main's history, its
PLAN.md marked deployed, the component's metadata in production). If not, stop.

In this order:

1. **Project code and chat name**, for example `ti_job_filter-x4k`, chat
   "Not done ti_job_filter-x4k Job filter".
2. **In Alfred**: the fix is an intention under the client engagement's one
   Project (the diagnosis created it). With no diagnosis thread (a small, known
   change), create the Project as cli-workflow's "Starting a new project" says.
3. **Register the project** (Alex, <client> main VS Code window terminal):
   `Set-Location "<absolute repo path>"; sb project add <code> --client <client> --repo "<absolute repo path>" --tests <TestClass>`
   so its tile and Send link work and `sb test` knows its test classes.
4. **Worktree**: `gitnewtree <code>` by link, with `repo` set to the client repo's
   absolute path. It branches from origin/main; main must be committed and pushed.
5. **The read-only plan prompt** (Stage 3), in the new worktree's window.

## Stage 3: the plan prompt finds the exact change

The first prompt is read-only and makes the expectations possible. It must:

- find every file the fix touches and report, for each: the path, the exact
  current lines involved (quoted), and their line numbers;
- for a class with tests: the test class, its current methods, and the class's
  current coverage if it can be read from the repo (otherwise say so);
- for a deletion: everything that references the classes (other classes,
  triggers, flows, pages, LWC, aura, custom metadata, scheduled jobs it can see in
  the repo), because a referenced class cannot be deleted;
- claim nothing, change nothing, and stop.

From that report Claude writes the **expected change list** for the build prompt.

## Stage 4: the build prompt, with expectations

The build prompt's scope names exact files, never folders. It carries an
"Expected changes" block that says, per file, what will change and nothing else:

```
Expected changes (anything else is a defect, stop and report it):
- force-app/main/default/classes/MapExportService.cls: one line changed, the
  WHERE clause near line 722 gains "AND Status__c != 'Closed'".
- force-app/main/default/classes/MapExportServiceTest.cls: two test methods
  added near line 880; no other line changes.
- No other file changes. No reformatting, no API version bumps, no renames.
```

The prompt also tells the CLI:

- claim exactly those files first, with
  `claims.cmd claim --run-tag <run tag> <file> <file> ...`, and that **sending
  this prompt is Alex's approval of those claims**, so the CLI does not stop to
  ask; deletions are claimed too;
- change only those lines, with Edit and Write (the guard refuses file changes
  made through the shell), and stop when the change is made: **no deploy in this
  prompt**;
- hand every report back by writing it to `.clip/last-report.md` and running
  `clip.cmd --tag <run tag> --last`. The shared Switchboard rules (loaded at
  session start in every repo on Switchboard's list) already say this, so a
  prompt only needs to repeat it for a session started before the rules were
  installed. A report held for personal data is released by Alex with
  `clip.cmd release <id>`;
- end with "Scope vs changes" and "Next step's scope", as cli-workflow requires.

## Stage 5: the review gate

When the build report comes back:

1. **Claude checks the attached change list** ("Changes (attached by clip, not
   written by Claude)") against the expectations, file by file and line by line,
   and says plainly whether they match. Any extra file, extra line, whitespace
   churn or metadata change is raised as a defect. A missing change list is
   itself a defect: stop.
2. **Alex checks it himself.** The step tells him exactly what he should see, so
   he can confirm at a glance:
   - **<code> worktree VS Code window:** open Source Control (Ctrl+Shift+G).
   - Expected: exactly N files. File A: one line changed near line 722, the
     filter added. File B: two methods added near line 880. Nothing else.
   - Feedback: pass or fail, or a screenshot.
3. Only after both pass does the deploy prompt go out. A mismatch goes back to
   the CLI as a follow-up (`s3b`) to undo the extra changes, then the gate again.

## Stage 6: sandbox deploy and tests

The deploy prompt asks the CLI to run `sb deploy <sandbox alias>` then
`sb test <sandbox alias>` in the worktree. The wrapper:

- deploys only this thread's claimed, changed files, under a short sandbox lock;
- runs only the project's test classes (RunSpecifiedTests);
- first retrieves the same components from the sandbox and refuses, with the
  diff, if someone changed them through Setup. That is a stop: show Alex the diff
  and decide with him;
- refuses click-tier changes until Switchboard's Phase 5. **Click tier includes
  any deletion** (destructiveChanges), field deletes or type changes, profiles,
  permission sets adding system permissions, org settings, and triggers or active
  record-triggered flows in partial and full sandboxes. For those, Alex deploys to
  the sandbox by hand (Stage 7's commands with the sandbox alias).

If `sb deploy` refuses because it cannot confirm the org is a sandbox, do not
log in again on a guess: have Alex run `sb org verify <alias>` in the worktree
terminal first, and take a mismatch to the Switchboard thread.

The report must give: the deploy result, a pass or fail line for every test
method (`sb test` prints them, failures first, with the cause but never the
message text, which can hold record data), and **coverage per changed class**,
which `sb test` also prints. Every changed class needs at least 75%, and coverage
must not drop. Then Alex checks the behaviour in the sandbox, with test steps in
cli-workflow's testing format.

### The test-only loop

Getting coverage up often takes several rounds while the CLI learns the org. Once
the main change has passed the review gate, the deploy prompt may let the CLI
loop on its own: edit the test class only, `sb deploy`, then
`sb test <sandbox alias> --round-note "<one line: what this round changed>"`
(`--new-loop` on the first round). Each round is recorded in
`.clip/test-loop.json`, never committed, and `sb test` ends with one verdict:

- `CONTINUE: round N, <why it's progressing>`: go on;
- `STOP: same error twice`, `STOP: coverage flat for 2 rounds` (only while a
  changed class is under the minimum), `STOP: ceiling of 15 rounds` or
  `STOP: coverage dropped`: stop and report every round's note;
- `DONE: all tests pass and every changed class is at or over 75%`.

The numbers are per-repo settings in repos.json (`testCoverageMin`,
`testSameErrorStop`, `testFlatCoverageStop`, `testMaxRounds`), tuned after
dogfooding. A round that touches anything but a test class ends the loop and goes
back through the review gate.

**Smart-test rules** for every round, checkable from the report:

1. **Read the org before writing test data.** For each object the tests create:
   its required fields, validation rules, record types, and the triggers and
   flows that fire on it (from the repo, plus a describe in the sandbox).
2. **Every round names its change** in its `--round-note`, so no fix is retried.
3. **Fix causes, not symptoms.** Never catch an exception or skip an assertion to
   make a test pass, and never `SeeAllData=true`.

## Stage 7: production (Alex only)

Claude writes the steps; Alex runs them, always in his own terminal, never by
link. Always validate first, then quick-deploy the validated job, so what runs in
production is exactly what was validated. The first step of this stage repeats
Stage 0's production login check.

Every production step runs in the **<code> worktree terminal**, and its copy box
starts with `Set-Location "<absolute worktree path>";`. The `sb prod` commands
refuse inside a Claude session, so they are always Alex's.

**Validate**: `sb prod validate <code>`, once built (switchboard_prodrepo-w3k);
until then:

```
Set-Location "<absolute worktree path>"; sf project deploy validate --source-dir "<absolute path to file1>" --source-dir "<absolute path to file2>" --target-org <production alias> --test-level RunSpecifiedTests --tests <TestClass1> --tests <TestClass2>
```

- the `--source-dir` paths are the project's changed files only
  (`git diff --name-only` against main), each as an absolute path in the worktree;
- Alex reports the Job ID and the number of tests run, and **the test count must
  match the last `sb test` for this code**. A different count is a stop, before any
  quick deploy.

**Deploy** what was validated: `sb prod deploy <code>`, once built
(switchboard_prodrepo-w3k); until then:

```
Set-Location "<absolute worktree path>"; sf project deploy quick --job-id <job id> --target-org <production alias>
```

- **any component reported Unchanged is a failure**: it means production didn't
  get what was validated. Stop and look;
- afterwards, **retrieve the deployed components from production** into the
  worktree (`sf project retrieve start --source-dir "<absolute path>" ...`) and
  compare with `git diff`: no difference, ignoring line endings, is a pass. Any
  difference is a failure.

**Data changes** use `sb prod dataop <code> --plan <file>`, once built
(switchboard_prodrepo-w3k); until then the "Data operations" steps below, by hand.

**Deletions** use a manifest pair the CLI writes in the worktree (scope it:
`manifest/destructive/package.xml`, empty of members, and
`manifest/destructive/destructiveChanges.xml`, listing the classes):

```
Set-Location "<absolute worktree path>"; sf project deploy validate --manifest "<absolute worktree path>\manifest\destructive\package.xml" --post-destructive-changes "<absolute worktree path>\manifest\destructive\destructiveChanges.xml" --target-org <production alias> --test-level RunSpecifiedTests --tests <a test class that still exists>
```

Before any production deploy, Claude names: the exact files, the test classes,
what changes for users, and anything Stage 8 must follow.

## Stage 8: after production

In order:

1. Post-deploy configuration, if any (see "Often forgotten" below), and any
   scheduled job (see "Scheduled jobs").
2. **Finish by link**: `queue_switchboard_git` with the code and gitpush mode
   `finish` (finish mode `pr` pushes the branch and opens the pull request). The
   link ends the reply. When the `git <id> done` line arrives, Claude reads the
   run with `get_switchboard_run` and **takes the pull request link from its
   result**, never asking Alex for it. Finish by link closes the worktree's VS Code
   window once that is built (switchboard_prodrepo-w3k); until then, Alex closes
   it before clicking. The fallback is the terminal step
   `Set-Location "<absolute repo path>"; gitpush <code> finish`.
3. Alex merges the pull request (GitHub, or `gh pr merge`), then pulls main.
   main now matches production. Merge right after the deploy succeeds, even when
   verification takes days. Mark PLAN.md deployed (date and job id).
4. **Post-deploy checks**: PLAN.md's "what to check after", including every
   scheduled job rescheduled exactly as it was, and the failure threshold.
5. **Verification window**: a pause point (below), waiting on verification (what
   to check, and when). The thread stays open until Alex confirms the fix worked.
   A data stage that waits on verification runs only after it.
6. Closeout: mark the fix's intention done, set a delete date on any Drive file
   holding personal data, and rename the chat. The Project closes only when its
   last fix is done; the diagnosis thread closes with it.

## The fix plan and rollback plan (in the repo)

Before Stage 7, the CLI writes `fixes/<code>/PLAN.md` in the client repo,
committed with the fix's pull request: the problem numbers, the approval record
(date and exactly what was approved), any fix this one depends on, the files,
settings steps and data operations, the deploy order, what can't be undone, what
to check after, the failure threshold that triggers a rollback, the Drive path,
and the **rollback plan**:

- **reverse order**: what went in last comes out first;
- code: redeploy the previous versions from main's commit before the merge
  (validate, then quick deploy), or a destructive deploy for added components;
- settings: the old values, step by step;
- data: the data-ops backup file and the command that loads it back;
- when the new data only makes sense to the new code, code and data roll back
  together, in the order named here.

## Before production: check for drift again

Right before Stage 7's validate, retrieve the fix's components from production
and compare them with main, as Stage 6 does for the sandbox. A difference means
someone changed production since the sandbox test: stop and decide with Alex.

## When things go wrong

- **A new problem found mid-fix**: stop and report. It goes back to the diagnosis
  thread as the next problem number. The scope never grows quietly, and anything
  outside what the client approved needs approval first.
- **The fix fails in the sandbox**: the cause was wrong. Back to the diagnosis
  thread, rather than patching here.
- **A production deploy fails**: a Salesforce deploy is all or nothing, so nothing
  is half deployed. Read the errors, fix in the worktree, back through the gate.
- **A data operation partly fails**: record the failure count and the failed Ids
  (data-ops), and rerun only those, after the cause of the failure is understood.
- **Two fixes on the same components** deploy one at a time; the second waits
  until the first's verification window closes.

## Pause points

There are three:

1. the client's approval of the fix (in the diagnosis thread);
2. the client's approval before production, when the client wants it (after
   Stage 6);
3. the verification window after production (Stage 8).

**At a pause point, before the reply ends**, Claude does all three, so it reads as
paused, not stalled, and can be picked up cold:

1. **An Alfred intention** under the Project, in the Work context, due on the
   check's date, **with the reminder on it**. Its note opens with one sentence on
   where things stand, then the steps for that day, then the line to paste into
   this chat to resume.
2. **`update_project_plan`** with where_now, next_step, waiting_on and the date;
   `waiting_on_kind` is `decision` for a client approval and `alex` for a
   verification window.
3. **`log_activity`** with kind progress.

**Each check's query covers every day since the last check**: a daily count over
the whole gap (for example `GROUP BY DAY_ONLY(CreatedDate)` over
`LAST_N_DAYS:<n>`, n being the days since the last check), never only
`YESTERDAY`, so a missed day can't hide a failure.

## Rollbacks

A rollback is its own thread, project code and Alfred intention under the same
Project, started from kickoff text this thread writes. It runs the PLAN.md
rollback plan, with the same rules: Alex runs production, sandbox first when time
allows, and main ends matching production. What can't be undone is reported to
the client, not promised.

## Scheduled jobs

Claude never schedules, aborts or reschedules a job. Alex does, from steps written
here:

- **Deploying a class a scheduled job uses** fails while the job is queued,
  unless production's Deployment Settings allow deployments with pending jobs.
  Before the deploy, Alex notes the job's name, schedule and next run (the
  Scheduled Jobs page:
  `sf org open --target-org <production alias> --path /lightning/setup/ScheduledJobs/home`),
  aborts it, deploys, then reschedules it exactly as it
  was.
- **Rescheduling:** the Apex Classes page
  (`sf org open --target-org <production alias> --path /lightning/setup/ApexClasses/home`),
  Schedule Apex, for weekly or monthly schedules. A cron schedule (hourly, specific minutes) needs one line of
  anonymous Apex that Alex runs himself in the Developer Console; Claude writes the
  line, with the cron expression explained in words, and Alex checks Scheduled
  Jobs afterwards.

## Data operations (Alex only)

Some fixes need records touched: a re-sync, a backfill, a cleanup. Claude drafts;
Alex runs, sandbox first. Every operation leaves a record in the repo, so months
later anyone can see exactly what was done.

**Which tool:**

- **Logic must re-run** (a class or trigger recomputes the records): a **Batch
  Apex class**, written with its test, through the normal stages (gate, sandbox
  deploy and tests, production validate and quick deploy). Alex starts it with one
  line in the Developer Console (`Database.executeBatch(new <Class>(), 200);`),
  which Claude writes. Batches of 200 keep each chunk inside governor limits; a
  single anonymous Apex run over thousands of records does not. When the job is
  done, a **destructive deploy deletes the class and its test** from production
  (click tier: Alex runs it, Stage 7's deletion commands), so nothing that must
  never run again stays in the org.
- **Fields set to known values**: a **reviewed CSV**. First a read-only export of
  the current values (Id and each field to change) as the backup and undo file,
  then the change CSV (Id and new values), checked row by row, loaded by Alex with
  `sf data update bulk` or Data Loader.
- Workbench only for quick read-only checks: it leaves no record and can't be
  repeated exactly.

**Before either:** a read-only count of the records in scope; then the list of
what fires on that object (triggers, record-triggered flows, workflow rules and
validation, from the repo) and what each would do, including any email; decide
with Alex whether to use any bypass the org has. Rehearse in the sandbox (a
developer sandbox has no production data, so the batch is proven by its test
class there). Afterwards, the same count again and the batch job's failure count.

**The record: one folder per operation, `data-ops/<yyyy-mm-dd>-<slug>/`**, in the
client repo, committed with the fix's pull request:

- `README.md`: who asked and why, what it changes, what fires, the sandbox
  rehearsal, the production run time, and the batch job Id with its success and
  failure counts;
- `apex/`: the batch class and test exactly as deployed (outside force-app, so
  they can never be deployed again by accident);
- `run.apex`: the exact line Alex ran;
- `counts-before.txt` and `counts-after.txt`;
- `destructive/`: the manifest pair that deleted the class;
- `affected-ids.csv`: the record Ids touched, and for a field fix the old and new
  values. **Ids and changed values only: never names, emails or amounts.** If the
  client's agreement doesn't allow record Ids in the repo, or a changed field is
  personal, keep the CSVs in the project's Drive folder (Alex's Secorus Google
  Drive, `<org>/<client>/<project name>/<project code>/`), with a delete date,
  and have the README point there. Say in the README which kind of sandbox the
  rehearsal ran in: a partial or full sandbox has a copy of real data, a
  developer sandbox has none.

**`sb prod dataop <code> --plan <file>`** (Alex's terminal, once built by
switchboard_prodrepo-w3k) runs the production load from a plan file in the
worktree (object, operation, CSV, expected count). It takes the backup, checks the
CSV's Ids match the backup's exactly, refuses without a recorded sandbox
rehearsal, and records the counts before and after and the failed rows.
`sb prod rollback <code>` restores from that backup. Until it is built, Alex runs
the load by hand as above, and the CLI creates the folder from this list.

## Salesforce reads (by link)

Claude reads org data only with `queue_switchboard_sf_read` and
`get_switchboard_sf_result`, in claude.ai. The CLI can't: the guard refuses both
tools and `sf data` in every CLI session.

- **Levels**, per org in Switchboard's orgs.json, each including the ones below:
  `objects` (the object list), `metadata` (one describe), `ids` (counts, and Id,
  CreatedDate and LastModifiedDate only, in fields and filters), `data` (named
  fields). Production needs production allowed; `data` on production also needs
  production full data and the contract flag. Alex sets these in his terminal
  (`sb org set` / `sb org add`; the exact flags are in Switchboard's
  salesforce/RULES.md); by link they're refused.
- **A read is structured, never SOQL:** an object, a count or 1 to 50 fields with
  a limit of 1 to 1000, and up to 10 filters (`=`, `!=`, `<`, `<=`, `>`, `>=`, or
  `in` with a list). No relationship fields. Values are typed from the object's
  describe, so dates work (`CreatedDate >= "2026-01-01"`), and an unknown field is
  refused before anything is sent.
- **Every read is approved by Alex's click.** The page shows the org, production or
  sandbox, level, object, fields, filters and limit, and a large PRODUCTION FULL
  DATA banner for `data` on production.
- **Results live in Alfred for at most 10 minutes** and come back once: fetch on
  the "sf <id> done" line, then it's gone. The read log keeps the query and row
  count, never rows.
- **Ask the least that answers the question:** a count first, then Ids with dates,
  then only the fields a hypothesis needs. Whatever Claude reads stays in the chat
  history, so summarise rather than repeat rows, and for names, emails or amounts
  ask whether Alex would rather run that query himself.
- **Raw rows never go to a CLI prompt.** The CLI gets Claude's summary.

For diagnosing a client's reported problem, use the sf-diagnose skill.

## Test class rules

- Every changed or new class keeps at least 75% coverage, and coverage never
  drops because of the change.
- Tests are written with the change, not after it.
- New tests cover the positive case, a negative or error case, and bulk (200
  records) where the code runs on many records.
- Test data is created in the test (`@TestSetup` or the method); never
  `SeeAllData=true`.
- The smart-test rules and the test-only loop are in Stage 6.

## Often forgotten after a deploy

- Field-level security, even when object permissions exist.
- Profile or permission set access for new fields, classes or pages.
- Adding a component to a Lightning page or tab (often deferred until after
  production is verified).
- Scheduled jobs that were aborted for the deploy.

Track each one as its own step, with what Alex should see when it is done.