# Ken — seed check. The Claude scheduled task prompt.

**This file IS the automation**, in the same shape as `docs/dj-daily-task-prompt.md`: there is
no Workshop code for this job. The prompt below is the whole program.

- **Schedule:** daily, **08:00 America/Los_Angeles**. The task fires every day but does real
  work only on **Monday, Wednesday and Friday**. The other four days it still stamps a run:
  `platform_schedules` says daily, so a day with no row reads as a dead task.
- **App / job:** `ken` / `ken_seed_check` (schedule row `b5b2d972-76ae-41a3-a125-959bbfb9b3fe`).
- **Tools:** Alfred connector only. No Workshop call is needed; see the notes at the bottom.
- **Prerequisite:** the Alfred connector must have been **reconnected after the 2026-09-11
  deploy**. `get_ken_areas`, and `app: "ken"` on `create_platform_run`, exist only in that
  manifest.
- **Edit rule:** change this file, then paste it into the task. Never edit the task alone.

> ## 🛑 A CHANGE TO THIS FILE DOES NOTHING UNTIL IT IS PASTED INTO THE TASK
>
> The task runs the text that was pasted, not the text in this repo. So the prompt carries a
> version and Step 7 echoes it. An older version (or none) in a report means the task is running
> stale text.
>
> ### `PROMPT VERSION: 2026-09-11a`
>
> Bump the date-letter whenever this file changes below the line.

## The record and the notification are SEPARATE

| | when | where |
|---|---|---|
| **Record** | **every run**: off days, zero counts, suppressed runs and failures included | `platform_runs` |
| **Notification** | **only** when at least one seed is unseeded AND no Ken nudge is already pending | one Alfred **inbox item** |

A zero count raises nothing. A day that finds a nudge already pending raises nothing. A signal
that fires on the normal case teaches its reader to skip it.

---

## THE PROMPT — everything below the line goes into the task

---

You are running the Ken seed check. Follow these steps in order. **Do not improvise.**

### The three rules that override everything else

1. **NEVER IMPROVISE.** If you hit anything this prompt does not explicitly cover, **STOP** and
   report what you saw. Do not invent a recovery, and do not retry with different arguments.
2. **REPORT WHAT YOU DID, NOT WHAT YOU INTENDED.** Every number you write, in the run details or
   the report, is copied from a tool response or counted from one. If you do not have it, write
   `unknown`.
3. **WHEN A CALL FAILS, QUOTE THE ERROR VERBATIM**, with the HTTP status if there is one. Never
   write "the call failed".

**Whenever a step below says STOP: go to Step 6 and close the run as `failed`, then Step 7.**

---

### Step 1 — Open the run, before anything else

Call `create_platform_run` with `app: "ken"`, `job: "ken_seed_check"`, `executor: "claude"`,
`status: "running"`. Pass nothing else. **Keep the run id.** Every later step needs it.

This comes first so a task that dies mid-flight leaves a `running` row behind rather than
nothing at all.

If this call fails, there is no run to close. Skip to Step 7, report the verbatim error, and
finish. If the error is an **input validation error naming the allowed `app` values**, the
rejection came from a stale tool schema. Say: *"Redeploy the mcp function, then reconnect the
Alfred connector so it refetches the tool manifest."*

### Step 2 — Is today a run day?

Work out **today's date in America/Los_Angeles** and its **weekday name**. Write both down:
they go into the run's `details` whatever happens, so a wrong weekday is visible in the log.

Run days are **exactly Monday, Wednesday and Friday.**

**Not a run day:** go to Step 6 and close as `ok` with
`details: { run_day: false, skipped: "off_day", local_date, weekday }`. Read nothing else.

### Step 3 — Read the seeds and the areas

1. `get_items` with `context_id: "msxh8sz8ci2ldf6t02k"` (the Alfred **Ken** context) and
   `limit: 50`. Keep each item's `id` and `name`. These are the seeds.
2. `get_ken_areas`. Keep every **non-null** `source_ref`.

**If either response starts with `NOTE: results truncated`, STOP**, with
`failure_kind: "read_truncated"` and the NOTE as `error_message`. A count taken from a partial
read is wrong, and it is not obvious which way: missing seeds hide work, and missing areas make
seeded items look unseeded.

If `get_items` errors, STOP with `failure_kind: "alfred_read"`. If `get_ken_areas` errors, STOP
with `failure_kind: "ken_read"`.

### Step 4 — Count the unseeded seeds

A seed is **seeded** when its Alfred `id` is **exactly equal** to some area's `source_ref`.
Otherwise it is **unseeded**. Let **N** be the number of unseeded seeds.

> ⚠️ **THE ID TYPES DIFFER, AND ONLY ONE COMPARISON IS MEANINGFUL.**
> - Alfred item ids are short **text**, e.g. `mtw2g9lb8cbs0xhsdij`.
> - `ken_areas.id` is a **uuid**. It is **never** compared to anything in this job.
> - `ken_areas.source_ref` is **text holding an Alfred id**. This is the only field you compare
>   against.
>
> Compare `item.id` with `source_ref` as exact, case-sensitive strings. **Never match on names.**
> An area whose name looks like a seed but whose `source_ref` is null does not seed it. A seed
> renamed in Alfred is still seeded if its id matches.

**N = 0:** go to Step 6 and close as `ok`. **Never create an inbox item for zero.**

### Step 5 — Check for a pending nudge, then notify

1. `get_inbox` with `limit: 50`. It returns only **untriaged, unarchived** items.

   A **Ken nudge** is an item whose `captured_text` **begins with exactly** `Ken seed check —`.

   **If one exists:** go to Step 6 and close as `ok`, with `suppressed_by: <that item's id>` in
   `details`. **Do not update, merge, archive or re-word the existing item.** Skipping is the
   whole dedupe strategy.

   If the response starts with `NOTE: results truncated` and no nudge appears in the rows you
   were given, carry on to 5.2 and set `inbox_read_truncated: true` in `details`. A duplicate
   nudge is visible and harmless. A nudge suppressed on a guess is neither.

   If `get_inbox` errors, STOP with `failure_kind: "inbox_read"`.

2. `create_inbox_item` with:
   - `captured_text`, exactly this shape:

     ```
     Ken seed check — <N> new seed(s), <local_date>

     Ken: <N> new seeds in the Alfred Ken context. Read them, tell me what mode and accuracy each should get, then distill each into 2-3 items before we quiz.

     Seeds:
     - <name> (<alfred id>)
     - <name> (<alfred id>)
     ```

     ⚠️ **The first line is the dedupe marker.** It must begin `Ken seed check —`, with an em
     dash, character for character. The next run finds it by that prefix and nothing else.
   - `suggested_context_id: "msxh8sz8ci2ldf6t02k"`
   - `ai_reasoning: "Created by the ken_seed_check scheduled task, run <run id>."`

   Set nothing else. This is a nudge, not a capture to file, so there is no item, intent or
   event to suggest.

   **Keep the returned inbox id.** If the call errors, STOP with `failure_kind: "inbox_write"`.

### Step 6 — Close the run

Call `update_platform_run` with the run id from Step 1. **One call.** A closed run cannot be
re-stamped, and `details` can only be written while closing.

- **`status`:** `ok` for every outcome in Steps 2–5 (off day, zero, suppressed, created).
  `failed` **only** when a step said STOP.
- **`details`**, always: `run_day`, `local_date`, `weekday`. On a run day, also `seeds_read`,
  `areas_read`, `unseeded_count` (N), and `unseeded_ids`. Then **one** of `inbox_item_id` (created),
  `suppressed_by` (pending nudge found), or neither (N = 0). Add `inbox_read_truncated: true`
  if Step 5 set it. If this run was started by hand rather than by the schedule, add
  `manual: true`.
- **On `failed`:** `error_message` holds the **verbatim** error, and `details.failure_kind` is
  one of `alfred_read`, `ken_read`, `read_truncated`, `inbox_read`, `inbox_write`, `unknown`.

> 🛑 **A `failed` close REQUIRES both `error_message` and `details.failure_kind`. The tool
> rejects the write without them.** If it is rejected for that reason, supply them. **Never
> downgrade the status to get past it.** A failure logged without its cause cannot be told apart
> from one that failed for no reason.

If the close itself fails, report that verbatim in Step 7. The run stays `running`, which
reads as an orphan rather than as a success. That is the right way for this to be wrong.

### Step 7 — Report to the chat

Nobody may read this. Write it anyway, in exactly this shape:

```
Ken seed check — <local_date> (<weekday>)
  prompt version: 2026-09-11a
  run id: <id>
  run day: <yes | no — skipped>
  seeds read: <n>   areas read: <n>
  unseeded: <n>   <names, if any>
  inbox: <created <id> | suppressed — pending nudge <id> | none — zero unseeded |
          none — off day | none — failed>
  status stamped: <ok | failed | NOT STAMPED — <why>>
```

Print `prompt version` exactly as written at the top of this prompt.

---

## Notes for the human reading this later

**Why this is a Claude task and not Workshop code.** Workshop is an MCP server that Claude
calls into. It has no scheduler and no Supabase credential of its own. Every scheduled job in
this project, `dj/daily_history_sync` included, is a Claude scheduled task whose prompt lives
in `docs/`, and it opens and closes its run through the Alfred connector. This job needs no
Workshop tool at all.

**Executor.** The run is stamped `executor: "claude"`, because Claude is what runs it (the DJ
sync does the same). The schedule row currently says `executor: "workshop"`.

**What this task deliberately does NOT do:**

- **No inbox item on failure.** A failure is recorded in `platform_runs` with its cause and is
  not raised separately. The DJ sync raises failures; this job was specified without that.
- **No update or merge of a pending nudge.** It skips. A pending nudge stays exactly as it was
  written, even if more seeds have arrived since. Its list is as of the day it was written.
- **No name matching**, and no area creation. It counts and nudges, nothing else.

**A known gap: an area created in conversation never counts as seeding.** If an area is created
for a seed without passing that seed's id as `source_ref`, the seed stays "unseeded" and is
listed in every nudge. No tool today sets `source_ref` on an existing area. When seeding from
this nudge, create the area with `create_ken_area source_ref=<alfred id>`.

**Day-one check:** after the first scheduled firing, call `get_platform_runs` with `app: "ken"`,
`job: "ken_seed_check"` and confirm a run was stamped and closed.
