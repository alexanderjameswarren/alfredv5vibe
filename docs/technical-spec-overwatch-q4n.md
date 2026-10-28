# Technical spec: Overwatch (overwatch-q4n)

Status: approved, revised after the plan step, 2026-10-24; Phases 7 and 8 revised 2026-10-27 (plan overwatch-q4n-s38a-h4tw, decisions written in Step 39)
Source of the facts below: the read-only discovery report (run tag overwatch-q4n-s1-k8vd) and the plan report (overwatch-q4n-s2-r3mb).

## 1. What Overwatch is

A new Alfred app with its own tab, plus a nightly Claude job, that keeps Alex aware of:

- **What he did:** a log of finished work and progress across every app, filterable by date range, app, context and tag. Later, all client work shipped.
- **What he is doing:** every active project, where it stands, what it is waiting on, and whether it has stalled.
- **What he wants to do:** someday ideas and parked projects, with the reasons they were parked, so nothing is forgotten and nothing is reinvented.
- **What he is not using:** apps and habits that have gone quiet against their expected rhythm.
- **What has drifted:** skills, tools, functions and schedules that no longer match each other, and follow-up work a finished project created elsewhere.

It is allowed to be pushy, within limits set in its own plan.

## 2. Principles

1. **Instructions stay fixed; lists grow.** No prompt names a specific app. Prompts read the `apps` table and Overwatch's own tables. A new app, client or hobby is a new row, not new code or a new prompt.
2. **Status is written while working, never gathered afterwards.** A scheduled task cannot reach chat threads or project chats. Every thread and CLI session reports into Alfred; Overwatch reads Alfred.
3. **Counting is done by queries; Claude writes the judgement.** Stalls, gaps, backlogs and limits are exact database queries. Claude only words the note and the nudges.
4. **One gate for changes to Overwatch itself.** Overwatch may freely update its own "checks for next run". Changes to its settings or instructions arrive as a paste-ready prompt in the inbox, which Alex talks through in a thread. When Alex changes them in chat himself, the change is written directly.
5. **Every inbox item has exactly one owner, and an app only touches items it owns.** The hourly enrichment job is Overwatch's router (it may be renamed "Overwatch hourly enrich"): it sets each item's `source_app` from the apps descriptions. When it is not sure, it leaves the app blank and says why in `ai_reasoning`; Alex assigns it with the app picker. A wrongly routed item is worse than an unrouted one. Every app skill reads the inbox filtered by its own app id, never the whole inbox, and reassigning an item's app moves it to the other app's queue. Example: a health insurance bill belongs to Warren Buffet; Arnold never sees it. Overwatch's nightly job audits this: unrouted items, items routed with low confidence, and any app skill that reads the inbox without its own app filter.
6. **Follow the house rules.** Every database change is a numbered migration with `platform.register_table`, explicit grants to authenticated and service_role (no anon), and a CONFORMANT conformance check. New UI follows existing Alfred patterns (modals for confirmations, RecordLinks header, 8px corners, colour meanings). Tools are built with `defineTool`.

## 3. What already exists and is reused

- `apps` table (migration 116): id, name, description, icon, path, button_name.
- Status on items, intents and item_groups: status (someday, active, background, closed), status_changed_at, status_written_at, last_completed_at, maintained by triggers.
- `closed_reason` on items, intents and item_groups: `done` or `wont_do` (migration 153).
- Executions: status active, paused or closed; outcome done or skipped. Closing lives in `src/executions/useExecutionActions.js`.
- Groups: item_groups, item_group_members, group_types (Menu, Project, Series). Groups have no dates, effort or links.
- Notes table (item, intention, group targets).
- Inbox with source_type `task` items for scheduled jobs, and a Copy button.
- Reminders and push notifications (`create_reminder`), with the rule that every notification is backed by an inbox item.
- `platform_runs` and `platform_schedules`.
- `clips` plus `scripts/clip.mjs` (CLI reports arrive with run tag, repo and branch).
- Claims and blocks in `.git/alfred-claims.json` and `.git/alfred-claim-blocks.json`.
- gitpush finish hook point: `scripts/git-push-worktrees.mjs`, after `mergeWorktree` succeeds and before `removeClaims`.

The Phase 9 proposal inbox does not exist. Overwatch does not need it: its proposals are plain task inbox items carrying a paste-ready prompt. Phase 9 can later turn them into one-tap applies.

## 4. Data model

All tables: `user_id` defaulting to `auth.uid()`, RLS owner-only, registered, commented, explicit grants, audited where noted.

### 4.1 Plumbing changes to existing tables

**clips:** add `run_tag text`, `repo text`, `branch text`, plus an index on `run_tag text_pattern_ops` for prefix searches. `clip-capture` writes them; a migration backfills them from the paired `inbox.source_metadata`. `get_recent_clips` keeps its current inputs and outputs.

**platform_runs, platform_schedules:** replace the six-app check constraint with a foreign key to `apps(id)`. The MCP tools' `app` input becomes free text validated against `apps`.

**apps:** unchanged, because it is shared and has no owner, so a tool editing it could change rows for every signed-in user. Add an `overwatch` apps row with path `/overwatch` (migration).

**app_profiles** (new, per user): `user_id`, `app_id` (FK apps), unique on the pair, plus
- `activity_recipe text`: plain words telling the nightly job how to read this app's activity and what counts. Example: "One row per practice day: total minutes and songs touched, from get_sam_sessions."
- `rhythm_days integer`: how many days of silence before the app counts as quiet. Null means no rhythm (Timer, Games).
- `current_state text`: about one page describing what the app does today, its main flows and known gaps.
- `current_state_updated_at timestamptz`.

`update_app_profile` (tier 2) writes it.

**group_types:** add a stable `key` column (`project`, `menu`, `series`), backfilled from the seeded labels. Everything in Overwatch finds Project groups by `key = 'project'`, never by label, so renaming "Project" breaks nothing.

**inbox (Phase 8c, decided 2026-10-27):** add `suggested_group_id text`, FK `item_groups(id)` on delete set null, nullable. See 4.17.

**Seeding:** schedule rows and the starting plan are seeded by migrations, taking the user id from a known context row as migration 091 does.

### 4.2 activity

The log of what got done. Rows are only inserted, never edited by tools.

| column | notes |
|---|---|
| id | uuid |
| user_id | |
| occurred_at | timestamptz, when the work happened |
| app_id | text, FK apps |
| context_id | FK contexts, nullable |
| group_id | FK item_groups, nullable (the project) |
| target_type | item, intention, group, execution, job_application, other |
| target_id | text, nullable |
| kind | `shipped`, `done`, `progress`, `used` |
| title | one line |
| summary | short text, nullable |
| source | `trigger`, `claude`, `cli`, `nightly`, `manual` |
| source_ref | text, nullable; the source record's id or run tag |
| tags | text array; a snapshot of the record's tags when the row was written |
| created_at | |

Unique on (user_id, source, source_ref) where source_ref is not null, so nothing is logged twice. The UI may delete a wrong row, with a confirm modal.

`app_id` comes from the context's `app_id`, defaulting to `alfred`. `tags` is copied from the item, intention or group at write time, so activity can be filtered by tag; it is a snapshot on purpose, because history should show how a thing was tagged when it happened.

**Triggers that write activity.** Closing as done creates an execution only for a first-time completion of an intention (`closeRecords` in `src/intentions/useIntentionActions.js`), and that execution arrives as an INSERT already closed. So there are three triggers:
- **executions**, after insert, update or delete: an execution that is closed with outcome `done` writes one `done` row; deleting it (Undo) deletes the row. It skips an execution whose intention was closed `done` at the same `closed_at`, and the execution on a Project group's own intention, so nothing is logged twice.
- **items and intents**, on a close with closed_reason `done`: one `done` row, unless the executions trigger already logged this close.
- **item_groups**, on a close with closed_reason `done` where the group type's key is `project`: one `shipped` row.

Activity rows are inserted and deleted only by these triggers and `log_activity`; tools never edit them.

### 4.3 project_plans

Planning fields for Project-type groups only, one row per group.

**Every Project group holds at least one item or intention (decided 2026-10-25).** Whenever Claude suggests creating a Project, it also suggests an overview item outlining it, pushed to the inbox with `create_inbox_item` (`suggest_item` and the `suggested_item_*` fields) for Alex to file and attach. A new group starts as Someday; Alex sets it to Active.

| column | notes |
|---|---|
| group_id | PK, FK item_groups |
| project_code | text, nullable; the CLI project code (e.g. overwatch-q4n), which links run tags to the project |
| target_date | date, nullable |
| effort_estimate | integer, nullable; estimated CLI steps |
| where_now | one line: where it stands |
| next_step | one line |
| waiting_on | one line, nullable |
| waiting_on_kind | `alex`, `decision`, `project`, `hurdle`, nullable |
| waiting_on_group_id | FK item_groups, nullable (when waiting on another project) |
| hurdle_kind | `technology`, `time`, `money`, `skill`, nullable; set when parked |
| status_written_at | timestamptz; when the status line was last written |
| updated_at | |

Actual effort is counted, not stored: the number of distinct step numbers in run tags under the project code.

**steps_used counts only CLI run tags (2026-10-27).** A project worked outside the CLI (a client project, a claude.ai-only project) shows 0 steps used; its progress is kept by hand through `update_project_plan` (where_now, next_step) and its portfolio slices' status (4.16). An hours unit is deferred until a client project needs it.

`effort_estimate` is the **current** estimate. It changes only together with a new project_estimates row (4.12), so every figure the project has had is kept with its reason.

Priority is not stored here. The order of work lives in the portfolio plan (4.16), because one project can appear in several slices of it.

### 4.4 project_links

| column | notes |
|---|---|
| id | |
| from_group_id, to_group_id | FK item_groups |
| kind | `notify_on_ship` (when from ships, tell to), `no_parallel` (learned from repeated blocks), `depends_on` |
| note | text |
| created_by | `alex` or `overwatch` |
| created_at | |

### 4.5 claim_blocks

History of claims blocks, written by the claims script.

| column | notes |
|---|---|
| id | |
| waiter_code, holder_code | project codes |
| item | the file or folder |
| run_tag | the waiter's run tag |
| blocked_at, last_seen_at | |
| repeat_count | integer, bumped on repeats; information only |
| cleared_at | nullable |

The guard refuses every blocked edit, so repeats count attempts, not episodes. **Three or more separate episodes (distinct `blocked_at`) between the same pair of project codes inside 30 days** makes the nightly job propose a `no_parallel` link.

The claims script never posts on the guard hook's path. It writes new blocks, repeats and clears to a local outbox file, and a detached `scripts/overwatch-post.mjs` sends them, so a slow network never stalls an edit.

### 4.6 overwatch_plans

Overwatch's rulebook. Rows are only inserted; exactly one is active, enforced by a partial unique index.

| column | notes |
|---|---|
| id | |
| active | boolean |
| instructions | text: focus, what to watch, tone |
| settings | jsonb, see below |
| checks_next_run | jsonb array of { text, check_on (date), about (app id or group id) } |
| written_by | `alex` or `overwatch` |
| reason | text |
| supersedes_id | FK overwatch_plans, nullable |
| created_at | |

`checks_next_run` is the one field the nightly job updates in place. Every other change inserts a new row and deactivates the old one in one transaction.

Starting settings:
```
{
  "active_project_limit": 3,
  "limit_mode": "soft",
  "pushes_per_day": 1,
  "push_time": "05:00",
  "stall_days": 5,
  "waiting_on_alex_days": 3,
  "fading_days": 30,
  "overrun_factor": 1.5,
  "inbox_backlog_threshold": 5,
  "weekly_day": "monday",
  "audit_every_weeks": 2,
  "estimate_accuracy_min_shipped": 3,
  "estimate_correction_factor": 1.0,
  "routing_low_confidence": 0.6,
  "overdue_days": 2,
  "friction_trigger_count": 3,
  "friction_window_days": 30,
  "urgent_within_days": 7
}
```

`urgent_within_days` (2026-10-26) is how close a deadline must be to show red and count as urgent; it goes in through the gate, and until then no deadline is treated as urgent.

`inventory_stale_days` (2026-10-27, Step 48), default **7**: how old the last inventory rebuild may be before the nightly job raises "inventory stale". It goes in through the gate; until then the nightly prompt uses 7 and lists the setting as missing, the one fallback any scheduled task uses.

`routing_low_confidence` and `overdue_days` were added 2026-10-25 for the nightly job, and `friction_trigger_count` and `friction_window_days` for the weekly one; `push_time` moved from 07:30 to 05:00 the same day. All went in through the gate (active plan 2b0efc78-b788-427a-b75f-efb9e91864ea). A scheduled task reads every number from these settings and never hard-codes one; a setting it needs that is missing skips that count and is listed in the run.

### 4.7 overwatch_watch

Short-term adjustments with dates.

| column | notes |
|---|---|
| id | |
| kind | `focus`, `ease_off`, `keep_an_eye_on` |
| text | |
| app_id, group_id | nullable |
| starts_on, ends_on | dates |
| created_by | `alex` or `overwatch` |
| expiry_noted_at | nullable; set once the note has mentioned its expiry |
| created_at | |

### 4.8 overwatch_notes

The notes the tab shows, kept as history.

| column | notes |
|---|---|
| id | |
| period | `nightly` or `weekly` |
| for_date | date |
| body | markdown |
| flags | jsonb: structured findings (quiet apps, stalls, backlogs, over-limit, stopped schedules) so the tab can render them without parsing prose |
| plan_id | FK overwatch_plans; the plan that was active |
| created_at | |

Unique on (user_id, period, for_date).

### 4.9 platform_inventory

Every moving part, rebuilt by a script, never hand-edited.

| column | notes |
|---|---|
| id | |
| kind | `tool`, `skill`, `edge_function`, `schedule`, `table`, `screen`, `task_prompt` |
| name | |
| app_id | FK apps, nullable |
| reads, writes | text arrays of table names |
| location | repo path |
| fingerprint | hash of the source |
| last_changed_project | project code, nullable |
| seen_at | when the last rebuild saw it |

Unique on (user_id, kind, name). Rows not seen by the latest rebuild are deleted by the rebuild. The whole set arrives in one `inventory` event and is replaced by `replace_platform_inventory` (4.15) in one transaction, so a reader never sees half a rebuild.

Tools defined with `defineTool` but not registered in `mcp/index.ts` (today `dry_run_dj_plays`, `dry_run_dj_playlist` and `record_dj_playlist_bulk`, deliberately absent from the manifest) are annotated like every other tool but are **not** inventoried.

### 4.10 overwatch_seen_releases

| column | notes |
|---|---|
| id | |
| source | `claude_release_notes`, `claude_code_changelog`, `api_release_notes` |
| entry_key | text, unique per source |
| title | |
| summary | |
| first_seen_at | |

### 4.11 process_friction

A log of snags in how any of Alex's workflows run, not just coding: the CLI loop, and equally the skills for SAM practice, Drive Mix, money, job search, the inbox and the rest. A missed instruction, a testing format that confused Alex, a prompt he had to correct, a step that caused a redo, a chat flow in any app that did not work.

| column | notes |
|---|---|
| id | uuid |
| user_id | |
| occurred_at | timestamptz, when the snag happened |
| what_happened | text, in plain words |
| process | `cli_testing_steps`, `cli_prompt`, `todos`, `closeout`, `skill:<name>`, `inbox`, `other` |
| project_code | text, nullable; the CLI project code it happened in |
| suggested_fix | text, nullable |
| pattern_id | uuid, nullable; set when the weekly job groups entries into one pattern |
| status | `open` (default), `fixed`, `wont_fix`; set by `update_friction` (added 2026-10-25) |
| wont_fix_reason | text, nullable; one line, required when status is `wont_fix` and null otherwise |
| resolved_by | text, nullable; who or what closed it (a skill change, a prompt change, or the decision not to fix) |
| resolved_at | timestamptz, nullable |
| created_at | |

`resolved_by` and `resolved_at` are stamped for both `fixed` and `wont_fix`, and are null while `open`. Existing rows with `resolved_at` set become `fixed`; the rest stay `open`.

**Logging.** Any Claude thread, in any app, logs an entry with `log_friction` when Alex misses or misreads an instruction, says a format or flow is not working, or has to correct how something was presented. It logs without asking and mentions it in one line. The instruction lives in Alex's claude.ai profile preferences, so every chat carries it, not only the Alfred project and the skills. A snag inside an app skill uses `skill:<name>` (for example `skill:sam-practice`, `skill:drive-mix`, `skill:wb-planning`, `skill:job-search`); the inbox uses `inbox`.

**Fixes wait for a pattern.** The weekly job groups `open` entries by process. When one process has `friction_trigger_count` (3) or more `open` entries in `friction_window_days` (30) days, it proposes a fix as a task inbox item with a paste-ready prompt (the gate in principle 4). `fixed` and `wont_fix` entries never count toward the trigger. Resolving a pattern sets `status` and stamps `resolved_by` and `resolved_at` on its entries.

### 4.12 project_estimates

Every estimate a project has had, oldest first. Rows are only inserted; the first is the original estimate and is never changed.

| column | notes |
|---|---|
| id | uuid |
| user_id | |
| group_id | FK item_groups (a Project group) |
| kind | `initial`, `scope_increase`, `scope_decrease`, `re_estimate`, `final` |
| estimate | integer: the project's estimate in CLI steps after this row (for `final`, the actual steps used) |
| cli_estimate | integer, nullable: the figure the CLI gave, before `estimate_correction_factor`; set on `initial` and `re_estimate` |
| steps_added | integer, nullable: positive for `scope_increase`, negative for `scope_decrease` |
| at_step | integer, nullable: the step number (from the run tag) it happened at |
| reason | one line |
| created_at | |

One `initial` and at most one `final` per project. Writing a row also sets `project_plans.effort_estimate` to its `estimate` (except `final`), in one transaction.

**Where the figures come from.**
- **Initial:** the read-only plan prompt of every new project asks the CLI for a step estimate broken down by phase. The claude.ai thread saves the total as the `initial` row, with the CLI's own figure in `cli_estimate` and `estimate` = round(`cli_estimate` × `estimate_correction_factor`).
- **Scope changes:** when work is added to or taken out of a project, the thread records a `scope_increase` or `scope_decrease` row from the CLI report, with `steps_added` and the reason. A plain wrong guess, with no change of scope, is a `re_estimate`.
- **Final:** at closeout, before the Project group is closed, the thread records a `final` row with the actual steps used (`steps_used` from get_project_plans).

**Decided 2026-10-25.**
- `cli_estimate` (the CLI's raw figure) is kept on every `initial` and `re_estimate` row.
- `estimate_correction_factor` is applied when the initial estimate is saved, with the raw figure beside it.
- Steps are counted the way `steps_used` counts them: a lettered sub-step (s4b) counts as step 4.
- The Overwatch project is seeded with two rows, not one: `initial` 40 (its original estimate, made at Step 17), then `scope_increase` +4 at step 18, reason "estimate tracking added (Steps 21-24)". Its current `effort_estimate` becomes 44.

**How they are judged.** Overrun is judged against the **current** estimate. Accuracy is reported against both the **original** (`initial`) estimate and the **scope-adjusted** estimate (`initial` plus every `steps_added`), so added scope never counts as a bad estimate.

### 4.13 platform_open_work (Phase 7, decided 2026-10-27)

Unfinished work written down in `docs/`: its own table, not a kind in platform_inventory, because its shape (file, line, text) differs and every rebuild moves line numbers. Rebuilt and replaced with the inventory, in the same `inventory` event and the same transaction.

| column | notes |
|---|---|
| id | uuid |
| user_id | |
| file | repo path, e.g. `docs/history/progress-dj.md` |
| line | integer, 1-based |
| kind | `checkbox` (an open `- [ ]`), `deferred_phase` (a phase or step marked deferred), `not_fixed` (a "not fixed here" or follow-up note) |
| text | the line, trimmed, at most 500 characters |
| project_code | text, nullable; from the file name (`progress-<code>.md`, `technical-spec-<code>.md`, `review-<code>.md`) |
| seen_at | when the last rebuild saw it |

The scan reads spec, progress and review files in `docs/` and `docs/history/` (`technical-spec-*`, `progress-*`, `review-*`, `*-progress.md`). Not audited (rebuilt wholesale); owner RLS like the rest.

**docs/history is filtered (Alex, 2026-10-27, Step 45).** There, plain unchecked boxes are left out (a finished project's leftovers); only unchecked follow-ups, deferred phases or steps, "not fixed" notes, and the bullets under a heading named "Later" ("## Later", "## 6. Later phase", "## Later, not Phase 3") are kept. Files in `docs/` keep every kind. "Later" bullets are recorded as `deferred_phase`, since the table's kinds are fixed.

### 4.14 finish_summaries (Phase 7, decided 2026-10-27)

What a worktree's Finish carried into main, sent by gitpush (5.4) and reviewed by the nightly job.

| column | notes |
|---|---|
| id | uuid |
| user_id | |
| project_code | the worktree owner |
| branch | |
| merge_commit | text; the merge commit in main |
| finished_at | timestamptz |
| diff_stat | jsonb: { files, insertions, deletions } |
| migrations | text array: numbered migration paths new or changed in the merge |
| tools | text array: tool names whose defineTool block changed |
| skills | text array: `.claude/skills/*/SKILL.md` paths changed |
| functions | text array: edge function folders changed |
| task_prompts | text array: task prompt docs changed |
| paths | text array: every path in the merge |
| reviewed_at | timestamptz, nullable; set when the nightly job has compared it with the inventory |
| reviewed_by_run | text, nullable; the platform_runs id that reviewed it |
| created_at | |

Unique on (user_id, merge_commit), so a resend is harmless. Owner RLS, audited.

### 4.15 Phase 7 functions

- `replace_platform_inventory(p_user_id uuid, p_parts jsonb, p_open_work jsonb)`: deletes the user's platform_inventory and platform_open_work rows not in the new sets and upserts the rest, in one transaction. Security definer, execute granted to service_role only; only overwatch-ingest calls it.

### 4.16 Portfolios and the portfolio plan (Phase 8b, decided 2026-10-27)

The order Alex means to work in. It is a plan of **slices**, not projects, kept per **portfolio**, and versioned like overwatch_plans. The same tables serve client projects: nothing may assume a project is Alfred code, has a project code, or is counted in CLI steps.

**portfolios**

| column | notes |
|---|---|
| id | uuid |
| user_id | |
| name | text, unique per user, e.g. "Alfred ecosystem", "Client work" |
| context_ids | text array of contexts the portfolio covers (e.g. Client work: the Team IMPACT and ActBlue contexts); used to list a portfolio's Project groups that no slice names yet |
| position | integer; the order of the switch on the tab |
| archived | boolean, default false |
| created_at, updated_at | |

Owner RLS, audited.

**portfolio_plans**: one active per portfolio (partial unique index on (portfolio_id) where active); rows are only inserted.

| column | notes |
|---|---|
| id | uuid |
| user_id | |
| portfolio_id | FK portfolios |
| active | boolean |
| theory | text: Alex's ordering principles, e.g. "bugs first, then tools that make the work faster, then X because it solves Y" |
| notes_for_next_review | text, nullable: what to reconsider and when |
| review_by | date, nullable |
| reason | text: why this version replaced the last |
| written_by | `alex` or `overwatch` |
| supersedes_id | FK portfolio_plans, nullable |
| created_at | |

`portfolio_plans_guard` allows only `active` true to false; every other change is a new version.

**portfolio_lanes** (revised 2026-10-27, Step 40): each plan version names its own lanes, as many as it needs (e.g. "Main", "SAM", "Client work"). Lanes are not a fixed list: a lane is a row of its plan version.

| column | notes |
|---|---|
| id | uuid |
| user_id | |
| plan_id | FK portfolio_plans |
| name | text, unique per plan |
| position | integer, unique per plan; the order lanes show in |
| note | text, nullable, e.g. "the heavy work, one slice at a time" or "lighter work beside Main" |
| created_at | |

Lanes are frozen once written (`portfolio_slices_guard` covers them too): renaming, adding or removing a lane is a new version. Owner RLS, audited.

**portfolio_slices**: the ordered work of a plan version, within its lanes. A slice is a Project group plus the phases it covers; the same group can appear in several slices, in one lane or several (A phases 2-3, B phase 1, A phase 4).

| column | notes |
|---|---|
| id | uuid |
| user_id | |
| plan_id | FK portfolio_plans (kept for the guard and for reads; must match the lane's plan) |
| lane_id | FK portfolio_lanes |
| position | integer, unique per lane; the order within the lane |
| group_id | FK item_groups; a Project group (group_types.kind = project) of the same user |
| phases | text, e.g. "Phases 2 and 3"; null means the whole project |
| why | text: its place in terms of the theory |
| status | `planned` (default), `in_progress`, `done`, `paused` |
| paused_reason | text; required when `paused`, null otherwise |
| status_changed_at | timestamptz |
| created_at | |

At most one `in_progress` slice per lane (partial unique index on (lane_id) where status = 'in_progress'). `portfolio_slices_guard`: lanes and slices of an inactive plan are frozen; on the active plan lanes are frozen and slices may change only `status`, `paused_reason` and `status_changed_at`. Owner RLS, audited.

**Writing a version** is one call to `create_portfolio_plan(p_portfolio_id, p_theory, p_notes_for_next_review, p_review_by, p_reason, p_written_by, p_lanes jsonb)` (invoker), where `p_lanes` is `[{ name, position, note, slices: [{ position, group_id, phases, why, status, paused_reason }] }]`: it deactivates the portfolio's active plan, inserts the new one with `supersedes_id`, then its lanes and their slices with their given statuses, in one transaction. A slice's status changing (started, done, paused) is not a new version: `update_portfolio_slice` changes it in place on the active plan.

### 4.17 Suggested Project group on inbox items (Phase 8c, decided 2026-10-27)

`inbox.suggested_group_id` (4.1) names an active or someday Project group of the same user that the capture belongs in. `create_inbox_item` and `update_inbox_item` accept it and refuse any other group. `process_inbox_item` gains a `group` payload key ({ group_id }): after it files the item or intention, it adds an item_group_members row (member_type `item` or `intention`, next position) in the same transaction, so filing and joining the project succeed or fail together. alfred-enrich suggests it from `get_project_plans` (`status: "all"`).

## 5. Getting activity and status in

### 5.1 One door from the desktop: `overwatch-ingest` edge function

The claims script, Switchboard and gitpush all run on the desktop. They use one new edge function, authenticated with the same long-lived secret pattern as `clip-capture` (its own `OVERWATCH_INGEST_SECRET` and a fixed user id from function secrets; the desktop reads the secret from the environment or the Windows user registry, as `clip.mjs` does). It accepts:
- `claim_block` (Phase 1): upserts a claim_blocks row.
- `finish_summary` (Phase 7): a project's "what changed" summary at worktree finish (5.4), upserted into `finish_summaries` (4.14) on merge_commit.
- `inventory` (Phase 7): the rebuilt inventory (5.5): `{ parts: [...], open_work: [...] }` as **one event**, never split across batches, applied with `replace_platform_inventory` (4.15).

The local outbox (`scripts/lib/overwatch-post.mjs`) sends an `inventory` event on its own, not inside a batch of 200, because replacing needs the whole set.

### 5.2 Alfred's own work

The triggers in 4.2.

### 5.3 Claude and CLI work (the cli-workflow skill)

When the claude.ai thread handles a CLI report, it also:
1. Writes the project's status line (where_now, next_step, waiting_on and its kind) with `update_project_plan`.
2. Logs one `progress` activity row with `log_activity`, source `cli`, source_ref the run tag.

At closeout it logs a `shipped` row and closes the project group with `done`.

### 5.4 Finish-time impact review

At `gitpush <code> finish`, after the merge and before claims are released, gitpush:
1. Rebuilds the inventory (5.5) in the main checkout and queues it.
2. Queues a `finish_summary` (4.14): the diff stat, new or changed migrations, tools, skills, functions and task prompts, taken from git (`scripts/lib/finish-summary.mjs`).

Both go through the existing local outbox and detached sender, so a slow or failed send never stops Finish; gitpush says what it queued. `npm run inventory -- --send` sends the inventory by hand.

**Decided 2026-10-27 (Step 47): the inventory goes on every merge into main, the summary on Finish.** After every push that lands in main (worktree Checkpoint and Finish, main Push and Finish) gitpush rebuilds the inventory from the main checkout and queues an `inventory` event; a Finish also queues a `finish_summary` (a worktree's merge commit against its first parent; a main Finish's commits against the upstream before the push). Nothing is queued when the run is refused, cancelled, skipped or its push fails, nor with `OVERWATCH_SENDER=off`. The plan's "About to" list has a "Send" line naming what will go, and the run ends by printing what was queued and where the sender's log is. The logic is in `scripts/lib/finish-summary.mjs`.

The nightly job then reads unreviewed summaries (`get_finish_summaries`), compares each with the inventory, creates one task inbox item per follow-up it finds (for example "get_items reads items but not the new column"), rewrites the affected app's `current_state` with `update_app_profile`, and marks the summaries reviewed (`mark_finish_summaries_reviewed`). A summary stays unreviewed through a failed night, so none is lost.

### 5.5 Inventory rebuild

A script, `scripts/inventory.mjs` (logic in `scripts/lib/inventory.mjs`), walks the repo:
- tools: `defineTool` calls, with their declared tables (5.6); registered tools only (4.9)
- skills: `.claude/skills/*/SKILL.md`, with the tool names each mentions
- edge functions: `supabase/functions/*`
- task prompts: `docs/**/*task-prompt*.md`
- tables: `supabase/schema-snapshot.sql`
- screens: routes in `src/viewPaths.js`
- open work: spec, progress and review files in `docs/` and `docs/history/` (4.13)

Schedules come from `platform_schedules` directly; the script does not rebuild them. It runs after every gitpush into main (5.4) and by hand with `npm run inventory` (prints a summary; `--send` queues it). A trigger whose function assigns to NEW (a BEFORE trigger changing its own row) lists its own table in writes as well as reads.

**As built (Step 44).** `npm run inventory` writes the payload to `.scratch/inventory.json` (git-ignored) and prints counts per kind, open work per file, and anything it could not use; `--json` prints the payload instead. Triggers come from the snapshot too: reads is the table a trigger fires on, writes the tables its function inserts into, updates or deletes from (a pattern search, so dynamic SQL is missed). `fingerprint` is a sha1 of the part's source text; `last_changed_project` is the project code in the subject of the newest commit touching its file ("<code>: …" or "Merge worktree-<code>"), else null; snapshot parts carry null. **App rule:** the first match among the words of a part's name: wb, money or warren → warren_buffet; drive_mix → drive_mix; sam; ken; dj; job or jobs → jobs; overwatch, friction, activity, project, claim_blocks, app_profile, seen_releases, platform_inventory, open_work, finish_summaries → overwatch; anything else alfred (a platform.* table: none). Only ids seeded in the migrations' `insert into public.apps` are used.

### 5.6 Tools declare their tables

`defineTool` gains a required `tables: { reads: string[], writes: string[] }`. Every existing tool gets annotated, which is its own phase because it touches every tools file.

**Decided 2026-10-27.**
- **The arrays are literal strings only**, so the conformance test and the inventory read them from the source without running Deno. One parser in `scripts/lib/inventory.mjs` serves both.
- A tool backed by an RPC declares the tables the RPC reads and writes, not the RPC.
- Views count as tables. `platform.*` objects are written schema-qualified (`platform.registry`); public ones bare.
- `tables` comes before `handler` and `propose`, because the parser reads only the properties before them.
- **"*" means "any registered table" (2026-10-27, Step 41b).** It is allowed only in `reads`, for a generic reader (today only `get_records`); the test refuses it in `writes`. The inventory records such a tool as "reads any table".
- **Triggers are not declared on tools.** A write that fires a trigger (closing an item writes `activity`) lists only the tables the tool itself touches; the inventory (Step 44) reads triggers from the schema snapshot.
- **Shared plumbing is left off every tool:** the budget check, the read settings and the audit log, which `defineTool` and `readTable` do for all of them.
- **The conformance rule is a test, not `check_platform_conformance`** (the database cannot read TypeScript): `supabase/functions/mcp/tables.test.mjs` fails any `defineTool` with no `tables`, a non-literal array, or a declared name with no CREATE TABLE or CREATE VIEW in `supabase/schema-snapshot.sql`. It covers every defineTool, the three unregistered DJ tools included. The weekly drift audit is the backstop for drift after the snapshot.

### 5.7 Other apps: the nightly pull

The nightly job reads each app's `activity_recipe`, calls the tools it names, and writes at most one `used` or `progress` row per app per day, source `nightly`, source_ref `<app>:<date>`.

### 5.8 Chats outside the CLI

Not code. Alex adds a global preference in Settings, Profile (text in Appendix A), and runs a one-time sweep in a chat outside any Project to capture his project ideas (Appendix B).

### 5.9 The schema snapshot label (Phase 7, decided 2026-10-27)

**The bug.** `scripts/schema-snapshot.mjs` labels the snapshot "through migration N" from main's migration list, and gitpush runs it **before** the merge, so the label lags one migration behind (after 179 merged, the file still said 178). A later push that carries the same migration again (an already-numbered migration edited after its checkpoint) then looks newer than the snapshot and runs Docker for nothing.

**The fix.** gitpush passes the newest merged migration number to the script (`--through N`), which labels with the larger of that and main's highest. A push with no newer migration never runs Docker.

**Opt-out, not opt-in.** The snapshot stays automatic for Checkpoint, Finish and main Push, because a Checkpoint is when migrations land. `--no-snapshot` skips it (for when Docker is not running); the label then stays behind, so the next push that carries a migration catches it up.

## 6. The nightly job

A Claude scheduled task, `overwatch/nightly`, at 04:20 Pacific (after DJ at 3:30 and Drive Mix at 3:54, before `push_time` 05:00, so everything lands before Alex is up at 5; times changed 2026-10-25), with the Alfred and Claude_Code_Remote connectors. Its prompt lives in the repo at `docs/overwatch-nightly-task-prompt.md`. It writes a platform_runs row every run. Its platform_schedules row, and the weekly one, come from one migration written with the weekly prompt.

**The rule for every Overwatch scheduled task (decided 2026-10-25).** The task's prompt in `docs/` owns the procedure: the steps, the writes allowed, run logging, failure handling, limits and its PROMPT VERSION. The `overwatch` skill owns the judgment: how to read each app, the note's tone and wording, what is fading, what counts as a deadline mention. The prompt tells the task to load the skill for those, and the prompt's steps win where the two conflict. Nothing is written in both: the skill's section for a task is a pointer to its prompt plus the judgment guidance. The weekly task follows the same split.

What it does, in order:
1. **Read** the active plan, active watch items, the apps table, active Project groups with their project_plans, and the checks due today.
2. **Pull** each app's activity (5.7).
3. **Count** (queries, not judgement):
   - quiet apps: last activity older than `rhythm_days`, adjusted by `ease_off` watch items
   - stalled projects: no CLI report under the project code for `stall_days`, and not waiting on another project
   - waiting on Alex longer than `waiting_on_alex_days`
   - overrun: actual steps above the current `effort_estimate × overrun_factor`, or past `target_date`
   - scope changes: every `scope_increase` or `scope_decrease` row since the last note, each named in the note with its reason
   - active projects above `active_project_limit`
   - empty Project groups: active or someday Project groups with no item or intention member (one `get_groups` read), a line each in the note and the `empty_projects` flag, no inbox item
   - inbox backlog per app above `inbox_backlog_threshold`, with the oldest item's age
   - overdue intentions: an active intention whose scheduled event is more than `overdue_days` old with no execution for it; and an active intention with no scheduled date whose text names a deadline or cutoff ("claim by", "expires", a month or a date; the skill says how to read it). Both go in one combined inbox item, like fading
   - stopped schedules: no ok run within expected_by plus grace_hours
   - scheduled tasks themselves: `list_triggers` (the Claude_Code_Remote connector, which every Claude task has) returns every scheduled task with its prompt, schedule and last run status, so the job flags an enabled task whose last run failed or that is missing past its schedule, or that has no matching platform_schedules row, and can read task prompts that are not in the repo
   - inbox routing: unrouted items, unrouted items older than a day, and items routed with `ai_confidence` below `routing_low_confidence`, so a capture sent to the wrong app is caught the next morning
   - repeated claim blocks (4.5)
   - fading items: active items and intentions with no activity for `fading_days`, judged by the skill (reference items and recurring intentions between occurrences are not fading); one combined inbox item
   - watch items that expired since the last run
   - (Phase 7) unreviewed finish summaries, compared with the inventory (5.4): at most 3 a night, the tables their migrations name (at most 5), the parts outside the work that read or write those tables, changed tools no skill names, and changed skills to paste into claude.ai (nightly prompt 2026-10-27a, count 11)
   - (Phase 7) inventory freshness: the last rebuild's `seen_at` older than `inventory_stale_days` (new setting, default 7: the one setting the prompt falls back on while the plan lacks it; to add through the gate) raises one "inventory stale" item (count 10)
   - (Phase 8b) portfolio plans whose `review_by` has passed: one item per portfolio, deduplicated like the others
4. **Act:**
   - write tonight's `overwatch_notes` row (body plus flags). The note is still written every night, for the nudge, for chat and as history; the tab no longer shows it except through the status line. Its shape (2026-10-26): no title line; two headings, "Action Required" and "Yesterday's Activity" (one bullet per app); friendly dates ("Oct 15"); every record named as a markdown link `[Name](https://alfredv5vibe.vercel.app/<id>)`, never a bare URL; each project's name is its link, with its estimated finish date, and its scope changes and empty-group warning as sub-bullets; quiet apps as "Jobs (3 days)", the days since the app was really last used (from the app's own data through its recipe when the activity log has no row; "unknown" only when the app has no data); the inbox as in section 9 rule 7; a schedule with no ok run is suggested as a bug to log
   - for a stall or overrun, create a task inbox item holding a status-request prompt aimed at the right worktree or project thread, with its own run tag (Appendix C)
   - for fading items, create one task inbox item listing them, each asking keep, park or let go; overdue intentions get one combined item the same way
   - a status request's run tag is `<project-code>-s<step of the project's last report>q-<4 chars>`, and its Window line comes from that report's repo
   - for a proposed `no_parallel` link or a plan change, create a task inbox item with a paste-ready prompt (the gate in principle 4)
   - (Phase 7) for each follow-up a finish summary implies, one task inbox item (kind `follow_up`, at most 5 a night) with **`source_app` the affected app**, the one exception to Overwatch's own items, deduplicated across all apps on its first line; rewrite the affected app's `current_state` only when the work changes what the app does (at most 2); then `mark_finish_summaries_reviewed` with the run's id. A failed review marks nothing, so the summaries wait for the next night. The impact review adds 2 Alfred calls on a night with no summary and about 8 to 12 (at most 19) with one
   - send at most `pushes_per_day` notifications at `push_time`, each through `create_reminder` backed by one of the inbox items above, most important first
   - update `checks_next_run`

On the weekly day a second task, `overwatch/weekly`, adds the week's view; it does not repeat the nightly counts. Its prompt is `docs/overwatch-weekly-task-prompt.md`. It fires Mondays at 04:35 Pacific, after the nightly run. A claude.ai task's schedule cannot read the plan, so the prompt checks today against `weekly_day` and, on a mismatch, raises one item saying the task's day, the schedule row and the plan disagree, and does nothing else; changing `weekly_day` therefore means changing all three. In Phase 5 the drift audit covers what the tools can see: schedules with no ok run in 14 days, scheduled tasks and schedule rows that do not match (`list_triggers`), stale prompt versions, apps with no profile or recipe, and items routed to an unknown app. Phase 7 adds, from `get_platform_inventory` (weekly prompt 2026-10-27a, Step 8.3, about 9 calls): skills and live task prompts naming tool-shaped names that are not registered tools (the inventory's `details.unknown_tools`; the skill sorts real misses from arguments, examples, SQL functions and other connectors' tools), apps with no skill, tables no tool reads or writes (leaving out every `platform.*` table and view and any table a trigger writes), and tools declaring a table missing from the inventory. **Two skills claiming one trigger is not checked:** the inventory holds no skill descriptions or trigger phrases. Skills in claude.ai are still not readable by a task (open question 4); the audit reads the repo copies. It does:
- writes the weekly note: what shipped, what progressed, ideas list summary (count, oldest untouched, newly possible)
- re-checks parked projects: compares `hurdle_kind = technology` waiting-on lines with the week's shipped activity and new releases
- feature watch: web-searches Anthropic's release notes and the Claude Code changelog, records new entries in overwatch_seen_releases, and creates one inbox item listing entries that may unblock a parked project or affect the inventory
- estimate accuracy: once at least `estimate_accuracy_min_shipped` projects have shipped with a `final` row, reports actual against original and against scope-adjusted for each, and suggests an `estimate_correction_factor`. A change to the factor is a settings change and goes through the plan gate (principle 4)
- friction grouping: groups open process_friction entries by process, sets `pattern_id` on each group, and for a process with `friction_trigger_count` or more open entries in `friction_window_days` days creates one task inbox item proposing a fix, with a paste-ready prompt (4.11)
- every `audit_every_weeks` weeks, the drift audit: the Phase 5 checks above plus the Phase 7 inventory checks

## 7. MCP tools

All via `defineTool` with declared tables (once 5.6 lands).

| tool | tier | does |
|---|---|---|
| get_activity | 1 | range, app, context, group, tag, kind filters; paged via readTable |
| log_activity | 1 | insert one activity row; duplicate source_ref returns the existing row |
| get_project_plans | 1 | active projects with plans, counts of actual steps, last report time |
| update_project_plan | 2 | create or update a project's plan row; `effort_estimate` is no longer set here once estimates are tracked (4.12) |
| record_project_estimate | 2 | add a project_estimates row and, except for `final`, set the plan's `effort_estimate` in the same transaction; refuses a second `initial` or `final` |
| get_project_estimates | 1 | a project's estimate history, with original, scope-adjusted and current totals |
| get_project_links / create_project_link | 1 / 2 | |
| get_overwatch_plan | 1 | the active plan, optionally history |
| create_overwatch_plan | 3 | new plan row superseding the active one, through the built-in confirm gate with `propose` showing what changes |
| update_overwatch_checks | 2 | replace checks_next_run on the active plan |
| get_overwatch_watch / create_overwatch_watch / update_overwatch_watch | 1 / 2 / 2 | |
| get_overwatch_notes / create_overwatch_note | 1 / 2 | |
| get_platform_inventory | 1 | (Phase 7) parts by kind, name (contains), app_id, `table` (parts that read or write it, each with `uses`: reads, writes or both) and `reads_any`; the NOTE gives counts per kind |
| get_open_work | 1 | (Phase 7, Step 46) platform_open_work by file (contains), project_code, kind, and `where`: live, history or all |
| get_finish_summaries | 1 | (Phase 7) unreviewed by default; project code and date filters; paged via readTable |
| mark_finish_summaries_reviewed | 2 | (Phase 7) set reviewed_at and reviewed_by_run on the given ids |
| get_claim_blocks | 1 | |
| update_app_profile | 2 | activity_recipe, rhythm_days, current_state |
| record_seen_releases | 1 | |
| log_friction | 1 | insert one process_friction entry |
| get_friction | 1 | filters for process, project code, status (`open` by default), date range; paged via readTable |
| update_friction | 2 | set pattern_id when grouping; set status (`fixed` or `wont_fix`, the latter with wont_fix_reason), stamping resolved_by and resolved_at; back to `open` clears all three |
| get_portfolios | 1 | (Phase 8b) every portfolio with its contexts and its active plan's id, theory first line, review_by and slice counts by status |
| upsert_portfolio | 2 | (Phase 8b) create or rename a portfolio, set its contexts, position or archived |
| get_portfolio_plan | 1 | (Phase 8b) a portfolio's active plan: its lanes in position order, each with its slices in order, each slice with the group's name, status and project code; `include_history` adds older versions |
| create_portfolio_plan | 3 | (Phase 8b) a new version replacing the portfolio's active plan, in one transaction; input is the lanes with their slices (4.16); `propose` shows lanes added, removed or renamed, slices added, removed, moved within a lane or moved between lanes, and the theory change |
| update_portfolio_slice | 2 | (Phase 8b) a slice of the active plan: status (`in_progress`, `done`, `paused` with paused_reason, back to `planned`); refuses a second `in_progress` in the same lane |

Phase 8c changes two existing tools: `create_inbox_item` and `update_inbox_item` accept `suggested_group_id` (4.17).

## 8. Skills

- **New `overwatch` skill:** how the nightly and weekly jobs run, how to talk with Alex in an Overwatch chat (reading the note, planning, setting watch items, changing the plan), and the gate. It also covers cross-app questions in chat ("scan Alfred for money to-dos"): Overwatch routes anything still unrouted first, then the owning app's skill does the deep dive on its own items. "Unrouted" includes items the hourly job has not reached yet, which the skill enriches and routes on the spot. Its description must name triage, routing and "what needs my attention" so it loads alongside an app skill. It says when to call `log_friction` (4.11). Phase 7: judging finish-summary follow-ups and the inventory drift findings. Phase 8b: talking through a portfolio plan (theory first, then slices), when a version is new versus a slice status change.
- **App skills:** each reads the inbox filtered by its own app id only.
- **cli-workflow:** status-line and activity writes on every report (5.3); closeout adds the shipped row, closing the project group, and checking that finish sent its summary; new projects create their Project group and project_plans row with the project code. It also says when to call `log_friction` (4.11). Estimates (4.12): the read-only plan prompt asks the CLI for a step estimate broken down by phase, saved as the `initial` row; a report that adds or removes work records a scope row; closeout records the `final` row before the group is closed.
- **mcp-platform (Phase 7):** the canonical defineTool shape gains `tables`, literal arrays, RPC tables declared (5.6).
- **Alfred project instructions and Alex's claude.ai profile preferences (he added the latter 2026-10-25):** one line telling every other thread, in any app, to call `log_friction` when Alex misses or misreads an instruction, says a format or flow is not working, or has to correct how something was presented, and to mention it in one line.
- **alfred-enrich:** the duplicate check also searches closed items and intentions with closed_reason `wont_do`, and shows why they were dropped. Phase 8c: suggest a Project group (`suggested_group_id`) when the capture clearly belongs to an active or someday project; leave it blank when unsure.

## 9. The Overwatch tab (`/overwatch`)

**The tab is a live snapshot (Alex, 2026-10-26, Step 31b).** Every section shows the current state, computed fresh when the page opens, never copied from a note. Activity is the one dated section: it opens on today and pages back through earlier days. (Future work: Activity may become its own tab.)

Follows existing Alfred patterns. Top to bottom:
The page header is just "Overwatch" with its icon; no tagline (2026-10-26, Step 31c).

0. **The status line** has exactly three wordings (Step 31c): "Report as of <time> · everything scanned"; "Report as of <time> · partially scanned: <what was not checked, in plain words, e.g. Money not checked>" when a run skipped part of its work (from its `details.skipped`, whose `part` values are `count:<flags key>`, `pull:<app_id>`, `inbox:<first line>` or `nudge:<tool>`); and, in the danger colour, "Scan failed · see Action Required" when the latest nightly run or this morning's weekly run **failed** (a failed run always raises an Action Required item). No run status word ever shows. The line is a real link to `/overwatch/briefing`, and it has a copy button for the latest nightly briefing.
   - **Briefing** (the note page; icon lucide Newspaper, unused elsewhere in the app): `/overwatch/briefing` shows the latest nightly briefing and, on the weekly day, the week's; `/overwatch/briefing/<note_id>` shows one. Each briefing has one header, "Nightly briefing · Mon, Oct 26" or "Weekly briefing · Mon, Oct 26", which is a real link to its own URL; a leading title line in an older note ("Overwatch nightly, 2026-10-26") is dropped when rendering. Its copy text is "Overwatch: nightly briefing <date>", the note, note_id, run_id, the briefing's link, and the closing line "Let's go through this briefing."
   - **Scan gaps:** when the nightly run skips the same part on 3 nights running, it raises one Action Required item about it (kind `scan_gap`), deduplicated like the others.
1. **Action Required** (was "Needs you"): Overwatch's open inbox items, each row a real link to the item. The row's title drops the "Overwatch: " prefix and a trailing " — <date>"; the kind and time line stays, and the copy text keeps the full first line. An item's first line puts what makes it unique before its " — ", because Overwatch deduplicates open items on the text up to the " — ".
2. **Quiet lately:** apps past their rhythm, with days since last activity.
3. **Projects:** active projects as cards showing where_now, next step, waiting-on, steps used against the current estimate (and the original), target date, an estimated finish date from pace (steps used per day since the first report, projected over the steps remaining), stall or overrun flags, scope changes and an empty-group warning. A count against the soft limit ("3 of 3 active").
   - **Portfolio plan (Phase 8b, 2026-10-27).** A portfolio switch (chips in the Inbox chip style, by `position`; the last one chosen is remembered per browser) above three groups:
     - **Now:** one line per lane, in lane position order: the lane's name and its `in_progress` slice (a card as above plus its phases and why), or "Nothing in progress" for a lane with none.
     - **Next:** the first `planned` slice in each lane, labelled with its lane.
     - **Later:** the rest, lane by lane in position order; `paused` slices show their paused_reason; `done` slices collapse to a count.
     A lane's note shows under its name on the plan page, not on the tab.
     **As built (Step 55).** The tab reads the portfolio tables directly under RLS, like the rest of the tab (`getPortfolioPlans`), in the shapes the tools return; logic in `src/overwatch/portfolioModel.js`, display in `PortfolioPlan.jsx`. The switch shows whenever a portfolio exists, even one, so it is clear whose plan this is. A Now slice whose group is not closed shows the full Project card plus its phases and why; a closed group's slice shows a plain row. "Not in the plan" lists the portfolio's someday, active and background Project groups (in its `context_ids`) that no slice of the active version names. Copy follows the Ideas rule: a group of 2 or more slices copies once on its heading, a group of 1 on its row. The header link to the plan page waits for Step 56, which adds the route.
     Each slice is a real link to its group, with a copy button ("Overwatch: slice <group> <phases> of the <portfolio> plan … What should I do about this?"). A project in the portfolio's contexts that no slice names is listed under "Not in the plan". With no plan yet, the section shows the cards as today and "No plan for <portfolio> yet."
   - **The plan page** `/overwatch/plan/<portfolio_id>` (a real link from the section header): the theory, the notes for next review, review_by (red once passed), the reason for this version, and the older versions (date, reason, written by), each expandable to its slices. Copy: "Overwatch: <portfolio> plan", the theory, the slices, "Let's review this plan."
4. **Activity:** Today, Week, Month, or a date range; filters for app, context and tag; grouped by project, then intention; shipped, done, progress and used rows styled differently.
5. **Ideas:** someday and parked projects, with waiting-on and hurdle kind; "newly possible" ones flagged first.
6. **Friction:** `open` process_friction entries grouped by process, with a count for each, newest first within a group. A process at the trigger (`friction_trigger_count` or more open in `friction_window_days` days) is marked, and one a single entry short of it is marked as near it.

Watch items and plan settings are viewable on the tab; editing them goes through chat.

**Layout (agreed 2026-10-25, Step 29; revised 2026-10-26, Step 31b).** The status line, then one scrolling column of collapsible section cards, most important first: Action Required, Projects, Quiet lately, Activity, Ideas, Friction. Action Required and Projects open by default; Quiet lately, Ideas and Friction collapse with their counts; Activity collapses to Today. Notes render through a small renderer of our own (headings, lists, bold, code, links), not a new dependency. Quiet lately reads live from a view of each app's newest activity. Nothing on the tab is editable.

**Design rules for the whole phase (Alex, 2026-10-25).**
1. Look and feel match the existing app. The Inbox and Context pages are the reference for cards, spacing, typography, chips, colours and icons. Reuse the shared components and styles; invent nothing where one exists.
2. Copy widgets. Anything that could start or help a conversation gets a copy button, the pattern of the copy icon next to an item's title. The text is paste-ready for an Overwatch chat or a new thread: it starts "Overwatch:", names what it is (a project, a quiet app, a friction process, an overdue intention, an activity row, a note), and carries its ids, its link (`https://alfredv5vibe.vercel.app/<id>`, or the group link), the key facts on the card, and a short question where it fits ("What should I do about this?"). One shared helper (`src/overwatch/overwatchCopy.js`) and one button (`OverwatchCopyButton`, the shared CopyButton) serve every section.
3. Links to records, groups and other tabs wherever a thing is named: records through `/<id>`, Projects to their group, activity rows to their target.
4. Icons: app icons on app and activity rows, the record type icons the app already uses, lucide TowerControl ("Control tower") for Overwatch. Alex replaced Radar as too busy on 2026-10-25; the apps row moves from Radar to TowerControl in Step 33's migration, and until then AppIcon maps Radar to TowerControl.
5. **Red for time-sensitive things**, wherever they appear, in the app's danger colour (`destructive`): overdue intentions, a deadline within `urgent_within_days` (a plan setting, default 7, added through the gate; while it is missing no deadline is red), and a failed run or a stopped schedule.
6. **Every link is a real anchor with an href**, so middle-click and open-in-new-tab work, whole-row links included. This is a rule for every screen; it is in `docs/design-system/design-system.md`.
7. **Inbox, wherever shown** (the note, and any inbox line on the tab): "<N> items. Nothing urgent." unless something is urgent: an unrouted item older than a day, an app's backlog whose oldest item is older than `stall_days`, or low-confidence routing. Then it lists only those.

**Inbox detail (Phase 8c).** When an item has `suggested_group_id`, the detail shows "Add to project: <group name>" (Project icon, the name a real link to the group) with a toggle, on by default; filing with it on sends the `group` payload to `process_inbox_item`. The component is `src/inbox/SuggestedGroup.jsx`.

## 10. Phases

1. **Plumbing:** clips columns and backfill; runs and schedules app foreign key; claim_blocks table and the overwatch-ingest function (claim_block only); claims script posts blocks through a local outbox; register the three missing schedules and have their prompts write runs:
   - DJ daily sync (`dj/daily_history_sync`): daily, 4:30 am Pacific (3:30 from 2026-10-25).
   - Drive Mix daily refresh (`drive_mix/daily_refresh`): daily, 4:54 am Pacific (3:54 from 2026-10-25).
   - Weekly DJ review (`dj/weekly_review`): Fridays, 13:00 UTC.
   Today's Jazz is a skill used in chat, not a scheduled task, so it gets no schedule.
2. **Core tables:** group_types key; app_profiles and the overwatch apps row; activity with its three triggers; project_plans; project_links; overwatch_plans with the starting plan; overwatch_watch; overwatch_notes; overwatch_seen_releases; process_friction.
3. **Tools:** section 7 except inventory.
4. **Skills and backfill:** cli-workflow and alfred-enrich changes; overwatch skill; backfill current Project groups and plans for live worktrees; backfill activity for the last 30 days from closed executions and CLI reports; write each app's current_state, activity_recipe and rhythm_days from the discovery report.
5. **Nightly and weekly jobs:** estimate tracking first (project_estimates and its RPC, record_project_estimate and get_project_estimates, update_project_plan stops setting effort_estimate, the two new settings through the plan gate, the cli-workflow lines, and the Overwatch project's own initial row); friction status (4.11: the status and wont_fix_reason columns, update_friction and get_friction); then the prompts in the repo, schedule rows, first runs checked by hand.
6. **The tab.** Shipped 2026-10-26: status line and Briefing, Action Required, Active Projects, Quiet lately, Activity, Ideas, Friction, built to the design rules in section 9.
7. **Inventory and impact review (revived 2026-10-27, Steps 40 to 49):** `tables` on defineTool and every tool annotated (5.6), with the conformance test; the schema snapshot label fix and `--no-snapshot` (5.9); platform_inventory, platform_open_work and finish_summaries with `replace_platform_inventory`; the inventory script and `npm run inventory`; the ingest function's `inventory` and `finish_summary` kinds; get_platform_inventory, get_finish_summaries and mark_finish_summaries_reviewed; gitpush Finish sends both through the outbox; the nightly prompt compares finish summaries with the inventory and raises follow-ups; the weekly drift audit gains the Phase 7 checks.
8. **Project planning (new 2026-10-27, Steps 50 to 59).** Most of it is done in claude.ai; the code parts are:
   - **8a, three read-only CLI review passes** (after Phase 7, so "unfinished" comes from platform_open_work), each reporting per app what it does, what is unfinished and its known bugs; the findings are saved to each app's `current_state` from claude.ai. The families:
     1. Alfred core: alfred, overwatch, timer, games (all of `src/` except money and sam).
     2. Money and SAM: warren_buffet and sam, with the wb-sync and sam-song-scores functions.
     3. Chat-and-tool apps: dj, drive_mix, ken, jobs; plus workshop, switchboard, arnold, monty_don and sports, which live mostly outside this repo or are not built yet.
   - **Chat work in claude.ai (not CLI steps):** a review of Alfred's items and intentions, including the roadmap item and SAM; the friction log turned into intentions attached to projects; ideas from other Claude chats swept into Alfred (Appendix B).
   - **8b, the portfolio plan** (4.16, section 7, section 9).
   - **8c, the suggested Project group** on inbox items (4.17).

**Moved out (2026-10-27):** the old Phase 8, Switchboard posting live session state through overwatch-ingest, is no longer part of this project; it is kept as an Alfred intention.

Phases 1 to 6 give a working Overwatch. Phase 7 is large but self-contained.

## 11. Open questions

1. Activity backfill depth: 30 days proposed.
2. Nightly time and push: decided 2026-10-25. Nightly 04:20, weekly Monday 04:35, push 05:00 Pacific.
3. Client work: a context per client is assumed; confirm when the first client arrives. (2026-10-27: a "Client work" portfolio covers the Team IMPACT and ActBlue contexts, 4.16.)
4. Skills in claude.ai cannot be read by a scheduled task, so the repo-versus-claude.ai drift check is out of reach for now. Proposed: record a fingerprint whenever Alex confirms he pasted a skill, and flag repo changes since.
5. Hours as an effort unit for projects worked outside the CLI: deferred until a client project needs it (4.3).

## Appendix A: global chat preference (Settings, Profile)

"When a conversation becomes a project idea, a code idea, or something worth learning in Ken, offer once to capture it to the Alfred inbox with a one-line summary, and remind me to clip the chat so the item links back to it. Check Alfred's apps list (get_apps) for which app it belongs to. Suggest the tag `idea` for an idea (something I might do or build someday, not a task); a code idea also gets its app's tag, and a bug gets `bug` instead of `idea`."

## Appendix B: one-time idea sweep (a chat outside any Project)

"Look through my recent chats for project or code ideas I've been exploring. List each one with a one-line summary, then create an Alfred inbox item for each, with the app left blank and the tag `idea` suggested."

## Appendix C: status-request prompt shape

For a worktree:
```
Run tag: <project-code>-s<next step>b-<4 chars>
Window: the <project-code> worktree

Overwatch status request. This project has been on step <n> for <days> days against an estimate of <estimate> steps. Report: what is done, what is blocking, what remains, and a revised estimate in steps. Change nothing.

Run tag: <same>
```

For a project thread (marked as not for the CLI):
```
FOR CLAUDE.AI, NOT THE CLI
Overwatch status request for <project>. Summarise where this project stands, what it is waiting on, and the next step, then write them to the project's plan with update_project_plan.
```
