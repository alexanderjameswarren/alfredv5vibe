# Technical spec: nightly counts (nightly_counts-f8k)

## 1. Why

Overwatch's nightly task budgets about 45 Alfred calls and went over almost every night since Oct 28
(53, 56, 59, 53, 61, 47), usually pausing for the 5-minute window to clear. One Postgres function and
one tier 1 tool return most of the counts as a single JSON object, so the run stays well under budget
with no pause.

**Out of scope:** updating the scheduled task itself (Claude does it from main after the prompt lands),
the weekly prompt, and the Overwatch tab's screens.

**Expected calls after the change:** about 12 to 20 on a typical night, 38 at worst (a night with a
full impact review). A night like Nov 2 falls from 47 to about 13; one like Nov 1 from 61 to about 21.
Per-step figures before the change are worked out from the prompt and row counts, since runs log only
the total. The pause rule stays as a safety net, because the budget is shared with other tasks.

## 2. What the function counts, and what stays with Claude

**Fully counted:** stalled, waiting on Alex, overruns, over limit, estimated finish, empty projects,
scope changes, inbox backlog, unrouted, low confidence, stopped schedules, orphan runs, missed
intentions, inventory stale, portfolio review, repeated claim blocks, watch ended, the plan, and the
duplicate-run check.

**Facts from the function, the decision with Claude:**
- **Quiet apps:** the function returns last activity. Pulls run after it, so Claude removes any app its
  pull found active. An app with no log row (`quiet_needs_own_data`) still needs its recipe's record read.
- **Fading:** candidates (section 5). Whether one still means to happen is the skill's call.
- **Deadline with no date:** active intentions with no event in the window. What counts as a deadline
  is the skill's call.
- **Checks due:** the due list. The `found` text is Claude's.

**Claude alone:** recipe pulls (recipes are Alex's plain words), `task_health` (`list_triggers`, another
connector), impact review follow-ups, and all wording.

## 3. The migration

`supabase/migrations/_pending_nightly_counts-f8k_counts_fn.sql`, numbered at s4 after `gitsync`.

```sql
alter table public.overwatch_watch
  add column intent_id text references public.intents(id) on delete set null;
comment on column public.overwatch_watch.intent_id is '...';
```

Then the function, its comment and its grants. `check_platform_conformance` runs afterwards and must
say `CONFORMANT`. No Overwatch tab change.

## 4. The function

`public.overwatch_nightly_counts(p_as_of timestamptz default now()) returns jsonb`

- **Argument:** only `p_as_of`, which pins the clock for tests and the comparison. It does not rewind
  the data. The function reads the active plan itself and works out `local_date` in
  America/Los_Angeles, so settings cannot drift between the prompt and the function.
- **Security:** `security invoker`, `stable`, plpgsql, `search_path public, pg_temp`, as
  `overwatch_project_progress`. The tool runs as Alex, so RLS gives the same rows as today's reads, and
  one statement gives every count one snapshot.
- **Grants, same file:**
  ```sql
  revoke all on function public.overwatch_nightly_counts(timestamptz) from public, anon;
  grant execute on function public.overwatch_nightly_counts(timestamptz) to authenticated, service_role;
  ```
- **Missing setting:** the count's key is left out and the setting named in `settings_missing`, except
  `inventory_stale_days`, which uses 7 (the prompt's rule 1).
- **`since_last`:** `created_at` of the newest **nightly** note with `for_date` before `local_date`, else
  `local_date` minus 1 day.
- **Definitions** follow Step 5 of `docs/overwatch-nightly-task-prompt.md` as it stands, except where
  section 6 says otherwise. "More than N days" compares whole Pacific days.
- **`empty_projects`** reads `items` and `intents` only to drop archived members, as `shapeGroups` does.

Flags keys match the live notes, so Step 7 can copy them:

```
{ local_date, utc_offset, since_last, plan: {id, instructions, settings, checks_later},
  settings_missing: [],
  prior_runs: { today: [...], last_two: [{id, started_at, skipped}] },
  apps: [{app_id, name, rhythm_days, activity_recipe, current_state, last_activity_on, active_yesterday}],
  activity_yesterday: [{app_id, kind, title}],
  quiet_apps: [{app, last_used_on, days_since, rhythm_days}], quiet_needs_own_data: [app_id],
  projects: [full get_project_plans row], stalled, waiting_on_alex, overruns,
  over_limit: [{count, limit}], estimated_finish, scope_changes, empty_projects,
  inbox_total, backlogs, unrouted: [{total, older_than_one_day}], low_confidence_routing,
  inbox_urgent, overwatch_open_first_lines, followup_open_first_lines,
  stopped_schedules, orphan_runs, claim_blocks,
  fading_candidates: {total, rows: [{kind: "intention", id, text, days}]},
  overdue_intentions, deadline_candidates: [{id, text, description (first 200 characters)}],
  watch_ended, watch_in_force, checks_due, inventory_stale, finish_summaries,
  portfolio_review_due }
```

`fading_candidates.rows` is the oldest 50, with `total` beside it.

## 5. Fading is intentions only

Items never fade. Items are reference material (recipes, Shopping products, notes), and a to-do linked
to an item is tracked by its intention.

A candidate is an intention that is:
- active and not archived;
- one-off: `recurrence_config` is null or its `type` is `once`, the same test `get_intents` uses;
- with no unarchived event today or later;
- with no undone past event inside the window Step 5.7 reads (`local_date` minus `fading_days`), since
  that is a missed date, not fading;
- with `updated_at` more than `fading_days` days before `local_date`;
- not named by a current `focus` or `keep_an_eye_on` watch: its `intent_id` is the intention's id, or
  its `group_id` is the intention's group (the intention's `group_id` or a live membership,
  `removed_at` null). Current means `starts_on` on or before `local_date` and `ends_on` on or after it.

**Decision: an undone event older than that window does not exclude the intention.** The missed-date
count looks back only `fading_days`, so excluding those too would drop them from both lists.

The prompt rewrite drops the item reads (the `get_items` and `get_records` item pages).

**Oct 19 figures.** Active rows with an identical `updated_at` of 2026-10-19 20:21:21 UTC, from migration
139's backfill of `status_written_at`. Their real last-touched dates are lost.

| | Alex's count | CLI count, 2026-11-02 |
|---|---|---|
| Active items | 335 | 334 |
| Active intentions | 38 | 35 |

Those intentions become fading candidates around Nov 18 (the first night "more than 30 days" holds is
Nov 19). That is expected and needs no special handling.

## 6. Differences from today's counts

- **Fading:** section 5. Items are gone, and the date is `updated_at` alone.
- **Stopped schedules:** reads each job's true last ok run, not the newest 50 runs. There were 440 ok
  runs in 14 days, so 50 covers about 1.6 days, and a schedule missing from that list is not flagged
  when its due time is older than the list. The function may flag schedules the old check missed.
- **`since_last`:** nightly notes only. Today's read can pick up Monday's weekly note, which drops scope
  changes made between the two runs on Tuesday night.
- **Day counts** may move by one where the old run's arithmetic differed.
- **`estimated_finish`** is in the real flags but not the prompt's list. The rewrite adds it.

### Finding, fixed at s8: a false stopped schedule after the grace ends

Called at 2:35 pm Pacific on 2026-11-02, `stopped_schedules` listed `sam/daily_plan_review` with
`last_ok` 2026-11-02, a false alarm. That job is expected by 08:00 with 6 hours' grace but runs just
after midnight Pacific (00:16 that day). After 14:00 the function takes today's 08:00 as the due time,
and a run at 00:16 is before it. At 4:20 am this never fires, which is why the nightly never showed it.

**The rule from s8:** a job is stopped only when it has no ok run after the **previous** due time plus grace
(daily: `due_at` minus 1 day, plus `grace_hours`; weekly: minus 7 days, plus `grace_hours`) **and** the
current due time plus grace has passed. A run inside the previous cycle's grace counts for that cycle only.

### Finding, for s8: `apps.active_yesterday` also counts today

`active_yesterday` is true when an app's last activity is yesterday **or today**. At 4:20 am a job that
already logged a row after midnight would make it true with nothing yesterday, and the pull would be
skipped. The rewritten prompt therefore does not read it: it decides from `activity_yesterday`.

## 7. The nightly tool

`get_overwatch_nightly_counts`, tier 1, in `supabase/functions/_shared/tools/overwatch-nightly.ts`, with
an optional `as_of`. A computed report, so it keeps its own shape, with lists capped as above.

```
tables: { reads: ["overwatch_plans", "overwatch_watch", "overwatch_notes", "apps", "app_profiles",
  "activity", "platform_runs", "platform_schedules", "item_groups", "group_types", "project_plans",
  "clips", "project_estimates", "item_group_members", "items", "intents", "events", "executions",
  "inbox", "reminders", "claim_blocks", "project_links", "platform_inventory", "finish_summaries",
  "portfolios", "portfolio_plans"], writes: [] }
```

**Tests:**
- `overwatch-nightly.test.mjs`: passes `as_of`, refuses a bad one, returns bare data, reports database
  errors as retryable.
- `mcp/index.test.mjs`: tool list and tier.
- `mcp/tables.test.mjs`: runs as is.
- `supabase/tests/nightly_counts-f8k/1_counts_test.sql` (`--test`, undoes itself): fixture rows either
  side of each threshold, every fading exclusion, the JWT set as in
  `arnold_v1-k7m/2_get_progress_test.sql`, and the run time.

## 8. The watch tools

In `supabase/functions/_shared/tools/overwatch-plan.ts`, with `inputSchema` in `mcp/index.ts`:

- `create_overwatch_watch` and `update_overwatch_watch` accept an optional `intent_id`. On update, null
  clears it. The foreign key is the check on a bad id.
- `get_overwatch_watch` returns it, through `WATCH_COLUMNS`.
- `WATCH_COLUMNS` naming a new column means the deploy must follow the migration (s4 before s6).

Tests go in `overwatch-plan.test.mjs`.

## 9. The prompt and the skill

**`docs/overwatch-nightly-task-prompt.md`:** Steps 2.3 to 5 read from the one call, the item reads go,
the fading wording says intentions, `estimated_finish` joins the flags list, the call budget text is
updated, and the version is bumped.

**`.claude/skills/overwatch/SKILL.md`:**
- the fading rule drops "or an active item" and the reference-items exclusion, and says items never fade;
- the watch section says a watch can name an intention;
- the version line is bumped. A skill change means a `propose_skills` update in claude.ai.

## 10. Checking the counts match

In this order, because a manual run replaces that day's note. These are the last three steps of ten:

- **s8:** fix the stopped-schedule rule in a new migration (section 6).
- **s9:** the morning after s8, before the prompt changes in the task, call the tool with `as_of` set to
  that morning's run start and compare every flags key against that morning's note. Do it the same
  morning, since the data is not rewound. Explain every difference in the progress file.
- **s10:** Claude updates the scheduled task from main after Alex checkpoints. One manual run: check the
  calls, no pause, and the note. Then Finish.

The tool's first real call, from claude.ai on 2026-11-02 against mcp 192, came back whole at about
37,000 characters, with all top-level keys.
