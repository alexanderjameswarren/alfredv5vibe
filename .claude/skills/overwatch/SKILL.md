---
name: overwatch
description: "Overwatch, Alex's view across every Alfred app: what he did, is doing and wants to do, what has stalled or gone quiet, and what has drifted. Load it whenever he asks what needs his attention, for triage or routing of his inbox across apps (\"scan Alfred for money to-dos\"), about his projects, stalls, plans or ideas, about Overwatch's note, watch items or plan, or about process friction; and for the Overwatch nightly and weekly scheduled runs. Load it alongside an app's own skill when the question is about one app."
---

# Overwatch

Overwatch keeps Alex aware of his whole life in Alfred: what got done, what is moving,
what is stalled, what is waiting on him, which apps have gone quiet, and what has drifted.
It is allowed to be pushy, within the limits in its own plan.

Spec: `docs/technical-spec-overwatch-q4n.md` in the alfred-v5 repo.

## Four rules that hold everywhere

1. **Read the lists, not a list in this file.** Apps come from `get_apps` and each app's
   profile (`activity_recipe`, `rhythm_days`, `current_state`, written with
   `update_app_profile`). A new app is a new row, never a change here.
2. **Count with tools; write the judgement.** Stalls, gaps, backlogs and limits are counted
   from tool results. Claude only words the note and the nudges.
3. **One gate for changing Overwatch.** `update_overwatch_checks` is free. Anything else
   about the plan (instructions or settings) changes only through `create_overwatch_plan`,
   which is tier 3. In a scheduled run, never call it: propose the change as a task inbox
   item with a paste-ready prompt. In chat, call it only when Alex has agreed the change,
   show him the proposal, and confirm only after he approves it.
4. **Every inbox item has one owner app.** Each app's skill reads only its own items. You
   route; you do not do an app's work for it.

## In chat

### "What needs my attention?"

1. **Route first.** `get_inbox` with `source_app: "none"`. Items still at
   `ai_status: "not_started"` have not been reached by the hourly job: enrich and route
   them now, following the `alfred-enrich` skill (it is the router; load it). Items left
   unrouted on purpose keep their reason.
2. **Read Overwatch's note.** `get_overwatch_notes` with `limit: 1` for the latest; its
   `flags` hold the findings.
3. **Fill in what has changed since.** `get_project_plans` (stalls, waits, overruns),
   `get_inbox` per app for backlogs, and `get_overwatch_watch` for what is in force.
4. **Answer in order of importance**, a line each, naming the app or project. For a deep
   dive into one app's items, hand over to that app's skill (`wb-planning`, `job-search`,
   `sam-practice` and the others) rather than doing its work here.

### Projects

- `get_project_plans` lists Project groups with their plan and counted effort
  (`steps_used`, `reports`, `last_report_at`). `has_plan: false` means a Project with no
  plan yet: offer to write one.
- `update_project_plan` writes the plan: `where_now`, `next_step`, `waiting_on` and
  `waiting_on_kind`, `target_date`, `hurdle_kind` when parking it. Not the estimate.
- `record_project_estimate` is the only way to change `effort_estimate` (`initial`,
  `scope_increase`, `scope_decrease`, `re_estimate`, `final`, each with a reason);
  `get_project_estimates` reads the history with original and scope-adjusted totals.
- `create_project_link` records `notify_on_ship`, `no_parallel` or `depends_on` between
  two Projects; `get_project_links` reads them.
- Groups are made in the app, never by a tool. Shipping a project means closing its group
  as Completed in the app; that writes the shipped row itself.

### Watch items

`create_overwatch_watch` for a dated `focus`, `ease_off` or `keep_an_eye_on`, pointing
at an `app_id` or `group_id` when it is about one. An `ease_off` on an app stops its
quiet days counting. `update_overwatch_watch` changes one.

### The plan

`get_overwatch_plan` reads it whole. To change it, see rule 3: pass the whole
instructions and the whole settings, with a reason; show Alex the proposal; confirm only
after he approves.

### Friction

When Alex misses or misreads an instruction, says a format or flow is not working, or has
to correct how something was presented, call `log_friction` without asking (`process` is
`cli_testing_steps`, `cli_prompt`, `todos`, `closeout`, `inbox`, `other` or
`skill:<name>`), and mention it in one line. Do not fix anything on one entry; fixes wait
for a pattern.

## The nightly run (scheduled task `overwatch/nightly`)

Open the run first: `create_platform_run` with app `overwatch`, job `nightly`, executor
`claude`, status `running`. Close it last with `update_platform_run` (`ok`; `partial` when
a step failed; `failed` with `error_message` and `details.failure_kind`).

1. **Read.** `get_overwatch_plan` (settings and today's checks), `get_overwatch_watch`,
   `get_apps` with each app's profile, `get_project_plans`.
2. **Pull.** For each app with an `activity_recipe`, follow it, and write at most one row
   per app per day with `log_activity` (`kind` `used` or `progress`, `source: "nightly"`,
   `source_ref: "<app>:<YYYY-MM-DD>"`, so a re-run adds nothing).
3. **Count.** From the tools, not by judgement:
   - quiet apps: last activity (`get_activity` with `app_id`) older than `rhythm_days`,
     unless an `ease_off` watch item covers the app;
   - stalled projects: no CLI report (`last_report_at`) for `stall_days`, and not waiting
     on another project;
   - waiting on Alex longer than `waiting_on_alex_days` (`status_written_at`);
   - overruns: `steps_used` above `effort_estimate` (the current estimate, scope changes
     included) × `overrun_factor`, or past `target_date`;
   - scope changes since the last run: new `scope_increase` or `scope_decrease` rows in
     `get_project_estimates`, noted in tonight's note with their reasons;
   - active projects above `active_project_limit`;
   - inbox backlog per app above `inbox_backlog_threshold`, with the oldest item's age;
     unrouted items, and unrouted items older than a day;
   - stopped schedules: `get_platform_schedules` against `get_platform_runs`, no `ok` run
     within `expected_by` plus `grace_hours`;
   - repeated claim blocks: `get_claim_blocks`, three or more episodes (distinct
     `blocked_at`) between the same two codes in 30 days;
   - fading items and intentions: active, with no activity for `fading_days`;
   - watch items that ended since the last run.
4. **Act.**
   - Write tonight's note: `create_overwatch_note` with `period: "nightly"`, a short body,
     and every finding in `flags`.
   - A stall or overrun: one task inbox item holding a status-request prompt for the
     project's worktree or thread, with a new run tag.
   - A fading item: one task inbox item asking keep, park or let go.
   - A proposed `no_parallel` link or plan change: one task inbox item with a paste-ready
     prompt (rule 3).
   - Inbox items here use `create_inbox_item` with `source_type: "task"`,
     `source_app: "overwatch"` and `source_metadata.task_name`.
   - At most `pushes_per_day` nudges, at `push_time`, each a `create_reminder` linked to
     one of those inbox items, most important first.
   - Mark expired watch items noted (`update_overwatch_watch` `expiry_noted: true`).
   - `update_overwatch_checks` with what the next run should look at.

## The weekly run (on the plan's `weekly_day`)

Everything the nightly run does, plus:
- the weekly note (`period: "weekly"`): what shipped, what progressed, and the ideas list
  (count, oldest untouched, newly possible);
- parked projects with `hurdle_kind: "technology"`: compare their `waiting_on` with the
  week's shipped activity and new releases;
- feature watch: search Anthropic's release notes and the Claude Code changelog, pass what
  was read to `record_seen_releases`, and raise one inbox item listing the `recorded`
  entries that could unblock a parked project or change the platform;
- friction: `get_friction` (open), group entries by process with `update_friction`
  (`pattern_id: "new"` once, then that id), and for a process with three or more open
  entries in 30 days, one task inbox item proposing a fix with a paste-ready prompt;
- estimate accuracy, once `estimate_accuracy_min_shipped` projects have a `final` row:
  actual against original and against scope-adjusted for each, and a suggested
  `estimate_correction_factor`, which changes only through `create_overwatch_plan`;
- every `audit_every_weeks` weeks, the drift audit: skills naming missing tools, two
  skills claiming the same trigger, schedules with no recent run, apps with no skill,
  tables no tool reads.
