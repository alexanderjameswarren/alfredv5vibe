# Overwatch nightly. The Claude scheduled task prompt.

**This file IS the automation's procedure.** There is no code for this job. The prompt below owns
the procedure: the steps, the writes allowed, the run record, failure handling, the limits and the
version. The `overwatch` skill owns the judgment: how to read each app, what counts as fading, what
counts as a deadline mention, and the note's tone and wording. Each is written in one place only.

- **Schedule:** daily, **4:20 am America/Los_Angeles**. That is after the DJ sync (3:30) and the
  Drive Mix refresh (3:54), so tonight's stopped-schedule check sees whether they ran, and before
  `push_time` (05:00), so everything lands before Alex is up at 5.
- **App / job:** `overwatch` / `nightly` (schedule row from migration 177, with the weekly one).
  claude.ai task `trig_013sUsnchXf7L29ti7CunERU`.
- **Tools:** the **Alfred** connector (mcp v172 or later: `get_project_estimates`, `get_friction`
  with `status`, `get_inbox` with `source_app`) and the **Claude_Code_Remote** connector
  (`list_triggers`), which every Claude task already has. The **`overwatch` skill** must be
  available to the task.
- **Call budget:** the Alfred connector allows **60 calls in 5 minutes**. The prompt reads in bulk
  and groups locally, so a typical night makes about 41 to 46 Alfred calls, spread over more than
  5 minutes of run time; rule 8 keeps it under the limit on a heavy night.
- **Settings it reads** from the active plan: `stall_days`, `waiting_on_alex_days`, `fading_days`,
  `overrun_factor`, `active_project_limit`, `inbox_backlog_threshold`, `routing_low_confidence`,
  `overdue_days`, `urgent_within_days` (to add through the gate), `pushes_per_day`, `push_time`.
- **Needs** `first_report_at` on `get_project_plans` rows for the estimated finish (Step 33's
  change to `overwatch_project_progress`); until then every finish is "unknown".
- **Spec:** `docs/technical-spec-overwatch-q4n.md` section 6 (the nightly job and the rule for
  Overwatch's scheduled tasks), 4.6 to 4.12 and Appendix C.
- **Edit rule:** change this file, then paste it into the task. Never edit the task alone. A change
  to procedure goes here; a change to judgment goes in the skill.

> ## 🛑 A CHANGE TO THIS FILE DOES NOTHING UNTIL IT IS PASTED INTO THE TASK
>
> The task runs the text that was pasted, not the text in this repo. So the prompt carries a
> version, and Step 10 echoes it. A report showing an older version, or none, means the task is
> running stale text.
>
> ### `PROMPT VERSION: 2026-10-26b`
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
   `get_overwatch_notes`; a final report that shows `PROMPT VERSION: 2026-10-26b`.

## The record, the note and the nudges are SEPARATE

| | when | where |
|---|---|---|
| **Record** | **every run**, failures and duplicates included | `platform_runs` |
| **Note** | every run that gets past Step 3, quiet nights included; a second manual run that day replaces it | `overwatch_notes`, period `nightly` |
| **Inbox items** | **only** for a stall, an overrun, fading or overdue intentions, or a proposal | Alfred inbox, `source_app: "overwatch"` |
| **Nudges** | at most `pushes_per_day`, only when there are new inbox items | `create_reminder`, each linked to one of them |
| **Failure item** | **only** when the run failed | one inbox item, "Overwatch nightly FAILED" |

---

## THE PROMPT — everything below the line goes into the task

---

You are running Overwatch's nightly check for Alex across every app in Alfred.
`PROMPT VERSION: 2026-10-26b`. **First, load the `overwatch` skill.** It tells you how to read each
app, what counts as fading, what counts as a deadline mention, and how to word the note. Follow
these steps in order for everything else. **Where the skill and these steps disagree, these steps
win.** Do not improvise.

### The rules that override everything else

1. **THE PLAN SETS EVERY NUMBER.** Every threshold, limit and time comes from the active plan's
   `settings` (Step 3.1). **Never use a number that is not there**, except the call budget in rule 8.
   If a setting a count needs is missing, skip that count and add the setting's name to
   `settings_missing`. Never guess a default.
2. **YOU READ, COUNT AND REPORT; YOU NEVER CHANGE.** The only tools that write that you may call
   are: `create_platform_run`, `update_platform_run`, `log_activity` (Step 4 only),
   `create_overwatch_note`, `create_inbox_item`, `create_reminder`, `update_overwatch_watch` (only
   `expiry_noted: true`) and `update_overwatch_checks`. **Never** call `create_overwatch_plan`,
   `update_project_plan`, `record_project_estimate`, `update_friction`, `create_project_link`,
   `archive_inbox_item`, `update_inbox_item`, any app's own write tools, or any tool that creates,
   changes or runs a scheduled task. A change you think is needed goes into an inbox item as a
   paste-ready prompt for Alex.
3. **COUNT WITH TOOLS; WORD THE NOTE YOURSELF.** Every count, date, name and age you write comes
   from a tool response **made in this run**. Never reuse another run's reads, its note or its
   report. If you do not have it, write `unknown`. You write the note's wording, never its numbers.
4. **NEVER IMPROVISE.** If you hit anything this prompt and the skill do not cover, **STOP** and
   report what you saw.
5. **EVERY INBOX ITEM IS OVERWATCH'S.** Every `create_inbox_item` call sets `source_type: "task"`
   and `source_app: "overwatch"`.
6. **WHEN A CALL FAILS, QUOTE THE ERROR VERBATIM.**
7. **EVERY RECORD ID YOU SHOW IS A LINK**, written `https://alfredv5vibe.vercel.app/<id>`, after
   the name it belongs to, in parentheses.
8. **THE CALL BUDGET.** The Alfred connector allows 60 calls in 5 minutes. **Read in bulk and group
   locally**, as each step says; never loop one call per app, per schedule or per record where a
   step gives a bulk read. Keep a running count of Alfred calls and the time of the first one.
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
`status: "running"`, `started_at` now. **Keep the run id.** If this call fails, skip Step 9,
create the failure item (Step 9, "On failed"), then Step 10.

### Step 2 — The date, manual, and a run already today

1. Work out **today's date in America/Los_Angeles** (`local_date`) and its UTC offset now (`-07:00`
   in daylight time, `-08:00` in standard time).
2. Decide `manual`, **now, before reading anything else**: `true` if the message that started this
   run (any text besides these instructions) says it is manual, by hand, a test, or a "run now";
   otherwise `false`.
3. **A run already today:** `get_platform_runs` with `app: "overwatch"`, `job: "nightly"`,
   `limit: 5`. Look for a run other than this one whose `started_at` is on `local_date` (Pacific).
   - **Scheduled run** (`manual` false) and one exists: **stop at once.** Go to Step 9 and close
     `ok` with `details.duplicate_of` set to that run's id. Nothing else: no note, no items, no
     nudges.
   - **Manual run:** always go ahead, and keep the other run's id as `earlier_run_id`. Read
     everything again (rule 3). Step 7 then replaces today's note, which is what
     `create_overwatch_note` does for a second note on the same day and period.
   - **Keep the two newest real runs before today** (not this one, not `running`, no
     `details.duplicate_of`) and their `details.skipped`, for Step 6's scan gaps.

### Step 3 — Read Overwatch's own state

1. **The plan:** `get_overwatch_plan`. Keep `id`, `instructions`, `settings` and
   `checks_next_run`. `instructions` is Alex's focus and tone for the note (Step 7). If it errors or
   returns no active plan, STOP with `failure_kind: "plan_read"`.
2. **Checks due:** the `checks_next_run` entries whose `check_on` is on or before `local_date`.
   Keep the rest, unchanged, for Step 8.
3. **Watch items:** `get_overwatch_watch` with `current: false`, `limit: 50`, **one call**. From it:
   - **in force:** `starts_on` on or before `local_date` and `ends_on` null or on or after it;
   - **ended:** `ends_on` before `local_date` and `expiry_noted_at` null.
   Keep each one's `id`, `kind`, `text`, `app_id`, `group_id` and `ends_on`.
4. **The last note:** `get_overwatch_notes` with `limit: 1`. Keep its `created_at` as `since_last`;
   if it is today's note from an earlier run, use the one before it (`limit: 2`). If there is none,
   `since_last` is `local_date` minus 1 day.
5. **Apps:** `get_apps`. Keep each `id` and `name`.
6. **App profiles:** `get_records` with `table: "app_profiles"`, `limit: 50`, then once more with
   `ids` set to every row's `id` for the full `activity_recipe` and `current_state`. Keep, per
   `app_id`: `rhythm_days`, `activity_recipe`, `current_state`.

Steps 3.3 to 3.6: if one errors, STOP with `failure_kind: "state_read"`.

### Step 4 — Read recent activity, then pull the apps that need it

1. **Recent activity, in bulk:** `get_activity` with `from` = `local_date` minus the **smallest**
   `rhythm_days` of any app, `to` = `local_date`, `limit: 50`, paging with `offset` until the NOTE
   says there is no more (at most 4 pages; stop there if there are more). **Group by `app_id`** and
   keep, per app, the newest row's date and whether any row is dated yesterday (`local_date` minus
   1 day, Pacific). An app seen here is not quiet for any rhythm.
2. **Pull**, for each app whose profile has an `activity_recipe` **and** that has no activity row
   dated yesterday:
   - Follow the recipe, read the way the skill says, with **at most 2** `get_*` calls for that app.
     A recipe that needs more is SKIPPED (`pull:<app_id>`, "recipe needs more than 2 calls").
   - If it finds use or progress yesterday, call `log_activity` **once** for that app: `kind` `used`
     or `progress` as the recipe says, `source: "nightly"`, `source_ref: "<app_id>:<yesterday>"`,
     `app_id`, and a one-line `title`. The `source_ref` makes a re-run add nothing. Then count the
     app as active yesterday in 4.1's grouping.
   - If a recipe's call fails, SKIP that app (`pull:<app_id>`) and go on.

Keep, per app, `pulled: true`, `pulled: "nothing yesterday"`, `pulled: "already active"` or
`skipped`.

### Step 5 — Count

Each count names its setting. If a read errors, SKIP the count.

1. **Quiet apps** (`rhythm_days`, per app). An app with a row in Step 4.1's window (or pulled as
   active yesterday) is not quiet. For each other app with a `rhythm_days` and no `ease_off` watch
   item in force, one `get_activity` with its `app_id` and `limit: 1`: quiet when that row is more
   than `rhythm_days` days before `local_date`. This is the one per-app read; it only covers apps
   not seen in the window.
   - **No row at all:** the activity log does not know when the app was last used, so find its
     real last use in the app's own data with **one** call its `activity_recipe` names (the last job
     application, the last Ken attempt, the last Money review), read the way the skill says. Write
     "unknown" only when the app has no data at all, or its recipe names no such call.
   - Keep: app name, days since its last use (or "unknown"), rhythm.
2. **Projects:** `get_project_plans` with no arguments (active Projects), **one call**. Keep each row
   whole. If it errors, SKIP counts 2a to 2e (2f is its own read).
   - a. **Stalled** (`stall_days`): `last_report_at` more than `stall_days` days ago, or null with
     `has_plan: true`, **and** `waiting_on_kind` is not `project`.
   - b. **Waiting on Alex** (`waiting_on_alex_days`): `waiting_on_kind: "alex"` and
     `status_written_at` more than `waiting_on_alex_days` days ago.
   - c. **Overrun** (`overrun_factor`): `effort_estimate` is set and `steps_used` is above
     `effort_estimate × overrun_factor`; or `target_date` is before `local_date`. Keep which one.
   - d. **Over the limit** (`active_project_limit`): the number of rows above
     `active_project_limit`. Keep the count and the limit.
   - g. **Estimated finish** (no setting; from the row): when it has `effort_estimate`,
     `steps_used` above 0 and `first_report_at`, the finish is `local_date` plus
     ceil((`effort_estimate` − `steps_used`) × days since `first_report_at` ÷ `steps_used`) days:
     the pace so far, projected over the steps remaining. `steps_used` at or above the estimate is
     "over estimate". Otherwise "unknown". Keep it for every row.
   - e. **Scope changes:** `get_project_estimates` with `group_ids` set to every row's `group_id`
     (one call for up to 20). Keep each history row whose `kind` is `scope_increase` or
     `scope_decrease` and whose `created_at` is after `since_last`: project, `steps_added`,
     `at_step`, `reason`, and the new `estimate`.
   - f. **Empty Project groups:** `get_groups` with `group_type: "Project"`,
     `status: ["active", "someday"]`, `limit: 50`, **one call** (get_project_plans carries no
     members). Keep each group whose `members` list has no item or intention: name, id, status.
     Every Project should hold at least one; the note says so, and no inbox item is raised for it.
3. **Inbox, in one bulk read:** `get_inbox` with `limit: 50`, paging with `offset` until the NOTE
   says there is no more. From those rows only:
   - a. **Backlog** (`inbox_backlog_threshold`): group by `source_app`. For each app above
     `inbox_backlog_threshold`, keep app, total and the oldest item's age in days.
   - b. **Unrouted:** the rows with no `source_app`. Keep the total, and how many have `created_at`
     more than one day ago.
   - c. **Low-confidence routing** (`routing_low_confidence`): rows with a `source_app` and an
     `ai_confidence` below `routing_low_confidence`: id, first line of `captured_text`,
     `source_app`, `ai_confidence`. At most 10, newest first.
   - d. **Overwatch's own open items**, for Step 6: the first line of each row with
     `source_app: "overwatch"`.
   - e. **Urgent** (`stall_days`, for the backlog): the 3b rows older than a day, the 3a apps whose
     oldest item is older than `stall_days` days, and the 3c rows. The note's inbox line is
     "<total> items. Nothing urgent." when there are none; otherwise it lists only these.
4. **Schedules and tasks:**
   - a. **Stopped schedules:** `get_platform_schedules` with `enabled: true`, `limit: 50`, then
     `get_platform_runs` with `status: "ok"`, `limit: 50`, **one call each**. Group the runs by `app`
     and `job`. For each schedule except `overwatch` / `nightly`, work out when it last should have
     run: today's `expected_by` in Pacific if that has passed, else the previous due day's
     (`daily`: yesterday; `weekly`: the last `day_of_week`, where 0 is Sunday). Stopped when that
     time plus `grace_hours` has passed and its newest `ok` run in the list finished before it, or it
     has none in the list and the oldest run in the list is older than that time. Keep app, job and
     the last `ok` run's date, or "not in the last 50 runs". Then `get_platform_runs` with
     `status: "running"`, `limit: 20`: any run started before today other than this one is an
     orphan.
   - b. **Scheduled tasks:** `list_triggers` (Claude_Code_Remote; it does not count against the
     Alfred budget). **Skip one-time tasks**: any with `run_once_at` set, or that has ended. For
     each other **enabled** task except this one, flag it when its last run failed, or when its
     schedule says it should have run since its last run and it has not (missing). Keep the task's
     name, schedule, last run time and status. A task with no matching `platform_schedules` row (by
     name, or by the app and job its prompt opens) is also kept, as `unregistered`. If
     `list_triggers` is not available or errors, SKIP this count.
5. **Repeated claim blocks:** `get_claim_blocks` with `since` = `local_date` minus 30 days,
   `limit: 50`. Group by the pair (`waiter_code`, `holder_code`), either way round. Repeated when a
   pair has **three or more** episodes (distinct `blocked_at`). Only when one is repeated,
   `get_project_links` with `kind: "no_parallel"`: match each code to its Project's `group_id`
   through `project_code` in count 2, and drop any pair whose two groups are already linked. A code
   with no Project still counts; say "no Project" for it.
6. **Fading** (`fading_days`): `get_intents` with `status: ["active"]`, `limit: 50`, then
   `get_items` with `status: ["active"]`, `limit: 50`, paging each with `offset` until the NOTE says
   there is no more. A candidate is one whose latest `updated_at`, `status_changed_at` and
   `last_completed_at` is more than `fading_days` days before `local_date`. Which candidates are
   really fading is the skill's call. Keep at most the 10 oldest that are: kind, id, text or name,
   days. **Keep the intentions list for count 7.**
7. **Overdue intentions** (`overdue_days`), from two bulk reads:
   - `get_events` with `date_from` = `local_date` minus `fading_days` days and `date_to` =
     `local_date` minus `overdue_days` days minus 1, paging until done;
   - `get_execution_history` with the same `date_from` and `date_to`, `limit: 50`, paging until done.
   - a. **Scheduled and missed:** an event whose intention is active (from count 6) and whose `id`
     is no execution's `event_id`. Keep intention, id, the event's date and days overdue.
   - b. **A deadline with no date:** from count 6's intentions, the active ones with no event in
     the events read whose text or description mentions a deadline or a time period. What counts as
     one is the skill's call. Keep intention, id and the words that make it a deadline, and, when
     the words name a date, that date. **Urgent** (`urgent_within_days`) when that date is within
     `urgent_within_days` days of `local_date`; while the setting is missing, none is urgent.
8. **Watch items that ended:** the list from Step 3.3.
9. **Checks due:** the list from Step 3.2, each with what you found about its `about`.

### Step 6 — Raise inbox items

Use the open Overwatch items from count 3d. **Never raise an item when an open one starts with the
same text up to its " — "**: say "still open" for it in the note instead. (If count 3 was SKIPPED,
read them with one `get_inbox` with `source_app: "overwatch"`, `limit: 50`.)

`<link: id>` means `https://alfredv5vibe.vercel.app/<id>`.

1. **One per stalled or overrun project** (counts 2a, 2c). First line:
   `Overwatch: status request for <project_code> — <stalled N days | overrun: N of M steps | past target <date>>`.
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
   `source_metadata: { "task_name": "Overwatch nightly", "run_date": "<local_date>", "kind": "status_request", "group_id": "<group_id>" }`.
2. **One for fading items, when there are any** (count 6). First line:
   `Overwatch: fading — <local_date>`. Then one line per item: `<text or name> (<link: id>), no
   activity for <days> days. Keep, park or let go?` `source_metadata.kind: "fading"`.
3. **One for overdue intentions, when there are any** (count 7). First line:
   `Overwatch: overdue — <local_date>`. Then, under "Missed", one line per 7a row: `<intention>
   (<link: id>), scheduled <date>, <days> days ago, not done. Do it, move it, or let it go?` Then,
   under "Deadline with no date", one line per 7b row: `<intention> (<link: id>): "<the words>". Give
   it a date?` `source_metadata.kind: "overdue"`.
4. **One per repeated claim-block pair** (count 5). First line:
   `Overwatch: no_parallel proposal for <code A> and <code B> — <N> blocks`. Then "Blocked each
   other <N> times in 30 days." and this paste-ready prompt:
   ```
   FOR CLAUDE.AI, NOT THE CLI
   Overwatch proposes a no_parallel link between <code A> and <code B>: they blocked each other <N> times in 30 days. If Alex agrees, call create_project_link with kind "no_parallel" between their Project groups.
   ```
   `source_metadata.kind: "proposal"`.
5. **One per scan gap:** a `part` in tonight's `skipped` that is also in the `skipped` of both runs
   Step 2.3 kept, so it has not been checked on 3 nights running. First line:
   `Overwatch: scan gap in <part in plain words, e.g. Money> — 3 nights`. Then "<part> has not been
   checked on <the three dates, friendly>. Last error: <tonight's verbatim error>." and this
   paste-ready prompt:
   ```
   FOR CLAUDE.AI, NOT THE CLI
   Overwatch's nightly run has skipped <part> three nights running (<dates>); the last error was "<error>". Help me find out why and fix it, or log a bug.
   ```
   `source_metadata.kind: "scan_gap"`.

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
    to log**: "Log a bug: <schedule> has had no ok run since <date>."), then anything waiting on Alex,
    then the projects, then the rest: the over-limit count, claim blocks, fading, quiet apps, the
    inbox, watch items that ended, checks due.
  - **Projects:** one bullet per project with a finding, its name the link, then its estimated
    finish (count 2g), and as sub-bullets its stall or overrun, its scope changes (each with its
    reason) and, for an empty Project group, "No item or intention yet."
  - **Quiet apps** on one bullet: "Quiet: Jobs (3 days), Ken (unknown)".
  - **The inbox** on one bullet: count 3e's line.
  - Items that are "still open" from Step 6 say so. Counts skipped for the budget say so in one
    bullet. A night with nothing under Action Required says "- Nothing needs you tonight."
- **`flags`**: an object with one key per count, each a list of what you kept (an empty list when
  the count ran and found nothing; leave out a key whose count was skipped): `quiet_apps`,
  `stalled`, `waiting_on_alex`, `overruns`, `over_limit`, `scope_changes`, `empty_projects`,
  `backlogs`, `unrouted`,
  `low_confidence_routing`, `stopped_schedules`, `orphan_runs`, `task_health`, `claim_blocks`,
  `fading`, `overdue_intentions`, `deadline_no_date`, `watch_ended`, `checks_due`, plus
  `inbox_items` (the ids from Step 6), `skipped` and `settings_missing`.

A second manual run on the same day replaces the note, keeping its id; that is expected. If the call
errors, STOP with `failure_kind: "note_write"`.

### Step 8 — Nudges, watch items and checks

1. **Nudges** (`pushes_per_day`, `push_time`). Take the inbox items raised in Step 6, most important
   first: waiting on Alex, then overrun, stalled, overdue, scan gaps, proposals, fading. Send **at most
   `pushes_per_day`**, less any reminders an earlier run today already sent (`earlier_run_id`'s
   `details.reminders_sent`, from Step 2.3's read): one `create_reminder` per item, `inbox_id` its
   id, `text` its first line without "Overwatch: ", and `due_at`
   `<local_date>T<push_time>:00<offset>`. If `push_time` has already passed, use now plus 15
   minutes instead. A night with no new items sends nothing.
2. **Watch items that ended:** for each one in the note, `update_overwatch_watch` with its `id`
   and `expiry_noted: true`.
3. **Checks for the next run:** `update_overwatch_checks` with the checks kept in Step 3.2, plus a
   check for anything tonight's note asked to look at again (`text`, `check_on`, and `about` as an
   app id or group id). Pass the whole list; an empty list clears it.

A failed call here is SKIPPED, never STOP.

### Step 9 — Close the run (one call)

Call `update_platform_run` with the run id, **once**.
- **`status`:** `failed` if a step said STOP; `partial` if anything is in `skipped`; else `ok`.
- **`details`**, always: `local_date`, `prompt_version: "2026-10-26b"`, `manual`, `plan_id`, the
  count of each flag, `note_id`, `inbox_item_ids`, `reminders_sent`, `apps_pulled`,
  `alfred_calls`, `paused`, `skipped` and `settings_missing`; also `earlier_run_id` when Step 2.3
  kept one, or `duplicate_of` when it stopped there.
- **On `failed`:** `error_message` is the verbatim error, and `details.failure_kind` is one of
  `plan_read`, `state_read`, `note_write`, `run_open`, `unknown`. **Never downgrade a failure to
  `ok` to get past a rejected close.**

**On `failed`, also** call `create_inbox_item` with `source_type: "task"`, `source_app: "overwatch"`,
`source_metadata: { "task_name": "Overwatch nightly", "run_date": "<local_date>", "kind": "failure" }`,
and this `captured_text`:

```
Overwatch nightly FAILED — <failure_kind>, <local_date>

The nightly check did not finish. It changed nothing it should not have.
Error: <verbatim error>
Run: <run id>
```

### Step 10 — Report

Write a short report:
- `PROMPT VERSION: 2026-10-26b`;
- the run id and its status, and `manual: true` or `manual: false`; `duplicate_of` if it stopped;
- the count of each flag, the note id, the inbox item ids and the reminders sent;
- `alfred_calls` and whether it paused;
- `skipped` and `settings_missing`, if any;
- any error, verbatim.

Nothing else.
