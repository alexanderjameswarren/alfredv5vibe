---
name: "sf-diagnose"
description: "Diagnose a problem a Salesforce client reports (Team IMPACT, ActBlue clients): trace the code, form hypotheses, confirm them with Switchboard reads by link, and record findings. Use alongside salesforce-workflow and cli-workflow."
---

# Salesforce diagnosis

Skill version: 2026-11-12b

Use when a client reports problems in their Salesforce org and the causes aren't
known yet. This thread is the **diagnosis and planning thread**, and it stays the
hub until every fix closes: it finds the causes, defines the fixes, gets them
approved, hands each approved fix to its own thread in the right order, and takes
back any new problem a fix thread finds. Fixes go through salesforce-workflow.
cli-workflow governs run tags, prompts, reports and the step format.

## Starting

1. **One thread per project code, always.** This thread gets the diagnosis code,
   chat "Not done <code> <Client> <few words>" (the client's name is always in a
   client chat's title, for example "Not done cd_ab_diagnose-r4m Common Defense
   ActBlue sync"). One Alfred Project for the whole engagement, under client work,
   Active, with this code as its `project_code`.
2. **Ask for the client folder** first: its absolute path (for example
   `C:\Users\Alex\projects\actblue\common-defense`). Never guess it. With no repo
   there yet, Alex retrieves the metadata **from production** (main must match
   production), commits it as "Baseline from production <date>" and pushes it to
   a private GitHub repo before anything else.
3. **Register the orgs and the project, in this order** (Alex, each step's copy box
   starting with `Set-Location "<absolute client folder>";`):
   1. `sf org list`, to see which aliases exist;
   2. `sb org add <alias> --client <client slug>` for each org the work needs;
   3. `sb org verify <alias>` for each;
   4. `sb project add <code> --client <client slug> --repo "<absolute client folder>"`,
      so its tile and Send link work. No worktree: diagnosis is read-only, in the
      main folder.
4. **Security check**: salesforce-workflow Stage 0 (no Salesforce MCP, read-only
   permissions, worktrees excluded, `sb org verify`, the production login check),
   plus each org's read level, as a short pass or fail list. Note each sandbox's
   kind (developer, partial, full): it decides how real a data rehearsal can be.
5. **Freshness**: salesforce-workflow Stage 1 for the sandbox, and the repo against
   production (loop step 2).

No Drive folder at the start: it is made when the first file that can't go in
git exists (see "Drive folder" under Rules).

## The loop

1. **Intake** (this chat, no tools). Number every problem: **P1, P2, …**, each
   with the symptom in plain words, when it started, who is affected, and example
   records **by Id only**. Ask for what's missing before anything runs. Use the
   numbers everywhere after this: prompts, reads, findings, fixes.
2. **Is the repo current?** With main clean (`git status` empty), retrieve the
   metadata the symptoms touch from production **straight into the client repo's
   main folder** (Alex runs the retrieve, since the guard refuses production for
   the CLI), then `git --no-pager -c core.safecrlf=false diff --stat` and
   `git diff` are the comparison. Never a scratch folder: sf refuses an output
   folder outside the project. Any difference means main doesn't match production,
   which is often the bug itself:
   - **admin-only** (reports, settings, sites): committed as "Sync from production
     <date>";
   - **code** (classes, triggers, lwc, aura, pages): stop and show it before
     anything else.
   To undo a retrieve, `git restore .` and `git clean` on the retrieved paths, as
   Alex's steps.
3. **Trace the code, no data.** Per problem, the CLI follows the path the symptom
   takes: triggers, record-triggered flows, classes, scheduled jobs, validation
   rules, managed-package boundaries, and outside systems the records sync to. It
   reports **hypotheses**, each naming the read that would confirm or rule it out
   (object, level, fields, filters).
4. **Reads, one link at a time, lowest level first.** The CLI may propose several;
   Claude trims each to the least that answers it, orders them (counts first), and
   gives one link per reply with `queue_switchboard_sf_read`: a count, then Ids with
   dates, and `data` with named fields only when a hypothesis needs field values.
   Fetch with `get_switchboard_sf_result` when the "sf <id> done" line arrives; it
   comes back once. One live link per project code.
   - **An sf read link ends the reply**, the same as git and SQL links, and
     nothing else in that reply asks for a reply: **a decision never shares a
     reply with a link**, and neither does a step asking for a paste-back.
   - **After a link is approved, the next reply only waits** for the done line,
     then reads the result, before anything new.
5. **Talk it over.** Claude summarises what each read showed. Raw rows never go
   into a CLI prompt: the next prompt carries the summary ("12 of the 3,000 have a
   parent Id pointing at a closed record, oldest from March").
6. **Repeat** 3 to 5 until each problem's cause is shown by data, not just
   plausible.
7. **The diagnosis: every problem, the same parts.** Per problem number:
   - the cause, and the read that showed it;
   - the code fix (files, what changes);
   - settings changes (Setup steps Alex makes);
   - the data fix (count, method, and what fires on save: triggers, flows,
     emails, outside syncs);
   - **what can't be undone**: emails sent, records synced to ActBlue or any
     outside system, anything a backup can't reverse. The client sees this before
     approving;
   - the tests;
   - the risk, the rollback plan, and the failure threshold that would trigger it
     ("if X after deploy, roll back");
   - the effort, in CLI steps.
8. **Group the problems into fixes, and call out every split.** A fix is what
   ships and rolls back together. Claude proposes the grouping and says plainly
   **"split point"** wherever a fix could become two, with the reason:
   - **Default to one fix (one thread) when parts depend on each other in order**,
     for example code that must be in production before a data update. The thread
     runs them as ordered stages: deploy, verify, then the data operation.
   - **Split** when a part needs its own approval, runs much later, or can ship
     alone with no dependency.
   - **Problems whose fixes touch the same components are one fix**, or deploy
     one at a time: the second waits until the first's verification window closes,
     so either can still be rolled back cleanly.
   - **Alex can override any split** and ship parts as one; record the choice and
     why in the README.
   - **When split fixes depend on each other**, record the order (fix A before
     fix B). A sequence number in the codes helps reading; the order is enforced
     by the hand-off and the gate (step 12).
9. **Findings in the repo**, written by the CLI to
   `diagnoses/<yyyy-mm-dd>-<slug>/README.md`: the numbered problems, the hypotheses
   and which held, the exact reads (object, level, fields, filters, action ids), the
   counts, step 7's definitions, step 8's grouping, splits, overrides and order,
   and the Drive path. **No personal data**: Ids and counts only.
10. **The client findings doc**: a doc artifact, plain language, per problem: what
    was wrong, what the fix does, what the data change touches (counts), what can't
    be undone, the risk, and the effort. No Ids, no personal data. Alex emails it
    for approval.
11. **Pause for approval.** Set the Project's plan to waiting on the client
    (`waiting_on_kind` decision, the line saying which fixes are awaiting
    approval), so it doesn't read as stalled. When approval comes, record the date
    and exactly what was approved; each fix's PLAN.md carries it.
12. **Hand-off, per approved fix, in order:**
    - an Alfred intention for the fix, under the Project;
    - a slice when Alex wants one: one slice for a batch approved together, a
      slice each when approvals come apart;
    - a new project code for the fix; Claude tells Alex to start a new thread and
      gives its kickoff text in a copy box: the fix's code and chat name, the
      problem numbers, the step 7 definition, the diagnosis README path, the Drive
      path, the approval record, any fix it depends on, and "follow
      salesforce-workflow from Stage 2";
    - **a dependent fix's kickoff is given only when the fix it depends on has
      reached its gate** (deployed and verified, or whatever step 8 named), and its
      first prompt is a read-only **gate check**: the prerequisite is in production
      (main's history, its PLAN.md marked deployed, the component's metadata in
      production). If the check fails, it stops.
    Unapproved fixes stay in the README and the findings doc; nothing starts.

## When things change mid-fix

- **A fix thread finds a new problem**: it stops and reports. The problem comes
  back here as the next number (P4), through the loop. A fix's scope never grows
  quietly, and anything outside what the client approved needs approval first.
- **A fix doesn't work in the sandbox**: the hypothesis was wrong. Back here to
  the loop, rather than patching in the fix thread.

## Rollbacks

A rollback is its own thread, project code and Alfred intention under the same
Project, started from kickoff text the fix thread writes. It runs the PLAN.md
rollback plan. **Reverse order**: what went in last comes out first (usually the
data, then the code). When the new data only makes sense to the new code, or the
old code would re-break the data, code and data roll back together in one thread,
in the order PLAN.md names. What can't be undone (step 7) is reported to the
client, not promised.

## Rules

- **Claude reads; the CLI never does.** The guard refuses the read tools and
  `sf data` in CLI sessions.
- **Every read is approved by Alex's click**, and the page shows exactly what will
  be read. Production full data shows a large PRODUCTION FULL DATA banner.
- **Minimise.** Count before rows, Ids before fields, the fewest fields that test
  the hypothesis. Whatever Claude reads stays in this chat's history even after
  Alfred deletes it, so summarise instead of repeating rows; for names, emails or
  amounts, offer Alex the query to run himself in the Developer Console.
- **A Developer Console step starts by signing in**: a terminal step
  `sf org open --target-org <alias>` (the console is under the gear menu), so the
  org and the sign-in are never left out.
- **Read levels are set by Alex in his terminal**, per org (see salesforce-workflow,
  Salesforce reads). If a read is refused for its level, say so and ask; never
  route around it.
- **Never claim a cause the data hasn't shown.** Say what's confirmed, what's
  likely, and what read would settle it.
- **Where things live**: documents of record in the client repo (diagnosis, fix
  plans, rollback plans, data-ops); files that can't go in git in the Drive folder,
  each with a delete date (the end of the verification window plus a buffer) when
  it holds personal data; the findings doc for the client; status in Alfred only.
- **Drive folder**, for files that can't go in git, in Alex's Secorus Google
  Drive. **Made only when the first such file exists** (usually a data-ops
  backup), never at the start. Its path mirrors the projects folder exactly, then
  the project name, then the project code: for
  `C:\Users\Alex\projects\actblue\common-defense`, that is
  `actblue/common-defense/<project name>/<project code>/`. Claude creates it with
  the Google Drive connector when that is connected to the Secorus account, and
  otherwise gives Alex one step. The repo's README for each diagnosis, fix or data
  operation names its Drive path.