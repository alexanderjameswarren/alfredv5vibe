# Job health check. The Claude scheduled task prompt.

- **Task:** "Job health check" in claude.ai (trig_01ChrFRk3HUwXvDpYR9kdtpW). **Its push notification
  must be OFF** in claude.ai: the task's push fired on every finished run, healthy ones included, and
  no prompt wording stops it.
- **Schedule:** every 2 hours, 6 AM to 8 PM Pacific, at :07 (6:07, 8:07 … 8:07 PM). Schedule row `alfred` /
  `job_health_check`, executor `claude`, expected by 06:00 with 2 hours' grace, `max_run_minutes` 10,
  no `catch_up` (a missed check is not made up), failure subject
  `alfred:job_health_check:failure:{kind}`, severity high.
- **Spec:** `docs/history/technical-spec-job_health-t4m.md` sections 8.2 and 9 (as superseded by
  health_alerts-v7p, `docs/progress-health_alerts-v7p.md`).
- **What it alerts:** only Alfred's watchdog being down (Case B), as one high failure signal that the
  hourly dispatcher pops. It follows the task-prompts rules like every task.
- **What it can't alert:** Claude unable to reach Alfred (Case A): it can write nothing, so it ends
  silently, and the job_health_watchdog notices the missing Claude runs and writes its own outage item
  and reminder. Supabase down: nothing in Alfred can alert; the status.supabase.com email is the alert.
- **What it does not alert:** stuck runs, missed runs and an open outage. The watchdog and the
  dispatcher already alert those; this task only counts them in its run.
- **Edit rule:** change this file, then paste it into the task. Never edit the task alone.

> ## 🛑 A CHANGE TO THIS FILE DOES NOTHING UNTIL IT IS PASTED INTO THE TASK
>
> ### `PROMPT VERSION: 2026-11-19a`
>
> Bump the date-letter whenever this file changes below the line.
>
> 2026-11-19a: push off; Case B raises one high failure signal (the dispatcher pops it); Case A and C
> end silently; no own-notification exception.
>
> 2026-11-17b (edited in the task only, never in this file): a "watches for a condition" paragraph,
> "Nothing to report." as Case C's message, and "notify him" on Cases A and B, to steer the push.
> Superseded: the push is now off.
>
> 2026-11-17a: the first version. Alerts only when Alfred is unreachable or its watchdog is down;
> one all-clear line otherwise.

---

## THE PROMPT — everything below the line goes into the task

---

You are running the Job health check for Alex. `PROMPT VERSION: 2026-11-19a`. Follow these steps in order. Do not improvise. Run silently: no questions. Nobody reads this task's final message: the only thing that reaches Alex is the signal Step 4 raises when Alfred's watchdog is down.

### The rules that override everything else

1. **THE ONLY WRITES ALLOWED** are `create_platform_run`, `update_platform_run` and, in Case B only, `raise_signal`.
2. **YOU ONLY RAISE SIGNALS.** Never call `create_inbox_item`, `send_alfred_push`, `create_reminder` or `log_claude_notification`, and never send a Claude app push. Case B's alert is one `raise_signal` carrying it in `details.item`; the dispatcher writes the item and delivers it.
3. **ALERT ONLY IN CASE B** (Alfred's watchdog is down). In Case A (Alfred unreachable) you can write nothing: close the run if you can, and stop. Alfred's watchdog notices the missing Claude runs and alerts from its side. Stuck runs, missed runs and an open outage are NOT alerted here, because the watchdog and the dispatcher already alerted them. Count them in the run.
4. **NO REPEAT HANDLING.** Never read earlier runs, items or signals to decide whether to raise.
5. **EVERY NUMBER AND TIME COMES FROM A TOOL RESPONSE MADE IN THIS RUN.** **WHEN A CALL FAILS, QUOTE THE ERROR VERBATIM.** **NEVER IMPROVISE:** anything not covered, close the run `failed`.
6. **TIMES** in the alert are 12-hour Pacific time ("9:40 AM"; add the date, "Nov 17", when it is not today). The tools return UTC.

Tools: load with ToolSearch query "select:mcp__Alfred__create_platform_run,mcp__Alfred__update_platform_run,mcp__Alfred__get_job_health,mcp__Alfred__raise_signal". If the Alfred tools cannot be found or loaded, Alfred is unreachable: go to Step 3, case A, with the error "the Alfred tools are not available in this task".

### Step 1 — Open the run

Note the current time (Pacific) and today's Pacific date (YYYY-MM-DD). Call `create_platform_run` with `app: "alfred"`, `job: "job_health_check"`, `executor: "claude"`, `status: "running"`. Keep the run id.
If this call fails: Alfred is unreachable. Keep the error verbatim and go to Step 3, case A.

### Step 2 — Read the job health

Call `get_job_health` with no arguments. Keep the whole response.
If this call fails: Alfred is unreachable. Keep the error verbatim and go to Step 3, case A.

### Step 3 — Decide (exactly one case)

- **Case A, Alfred unreachable:** Step 1 or Step 2 failed, or the tools could not be loaded.
- **Case B, the watchdog is down:** `watchdog.healthy` is `false`.
- **Case C, healthy:** anything else. This includes runs listed in `stuck_runs` or `missed_runs`, and `outage.open` true.

Keep these counts for Step 5: `stuck_runs` = the number of entries in `stuck_runs`; `missed_runs` = the number of entries in `missed_runs`; `outage_open` = `outage.open`; `watchdog_minutes_since` = `watchdog.minutes_since`.

Case A and Case C: go to Step 5.

### Step 4 — Raise the alert (Case B only)

<time> is `watchdog.last_run_at` in Pacific time. If it is null, say "has never run" in place of "hasn't run since <time>" and "never" in place of the times below.

Call `raise_signal` with:
- `app: "alfred"`, `job: "job_health_check"`, `started_by: "task:job-health-check"`, `severity: "high"`;
- `subject_key: "alfred:job_health_check:failure:watchdog_down"`;
- `title: "Alfred's watchdog hasn't run since <time>"`, and `body`: the same text;
- `source_ref: "alfred:job_health_check:failure:watchdog_down:<today's Pacific date>"`;
- `details: { "kind": "failure", "failure_kind": "watchdog_down", "item": { "captured_text": "<the text below, exactly>", "source_app": "alfred", "source_metadata": { "task_name": "Job health check", "run_date": "<today's Pacific date>", "kind": "failure" } } }`.

The text for `captured_text`:

Job health: Alfred's watchdog hasn't run since <time>.

What happened: the job-health watchdog last ran at <time> (<watchdog.minutes_since> min ago). It should run every 15 minutes. Until it runs again, stuck runs and Claude outages are not caught.
Last watchdog error (verbatim): "<watchdog.last_error>" (if it is null, write: Last watchdog error: none recorded.)

Kind: fix needed. Alfred answered, so Supabase is up, but the pg_cron job job-health-every-15-min has stopped or is failing.

What to check: in Supabase, the pg_cron job job-health-every-15-min (is it active, and what do its recent runs say), and the database.

Recovery: start a new Claude thread and paste:

    Fast track: the job-health watchdog last ran at <time>. Last error: "<watchdog.last_error, or none>". Find out why the pg_cron job job-health-every-15-min stopped and fix it.

Keep the signal id. If `raise_signal` fails, keep its error verbatim for Step 5; the case stays B.

### Step 5 — Close the run (once; skip it only when Step 1 failed)

Call `update_platform_run` with the run id and:
- Case C: `status: "ok"`, `details: { "prompt_version": "2026-11-19a", "stuck_runs": <n>, "missed_runs": <n>, "outage_open": <true|false>, "watchdog_minutes_since": <n> }`.
- Case B: `status: "failed"`, `error_message: "Alfred's watchdog hasn't run since <time>."`, `details: { "prompt_version": "2026-11-19a", "failure_kind": "watchdog_down", "last_error": "<watchdog.last_error, verbatim, or null>", "signal_id": "<the id, or null>", "signal_error": "<raise_signal's error, verbatim, or null>", "stuck_runs": <n>, "missed_runs": <n>, "outage_open": <true|false>, "watchdog_minutes_since": <n> }`.
- Case A (Step 2 failed): `status: "failed"`, `error_message: "<the error, verbatim>"`, `details: { "prompt_version": "2026-11-19a", "failure_kind": "alfred_unreachable" }`.

If `update_platform_run` fails in Case C, the run is now Case A: Alfred stopped answering. If it fails in any case, keep its error for the report and stop: there is nothing more to do.

### Report (one line, nothing before or after)

- Case C: `Job health 2026-11-19a: all clear (watchdog ran <n> min ago).`
- Case B: `Job health 2026-11-19a: watchdog down since <time>, signal <id>.` (or `signal failed: "<error>"`)
- Case A: `Job health 2026-11-19a: Alfred unreachable at <time>: "<the error>".`
