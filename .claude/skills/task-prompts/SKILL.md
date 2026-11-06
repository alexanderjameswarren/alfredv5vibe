---
name: task-prompts
description: "The rules every Alfred scheduled-task prompt follows: signals only, never a direct inbox item or notification, a stable subject_key, failures as signals, a platform run opened and closed every time, a PROMPT VERSION line. Load it whenever a scheduled-task prompt (a docs/*task-prompt*.md file, or the text of a claude.ai scheduled task) is written, changed or reviewed, or a new scheduled job is planned, in chat or in the CLI. Includes a checklist and a skeleton prompt."
---

# Task prompts

Skill version: 2026-11-06a

A scheduled task (DJ daily, Ken seed check, Money cleanup and the rest) runs the text pasted into
claude.ai. That text lives in a repo file in `docs/`. These rules come from the ten prompts at
2026-11-06a (notification routing, spec `docs/technical-spec-notification_routing-d7v.md`). A prompt
that breaks one is flagged by Overwatch's weekly run (Step 8b).

## The rules

1. **Signals only.** Everything the task wants Alex to see is one `raise_signal`. The inbox item it
   used to write goes in `details.item`: `{captured_text, source_app, source_metadata, ai_reasoning}`,
   `captured_text` required, no other keys. The dispatcher writes the item, folds repeats into it,
   and decides whether a notification goes too.
2. **Never** call `create_inbox_item`, `send_alfred_push`, `create_reminder` or
   `log_claude_notification`, and never send a Claude app push. Say so in the prompt's rules, as a
   prohibition ("Never call …"). The prompt's allowed-writes rule ("THE ONLY WRITES ALLOWED are …")
   must not list any of them: that list is what the weekly check reads as use.
3. **subject_key with no date**, lower case, `<app>:<job>:<what>`, so tomorrow's repeat folds into
   today's open item. The exception: a weekly report is new each week, so its key carries the date
   (`dj:weekly_review:report:<YYYY-MM-DD>`, `warren_buffet:wb_weekly_cleanup:week:<date>`), or this
   week's report would fold into last week's open one. `source_ref` is `<subject_key>:<date>`, so a
   re-run the same day raises nothing new.
4. **Failures are signals.** `details.kind: "failure"`, `severity: "high"`, a stable subject key
   (`<app>:<job>:failure` or `…:failure:<failure_kind>`), the error verbatim in the item. Raise it
   every time the run fails. A failed `raise_signal` never fails the run: note it in the run details.
5. **Who and where.** `started_by: "task:<slug>"` (the task's name, lower case, hyphens, e.g.
   `task:dj-weekly-review`), the signal's `app` and `job` the run's own, and `details.item.source_app`
   set to the app the item belongs to.
6. **A platform run every time.** `create_platform_run` (status `running`) first, `update_platform_run`
   once at the end, including when a step stops. A failed close needs `error_message` and
   `details.failure_kind`; never downgrade to `ok`. Record `prompt_version` in the details.
7. **A PROMPT VERSION line**, `PROMPT VERSION: YYYY-MM-DDx`, near the top of the file and in the prompt
   text, bumped (date and letter) on every change below the line, with one line saying what changed.
   The run's details and its last report line echo it, so a forgotten paste shows.
8. **No repeat handling.** Never read the inbox, earlier runs or earlier signals to decide whether to
   raise, and never word anything as "still failing" or "N runs in a row". The dispatcher counts
   repeats. (A task's own data is fine: SAM's write-once review note is the plan's state, not a repeat.)
9. **"THE PROMPT" line.** The file holds notes for people above `## THE PROMPT — everything below the
   line goes into the task`, and the task's text below it. Hand a prompt over from below that line.
10. **The one exception:** Overwatch's nightly dispatcher checks (count 13) write straight to the
    inbox with `create_inbox_item`, because the dispatcher may be what is broken. No other task, and
    no other Overwatch item, does.

Severity is the task's judgment, not a channel: `high` for what should reach Alex now (failures, a
nudge the plan says to send), `normal` for what can wait in the inbox, `low` for what is only worth
keeping. The delivery rules in Overwatch's plan turn that into hold, inbox or a notification.

## Checklist

- [ ] No `create_inbox_item`, `send_alfred_push`, `create_reminder` or `log_claude_notification`
      outside a "never" sentence; none in the allowed-writes rule.
- [ ] Every `raise_signal` has `app`, `job`, `severity`, `subject_key` (no date unless a weekly
      report), `title`, `started_by: "task:<slug>"`, `source_ref`, and `details.kind` (+ `item`).
- [ ] A failure path: high, `kind: "failure"`, stable key, verbatim error, raised every time.
- [ ] Run opened first and closed once, on every path; `prompt_version` in the close.
- [ ] PROMPT VERSION bumped, with a one-line change note; the report line echoes it.
- [ ] No reads of earlier runs, items or signals to decide whether to raise.
- [ ] "THE PROMPT" line in the file.
- [ ] After a change: hand the text over (an inbox item holding it, md5 checked) so Alex updates the
      scheduled task, then the file is checkpointed.

## Skeleton

```
# <Task name>. The Claude scheduled task prompt.

- **Schedule:** <cadence, Pacific time>. **App / job:** `<app>` / `<job>`, executor `claude`.
- **Edit rule:** change this file, then paste it into the task. Never edit the task alone.

> ### `PROMPT VERSION: YYYY-MM-DDa`
>
> Bump the date-letter whenever this file changes below the line.
>
> YYYY-MM-DDa: <what changed>.

---

## THE PROMPT — everything below the line goes into the task

---

You are running <task> for Alex. `PROMPT VERSION: YYYY-MM-DDa`. Follow these steps in order. Do not improvise.

### The rules that override everything else

1. **THE ONLY WRITES ALLOWED** are `create_platform_run`, `update_platform_run`, `raise_signal`
   <and this app's own writes, if any>.
2. **YOU ONLY RAISE SIGNALS.** Never call `create_inbox_item`, `send_alfred_push`, `create_reminder`
   or `log_claude_notification`, and never send a Claude app push. An item is one `raise_signal` that
   carries it in `details.item`; the dispatcher writes it and decides what reaches Alex.
3. **NO REPEAT HANDLING.** Never read earlier runs, items or signals to decide whether to raise.
4. **EVERY NUMBER COMES FROM A TOOL RESPONSE MADE IN THIS RUN.** **WHEN A CALL FAILS, QUOTE THE
   ERROR VERBATIM.** **NEVER IMPROVISE:** anything not covered, close the run `failed`.

### Step 1 — Open the run
`create_platform_run` with `app: "<app>"`, `job: "<job>"`, `executor: "claude"`, `status: "running"`.
Keep the run id.

### Step 2 … — <the work>

### Step N — Raise what needs Alex (only when something does)
`raise_signal`: `app: "<app>"`, `job: "<job>"`, `started_by: "task:<slug>"`, `severity: "normal"`,
`subject_key: "<app>:<job>:<what>"`, `title`, `body` (one line), `source_ref: "<subject_key>:<date>"`,
`details: { "kind": "flag", "item": { "captured_text": "<the item's text>", "source_app": "<app>",
"source_metadata": { "task_name": "<title>", "run_date": "<date>" } } }`. Keep the signal id.

### Step N+1 — Close the run (once, on every path)
On failure, first `raise_signal` with `severity: "high"`, `subject_key: "<app>:<job>:failure"`,
`details: { "kind": "failure", "item": { "captured_text": "<task> failed <date>\n<the error, verbatim>", … } }`.
Then `update_platform_run`: `status` ok, partial or failed (with `error_message` and
`details.failure_kind`), and `details.prompt_version: "YYYY-MM-DDa"`, `signal_id`.

### Report (one line)
`<task> YYYY-MM-DDa: <what happened>`.
```
