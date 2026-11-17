# Job health — technical spec

Project code: `job_health-t4m`. Progress: `docs/progress-job_health-t4m.md`.
Written 2026-11-16 (s2), from the s1 plan (run tag `job_health-t4m-s1-q8vd`), which Alex approved together with every recommendation in its section 6.

## 1. Why

- **Silent hangs.** On Nov 16 the 5:00 AM Pacific wb-sync run (`platform_runs` id `f847a5cd-156f-42cd-b4be-84a53cacea2b`) stayed `running` with `details {}`: no failure, no signal, nothing noticed.
- **A silent outage.** Every alert goes through Claude's hourly dispatcher, a Claude scheduled task. If Claude, or Claude's connection to Alfred, breaks (it has before), nothing tells Alex.
- **Too many notifications.** The Overwatch weekly sends phone notifications for things with no time pressure.

## 2. What exists today (from s1)

- **wb-sync** (`supabase/functions/wb-sync/index.ts`), fired at 13:00 UTC by pg_cron `wb-sync-daily` through `net.http_post` (timeout 120 s). It opens its run first, then calls `fetchSimplefin`. That `fetch` (line 79) has **no timeout**. Ok runs take 89 s (p50), 116 s (p95), 125 s (max). Its failures raise `raise_signal` with subject `wb-sync:failure:kind:<kind>` (or `:bank:<slug>`, `:msg:<hash>`), severity `low`, `started_by: "task:wb-sync"`, and an ok run resolves the prefix `wb-sync:failure`.
- **notify-dispatch** (pg_cron `notify-dispatch-every-minute`, service role) sends web push for due `notification_steps` and due `reminders` (`state = 'scheduled'`, `due_at <= now()`), and logs each push to `claude_notifications`. It writes no `platform_runs` rows.
- **Other pg_cron jobs:** `switchboard-prune-runs`, `switchboard-prune-sf-results`.
- **`raise_signal`** accepts `p_user_id` only when `current_user = 'service_role'`; otherwise it needs `auth.uid()`. Under pg_cron, `current_user` is `postgres` and `auth.uid()` is null, so it refuses.
- **`platform_schedules`** has 13 rows. Its cadence is `daily` or `weekly` only, with `expected_by` (Pacific), `grace_hours` and `day_of_week` (0 = Sunday).
- **Claude-executor heartbeat.** The hourly dispatcher (`alfred/claude_hourly_notifications`) runs at about :09 past each hour, first about 5:09 and last 19:09. `inbox_enrich_hourly` runs hourly from 5 AM to 9 PM. On Nov 13 the dispatcher's first run was 7:09.

## 3. Part A — Weekly prompt severity (first build step, checkpointed on its own)

In `docs/overwatch-weekly-task-prompt.md` Step 9:
- the general severity line (`"high"` for a plan change) becomes `"normal"` for a plan change;
- item 6, direct writes, changes `severity: "high"` to `severity: "normal"`;
- PROMPT VERSION becomes `2026-11-16a`, with the change note "plan_change and direct_writes are severity normal (inbox), not high." It appears in the header block, the prompt's first line, Step 10's `prompt_version` and Step 11's report line, and in the setup step's check line.

Neither the task-prompts skill nor the overwatch skill has a rule requiring `high` for these (task-prompts says `high` is for what should reach Alex now). Neither skill changes in this part. After the change, the text is handed over so Alex pastes it into the task.

## 4. New `platform_schedules` columns (s5)

| column | type | meaning |
|---|---|---|
| `hourly_until` | `time`, null | When set, the job is expected every hour from `expected_by` to `hourly_until` (Pacific), not just once a day. |
| `max_run_minutes` | `int`, null, > 0 | A run still `running` after this long is stuck. Null means the job is not swept. |
| `catch_up` | `text`, null, `self` \| `skip` \| `run_now` | What to do about a missed run. Null means the job is not checked for missed runs. |
| `failure_subject` | `text`, null | The job's own failure subject key. `{kind}` is replaced by the failure kind (`stuck`). The result must match the signals subject format. |
| `failure_severity` | `text`, null, `low` \| `normal` \| `high` \| `urgent` | The severity the job uses for its own failures. |
| `started_by` | `text`, null, `started_by_valid()` | The job's `started_by`. |

How `max_run_minutes` was set: three times the p95 of the last 30 days' ok and partial runs, rounded up to 10, 15, 20 or 30, and never under 10.

### Values per schedule

| app / job | executor | hourly_until | max_run_minutes (p95) | catch_up | failure_subject | severity | started_by |
|---|---|---|---|---|---|---|---|
| alfred / claude_hourly_notifications | claude | 19:00 | 10 (41 s) | skip | `alfred:claude_hourly_notifications:failure:{kind}` (new: the dispatcher raises none itself) | high | `task:claude-hourly-notifications` |
| alfred / inbox_enrich_hourly | claude | 21:00 | 10 (31 s) | self | `alfred:inbox_enrich_hourly:failure:{kind}` | high | `task:hourly-inbox-enrichment` |
| alfred / notify-dispatch | alfred | — | null (writes no runs) | null | null | null | null |
| arnold / arnold_morning_review | claude | — | 10 (31 s) | skip | `arnold:arnold_morning_review:failure` | high | `task:arnold-morning-review` |
| dj / daily_history_sync | claude | — | 15 (46 s) | run_now | `dj:daily_history_sync:failure:{kind}` | high | `task:dj-daily` |
| dj / weekly_review | claude | — | 20 (120 s) | run_now | `dj:weekly_review:failure` | high | `task:dj-weekly-review` |
| drive_mix / daily_refresh | claude | — | 20 (141 s) | self | `drive_mix:daily_refresh:failure:{kind}` | high | `task:drive-mix-daily-refresh` |
| ken / ken_seed_check | claude | — | 10 (19 s) | self | `ken:ken_seed_check:failure:{kind}` | high | `task:ken-seed-check` |
| overwatch / nightly | claude | — | 30 (520 s) | self | `overwatch:nightly:failure:{kind}` | high | `task:overwatch-nightly` |
| overwatch / weekly | claude | — | 30 (527 s) | run_now | `overwatch:weekly:failure:{kind}` | high | `task:overwatch-weekly` |
| sam / daily_plan_review | claude | — | 15 (74 s) | self | `sam:daily_plan_review:failure:{kind}` | high | `task:sam-daily-review` |
| warren_buffet / wb_weekly_cleanup | claude | — | 20 (105 s) | self | `warren_buffet:wb_weekly_cleanup:failure:{kind}` | high | `task:money-cleanup` |
| warren_buffet / wb-sync | alfred | — | 10 (116 s; the Edge wall clock ends a run long before 10 min anyway) | self | `wb-sync:failure:kind:{kind}` | low | `task:wb-sync` |
| alfred / job_health_check (new, Part D) | claude | — | 10 | skip | null (the task alerts through its own notification) | null | `task:job-health-check` |

Before s5 is queued, each subject is checked against its prompt file again (the drift check). The DJ daily, DJ weekly and Ken prompts live in `docs/history/`.

**DJ daily is `run_now`** because the play-history read only reaches back so far: plays from a missed day can be lost if the next run waits a day. The new `job_health_check` row: `cadence daily`, `expected_by 06:00`, `grace_hours 2` (it only checks the day's first run). The s5 migration inserts it.

## 5. Part B — Stuck runs

### 5.1 The sweep (inside the watchdog tick, §6)

For each `platform_runs` row with `status = 'running'` whose schedule (same `user_id`, `app`, `job`) has a `max_run_minutes`, and that has run longer than that:
- **Update the row:** `status 'failed'`, `finished_at now()`, `error_message` = `Stuck: still running after <N> min (limit <max> min). Marked failed by the job-health watchdog.`, and `details || {"failure_kind": "stuck", "swept_by": "job_health_watchdog", "ran_minutes": <N>, "max_run_minutes": <max>}`. The update matches `status = 'running'` too, so a run that closes at the same moment is left alone.
- **Raise the job's normal failure signal**, but only when the run started in the last 24 hours. Older stuck rows, today's f847a5cd included once it is more than a day old when the sweep first runs, are marked failed with no signal. The signal is a **direct insert into `signals`** with the same columns and conflict rule `raise_signal` uses (`on conflict (user_id, source_ref) do nothing`). `raise_signal` is not changed. Its fields:
  - `app`, `job` from the run;
  - `severity` = `failure_severity`;
  - `subject_key` = `failure_subject` with `{kind}` → `stuck`;
  - `started_by` = the schedule's `started_by`;
  - `title` = `<job> stuck: marked failed after <N> min`;
  - `body` = the fix-needed text (§9.3);
  - `source_ref` = `job_health:stuck:<run id>`;
  - `details` = `{"kind": "failure", "run_id", "failure_kind": "stuck", "item": {"captured_text": <the fix-needed text>, "source_app": <app>, "source_metadata": {"task_name": <title>, "run_date": <Pacific date>, "kind": "failure"}}}`.

  So the dispatcher's escalation rules apply exactly as for the job's own failures: wb-sync's first stuck run is held (low), and a Claude task's goes out as high.
- A stuck run of a job with **no schedule row, or a null `max_run_minutes`**, is not swept.
- **A stuck dispatcher run** (`claude_hourly_notifications`) gets its signal like the rest. It also gets a direct inbox item and a reminder, in fix-needed wording (§9.3), because the dispatcher cannot deliver news about itself. This is the one other direct write, and it is the watchdog's, not a task's.
- A wb-sync stuck signal is resolved by wb-sync's next ok run, as its other failures are (prefix `wb-sync:failure`).

### 5.2 The wb-sync fix (s4)

Built at s4:
- **Fetch timeout.** `core.withTimeout` gives `fetchSimplefin` an AbortController signal and races it against a timer, so a body read that ignores the signal still cannot outlast the limit. On a timeout it throws `RunFailure("SimpleFIN did not answer within <n> s.", "failed", "timeout")`. The run closes `failed` with kind `timeout` and raises `wb-sync:failure:kind:timeout`, severity low, through the normal path. The limit is `core.FETCH_TIMEOUT_MS`.
- **Time budget.** `core.TIME_BUDGET_MS` = 120 000, timed from the start of the request. Before each stage (fetch, accounts, balances, holdings, transactions, pending, unprocessed, each processing chunk, detection), a stage that would start after 120 s throws `RunFailure(<"Stopped before stage "<name>" at <t> s: past the 120 s time budget …">, "failed", "time_budget")`. That leaves 30 s of the 150 s wall clock to close the run and raise `wb-sync:failure:kind:time-budget`.
- **Stage log.** Every stage logs `[wb-sync] stage=<name> t=<seconds>s`, including `last_run` before the run opens and `close` / `close_failed kind=<kind>` at the end.

**The fetch limit (O5, settled s4b).** `FETCH_TIMEOUT_MS` = 105 000. The 60 s first asked for would have failed nearly every day, because SimpleFIN alone takes most of a normal run.

**The window cap (s4b).** The start is still 10 days before the last ok run (its `started_at`, whose local date is its `covered_to`), and never more than 89 days back. `core.chooseWindow` now also caps it at `WINDOW_MAX_DAYS` = 14 days before now, so a run of failures cannot widen the fetch. When the cap cuts it, the dates not fetched go into the run's `details.window_gap` as `{ from, to }` (local dates; `to` is the cap's day, which is partly fetched), on ok and failed closes alike, and the log line `[wb-sync] window_gap from=… to=… (not fetched)` is written. A run with no earlier ok run also fetches 14 days and records the rest of the 89 as a gap. Nothing fills a recorded gap yet. **Filling it is a later item** (for example a one-off run with an explicit window, or a fill step after an ok run).

Deployed at s4b: wb-sync version 17, 2026-11-17 08:05 Pacific.

## 6. Part C — The Alfred watchdog

A SQL function, `public.job_health_watchdog()`, `security definer`, owned by postgres, with `search_path` pinned. pg_cron job `job-health-every-15-min`, `*/15 * * * *`, runs `select public.job_health_watchdog()`. It makes no HTTP call and holds no secret, so it is queued like any migration (open item O3). Execute is revoked from `public`, `anon` and `authenticated`, so only cron and postgres run it.

Each tick, for each user with `platform_schedules` rows, each part in its own `begin … exception` so one failure doesn't stop the others:
1. **Sweep stuck runs** (§5.1).
2. **Heartbeat.** All in Pacific time:
   - `last_claude` = the newest `started_at` of any run with `executor = 'claude'`;
   - `anchor` = the later of `last_claude` and today 05:15;
   - **Open an outage** when no outage is open, the time is between 05:00 and 20:00, and more than 2 hours have passed since `anchor`. Set `outage_since = anchor`, write the outage inbox item and a reminder (§9.2). One alert per outage.
   - **Recover** when an outage is open and `last_claude > outage_since`. Compute the missed runs between `outage_since` and now (§7), write ONE recovery inbox item listing them and one reminder (§9.2), and close the outage. Recovery can happen at any hour; a new outage only opens inside the window.
3. **State.** Write `last_tick_at`, the counts and any part's error to `job_health_state`.

**Alfred push.** The watchdog inserts a `reminders` row: `due_at now()`, `state 'scheduled'`, `created_by 'app'`, `started_by 'task:job-health-watchdog'`, `inbox_id` = the item it just wrote, `text` = the short push line. notify-dispatch sends it within a minute, the same way it sends every reminder, and logs it. It needs no new edge function and no secret.

**Inbox items** are direct inserts into `inbox`: `source_type 'manual'`, `source_app 'overwatch'`, `ai_status 'complete'`, so the enrichment job leaves them alone. `source_metadata {task_name, run_date, kind: "job_health"}`. The id uses the inbox's own id format, with the generator chosen at s6 from the existing SQL that writes inbox rows.

### 6.1 `job_health_state` (new table, one row per user)

| column | type | |
|---|---|---|
| `user_id` | uuid, primary key | |
| `last_tick_at` | timestamptz | the watchdog's last run |
| `last_tick_error` | text, null | the last part that failed, verbatim |
| `outage_since` | timestamptz, null | open outage: the anchor time |
| `outage_alerted_at` | timestamptz, null | |
| `outage_inbox_id` | text, null | |
| `last_recovered_at` | timestamptz, null | |
| `last_outage_since` | timestamptz, null | the last closed outage's start, for the chat flow |
| `last_sweep` | jsonb | `{at, swept, signalled}` |
| `updated_at` | timestamptz | |

Registered with `platform.register_table('public.job_health_state')` (audited false, since it is written every 15 minutes). Grants come from `register_table`, and anon gets nothing.

## 7. Part E — Missed runs and recovery

`public.job_health_missed_runs(p_user uuid, p_from timestamptz, p_to timestamptz)` returns a set of `(app, job, executor, expected_at, catch_up)`, for schedules with `enabled` and a non-null `catch_up`:
- **daily:** one expected run each Pacific day at `expected_by`;
- **weekly:** one on `day_of_week`;
- **hourly** (`hourly_until` set): one each hour from `expected_by` to `hourly_until`;
- an expected run counts when `expected_at` is in `[p_from, p_to]` and `expected_at + grace` is past. `grace` is `grace_hours`, or 1 hour for an hourly slot;
- it is **missed** when no run of that app and job started in the matching slot. For a daily or weekly run, the slot is that Pacific day up to `expected_at + grace`. For an hourly run, it is `[hour, hour + 1h)`.

The recovery item (§9.2) groups the missed runs by job, each with its rule and what happens:
- `self`: "the next run covers the gap: nothing to do."
- `skip`: "not worth running late: nothing to do."
- `run_now`: "run it once by hand: open the '<task name>' task in claude.ai and press Run now."

**Overwatch chat flow** (overwatch skill, s10): "review missed jobs since <time>". Call `get_job_health` with `since`, list the missed runs by rule (`run_now` first, each with its task name), and the stuck runs. Say which need Alex: for `run_now`, offer to walk him through it. Confirm the outage has closed.

## 8. Part D — The Claude health check

### 8.1 Tool `get_job_health` (tier 1, s8)

It is backed by the RPC `public.get_job_health(p_since timestamptz default null)` (created in the s6 migration, granted to `authenticated`), and returns one object:
- `watchdog`: `{last_tick_at, minutes_since, healthy}`, where `healthy` is `minutes_since <= 35` (two missed ticks), and `last_tick_error`;
- `outage`: `{open, since, alerted_at, last_recovered_at, last_outage_since}`;
- `stuck_runs`: runs swept in the window (`details.failure_kind = 'stuck'`), and runs still `running` past their limit (when the watchdog is dead);
- `missed_runs`: from `job_health_missed_runs` for the window;
- `since`: the window's start. It defaults to the start of the previous `job_health_check` run, or 24 hours ago. So each problem is reported once, and the task never reads its own earlier runs.

`tables: { reads: ["platform_runs", "platform_schedules", "job_health_state"], writes: [] }`. The file is `_shared/tools/job-health.ts` with its test, registered in `mcp/index.ts` (held by warren_buffet_p4-r6d; it is claimed at s8).

### 8.2 The task (`docs/claude-health-check-task-prompt.md`, s9)

- **Schedule:** every 2 hours, 6 AM to 8 PM Pacific. App/job `alfred` / `job_health_check`, executor `claude`, `started_by: "task:job-health-check"`. It follows the task-prompts skeleton, PROMPT VERSION and THE PROMPT line.
- **Steps:**
  1. `create_platform_run`. If it fails, Alfred is unreachable: the run ends with the outage text (§9.4a) and nothing else.
  2. `get_job_health`. If it fails, the same.
  3. A problem is any of: `watchdog.healthy` false; any `stuck_runs`; any `missed_runs` outside an open or just-closed outage (those are the watchdog's to report); `last_tick_error` set.
  4. Close the run: ok when healthy, `partial` when it found problems, with `details.prompt_version` and the counts.
  5. **The report.** When problems: the alert text (§9.4). When healthy: one line, `Job health <version>: all clear (watchdog <n> min ago).`
- **It raises no signals.** Its own final message, with Claude's notification on, is the alert. This is the **named exception** added to task-prompts rule 2 (§10). After it ships, Alex turns Claude's notification off on every other task (by hand in claude.ai, not a CLI job). Open item O2 asks whether healthy runs notify too.

## 9. Part F — Alert wording (in full)

### 9.1 The rule (task-prompts and overwatch skills)

Every alert says, in this order:
1. **What happened**, in one plain sentence, with times in 12-hour Pacific;
2. **Which kind it is**: *outage* (Claude or Supabase is down, so nothing on our side to fix) or *fix needed* (both services are up, and something of ours is broken);
3. **What to check**;
4. **How to recover**, ending with a paste-ready prompt in a block of its own.

**Notifications are only for time-sensitive things:** an outage starting, an outage over, a stuck dispatcher, and the health check's findings. Everything else goes to the inbox at the job's own severity, and the dispatcher's rules decide.

### 9.2 Outage (the watchdog)

**Push** (reminder text): `Claude tasks stopped at <time>. Outage: check status.claude.com and status.supabase.com. Details in your inbox.`

**Inbox item:**

```
Claude tasks stopped at <time>

What happened: no Claude scheduled task has started since <time> (<N> h <M> min). The hourly dispatcher, inbox enrichment and every other Claude task are not running, so Alfred notifications from tasks are not going out.

Kind: outage. Claude, or Claude's connection to Alfred, is down.

What to check: status.claude.com and status.supabase.com. If either shows an incident, wait: there is nothing to fix on our side.

Recovery: once it is fixed, start a new Claude thread and paste:

    Overwatch: connections are back. Review missed jobs since <time> and give me the recovery plan.

If both status pages have been green for over an hour, treat it as fix needed: check in claude.ai that the scheduled tasks are still enabled and that the Alfred connector is connected.
```

**Recovery push:** `Claude tasks are running again. <N> runs missed, <M> to run by hand. List in your inbox.`

**Recovery inbox item:**

```
Claude tasks are running again: <outage start> to <recovered at>

What happened: no Claude task ran for <duration>. <N> scheduled runs were missed.

Kind: outage, now over.

Missed runs:
- <task name> (<app>/<job>), <times>: <rule>. <what happens>
  …

Recovery: run the "run it now" jobs above by hand. For a full review, start a new Claude thread and paste:

    Overwatch: connections are back. Review missed jobs since <outage start> and give me the recovery plan.
```

When no runs were missed: "Missed runs: none."

### 9.3 Fix needed (stuck run: the signal's item, and the stuck dispatcher's direct item)

```
<job> was stuck and has been marked failed

What happened: <app>/<job> run <run id> started at <time> and was still running after <N> min (its limit is <max> min). The watchdog marked it failed.

Kind: fix needed. Claude and Supabase are up; something in this job is broken.

Error (verbatim): "<error_message>"

What to check: the job's own record of that run: the Edge Function logs at that time for an Alfred job (wb-sync), or the task's run history in claude.ai for a Claude task.

Recovery: <the catch_up line from §7>. To find the cause, start a new Claude thread and paste:

    Fast track: diagnose <app>/<job> run <run id>. It was still running after <N> min and was marked failed as stuck. Error: "<error_message>". Read the run with get_platform_runs, find why it hung, and propose the fix.
```

The stuck dispatcher's push: `The hourly dispatcher hung at <time>. Fix needed: task notifications may be stuck. Details in your inbox.`

### 9.4 The health check's alert (its final message)

- **a. Alfred is unreachable** (outage):
  ```
  Job health: Claude could not reach Alfred at <time>.
  Error (verbatim): "<error>"
  Kind: outage, or Alfred itself is down.
  What to check: status.claude.com and status.supabase.com. If either shows an incident, wait. Once it is fixed, start a new Claude thread and paste:
      Overwatch: connections are back. Review missed jobs since <time> and give me the recovery plan.
  If both are green, it is fix needed: check that the Alfred connector is connected in claude.ai.
  ```
- **b. The watchdog is silent** (fix needed: Alfred answered, so Supabase is up):
  ```
  Job health: the Alfred watchdog last ran at <time> (<N> min ago).
  Kind: fix needed. Supabase is answering, but the pg_cron job job-health-every-15-min has stopped or is failing. Stuck runs and outages are not being caught.
  Last watchdog error (verbatim): "<last_tick_error or none>"
  What to check: the cron job and its recent runs in Supabase.
  Recovery: start a new Claude thread and paste:
      Fast track: the job-health watchdog last ran at <time>. Last error: "<error>". Find out why job-health-every-15-min stopped and fix it.
  ```
- **c. Stuck or missed runs** (fix needed): one line each, `<app>/<job> run <run id>: <what happened>. Error: "<verbatim>"`, then a single `Fast track: diagnose …` prompt naming them all.

## 10. Skill changes (s9, s10)

- **task-prompts:**
  - rule 2 gains the exception: "The health check (`docs/claude-health-check-task-prompt.md`) raises no signals: its final message is the alert, and it is the only task with Claude's notification on.";
  - rule 10 gains the watchdog: "and the Alfred watchdog (a database job, not a task) writes outage, recovery and stuck-dispatcher items directly";
  - a new "Alert wording" section (§9.1), and a checklist line;
  - the skill version is bumped.
- **overwatch:**
  - the "review missed jobs since <time>" chat flow (§7);
  - the alert wording rule (§9.1);
  - Step 8b's judgment: the health check's notification is the rule working, not a finding;
  - the skill version is bumped.

## 11. Open items

- **O1 (answered s4).** The Nov 16 Edge logs: "booted (time: 405ms)" at 05:00:06; "[wb-sync] stage=context: WB_CONTEXT_ID length=19" at 05:00:07; then nothing until "shutdown" at 05:02:36, 150 s after boot. So the run hung after the context stage, most likely in the SimpleFIN fetch, and the wall clock killed the worker before close or catch ran. The fix is the fetch timeout, the 120 s time budget and the stage log (§5.2).
- **O5 (answered s4b): the fetch limit.** Alex chose 105 s; deployed with the 14-day window cap (§5.2). The Nov 17 run (9fbc453b) failed with HTTP 524 at 125 s on a 13-day window, so the window was not its cause: SimpleFIN is slow. Per-bank parallel calls may follow as s4c. The s4 analysis: Ok runs in the last 3 weeks: 13 accounts, 20 holdings, 28–51 transactions returned, 2–20 rows processed, an 11–13 day window, and 76–125 s in all. The database stages are about a dozen small queries over that. The failed runs show where the time goes: HTTP 524 (a gateway timeout) at 125.5 s three times, Oct 28, Oct 29 and Nov 1, and HTTP 503 at 47 s on Nov 15, all with nothing after the fetch. So SimpleFIN's one `/accounts` call takes roughly 75–120 s on a normal day. A 60 s limit would fail almost every run. Recommendation: `FETCH_TIMEOUT_MS` = 105 000. The fetch starts at about 2 s, so it ends by about 107 s, leaving about 13 s for the database stages inside the 120 s budget and 30 s more to close. The first deployed runs' stage logs confirm the split.
- **O2 (answered s3, test at s9).** The scheduled-task tool documents that a task's push fires "when a run finishes with something noteworthy", as the server judges it, not on every run. s9 tests it with one healthy run and one forced alert.
- **O3 (at s6).** If the SQL runner refuses `cron.schedule`, the cron statement goes to the SQL editor as the runner-refused fallback. It holds no secret.
- **O4 (decided in this spec, for Alex to confirm).** A stuck dispatcher run gets a direct alert (§5.1), because its own signal would wait on the dispatcher.

## 12. Database items, by step

| step | items |
|---|---|
| s4 | `db:deploy` (wb-sync) |
| s5 | `db:table:platform_schedules` (the columns, the values and the job_health_check row; the sweep itself ships in s6) |
| s6 | `db:table:job_health_state` (new), `db:table:inbox`, `db:table:reminders`, `db:table:signals`, `db:table:platform_runs`, `db:fn:job_health_watchdog`, `db:fn:job_health_missed_runs`, `db:fn:get_job_health` |
| s8 | `db:deploy` (mcp) |
