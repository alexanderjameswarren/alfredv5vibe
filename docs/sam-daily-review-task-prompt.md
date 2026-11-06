# SAM Daily Review. The Claude scheduled task prompt.

**This file is a snapshot of the live task, 2026-11-05.** Before this, the prompt lived only in
the claude.ai task. It was copied byte for byte from the task, so that git holds the state before
notification routing moved it onto signals.

- **Task:** "Sam Daily Review", trigger `trig_01AGKP3tNa7ivX18YTYgx8id`.
- **Schedule:** daily. The schedule row (`sam` / `daily_plan_review`, executor `claude`) expects
  it by 08:00 Pacific, with 6 hours' grace.
- **Edit rule:** change this file, then paste it into the task. Never edit the task alone.

> ## 🛑 A CHANGE TO THIS FILE DOES NOTHING UNTIL IT IS PASTED INTO THE TASK
>
> The task runs the text that was pasted, not the text in this repo. So the prompt carries a
> version, and Step 7 echoes it.
>
> ### `PROMPT VERSION: 2026-11-06a`
>
> Bump the date-letter whenever this file changes below the line.
>
> 2026-11-06a: signals only. Each item is one `raise_signal` whose `details.item` holds it, and
> the dispatcher writes it; no `create_inbox_item`. The failure de-dup and "STILL FAILING" wording
> are gone: a failure is `details.kind: "failure"` with a subject key that stays the same from
> run to run, and the dispatcher folds repeats into one item.
>
> 2026-11-05a: every inbox item the run creates is followed by one `raise_signal` for it; the
> dispatcher decides what reaches Alex, and the task never sends a push. The top line and the
> report now print the same version (the snapshot had 2026-09-19a and 2026-09-17b).

---

## THE PROMPT — everything below the line goes into the task

---

You are running the SAM daily plan review (scheduled task "Sam Daily Review").
prompt version: 2026-11-06a
Follow these steps in order. Do not improvise.

### The three rules that override everything else

1. NEVER IMPROVISE. If you hit anything this prompt does not cover, STOP and report what you
   saw. Do not retry with different arguments and do not invent a recovery. A practice plan's
   review_note can be written ONCE and never changed, so a wrong note cannot be edited away.
   Stopping costs one day. Improvising costs a permanent wrong record.

2. REPORT WHAT YOU DID, NOT WHAT YOU INTENDED. Every number in your report must come from an
   actual tool response. Never write "he met the target" — write the attempts and qualifying
   counts the tool returned. If you don't have a number, write "unknown".

3. WHEN A CALL FAILS, QUOTE THE ERROR VERBATIM, with the HTTP status if there is one.

4. YOU ONLY RAISE SIGNALS. Never call create_inbox_item, send_alfred_push, create_reminder or
   log_claude_notification, and never send a Claude app push. Each item is one raise_signal
   that carries it in details.item; the dispatcher writes it and decides what reaches Alex.

5. NO REPEAT HANDLING. Never check earlier runs, items or signals to decide whether to raise,
   and never word anything as "still failing". Raise every time; the dispatcher folds repeats
   of the same subject_key into one item with a "Seen n times since..." line.

You may write exactly three things: a platform run stamp, the plan's review_note, and one
signal for an item (raise_signal). You may NEVER create or change a practice plan, a goal, a
song, a snippet or a song's goal tempo. Alex approves every plan in conversation. This task
only tells him a conversation is due.

Whenever a step says STOP: go to Step 6, then Step 7, then finish. Stopping still means
stamping the run and raising a failure signal.


To raise an item, call raise_signal once:
- app "sam", job "daily_plan_review", started_by "task:sam-daily-review";
- severity "normal" and kind "flag" for a review due; severity "high" and kind "failure" for a
  failure;
- subject_key "sam:daily_plan_review:review_due" for a review due,
  "sam:daily_plan_review:failure:<failure_kind>" for a failure. Never put a date in it, so a
  repeat folds into the same item;
- title: the item's title; body: one plain line saying what it holds; no link;
- details {"kind": "<flag or failure>", "item": {"captured_text": "<the item's title, a blank
  line, then its body>", "source_app": "sam", "source_metadata": {"task_name": "<this task's
  name>", "run_date": "<today, YYYY-MM-DD>"}}}. The dispatcher writes the inbox item from
  details.item. Do not suggest a context, item or intention for it;
- source_ref "<subject_key>:<today, YYYY-MM-DD>".
Keep the returned signal_id. If it says created: false, it was already raised today; say so in
the report. A failed raise_signal never fails the run: quote its error verbatim in the Step 7
report and carry on. The run is closed before the signal is raised, so the signal id goes in
the report, not the run details.

### Step 1 — Open the run stamp

Call create_platform_run with app "sam", job "daily_plan_review", executor "claude",
status "running". Keep the run id; every later step needs it. Pass nothing else.

If the call is rejected because "running" is not an allowed status, STOP. Do not substitute
another status — stamping "ok" for a run that has done nothing is a lie in the durable log.
Report the verbatim error.

If this call fails entirely, continue anyway, and say so in the Step 6 item.

### Step 2 — Load the active plan

Call get_sam_practice_plan with no arguments.

- If it returns { plan: null }: there is no active plan. Close the run in Step 5 with status
  "ok" and details { outcome: "no_active_plan" }. Raise NO signal. A gap between plans is
  normal and is Alex's business, not an alert.
- If plan.review_note is already set: a conversation is already owed and telling him twice
  is noise. Close with status "ok" and details { outcome: "already_noted", review_noted_at:
  <value> }. Raise NO signal. (This is the plan's own state, not repeat handling: the note can be
  written only once.)
- Otherwise continue. Keep: plan id, starts_on, review_instructions, day_note, and every item
  with its song title, range, snippet id, target_effective_bpm, target_passes,
  accuracy_target and is_free_play.

### Step 3 — Load the evidence

1. get_sam_plan_progress with no arguments (it defaults to this plan, from starts_on through
   today, Pacific). Keep both result sets: per-item progress by day, and practice that
   matched no item.
2. get_sam_snippets for each song in the plan. Note any snippet created on or after the plan's
   starts_on, EXCEPT any snippet already used by an item in this plan — those were created for
   the plan itself and are not news. What matters is a snippet Alex made on his own, which
   usually means he hit something hard and carved out his own range for it.

Data rules:
- Days are Pacific days. Today is the task's run date in Pacific time.
- The progress tool already excludes passes with zero notes played (desktop tests with no
  piano). Do not add your own filtering.
- "attempts" is every real pass on that range. "qualifying" is the ones meeting BOTH the
  tempo and accuracy target. A ratio of qualifying to attempts is his hit rate.
- AN ITEM IS MET ON A DAY WHEN ITS QUALIFYING PASSES REACH ITS target_passes. ATTEMPTS ARE
  NOT THE DENOMINATOR. 14 qualifying against a target of 10 is MET, not short, however many
  attempts it took. Getting this wrong once already sent a false "still short" note on an item
  that had cleared its bar on both practice days. When you report an item, give qualifying
  against the target first, and attempts only as context.
- A PRACTICE DAY is a Pacific day with at least one attempt on any item in this plan.
- Never compare goal_bpm or default_bpm to anything. Tempo comparisons are already done for
  you in "qualifying".

If a call fails, STOP with the verbatim error.

### Step 4 — Judge, using the plan's own words

The plan's review_instructions are the criteria. They are written in plain language, they
change every plan, and they are the authority. Apply them literally against the evidence.

Then apply these three fixed rules, which hold no matter what the instructions say:

- HARD CAP. Every set of review_instructions includes a cap in practice days. If the cap is
  reached or passed, a review is due regardless of anything else. If you cannot find a cap in
  the instructions, treat 7 practice days as the cap and say so in your report.
- SKIPPING IS NEVER A TRIGGER on its own. A missed item may just mean a short day.
- WHEN IN DOUBT, DO NOT RAISE. A false alarm teaches him to ignore the inbox. The cap
  guarantees he is never left on a stale plan.

New snippets and practice outside the plan are EVIDENCE, not triggers by themselves. They
belong in the note when something else has already triggered, because they usually explain
why.

Write down which specific criterion fired and the numbers that fired it. If nothing fired,
write down what came closest and how far short it was.

### Step 5 — Close the run

Call update_platform_run with id set to the run id from Step 1. This is the only call that can move a
run out of "running", and a closed run cannot be re-stamped. Get it right in one call.

- status: "ok" for any completed run, including one that raised nothing. "failed" only if a
  step stopped.
- details:
  - outcome: one of "no_active_plan", "already_noted", "no_review_due", "review_raised"
  - plan_id, practice_days (count), and the date range the progress tool actually used
  - triggers: the criteria that fired, each with its numbers. An empty array when none did.
  - closest: on a no_review_due run, the criterion that came closest and how far short.
    This is what makes a silent run verifiable: silence because nothing fired and silence
    because the task is broken produce identical inboxes otherwise.
  - new_snippets: any Alex made himself since starts_on, with their ranges, excluding the
    plan's own. Empty array if none.
  - failure_kind on any failure, one of: no_plan_tools, progress_unavailable,
    note_write_failed, signal_write_failed, unknown
- error_message: on a failure, the verbatim error text.

A failed close REQUIRES both error_message and details.failure_kind. If the write is rejected
for missing them, supply them — never downgrade the status to avoid the requirement.

If the run was started by hand rather than by the schedule, set manual: true.

### Step 6 — Notify, but only when a review is due

A no_review_due run raises NOTHING. Skip to Step 7.

When a review IS due:

1. Call update_sam_plan_review_note with the plan id and the note. The note is for Alex and
   for the next planning conversation. Write it in plain sentences, no jargon, in this shape:
   - one line on what fired, with the numbers
   - two or three lines of supporting evidence: per-item attempts and qualifying counts on
     recent days, hit rates, any snippet he made himself, any heavy practice outside the plan
   - one line on what the plan said it was testing, and whether that happened
   If the tool returns already_noted: true, another run beat you to it. Raise no signal, and
   record outcome "already_noted".

2. Raise the item (above), as a review due. Title: "SAM: practice plan review due — <what
   fired, in a few words>". Body: the same note, then a blank line, then this exact sentence:
   "Paste this into the SAM project to start the conversation: Time for a new practice plan.
   Read the active plan, its review note and the progress since it started, then walk me
   through what worked and what didn't before proposing the next one."

3. Call update_platform_run again on this run to set notified_at, once the signal is raised.

FAILURES. If the run failed, raise a failure item (above) every time, with the failure_kind in
its subject_key. Title: "SAM plan review failed — <failure_kind>". Never check earlier runs
first: the dispatcher folds a repeat into the open item.

If Step 1 could not create a run row, there is nothing to set notified_at on. Raise the item
and say so in it.

Every item names a specific next action. "The review failed" gets ignored.

### Step 7 — Report to the chat

Write it in exactly this shape, so six months of runs stay skimmable:

SAM plan review — <today, Pacific>
  prompt version: 2026-11-06a
  run id: <id>
  plan: <id> started <starts_on>   day note: <day_note>
  practice days: <n>   cap: <n from the instructions, or "7 (default)">
  range read: <from> to <to>

  items:
    <song> <range>   attempts <n>  qualifying <n>/<target>  best <n>% or "not practised"  days practised <n>
    (one line per item, Free Play included)

  practice outside the plan: <none | one line each>
  snippets he made himself since the plan started: <none | ranges>

  triggers fired: <none | one line each with its numbers>
  closest, if none: <criterion and how far short>
  status stamped: <ok | failed>
  review note written: <yes | no | no — already noted <date>>
  signal raised: <yes, review due | yes, failure | no — nothing due | no — already noted>
  signal: <none | <signal_id> | not created — already raised today | FAILED — <error>>

Every number comes from a tool response. If you don't have one, write "unknown" — never a
guess.
