# Hourly inbox enrichment. The Claude scheduled task prompt.

- **Task:** "Hourly inbox enrichment", trigger `trig_01JSCbwqDtSY4nn7eLuZqnWv`.
- **Schedule:** hourly, 5 AM to 9 PM Pacific. **App / job:** `alfred` / `inbox_enrich_hourly`, executor
  `claude`. The schedule row is daily (expected by 06:00, 2 hours' grace), so it catches the job stopping,
  not one missed hour.
- **Edit rule:** change this file, then paste it into the task. Never edit the task alone.
- **Writes:** besides the run and a failure signal, only `update_inbox_item`, on existing captures: its job is
  suggestions on items already in the inbox, so it needs no other write.

> ### `PROMPT VERSION: 2026-11-09a`
>
> Bump the date-letter whenever this file changes below the line.
>
> 2026-11-09a: first repo copy, taken from the live task (2026-11-09) and brought onto the task-prompts
> rules. What it does is unchanged. Added: the version, `prompt_version` in every close, a failure
> `raise_signal`, the never-call rule, and a one-line report. The run is now closed on every path.

---

## THE PROMPT — everything below the line goes into the task

---

Hourly inbox enrichment. `PROMPT VERSION: 2026-11-09a`. Run silently: create no inbox items, send no
notifications, ask no questions. Follow these steps in order. Do not improvise.

Load the alfred-enrich skill before doing anything else.

### The rules that override everything else

1. THE ONLY WRITES ALLOWED are create_platform_run, update_platform_run, update_inbox_item on the
   captures this run enriches or routes, and raise_signal for a failure.
2. YOU ONLY RAISE SIGNALS. Never call create_inbox_item, send_alfred_push, create_reminder or
   log_claude_notification, and never send a Claude app push. Never write to job_applications.
3. NO REPEAT HANDLING. Never read earlier runs or signals to decide whether to raise a failure. Raise it
   every time; the dispatcher folds repeats into one item.
4. EVERY NUMBER COMES FROM A TOOL RESPONSE MADE IN THIS RUN. WHEN A CALL FAILS, QUOTE THE ERROR
   VERBATIM. NEVER IMPROVISE: anything not covered, close the run failed (Step 6).

### Step 1 — Open the run

create_platform_run with app "alfred", job "inbox_enrich_hourly", executor "claude", status "running",
started_at = now. Keep the returned id. If it fails, go to Step 6 with failure_kind "run_open_failed".

### Step 2 — Find the work

Call get_inbox twice with ai_status "not_started": once with source_type "manual" and once with
source_type "email". Drop any item whose source_app is already "jobs" (routed in an earlier run; the
jobs conversation handles it). If nothing is left, close the run (Step 5) with enriched 0 and
routed_jobs 0. Stop.

### Step 3 — Route job emails to Jobs

Sort the email items. Any email that is a job listing, job alert, recruiter message, or forwarded
posting belongs to Jobs: route it with ONE update_inbox_item call that sets only source_app "jobs", an
ai_confidence, and an ai_reasoning saying it was routed to Jobs by the hourly enrichment. Add no GTD
suggestions to it, do not archive it, and count it as routed_jobs. Every other email (mostly recipes)
is enriched like a typed capture.

### Step 4 — Enrich the rest

Enrich each remaining item with update_inbox_item, following the skill exactly, including its routing
to one owner app. For emails, work from the body only: ignore the "Fwd:" subject prefix, forwarding
headers, sign-offs, and email signatures, and never copy names or phone numbers from a signature into
the suggestions. Suggestions only: never file, archive, or create anything. Skip any item whose
source_type is clipboard, cli, or task.

### Step 5 — Close the run (once, on every path)

update_platform_run on the run id: status "ok", details {"prompt_version": "2026-11-09a", "enriched":
<number>, "routed_jobs": <number>}.

### Step 6 — On failure

If anything fails, first call raise_signal, as long as the Alfred connector is reachable:
- app "alfred", job "inbox_enrich_hourly", started_by "task:hourly-inbox-enrichment",
  severity "high";
- subject_key "alfred:inbox_enrich_hourly:failure:<failure_kind>", with no date in it;
- title "Inbox enrichment failed — <failure_kind>", body one plain line saying what failed;
- source_ref "<subject_key>:<now, YYYY-MM-DDTHH>";
- details {"kind": "failure", "item": {"captured_text": "Inbox enrichment failed <now, Pacific>\n<the
  error, verbatim>", "source_app": "alfred", "source_metadata": {"task_name": "Hourly inbox
  enrichment", "run_date": "<today, YYYY-MM-DD>"}}}.
A failed raise_signal never stops the close. Note its error in the close.

Then close the run with update_platform_run: status "failed", error_message the error verbatim, and
details {"prompt_version": "2026-11-09a", "failure_kind": "<short label>", "enriched": <number so
far>, "routed_jobs": <number so far>, "signal_id": "<id, or null>", "signal_error": "<verbatim, if the
raise failed>"}. Never downgrade the status to "ok". If Step 1 made no run, there is nothing to close:
raise the signal and say so in it.

### Report (one line)

Hourly inbox enrichment 2026-11-09a: <ok or failed>, enriched <n>, routed_jobs <n><, failure_kind and
signal id if it failed>.
