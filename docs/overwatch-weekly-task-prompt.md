# Overwatch weekly. The Claude scheduled task prompt.

**This file IS the automation's procedure.** There is no code for this job. The prompt below owns
the procedure: the steps, the writes allowed, the run record, failure handling, the limits and the
version. The `overwatch` skill owns the judgment: what the week amounts to, what a friction pattern
is and what would fix it, whether a parked project has become possible, and the note's wording.
The nightly job runs on the weekly day too; this one adds the week's view and does not repeat the
nightly counts.

- **Schedule:** weekly, **Monday 4:35 am America/Los_Angeles**. The plan's `weekly_day` is
  `monday`. That is after the nightly run (4:20), so tonight's note is in, and before the
  dispatcher's first run (05:00), so its signals are delivered when Alex is up at 5.
- **Weekly day:** a claude.ai task's schedule cannot read the plan, so the task fires on a fixed
  day and Step 2 checks it against `weekly_day`. On a mismatch the run does nothing but raise one
  item saying the task's schedule and the plan disagree. **Changing `weekly_day` in the plan means
  also changing this task's day and the schedule row's `day_of_week`.**
- **App / job:** `overwatch` / `weekly` (schedule row from migration 177, with the nightly one).
- **Tools:** the **Alfred** connector (mcp v174 or later, for `get_platform_inventory` in Step 8), the **Claude_Code_Remote** connector
  (`list_triggers`) and **web search**. The **`overwatch` skill** must be available to the task.
- **Settings it reads** from the active plan: `weekly_day`, `audit_every_weeks`,
  `friction_trigger_count`, `friction_window_days`, `estimate_accuracy_min_shipped`,
  `estimate_correction_factor`. `pushes_per_day` and `push_time` are no longer read: what reaches
  Alex, and how often, is the dispatcher's (the plan's `delivery` section).
- **Spec:** `docs/technical-spec-overwatch-q4n.md` section 6 ("On the weekly day"), 4.10, 4.11 and
  4.12.
- **Edit rule:** change this file, then paste it into the task. Never edit the task alone. A change
  to procedure goes here; a change to judgment goes in the skill.

> ## 🛑 A CHANGE TO THIS FILE DOES NOTHING UNTIL IT IS PASTED INTO THE TASK
>
> The task runs the text that was pasted, not the text in this repo. So the prompt carries a
> version, and Step 11 echoes it.
>
> ### `PROMPT VERSION: 2026-11-06b`
>
> 2026-11-06b: Step 8b, every week: any non-Overwatch task prompt that writes to the inbox or notifies
> directly, judged from each enabled task's live text (`list_triggers`), raised as one signal.
>
> 2026-11-06a: signals only. Every item is one `raise_signal` whose `details.item` holds it; the
> dispatcher writes it and folds a repeat into the open item. No `create_inbox_item`, and the open
> items are read only to say "still open" in the note. A failed run raises a `failure` signal.
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
   note in `get_overwatch_notes`; a report showing `PROMPT VERSION: 2026-11-06b`.

---

## THE PROMPT — everything below the line goes into the task

---

You are running Overwatch's weekly review for Alex across every app in Alfred.
`PROMPT VERSION: 2026-11-06b`. **First, load the `overwatch` skill.** It tells you how to read the
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
   `raise_signal` (Steps 2.4, 9 and 10 only), `record_seen_releases`, and `update_friction` **with
   `pattern_id` only**. **Never** call `create_reminder`, `send_alfred_push`, `log_claude_notification`,
   `create_overwatch_plan`, `update_overwatch_checks`,
   `update_friction` with `status` or `resolved_by`, `update_project_plan`,
   `record_project_estimate`, `create_project_link`, `archive_inbox_item`, `update_inbox_item`, any
   app's own write tools, or any tool that creates, changes or runs a scheduled task. **Every change
   to the plan, including `estimate_correction_factor`, is proposed in an inbox item, never written.**
3. **COUNT WITH TOOLS; WORD THE NOTE YOURSELF.** Every count, date, name and figure comes from a
   tool response, except the accuracy ratios in Step 7, which you work out from the figures it
   names. If you do not have it, write `unknown`.
4. **NEVER IMPROVISE.** If you hit anything this prompt and the skill do not cover, **STOP** and
   report what you saw.
5. **EVERY ITEM IS A SIGNAL, AND OVERWATCH'S.** Never call `create_inbox_item`: every item is one
   `raise_signal` whose `details.item` has `source_app: "overwatch"`, and the dispatcher writes it.
   No repeat handling: never skip an item because one like it is open.
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
`status: "running"`, and no `started_at` (the server records it, and refuses one on a running
run). **Keep the run id.** If this call fails, skip Step 10,
raise the failure signal (Step 10, "On failed"), then Step 11.

### Step 2 — The dates, manual, and the weekly day

1. Work out **today's date in America/Los_Angeles** (`local_date`), its weekday, and its UTC offset.
   The week is `week_from` = `local_date` minus 7 days to `week_to` = `local_date` minus 1 day.
2. Decide `manual`: `true` if the message that started this run says it is manual, by hand, a test
   or a "run now"; otherwise `false`.
3. **The plan:** `get_overwatch_plan`. Keep `id`, `instructions` and `settings`. If it errors or
   returns no active plan, STOP with `failure_kind: "plan_read"`.
4. **The weekly day.** If `settings.weekly_day` is missing, STOP with
   `failure_kind: "settings_missing"`. If it is not today's weekday and `manual` is false: raise
   one item (Step 9's format, `severity: "normal"`, subject `overwatch:weekly:schedule_mismatch`)
   with first line
   `Overwatch: weekly schedule mismatch — ran <weekday>, plan says <weekly_day>`, title
   `Overwatch: weekly ran <weekday>, plan says <weekly_day>`, and the body "The Overwatch weekly task ran
   on <weekday>, but the plan's weekly_day is <weekly_day>. Change the claude.ai task's day and the
   overwatch/weekly schedule row's day_of_week to match, or change weekly_day through the plan
   gate.", then go to Step 10.3 and close `ok` with `details.not_weekly_day: true`. Do nothing else:
   no note, no other signal.

### Step 3 — Read the week

1. **Activity:** `get_activity` with `from: week_from`, `to: week_to`, `limit: 50`, paging with
   `offset` until the NOTE says there is no more. Keep each row's `kind`, `app_id`, `group_id`,
   `title` and date.
2. **The week's notes:** `get_overwatch_notes` with `from: week_from`, `to: local_date`,
   `limit: 50`. Keep each note's `for_date`, `period`, `body` and `flags`.
3. **Projects:** `get_project_plans` with `status: "all"`, `limit: 50`. Keep each row whole.
4. **Inbox items Overwatch already has open:** `get_inbox` with `source_app: "overwatch"`,
   `limit: 50`. Keep the first line of each, **only for the note**: an item raised this run whose
   first line matches an open one up to its " — " is "still open" in the note. Raise it anyway; the
   dispatcher folds it into the open item.

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
     14 days. Also disabled schedules, listed once. **`alfred` / `notify-dispatch` writes no runs**,
     so for it use `get_reminders` with `limit: 1` (scheduled only, soonest first) instead: a finding
     only when that reminder's `due_at` plus the schedule's `grace_hours` has passed.
   - **Scheduled tasks and schedule rows that do not match:** `list_triggers`. An enabled task with
     no `platform_schedules` row (by name, or by the app and job its prompt opens), and a schedule
     row with no enabled task. A task whose prompt carries a `PROMPT VERSION` older than the one in
     its schedule row's `notes`, when the notes name one.
   - **Apps with no profile or no rhythm:** `get_apps` against `get_records` with
     `table: "app_profiles"`: an app with no row, or with no `activity_recipe`.
   - **Routing:** inbox items routed to an app id that `get_apps` does not list.
3. **The inventory checks (Phase 7).** Read the inventory once: `get_platform_inventory` with
   `kind: "skill"`, then `kind: "task_prompt"` (one call each, `limit: 50`), `kind: "tool"` and
   `kind: "table"` (`limit: 50`, paging until the NOTE says there is no more: about 4 and 3 calls),
   about **9 calls** in all. Keep each part's `name`, `app_id`, `reads`, `writes`, `seen_at` and
   `details` (`tools` and `unknown_tools` for skills and prompts). Then, all worked out locally:
   - **Skills and prompts naming tools that are not in the inventory:** each name in a skill's or a
     live (not `details.history`) prompt's `details.unknown_tools`. Which of them are real (a tool
     that is gone or misspelt) and which are not tools at all is the skill's call; keep only the real
     ones.
   - **Apps with no skill:** each `get_apps` id that no skill's `app_id` names. Which of them need
     one is the skill's call; keep them all, the skill words the note.
   - **Tables no tool reads or writes:** each table part whose name is in no tool's `reads` or
     `writes`, **leaving out** every `platform.*` table and view (the registry, the audit and call
     logs, anon access and the conformance views: the platform's own plumbing, which tools never
     declare), and any table a trigger part writes (kept up by triggers, read through other tables
     or the app). A tool with `reads_any` (get_records) can read any of them, so say so once rather
     than counting it.
   - **Tools declaring a table missing from the inventory:** each name in a tool's `reads` or
     `writes` that is not a table part's name. The repo's tables test should make this empty; a
     finding means the snapshot and the inventory disagree.
   - **Not checked: two skills claiming the same trigger.** The inventory holds no skill descriptions
     or trigger phrases, so it cannot show this; leave it out and say so once in the note.
   - Also note the inventory's `seen_at` (the last rebuild): the checks are only as fresh as it is.
4. Set `drift_audit: true`. If a read errors, SKIP that check (`count:drift_audit`).

### Step 8b — Task prompts that write or notify directly (every week)

Every task except Overwatch's only raises signals (the `task-prompts` skill). This finds one that doesn't.
It runs every week, drift-audit week or not.

1. **The prompts.** `list_triggers` (Claude_Code_Remote; not the Alfred budget): every enabled, recurring
   task and its prompt text, which is what actually runs. Leave out Overwatch's own tasks (Overwatch
   nightly and weekly) and this one. Then `get_platform_inventory` with `kind: "task_prompt"`,
   `limit: 50` (one call; reuse Step 8.3's read on an audit week): each repo prompt's `name`,
   `app_id` and `details.version`, and `details.tools` (every registered tool the file names).
2. **Which to read closely.** Only a task whose text names one of `create_inbox_item`,
   `send_alfred_push`, `create_reminder` or `log_claude_notification`. Every prompt names them in its
   "never call" rule, so naming one is not a finding.
3. **Use or prohibition.** For each sentence or list line that names one of those tools, decide which:
   - **A prohibition** (not a finding): the sentence forbids it: "Never call …", "No `create_inbox_item`",
     "do not …", "not …", or a "never call" list.
   - **A use** (a finding): the sentence tells the task to call it ("Call `create_inbox_item` with …",
     "then `send_alfred_push`"), or lists it among the writes the task may make ("THE ONLY WRITES ALLOWED
     are …", "The only writes are …", "You may write …").
   - The allowed-writes rule wins: a tool in that list is a use even if a "never" sentence also names it.
     Unsure: count it as a use, and quote the sentence.
4. **Keep, per finding:** the task's name, the tool, the sentence (verbatim, up to 200 characters), and
   the repo file whose `name` matches (by the task's name or the app and job its text opens), with both
   versions: the live text's `PROMPT VERSION` and the file's `details.version`. A task with no repo file
   is kept as `no file`.
5. If `list_triggers` is not available or errors, SKIP this step (`count:direct_writes`). The inventory
   alone cannot decide it: it records which tools a prompt names, not how.

### Step 9 — Raise items

Every item is one `raise_signal`, never `create_inbox_item`:
- `app: "overwatch"`, `job: "weekly"`, `started_by: "task:overwatch-weekly"`.
- `severity`: `"high"` for a plan change; `"normal"` for a friction fix, newly possible and the
  drift audit; `"low"` for the feature watch.
- `subject_key`: stable from week to week, so a repeat folds into the open item:
  `overwatch:weekly:<kind>`, plus `:<the pattern, app or group id>` when the item is about one
  thing. Lower case, no spaces, no date; for example `overwatch:weekly:plan_change`,
  `overwatch:weekly:friction:<pattern id>`, `overwatch:weekly:releases`.
- `title`: the item's title without "Overwatch: ". For the feature watch and the drift audit,
  use the top entry or finding: `<N> new releases: <top entry>`,
  `drift audit, <N> findings: <top finding>`.
- `body`: one plain line on why it matters. No `link`.
- `details`: `{"kind": "info", "item": {"captured_text": "<the first line, then the rest>",
  "source_app": "overwatch", "source_metadata": {"task_name": "<its title>", "run_date":
  "<local_date>", "kind": "<kind>"}, "ai_reasoning": "Created by the overwatch/weekly scheduled
  task, run <run id>."}}`, and nothing else.
- `source_ref`: `<subject_key>:<local_date>`.

The inbox card shows `task_name` then `run_date`, not the first line, so each item names its `Title:`
to say what it is; the run stays on record in `ai_reasoning`. Never count, cap or skip them, and
never check what the nightly run sent: the dispatcher decides what reaches Alex and when. Keep each
returned signal id. A failed call is SKIPPED (`inbox:<first line>`). The weekly schedule mismatch
item (Step 2.4) uses kind `schedule_mismatch`.

1. **One per friction pattern** (Step 6.3), kind `friction_fix`. First line:
   `Overwatch: friction fix for <process> — <count> entries`.
   Title: `Overwatch: friction fix for <process>, <count> entries`. Then "<count> open entries in <friction_window_days>
   days:", one line per
   entry, then this paste-ready prompt, filled in from the skill's proposal:
   ```
   FOR CLAUDE.AI, NOT THE CLI
   Overwatch found a friction pattern in <process>: <count> open entries in <friction_window_days> days (pattern <pattern_id>). The entries: <one line each>. Proposed fix: <the fix, and the skill or file it changes>. If Alex agrees, make the change, then call update_friction with ids <the entry ids>, status "fixed" and resolved_by "<what changed>".
   ```
2. **One for the feature watch, when Step 5.3 kept anything**, kind `feature_watch`. First line:
   `Overwatch: new releases — <N> entries`. Title: `Overwatch: <N> new releases`. One line per entry: `<title> (<source>, <entry_key>):
   <summary>. Touches: <project or platform>.`
3. **One per newly possible parked project** (Step 4.2), kind `newly_possible`. First line:
   `Overwatch: <group name> may be newly possible — <the activity or release>`.
   Title: `Overwatch: <group name> may be newly possible`. Then its `waiting_on`, what makes it possible, and:
   ```
   FOR CLAUDE.AI, NOT THE CLI
   Overwatch thinks <group name> may no longer be blocked: it was waiting on "<waiting_on>", and <the activity or release>. Check with Alex whether to take it off the shelf; if so, clear hurdle_kind and waiting_on with update_project_plan.
   ```
4. **One for the correction factor, when Step 7.5 says so**, kind `plan_change`. First line:
   `Overwatch: plan change — estimate_correction_factor <current> to <suggested>`.
   Title: `Overwatch: estimate factor <current> to <suggested>`. Then each
   project's two ratios, and:
   ```
   FOR CLAUDE.AI, NOT THE CLI
   Overwatch proposes changing estimate_correction_factor from <current> to <suggested>, the median of actual over CLI estimate across <N> shipped projects: <one line each>. If Alex agrees, read the active plan with get_overwatch_plan and call create_overwatch_plan with the same instructions and settings, that one value changed, and the reason "Weekly estimate accuracy, <local_date>".
   ```
5. **One for the drift audit, when Step 8 found anything**, kind `drift_audit`. First line:
   `Overwatch: drift audit — <N> findings`. Title: `Overwatch: drift audit, <N> findings`. One line per finding.
6. **One for direct writes, when Step 8b found anything**, kind `direct_writes`, `severity: "high"`,
   `subject_key: "overwatch:weekly:direct_writes"` (stable, so a repeat folds into the open item). First line:
   `Overwatch: task prompts writing directly — <N> tasks`. Title: `Overwatch: <N> task prompts write directly`.
   One line per finding: `<task>: <tool> — "<the sentence>" (live <version>, repo <version or no file>)`. Then:
   ```
   FOR CLAUDE.AI, NOT THE CLI
   Overwatch found task prompts that write to the inbox or notify directly: <task: tool, one each>. Load the task-prompts skill, compare each with its file in docs/, and propose the change that moves it to raise_signal with details.item.
   ```

### Step 10 — Write the note and close the run

1. **The weekly note:** `create_overwatch_note` with `period: "weekly"`, `for_date: <local_date>`,
   and:
   - **`body`**: markdown, worded the way the skill says, in the plan's `instructions` voice, with
     the nightly note's rules: **no title line**; friendly dates ("Oct 15", never 2026-10-15);
     **every record named as a markdown link** `[Name](https://alfredv5vibe.vercel.app/<id>)`
     (projects to `https://alfredv5vibe.vercel.app/groups/detail/<group_id>`, inbox items to
     their id), never a bare URL. Exactly this shape:
     ```
     ## Action Required
     - <what this week needs from Alex, most important first: task prompts writing directly, plan change, friction fixes, newly possible, new releases that matter, drift audit findings; "Nothing needs you this week." when none>
     ## The Week
     - <what shipped, then what progressed, by project and app; the week's nightly flags that stayed open>
     - Ideas: <count>, oldest untouched <name as a link>; newly possible <names as links>
     - Estimates: <accuracy, or why it waits>
     - Drift audit: <findings, or when it is next due>
     - Task prompts: <"every task only raises signals (<N> checked)", or the tasks that write directly>
     ```
     Items "still open" say so.
   - **`flags`**: `shipped`, `progressed`, `ideas` (count, oldest), `newly_possible`,
     `new_releases`, `friction_patterns`, `estimate_accuracy`, `drift_audit` (the findings, or
     `not_due`), `direct_writes` (Step 8b's findings, an empty list when none, left out when skipped),
     `signals` (the signal ids from Step 9), `skipped`, `settings_missing`.
   - If it errors, STOP with `failure_kind: "note_write"`.
2. **Signals** were raised in Step 9; nothing more here.
3. **Close the run:** `update_platform_run` with the run id, **once**.
   - **`status`:** `failed` if a step said STOP; `partial` if anything is in `skipped`; else `ok`.
   - **`details`**, always: `local_date`, `prompt_version: "2026-11-06b"`, `manual`, `plan_id`,
     `drift_audit` (true or false), `direct_writes` (the count, or `"skipped"`), `prompts_checked`, `note_id`,
     `signal_ids`, `signals_raised`, `new_releases`,
     `friction_patterns`, `shipped_count`, `skipped`, `settings_missing`, and `not_weekly_day` when
     it applies.
   - **On `failed`:** `error_message` is the verbatim error, and `details.failure_kind` is one of
     `plan_read`, `settings_missing`, `week_read`, `note_write`, `run_open`, `unknown`. **Never
     downgrade a failure to `ok` to get past a rejected close.**

**On `failed`, first** call `raise_signal` once, and put its id in `details.failure_signal_id`
(a failed call goes in `details.signal_error`, verbatim; it does not change the close):
`app: "overwatch"`, `job: "weekly"`, `started_by: "task:overwatch-weekly"`, `severity: "high"`,
`subject_key: "overwatch:weekly:failure:<failure_kind>"` (no date, so repeats fold into one item),
`title: "Overwatch weekly FAILED: <failure_kind>"`, `body`: the error in one line,
`source_ref: "overwatch:weekly:failure:<failure_kind>:<local_date>"`, and `details`:
`{"kind": "failure", "item": {"captured_text": "<the text below>", "source_app": "overwatch",
"source_metadata": {"task_name": "Overwatch weekly FAILED: <failure_kind>", "run_date": "<local_date>", "kind": "failure"}}}`,
with this text:

```
Overwatch weekly FAILED — <failure_kind>, <local_date>

The weekly review did not finish. It changed nothing it should not have.
Error: <verbatim error>
Run: <run id>
```

### Step 11 — Report

Write a short report:
- `PROMPT VERSION: 2026-11-06b`;
- the run id and its status, and `manual: true` or `manual: false`;
- whether the drift audit ran; how many task prompts Step 8b checked and any that write directly;
- the note id and the signals raised;
- `skipped` and `settings_missing`, if any;
- any error, verbatim.

Nothing else.
