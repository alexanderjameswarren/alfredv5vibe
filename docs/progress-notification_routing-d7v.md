# Notification routing — progress

Project code `notification_routing-d7v`. Spec: `docs/technical-spec-notification_routing-d7v.md`.
Total estimate: about 11h 20m, plus about 10 task pastes by Alex.

> **Steps 3 and 9 wait on warren_buffet_p4-r6d.** It holds `supabase/functions/mcp/index.ts` and
> `supabase/functions/mcp/index.test.mjs` (step 3) and `docs/wb-weekly-cleanup-task-prompt.md`
> (step 9). Claim them at those steps, once that thread has finished or checkpointed them. Step 9
> does the Money cleanup prompt last.

Every `db:` item is claimed just in time at its own step, after `gitsync`, and released by
Checkpoint. Migrations are numbered only at the step that queues them.

## Steps

### 1. Plan — DONE 2026-11-03 (`s1-k3vp`)

### 2. Confirm, claim, spec and progress — DONE 2026-11-03 (`s2-w8hc`)
47 files and folders claimed. The three Warren Buffet files were left for steps 3 and 9.

### Phase A — Signals

### 3. Signals table and tools, without the MCP server file — DONE 2026-11-03 (`s3b-r4jx`)
(`s3-p6ty` was stopped by the plan guard: its scope had `SQL: none`.) Written, not queued:
`_pending_notification_routing-d7v_signals.sql` (signals table, indexes, guard trigger,
`started_by_valid`, `raise_signal` with the service_role path, `started_by` and `signal_id` on
`claude_notifications` with a backfill, `log_claude_notification` with two trailing defaults,
`register_table`), test `1_verify_signals.sql`, tools `raise_signal` and `get_signals`, and
optional `started_by` on `send_alfred_push` and `log_claude_notification`. `requireAlfredPath`
moved into claude-notifications.ts (re-exported from alfred-push.ts), so signals.ts loads without
web-push. `resolve_signal` moved to step 7.

### 3c/3d. Register the step 3 and 4 tools — DONE 2026-11-03 (`s3c-m5zd` stopped by the Switchboard reinstall, finished in `s3d-v9kb`)
mcp/index.ts registers `raise_signal`, `get_signals`, `get_dispatch_plan`, `deliver_signals` and
`get_delivery_rules`, and `send_alfred_push` and `log_claude_notification` take an optional
`started_by`. mcp/index.test.mjs: 192 tools, `get_delivery_rules` in the Overwatch tiers, a
schema-against-handler test for the signal tools and the two started_by schemas, and 7 app-id
schemas (raise_signal added). The db items were all free at check time.

### 3e. Number, queue and deploy steps 3 and 4 together (30m)
After Alex's gitsync: drift check on `signals`, `claude_notifications`, `overwatch_plans`, `inbox`
and `claude_notification_settings`, db claims, number both migrations (signals first, then
dispatcher), queue them, queue tests 1 and 2 with `--test`, deploy mcp,
`check_platform_conformance`, Checkpoint.

Scope of this step:
- create: supabase/migrations/<next>_signals.sql, supabase/migrations/<next+1>_dispatcher.sql
- update: nothing
- delete: supabase/migrations/_pending_notification_routing-d7v_signals.sql, supabase/migrations/_pending_notification_routing-d7v_dispatcher.sql
- deploy: mcp
- SQL: signals, claude_notifications, overwatch_plans, inbox, claude_notification_settings
Estimated run: 30m

DB: `db:table:signals`, `db:table:claude_notifications`, `db:table:overwatch_plans`,
`db:table:inbox`, `db:table:claude_notification_settings`, `db:fn:raise_signal`,
`db:fn:log_claude_notification`, `db:fn:dispatch_signals`, `db:fn:overwatch_delivery_problem`,
`db:deploy`.
Waits on: mcp/index.ts and its test (warren_buffet_p4-r6d).

### Phase B — Dispatcher

### 4. Delivery rules and dispatcher function, without the MCP server file — DONE 2026-11-03 (`s4-h2qn`)
Written, not queued: `_pending_notification_routing-d7v_dispatcher.sql`. It has
`overwatch_delivery_whole`, `overwatch_delivery_problem`, a check constraint on `overwatch_plans`,
compute-only `dispatch_signals`, and the seed: a new Overwatch plan version copying
claude_notification_settings, with no minimum gap. Test `2_verify_dispatcher.sql` covers the
validator, the seed and every rule. Tools: `get_dispatch_plan` and `deliver_signals` in
signals.ts, `get_delivery_rules` in overwatch-plan.ts, with tests. Registration moved to 3c.
`update_signal` moved to step 11. Spec sections 4.2, 4.3, 5 and 6 updated: the rule order now puts
escalation before merge, and the seed copies today's settings.

### 5. The dispatcher task (40m)
Rewrite the hourly prompt as stages A (watch) and B (dispatch); new `PROMPT VERSION`; schedule
row notes. Alex pastes the prompt into the task.

Files: docs/claude-hourly-notifications-task-prompt.md.
DB: `db:table:platform_schedules` (notes, via `create_platform_schedule` in chat or a data
migration), `db:table:claude_notification_settings` (stop reading; rows kept).

### Phase C — Senders and apps

### 6. started_by on reminders; notify-dispatch logs every pop (60m)
`reminders.started_by` with backfill; `create_reminder` requires it and refuses `task:*`;
`notify-dispatch` writes a `claude_notifications` row per reminder and step pop. Re-check
`verify_jwt = false` after the deploy.

Files: supabase/migrations/_pending_notification_routing-d7v_started_by.sql (then numbered),
supabase/tests/notification_routing-d7v/3_started_by_verify.sql,
supabase/functions/notify-dispatch/index.ts, reminders.ts +test.
DB: `db:table:reminders`, `db:table:claude_notifications`, `db:deploy`.

### 7. wb-sync raises signals (45m)
`raise_signal` on blocking errors, `resolve_signal` on ok; its open-item check goes. This step
also writes `resolve_signal` (function and tool), moved here from step 3.

Files: supabase/functions/wb-sync/index.ts, supabase/functions/_shared/wb-sync-core.ts +test.
DB: `db:table:signals`, `db:deploy`.

### 8. Overwatch and Arnold onto signals (50m)
Overwatch nightly and weekly raise signals instead of reminders; `pushes_per_day` and `push_time`
retired. Arnold morning review raises a signal only when it raised an item. Alex pastes three
prompts.

Files: docs/overwatch-nightly-task-prompt.md, docs/overwatch-weekly-task-prompt.md,
docs/arnold-morning-review-task-prompt.md, .claude/skills/overwatch/SKILL.md,
.claude/skills/arnold/SKILL.md.
DB: none.

### 9. The other apps (60m)
DJ daily and weekly, Ken seed check, SAM daily review, Drive Mix, then Money cleanup last. Alex
first pastes the live SAM daily review and Drive Mix prompts so they can be saved. Alex pastes six
prompts.

Files: docs/history/dj-daily-task-prompt.md, docs/history/dj-weekly-review-prompt.md,
docs/history/ken-seed-check-task-prompt.md, docs/sam-daily-review-task-prompt.md (new),
docs/drive-mix-daily-refresh-task-prompt.md (new), docs/wb-weekly-cleanup-task-prompt.md.
DB: none.
Waits on: docs/wb-weekly-cleanup-task-prompt.md (warren_buffet_p4-r6d).

### Phase D — Dispatcher screen

### 10. Dispatcher screen, read-only (75m)
`/overwatch/dispatcher`: Queued, Held, Delivered, Merged, History, Reminders, Step timers; a
Dispatcher row on the Overwatch tab.

Files: src/overwatch/DispatcherPage.jsx +test, src/overwatch/dispatcherModel.js +test,
src/overwatch/overwatchApi.js +test, src/overwatch/OverwatchPage.jsx +test, src/viewPaths.js +test.
DB: none.

### 11. Dispatcher actions (75m)
Hold, drop, deliver now on signals; edit and cancel reminders; reschedule and cancel step timers.
Confirmations are modals. `push-send` gains the `signal_id` mode. The `update_signal` tool (tier 2:
hold, drop, deliver now from chat) is written here too, moved from step 4: it needs
signals.ts, signals.test.mjs and mcp/index.ts in this step's scope.

Files: as step 10, plus src/utils/remindersApi.js, src/utils/notificationStepsApi.js,
supabase/functions/push-send/index.ts.
DB: `db:table:signals`, `db:deploy` (push-send).

### Phase E — Nightly review

### 12. Nightly checks on the dispatcher (60m)
`overwatch_nightly_counts` gains a `dispatcher` block; the nightly proposes rule changes and
raises an item directly when the dispatcher has stopped. Alex pastes the nightly prompt.

Files: supabase/migrations/_pending_notification_routing-d7v_nightly_dispatcher.sql (then
numbered), supabase/tests/notification_routing-d7v/4_nightly_dispatcher_verify.sql,
overwatch-nightly.ts +test, docs/overwatch-nightly-task-prompt.md, .claude/skills/overwatch/SKILL.md.
DB: `db:fn:overwatch_nightly_counts`, `db:deploy`.

### 13. Cutover and finish (30m)
Alex turns off the Claude app push on every scheduled task. End-to-end check: one signal of each
decision, one reminder, one step timer, each logged. Then `gitpush` Finish.

`started_by` becomes required here: `claude_notifications.started_by` not null (after checking no
null rows since step 3c), and required on `send_alfred_push` and `log_claude_notification`. Until
then it is nullable and optional, so the live hourly task keeps working.

Files: this file. DB: none.

## Timing log

| Step | Estimate | Actual | Notes |
|---|---|---|---|
| 1 | 10m | 3m 32s | plan |
| 2 | 25m | 2m 10s | claim, spec, progress |
| 3 | 35m | 1m 51s | stopped by the plan guard (SQL: none) |
| 3b | 35m | 3m 46s | migration, test, tools, tests |
| 4 | 8m | 10m 6s | dispatcher migration, test, tools, tests |
| 3c | 5m | not measured | stopped: Switchboard reinstall blocked every guard |
| 3d | 5m | see report | registration, index tests |
