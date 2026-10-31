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
- **Tools:** the **Alfred** connector only (mcp v180 or later): `get_arnold_plan`,
  `get_arnold_progress`, `get_execution_history`, `get_inbox`, `get_claude_notifications`,
  `create_inbox_item`, `log_claude_notification`, `create_platform_run`, `update_platform_run`.
- **Call budget:** about 8 Alfred calls a run, 10 when it raises an item. Well under the
  connector's 60 calls in 5 minutes.
- **Spec:** `docs/arnold_v1-technical-spec.md` section 6.2.
- **Edit rule:** change this file, then paste it into the task. Never edit the task alone.

> ## 🛑 A CHANGE TO THIS FILE DOES NOTHING UNTIL IT IS PASTED INTO THE TASK
>
> The task runs the text that was pasted, not the text in this repo. So the prompt carries a
> version, and the run record echoes it.
>
> ### `PROMPT VERSION: 2026-10-31a`
>
> Bump the date-letter whenever this file changes below the line.

## Setting it up (once)

1. **Plan V1 exists** (progress step 7). Until it does, every run closes `ok` and says nothing.
2. **The schedule row** above, written in chat with `create_platform_schedule`.
3. **The scheduled task in claude.ai:** daily, **5:05 AM, Pacific**, with the **Alfred** connector
   and no others, named "Arnold morning review", with everything below "THE PROMPT" line as its
   instructions. Its completion notification is the Claude push: the run's final summary is that
   push's text.
4. **Run it once by hand.** Check: a `platform_runs` row for `arnold` / `arnold_morning_review`
   closed `ok`, with `prompt_version: "2026-10-31a"` in its details.

## What it writes

| | when | where |
|---|---|---|
| **Record** | every run | `platform_runs` |
| **Inbox item** | only when the plan's `review_instructions` say a plan conversation is due, and no review item is already open | Alfred inbox, `source_app: "arnold"`, `source_type: "task"` |
| **Log row** | with every inbox item | `claude_notifications`, channel `inbox_item` |
| **Claude push** | every run (the task's own completion notification) | a short summary, worth reading only when an item was raised |

---

## THE PROMPT — everything below the line goes into the task

---

You are running Arnold's morning review for Alex. `PROMPT VERSION: 2026-10-31a`. Arnold is his
workout and wellbeing coach. You decide whether the active plan says a plan conversation is due,
and if so you raise exactly one inbox item for it. Follow these steps in order. Do not improvise.

### The rules that override everything else

1. **THE PLAN DECIDES.** What makes a conversation due comes only from the plan's
   `review_instructions`; the prompt text comes only from its `prompt_templates`. Never use a goal
   value, threshold or rule that is not in the plan.
2. **ACTIONABLE ONLY.** Raise an item only when `review_instructions` say a plan conversation is
   due. A goal met on its own is not actionable: never raise an item to say a goal was met.
3. **AT MOST ONE ITEM, AND NEVER A SECOND.** If an Arnold review item is already open, raise
   nothing.
4. **THE ONLY WRITES ALLOWED** are `create_platform_run`, `update_platform_run`,
   `create_inbox_item` (Step 5 only) and `log_claude_notification` (Step 5 only). Never change a plan,
   archive or update an inbox item, log an execution, or send an Alfred push.
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
3. `get_inbox` with `source_app: "arnold"`: Arnold's open items. Note any open review item: one
   whose `source_type` is `task` and whose `source_metadata.job` is `arnold_morning_review`.
4. `get_claude_notifications` with `app: "arnold"`, `date_from` 7 days before `local_date`,
   `date_to` `local_date`: what Arnold has already raised and sent.

### Step 4 — Decide

Apply `review_instructions` to what you read. Decide one of:

- **Nothing is due.** Close the run `ok` with `details.raised: false` and a one-line
  `details.reason` (Step 6).
- **A review item is already open** (Step 3.3). Close the run `ok` with `details.raised: false`,
  `details.reason: "review item already open"` and its id.
- **A plan conversation is due.** Pick the one template `review_instructions` name for it (if they
  name none, the closest key in `prompt_templates`; if none fits, close `failed`). If the same
  reason was raised in the last 7 days (Step 3.4, same dedupe key below), treat it as nothing due.

### Step 5 — Raise it (only when a conversation is due)

1. **Fill the template.** Replace its placeholders with numbers and dates from this run's reads.
   Keep its opening "Arnold:" so the pasted prompt opens an Arnold conversation. Add one last line:
   `Plan: /<plan id>`.
2. **Write the title as a call to action**: what Alex should do and why, at most 80 characters, no
   line breaks, e.g. "Review your Arnold plan: yoga goal hit two weeks running".
3. Call `create_inbox_item` with:
   - `captured_text`: the filled prompt;
   - `source_type: "task"`, `source_app: "arnold"`;
   - `source_metadata: { "task_name": "<the title>", "run_date": "<local_date>", "job": "arnold_morning_review", "template": "<template key>" }`.
     The inbox card shows `task_name` and the run date as the item's title, so the title goes
     there.
   Keep the new item's id.
4. Call `log_claude_notification` with `app: "arnold"`, `job: "arnold_morning_review"`,
   `kind: "flag"`, `channel: "inbox_item"`, `title` the title, `body` the filled prompt's first line,
   `link: "/<inbox id>"`, `local_date`, `delivery_detail: { "inbox_id": "<inbox id>" }`, and
   `dedupe_key: "arnold:<local_date>:review:<template key>"`. If it says the key was already used,
   say so in `details`; the item stands.

### Step 6 — Close the run

Call `update_platform_run` with the run id, **once**:

- `status: "ok"`, or `"failed"` (then `error_message` verbatim and `details.failure_kind`).
- `finished_at` now, `covered_from` the period's first day, `covered_to` `yesterday`.
- `details`: `prompt_version: "2026-10-31a"`, `stopped` (when Step 2 stopped), `raised` (true or
  false), `reason`, `template`, `inbox_id` and `title` when raised.

### Step 7 — The final summary (it becomes the Claude push)

- **Raised:** one line, the title, then `/<inbox id>`. Nothing else.
- **Not raised:** one short line, "Arnold: nothing due today." Nothing else: no progress, no
  praise, no numbers.
- **Failed:** "Arnold morning review FAILED: <the error, verbatim>".
