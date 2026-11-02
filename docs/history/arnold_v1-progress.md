# Progress: Arnold V1 (project code `arnold_v1`)

This file: `docs/arnold_v1-progress.md`. Spec: `docs/arnold_v1-technical-spec.md`. Worktree and claims owner: `arnold_v1-k7m`.

The CLI does one step, reports, and stops for Alex's confirmation before the next.

| Step | What | Where | Status |
|---|---|---|---|
| 1 | Read-only recon and plan | CLI | Done 2026-10-29 |
| 2 | Claim the files; rewrite spec and progress; write migration 1 (`_pending_`) and its verify query | CLI | Done 2026-10-29 |
| 3 | Database step for migration 1: gitsync, drift check, claim db items, number, Alex runs it and the verify query, checkpoint | CLI + Alex runs SQL | Done 2026-10-29: `186_arnold_v1_plans_goals_notifications.sql` ran (after the s3c CASE-in-IF fix), `1_verify.sql` CONFORMANT, checkpointed to main (0618fd1) |
| 4 | Migration 2: `arnold_get_progress()` plus a test script against real microworkout executions and a test plan; then its database step | CLI + Alex runs SQL | Done 2026-10-29: `187_arnold_v1_get_progress.sql` ran, `2_get_progress_test.sql` passed every check (Oct 28 count 3, checkpoints 0/2/3, all refusals true), checkpointed to main (ae93dec) |
| 5 | MCP tools: `get_arnold_plan`, `create_arnold_plan`, `get_arnold_progress`, `log_claude_notification`, `get_claude_notifications`, `send_alfred_push`, and `_shared/web-push-send.ts`. Deploy mcp; Alex refreshes the Alfred connector | CLI | Done 2026-10-30: mcp v179 deployed (s5c), `verify_jwt` false, 178 tools; a test push reached the phone and a repeated dedupe_key was refused; tool files checkpointed to main (d3af5ea), releasing db:deploy |
| 6 | `arnold` skill in the repo; alfred-enrich gym-email routing; Alex copies both into claude.ai | CLI + Alex | Done 2026-10-31: checkpointed to main (d438ca6). Revised at s8b (skills 2026-10-31b: actionable-only review items, gym card title, a class counts once logged); Alex re-copies both into claude.ai |
| 7 | Alfred data setup: Yoga class intention, Morning sleep check-in intention; then plan V1 created in a fresh thread through the `arnold` skill, with Alex's approval | This chat | Intentions done 2026-10-31: Yoga class `mvwgd2o3ftyyyus5zks`, Morning sleep check-in `mvwgdsgi851e98oy3go`. No Gmail filter needed: enrichment already routes Life Time emails (noreply@t.lifetime.life) to arnold. The `arnold` app description moved into the step 8 migration. Done 2026-10-31: plan V1 is active (created in chat through the `arnold` skill) |
| 8 | Shared notification settings: `claude_notification_settings` table and validator (migration 3) and its verify test; tools `get_claude_notification_settings` (tier 1) and `update_claude_notification_settings` (tier 2); database step; deploy mcp; Alex's settings row written in chat | CLI + Alex runs SQL + this chat | Code written 2026-10-31 (s8b): verify test, tools, 180 tools registered. s8c: numbered `188_arnold_v1_claude_notification_settings.sql` (after gitsync to 1831c94, no drift). 2026-10-31: 188 run (CONFORMANT, 94 tables) and `3_notification_settings_verify.sql` passed every check. s8d: mcp v180 deployed, `verify_jwt` false, 180 tools. Done 2026-10-31: checkpointed to main (0cc6355), db claims released. The shared settings row is saved (chat, 2026-10-31) |
| 9 | Claude hourly notifications task (generic, all apps): prompt doc `docs/claude-hourly-notifications-task-prompt.md` (CLI), then the Claude scheduled task and its `platform_schedules` row (chat) | CLI + this chat | Done 2026-10-31: prompt doc checkpointed to main (cc924d6). s10: links are `/<id>` only, PROMPT VERSION 2026-10-31b. The task "Claude hourly notifications" (hourly 05:00-19:00 Pacific) and its `platform_schedules` row exist (chat, 2026-10-31) |
| 10 | Morning review task: prompt doc (CLI), then the Claude scheduled task and its `platform_schedules` row (chat) | CLI + this chat | Done 2026-10-31: prompt doc (PROMPT VERSION 2026-10-31a) in main (0f6dcc5); the task "Arnold morning review" (05:05 daily) and its `platform_schedules` row exist. s11: mcp v181 deployed with the `/<id>` link help, `verify_jwt` false, 180 tools; awaiting Checkpoint |
| 11 | Testing on the phone (Alfred push and Claude push), one part at a time | Alex | Done 2026-11-02: passed, see "Test results" |
| 12 | Closeout: move the spec and progress to `docs/history/` | CLI | Done 2026-11-02 (s12): hourly doc's schedule corrected to 05:00-19:00, both docs moved |

## Test results (phone, 2026-10-31 to 2026-11-02)

- **Hourly task:** the first run sent one correct encouragement. On Nov 1 it sent a yoga inbox-waiting nudge that opened the Life Time email, a behind-pace microworkout nudge and a halfway encouragement. No caps were exceeded, and every `/<id>` link opened the right record.
- **Gym email:** the card was titled "Log Yoga class for Arnold", and logging the class stopped the yoga nudges.
- **Morning review:** Nov 1 raised nothing (correct). Nov 2 raised exactly one item, "Check in on your back with Arnold: scheduled after Sunday's yoga" (`back_check` template), logged in `claude_notifications`, with a Claude push.

## Later

- A Notifications project: pacing and sequencing notifications across apps.
- Two plan-guard bugs logged for Switchboard 2.0: `<NNN>` migration names, and redirects in deploy commands.
- Inbox items cannot link an existing intention.

## Scope blocks

### Step 3 (run as s3, then s3b)
- create: supabase/migrations/186_arnold_v1_plans_goals_notifications.sql (number 186 issued by number-migration on 2026-10-29)
- update: docs/arnold_v1-progress.md
- delete: supabase/migrations/_pending_arnold_v1-k7m_plans_goals_notifications.sql
- deploy: nothing
- SQL: arnold_plans, arnold_goals, claude_notifications
- Database items: db:table:arnold_plans, db:table:arnold_goals, db:table:claude_notifications, db:fn:arnold_create_plan, db:fn:log_claude_notification (claimed at this step, after gitsync; released by Checkpoint)
- Estimated run: 15m

### Step 4 (run as s4, then s4b)
- create: supabase/migrations/_pending_arnold_v1-k7m_get_progress.sql, supabase/tests/arnold_v1-k7m/2_get_progress_test.sql (s4); supabase/migrations/187_arnold_v1_get_progress.sql (s4b, number 187 issued by number-migration on 2026-10-29)
- update: nothing
- delete: supabase/migrations/_pending_arnold_v1-k7m_get_progress.sql (in the follow-up that numbers it)
- deploy: nothing
- SQL: arnold_plans, arnold_goals, executions, intents
- Database items: db:fn:arnold_get_progress (claimed at the database part, after gitsync)
- Estimated run: 35m

### Step 5 (s5: code and tests)
- create: supabase/functions/_shared/tools/arnold.ts, supabase/functions/_shared/tools/arnold.test.mjs, supabase/functions/_shared/tools/claude-notifications.ts, supabase/functions/_shared/tools/claude-notifications.test.mjs, supabase/functions/_shared/tools/alfred-push.ts, supabase/functions/_shared/tools/alfred-push.test.mjs, supabase/functions/_shared/web-push-send.ts, supabase/functions/_shared/web-push-send.test.mjs
- update: supabase/functions/mcp/index.ts, docs/arnold_v1-progress.md
- delete: nothing
- deploy: nothing
- SQL: none
- Estimated run: 40m

### Step 5b (test count update, design update, then deploy)
- create: nothing
- update: supabase/functions/mcp/index.test.mjs, docs/arnold_v1-progress.md, docs/arnold_v1-technical-spec.md
- delete: supabase/functions/mcp/deno.lock
- deploy: mcp
- SQL: none
- Database items: db:deploy (claimed at the deploy, after gitsync)
- Claim first: supabase/functions/mcp/index.test.mjs, supabase/functions/mcp/deno.lock
- Estimated run: 25m

### Step 6 (skill, run as s6)
- create: .claude/skills/arnold/SKILL.md
- update: .claude/skills/alfred-enrich/SKILL.md, docs/arnold_v1-progress.md
- delete: nothing
- deploy: nothing
- SQL: none
- Database items: none
- Estimated run: 20m

### Step 7
Chat only. No files, no SQL from the CLI.

### Step 8 (code and tests, migration left `_pending_`; s8 was blocked for SQL scope, done as s8b)
- create: supabase/migrations/_pending_arnold_v1-k7m_claude_notification_settings.sql, supabase/tests/arnold_v1-k7m/3_notification_settings_verify.sql
- update: supabase/functions/_shared/tools/claude-notifications.ts, supabase/functions/_shared/tools/claude-notifications.test.mjs, supabase/functions/mcp/index.ts, supabase/functions/mcp/index.test.mjs, docs/arnold_v1-progress.md, docs/arnold_v1-technical-spec.md, .claude/skills/arnold/SKILL.md, .claude/skills/alfred-enrich/SKILL.md
- delete: nothing
- deploy: nothing
- SQL: claude_notification_settings, apps, arnold_plans
- Database items: none
- Estimated run: 45m

### Step 8c (database step, then deploy; run as s8c and s8d)
- create: supabase/migrations/188_arnold_v1_claude_notification_settings.sql (number 188 issued by number-migration on 2026-10-31)
- update: docs/arnold_v1-progress.md
- delete: supabase/migrations/_pending_arnold_v1-k7m_claude_notification_settings.sql
- deploy: mcp (s8d, after Alex has run the migration and the verify test)
- SQL: claude_notification_settings, apps
- Database items: db:table:claude_notification_settings, db:table:apps, db:fn:claude_notification_settings_problem, db:fn:claude_notification_settings_guard (s8c, after gitsync); db:deploy (s8d)
- Estimated run: 25m

### Step 9
- create: docs/claude-hourly-notifications-task-prompt.md
- update: nothing
- delete: nothing
- deploy: nothing
- SQL: none
- Database items: none (the `platform_schedules` row is written in chat with create_platform_schedule)
- Claim first: docs/claude-hourly-notifications-task-prompt.md
- Estimated run: 15m

### Step 10
- create: docs/arnold-morning-review-task-prompt.md
- update: nothing
- delete: nothing
- deploy: nothing
- SQL: none
- Database items: none (the `platform_schedules` row is written in chat with create_platform_schedule)
- Claim first: docs/arnold-morning-review-task-prompt.md (already held since step 2)
- Estimated run: 20m

### Step 11
Alex only. No files.

### Step 12
- create: docs/history/arnold_v1-technical-spec.md, docs/history/arnold_v1-progress.md
- update: nothing
- delete: docs/arnold_v1-technical-spec.md, docs/arnold_v1-progress.md
- deploy: nothing
- SQL: none
- Database items: none
- Estimated run: 5m

## Claims

Claimed at step 2 (run tag `arnold_v1-k7m-s2-w8dn`), held until gitpush Finish:

- **Docs:** both docs; `docs/arnold-hourly-task-prompt.md`; `docs/arnold-morning-review-task-prompt.md`; `docs/history/arnold_v1-technical-spec.md`; `docs/history/arnold_v1-progress.md`.
- **SQL:** both `_pending_` migrations; `supabase/tests/arnold_v1-k7m/`.
- **Functions:** the six tool files under `supabase/functions/_shared/tools/` (`arnold`, `claude-notifications`, `alfred-push`, each with a test); `supabase/functions/_shared/web-push-send.ts` and its test; `supabase/functions/mcp/index.ts`.
- **Skills:** `.claude/skills/arnold/`; `.claude/skills/alfred-enrich/SKILL.md`.

The numbered migration files are claimed at their database steps. Claimed at step 3: `supabase/migrations/186_arnold_v1_plans_goals_notifications.sql`, and the db items `db:table:arnold_plans`, `db:table:arnold_goals`, `db:table:claude_notifications`, `db:fn:arnold_create_plan` and `db:fn:log_claude_notification`. gitpush Checkpoint releases the db items. Claimed at step 4 (s4b): `supabase/migrations/187_arnold_v1_get_progress.sql` and `db:fn:arnold_get_progress`. Claimed at s5b: `supabase/functions/mcp/index.test.mjs`, `supabase/functions/mcp/deno.lock` (deleted at s5b), and `db:deploy`. Claimed at s8c: `supabase/migrations/188_arnold_v1_claude_notification_settings.sql`, `db:table:claude_notification_settings`, `db:table:apps`, `db:fn:claude_notification_settings_problem`, `db:fn:claude_notification_settings_guard`. `docs/arnold-hourly-task-prompt.md` is no longer used (renamed at s5b); its claim is left for gitpush Finish to release.

## Decisions log

- 2026-10-29: No new activity table. Workouts are intentions and executions; gym emails are inbox items Alex processes.
- 2026-10-29: Every number, time, limit and instruction is stored in the plan record. Code holds no goal values.
- 2026-10-29: Plans are versioned like SAM's: Arnold proposes, Alex approves, the old plan is superseded and kept.
- 2026-10-29: The Claude notification log is shared across apps, not Arnold-only. Named `claude_notifications`, to stay distinct from `notification_steps`, `reminders` and `push_subscriptions`.
- 2026-10-29: Sleep check-in is in V1. No Arnold screen in V1.
- 2026-10-29 (step 2): No pauses column and no pauses table. Travel or a rehab week is a new plan version.
- 2026-10-29 (step 2): Microworkouts count elements with `display_type = 'step'` and `is_completed = true`, each dated by its own `completed_at` in Pacific time. Never the execution's `closed_at` or `event_date`.
- 2026-10-29 (step 2): Hourly nudges are a Claude scheduled task, not an Edge Function.
  - It runs hourly, 5 am to 8 pm Pacific, and applies the plan's plain-language `nudge_instructions` within `notification_settings`.
  - Pace checkpoints stay on goals as data.
  - Dropped: rule types, `nudge_rules`, `encouragement_rules`, the `messages` templates and `pauses`. Kept: an optional `voice_notes`.
  - Delivery is the new shared tool `send_alfred_push`. It logs and sends in one call and refuses a repeated dedupe key. Its sending code is `_shared/web-push-send.ts`, copied from notify-dispatch, which stays untouched.
  - Removed from the plan: the arnold-hourly Edge Function, arnold-hourly-core, the pg_cron migration, `supabase/config.toml`, `ARNOLD_HOURLY_SECRET` and the `p_user_id` parameters.
  - "Execution not logged" is judged by Claude from the inbox item and the intention.
- 2026-10-29 (step 2): The morning review always does two things when it raises something: a Claude push notification and an inbox item (`source_app` arnold, `source_type` task) holding the paste-ready prompt. Both are logged in `claude_notifications`, on channels `claude_push` and `inbox_item`.
- 2026-10-29 (step 2): Accepted from the step 1 report:
  - A Gmail filter labels gym emails `alfred/arnold` (data step), with the alfred-enrich rule as a fallback. (Dropped at s8b: not needed.)
  - `claude_notifications.app` is a foreign key to `apps(id)`, and there is a unique index on `(user_id, dedupe_key)`.
  - `delivery_status` is updated after the send.
  - The `arnold` app description gains sleep and wellbeing (data step).
- 2026-10-29 (step 2): The doc file names stay `docs/arnold_v1-technical-spec.md` and `docs/arnold_v1-progress.md`.
- 2026-10-30 (s5b): The hourly job is a generic Claude scheduled task, "Claude hourly notifications" (`claude_hourly_notifications`), not an Arnold task.
  - Its prompt is generic: read the shared settings, then for each enabled app read that app's plan and data with the tools the settings name, decide, and send.
  - New shared table `claude_notification_settings`, one row per user: `window_start`, `window_end`, `max_per_hour` (3), optional `max_per_day`, and `apps` (app id, enabled, plan and progress tool names; for Arnold `get_arnold_plan`, `get_arnold_progress`). Tools `get_claude_notification_settings` (tier 1) and `update_claude_notification_settings` (tier 2). Built as step 8.
  - Notifications are always sent separately, never combined. Each app's own limits stay in its plan (Arnold's 3 nudges and 2 encouragements a day); the shared settings add the overall window and caps.
  - The prompt doc is renamed `docs/claude-hourly-notifications-task-prompt.md`, claimed at its step.
  - Pacing, spacing and Overwatch sequencing belong to a future Notifications project, not Arnold V1.
- 2026-10-31 (s6): The `arnold` skill (now step 6) comes before the data setup (now step 7), so plan V1 is created in a fresh thread through the skill, which tests the skill's propose-then-confirm flow on the first real plan. Decided in chat.
- 2026-10-31 (s6): Alfred has no tool that creates items or intentions directly. New workouts Arnold designs reach Alfred as `create_inbox_item` suggestions that Alex files. `update_inbox_item` has no field for linking an existing intention, so the gym-email rule names the Yoga class intention, with its id, in `ai_reasoning`.
- 2026-10-31 (s8b): No Gmail filter. Hourly enrichment already routes Life Time emails (noreply@t.lifetime.life) to arnold. Replaces the step 2 filter decision.
- 2026-10-31 (s8b): Inbox items must be actionable (Alex). The morning review creates an Arnold inbox item only when `review_instructions` say a plan conversation is due, titled as a call to action (e.g. "Review your Arnold plan: yoga goal hit two weeks running"). A goal met on its own posts nothing to the inbox; the hourly job may still send an encouragement push. No `goal_met` template. `arnold_prompt_templates_problem` requires no key, so no SQL change; the `arnold_plans.prompt_templates` column comment still names `goal_met` as an example and was left as is.
- 2026-10-31 (s8b): Gym emails show "Log Yoga class for Arnold" on the inbox card (Alex). An enriched card's title is `suggested_item_text`, else `suggested_intent_text` (`listTitleFor`), and `update_inbox_item` sets both, so enrichment sets `suggested_intent_text` with `suggest_intent` and `suggest_item` off: the title shows and filing creates nothing.
- 2026-10-31 (s10): Every Alfred link Claude writes is `/<id>` (Alex's rule). A record type that does not open that way is a bug to file, never a reason for a longer path.
- 2026-10-31 (s10): The morning review's inbox item is `source_type: "task"` with the call-to-action title in `source_metadata.task_name` (shown with the run date as the card title). The Claude push is the scheduled task's own completion notification, so its final summary is one line.
- 2026-10-31 (s8b): A class counts only once Alex logs a done execution on the Yoga class intention; the email is a reminder to log it. Replaces "a confirmation counts as attended".

## Notes

- 2026-10-29 (step 3c): PL/pgSQL ends an IF condition at the first THEN outside parentheses, so a CASE inside an IF
  condition must be parenthesised. Every SQL file is now checked with libpg-query (SQL plus PL/pgSQL bodies, DO blocks
  included) in the scratch area before hand-over.
- 2026-10-29 (step 4): `arnold_get_progress` returns one `day` row per goal per day and, for weekly goals, one `week`
  row per Monday-to-Sunday week the range touches, counted over the whole week. Columns: plan_id, goal_key, label,
  measure, period, row_kind, local_date, week_start, count, target, met, on_track, days_left, usual_day, before_plan,
  checkpoints [{time, count, passed, count_by_time, met}], last_activity_at, execution_ids. At most 93 days per call.
  The current week's on_track is true once met, else null for Claude to judge from days_left and usual_days.
  Element keys fall back to camelCase (`isCompleted`, `completedAt`, `displayType`) in case old rows used them.
  The test script ends in a deliberate error so it rolls back; the result JSON is in the error message.
- 2026-10-29: `send_alfred_push` does not delete dead subscriptions. It reports 404/410 in `delivery_detail`, and notify-dispatch cleans them up.
- 2026-10-29: `web-push-send.ts` imports `npm:web-push@3.6.7` directly, so `supabase/functions/mcp/deno.json` is not touched. At s5, `deno check --config supabase/functions/mcp/deno.json` resolved it and type-checked all four new files clean; `_shared/platform.ts` already uses bare `jsr:` specifiers in the deployed mcp, the same mechanism.
- 2026-10-29 (s5): `send_alfred_push` is the first MCP tool to read `push_subscriptions` secret columns (endpoint, p256dh, auth_key). Secret columns are a read-tool setting, not a database grant, so `ctx.db` can read them; the tool uses them only to send and returns devices by subscription id.
- 2026-10-30 (s5b): For step 8, `mcp/tables.test.mjs` checks every tool's tables against `schema-snapshot.sql`, which only gains `claude_notification_settings` once the migration is checkpointed. So s8 may write the tools, but expect that test to fail until s8b's checkpoint; deploy (s8c) only once it passes.
- 2026-10-29 (s5): VAPID secrets confirmed project-wide (`VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, the names notify-dispatch reads), so the mcp function has them.
