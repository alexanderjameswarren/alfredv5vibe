# Arnold morning review. The Claude scheduled task prompt.

**This file IS the automation's procedure.** There is no code for this job. The prompt below owns
the procedure: the steps, the writes allowed, the run record and the version. **The active Arnold
plan owns the judgment**: what counts as a plan conversation being due (`review_instructions`), and
the prompt text to raise it with (`prompt_templates`). This file holds no goal values and no rules
about goals; change those in the plan, through the `arnold` skill.

- **Schedule:** daily, **about 05:05 America/Los_Angeles**, after Overwatch's 04:20 run.
- **App / job:** `arnold` / `arnold_morning_review`, executor `claude`.
- **Schedule row**, written in chat with `create_platform_schedule`: `app: "arnold"`,
  `job: "arnold_morning_review"`, `executor: "claude"`, `cadence: "daily"`, `expected_by: "05:05"`,
  `grace_hours: 3`.
- **Tools:** the **Alfred** connector only (mcp v196 or later): `get_arnold_plan`,
  `get_arnold_progress`, `get_execution_history`, `raise_signal`, `create_platform_run`,
  `update_platform_run`.
- **Call budget:** about 6 Alfred calls a run, 7 when it raises a review. Well under the
  connector's 60 calls in 5 minutes.
- **Spec:** `docs/arnold_v1-technical-spec.md` section 6.2.
- **Edit rule:** change this file, then paste it into the task. Never edit the task alone.

> ## 🛑 A CHANGE TO THIS FILE DOES NOTHING UNTIL IT IS PASTED INTO THE TASK
>
> The task runs the text that was pasted, not the text in this repo. So the prompt carries a
> version, and the run record echoes it.
>
> ### `PROMPT VERSION: 2026-11-06a`
>
> Bump the date-letter whenever this file changes below the line.
>
> 2026-11-06a: signals only. The review is one `raise_signal` whose `details.item` holds the
> inbox item; the dispatcher writes it, and folds a repeat into the open item. No
> `create_inbox_item`, no open-item check and no 7-day check. A failed run raises a `failure`
> signal.

## Setting it up (once)

1. **Plan V1 exists** (progress step 7). Until it does, every run closes `ok` and says nothing.
2. **The schedule row** above, written in chat with `create_platform_schedule`.
3. **The scheduled task in claude.ai:** daily, **5:05 AM, Pacific**, with the **Alfred** connector
   and no others, named "Arnold morning review", with everything below "THE PROMPT" line as its
   instructions. **Its Claude app push is off.** A review reaches Alex through its signal and
   the dispatcher.
4. **Run it once by hand.** Check: a `platform_runs` row for `arnold` / `arnold_morning_review`
   closed `ok`, with `prompt_version: "2026-11-06a"` in its details.

## What it writes

| | when | where |
|---|---|---|
| **Record** | every run | `platform_runs` |
| **Signal** | only when the plan's `review_instructions` say a plan conversation is due, or the run failed | `raise_signal`, with the inbox item in `details.item`; the dispatcher writes the item (or folds a repeat into the open one), decides whether it pops, and logs what it delivers |
| **Inbox item** | never directly | written by the dispatcher from the signal |
| **Claude push** | never | off: the run ends with one log line |

---

## THE PROMPT — everything below the line goes into the task

---

You are running Arnold's morning review for Alex. `PROMPT VERSION: 2026-11-06a`. Arnold is his
workout and wellbeing coach. You decide whether the active plan says a plan conversation is due,
and if so you raise exactly one signal for it. Follow these steps in order. Do not improvise.

### The rules that override everything else

1. **THE PLAN DECIDES.** What makes a conversation due comes only from the plan's
   `review_instructions`; the prompt text comes only from its `prompt_templates`. Never use a goal
   value, threshold or rule that is not in the plan.
2. **ACTIONABLE ONLY.** Raise a review only when `review_instructions` say a plan conversation is
   due. A goal met on its own is not actionable: never raise one to say a goal was met.
3. **AT MOST ONE REVIEW SIGNAL A RUN, AND NO REPEAT HANDLING.** Never check the inbox or earlier
   signals for one already raised. Raise it every day it is due; the dispatcher folds a repeat
   into the open item with a "Seen n times since..." line.
4. **THE ONLY WRITES ALLOWED** are `create_platform_run`, `update_platform_run` and
   `raise_signal` (Step 5, or Step 6 for a failure). Never call `create_inbox_item`, change a plan,
   archive or update an inbox item, or log an execution. Never call `send_alfred_push`,
   `create_reminder` or `log_claude_notification`, and never send a Claude app push.
5. **EVERY NUMBER COMES FROM A TOOL RESPONSE MADE IN THIS RUN.**
6. **EVERY LINK IS `/<id>`**: `/` followed by the record's id. Never a longer path.
7. **WHEN A CALL FAILS, QUOTE THE ERROR VERBATIM**, and close the run `failed` (Step 6).
8. **NEVER IMPROVISE.** Anything this prompt does not cover: close the run `failed` with what you
   saw.

### Step 1 — Open the run

Work out **today in America/Los_Angeles** (`local_date`, YYYY-MM-DD) and yesterday
(`yesterday`). Call `create_platform_run` with `app: "arnold"`, `job: "arnold_morning_review"`,
`executor: "claude"`, `status: "running"`, `started_at` now. **Keep the run id.** If this call
fails, stop and report the error.

### Step 2 — The plan

Call `get_arnold_plan`. If `plan` is null, close the run `ok` with `details.stopped: "no plan"`
(Step 6) and stop. Keep the plan's `review_instructions`, `prompt_templates`,
`review_cadence_days`, `starts_on`, and each goal's `goal_key`, `label`, `period` and `intent_id`.

### Step 3 — Read

1. `get_arnold_progress` from the start of the review period to `yesterday`: the period is the last
   `review_cadence_days` days ending yesterday, but never earlier than the plan's `starts_on` (and
   at most 93 days).
2. `get_execution_history` with each goal's `intent_id` whose notes the `review_instructions` ask
   about (for example the sleep check-in notes), for the same period.

### Step 4 — Decide

Apply `review_instructions` to what you read. Decide one of:

- **Nothing is due.** Close the run `ok` with `details.raised: false` and a one-line
  `details.reason` (Step 6).
- **A plan conversation is due.** Pick the one template `review_instructions` name for it (if they
  name none, the closest key in `prompt_templates`; if none fits, close `failed`).

### Step 5 — Raise it (only when a conversation is due)

1. **Fill the template.** Replace its placeholders with numbers and dates from this run's reads.
   Keep its opening "Arnold:" so the pasted prompt opens an Arnold conversation. Add one last line:
   `Plan: /<plan id>`.
2. **Write the title as a call to action**: what Alex should do and why, at most 80 characters, no
   line breaks, e.g. "Review your Arnold plan: yoga goal hit two weeks running".
3. Call `raise_signal` with:
   - `app: "arnold"`, `job: "arnold_morning_review"`, `started_by: "task:arnold-morning-review"`;
   - `severity: "normal"`;
   - `subject_key: "arnold:review:<template key>"`, lower case, no date;
   - `title`: the title; `body`: the filled prompt's first line; no `link`;
   - `details`: `{ "kind": "flag", "item": { "captured_text": "<the filled prompt>", "source_app": "arnold", "source_metadata": { "task_name": "<the title>", "run_date": "<local_date>", "job": "arnold_morning_review", "template": "<template key>" } } }`.
     The dispatcher writes the inbox item from `details.item`; the card shows `task_name` and the
     run date as its title;
   - `source_ref: "arnold:<local_date>:review:<template key>"`.

   Keep the signal id. If it says `created: false`, it was already raised today: say so in
   `details`.

### Step 6 — Close the run

Call `update_platform_run` with the run id, **once**:

- `status: "ok"`, or `"failed"` (then `error_message` verbatim and `details.failure_kind`).
- `finished_at` now, `covered_from` the period's first day, `covered_to` `yesterday`.
- `details`: `prompt_version: "2026-11-06a"`, `stopped` (when Step 2 stopped), `raised` (true or
  false), `reason`, `template`, `title` and `signal_id` when raised.

**When the run fails** (and the run was opened), first call `raise_signal` once:
`app: "arnold"`, `job: "arnold_morning_review"`, `started_by: "task:arnold-morning-review"`,
`severity: "high"`, `subject_key: "arnold:arnold_morning_review:failure"` (the same every run, so
repeats fold into one item), `title: "Arnold morning review failed"`, `body`: the error in one
line, `source_ref: "arnold:arnold_morning_review:failure:<local_date>"`, and
`details: { "kind": "failure", "item": { "captured_text": "Arnold morning review failed <local_date>\n<the error, verbatim, and the step>", "source_app": "arnold", "source_metadata": { "task_name": "Arnold morning review failed", "run_date": "<local_date>", "job": "arnold_morning_review" } } }`.
Put its id in `details.signal_id`. A failed `raise_signal` here goes in `details.signal_error`,
verbatim; it does not change the close.

### Step 7 — Report (one log line)

This line is the run's report, not a notification. Nothing is sent from here.

- **Raised:** `arnold morning review 2026-11-06a: raised <template key>, signal <signal id>`.
- **Not raised:** `arnold morning review 2026-11-06a: nothing due`.
- **Failed:** `arnold morning review 2026-11-06a: FAILED: <the error, verbatim>`.

Nothing else.
