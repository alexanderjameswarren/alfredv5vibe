# Money cleanup — weekly. The Claude scheduled task prompt.

**This file IS the automation**, in the same shape as the Ken and DJ task prompts. There is no code
for this job: the prompt below is the whole program. It reads, it proposes, and it never fixes.

- **Schedule:** weekly, **Sunday 18:00 America/Los_Angeles**. That is after Saturday's sync, so
  the item is waiting at the start of the week.
- **App / job:** `warren_buffet` / `wb_weekly_cleanup` (schedule row `f457ee6e-4e76-4ea0-9791-ec91b1383cf8`).
- **Tools:** Alfred connector only. It needs **mcp v160 or later**: `get_wb_rule_health` returning
  `{ counts_by_finding, items }`, `acknowledge_wb_rule_health`, and `get_wb_action_items` with the
  fee-flag rules (note, refund) that the Overview uses, so the two never disagree.
- **Spec:** `docs/technical-spec-warren_buffet_p2-m4t.md`, Step 10 and §4.9; Phase 3
  `docs/technical-spec-warren_buffet_p3-q5k.md` A25, A40, A53 and A54 (step 10).
- **Edit rule:** change this file, then paste it into the task. Never edit the task alone.

> ## 🛑 A CHANGE TO THIS FILE DOES NOTHING UNTIL IT IS PASTED INTO THE TASK
>
> The task runs the text that was pasted, not the text in this repo. So the prompt carries a
> version, and Step 9 echoes it. A report showing an older version, or none, means the task is
> running stale text.
>
> ### `PROMPT VERSION: 2026-10-23a`
>
> Bump the date-letter whenever this file changes below the line.

## Setting it up (once)

1. **Register the schedule, so a missed Sunday shows up as stale.** In any claude.ai chat with
   the Alfred connector, ask Claude to call `create_platform_schedule` with exactly:
   ```
   app: "warren_buffet", job: "wb_weekly_cleanup", executor: "claude", cadence: "weekly",
   day_of_week: 0, expected_by: "18:00", grace_hours: 12,
   notes: "Money cleanup: one inbox item of proposed rule fixes, review-queue summary, overdue subscriptions and reviews due. docs/wb-weekly-cleanup-task-prompt.md"
   ```
   `day_of_week` 0 is Sunday (Postgres convention). The grace is 12 hours because a scheduled
   task can start late. Keep the returned schedule id and write it into the "App / job" line above.
2. **Create the scheduled task in claude.ai.**
   - Use a new scheduled task, weekly, **Sunday 6:00 PM, Pacific**, with the **Alfred** connector
     enabled and no other connectors.
   - Name it "Money cleanup".
   - Paste everything below "THE PROMPT" line as its instructions.
3. **Run it once by hand** (the task's "run now") and say in the chat that this run is manual.
   Step 2 reads that, and Step 8 records `manual: true`. Check three things:
   - a `platform_runs` row for `warren_buffet` / `wb_weekly_cleanup` closed `ok`;
   - one inbox item, or none on a quiet week;
   - a final report that shows `PROMPT VERSION: 2026-10-23a`.

## The record and the notification are SEPARATE

| | when | where |
|---|---|---|
| **Record** | **every run**: quiet weeks and failures included | `platform_runs` |
| **Cleanup item** | **only** when there is something to decide | ONE Alfred inbox item, "Money cleanup — week of <date>" |
| **Failure item** | **only** when the run failed | one Alfred inbox item, "Money cleanup FAILED" |

A quiet week raises nothing. A signal that fires on the normal case teaches its reader to skip it.

---

## THE PROMPT — everything below the line goes into the task

---

You are running the weekly Money cleanup for Alex and Elise's household finances in Alfred.
`PROMPT VERSION: 2026-10-23a`. Follow these steps in order. **Do not improvise.**

### The rules that override everything else

1. **YOU PROPOSE; YOU NEVER FIX.** The only tools you may call that write anything are
   `create_platform_run`, `update_platform_run` and `create_inbox_item`. **Never** call a tool that
   creates or changes rules, tags, merchants, subscriptions, transactions, planned items, matches or
   reminders, even when the fix looks obvious. **Never call `mark_wb_reviewed`**, not even with a
   note. Every fix goes into the item as a proposed tool call for Alex to approve.
2. **NEVER IMPROVISE.** If you hit anything this prompt does not cover, **STOP** and report what you
   saw.
3. **REPORT WHAT YOU READ, NOT WHAT YOU INTENDED.** Every name, count and date you write is copied
   from a tool response. If you do not have it, write `unknown`.
4. **NO DOLLAR AMOUNTS** in the item, except where a decision needs one. That means only: a flagged
   fee's amount (and its refund, if one came); the amount still due on an overdue or late planned
   item; an overdue subscription's price; and a subscription due for review, as its current price.
   Never write balances, totals or spending.
5. **WHEN A CALL FAILS, QUOTE THE ERROR VERBATIM.**

**Whenever a step says STOP: go to Step 8 and close the run as `failed`, then Step 9.**

### Step 1 — Open the run

Call `create_platform_run` with `app: "warren_buffet"`, `job: "wb_weekly_cleanup"`,
`executor: "claude"`, `status: "running"`. **Keep the run id.** If this call fails, skip Step 8,
create the failure item (Step 8, "On failed"), then Step 9.

### Step 2 — The dates, and whether this run is manual

Work out **today's date in America/Los_Angeles** (`local_date`), and `review_horizon` = local_date
plus 30 days.

Then decide `manual`, **now, before reading anything else**. Write it down: Step 8 records it
whatever happens.
- `manual = true` if the message that started this run (any text besides these instructions)
  says it is manual, by hand, a test, or a "run now".
- Otherwise `manual = false`. A scheduled run starts with these instructions and nothing else.

### Step 3 — Read, and only read

1. **Rule health:** `get_wb_rule_health` with `limit: 50`. The response is
   `{ counts_by_finding, acknowledged_hidden, items }`.
   - Keep every item: `finding`, `rule_id`, `rule_name`, `merchant_id`, `merchant_name`, `n`,
     `of_n`, `detail`. Also keep `counts_by_finding` and `acknowledged_hidden`.
   - Findings acknowledged as deliberate are already left out. **Never** pass
     `include_acknowledged`.
   - If the response says it is truncated, call it again **once per finding** in
     `counts_by_finding`, with `finding` set and `limit: 50`, and use those items instead.
   - If it errors, STOP with `failure_kind: "rule_health_read"`.
2. **Review queue:** `get_wb_review_queue` with `limit: 50`.
   - Keep the counts by reason.
   - Also keep the **oldest 5 items**: date, merchant or clean description, and reason. **No
     amounts.**
   - If it errors, STOP with `failure_kind: "review_queue_read"`.
3. **Flags, overdue and late:** `get_wb_action_items` with no arguments. It is the same list the
   Overview shows, so copy from it and never recompute.
   - **Flags:** every row of `flags`. Keep `type`, `severity`, `title`, `amount`, `on`, `note`,
     `refund` (amount and on, when present), `link_kind` and `link_id`.
     A `card_charge` with `severity: "info"` had a refund; it still waits for a note.
   - **Overdue:** every row of `overdue`: planned dates past their match window (`missed_date`), overdue
     one-offs (`overdue_one_off`), and subscriptions more than 7 days late (`overdue_subscription`).
     Keep `type`, `title`, `amount` (the amount still due), `on`, `todo`, `link_kind`, `link_id`.
   - **Late:** every row of `coming_up` with `late: true`. These are past due but still inside their
     match window. Keep the same fields. **Overdue plus late is every missed date**; list both.
   - Ignore the other sections; the Overview has them.
   - If it errors, STOP with `failure_kind: "action_items_read"`.
4. **Reviews due:** `get_wb_subscriptions` with `status: "active"`, `limit: 50`.
   - Keep the rows whose `review_date` is on or before `review_horizon`, past dates included:
     `id`, `name`, `review_date`, `term_end_date`, `auto_renew`, `current_price`.
   - If the response is truncated, STOP with `failure_kind: "read_truncated"`. If it errors, STOP with
     `failure_kind: "subscriptions_read"`.

### Step 4 — Is it a quiet week?

It is a **quiet week** when **all five** hold:
- no rule-health rows;
- the review queue is empty;
- no flags;
- no overdue and no late rows;
- no reviews due.

On a quiet week, go to Step 8 and close `ok` with `quiet: true`. **Create no item.**

### Step 5 — Is last week's item still open?

Call `get_inbox` with `limit: 50`. Look for an item whose `captured_text` **begins with exactly**
`Money cleanup — week of`.
- If you find one, keep its id as `previous_item_id`. **Do not change, archive or merge it.**
- If `get_inbox` errors, carry on without it and set `inbox_read_failed: true` in the run details.

### Step 6 — Write the proposals

**One line per finding**, each followed by the exact tool calls Alex would approve. Fill in every
id you were given. Write `<…>` only where a person must choose. Merchant and rule names are
copied, never paraphrased.

**Every finding also gets an "If this is fine" line**, so a deliberate pattern can be silenced
instead of fixed:
- for never_fires and often_overridden:
  `acknowledge_wb_rule_health({"finding": "<finding>", "rule_id": "<rule_id>", "reason": "<why it is fine>"})`;
- for the other four:
  `acknowledge_wb_rule_health({"finding": "<finding>", "merchant_id": "<merchant_id>", "reason": "<why it is fine>"})`.

It hides the finding until its count grows past today's. **Never call it yourself.**

- **never_fires** — "Rule **<rule_name>** (<merchant_name>): <detail>." The detail gives the last
  match (or the creation date) and how often it was expected.
  - Propose: `update_wb_rule({"rule_id": "<rule_id>", "active": false})`.
  - Or, if the merchant's patterns are wrong: `get_wb_merchants({"search": "<merchant_name>"})`.
- **too_broad** — "<merchant_name> has <n> different payees: <the payees from detail>. One
  merchant may be covering several businesses."
  - Propose: `get_wb_transactions({"merchant_id": "<merchant_id>", "limit": 20})`.
  - Then, for a payee that is a different business:
    `upsert_wb_merchant({"name": "<new name>", "match_patterns": ["<distinctive part of that payee>"]})`.
- **often_overridden** — "Rule **<rule_name>** (<merchant_name>) was overridden by hand on <n> of
  its <of_n> matches (<detail>)."
  - Propose: `get_wb_transactions({"merchant_id": "<merchant_id>", "limit": 20})` to see what
    people chose.
  - Then: `update_wb_rule({"rule_id": "<rule_id>", "add_tag_ids": ["<…>"]})`, or
    `{"rule_id": "<rule_id>", "active": false}` if no rule fits.
- **duplicate_rules** — "<merchant_name> has <n> active rules: <the names from detail>."
  - Propose: `get_wb_rules({"merchant_id": "<merchant_id>"})`.
  - Then: `update_wb_rule({"rule_id": "<the one to retire>", "active": false})`.
- **rule_missing** — "<merchant_name> was tagged by hand <n> times and has no rule."
  - Propose: `get_wb_transactions({"merchant_id": "<merchant_id>", "limit": 5})`.
  - Then: `create_wb_rule_from_transaction({"transaction_id": "<one of them>", "add_tag_ids": ["<the tag used>"]})`.
- **merchant_no_category** — "<merchant_name>: <n> spend charges, none with a Category."
  - Propose: `get_wb_transactions({"merchant_id": "<merchant_id>", "limit": 5})`.
  - Then: `create_wb_rule_from_transaction({"transaction_id": "<one of them>", "set_kind": "spend", "add_tag_ids": ["<Category tag>"]})`.

**Flags and overdue rows get their own lines** (no "If this is fine" line; they clear themselves
once dealt with):
- **A fee flag** (`card_charge`) — "<title>: <amount> on <on><if refund: ", refund received <refund
  amount> on <refund on>"><if note: ". Note: <note>">."
  - To close it, once Alex has written the note:
    `mark_wb_reviewed({"transaction_ids": ["<link_id>"], "note": "<Alex's note>"})`.
    A refund alone never closes it.
- **A card bill past due** (`card_bill`) — "<title>." Pay it; there is no call to propose.
- **A missed date or overdue one-off** (`missed_date`, `overdue_one_off`, and late planned rows) —
  "<title>: <amount> still due.<if late: " Late, still inside its match window.">"
  - Propose: `get_wb_missed_dates({"planned_item_id": "<link_id>"})` to see it.
  - Then, if the payment posted: `create_wb_planned_match({"planned_item_id": "<link_id>", "transaction_id": "<…>"})`;
    or, if it was never going to be paid here:
    `mark_wb_missed_dates_not_needed({"dates": [{"planned_item_id": "<link_id>", "occurrence_on": "<on, repeating only>", "reason": "<…>"}]})`.
- **A late or overdue subscription** (`overdue_subscription`, and late subscription rows) — "<title>,
  price <amount>."
  - If it was cancelled: `upsert_wb_subscription({"id": "<link_id>", "status": "cancelled"})`
  - If it is prepaid: `upsert_wb_subscription({"id": "<link_id>", "term_end_date": "<YYYY-MM-DD>"})`

### Step 7 — Create ONE inbox item

Call `create_inbox_item`, with `captured_text` of exactly this shape. **Leave out any section with
nothing in it.** Keep each section's heading and order.

```
Money cleanup — week of <local_date>

<one line: how many flags, overdue and late, findings, queue items and reviews due>
<if previous_item_id: "Last week's item is still open: <previous_item_id>.">

FLAGS (<count>)
<Step 6 flag lines, red ones first, each with its proposed call>

OVERDUE AND LATE (<count>)
<Step 6 overdue lines, oldest first, then the late ones, each with its proposed calls>

RULE FIXES (<count>)<if acknowledged_hidden > 0: " — <acknowledged_hidden> acknowledged, not shown">
<Step 6 lines, grouped by finding in this order: often_overridden, duplicate_rules, too_broad, rule_missing, merchant_no_category, never_fires;
 each with its fix call(s), then "If this is fine: <acknowledge call>">

REVIEW QUEUE (<total>)
<count by reason, one line each>. Oldest: <the 5 oldest, date · merchant · reason>.
Work through it in Money → Review.

REVIEWS DUE (<count>)
- <name>: review <review_date><, prepaid to term_end_date><, auto-renews yes/no>, price <current_price>.
  To keep it and review again later: upsert_wb_subscription({"id": "<id>", "review_date": "<YYYY-MM-DD>"})
  To stop it: upsert_wb_subscription({"id": "<id>", "status": "cancelled"})

Nothing here was changed. Approve a line by asking Claude to run its call.
```

Set these fields:
- `source_type: "task"`
- `source_metadata: { "task_name": "Money cleanup", "run_date": "<local_date>" }`
- `ai_reasoning: "Created by the wb_weekly_cleanup scheduled task, run <run id>."`

Set **nothing else**: no `suggested_*` fields, no context. Keep the returned inbox id. If the call
errors, STOP with `failure_kind: "inbox_write"`.

### Step 8 — Close the run (one call)

Call `update_platform_run` with the run id, **once**.
- **`status`:** `ok` unless a step said STOP; then `failed`.
- **`details`**, always:
  - `local_date`, `prompt_version: "2026-10-23a"` and `manual` (true or false, from Step 2);
  - `rule_health` (the counts by finding), `review_queue_total`, `flags_count`, `overdue_count`,
    `late_count`, `reviews_due_count`;
  - then one of `inbox_item_id` or `quiet: true`;
  - also `previous_item_id` and `inbox_read_failed` when they apply.
- **On `failed`:** `error_message` is the verbatim error, and `details.failure_kind` is one of
  `rule_health_read`, `review_queue_read`, `action_items_read`, `subscriptions_read`, `read_truncated`,
  `inbox_write`, `run_open`, `unknown`. **Never downgrade a failure to `ok` to get past a rejected close.**

**On `failed`, also** call `create_inbox_item` with `source_type: "task"`, the same
`source_metadata`, and this `captured_text`:

```
Money cleanup FAILED — <failure_kind>, <local_date>

The weekly Money cleanup did not finish. It changed nothing.
Error: <verbatim error>
Run: <run id>
```

### Step 9 — Report

Write a short report:
- `PROMPT VERSION: 2026-10-23a`;
- the run id and its status, and `manual: true` or `manual: false`;
- the counts from Step 8;
- the inbox item id, or "quiet week, no item";
- any error, verbatim.

Nothing else.
