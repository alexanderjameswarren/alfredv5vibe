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

### 3e. Resolve the gitsync conflict — DONE 2026-11-03 (`s3e-q7lf`)
Alex committed steps 3 and 4 locally (28b9d33). Then gitsync brought in 10 warren_buffet_p4-r6d
commits (finish merge fbf1039), and they conflicted in mcp/index.test.mjs on the tool count. Both
sides were kept: 193 tools, plus Warren Buffet's record_wb_subscription_review assertion.
index.ts auto-merged cleanly, with 193 registrations and no duplicates. Drift check: the only new
migration is 199_wb_subscription_reviews.sql, which touches none of signals,
claude_notifications, overwatch_plans, inbox or claude_notification_settings. Next free numbers:
200 and 201.

### 3f. Number and claim; queue 200 — IN PROGRESS 2026-11-03 (`s3f-c8wd`)
Merge done (eee47a0). 200 and 201 were still free: 200_signals.sql and 201_dispatcher.sql are
written, the pending files are deleted, and the ten db items are claimed. The queue refused 200
("may exceed the time limit"), because of `create index ... claude_notifications_signal` on an
existing table. **200 was run by hand** by Alex in the SQL editor, whole and index included
(`s3g`): CONFORMANT, 103 tables. Claude confirmed signals, started_by and signal_id on
claude_notifications, raise_signal and started_by_valid are live.

### 3g. Queue 201 — DONE 2026-11-03 (`s3g-n2rb`)
201_dispatcher.sql queued: action 7cca87fd-4d7f-4ca0-8b0c-5b8b93717c85. No `--expect`: its only
data change is the seed, which runs inside a do block and so reports no count. The describe says
1 plan version. **201 ran** through the queue: run e6715325-4572-4752-9609-87547bc0c0dd,
CONFORMANT. Claude confirmed one active Overwatch plan version carries the delivery section
(05:00-20:00, 3 pops an hour, no daily cap, no minimum gap).

### 3h. Queue test 1 — DONE 2026-11-03 (`s3h-t4mg`)
1_verify_signals.sql queued with `--test`: action 30ff5b45-9992-4cf7-8b2d-b68bd41420a8. Only one
approval link can be live per project, so 2_verify_dispatcher.sql is queued after it has run.
**Test 1 ran:** run e4254789-c151-4734-a883-489906992e42, ok true, 36 of 36 checks, none failed.

### 3i. Queue test 2 — DONE 2026-11-03 (`s3i-b6xr`)
2_verify_dispatcher.sql queued with `--test`: action 1458c614-12f7-494e-9cd8-2a9ca827df0c.
**Test 2 failed:** run 1cb79725-bbcc-4977-a000-f1677c6628ae, ok false, "column reference "i" is
ambiguous" (42702), at the first dispatch_signals call with delivery rules. The 25 checks before
it passed. **201's dispatch_signals had the bug:** two query aliases named `i` clashed with the
plpgsql loop variable `i` (generate_subscripts in bundling, inbox in merge), so it failed on
every run with rules. Nothing called it yet; mcp was not deployed.

### 3j. Fix dispatch_signals — DONE 2026-11-03 (`s3j-y3kc`)
202_dispatcher_fix.sql replaces dispatch_signals with the two aliases renamed (`gs(n)`, `ib`).
A diff against 201 shows no other change. Queued: action 71e8d796-f5ac-4435-8282-1870b84df788.
Test 2 reruns after 202, then deploy mcp, check_platform_conformance, Checkpoint (202 joins the
checkpoint paths). **202 ran** through the queue: run 5b6ade05-18dc-4b8e-88d8-15f68600c9e4,
CONFORMANT.

### 3k. Re-queue test 2 — DONE 2026-11-03 (`s3k-w9fh`)
2_verify_dispatcher.sql queued again with `--test`: action f83e9c3c-8d0b-45fa-807a-04601d16b8e8.
**Test 2 failed again:** run cddebd96-8165-40ad-b5ef-f39bf9c335d0, "malformed array literal: "same
subject as another signal delivered in this run"". **202 left this second bug:** the same-run
merge branch appended an untyped literal to the text[] `a_why`, which Postgres read as an array.

### 3l. Second dispatch_signals fix — DONE 2026-11-03 (`s3l-j5pd`)
203_dispatcher_fix_2.sql replaces dispatch_signals with that literal cast to `::text`. I scanned
every array append: the rest are typed (record fields, `null::uuid`, `null::text`, `false`, `0`,
`'...'::text`, `format()` and variables). A diff against 202 shows only that one line changed.
No local Supabase was running, so nothing was tested before queuing. Queued: action
e224ac17-a4bd-4f31-838f-c72e229e4335. Test 2 reruns after 203. **203 ran** through the queue:
run 61514e25-e242-4cb3-8169-f32a9365cfd6, CONFORMANT.

### 3m. Re-queue test 2 after 203 — DONE 2026-11-04 (`s3m-r7hq`)
2_verify_dispatcher.sql queued again with `--test`: action dbbe025f-45f6-4c9f-a2da-d6cfb3fd1982.
**Third run completed:** run 3a627e89-d1b9-43c5-b6ae-4159e84b18bf, 50 of 52 checks pass. Failed:
counts_pops_sent and hour_cap_urgent_waits.

### 3n. Diagnose the last two failures — DONE 2026-11-04 (`s3n-x6tb`)
The test was wrong, not the function. The spec counts pops by clock hour (section 5, `pace`).
The test pins its clock at exactly 10:00, but stamped its sample pop at 09:50, which is the
previous hour. So this_hour was 0 (counts_pops_sent), and the hourly cap of 1 still had room,
so the urgent signal popped instead of waiting (hour_cap_urgent_waits). The spec's rule 6 says
urgent waits at a cap, and the function does that. Fix: the sample pop is stamped at v_at. No 204.
Test 2 re-queued: action 7841cbdb-eaab-4788-bebc-af5cd569189f. **Fourth run passed:** run
f7ef704b-38c6-448f-b810-54554db5c562, ok true, 52 of 52.

### 3o. Deploy mcp — DONE 2026-11-04 (`s3o-k8vn`). STEPS 3 AND 4 DONE.
mcp/index.test.mjs passed 41 of 41. mcp was deployed as version 194, verify_jwt false.
check_platform_conformance came back CONFORMANT (103 tables). Migrations 200-203 are live.
Waiting on Alex: gitpush Checkpoint, which releases the ten db claims.

Order from here, one at a time: 200 approved → queue 201 → approved → queue tests 1 and 2 with
`--test` → deploy mcp → `check_platform_conformance` → Checkpoint (releases the db claims).

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

### 5. The dispatcher task — WRITTEN 2026-11-04 (`s5-g3mz`)
Steps 3 and 4 are checkpointed (main b3673a3) and the db claims are released.
docs/claude-hourly-notifications-task-prompt.md has been rewritten as the dispatcher, PROMPT
VERSION 2026-11-04a. Stage A watches each enabled watcher from get_delivery_rules and calls
raise_signal (started_by task:claude-hourly-notifications, a stable subject_key with no date, and
source_ref subject:date:hour). Stage B calls get_dispatch_plan, words only the pops, inbox items
and the digest, and calls deliver_signals; outside the window it delivers nothing. The run ends
with one line of counts. No Claude app push, no reminders.
**Alex, next:** paste it into the "Claude hourly notifications" task, turn off that task's Claude
app push, run it once by hand, and update the schedule row's notes in chat.
**LIVE 2026-11-04:** Claude updated the task to prompt 2026-11-04a and turned its Claude app push
off. Its first run (13:11) closed ok: it watched arnold and raised nothing. Alex chose no global
daily cap for now, so the delivery rules stay as seeded.

Original plan for this step (40m):
Rewrite the hourly prompt as stages A (watch) and B (dispatch); new `PROMPT VERSION`; schedule
row notes. Alex pastes the prompt into the task.

Files: docs/claude-hourly-notifications-task-prompt.md.
DB: none from the CLI. The schedule row's notes change in chat with `create_platform_schedule`.
claude_notification_settings stops being read; its rows stay.

Scope of this step:
- create: nothing
- update: docs/claude-hourly-notifications-task-prompt.md
- delete: nothing
- deploy: nothing
- SQL: none
Estimated run: 40m

### Phase C — Senders and apps

### 6. started_by on reminders; notify-dispatch logs every pop — WRITTEN 2026-11-04 (`s6-p4wc`)
- `_pending_notification_routing-d7v_started_by.sql`:
  - adds reminders.started_by and backfills it (alex where created_by is app, chat where it is claude), then sets it not null;
  - adds a check using started_by_valid;
  - adds a before-insert trigger that fills it from created_by, so the app and create_reminder() need no change.
- create_reminder takes an optional started_by, set on the new row after the RPC; chat and absent are left to the trigger. Its schema in mcp/index.ts has it.
- notify-dispatch now:
  - reads started_by and created_by;
  - logs every push in claude_notifications (sent, failed and no_subscription), as app alfred, job reminder or step_timer, kind info, channel alfred_push, with link = the tap target;
  - uses dedupe keys `reminder:<id>:<due_at>` and `step:<id>:<due_at>`, started_by from the reminder, and `alex` for step timers;
  - writes one upsert per run, ignoring duplicates. Logging never blocks a send.
- Test `3_started_by_verify.sql` written.
- Tests: reminders and mcp 55 of 55; `deno check` on notify-dispatch is clean.

### 6b. Number and queue 204 — DONE 2026-11-04 (`s6b-f8nt`)
Alex committed step 6 (ecac849) and ran gitsync: nothing came in but b3673a3, so there is no drift.
- **Cap check:** reminder and step-timer pushes do not count toward the caps or the gap. In
  dispatch_signals (203), a single query gives the hour count, the day count and the last pop
  time, and it filters `job not in ('reminder', 'step_timer')`. Those are exactly the jobs
  notify-dispatch now logs. Test 2's reminders_not_counted already inserts that row shape (app
  alfred, job reminder, alfred_push, sent). No fix was needed.
- 204_reminders_started_by.sql was written from the pending file, comments only changed.
- The pending file and notify-dispatch/deno.lock are deleted. deno.lock was claimed first,
  because it was unclaimed and the guard blocked the delete.
- Claimed db:table:reminders, db:table:claude_notifications and db:deploy.
- Queued 204 with `--expect unknown`: there are 46 reminders now, and more can be added before
  approval. Action 91c8e1ab-fbbd-4adc-a317-c9d959cb2bfe.

**204 ran** through the queue: run 17bc3b30-06e8-4f8e-afe3-0aadb779755b, CONFORMANT. Claude's
read-only role is refused on reminders, so test 3 is the check on the backfill.

### 6c. Queue test 3 — DONE 2026-11-04 (`s6c-h7dk`)
3_started_by_verify.sql queued with `--test`: action 2f2effc2-6e1a-4294-b5d0-ee23f4fd4c18.

**Test 3 ran:** run 66d7c410-f28d-4ce8-9835-14e6ca7f8a2a, ok true, 17 of 17.

### 6d. Deploy — DONE 2026-11-04 (`s6d-b2zy`). STEP 6 DONE.
reminders and mcp tests passed 55 of 55. `deno check --no-lock` on notify-dispatch was clean,
with no lock file left. notify-dispatch was deployed as v17 and mcp as v195, both with
verify_jwt false. check_platform_conformance came back CONFORMANT (103 tables). Waiting on
Alex: Checkpoint, which releases db:table:reminders, db:table:claude_notifications and
db:deploy.

Original plan for 6d (20m):
Order: 204 runs → queue test 3 with `--test` → deploy mcp and notify-dispatch, and re-check
notify-dispatch's verify_jwt is false → check_platform_conformance → Checkpoint.

Original 6b plan (30m):
In this order:
1. gitsync, drift check on reminders and claude_notifications, db claims.
2. Number the migration and queue it.
3. Run test 3 with `--test`.
4. Deploy mcp and notify-dispatch. Deploy them only after the migration, because both read reminders.started_by. Re-check notify-dispatch's verify_jwt is false after the deploy.
5. check_platform_conformance, then Checkpoint.

Scope of this step:
- create: supabase/migrations/<next>_reminders_started_by.sql
- update: nothing
- delete: supabase/migrations/_pending_notification_routing-d7v_started_by.sql
- deploy: mcp, notify-dispatch
- SQL: reminders, claude_notifications
Estimated run: 30m
DB: `db:table:reminders`, `db:table:claude_notifications`, `db:deploy`.

Original plan for step 6 (60m):
`reminders.started_by` with backfill; `create_reminder` requires it and refuses `task:*`;
`notify-dispatch` writes a `claude_notifications` row per reminder and step pop. Re-check
`verify_jwt = false` after the deploy.

Files: supabase/migrations/_pending_notification_routing-d7v_started_by.sql (then numbered),
supabase/tests/notification_routing-d7v/3_started_by_verify.sql,
supabase/functions/notify-dispatch/index.ts, reminders.ts +test.
DB: `db:table:reminders`, `db:table:claude_notifications`, `db:deploy`.

Scope of this step (write and test; numbering, queuing and deploys follow as 6b):
- create: supabase/migrations/_pending_notification_routing-d7v_started_by.sql, supabase/tests/notification_routing-d7v/3_started_by_verify.sql
- update: supabase/functions/notify-dispatch/index.ts, supabase/functions/_shared/tools/reminders.ts, supabase/functions/_shared/tools/reminders.test.mjs, supabase/functions/mcp/index.ts, supabase/functions/mcp/index.test.mjs
- delete: nothing
- deploy: nothing
- SQL: reminders, claude_notifications
Estimated run: 45m

**Step 6 verified live (2026-11-04):** step 6 is checkpointed. notify-dispatch v17 logged a test
reminder (job reminder, started_by chat) and a step timer (job step_timer, started_by alex).

### 7. wb-sync raises signals, resolve_signal, short links — WRITTEN 2026-11-04 (`s7-m3qe`)
- **`_pending_notification_routing-d7v_resolve_signal.sql`:** `resolve_signal(p_app, p_subject_key, p_started_by, p_user_id)`.
  - p_subject_key is a subject or a prefix of subjects (before a `:`).
  - Each matching subject with signals since its last resolved gets a `resolved` row, and its queued signals are dropped.
  - The service-role rule is the same as raise_signal's.
- **resolve_signal tool:** in signals.ts and registered in mcp/index.ts (194 tools).
- **wb-sync:**
  - It no longer writes inbox rows or checks open items.
  - Each distinct blocking error raises a signal: subject `wb-sync:failure:<hash>`, severity low (held first; the seeded escalation makes the second in a row an inbox item), started_by `task:wb-sync`, source_ref `wb-sync:<run>:<subject>`.
  - A fully ok, non-simulated run calls `resolve_signal(warren_buffet, wb-sync:failure)`. A partial run doesn't resolve, because a connection still needs attention.
  - `planAlerts` is gone, replaced by `signalParams` in wb-sync-core.
- **Short links:** notify-dispatch's tap target and log link are now `/<id>`: the execution for a step timer; the intention, else the inbox item, for a reminder.
  - The app's record route takes any UUID or app id, and recordRoutes opens an inbox row and an execution at their own screens.
  - Real ids all match the route.
  - An id that doesn't match keeps its page path. No bug to log.
- **Test** `4_resolve_signal_verify.sql`: two failures in a row escalate to inbox; a resolve drops the queued one and resets the count.
- **Tests:** signals and mcp 58 of 58, wb-sync-core 44 of 44. `deno check --no-lock` is clean for wb-sync and notify-dispatch.

### 7b. Escalation check, number and queue 205 — DONE 2026-11-04 (`s7b-w5ra`)
Alex committed step 7 (2ec2bff) and ran gitsync: only 1771236 came in, so there is no drift.
- **Check:** the seeded rule matches by prefix: dispatch_signals uses `starts_with(subject, key || ':')`. But the
  step 7 hash was not stable. It came from the raw message, with only case, spacing and digits normalised. A db
  failure's error text, a request id with letters in it, or a reworded message about the same bank would each give
  a new subject, so they would never escalate.
- **Fix (wb-sync-core.ts only; index.ts needed no change):** each alert now carries a stable `subject`.
  - A failed run: `kind:<failure kind>`.
  - A SimpleFIN error that names a bank: `bank:<bank slug>`.
  - Otherwise: `msg:<hash>`.
  The signal's subject is `wb-sync:failure:<subject>`, still under the prefix, so no rule change was needed. Two
  errors about one bank in one run raise one signal. New tests: 46 of 46. `deno check --no-lock` on wb-sync is clean.
  Test 4 gains a check that two different messages for the same failure escalate to inbox.
- 205_resolve_signal.sql was written from the pending file (its code is identical; only comments changed), and the
  pending file is deleted.
- Claimed 205, db:table:signals, db:fn:resolve_signal and db:deploy.
- Queued 205: action 62f43512-d86c-4168-ad7f-f63a95ce376a.

Order from here: 205 runs → test 4 with `--test` → deploy mcp → deploy wb-sync and notify-dispatch (re-check
verify_jwt) → check_platform_conformance → Checkpoint.
**205 ran** through the queue: run 56b6082c-9c4c-4ac7-b737-df131012f7a9, CONFORMANT.

### 7c. Queue test 4 — DONE 2026-11-04 (`s7c-k9tv`)
4_resolve_signal_verify.sql queued with `--test`: action 204f336b-629d-4dfb-b853-3addc3907bbd.
**Test 4 ran:** run 0a87030c-d58a-416c-933d-87de540e556c, ok true, 15 of 15.

### 7d/7e. Deploy — DONE 2026-11-04 (`s7d-r6pm` blocked, `s7e-t2hw`). STEP 7 DONE.
In 7d, the plan guard refused a single deploy loop: it read the function name as `$f`. Nothing
deployed then; the tests (104 of 104) and deno checks passed. In 7e the deploys ran one command
each:
- mcp **v196**
- wb-sync **v15**
- notify-dispatch **v18**

All three have verify_jwt false. check_platform_conformance came back CONFORMANT (103 tables).
wb-sync now raises signals and resolves them on an ok run, and notify-dispatch links are /<id>.
Waiting on Alex: Checkpoint, which releases db:table:signals, db:fn:resolve_signal and db:deploy.

Original 7b plan (30m):
In this order:
1. gitsync and drift check on signals.
2. Claim db:table:signals, db:fn:resolve_signal and db:deploy.
3. Number the migration and queue it.
4. Run test 4 with `--test`.
5. Deploy mcp, wb-sync and notify-dispatch. wb-sync needs resolve_signal live first. Re-check verify_jwt is false on wb-sync and notify-dispatch after deploying.
6. check_platform_conformance, then Checkpoint.

Scope of this step:
- create: supabase/migrations/<next>_resolve_signal.sql
- update: docs/progress-notification_routing-d7v.md
- delete: supabase/migrations/_pending_notification_routing-d7v_resolve_signal.sql
- deploy: nothing
- SQL: signals
Estimated run: 10m
(Queuing test 4 and the three deploys follow as their own steps, as in 6c and 6d.)

Original plan for step 7 (45m):
`raise_signal` on blocking errors, `resolve_signal` on ok; its open-item check goes. This step
also writes `resolve_signal` (function and tool), moved here from step 3.

Files: supabase/functions/wb-sync/index.ts, supabase/functions/_shared/wb-sync-core.ts +test.
DB: `db:table:signals`, `db:deploy`.

Scope of this step (write and test; numbering, queuing and deploys follow as 7b):
- create: supabase/migrations/_pending_notification_routing-d7v_resolve_signal.sql, supabase/tests/notification_routing-d7v/4_resolve_signal_verify.sql
- update: supabase/functions/wb-sync/index.ts, supabase/functions/_shared/wb-sync-core.ts, supabase/functions/_shared/wb-sync-core.test.mjs, supabase/functions/_shared/tools/signals.ts, supabase/functions/_shared/tools/signals.test.mjs, supabase/functions/mcp/index.ts, supabase/functions/mcp/index.test.mjs
- delete: nothing
- deploy: nothing
- SQL: signals
Estimated run: 45m

### 8. Overwatch and Arnold onto signals — WRITTEN 2026-11-04 (`s8-n6ya`)
Step 7 is checkpointed (main b4ed482).
- **Prompts at 2026-11-04a:**
  - Overwatch nightly and weekly raise one signal per inbox item they make, with started_by
    task:overwatch-nightly or task:overwatch-weekly, a stable subject key, severity by
    importance, link `/<inbox id>`, and `details.inbox_id`. Their own pushes_per_day counting is
    gone, and create_reminder, send_alfred_push and log_claude_notification are on their
    never-call lists.
  - Arnold morning review raises one signal for its review item (normal,
    `arnold:review:<template>`), not log_claude_notification. It dedupes over 7 days with
    get_signals, and ends with one log line; it has no Claude push.
- **Skills:** overwatch and arnold updated (versions 2026-11-04a).
- **Must ship first (8b):** deliver_signals has to honour `details.inbox_id`. Today an inbox
  decision makes a new item, and so does a pop unless an open item already shares the subject.
  So a task that writes its own item and also raises a signal would get a duplicate.
  Fix, in signals.ts and its test only, then a mcp deploy:
  - when a signal's `details.inbox_id` names an item, an inbox decision marks it delivered
    against that item;
  - a pop points at that item and adds a repeat;
  - neither makes a new item.
- **Alex, next:** agree; then 8b ships. After that, Claude updates the three scheduled tasks
  with the new prompts and turns off Arnold morning review's Claude app push.

### 8b. deliver_signals uses the task's own inbox item — DONE 2026-11-04 (`s8b-c4lu`)
When a signal's `details.inbox_id` names an item the caller can see (one read through ctx.db,
where RLS hides other users' items):
- an inbox decision marks the signal delivered against that item, with no new item, and logs
  it with `own_item: true`;
- a pop links to `/<that id>`, records the repeat on the item, and makes no new item.

An id that is missing or not the caller's falls back to a new item, and the signal's reason says
why. A signal without an inbox_id is unchanged and does no lookup. Tests: signals and mcp,
62 of 62. mcp was deployed as **v197**, verify_jwt false. check_platform_conformance came back
CONFORMANT (103 tables). db:deploy was released after the deploy: this step ends with gitcom,
not Checkpoint.
**Next:** Claude updates the three scheduled tasks (Overwatch nightly, Overwatch weekly, Arnold
morning review) with the 2026-11-04a prompts, and turns off Arnold morning review's Claude app
push.

Original plan for step 8 (50m):
Overwatch nightly and weekly raise signals instead of reminders; `pushes_per_day` and `push_time`
retired. Arnold morning review raises a signal only when it raised an item. Alex pastes three
prompts.

Files: docs/overwatch-nightly-task-prompt.md, docs/overwatch-weekly-task-prompt.md,
docs/arnold-morning-review-task-prompt.md, .claude/skills/overwatch/SKILL.md,
.claude/skills/arnold/SKILL.md.
DB: none.

Scope of this step:
- create: nothing
- update: docs/overwatch-nightly-task-prompt.md, docs/overwatch-weekly-task-prompt.md, docs/arnold-morning-review-task-prompt.md, .claude/skills/overwatch/SKILL.md, .claude/skills/arnold/SKILL.md, docs/progress-notification_routing-d7v.md
- delete: nothing
- deploy: nothing
- SQL: none
Estimated run: 50m

### 9. The other apps (60m)
DJ daily and weekly, Ken seed check, SAM daily review, Drive Mix, then Money cleanup last. Alex
first pastes the live SAM daily review and Drive Mix prompts so they can be saved. Alex pastes six
prompts.

Files: docs/history/dj-daily-task-prompt.md, docs/history/dj-weekly-review-prompt.md,
docs/history/ken-seed-check-task-prompt.md, docs/sam-daily-review-task-prompt.md (new),
docs/drive-mix-daily-refresh-task-prompt.md (new), docs/wb-weekly-cleanup-task-prompt.md.
DB: none.
Waits on: docs/wb-weekly-cleanup-task-prompt.md (warren_buffet_p4-r6d). Claimed in 9b.

#### 9 part 1. Which repo copies match what is live — DONE 2026-11-05 (`s9-q2vd`)
Read only. Repo versions: Money cleanup 2026-11-03a, DJ daily 2026-10-06a, Ken seed check
2026-09-25a, DJ weekly has no version line. SAM and Drive Mix had no repo copy.

#### 9 part 2. Snapshot three live prompts — DONE 2026-11-05 (`s9b-m3kx`)
Copied byte for byte from the inbox items Claude made from the live tasks (md5 checked against
the database), then archived those items as processed:
- docs/sam-daily-review-task-prompt.md (new): trigger `trig_01AGKP3tNa7ivX18YTYgx8id`. Its
  version line says 2026-09-19a, and its report template still prints 2026-09-17b. Left as live.
- docs/drive-mix-daily-refresh-task-prompt.md (new): trigger `trig_01M9atR63BYAAJx73rWM4Kxj`.
  No version line.
- docs/history/dj-daily-task-prompt.md: prompt replaced with live 2026-10-13a (trigger
  `trig_01EEaPPhygaPeybVvitpTq8k`); header version note updated. Header schedule text still says
  4:30, and the schedule row says 3:30.

Next: Alex runs gitcom. Then part 3 edits all six prompts onto signals: Money cleanup from repo
version 2026-11-03a, Ken seed check from repo version 2026-09-25a, and the other four from
these snapshots (DJ weekly from the repo copy).

Scope of part 3:
- create: nothing
- update: docs/wb-weekly-cleanup-task-prompt.md, docs/history/dj-daily-task-prompt.md, docs/history/dj-weekly-review-prompt.md, docs/history/ken-seed-check-task-prompt.md, docs/sam-daily-review-task-prompt.md, docs/drive-mix-daily-refresh-task-prompt.md, docs/progress-notification_routing-d7v.md
- delete: nothing
- deploy: nothing
- SQL: none

#### 9 part 3. Six prompts onto signals — DONE 2026-11-05 (`s9c-w7rd`)
All six are at 2026-11-05a. Each has a never-notify rule, and each inbox item is followed by one
`raise_signal` (started_by `task:<slug>`; high for a failure item, normal otherwise; details
`inbox_id`, kind flag, or info for the DJ weekly report; source_ref `<subject_key>:<date>`).
Money, Drive Mix and the DJ weekly record `signal_id` in the run details. SAM, DJ daily and Ken
failure items are made after the close, which accepts only `notified_at`, so their `signal_id` goes
in the report. The DJ daily header schedule is now 3:30. App ids and started_by values were checked
against raise_signal and started_by_valid: all accepted.

Next: Alex runs gitcom. Then Claude updates the six scheduled tasks from these files, and turns
off each one's Claude app push.

#### 9 part 4. Hand Claude the six prompts — DONE 2026-11-05 (`s9d-h4tn`)
The files matched main (b4dbb64). Each prompt's text below THE PROMPT (the whole file for the
DJ weekly review, which has no marker) is in an Overwatch task inbox item, and its md5 is checked
against the file: Money cleanup 50c8adbc, Daily DJ 183b7006, Weekly DJ review 2ecf2915, Ken seed
check 1a0bab33, SAM Daily Review 5a65ed8d, Drive Mix daily refresh fe022f90. They are left
unarchived. Next: Claude updates the six tasks and archives each item once its task is updated.

#### 9 part 5. Restore source_app on Ken and DJ weekly items — DONE 2026-11-05 (`s9e-p6jc`)
The Ken seed check nudge and failure item get `source_app: "ken"`; the Weekly DJ review item gets
`source_app: "dj"`. Both prompts are at 2026-11-05b. New inbox items, md5 checked: Ken seed check
e0cd30d4, Weekly DJ review 231898d0 (they replace the 05a items 1a0bab33 and 2ecf2915).
Next: Claude updates those two tasks. Then Alex checkpoints the two prompt files and this file
to main.

### Phase D — Dispatcher screen

### 10. Dispatcher screen, read-only (75m) — WRITTEN 2026-11-05 (`s10-v3qa`)
`/overwatch/dispatcher`: Queued, Held, Delivered, Merged, History, Reminders, Step timers; a
Dispatcher row on the Overwatch tab.

Files: src/overwatch/DispatcherPage.jsx +test, src/overwatch/dispatcherModel.js +test,
src/overwatch/overwatchApi.js +test, src/overwatch/OverwatchPage.jsx +test, src/viewPaths.js +test.
DB: none.

Done:
- `OVERWATCH_DISPATCHER_PATH` is `/overwatch/dispatcher`, served by OverwatchPage.
- The Dispatcher row sits under the status line and has its own read (`getDispatcherSummary`: head counts of queued and held signals, and alfred_push rows for the Pacific day). If it fails, the row says "Summary unavailable" and the rest of the tab still loads.
- `getDispatcher` reads the following, all through owner RLS, with no writes and no RPC:
  - signals in queued, held, delivered and merged (newest 200);
  - claude_notifications (newest 100);
  - scheduled reminders;
  - step timers that are scheduled or waiting;
  - the active plan's settings.delivery;
  - app names.
- `dispatcherModel.js` holds the plain-words rules, the inside-the-window check (end exclusive), Pacific times, and the rows. Each row's title links to `/<id>`, and a second link opens the inbox item (the inbox_id column, else details.inbox_id), the notification's own link, the reminder's target, or the step's execution.
- Dropped and resolved signals are not shown.
- Queued and Held start open; the other sections start collapsed.
- The only buttons are the section toggles.

Tests: the affected files pass 188/188; the full suite passes 3224, with 7 skipped; scripts pass 54/54.

#### 10b. Rework after Alex's review — WRITTEN 2026-11-05 (`s10b-k8wf`)
The sections are now Queued, "Unprocessed – next run <time>", Held and History.
- **Queued:** scheduled reminders, plus step timers with a due_at, soonest first. A step's title is its execution's name (the intention text, else the group's, else the first item's), and it links to the execution page.
- **Unprocessed:** signals still queued. The next run is the next top of the hour from 5 AM to 7 PM Pacific, else "tomorrow 5:00 AM".
- **History:** sent rows from claude_notifications ("Sent <time>", how, who started it) and merged signals ("Not sent: an item already exists in the Inbox", with the inbox link), newest first. A send with a signal_id gets a coloured edge, a bell, and "Dispatcher: <the signal's reason>".

Other changes:
- Times are 12-hour everywhere, and every label says "notification" or "notify", never "pop".
- The tab line reads "N queued · N unprocessed · N held · N notifications today".
- The page heading uses the BellRing icon, as the tab row does.
- Overlap fix: the rows' `relative z-10` links stacked above the app's sticky header (`z-10`, src/shared/AppChrome.jsx:63 and :180). The page root now has `isolate`. PlanPage and the other Overwatch screens use the same pattern and were not changed.

Tests: the affected files pass 190/190; the full suite passes 3226, with 7 skipped; scripts pass 54/54.

#### 10c. Round 2 after Alex's review — WRITTEN 2026-11-05 (`s10c-r2hy`)
- The Dispatcher icon is Radio on the tab row and the page heading; BellRing is gone from both.
- Every card is one link, and all the "Open …" lines are gone. A card opens:
  - its inbox item, if it has one;
  - otherwise what a reminder is for, the execution for a step, or the signal (for a sent row with no link, its log row).
- Each card starts with one icon:
  - BellRing: sent, or will be sent, as a notification;
  - Inbox: sent as an inbox item;
  - Ban: held, or not sent;
  - Hourglass: unprocessed.
- The coloured left bar is gone.
- Held cards read "Held", then "Dispatcher: <reason>".
- Merged cards read "Not sent", then "Dispatcher: an item already exists in the Inbox".
- "Dispatcher: <reason>" shows only when there is a reason. A stored "pop" or "pops" displays as "notification" or "notifications" (`reasonWords` in dispatcherModel.js). Stored data is unchanged.

Tests: the affected Overwatch files pass 114/114. The full suite's first run had 1 failure, which I didn't capture; the two reruns passed 3227 with 7 skipped. Scripts pass 54/54.

#### 10d. History paged — WRITTEN 2026-11-05 (`s10d-n5tq`)
- History shows the newest 50 cards (sent rows and merged signals together). Its heading reads "History (N shown)".
- "Show older" loads the next 50 and appends them, and is hidden when nothing older is left.
- `getDispatcherHistory(before)` pages in the read itself:
  - It reads claude_notifications and merged signals, each by `created_at desc, id desc`, past the cursor `{at, id}` (the oldest card shown), 51 rows each.
  - It merges them and keeps the 50 newest. The extra row says whether there is more.
  - It reads the reasons for the page's sent rows by signal id.
  - The first page comes with getDispatcher. The signals read there is now queued and held only.
- Merged cards now sort and show on created_at, not decided_at, which can be null.
- `timeKey` compares to the microsecond whatever fraction width PostgREST returns, so rows with the same time break on id, the same as the database.
- The API test pages 130 rows with groups of six on one instant through a fake store, and checks that every card appears exactly once and in order.
- Live now: 27 sent rows and 14 merged signals, 41 cards, so Show older does not appear yet.

Tests: the Overwatch files pass 118/118. The full suite ran twice, and both runs passed 3231 with 7 skipped and no failures. Scripts pass 54/54.

Next: step 10e, the High and Urgent limit change (a migration to dispatch_signals plus its test), then step 11.

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

`create_reminder` changes here too: started_by becomes required, and `task:*` callers are refused (decision 3). It
stays optional until then, because the Overwatch nightly and weekly prompts still call
create_reminder until step 8 moves them to signals.

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
| 3d | 5m | 1m 44s | registration, index tests |
| 3e | 5m | 42s | gitsync conflict in index.test.mjs |
| 3f | 5m | 3m 6s | numbered 200/201, db claims; queue refused 200 (index) |
| 3g | 5m | 8s | queued 201 (200 run by hand) |
| 3h | 5m | 7s | queued test 1 |
| 3i | 5m | 8s | queued test 2 |
| 3j | 5m | 1m 5s | 202: ambiguous alias i |
| 3k | 5m | 16s | re-queued test 2 |
| 3l | 5m | 1m 11s | 203: untyped literal into text[] |
| 3m | 5m | 15s | re-queued test 2 |
| 3n | 10m | 18s | test fix: sample pop in the wrong clock hour |
| 3o | 10m | 1m 15s | mcp deploy, conformance |
| 5 | 8m | 52s | dispatcher prompt |
| 6 | 10m | 2m 56s | reminders started_by, notify-dispatch logging |
| 6b | 10m | 1m 28s | cap check, numbered and queued 204 |
| 6c | 5m | 7s | queued test 3 |
| 6d | 10m | 1m 22s | deploy notify-dispatch and mcp, conformance |
| 7 | 10m | 4m 54s | resolve_signal, wb-sync signals, short links |
| 7b | 10m | 1m 36s | stable wb-sync subjects, numbered and queued 205 |
| 7c | 5m | 8s | queued test 4 |
| 7d | 10m | 17s | blocked by the plan guard (deploy loop) |
| 7e | 10m | 1m 13s | three deploys, conformance |
| 8 | 10m | 3m 45s | Overwatch and Arnold prompts and skills onto signals |
| 8b | 10m | 1m 58s | deliver_signals uses the task's own item; mcp v197 |
| 9 | 3m | 10s | which repo prompts are stale (read only) |
| 9b | 8m | 3m 32s | snapshot SAM, Drive Mix and DJ daily live prompts |
| 9c | 25m | 4m 37s | six prompts onto signals, 2026-11-05a |
| 9d | 5m | 5m 46s | six prompts into inbox items for Claude, md5 checked |
| 9e | 5m | 2m 44s | source_app back on Ken and DJ weekly items, 2026-11-05b |
| 10 | 75m | 6m 16s | read-only Dispatcher screen and tab row |
| 10b | 15m | 3m 41s | sections reworked, plain words, 12-hour times, header overlap |
| 10c | 10m | 4m 34s | whole-card links, one icon per card, Radio icon, reasons without "pop" |
| 10d | 10m | 4m 30s | History paged 50 at a time with a cursor, Show older |
