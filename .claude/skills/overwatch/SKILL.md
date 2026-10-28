---
name: overwatch
description: "Overwatch, Alex's view across every Alfred app: what he did, is doing and wants to do, what has stalled or gone quiet, and what has drifted. Load it whenever he asks what needs his attention, for triage or routing of his inbox across apps (\"scan Alfred for money to-dos\"), about his projects, stalls, plans or ideas, about a portfolio plan (what to work on in what order, its lanes, slices and theory), about Overwatch's note, watch items or plan, or about process friction; and for the Overwatch nightly and weekly scheduled runs. Load it alongside an app's own skill when the question is about one app."
---

# Overwatch

Skill version: 2026-10-28a

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

### Portfolio plans (the order Alex means to work in)

- **A portfolio is a body of work planned on its own.** The Alfred ecosystem is one, and client
  work (Team IMPACT, ActBlue) is another. **Keep client work in its own portfolio:** never put a
  client Project in the Alfred plan, or the other way round. `get_portfolios` lists them, each with
  its contexts and its active plan in brief (the theory's first line, `review_by`, slice counts by
  status). `upsert_portfolio` creates one, or renames it, sets its contexts, position or archived.
- **A plan version** is a `theory`, its lanes, and their slices. `get_portfolio_plan` reads the
  active version, or one named by `plan_id`, plus the list of versions.
  - **The theory** is Alex's ordering principles, in his words, e.g. "bugs first, then tools that
    make the work faster, then X because it solves Y". Read it before you suggest any change, and
    weigh the change against it.
  - **`notes_for_next_review`** says what to reconsider next time, and `review_by` says when.
  - **Lanes** are named per version, as many as the plan needs ("Main", "SAM", "Client work"), each
    with an optional note on what it is for. Renaming, adding or removing a lane is a new version.
  - **A slice** is a Project group plus the phases done in it (`phases`; none means the whole
    project). The same project can appear in several slices, so it can be partly done, paused and
    resumed later (A phases 2-3, B phase 1, A phase 4). Each slice has a `why` in terms of the
    theory, and a status: `planned`, `in_progress` (at most one per lane), `done`, or `paused` with
    `paused_reason`.
- **Two kinds of change.**
  - Starting, finishing or pausing a slice is **not** a new version: `update_portfolio_slice`,
    tier 2, or "Change status" on the plan page.
  - Anything else (reordering, adding or removing slices or lanes, a new theory) is a new version:
    `create_portfolio_plan`, **tier 3**. Pass the whole plan: the theory, a `reason`, and every lane
    with its slices. **The first call writes nothing and returns a proposal. Always show Alex that
    proposal, word for word, and wait for him to approve it before calling again with
    `confirmed: true`.** Never confirm on your own, in chat or in a scheduled run.
- **Talking a plan through:** theory first, then the lanes, then the slices in order, each with its
  why. Ask about the theory before you argue about any one slice.
- **When to suggest a review:**
  - `review_by` has passed (the nightly note flags it);
  - a slice was marked done, so what comes next may have changed;
  - a Project in the plan was closed, or a Project in the portfolio's contexts is in no slice ("Not
    in the plan" on the tab);
  - `notes_for_next_review` names something that has now happened.
  Suggest it in one line, with the plan link
  (`https://alfredv5vibe.vercel.app/overwatch/plan/<portfolio_id>`). Do not write a version unasked.

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
- **The tables a finish summary touched** (count 11b). A migration's file name usually names
  its table (`180_overwatch_platform_inventory.sql` is platform_inventory): match the inventory's
  table names against the words in each migration path, longest name first, and take every
  table named. Look at the summary's changed tools' tables only when it has no migration, or a
  migration whose name matches no table. Five tables a night is plenty; take the ones the
  migrations name first.
- **What counts as a follow-up** (count 11f). One is a thing Alex would otherwise forget that
  the Finish made necessary somewhere it did not touch:
  - `table_users`: a part that reads or writes a table the work changed, outside the work. A
    tool or skill that **reads** a table that gained or changed columns is a follow-up (does it
    still return what it should?). One that only **writes** it, a trigger, or the audit is not,
    unless the migration dropped or renamed something. Skip the parts of the same app as the
    work when the summary also changed that app's tools: the work most likely covered them.
  - `tool_in_no_skill`: a tool the work added or changed that no skill names, so no chat will
    think to call it. Not a follow-up for tools only scheduled prompts call; say so instead.
  - `skill_to_paste`: always a follow-up, one per skill changed. A claude.ai skill runs the
    pasted text, so a skill changed in the repo is stale until Alex pastes it.
  When unsure, raise it; a follow-up is cheap to archive and an unnoticed break is not.
- **When to rewrite `current_state`** (count 11g). Only when the work changes what the app
  **does** for Alex: a new screen or section, new tools he would use in chat, a new kind of
  record. Not for fixes, refactors, tests, docs or plumbing. Keep the rewrite to the existing
  page with one or two sentences added or changed, in the same plain voice; never shorten or
  reorder the rest.
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
- **Names that look like tools but are not missing tools** (drift audit). `unknown_tools` lists
  every name shaped like a tool (get_x, create_x, set_x) that is not a registered Alfred tool.
  Most are not missing tools: arguments and fields (`search_text`, `set_kind`, `check_on`,
  `split_id`, `set_video_id`), placeholders in examples (`create_thing`, `get_my_thing`), SQL
  functions and RPCs (`set_read_settings`), and **tools on other connectors**: the Workshop
  Surface tools (`create_dj_playlist`, `get_dj_playlists`, `get_dj_album`,
  `get_dj_library_albums`, `get_dj_artist_top_songs`, `search_dj_music`, `get_dj_history`,
  `get_workshop_status` and the rest of that connector). A finding is a name a skill or prompt
  tells Claude to **call** that exists nowhere: gone, renamed or misspelt.
- **Apps with no skill.** An app with no skill is fine when it has no chat flow: a screen-only
  app (Timer, Games), a hardware or desktop app run elsewhere (Workshop, Switchboard), or an app
  not built yet (Arnold, Monty Don, Sports, while they are ideas). Name it only when chats about
  it are happening (activity or inbox items routed to it) with no skill to guide them.
- **Tables no tool touches.** Many are read by the app's screens directly, not through a tool
  (push subscriptions, notification steps): that is not drift. A finding is a table nothing
  reads at all: no tool, no screen you know of, no trigger. Say "may be unused" and let Alex
  decide; never propose dropping it.
- **The note.** As for the nightly note: the plan's `instructions`, plain short lines,
  most important first, never a softened or invented count.
