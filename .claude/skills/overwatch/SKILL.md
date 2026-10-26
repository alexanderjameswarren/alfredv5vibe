---
name: overwatch
description: "Overwatch, Alex's view across every Alfred app: what he did, is doing and wants to do, what has stalled or gone quiet, and what has drifted. Load it whenever he asks what needs his attention, for triage or routing of his inbox across apps (\"scan Alfred for money to-dos\"), about his projects, stalls, plans or ideas, about Overwatch's note, watch items or plan, or about process friction; and for the Overwatch nightly and weekly scheduled runs. Load it alongside an app's own skill when the question is about one app."
---

# Overwatch

Skill version: 2026-10-26a

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
   `sam-practice` and the others) rather than doing its work here. Use the note's wording
   rules (below): friendly dates, records as links, the inbox as "<N> items. Nothing
   urgent." unless something is urgent, and a stopped schedule or task offered as a bug to
   log.

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
- **Every Project holds at least one item or intention.** Whenever you suggest creating a
  Project, also suggest an overview item outlining it, pushed to the inbox for Alex to file
  and attach: `create_inbox_item` with `suggest_item: true`, `suggested_item_text`,
  `suggested_item_description`, `suggested_item_elements`, `suggested_context_id` and
  `source_app` when known. The nightly note lists Projects that are still empty.

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
for a pattern. Only `open` entries count toward one; when Alex says, close entries with
`update_friction` as `fixed` (`resolved_by`) or `wont_fix` (`wont_fix_reason`, one line).

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
- **When an app was last used.** If the activity log has no row for an app, its real last
  use is in its own data: the newest record its recipe names (the last job application, the
  last Ken attempt, the last Money review). Use that date. "Unknown" is only for an app with
  no data at all.
- **Fading.** A candidate is old by the dates; it is fading only if it still means to happen.
  Not fading: reference items, someday-style holders, recurring intentions that are simply
  between occurrences, and anything a `focus` or `keep_an_eye_on` watch item names. Fading:
  a one-off intention or an active item that was started or promised and has gone silent.
  When unsure, include it; the item asks keep, park or let go.
- **A deadline with no date.** An active intention with no event whose text or description
  names a cutoff: "by", "before", "claim by", "expires", "points expire", "deadline",
  "due", "renew", "cancel before", or a month, a date, a season or "end of the year". A bare
  time period with no cutoff ("for a month", "weekly") is not a deadline. Quote the words
  that make it one, and when they name a date, read it as the next such date ("by March"
  in October is next March).
- **The note.** Follow the plan's `instructions` for focus and tone. Plain, short lines,
  most important first, each naming the app or project and what Alex can do. Say what
  changed since the last note, not everything that is true. Never soften a count, and never
  invent one. The prompt sets its shape (no title; "Action Required", then "Yesterday's
  Activity"); the wording within it is yours:
  - friendly dates, "Oct 15", never 2026-10-15;
  - every record by name, as a link: `[Renew passport](https://alfredv5vibe.vercel.app/<id>)`,
    never a bare URL;
  - quiet apps as "Jobs (3 days)";
  - a schedule or task that stopped is **a bug to log**, said that way: "Log a bug:
    notify-dispatch has had no ok run since Oct 20." The same in chat: offer to log it.
  - Yesterday's Activity is one bullet per app, the thing done, not the rows: "Sam: 3
    practice passes", "Money: 14 transactions reviewed".
  - A quiet night under Action Required is one bullet: "Nothing needs you tonight."

## The weekly run (scheduled task `overwatch/weekly`)

The procedure is `docs/overwatch-weekly-task-prompt.md`. The judgment it asks for:

- **The week.** Say what moved, by project and app: shipped first, then progress, then
  what was used. Group many small rows into one line ("12 SAM practice passes"). A
  nightly flag that stayed up all week is worth a line; one that cleared is not.
- **Newly possible.** A parked `technology` project is newly possible when something
  shipped or released this week does what its `waiting_on` asks for, not merely something
  nearby. Name the activity row or release and the words in `waiting_on` it answers. When
  unsure, say "may be" and raise it; Alex decides.
- **New releases that matter.** One touches a parked project when it answers that
  project's `waiting_on`, and touches the platform when it changes how Claude, the CLI,
  connectors, skills or scheduled tasks work for Alfred. Ignore pricing, model launches
  with no feature change, and other products.
- **A friction pattern and its fix.** Read the entries together: the shared cause, not
  the three symptoms. Propose one change, small and specific, to the skill or prompt rule
  that caused it (`process: "skill:<name>"` points at it), and name the file. When the
  entries do not share a cause, say so in the item and propose no fix.
- **Estimate accuracy.** Report actual against original and against scope-adjusted for
  each shipped project; a project that ran over only through scope changes was well
  estimated. Keep the note to the ratios and the suggestion.
- **The note.** As for the nightly note: the plan's `instructions`, plain short lines,
  most important first, never a softened or invented count.
