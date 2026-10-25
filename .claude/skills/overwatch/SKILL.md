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

## Scheduled runs: the prompt owns the procedure, this skill owns the judgment

Each Overwatch scheduled task runs a prompt from the repo that owns its procedure: the
steps, the writes it may make, the run record, failure handling, limits and its PROMPT
VERSION. This skill owns only the judgment the steps call for. Where the two disagree, the
prompt wins. Never repeat a prompt's steps here; change them in the prompt.

## The nightly run (scheduled task `overwatch/nightly`)

The procedure is `docs/overwatch-nightly-task-prompt.md`. The judgment it asks for:

- **Reading an app.** Its `activity_recipe` is Alex's own words for what counts as use or
  progress. Read it literally: the tools it names, and the record it names as the sign of
  use. `used` means he opened or played the app; `progress` means something moved (a
  practice pass, a tagged transaction, an application sent). When the recipe does not say,
  log nothing for that app. Don't guess. `current_state` says what the app is for right now;
  use it to judge whether a quiet app matters ("finished, kept for reference" does not).
- **Fading.** A candidate is old by the dates; it is fading only if it still means to happen.
  Not fading: reference items, someday-style holders, recurring intentions that are simply
  between occurrences, and anything a `focus` or `keep_an_eye_on` watch item names. Fading:
  a one-off intention or an active item that was started or promised and has gone silent.
  When unsure, include it; the item asks keep, park or let go.
- **A deadline with no date.** An active intention with no event whose text or description
  names a cutoff: "by", "before", "claim by", "expires", "points expire", "deadline",
  "due", "renew", "cancel before", or a month, a date, a season or "end of the year". A bare
  time period with no cutoff ("for a month", "weekly") is not a deadline. Quote the words
  that make it one.
- **The note.** Follow the plan's `instructions` for focus and tone. Plain, short lines,
  most important first, each naming the app or project and what Alex can do. Say what
  changed since the last note, not everything that is true. Never soften a count, and never
  invent one. A quiet night is one line: "Nothing needs you tonight."

## The weekly run (on the plan's `weekly_day`)

Its prompt, to come, will take the procedure below the same way, and this section will shrink
to its judgment. Until then, everything the nightly run does, plus:
- the weekly note (`period: "weekly"`): what shipped, what progressed, and the ideas list
  (count, oldest untouched, newly possible);
- parked projects with `hurdle_kind: "technology"`: compare their `waiting_on` with the
  week's shipped activity and new releases;
- feature watch: search Anthropic's release notes and the Claude Code changelog, pass what
  was read to `record_seen_releases`, and raise one inbox item listing the `recorded`
  entries that could unblock a parked project or change the platform;
- friction: `get_friction` (open), group entries by process with `update_friction`
  (`pattern_id: "new"` once, then that id), and for a process with three or more open
  entries in 30 days, one task inbox item proposing a fix with a paste-ready prompt. Only
  `open` entries count; `update_friction` closes them as `fixed` (`resolved_by`) or
  `wont_fix` (`wont_fix_reason`, one line);
- estimate accuracy, once `estimate_accuracy_min_shipped` projects have a `final` row:
  actual against original and against scope-adjusted for each, and a suggested
  `estimate_correction_factor`, which changes only through `create_overwatch_plan`;
- every `audit_every_weeks` weeks, the drift audit: skills naming missing tools, two
  skills claiming the same trigger, schedules with no recent run, apps with no skill,
  tables no tool reads.
