# Ken — seed check. The Claude scheduled task prompt.

**This file IS the automation**, in the same shape as `docs/dj-daily-task-prompt.md`: there is
no Workshop code for this job. The prompt below is the whole program.

- **Schedule:** daily, **08:00 America/Los_Angeles**. The task fires every day but does real
  work only on **Monday, Wednesday and Friday**. The other four days it still stamps a run:
  `platform_schedules` says daily, so a day with no row reads as a dead task.
- **App / job:** `ken` / `ken_seed_check` (schedule row `b5b2d972-76ae-41a3-a125-959bbfb9b3fe`).
- **Tools:** Alfred connector only. No Workshop call is needed; see the notes at the bottom.
- **Prerequisite:** the Alfred connector must have been **reconnected after the 2026-09-11
  `source_refs` deploy**. `get_ken_areas` with `source_refs`, and `app: "ken"` on the
  platform-run tools, exist only in that manifest.
- **Edit rule:** change this file, then paste it into the task. Never edit the task alone.

> ## 🛑 A CHANGE TO THIS FILE DOES NOTHING UNTIL IT IS PASTED INTO THE TASK
>
> The task runs the text that was pasted, not the text in this repo. So the prompt carries a
> version and Step 8 echoes it. An older version (or none) in a report means the task is running
> stale text.
>
> ### `PROMPT VERSION: 2026-11-06a`
>
> Bump the date-letter whenever this file changes below the line.
>
> 2026-11-06a: signals only. The nudge and the failure item are each one `raise_signal` whose
> `details.item` holds the item, and the dispatcher writes it; no `create_inbox_item`. The
> pending-nudge check, the weekly failure de-dup, `notified_at` and "STILL FAILING" are gone: the
> dispatcher folds repeats of a subject key into one item with a "Seen n times since..." line.
>
> 2026-11-05b: the nudge and the failure item carry `source_app: "ken"` again.
>
> 2026-11-05a: every inbox item the run creates (a nudge or a failure item) is followed by one
> `raise_signal` for it; the dispatcher decides what reaches Alex. The task never sends a push.

## The record and the notification are SEPARATE

| | when | where |
|---|---|---|
| **Record** | **every run**: off days, zero counts, suppressed runs and failures included | `platform_runs` |
| **Nudge** | **only** when at least one seed is unseeded | one **signal**, carrying the inbox item; the dispatcher folds it into the open nudge if there is one |
| **Failure item** | **only** when the run failed | one **signal** (`kind: "failure"`), carrying the inbox item; repeats fold into one item |

A clean run raises nothing: no nudge for zero, and no "it worked".
A signal that fires on the normal case teaches its reader to skip it.

**Failures need their own signal because staleness cannot see them.** Staleness alarms when no
run arrives. A run that arrives and closes `failed` satisfies it, so without a signal a broken
job would look alive indefinitely.

---

## THE PROMPT — everything below the line goes into the task

---

You are running the Ken seed check. `prompt version: 2026-11-06a`. Follow these steps in order.
**Do not improvise.**

### The rules that override everything else

1. **NEVER IMPROVISE.** If you hit anything this prompt does not explicitly cover, **STOP** and
   report what you saw. Do not invent a recovery, and do not retry with different arguments.
2. **REPORT WHAT YOU DID, NOT WHAT YOU INTENDED.** Every number you write, in the run details or
   the report, is copied from a tool response or counted from one. If you do not have it, write
   `unknown`.
3. **WHEN A CALL FAILS, QUOTE THE ERROR VERBATIM**, with the HTTP status if there is one. Never
   write "the call failed".
4. **YOU ONLY RAISE SIGNALS.** The only writes are `create_platform_run`, `update_platform_run`
   and `raise_signal`. Never call `create_inbox_item`, `send_alfred_push`, `create_reminder` or
   `log_claude_notification`, and never send a Claude app push. Each item is one `raise_signal`
   that carries it in `details.item`; the dispatcher writes it and decides what reaches Alex.
5. **NO REPEAT HANDLING.** Never read the inbox, earlier runs or earlier signals to decide
   whether to raise. Raise every time; the dispatcher folds repeats of the same `subject_key`
   into one item with a "Seen n times since..." line.

**Whenever a step below says STOP: go to Step 6 and close the run as `failed`, then Step 7,
then Step 8.** Stopping still means stamping the run and raising a failure signal. It does not
mean going quiet.

**Raising an item.** Call `raise_signal` once:
- `app: "ken"`, `job: "ken_seed_check"`, `started_by: "task:ken-seed-check"`;
- `severity` and kind: `"normal"` and `"flag"` for a nudge, `"high"` and `"failure"` for a
  failure item;
- `subject_key`: `"ken:ken_seed_check:nudge"` for a nudge,
  `"ken:ken_seed_check:failure:<failure_kind>"` for a failure item. Never a date in it;
- `title`: the item's first line; `body`: one plain line saying what it holds; no `link`;
- `details: { "kind": "<flag or failure>", "item": { "captured_text": "<the item's text>", "source_app": "ken", "source_metadata": { "task_name": "Ken seed check", "run_date": "<local_date>" }, "ai_reasoning": "Created by the ken_seed_check scheduled task, run <run id>." } }`.
  The dispatcher writes the inbox item from `details.item`, with `source_type: "task"`;
- `source_ref: "<subject_key>:<local_date>"`.

Keep the returned `signal_id`. If it says `created: false`, it was already raised today: note that.
**A failed `raise_signal` never fails the run:** record its verbatim error as `signal_error` in the
run details (or, for a failure item, in the report) and carry on.

---

### Step 1 — Open the run, before anything else

Call `create_platform_run` with `app: "ken"`, `job: "ken_seed_check"`, `executor: "claude"`,
`status: "running"`. Pass nothing else. **Keep the run id.** Every later step needs it.

This comes first so a task that dies mid-flight leaves a `running` row behind rather than
nothing at all.

**If this call fails, there is no run to close.** Skip Step 6. Go to Step 7 with
`failure_kind: "run_open"` and the verbatim error, then Step 8.

### Step 2 — Is today a run day?

Work out **today's date in America/Los_Angeles** and its **weekday name**. Write both down:
they go into the run's `details` whatever happens, so a wrong weekday is visible in the log.

Run days are **exactly Monday, Wednesday and Friday.**

**Not a run day:** go to Step 6 and close as `ok` with
`details: { run_day: false, skipped: "off_day", local_date, weekday }`. Read nothing else.

### Step 3 — Read the seeds, then ask which of them already have an area

1. `get_items` with `context_id: "msxh8sz8ci2ldf6t02k"` (the Alfred **Ken** context) and
   `limit: 50`. Keep each item's `id` and `name`. These are the seeds.

   **If the response starts with `NOTE: results truncated`, STOP**, with
   `failure_kind: "read_truncated"` and the NOTE as `error_message`. The Ken context holds more
   than 50 seeds and `get_items` does not page, so any count from here would be wrong. A loud
   failure beats a wrong count. If `get_items` errors, STOP with `failure_kind: "alfred_read"`.

   **No seeds at all:** N = 0. Go to Step 6 and close as `ok`. Do not call `get_ken_areas`.

2. `get_ken_areas` with `source_refs: [<every seed id from 3.1>]` and `limit: 50`. It returns
   **only** the areas whose `source_ref` is one of those ids. Keep the `source_ref` of each area
   that comes back. **Do not read all areas**: you only need to know which seeds are linked.

   `source_ref` is unique per user, so this can never return more areas than the ids you passed,
   and it cannot truncate. **If it ever starts with `NOTE: results truncated`, STOP anyway**,
   with `failure_kind: "read_truncated"`: something is wrong that this prompt does not
   understand. If it errors, STOP with `failure_kind: "ken_read"`.

### Step 4 — Count the unseeded seeds

A seed is **seeded** when its Alfred `id` is **exactly equal** to the `source_ref` of one of the
areas returned in 3.2. A seed with no area simply does not come back, and that absence is what
"unseeded" means. Let **N** be the number of unseeded seeds.

> ⚠️ **THE ID TYPES DIFFER, AND ONLY ONE COMPARISON IS MEANINGFUL.**
> - Alfred item ids are short **text**, e.g. `mtw2g9lb8cbs0xhsdij`.
> - `ken_areas.id` is a **uuid**. It is **never** compared to anything in this job.
> - `ken_areas.source_ref` is **text holding an Alfred id**. This is the only field you compare
>   against.
>
> Compare `item.id` with `source_ref` as exact, case-sensitive strings. **Never match on names.**
> An area whose name looks like a seed but whose `source_ref` is null does not seed it. A seed
> renamed in Alfred is still seeded if its id matches.

**N = 0:** go to Step 6 and close as `ok`. **Never raise a nudge for zero.**

### Step 5 — Nudge

1. Raise the nudge ("Raising an item", above), with:
   - the item's text, exactly this shape:

     ```
     Ken seed check — <N> new seed(s), <local_date>

     Ken: <N> new seeds in the Alfred Ken context. Read them, tell me what mode and accuracy each should get, then distill each into 2-3 items before we quiz.

     Seeds:
     - <name> (<alfred id>)
     - <name> (<alfred id>)
     ```

     The first line begins `Ken seed check —`, with an em dash.
   - `details.item` holds only `captured_text`, `source_app`, `source_metadata` and
     `ai_reasoning`. This is a nudge, not a capture to file, so there is no item, intent or event
     to suggest, **and no context either**: this row's only action is **Copy**.

   The dispatcher writes the item with `source_type: "task"`, so the row shows the task glyph, is
   titled `"<task_name> · <run_date>"`, offers **Copy** instead of **Process**, and is skipped by
   the hourly enrichment job. `task_name` is written as it reads: *Ken seed check*. The job slug
   stays `ken_seed_check`.

### Step 6 — Close the run

Call `update_platform_run` with the run id from Step 1. **One call.** A closed run cannot be
re-stamped, and `details` can only be written while closing.

- **`status`:** `ok` for every outcome in Steps 2–5 (off day, zero, nudged).
  `failed` **only** when a step said STOP.
- **`details`**, always: `run_day`, `local_date`, `weekday`. On a run day, also `seeds_read`,
  `areas_matched` (the number of areas 3.2 returned), `unseeded_count` (N), and `unseeded_ids`.
  When nudged, also `signal_id`, or `signal_error` when `raise_signal` failed. If this run was
  started by hand rather than by the schedule, add `manual: true`.
- **On `failed`:** `error_message` holds the **verbatim** error, and `details.failure_kind` is
  one of `alfred_read`, `ken_read`, `read_truncated`, `unknown`.

> 🛑 **A `failed` close REQUIRES both `error_message` and `details.failure_kind`. The tool
> rejects the write without them.** If it is rejected for that reason, supply them. **Never
> downgrade the status to get past it.** A failure logged without its cause cannot be told apart
> from one that failed for no reason.

If the close itself fails, report that verbatim in Step 8. The run stays `running`, which reads
as an orphan rather than as a success. That is the right way for this to be wrong. If the run
was closed `ok`, stop after Step 8. **Step 7 is for failures only.**

### Step 7 — Raise a failure item (failed runs only)

**An `ok` run skips this step entirely.** A failed run raises its failure item every time.
Never read earlier runs first: the dispatcher folds a repeat into the open item and counts it.

Raise it ("Raising an item", above, as a failure item), with item text of exactly this shape:

```
Ken seed check FAILED — <failure_kind>, <local_date>

<the verbatim error>

ACTION: <the action for this failure_kind, from the table below>
```

| `failure_kind` | ACTION |
|---|---|
| `run_open` | If the error is an **input validation error naming the allowed `app` values**: *"Redeploy the mcp function, then reconnect the Alfred connector so it refetches the tool manifest."* If it is a **Postgres check-constraint error**: *"platform_runs does not accept app 'ken' — check migration ken_003 is applied."* |
| `read_truncated` | If it came from **`get_items`**: *"The Alfred Ken context holds more than 50 seeds, and get_items does not page. This job cannot count correctly past 50 — needs a code change, not a retry. Triaging seeds out of the Ken context also clears it."* If it came from **`get_ken_areas`**: *"get_ken_areas truncated a source_refs read, which should be impossible because source_ref is unique per user. Needs investigation."* |
| `alfred_read`, `ken_read` | If the error mentions **JWT, token, auth or connector**: *"Reconnect the Alfred v5 connector. Use 'Use your own OAuth client' with client_id `2804f812-ea1a-4827-9443-3421fc4771f5` and a blank secret. Do NOT use 'No client ID — register one automatically'; dynamic registration fails on reconnect."* Otherwise: *"No known remedy for this error — needs investigation."* |
| `unknown` | *"No known remedy for this error — needs investigation."* |

**Never invent a remedy that is not in this table.** An honest "needs investigation" beats a
made-up instruction.

**If Step 1 could not create the run row**, add this line to the item: *"No run row exists for
this failure."*

The run is already closed, so its `signal_id` goes in the Step 8 report, not the run details.
If `raise_signal` fails here, report both errors verbatim in Step 8 and finish. When signals and
`platform_runs` sit behind the same broken connector, this is the one failure the task cannot
record; the Overwatch nightly's failure check sees a failed run with no failure signal.

### Step 8 — Report to the chat

Nobody may read this. Write it anyway, in exactly this shape:

```
Ken seed check — <local_date> (<weekday>)
  prompt version: 2026-11-06a
  run id: <id | none — run_open failed>
  run day: <yes | no — skipped>
  seeds read: <n>   areas matched: <n>
  unseeded: <n>   <names, if any>
  nudge: <raised | none — zero unseeded | none — off day | none — failed>
  status stamped: <ok | failed | NOT STAMPED — <why>>
  failure item: <n/a — ok run | raised | FAILED TO RAISE — <error>>
  signal: <none — no item | <signal_id> | not created — already raised today | FAILED — <error>>
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

- **No repeat handling.** It raises a nudge every run day with unseeded seeds. While a nudge is
  open the dispatcher folds the repeat into it: the item's list stays as of the day it was
  written, and its last line says how many times it has been seen since.
- **No name matching**, and no area creation. It counts and nudges, nothing else.
- **No notification on success.** See the table at the top.

**Linking an area created in conversation.** An area created without its seed's id as
`source_ref` leaves that seed "unseeded", and it is listed in every nudge. Fix it with
`update_ken_area id=<area uuid> source_ref=<alfred id>` rather than by creating a second area.

**Known ceiling: 50 seeds.** `get_items` caps at 50 and does not page, so past 50 seeds in the
Ken context Step 3 fails every run with `read_truncated` and raises a failure signal, which the
dispatcher folds into one item. That
is deliberate: a wrong count is worse than a loud failure. The areas side has no ceiling. The
`source_refs` read returns at most one area per seed passed, however many areas exist.

**Day-one check:** after the first scheduled firing, call `get_platform_runs` with `app: "ken"`,
`job: "ken_seed_check"` and confirm a run was stamped and closed.
