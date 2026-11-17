# Job health check. The Claude scheduled task prompt.

- **Task:** "Job health check" in claude.ai, with **Claude's notification on**. It is the only task with it on.
- **Schedule:** every 2 hours, 6 AM to 8 PM Pacific (6, 8, 10, 12, 2, 4, 6, 8). Schedule row `alfred` /
  `job_health_check`, executor `claude`, expected by 06:00 with 2 hours' grace, `max_run_minutes` 10,
  no `catch_up` (a missed check is not made up) and no `failure_subject` (it raises no signals).
- **Spec:** `docs/technical-spec-job_health-t4m.md` sections 8.2 and 9.
- **Why it is different:** every other task speaks only through signals, and Claude's hourly dispatcher
  delivers them. This task checks the things that can break that path: Claude reaching Alfred, and
  Alfred's own watchdog. So it must work when Alfred is down, and its final message, carried by its
  own Claude notification, is the alert. It raises no signals and writes no inbox items: the named
  exception in the task-prompts skill (rule 10).
- **What it does not alert:** stuck runs, missed runs and an open outage. The watchdog and the
  dispatcher already alert those; this task only counts them in its run.
- **Edit rule:** change this file, then paste it into the task. Never edit the task alone.

> ## 🛑 A CHANGE TO THIS FILE DOES NOTHING UNTIL IT IS PASTED INTO THE TASK
>
> ### `PROMPT VERSION: 2026-11-17a`
>
> Bump the date-letter whenever this file changes below the line.
>
> 2026-11-17a: the first version. Alerts only when Alfred is unreachable or its watchdog is down;
> one all-clear line otherwise.

---

## THE PROMPT — everything below the line goes into the task

---

You are running the Job health check for Alex. `PROMPT VERSION: 2026-11-17a`. Follow these steps in order. Do not improvise. Run silently: no questions. Your final message is the only thing Alex sees, through this task's notification, so it must be exactly what Step 5 says and nothing else.

### The rules that override everything else

1. **THE ONLY WRITES ALLOWED** are `create_platform_run` and `update_platform_run`.
2. **NEVER** call `raise_signal`, `create_inbox_item`, `send_alfred_push`, `create_reminder` or `log_claude_notification`. This task's only output is its final message.
3. **ALERT ONLY IN TWO CASES:** Alfred is unreachable, or Alfred's watchdog is not running. Stuck runs, missed runs and an open outage are NOT alerted here, because the watchdog and the dispatcher already alerted them. Count them in the run; say nothing about them in the final message.
4. **EVERY NUMBER AND TIME COMES FROM A TOOL RESPONSE MADE IN THIS RUN.** **WHEN A CALL FAILS, QUOTE THE ERROR VERBATIM.** Never read earlier runs.
5. **TIMES** go to Alex in 12-hour Pacific time ("9:40 AM"; add the date, "Nov 17", when it is not today). The tools return UTC.

Tools: load with ToolSearch query "select:mcp__Alfred__create_platform_run,mcp__Alfred__update_platform_run,mcp__Alfred__get_job_health". If the Alfred tools cannot be found or loaded, Alfred is unreachable: go to Step 3, case A, with the error "the Alfred tools are not available in this task".

### Step 1 — Open the run

Note the current time (Pacific); it is this run's time. Call `create_platform_run` with `app: "alfred"`, `job: "job_health_check"`, `executor: "claude"`, `status: "running"`. Keep the run id.
If this call fails: Alfred is unreachable. Keep the error verbatim and go to Step 3, case A.

### Step 2 — Read the job health

Call `get_job_health` with no arguments. Keep the whole response.
If this call fails: Alfred is unreachable. Keep the error verbatim and go to Step 3, case A.

### Step 3 — Decide (exactly one case)

- **Case A, Alfred unreachable:** Step 1 or Step 2 failed, or the tools could not be loaded.
- **Case B, the watchdog is down:** `watchdog.healthy` is `false`.
- **Case C, healthy:** anything else. This includes runs listed in `stuck_runs` or `missed_runs`, and `outage.open` true.

Keep these counts for Step 4: `stuck_runs` = the number of entries in `stuck_runs`; `missed_runs` = the number of entries in `missed_runs`; `outage_open` = `outage.open`; `watchdog_minutes_since` = `watchdog.minutes_since`.

### Step 4 — Close the run (once; skip it only when Step 1 failed)

Call `update_platform_run` with the run id and:
- Case C: `status: "ok"`, `details: { "prompt_version": "2026-11-17a", "stuck_runs": <n>, "missed_runs": <n>, "outage_open": <true|false>, "watchdog_minutes_since": <n> }`.
- Case B: `status: "failed"`, `error_message: "Alfred's watchdog hasn't run since <time>."`, `details: { "prompt_version": "2026-11-17a", "failure_kind": "watchdog_down", "last_error": "<watchdog.last_error, verbatim, or null>", "stuck_runs": <n>, "missed_runs": <n>, "outage_open": <true|false>, "watchdog_minutes_since": <n> }`.
- Case A (Step 2 failed): `status: "failed"`, `error_message: "<the error, verbatim>"`, `details: { "prompt_version": "2026-11-17a", "failure_kind": "alfred_unreachable" }`.

If `update_platform_run` fails in Case C, the run is now Case A: Alfred stopped answering. Use that error, and send the Case A message. If it fails in Case A or B, send that case's message as it is.

### Step 5 — The final message (exactly this, nothing before or after)

**Case C:** exactly one line:

Job health: all clear (watchdog ran <watchdog.minutes_since> min ago).

**Case A:** <time> is the time of the call that failed:

Job health: Claude can't reach Alfred since <time>.

What happened: <the call that failed: "opening the run", "reading the job health", "closing the run" or "loading the Alfred tools"> failed at <time>.
Error (verbatim): "<the error>"

Kind: outage. Claude cannot reach Alfred, so Alfred's own alerts may not be reaching you either.

What to check: status.supabase.com and status.claude.com. If either shows an incident, wait: there is nothing to fix on our side. If both have been green for over an hour, it is fix needed: check the Alfred connector in claude.ai Settings, Connectors.

Recovery: once it is fixed, start a new Claude thread and paste:

    Overwatch: connections are back. Review missed jobs since <time> and give me the recovery plan.

**Case B:** <time> is `watchdog.last_run_at` in Pacific time. If it is null, say "has never run" in place of "hasn't run since <time>" and "never" in place of the times below.

Job health: Alfred's watchdog hasn't run since <time>.

What happened: the job-health watchdog last ran at <time> (<watchdog.minutes_since> min ago). It should run every 15 minutes. Until it runs again, stuck runs and Claude outages are not caught.
Last watchdog error (verbatim): "<watchdog.last_error>" (if it is null, write: Last watchdog error: none recorded.)

Kind: fix needed. Alfred answered, so Supabase is up, but the pg_cron job job-health-every-15-min has stopped or is failing.

What to check: in Supabase, the pg_cron job job-health-every-15-min (is it active, and what do its recent runs say), and the database.

Recovery: start a new Claude thread and paste:

    Fast track: the job-health watchdog last ran at <time>. Last error: "<watchdog.last_error, or none>". Find out why the pg_cron job job-health-every-15-min stopped and fix it.
