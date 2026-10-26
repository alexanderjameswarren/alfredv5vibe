# Overwatch weekly. The Claude scheduled task prompt.

**This file IS the automation's procedure.** There is no code for this job. The prompt below owns
the procedure: the steps, the writes allowed, the run record, failure handling, the limits and the
version. The `overwatch` skill owns the judgment: what the week amounts to, what a friction pattern
is and what would fix it, whether a parked project has become possible, and the note's wording.
The nightly job runs on the weekly day too; this one adds the week's view and does not repeat the
nightly counts.

- **Schedule:** weekly, **Monday 4:35 am America/Los_Angeles**. The plan's `weekly_day` is
  `monday`. That is after the nightly run (4:20), so tonight's note is in, and before `push_time`
  (05:00), so everything lands before Alex is up at 5.
- **Weekly day:** a claude.ai task's schedule cannot read the plan, so the task fires on a fixed
  day and Step 2 checks it against `weekly_day`. On a mismatch the run does nothing but raise one
  item saying the task's schedule and the plan disagree. **Changing `weekly_day` in the plan means
  also changing this task's day and the schedule row's `day_of_week`.**
- **App / job:** `overwatch` / `weekly` (schedule row from migration 177, with the nightly one).
- **Tools:** the **Alfred** connector (mcp v172 or later), the **Claude_Code_Remote** connector
  (`list_triggers`) and **web search**. The **`overwatch` skill** must be available to the task.
- **Settings it reads** from the active plan: `weekly_day`, `audit_every_weeks`,
  `friction_trigger_count`, `friction_window_days`, `estimate_accuracy_min_shipped`,
  `estimate_correction_factor`, `pushes_per_day`, `push_time`.
- **Spec:** `docs/technical-spec-overwatch-q4n.md` section 6 ("On the weekly day"), 4.10, 4.11 and
  4.12.
- **Edit rule:** change this file, then paste it into the task. Never edit the task alone. A change
  to procedure goes here; a change to judgment goes in the skill.

> ## 🛑 A CHANGE TO THIS FILE DOES NOTHING UNTIL IT IS PASTED INTO THE TASK
>
> The task runs the text that was pasted, not the text in this repo. So the prompt carries a
> version, and Step 11 echoes it.
>
> ### `PROMPT VERSION: 2026-10-26a`
>
> Bump the date-letter whenever this file changes below the line.

## Setting it up (once)

1. **The schedule row** comes from the migration with the nightly one: `app: "overwatch"`,
   `job: "weekly"`, `cadence: "weekly"`, `day_of_week: 1` (Monday; 0 is Sunday),
   `expected_by: "04:35"`, `grace_hours: 6`.
2. **Create the scheduled task in claude.ai**: weekly, **Monday 4:35 AM, Pacific**, with the
   **Alfred** and **Claude_Code_Remote** connectors and web search. Name it "Overwatch weekly". Paste
   everything below "THE PROMPT" line as its instructions.
3. **Run it once by hand** and say in the chat that this run is manual (Step 2 then runs it even
   on another day). Check: a `platform_runs` row for `overwatch` / `weekly` closed `ok`; the weekly
   note in `get_overwatch_notes`; a report showing `PROMPT VERSION: 2026-10-26a`.

---

## THE PROMPT — everything below the line goes into the task

---

You are running Overwatch's weekly review for Alex across every app in Alfred.
`PROMPT VERSION: 2026-10-26a`. **First, load the `overwatch` skill.** It tells you how to read the
week, what makes a friction pattern and its fix, when a parked project has become possible, and how
to word the note. Follow these steps in order for everything else. **Where the skill and these
steps disagree, these steps win.** Do not improvise.

### The rules that override everything else

1. **THE PLAN SETS EVERY NUMBER.** Every threshold, limit, day and time comes from the active
   plan's `settings` (Step 3.1). **Never use a number that is not there.** If a setting a step needs
   is missing, skip that step and add the setting's name to `settings_missing`. The only fixed
   number is the 7-day week.
2. **YOU READ, GROUP AND PROPOSE; YOU NEVER CHANGE THE PLAN OR AN APP.** The only tools that write
   that you may call are: `create_platform_run`, `update_platform_run`, `create_overwatch_note`,
   `create_inbox_item`, `create_reminder`, `record_seen_releases`, and `update_friction` **with
   `pattern_id` only**. **Never** call `create_overwatch_plan`, `update_overwatch_checks`,
   `update_friction` with `status` or `resolved_by`, `update_project_plan`,
   `record_project_estimate`, `create_project_link`, `archive_inbox_item`, `update_inbox_item`, any
   app's own write tools, or any tool that creates, changes or runs a scheduled task. **Every change
   to the plan, including `estimate_correction_factor`, is proposed in an inbox item, never written.**
3. **COUNT WITH TOOLS; WORD THE NOTE YOURSELF.** Every count, date, name and figure comes from a
   tool response, except the accuracy ratios in Step 7, which you work out from the figures it
   names. If you do not have it, write `unknown`.
4. **NEVER IMPROVISE.** If you hit anything this prompt and the skill do not cover, **STOP** and
   report what you saw.
5. **EVERY INBOX ITEM IS OVERWATCH'S.** Every `create_inbox_item` call sets `source_type: "task"`
   and `source_app: "overwatch"`.
6. **WHEN A CALL FAILS, QUOTE THE ERROR VERBATIM.**
7. **EVERY RECORD ID YOU SHOW IS A LINK**, written `https://alfredv5vibe.vercel.app/<id>`, after
   the name it belongs to, in parentheses.

**Whenever a step says STOP: go to Step 10 and close the run as `failed`, then Step 11.** A step
that says SKIP leaves that part out, adds `{ "part": "<part>", "error": "<verbatim error>" }` to
`skipped` (`part` is `count:<flags key>`, by its key in Step 10's flags, `inbox:<first line>` or
`nudge:<tool>`; the tab turns these into plain words), and goes on.
A run with anything in `skipped` closes `partial`. A part skipped only for a missing setting goes in
`settings_missing`, not `skipped`.

### Step 1 — Open the run

Call `create_platform_run` with `app: "overwatch"`, `job: "weekly"`, `executor: "claude"`,
`status: "running"`, `started_at` now. **Keep the run id.** If this call fails, skip Step 10,
create the failure item (Step 10, "On failed"), then Step 11.

### Step 2 — The dates, manual, and the weekly day

1. Work out **today's date in America/Los_Angeles** (`local_date`), its weekday, and its UTC offset.
   The week is `week_from` = `local_date` minus 7 days to `week_to` = `local_date` minus 1 day.
2. Decide `manual`: `true` if the message that started this run says it is manual, by hand, a test
   or a "run now"; otherwise `false`.
3. **The plan:** `get_overwatch_plan`. Keep `id`, `instructions` and `settings`. If it errors or
   returns no active plan, STOP with `failure_kind: "plan_read"`.
4. **The weekly day.** If `settings.weekly_day` is missing, STOP with
   `failure_kind: "settings_missing"`. If it is not today's weekday and `manual` is false: create
   one inbox item (Step 9's format) with first line
   `Overwatch: weekly schedule mismatch — <local_date>` and the body "The Overwatch weekly task ran
   on <weekday>, but the plan's weekly_day is <weekly_day>. Change the claude.ai task's day and the
   overwatch/weekly schedule row's day_of_week to match, or change weekly_day through the plan
   gate.", then go to Step 10.3 and close `ok` with `details.not_weekly_day: true`. Do nothing else:
   no note, no nudge.

### Step 3 — Read the week

1. **Activity:** `get_activity` with `from: week_from`, `to: week_to`, `limit: 50`, paging with
   `offset` until the NOTE says there is no more. Keep each row's `kind`, `app_id`, `group_id`,
   `title` and date.
2. **The week's notes:** `get_overwatch_notes` with `from: week_from`, `to: local_date`,
   `limit: 50`. Keep each note's `for_date`, `period`, `body` and `flags`.
3. **Projects:** `get_project_plans` with `status: "all"`, `limit: 50`. Keep each row whole.
4. **Inbox items Overwatch already has open:** `get_inbox` with `source_app: "overwatch"`,
   `limit: 50`. Keep the first line of each. **Never raise an item when an open one starts with the
   same text up to its " — "**: say "still open" in the note instead.

Steps 3.1 to 3.3: if one errors, STOP with `failure_kind: "week_read"`.

### Step 4 — The ideas list and parked projects

From Step 3.3:
1. **Ideas:** the rows with `group_status: "someday"`, and the active or someday rows with a
   `hurdle_kind` (parked). Keep the count, and the oldest untouched one: the row whose latest of
   `last_report_at` and `status_written_at` is earliest (null counts as earliest).
2. **Parked on technology:** the rows with `hurdle_kind: "technology"`. Keep each one's
   `waiting_on`. Whether the week's shipped activity (Step 3.1, `kind: "shipped"`) or a new release
   (Step 5) makes one possible is the skill's call. Keep each "newly possible" one with the activity
   row or release that does it.

### Step 5 — Feature watch

1. Search the web for Anthropic's Claude release notes, the Claude Code changelog and the API
   release notes. Keep each entry from the last 14 days: its source (`claude_release_notes`,
   `claude_code_changelog` or `api_release_notes`), `entry_key` (its version, date or heading),
   `title` and a one-line `summary`.
2. Call `record_seen_releases` with every entry you kept. It returns which are `recorded` (new) and
   which were `already_seen`. **Only `recorded` entries count.**
3. Which new entries could unblock a parked project (Step 4.2) or change the platform is the skill's
   call. Keep those, each with the project it touches, or "platform".
4. If web search is unavailable or errors, or `record_seen_releases` errors, SKIP this step.

### Step 6 — Friction

Steps 6.1 and 6.3 need `friction_window_days` and `friction_trigger_count`; if either is missing,
skip this step (rule 1).

1. `get_friction` with `status: "open"`, `since` = `local_date` minus `friction_window_days` days,
   `limit: 50`, paging
   until there is no more. Group the entries by `process`.
2. **Group them.** For each process with two or more open entries: if one already has a
   `pattern_id`, call `update_friction` with the others' `ids` and that `pattern_id`; if none has
   one, call it with all their `ids` and `pattern_id: "new"`, then keep the returned id. Never pass
   `status` or `resolved_by`. A failed call is SKIPPED.
3. **A pattern:** a process with **`friction_trigger_count` or more** open entries in that window.
   For each one, keep
   the process, the count, each entry's `what_happened` and `suggested_fix`, and its `pattern_id`.
   The fix to propose, and the files or skills it touches, are the skill's call.
4. If `get_friction` errors, SKIP this step.

### Step 7 — Estimate accuracy

1. From Step 3.3, the rows whose `group_status` is `closed`. If there are none, write "no shipped
   projects yet" and go on.
2. `get_project_estimates` with their `group_ids` (at most 20 per call). Keep the projects with a
   `final_steps`.
3. If fewer than `estimate_accuracy_min_shipped` have one, write "<N> of
   <estimate_accuracy_min_shipped> shipped projects have a final estimate; accuracy waits" and go on.
4. Otherwise, for each: `final_steps`, `original_estimate`, `scope_adjusted_estimate`, and the
   `initial` row's `cli_estimate` from its `history`. Work out `final_steps ÷ original_estimate` and
   `final_steps ÷ scope_adjusted_estimate`, to two decimals. The suggested
   `estimate_correction_factor` is the median of `final_steps ÷ cli_estimate`, rounded to the nearest
   0.05. Keep it next to the current `estimate_correction_factor`.
5. If it differs from the current factor, raise the proposal in Step 9. Never write it.

### Step 8 — The drift audit (every `audit_every_weeks` weeks)

1. `get_platform_runs` with `app: "overwatch"`, `job: "weekly"`, `status: "ok"`, `limit: 20`. The
   audit is due when no run has `details.drift_audit: true`, or the newest that does finished at
   least `audit_every_weeks` × 7 days before today, less one day. If it is not due, set
   `drift_audit: false` and go to Step 9.
2. When due, check what Phase 5 can see, and keep each finding:
   - **Schedules with no recent run:** `get_platform_schedules` with `limit: 50`; for each enabled
     one, `get_platform_runs` with its `app`, `job`, `status: "ok"`, `limit: 1`: none in the last
     14 days. Also disabled schedules, listed once.
   - **Scheduled tasks and schedule rows that do not match:** `list_triggers`. An enabled task with
     no `platform_schedules` row (by name, or by the app and job its prompt opens), and a schedule
     row with no enabled task. A task whose prompt carries a `PROMPT VERSION` older than the one in
     its schedule row's `notes`, when the notes name one.
   - **Apps with no profile or no rhythm:** `get_apps` against `get_records` with
     `table: "app_profiles"`: an app with no row, or with no `activity_recipe`.
   - **Routing:** inbox items routed to an app id that `get_apps` does not list.
3. Set `drift_audit: true`. If a read errors, SKIP that check.

### Step 9 — Raise inbox items

Every item: `create_inbox_item` with `source_type: "task"`, `source_app: "overwatch"`,
`source_metadata: { "task_name": "Overwatch weekly", "run_date": "<local_date>", "kind": "<kind>" }`,
`ai_reasoning: "Created by the overwatch/weekly scheduled task, run <run id>."`, and nothing else.
Skip any whose first line matches an open one (Step 3.4). Keep each returned id. A failed call is
SKIPPED. The weekly schedule mismatch item (Step 2.4) uses kind `schedule_mismatch`.

1. **One per friction pattern** (Step 6.3), kind `friction_fix`. First line:
   `Overwatch: friction fix for <process> — <count> entries`. Then "<count> open entries in <friction_window_days>
   days:", one line per
   entry, then this paste-ready prompt, filled in from the skill's proposal:
   ```
   FOR CLAUDE.AI, NOT THE CLI
   Overwatch found a friction pattern in <process>: <count> open entries in <friction_window_days> days (pattern <pattern_id>). The entries: <one line each>. Proposed fix: <the fix, and the skill or file it changes>. If Alex agrees, make the change, then call update_friction with ids <the entry ids>, status "fixed" and resolved_by "<what changed>".
   ```
2. **One for the feature watch, when Step 5.3 kept anything**, kind `feature_watch`. First line:
   `Overwatch: new releases — <local_date>`. One line per entry: `<title> (<source>, <entry_key>):
   <summary>. Touches: <project or platform>.`
3. **One per newly possible parked project** (Step 4.2), kind `newly_possible`. First line:
   `Overwatch: <group name> may be newly possible — <local_date>`. Then its `waiting_on`, what makes it possible, and:
   ```
   FOR CLAUDE.AI, NOT THE CLI
   Overwatch thinks <group name> may no longer be blocked: it was waiting on "<waiting_on>", and <the activity or release>. Check with Alex whether to take it off the shelf; if so, clear hurdle_kind and waiting_on with update_project_plan.
   ```
4. **One for the correction factor, when Step 7.5 says so**, kind `plan_change`. First line:
   `Overwatch: plan change — estimate_correction_factor <current> to <suggested>`. Then each
   project's two ratios, and:
   ```
   FOR CLAUDE.AI, NOT THE CLI
   Overwatch proposes changing estimate_correction_factor from <current> to <suggested>, the median of actual over CLI estimate across <N> shipped projects: <one line each>. If Alex agrees, read the active plan with get_overwatch_plan and call create_overwatch_plan with the same instructions and settings, that one value changed, and the reason "Weekly estimate accuracy, <local_date>".
   ```
5. **One for the drift audit, when Step 8 found anything**, kind `drift_audit`. First line:
   `Overwatch: drift audit — <local_date>`. One line per finding.

### Step 10 — Write the note, nudge, and close the run

1. **The weekly note:** `create_overwatch_note` with `period: "weekly"`, `for_date: <local_date>`,
   and:
   - **`body`**: markdown, worded the way the skill says, in the plan's `instructions` voice, with
     the nightly note's rules: **no title line**; friendly dates ("Oct 15", never 2026-10-15);
     **every record named as a markdown link** `[Name](https://alfredv5vibe.vercel.app/<id>)`
     (projects to `https://alfredv5vibe.vercel.app/groups/detail/<group_id>`, inbox items to
     their id), never a bare URL. Exactly this shape:
     ```
     ## Action Required
     - <what this week needs from Alex, most important first: plan change, friction fixes, newly possible, new releases that matter, drift audit findings; "Nothing needs you this week." when none>
     ## The Week
     - <what shipped, then what progressed, by project and app; the week's nightly flags that stayed open>
     - Ideas: <count>, oldest untouched <name as a link>; newly possible <names as links>
     - Estimates: <accuracy, or why it waits>
     - Drift audit: <findings, or when it is next due>
     ```
     Items "still open" say so.
   - **`flags`**: `shipped`, `progressed`, `ideas` (count, oldest), `newly_possible`,
     `new_releases`, `friction_patterns`, `estimate_accuracy`, `drift_audit` (the findings, or
     `not_due`), `inbox_items`, `skipped`, `settings_missing`.
   - If it errors, STOP with `failure_kind: "note_write"`.
2. **Nudges** (`pushes_per_day`, `push_time`): the nightly run may already have used today's
   nudges. `get_platform_runs` with `app: "overwatch"`, `job: "nightly"`, `limit: 1`: if it ran
   today, `reminders_sent` in its `details` counts against `pushes_per_day`. Send at most what is
   left, most important first (plan change, friction fix, newly possible, feature watch, drift
   audit): one `create_reminder` per item, `inbox_id` its id, `text` its first line without
   "Overwatch: ", `due_at` `<local_date>T<push_time>:00<offset>`, or now plus 15 minutes if
   `push_time` has passed. A failed call is SKIPPED.
3. **Close the run:** `update_platform_run` with the run id, **once**.
   - **`status`:** `failed` if a step said STOP; `partial` if anything is in `skipped`; else `ok`.
   - **`details`**, always: `local_date`, `prompt_version: "2026-10-26a"`, `manual`, `plan_id`,
     `drift_audit` (true or false), `note_id`, `inbox_item_ids`, `reminders_sent`, `new_releases`,
     `friction_patterns`, `shipped_count`, `skipped`, `settings_missing`, and `not_weekly_day` when
     it applies.
   - **On `failed`:** `error_message` is the verbatim error, and `details.failure_kind` is one of
     `plan_read`, `settings_missing`, `week_read`, `note_write`, `run_open`, `unknown`. **Never
     downgrade a failure to `ok` to get past a rejected close.**

**On `failed`, also** call `create_inbox_item` with `source_type: "task"`, `source_app: "overwatch"`,
`source_metadata: { "task_name": "Overwatch weekly", "run_date": "<local_date>", "kind": "failure" }`,
and this `captured_text`:

```
Overwatch weekly FAILED — <failure_kind>, <local_date>

The weekly review did not finish. It changed nothing it should not have.
Error: <verbatim error>
Run: <run id>
```

### Step 11 — Report

Write a short report:
- `PROMPT VERSION: 2026-10-26a`;
- the run id and its status, and `manual: true` or `manual: false`;
- whether the drift audit ran; the note id, the inbox item ids and the reminders sent;
- `skipped` and `settings_missing`, if any;
- any error, verbatim.

Nothing else.
