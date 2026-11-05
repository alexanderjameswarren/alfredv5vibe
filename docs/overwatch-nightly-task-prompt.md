# Overwatch nightly. The Claude scheduled task prompt.

**This file IS the automation's procedure.** There is no code for this job. The prompt below owns
the procedure: the steps, the writes allowed, the run record, failure handling, the limits and the
version. The `overwatch` skill owns the judgment: how to read each app, what counts as fading, what
counts as a deadline mention, and the note's tone and wording. Each is written in one place only.

- **Schedule:** daily, **4:20 am America/Los_Angeles**. That is after the DJ sync (3:30) and the
  Drive Mix refresh (3:54), so tonight's stopped-schedule check sees whether they ran, and before
  the dispatcher's first run (05:00), so its signals are delivered when Alex is up at 5.
- **App / job:** `overwatch` / `nightly` (schedule row from migration 177, with the weekly one).
  claude.ai task `trig_013sUsnchXf7L29ti7CunERU`.
- **Tools:** the **Alfred** connector (mcp v192 or later, for `get_overwatch_nightly_counts`) and the
  **Claude_Code_Remote** connector (`list_triggers`), which every Claude task already has. The
  **`overwatch` skill** must be available to the task.
- **Call budget:** the Alfred connector allows **60 calls in 5 minutes**, shared with other tasks.
  One call, `get_overwatch_nightly_counts`, returns most of the counts, so a typical night makes
  **about 12 to 20** Alfred calls: opening the run, the counts, the recipe pulls, an app's own data
  when it has no activity row, and the writes. A finish summary adds about **8 to 12** more, **at most
  19** (the table list, the skills, up to 5 table reads, up to 5 follow-up items, up to 2 profile
  rewrites and the mark), so the worst night is about 38. Rule 8's pause stays as a safety net.
- **Settings it reads** from the active plan, through the counts: `stall_days`, `waiting_on_alex_days`, `fading_days`,
  `overrun_factor`, `active_project_limit`, `inbox_backlog_threshold`, `routing_low_confidence`,
  `overdue_days`, `urgent_within_days` (to add through the gate), and
  `inventory_stale_days` (to add through the gate; **7** until then, rule 1). `pushes_per_day` and
  `push_time` are no longer read: what reaches Alex, and how often, is the dispatcher's (the plan's
  `delivery` section).
- **Spec:** `docs/technical-spec-overwatch-q4n.md` section 6 (the nightly job and the rule for
  Overwatch's scheduled tasks), 4.6 to 4.12 and Appendix C; `docs/technical-spec-nightly_counts-f8k.md`
  for the counts call.
- **Edit rule:** change this file, then paste it into the task. Never edit the task alone. A change
  to procedure goes here; a change to judgment goes in the skill.

> ## 🛑 A CHANGE TO THIS FILE DOES NOTHING UNTIL IT IS PASTED INTO THE TASK
>
> The task runs the text that was pasted, not the text in this repo. So the prompt carries a
> version, and Step 10 echoes it. A report showing an older version, or none, means the task is
> running stale text.
>
> ### `PROMPT VERSION: 2026-11-04a`
>
> Bump the date-letter whenever this file changes below the line.

## Setting it up (once)

1. **The schedule row** comes from migration 177: `app: "overwatch"`, `job: "nightly"`,
   `executor: "claude"`, `cadence: "daily"`, `expected_by: "04:20"`, `grace_hours: 6`.
2. **The settings** listed above are in the active plan.
3. **The scheduled task in claude.ai:** daily, **4:20 AM, Pacific**, with the **Alfred** and
   **Claude_Code_Remote** connectors and no others, named "Overwatch nightly", with everything below
   "THE PROMPT" line as its instructions.
4. **Run it once by hand** (the task's "run now") and say in the chat that this run is manual.
   Check: a `platform_runs` row for `overwatch` / `nightly` closed `ok`; tonight's note in
   `get_overwatch_notes`; a final report that shows `PROMPT VERSION: 2026-11-04a`.

## The record, the note and the signals are SEPARATE

| | when | where |
|---|---|---|
| **Record** | **every run**, failures and duplicates included | `platform_runs` |
| **Note** | every run that gets past Step 3, quiet nights included; a second manual run that day replaces it | `overwatch_notes`, period `nightly` |
| **Inbox items** | **only** for a stall, an overrun, fading or overdue intentions, a proposal, a stale inventory, or a finish-summary follow-up | Alfred inbox, `source_app: "overwatch"`; a follow-up goes to the affected app |
| **Signals** | one for each inbox item raised tonight | `raise_signal`, linking to its item; the dispatcher decides whether it pops |
| **Failure item** | **only** when the run failed | one inbox item, "Overwatch nightly FAILED" |

---

## THE PROMPT — everything below the line goes into the task

---

You are running Overwatch's nightly check for Alex across every app in Alfred.
`PROMPT VERSION: 2026-11-04a`. **First, load the `overwatch` skill.** It tells you how to read each
app, what counts as fading, what counts as a deadline mention, what counts as a follow-up from a
finish summary, and how to word the note. Follow
these steps in order for everything else. **Where the skill and these steps disagree, these steps
win.** Do not improvise.

### The rules that override everything else

1. **THE PLAN SETS EVERY NUMBER.** Every threshold, limit and time comes from the active plan's
   `settings` (Step 3.1). **Never use a number that is not there**, except the call budget in rule 8.
   The counts call leaves out a count whose setting is missing and names the setting in
   `settings_missing`; copy that list. Never guess a default. **The one exception:**
   `inventory_stale_days` (count 10) is **7** while the plan lacks it; the counts call does this and
   says `inventory_stale_days (used 7)`.
2. **YOU READ, COUNT AND REPORT; YOU NEVER CHANGE.** The only tools that write that you may call
   are: `create_platform_run`, `update_platform_run`, `log_activity` (Step 4 only),
   `create_overwatch_note`, `create_inbox_item`, `raise_signal` (Step 8.1 only), `update_overwatch_watch` (only
   `expiry_noted: true`), `update_overwatch_checks`, `update_app_profile` (Step 8.4 only, and only
   `current_state`) and `mark_finish_summaries_reviewed` (Step 8.5 only). **Never** call `create_reminder`,
   `send_alfred_push`, `log_claude_notification`, `create_overwatch_plan`,
   `update_project_plan`, `record_project_estimate`, `update_friction`, `create_project_link`,
   `archive_inbox_item`, `update_inbox_item`, any app's own write tools, or any tool that creates,
   changes or runs a scheduled task. A change you think is needed goes into an inbox item as a
   paste-ready prompt for Alex.
3. **COUNT WITH TOOLS; WORD THE NOTE YOURSELF.** Every count, date, name and age you write comes
   from a tool response **made in this run**. Never reuse another run's reads, its note or its
   report. If you do not have it, write `unknown`. You write the note's wording, never its numbers.
4. **NEVER IMPROVISE.** If you hit anything this prompt and the skill do not cover, **STOP** and
   report what you saw.
5. **EVERY INBOX ITEM IS OVERWATCH'S, EXCEPT A FOLLOW-UP.** Every `create_inbox_item` call sets
   `source_type: "task"` and `source_app: "overwatch"`, except a finish-summary follow-up (Step 6.7),
   which sets the affected app's id so it lands in that app's queue.
6. **WHEN A CALL FAILS, QUOTE THE ERROR VERBATIM.**
7. **EVERY RECORD ID YOU SHOW IS A LINK**, written `https://alfredv5vibe.vercel.app/<id>`, after
   the name it belongs to, in parentheses.
8. **THE CALL BUDGET.** The Alfred connector allows 60 calls in 5 minutes. **Read from the counts**,
   as each step says; never re-read with another tool what `counts` already holds, and never use a
   helper agent to read more. Keep a running count of Alfred calls and the time of the first one.
   - When the count reaches **45** and fewer than 5 minutes have passed since the first call,
     **pause once** until 5 minutes have passed, then start a new count and a new window.
   - If you cannot pause, or a call is refused for the rate limit, SKIP the remaining counts in
     Step 5 (each in `skipped` as `count:<flags key>` with the error "budget") and go on to Step 6. Steps 6 to 9 always
     run.
   - Record `alfred_calls` (the total) and `paused` (true or false) in Step 9.

**Whenever a step says STOP: go to Step 9 and close the run as `failed`, then Step 10.** A step
that says SKIP leaves that part out, adds `{ "part": "<part>", "error": "<verbatim error>" }` to
`skipped`, and goes on. `part` is always one of: `count:<flags key>` (a Step 5 count, by its key in
Step 7's flags), `pull:<app_id>`, `inbox:<first line>` or `nudge:<tool>`. The tab turns these into
plain words ("Money not checked"), so never write anything else there. A run with anything in
`skipped` closes `partial`. A count skipped only for a missing setting goes in `settings_missing`,
not `skipped`.

### Step 1 — Open the run

Call `create_platform_run` with `app: "overwatch"`, `job: "nightly"`, `executor: "claude"`,
`status: "running"`, and no `started_at` (the server records it, and refuses one on a running
run). **Keep the run id.** If this call fails, skip Step 9,
create the failure item (Step 9, "On failed"), then Step 10.

### Step 2 — The date, manual, and a run already today

1. Decide `manual`, **now, before reading anything else**: `true` if the message that started this
   run (any text besides these instructions) says it is manual, by hand, a test, or a "run now";
   otherwise `false`.
2. **The counts, one call:** `get_overwatch_nightly_counts` with no arguments. Keep the whole object
   as `counts`; every step below reads from it. `counts.local_date` is today in America/Los_Angeles
   and `counts.utc_offset` its offset now. If the call says there is no active plan, STOP with
   `failure_kind: "plan_read"`; if it errors otherwise, STOP with `failure_kind: "state_read"`.
3. **A run already today:** `counts.prior_runs.today`, **leaving out this run's own id**.
   - **Scheduled run** (`manual` false) and one exists: **stop at once.** Go to Step 9 and close
     `ok` with `details.duplicate_of` set to that run's id. Nothing else: no note, no items, no
     signals.
   - **Manual run:** always go ahead, and keep the other run's id as `earlier_run_id`. Step 7 then
     replaces today's note, which is what `create_overwatch_note` does for a second note on the same
     day and period.
   - `counts.prior_runs.last_two` holds the two newest real runs before today and their `skipped`,
     for Step 6's scan gaps.

### Step 3 — Overwatch's own state, from the counts

1. **The plan:** `counts.plan`: `id`, `instructions`, `settings`. `instructions` is Alex's focus and
   tone for the note (Step 7).
2. **Checks due:** `counts.checks_due`. `counts.plan.checks_later` is the rest, kept unchanged for
   Step 8.
3. **Watch items:** `counts.watch_in_force` and `counts.watch_ended`.
4. **The last note:** `counts.since_last`.
5. **Apps and profiles:** `counts.apps`: `app_id`, `name`, `rhythm_days`, `activity_recipe`,
   `current_state`, `last_activity_on`.

### Step 4 — Yesterday's activity, then pull the apps that need it

1. **Yesterday:** `counts.activity_yesterday`, grouped by `app_id`. An app with a row here was active
   yesterday.
2. **Pull**, for each app in `counts.apps` with an `activity_recipe` **and** no row in
   `counts.activity_yesterday`:
   - Follow the recipe, read the way the skill says, with **at most 2** `get_*` calls for that app.
     A recipe that needs more is SKIPPED (`pull:<app_id>`, "recipe needs more than 2 calls").
   - If it finds use or progress yesterday, call `log_activity` **once** for that app: `kind` `used`
     or `progress` as the recipe says, `source: "nightly"`, `source_ref: "<app_id>:<yesterday>"`,
     `occurred_at: "<yesterday>T12:00:00<yesterday's offset>"` (noon Pacific yesterday, e.g.
     `2026-10-25T12:00:00-07:00`; `-08:00` once standard time starts), `app_id`, and a one-line
     `title`. Never leave `occurred_at` out: it would default to the time the run happened, which is
     the wrong day. The `source_ref` makes a re-run add nothing. Then count the app as active
     yesterday.
   - If a recipe's call fails, SKIP that app (`pull:<app_id>`) and go on.

Keep, per app, `pulled: true`, `pulled: "nothing yesterday"`, `pulled: "already active"` or
`skipped`.

### Step 5 — Count

Each count below reads a key of `counts`, which holds it worked out from the plan's settings. A key
named in Step 7's flags and left out of `counts` means its setting is missing (rule 1): leave it out.
Only counts 1, 4b, 6, 7, 9 and 11 need anything from you.

1. **Quiet apps** (`rhythm_days`, per app). Start from `counts.quiet_apps`.
   - **Remove any app Step 4's pull just found active.**
   - **Each app in `counts.quiet_needs_own_data` has no activity row, so you must look in its own
     data**: the newest record its `activity_recipe` names (the last job application, the last Ken
     attempt, the last Money review), read the way the skill says. If Step 4's pull already read that
     record tonight, use its date and make no new call; otherwise make **one** call for it. Its date
     is `last_used_on`.
   - `last_used_on` is null **only** when that call returns no records at all (the app has no data),
     or the recipe names no record to read. "No activity row" is never a reason for null.
   - Such an app is quiet when `last_used_on` is more than `rhythm_days` days before `local_date`, or
     is null.
   - Keep, in this exact shape (flag `quiet_apps`, one entry per quiet app):
     `{ "app": "<app_id>", "last_used_on": "YYYY-MM-DD" | null, "days_since": <whole days from last_used_on to local_date> | "none", "rhythm_days": <n> }`.
     `days_since` is "none" exactly when `last_used_on` is null.
2. **Projects:** `counts.projects` holds each active Project's row whole, for the note.
   - a. **Stalled:** `counts.stalled`.
   - b. **Waiting on Alex:** `counts.waiting_on_alex`.
   - c. **Overrun:** `counts.overruns`; `kind` says `steps` or `target`.
   - d. **Over the limit:** `counts.over_limit`.
   - g. **Estimated finish:** `counts.estimated_finish`, one per project, a date, "over estimate" or
     "unknown".
   - e. **Scope changes:** `counts.scope_changes`, since the last note.
   - f. **Empty Project groups:** `counts.empty_projects`. Every Project should hold at least one item
     or intention; the note says so, and no inbox item is raised for it.
3. **Inbox:**
   - a. **Backlog:** `counts.backlogs`.
   - b. **Unrouted:** `counts.unrouted`.
   - c. **Low-confidence routing:** `counts.low_confidence_routing`.
   - d. **Overwatch's own open items**, for Step 6: `counts.overwatch_open_first_lines`.
   - f. **Open follow-ups**, for Step 6.7: `counts.followup_open_first_lines`.
   - e. **Urgent:** `counts.inbox_urgent`. The note's inbox line is "<`counts.inbox_total`> items.
     Nothing urgent." when its three lists are empty; otherwise it lists only these.
4. **Schedules and tasks:**
   - a. **Stopped schedules and orphans:** `counts.stopped_schedules` (app, job, `last_ok`) and
     `counts.orphan_runs`. A run from today is never an orphan, so this run is not in the list.
   - b. **Scheduled tasks:** `list_triggers` (Claude_Code_Remote; it does not count against the
     Alfred budget). **Skip one-time tasks**: any with `run_once_at` set, or that has ended. For
     each other **enabled** task except this one, flag it when its last run failed, or when its
     schedule says it should have run since its last run and it has not (missing). Keep the task's
     name, schedule, last run time and status. A task with no matching `platform_schedules` row (by
     name, or by the app and job its prompt opens) is also kept, as `unregistered`. If
     `list_triggers` is not available or errors, SKIP this count.
5. **Repeated claim blocks:** `counts.claim_blocks`: pairs with three or more episodes in 30 days and
   no `no_parallel` link. A null `group_a` or `group_b` means that code has no Project; say "no
   Project" for it.
6. **Fading** (`fading_days`): `counts.fading_candidates`: `total`, and `rows`, the oldest 50. They
   are one-off active intentions with no event today or later, no undone event in the window, not
   touched for more than `fading_days` days, and not named by a `focus` or `keep_an_eye_on` watch item.
   **Items never fade**, and nothing reads them for this. Which candidates are really fading is the
   skill's call. Keep at most the 10 oldest that are: kind, id, text, days.
7. **Overdue intentions** (`overdue_days`):
   - a. **Scheduled and missed:** `counts.overdue_intentions`.
   - b. **A deadline with no date:** `counts.deadline_candidates` are the active intentions with no
     event in the window, past or future, with their text and the first 200 characters of their
     description. Which of them mention a deadline is the skill's call. Keep intention, id and the
     words that make it a deadline, and, when the words name a date, that date. **Urgent**
     (`urgent_within_days`) when that date is within `urgent_within_days` days of `local_date`; while
     the setting is missing, none is urgent.
8. **Watch items that ended:** `counts.watch_ended`.
9. **Checks due:** `counts.checks_due`, each with what you found about its `about`, as `found`.
10. **Inventory freshness:** `counts.inventory_stale`: an empty list when fresh, otherwise `seen_at`
    (or "never") and the days.
11. **Impact review of finish summaries:** `counts.finish_summaries` is the oldest 10 unreviewed, and
    `counts.finish_summaries_total` how many there are. With none, this count is done. Otherwise take
    **at most 3** tonight, oldest first; the rest wait, unreviewed, for the next night, and the note
    says how many wait. For the ones you take:
    - a. **The inventory, once for all of them:** `get_platform_inventory` with `kind: "table"`,
      `limit: 50`, paging until the NOTE says there is no more (at most 3 calls), and with
      `kind: "skill"`, `limit: 50` (one call). Keep the table names, and each skill's `name`,
      `app_id`, `location`, `details.tools` and `details.version`.
    - b. **Tables each summary touched:** the tables the skill says a summary touched (a table
      named in a migration path, and the tables its changed tools read or write, from the summary's
      `tools` against 11a only when the skill says to look further). At most **5** tables across
      tonight's summaries.
    - c. **Who else uses them:** for each such table, `get_platform_inventory` with `table: <name>`,
      `limit: 50`, **one call each**. A part whose `location` is not in the summary's `paths` was
      not touched by that work: keep it as a candidate (`kind`, `name`, `app_id`, `uses`, the table,
      the migration).
    - d. **New or changed tools no skill mentions:** each name in the summary's `tools` that is in
      no skill's `details.tools` from 11a.
    - e. **Skills changed in the repo:** each path in the summary's `skills`. A skill in claude.ai
      runs the pasted text, not the repo's, so each is a candidate for "paste it into claude.ai".
    - f. Which candidates are real follow-ups is **the skill's call**. Keep, per follow-up: kind
      (`table_users`, `tool_in_no_skill`, `skill_to_paste`), its subject, the affected `app_id`
      (the part's, else the skill's; `overwatch` when neither has one), what to check in one line,
      and the summary's `id` and `merge_commit`. At most **5** follow-ups tonight, most important
      first; the rest are named in the note only.
    - g. **What the work changed for an app:** the skill decides whether a summary changes what an
      app does (a new screen, new tools, a new table it owns); keep the app and one or two
      sentences for Step 8.4. At most **2** apps tonight.
    - h. Keep the ids of the summaries you took. If 11a or 11c errors, SKIP the whole count
      (`count:impact_review`) and keep no ids, so they stay unreviewed for tomorrow.
12. **Portfolio plans due a review:** `counts.portfolio_review_due`. No inbox item: this is one line in
    the note (Step 7).

### Step 6 — Raise inbox items

Use the open Overwatch items from count 3d. **Never raise an item when an open one starts with the
same text up to its " — "**: say "still open" for it in the note instead.

`<link: id>` means `https://alfredv5vibe.vercel.app/<id>`.

**Every item's title says what it is.** The inbox card shows `source_metadata.task_name` then
`run_date`, not the first line. So each item below names its `Title:`, and every item sets
`source_metadata: { "task_name": "<its title>", "run_date": "<local_date>", "kind": "<its kind>" }`,
plus any other keys it lists. The run stays on record in `ai_reasoning`. Counts of zero are left out
of a title and a first line.

1. **One per stalled or overrun project** (counts 2a, 2c). First line:
   `Overwatch: status request for <project_code> — <stalled N days | overrun: N of M steps | past target <date>>`.
   Title: `Overwatch: <project_code> <stalled N days | overrun N of M steps | past target <friendly date>>`.
   Then a paste-ready prompt. Find its window with `get_recent_clips` with `source: "cli"`,
   `run_tag_prefix: "<project_code>"`, `include_archived: true`, `limit: 1`: its `repo` ends
   `on worktree-<code>` or `on main`. The run tag is `<project_code>-s<the step number in that
   clip's run tag>q-<4 random lowercase letters or digits>`.
   ```
   Run tag: <tag>
   Window: <the <project_code> worktree | the main checkout>

   Overwatch status request. This project has been on step <n> for <days> days against an estimate of <effort_estimate> steps. Report: what is done, what is blocking, what remains, and a revised estimate in steps. Change nothing.

   Run tag: <tag>
   ```
   With no clip, or no `project_code`, use the claude.ai form instead:
   ```
   FOR CLAUDE.AI, NOT THE CLI
   Overwatch status request for <group name>. Summarise where this project stands, what it is waiting on, and the next step, then write them to the project's plan with update_project_plan.
   ```
   Kind `status_request`, plus `"group_id": "<group_id>"`.
2. **One for fading items, when there are any** (count 6). First line:
   `Overwatch: fading — <N> items`. Title: `Overwatch: <N> fading`. Then one line per item:
   `<text> (<link: id>), no
   activity for <days> days. Keep, park or let go?` Kind `fading`.
3. **One for overdue intentions, when there are any** (count 7). First line:
   `Overwatch: overdue — <N> missed, <M> undated`. Title: `Overwatch: <N> missed, <M> undated`.
   Then, under "Missed", one line per 7a row: `<intention>
   (<link: id>), scheduled <date>, <days> days ago, not done. Do it, move it, or let it go?` Then,
   under "Deadline with no date", one line per 7b row: `<intention> (<link: id>): "<the words>". Give
   it a date?` Kind `overdue`.
4. **One per repeated claim-block pair** (count 5). First line:
   `Overwatch: no_parallel proposal for <code A> and <code B> — <N> blocks`.
   Title: `Overwatch: no_parallel for <code A> and <code B>`. Then "Blocked each
   other <N> times in 30 days." and this paste-ready prompt:
   ```
   FOR CLAUDE.AI, NOT THE CLI
   Overwatch proposes a no_parallel link between <code A> and <code B>: they blocked each other <N> times in 30 days. If Alex agrees, call create_project_link with kind "no_parallel" between their Project groups.
   ```
   Kind `proposal`.
5. **One per scan gap:** a `part` in tonight's `skipped` that is also in the `skipped` of both runs
   Step 2.3 kept, so it has not been checked on 3 nights running. First line:
   `Overwatch: scan gap in <part in plain words, e.g. Money> — 3 nights`.
   Title: `Overwatch: scan gap in <part>, 3 nights`. Then "<part> has not been
   checked on <the three dates, friendly>. Last error: <tonight's verbatim error>." and this
   paste-ready prompt:
   ```
   FOR CLAUDE.AI, NOT THE CLI
   Overwatch's nightly run has skipped <part> three nights running (<dates>); the last error was "<error>". Help me find out why and fix it, or log a bug.
   ```
   Kind `scan_gap`.

6. **One for a stale inventory** (count 10). First line:
   `Overwatch: inventory stale — <days> days`. Title: `Overwatch: inventory stale, <days> days`.
   Then "The platform inventory was last rebuilt
   <friendly date, or never>. gitpush sends it after every merge into main; a long gap means the
   sends are failing or nothing has been merged." and this paste-ready prompt:
   ```
   FOR CLAUDE.AI, NOT THE CLI
   Overwatch says the platform inventory has not been rebuilt since <date>. Help me check the sender log (alfred-overwatch-outbox.jsonl.log in the repo's .git folder) and, if needed, run npm run inventory -- --send.
   ```
   Kind `inventory_stale`.
7. **One per follow-up** (count 11f), **`source_app` the follow-up's app** (rule 5). Dedupe against
   count 3f, not 3d: never raise one when an open item starts with the same text up to its " — ".
   First line and title, by kind:
   - `table_users`: `Overwatch: follow-up: <part> after <table> changed — <merge_commit, 7 characters>`.
     Title: `Overwatch: check <part> after <table> changed`.
   - `tool_in_no_skill`: `Overwatch: follow-up: <tool> is in no skill — <merge_commit, 7 characters>`.
     Title: `Overwatch: <tool> is in no skill`.
   - `skill_to_paste`: `Overwatch: follow-up: paste the <skill> skill into claude.ai — <merge_commit, 7 characters>`.
     Title: `Overwatch: paste <skill> skill`.
   Then the one line of what to check, "From <project_code>'s Finish on <friendly date>
   (<merge_commit>)." and, for `table_users`, its `uses` of the table; for `skill_to_paste`, the line
   `Skill version: <the skill's details.version from 11a, or unknown>`, the repo's version, which a
   chat compares with the installed copy.
   Kind `follow_up`, plus `"follow_up": "<kind>"` and `"summary_id": "<id>"`.

Every item also sets `ai_reasoning: "Created by the overwatch/nightly scheduled task, run <run id>."`
and nothing else: no `suggested_*` fields. Keep each returned inbox id. If one call errors, SKIP
it (`skipped` gets `inbox:<first line>`) and go on.

### Step 7 — Write tonight's note

Call `create_overwatch_note` with `period: "nightly"`, `for_date: <local_date>`, and:
- **`body`**: markdown, short, in the plan's `instructions` voice and worded the way the skill
  says. **No title line.** Exactly this shape:
  ```
  ## Action Required
  - <one bullet per finding, most important first>
  ## Yesterday's Activity
  - <App>: <what was done yesterday, from Step 4's rows>   (one bullet per app; "Nothing logged." when none)
  ```
  - **Dates** are friendly everywhere: "Oct 15", never 2026-10-15.
  - **Every record is a markdown link** `[Name](https://alfredv5vibe.vercel.app/<id>)`, never a
    bare URL: overdue and deadline intentions, inbox items, projects (to the group link,
    `https://alfredv5vibe.vercel.app/groups/detail/<group_id>`).
  - **Order under Action Required:** time-sensitive first (overdue intentions; deadlines, the urgent
    ones first; failed or missing tasks, stopped schedules and orphan runs, each suggested as **a bug
    to log**: "Log a bug: <schedule> has had no ok run since <date>."; for notify-dispatch, "Log a
    bug: notify-dispatch has left a reminder unsent since <date>."), then anything waiting on Alex,
    then the projects, then the portfolio plans due a review (count 12, one bullet each:
    "Review the [<name> plan](https://alfredv5vibe.vercel.app/overwatch/plan/<portfolio id>): review
    by <friendly date> has passed."), then the finish-summary follow-ups (one bullet per summary: its project and
    date, its follow-ups as sub-bullets, "N more wait" when count 11 left some), then the rest: a
    stale inventory, the over-limit count, claim blocks, fading, quiet apps, the inbox, watch items
    that ended, checks due.
  - **Projects:** one bullet per project with a finding, its name the link, then its estimated
    finish (count 2g), and as sub-bullets its stall or overrun, its scope changes (each with its
    reason) and, for an empty Project group, "No item or intention yet."
  - **Quiet apps** on one bullet: "Quiet: Jobs (12 days), Money (9 days)"; an app with no data at
    all reads "Ken (no data yet)".
  - **The inbox** on one bullet: count 3e's line.
  - Items that are "still open" from Step 6 say so. Counts skipped for the budget say so in one
    bullet. A night with nothing under Action Required says "- Nothing needs you tonight."
- **`flags`**: an object with one key per count, each a list of what you kept (an empty list when
  the count ran and found nothing; leave out a key whose count was skipped): `quiet_apps`,
  `stalled`, `waiting_on_alex`, `overruns`, `over_limit`, `estimated_finish`, `scope_changes`,
  `empty_projects`, `backlogs`, `unrouted`,
  `low_confidence_routing`, `stopped_schedules`, `orphan_runs`, `task_health`, `claim_blocks`,
  `fading`, `overdue_intentions`, `deadline_no_date`, `watch_ended`, `checks_due`,
  `inventory_stale` (`{ "seen_at": … | "never", "days": … }`, or an empty list when fresh),
  `impact_review` (the follow-ups from count 11f, each with its summary id),
  `portfolio_review_due` (count 12: `{ "portfolio_id": …, "name": …, "review_by": … }` each), plus
  `inbox_items` (the ids from Step 6), `skipped` and `settings_missing`.

A second manual run on the same day replaces the note, keeping its id; that is expected. If the call
errors, STOP with `failure_kind: "note_write"`.

### Step 8 — Signals, watch items and checks

1. **Signals.** For **each** inbox item raised in Step 6, call `raise_signal` once. Raise every one,
   every night it is raised: never count, cap or skip them, and never check for an earlier
   notification. The dispatcher decides what reaches Alex and when. A night with no new items
   raises nothing.
   - `app: "overwatch"`, `job: "nightly"`, `started_by: "task:overwatch-nightly"`.
   - `severity`: `"high"` for waiting on Alex and for missed intentions; `"low"` for fading; `"normal"`
     for everything else (overrun, stalled, scan gaps, a stale inventory, proposals, follow-ups).
   - `subject_key`: stable from night to night, so repeats tie together: `overwatch:<kind>:<the
     project, app or group id>`, or `overwatch:<kind>` when there is no one thing, lower case, no
     spaces, no date. For example `overwatch:stalled:<group id>`, `overwatch:overdue`,
     `overwatch:fading`, `overwatch:inventory`.
   - `title`, the text that may pop, by kind:
     - overdue: `<N> missed: <the most overdue intention> (+<M> undated)`, or with none missed
       `<M> undated: <the soonest deadline's intention>`; add `+<K> more` inside the brackets when
       more than one missed;
     - fading: `<N> fading: <the oldest item>`;
     - any other item: its title without "Overwatch: ".
   - `body`: one plain line on why it matters. `link`: `/<inbox id>`, the item's id.
   - `details`: `{"inbox_id": "<inbox id>", "kind": "flag"}`. The inbox id tells the dispatcher the
     item already exists, so it points at it instead of making another.
   - `source_ref`: `overwatch:nightly:<local_date>:<inbox id>`, so a re-run does not raise it twice.
2. **Watch items that ended:** for each one in the note, `update_overwatch_watch` with its `id`
   and `expiry_noted: true`.
3. **Checks for the next run:** `update_overwatch_checks` with `counts.plan.checks_later`, plus a
   check for anything tonight's note asked to look at again (`text`, `check_on`, and `about` as an
   app id or group id). Pass the whole list; an empty list clears it.
4. **An app's current state** (count 11g, at most 2): `update_app_profile` with the `app_id` and
   `current_state` only: the app's `current_state` from `counts.apps` with what the work changed worked in
   the way the skill says. Never `activity_recipe` or `rhythm_days`.
5. **Mark the summaries reviewed** (count 11h): `mark_finish_summaries_reviewed` with the kept ids
   and `run_id` this run's id, **one call**, only after Step 6's follow-ups were raised. Summaries
   left for tomorrow are not in it.

A failed call here is SKIPPED, never STOP.

### Step 9 — Close the run (one call)

Call `update_platform_run` with the run id, **once**.
- **`status`:** `failed` if a step said STOP; `partial` if anything is in `skipped`; else `ok`.
- **`details`**, always: `local_date`, `prompt_version: "2026-11-04a"`, `manual`, `plan_id`,
  `counts` (an object with one key per flag, the same keys as Step 7's flags, and that flag's
  count; never `flag_counts`), `note_id`, `inbox_item_ids`, `signals_raised`, `apps_pulled`,
  `summaries_reviewed` (the ids marked in Step 8.5), `profiles_rewritten` (app ids),
  `alfred_calls`, `paused`, `skipped` and `settings_missing`; also `earlier_run_id` when Step 2.3
  kept one, or `duplicate_of` when it stopped there.
- **On `failed`:** `error_message` is the verbatim error, and `details.failure_kind` is one of
  `plan_read`, `state_read`, `note_write`, `run_open`, `unknown`. **Never downgrade a failure to
  `ok` to get past a rejected close.**

**On `failed`, also** call `create_inbox_item` with `source_type: "task"`, `source_app: "overwatch"`,
`source_metadata: { "task_name": "Overwatch nightly FAILED: <failure_kind>", "run_date": "<local_date>", "kind": "failure" }`,
and this `captured_text`:

```
Overwatch nightly FAILED — <failure_kind>, <local_date>

The nightly check did not finish. It changed nothing it should not have.
Error: <verbatim error>
Run: <run id>
```

### Step 10 — Report

Write a short report:
- `PROMPT VERSION: 2026-11-04a`;
- the finish summaries reviewed and the follow-ups raised, and whether the inventory is stale;
- the run id and its status, and `manual: true` or `manual: false`; `duplicate_of` if it stopped;
- the count of each flag, the note id, the inbox item ids and the signals raised;
- `alfred_calls` and whether it paused;
- `skipped` and `settings_missing`, if any;
- any error, verbatim.

Nothing else.
