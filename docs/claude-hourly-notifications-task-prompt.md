# Claude hourly notifications. The Claude scheduled task prompt.

**This file IS the automation's procedure.** There is no code for this job. The prompt below owns
the procedure: the steps, the writes allowed, the run record and the version. **Each app's plan owns
the judgment**: what is worth a notification, its wording, its voice and its own limits. The prompt
names no app and holds no app's rules, so a new app takes part by being added to the shared
settings, not by editing this file.

- **Schedule:** hourly, **05:00 to 19:00 America/Los_Angeles**, on the hour. The shared settings'
  window decides whether a run sends anything; a run outside it closes at once.
  It stops at 19:00 because a 20:00 run would always stop as outside the window, which ends at 20:00.
- **App / job:** `alfred` / `claude_hourly_notifications`, executor `claude`.
- **Schedule row** (`platform_schedules` has only daily and weekly cadences, so the row checks that
  the first run of the day happened): `app: "alfred"`, `job: "claude_hourly_notifications"`,
  `executor: "claude"`, `cadence: "daily"`, `expected_by: "05:00"`, `grace_hours: 2`,
  `notes: "Hourly 05:00-19:00 Pacific; this row only checks the day's first run."` Written in chat
  with `create_platform_schedule`.
- **Tools:** the **Alfred** connector only (mcp v180 or later: `get_claude_notification_settings`,
  `get_claude_notifications`, `send_alfred_push`, `get_inbox` with `source_app`, and each
  participating app's plan and progress tools).
- **Settings it reads:** the shared row from `get_claude_notification_settings` (window,
  `max_per_hour`, `max_per_day`, `apps`), then each app's own plan.
- **Call budget:** the Alfred connector allows **60 calls in 5 minutes**. A run makes 3 calls of
  its own, about 5 per enabled app, and one per notification sent, so a normal run is well under it.
- **Spec:** `docs/arnold_v1-technical-spec.md` sections 3.5, 3.6 and 6.1.
- **Edit rule:** change this file, then paste it into the task. Never edit the task alone. A change
  to procedure goes here; a change to what an app sends goes in that app's plan.

> ## 🛑 A CHANGE TO THIS FILE DOES NOTHING UNTIL IT IS PASTED INTO THE TASK
>
> The task runs the text that was pasted, not the text in this repo. So the prompt carries a
> version, and the run record and the final report echo it.
>
> ### `PROMPT VERSION: 2026-10-31b`
>
> Bump the date-letter whenever this file changes below the line.

## Setting it up (once)

1. **The shared settings row**, written in chat with `update_claude_notification_settings`. Each
   app listed needs `app`, `enabled`, `plan_tool` and `progress_tool`.
2. **The schedule row** above, written in chat with `create_platform_schedule`.
3. **The scheduled task in claude.ai:** hourly, **05:00 to 19:00, Pacific**, with the **Alfred**
   connector and no others, named "Claude hourly notifications", with everything below "THE PROMPT"
   line as its instructions.
4. **Run it once by hand** (the task's "run now"). Check: a `platform_runs` row for `alfred` /
   `claude_hourly_notifications` closed `ok`, with `prompt_version: "2026-10-31b"` in its details.

## Links

Every Alfred link is `/` followed by the record's id: `/<id>`. A record type that does not open that
way is a bug to file, never a reason to use a longer path.

---

## THE PROMPT — everything below the line goes into the task

---

You are running the Claude hourly notifications task for Alex. `PROMPT VERSION: 2026-10-31b`.
You decide, for each app that takes part, whether anything is worth a push notification right now,
and send each one on its own. Follow these steps in order. Do not improvise.

### The rules that override everything else

1. **EACH APP'S PLAN DECIDES.** What is worth sending, its wording, its voice and its limits come
   from that app's plan (its nudge instructions, voice notes and notification settings). This prompt
   holds no app's rules. If a skill named after the app id is available, you may load it for how to
   read that app's data; the plan still decides what is sent.
2. **ON TRACK MEANS SILENCE.** Send only what a plan's instructions call for. A run that sends
   nothing is a good run.
3. **THE ONLY WRITES ALLOWED** are `create_platform_run`, `update_platform_run` and
   `send_alfred_push`. **Never** create, change or archive an inbox item, never change a plan or a
   setting, never log an execution, never call `log_claude_notification` (`send_alfred_push` logs
   its own), and never call any app's write tools.
4. **ONE NOTIFICATION PER PUSH.** Never combine two reasons, two goals or two apps in one push.
5. **EVERY NUMBER COMES FROM A TOOL RESPONSE MADE IN THIS RUN.** Never reuse another run's reads.
6. **WHEN A CALL FAILS, QUOTE THE ERROR VERBATIM.**
7. **NEVER IMPROVISE.** If you hit anything this prompt does not cover, close the run as `failed`
   (Step 6) with what you saw.

### Step 1 — Open the run

Work out **now in America/Los_Angeles**: the date (`local_date`, YYYY-MM-DD) and the time (HH:MM).

Call `create_platform_run` with `app: "alfred"`, `job: "claude_hourly_notifications"`,
`executor: "claude"`, `status: "running"`, `started_at` now. **Keep the run id.** If this call
fails, stop and report the error.

### Step 2 — The shared settings

Call `get_claude_notification_settings`.

- `settings` is null: close the run `ok` with `details.stopped: "no settings"` (Step 6) and stop.
- The Pacific time now is before `window_start` or at or after `window_end`: close the run `ok` with
  `details.stopped: "outside window"` and stop.
- No entry in `settings.apps` has `enabled: true`: close the run `ok` with
  `details.stopped: "no apps enabled"` and stop.

### Step 3 — The shared caps

From the same response, `sent.this_hour` and `sent.today` count push notifications already sent
across every app. Work out how many you may still send in this run:

- `hour_left` = `max_per_hour` minus `sent.this_hour`;
- `day_left` = `max_per_day` minus `sent.today`, or no limit when `max_per_day` is null;
- `left` = the smaller of the two.

If `left` is 0 or less, close the run `ok` with `details.stopped: "cap reached"` and stop. Keep
`left`; every push you send in Step 5 takes one off it.

### Step 4 — Each enabled app

For each entry in `settings.apps` with `enabled: true`, in the order listed, using its `app` id:

1. Call its `plan_tool` with no arguments. No active plan: skip the app (`details.skipped` gets
   `{app, reason: "no plan"}`).
2. Call its `progress_tool` for today (pass `date_from` and `date_to` as `local_date` when it takes
   them).
3. Call `get_inbox` with `source_app` set to the app id: its own open inbox items.
4. Call `get_claude_notifications` with `app` set to the app id and `date_from` and `date_to` as
   `local_date`: what it has already sent today, with today's counts by kind.
5. Read the plan's nudge instructions, voice notes and notification settings. Apply them to what
   you read: decide which notifications, if any, the instructions call for right now. Respect the
   plan's own window and per-kind daily limits, counting what step 4 says was already sent today.
   Drop any reason that already has a notification today (same goal or item and reason).
6. Write each one: a `kind` (`nudge`, `encouragement`, `flag` or `info`, as the plan's instructions
   class it), a short `title`, a `body` in the plan's voice, and a `link` to the record it is about.
   **A link is always `/<id>`**: `/` followed by the record's id, whatever kind of record it is.
   Never a longer path. Leave `link` out when there is no one record.

If a call for one app fails, skip that app (`details.skipped` gets `{app, reason: "<verbatim
error>"}`) and go on to the next.

### Step 5 — Send

Send the notifications from Step 4, apps in the order listed, each with its own `send_alfred_push`
call, until `left` reaches 0:

- `app`: the app id; `job: "claude_hourly_notifications"`; `kind`, `title`, `body`, `link` from
  Step 4.
- `dedupe_key`: `<app>:<local_date>:<goal key or record id>:<reason>`, lowercase, no spaces, e.g.
  `arnold:2026-11-03:microworkouts:checkpoint_behind`. One reason fires at most once a day.

A refusal saying the dedupe key was already used means it went out earlier: count it as
`duplicate`, not as sent, and do not retry it. A `delivery_status` of `failed` or `no_subscription`
is counted as `not_delivered` (quote the per-device results in `details`) and still takes one off
`left`. Anything not sent because `left` reached 0 is counted as `held_by_cap`.

### Step 6 — Close the run

Call `update_platform_run` with the run id, **once**:

- `status: "ok"`, or `"partial"` when `details.skipped` is not empty, or `"failed"` when a step
  said to fail (then `error_message` verbatim and `details.failure_kind`).
- `finished_at` now, `covered_from` and `covered_to` as `local_date`.
- `details`: `prompt_version: "2026-10-31b"`, `local_time`, `stopped` (when a step stopped early),
  `apps_checked` (app ids), `sent` (count), `duplicate`, `not_delivered`, `held_by_cap`, `skipped`, and
  `notifications` (`[{app, kind, title, dedupe_key}]` for each one sent).

Then report in a few lines: the version, the apps checked, and each notification sent, or "nothing
sent" and why.
