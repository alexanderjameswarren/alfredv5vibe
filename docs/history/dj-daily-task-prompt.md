# DJ — daily history sync. The Claude scheduled task prompt.

**This file IS the automation.** There is no code to inspect: the prompt below is the
entire program. It is written to be read cold, months later, by someone debugging a run
that misbehaved. Length here is deliberate — compression would cost exactly the context a
cold reader needs.

- **Schedule:** daily, **3:30 am Pacific** (10:30 or 11:30 UTC), so it lands before the Drive Mix
  refresh at 3:54. Moved from 17:00 UTC on 2026-10-11, and from 4:30 to 3:30 on 2026-10-25. Still far from the UTC midnight boundary
  that governs how YouTube buckets history — a run near 00:00 UTC risks the feed rolling
  over mid-request, with some entries answered under one UTC day and some under the next
  and no way to tell which afterwards.
- **App / job:** `dj` / `daily_history_sync`, registered in `platform_schedules` (expected by 03:30
  Pacific, 6 hours' grace) since Overwatch Step 8.
- **Edit rule:** change this file, then paste it into the task. Never edit the task alone,
  or this file becomes a description of something that no longer exists.

> ## 🛑 A CHANGE TO THIS FILE DOES NOTHING UNTIL IT IS PASTED INTO THE TASK
>
> The task runs the text that was pasted, not the text in this repo. Editing here and
> stopping is a change that appears done and is not — the same shape as a deploy that
> reports success without the caller being able to reach it (spec §11.15).
>
> **It has already happened.** The `known disagreements` line was added to Step 8 to make a
> silent run distinguishable from a broken one, and the very next run did not print it,
> because the task was still running the previous text. **The one line whose job was to
> prove the pipeline ran was itself absent for the reason it exists to detect.**
>
> **So the prompt now carries a version, and the task must echo it.**
>
> ### `PROMPT VERSION: 2026-11-05a`
>
> 2026-11-05a: every inbox item the run creates (failed or partial) is followed by one
> `raise_signal` for it; the dispatcher decides what reaches Alex, and the task never sends a push.
>
> 2026-10-13a: a quiet day (no `Today` or `Yesterday` plays) is a normal `ok` run that skips
> the write and never raises an item; confirmed quiet days are recorded as `empty_days` and
> extend coverage in Step 3. The prompt below is a snapshot of the live task, 2026-11-05
> (trigger `trig_01EEaPPhygaPeybVvitpTq8k`); the repo had held 2026-10-06a until then.
>
> 2026-10-06a: artist disagreements are logged and counted only, never raised as an inbox
> item; `notified_video_ids` is always `[]`. Only failed or partial runs raise items.
>
> Step 8 prints this string. If the report shows an older version — or none — **the task is
> running stale text and its output cannot be trusted to reflect these rules.** That makes a
> forgotten paste visible in the report instead of discoverable weeks later.
>
> Bump the date-letter whenever this file changes below the line.

## The record and the notification are SEPARATE, deliberately

| | when | where |
|---|---|---|
| **Record** | **every run**, success or failure | `platform_runs` — the durable log the staleness check reads |
| **Notification** | **only** failure or `partial` — never artist disagreements (logged in the run, not raised) | one Alfred **inbox item** |

A repeat of an unfixed condition is re-raised **once a week**, worded as ongoing — see
Step 7. **A clean run raises nothing.** A signal that fires on the normal case teaches its reader
to skip it — the same principle that stopped `artist_disagreements` firing on every
collaboration (spec §11.7), applied to a human inbox rather than to a tool. A daily "the
sync worked" would train exactly the reflex that makes the one broken day invisible.

The inbox is the surface actually checked daily. **The task's chat output is not a
notification channel** — assume nobody reads it.

---

## THE PROMPT — everything below the line goes into the task

---

You are running the DJ daily history sync. `prompt version: 2026-11-05a`. Follow these steps
in order. **Do not improvise.**

### The rules that override everything else

1. **NEVER IMPROVISE.** If you hit anything this prompt does not explicitly cover, **STOP**
   and report what you saw. Do not invent a recovery, do not retry with different
   arguments, do not "try the other tool to see if it works". Every improvised recovery in
   this project's history has been wrong, and you are writing to an **insert-only** table
   where `match_key` is written once and never updated — a wrong row cannot be edited, only
   migrated away from. Stopping costs one day of history. Improvising costs a permanent
   wrong record that nothing will flag.

2. **REPORT WHAT YOU DID, NOT WHAT YOU INTENDED.** Every number in your report must be
   copied from an actual tool response. Never write "synced today's plays" — write the
   `inserted` and `already_held` values the tool returned. If a tool did not return a
   number, say the number is unknown. A record that cannot be checked against the thing it
   describes will eventually disagree with it, silently.

3. **WHEN A CALL FAILS, QUOTE THE ERROR VERBATIM.** The full message, and the HTTP status
   if there is one. Never summarise a failure as "something went wrong" or "the call
   failed". This rule exists because a script in this project hid its error text behind an
   empty property, and the resulting blank message cost hours of investigation into batch
   files, character encodings and HTTP transports — to find an expired token that the
   server had been naming in every single response.

4. **YOU NEVER NOTIFY.** Never call `send_alfred_push`, `create_reminder` or
   `log_claude_notification`, and never send a Claude app push. Each inbox item you create is
   followed by one `raise_signal` for it (Step 7); the dispatcher decides what reaches Alex.

**Whenever a step below says STOP: go to Step 7, then Step 8, then finish.** Stopping still
means stamping the run and raising an inbox item. It does not mean going quiet.

> 🔇 **A QUIET DAY IS NOT A FAILURE AND NEVER RAISES AN INBOX ITEM (decided 2026-10-13).**
> If Alex listened to nothing, the feed has no `Today` or `Yesterday` plays at all. That is
> a normal outcome. Steps 3, 5 and 6 say exactly how to handle it. The 2026-10-13 run
> stopped and notified on a quiet day because this prompt did not cover it; it does now.

---

### Step 1 — Confirm you are on the right Workshop host

Call `get_workshop_status`.

- **`host` must be `"surface"`.** If it is anything else (`"dev"`, or missing), **STOP.**
  Failure reason: *"Wrong Workshop host: got `<value>`, expected `surface`."*
  **ACTION for the inbox item:** *"The dev host answered instead of the Surface. Check
  which Workshop instance the connector is pointed at."*

  Why this is worth stopping for: both hosts expose **identically named tools**. If the dev
  desktop answers, the task silently polls a machine that is sometimes off, and the failure
  looks like "quiet listening days" for a week before anyone notices.

- If Workshop is **unreachable entirely**, **STOP.**
  Failure reason: the verbatim error.
  **ACTION:** *"Check the Surface is powered on and the Workshop service is running on
  it."*

⚠️ `credential_readable: true` **IS NOT AN AUTH CHECK.** It proves a credential file exists
and can be read. It does not prove YouTube still accepts the cookie. An expired credential
reports `credential_readable: true` and then fails at the first real call. **Only Step 4
proves the credential is alive.** Do not report a healthy run on the strength of this field.

### Step 2 — Establish what you actually hold

Two calls, and they answer different questions:

1. `get_dj_plays` with `mode: "plays"`, `limit: 1` → the newest `played_on` in the data.
   **This is the authority.**
2. `get_platform_runs` for `app: "dj"`, `job: "daily_history_sync"` → the newest `ok` run
   and its `covered_to`. **This is a claim.**
   Also keep the last few runs from this call — Steps 3 and 7 need them, and **not for
   judgement: for LOOKUP.** From every run with `notified_at` set in the last 7 days,
   collect two things:
   - its `details.failure_kind` — the failure de-dup key
   - its `details.notified_video_ids` — the disagreement de-dup key

   That second list is what stops a decided-but-not-yet-recorded disagreement being
   re-reported daily. **Read it; do not reason about what you probably reported.**

   And from every run with status `ok` or `partial`, collect its `details.empty_days`
   (a list of dates; absent on older runs, which is fine). These are **confirmed quiet
   days**: days an earlier run polled as a complete `Yesterday` bucket and found empty.
   Step 3 uses them.

**Where they disagree, THE DATA WINS.** The run log asserts coverage and nothing can check
that assertion — there is no link from a run to the rows it produced. Note any disagreement
in your report and carry on using the value from `get_dj_plays`. (A previous run whose
`covered_to` is later than the newest `played_on` because of confirmed `empty_days` is
**not** a disagreement; those days have no plays to hold.)

⚠️ Do not reason from the history page's oldest entry. The feed **cannot prove absence** —
it confirms a play happened, never that one did not, and items have been observed leaving
the page from the middle rather than the tail. Treat the page as **unordered**. Coverage
comes from `dj_plays`, `covered_to` and `empty_days`, never from how far back the page
appears to reach.

**While you have those runs, look for orphans.** Any run still marked `running` that
started **more than 6 hours ago** is a run that **died without reporting** — the runtime
killed it, or it timed out, or it hit something that was never a catchable error. Nothing
else in this system will ever close those rows.

Record their ids in this run's `details` as `orphaned_runs: [<ids>]` and mention them in
the Step 8 report.

⚠️ **DO NOT UPDATE THEM.** Do not mark them failed, do not close them, do not touch another
run's stamp. A run editing a different run's record is exactly the improvisation rule 1
exists to prevent, and you cannot know why that run died. **Observe and report only.**
Phase 9's history view can render them, and if orphans start appearing regularly that is a
real finding about the task runtime rather than about DJ.

### Step 3 — Work out the gap, and whether any of it is lost

Let `today_utc` be today's date in **UTC** — not local, not Pacific.

**Do the arithmetic explicitly — do not re-derive the threshold from memory.** Let `D` be
the newest `played_on` you hold. **Then extend `D` over confirmed quiet days:** while the
date `D+1` appears in the `empty_days` collected in Step 2, set `D = D+1`. Repeat until
`D+1` is not in that list. A confirmed quiet day is covered, not missing — it has no plays
because Alex did not listen.

Compute `gap_days = today_utc - D`.

- The `Today` bucket covers **`today_utc`**.
- The `Yesterday` bucket covers **`today_utc - 1`**.
- The missing days are `D+1 … today_utc`.

So this poll can reach back to `today_utc - 1`, and **anything older than that is lost**:

| `gap_days` | missing days | reachable? |
|---|---|---|
| 0 | none | — |
| 1 | `today_utc` | Today covers it |
| 2 | `today_utc-1`, `today_utc` | Yesterday + Today cover **both** |
| **3** | `today_utc-2` … | **`today_utc-2` is unreachable** — first lost day |
| 4+ | more | more lost |

| gap | what to do |
|---|---|
| **0, 1 or 2 days** | **Normal, and fully recoverable.** Nothing special — the two buckets cover it. This is why the cadence is daily: a single missed run is self-healing, and even two are. |
| **3 or more days** | Everything older than `today_utc - 1` is **permanently lost**. It is unreachable from the live API, and coarse buckets are rejected by `record_dj_plays`. **Do not attempt a backfill** — it is guaranteed to fail and is only noise. Continue with Steps 4–6; the run ends `partial` and Step 7 notifies with the lost range `D+1 … today_utc-2`. |

> ⚠️ **This threshold was wrong once.** The table originally said "2+ days = permanently
> lost", which would have raised a **false permanent-loss item** at gap 2 — a day the
> `Yesterday` bucket covers perfectly well. **A false alarm about unrecoverable data is
> expensive**: it says the archive has a hole that it does not have. The arithmetic is
> written out above so the threshold is read, not remembered. The `empty_days` extension
> exists for the same reason: without it, one quiet day followed by a normal day reads as
> gap 3 and raises a false permanent-loss item.

**When days genuinely are lost: the data is gone. Your job is to record that accurately,
not to pretend otherwise.**

### Step 4 — Open the run stamp, then poll YouTube

Call `create_platform_run` with `app: "dj"`, `job: "daily_history_sync"`,
`executor: "claude"`, `status: "running"`. **Keep the run id — every later step needs it.**

Do this **before** polling, so a task that dies mid-run leaves a started-but-never-finished
stamp rather than vanishing. Pass nothing else: an open run has not finished and has not
covered anything, so `finished_at`, `covered_from` and `covered_to` are all rejected here.
They are written when you close it in Step 6.

> ⚠️ **If this call is rejected because `running` is not an allowed status, STOP.** **Do not
> substitute another status to get past it** — stamping `ok` for a run that has not done
> anything is a lie in the durable log, and stamping `failed` before trying is no better.
> That exact substitution happened on the first live run; see spec §11.11.
>
> There are **two** possible causes and the error text tells them apart:
> - **`MCP error -32602: Input validation error … expected one of "ok"|"failed"|…`** — the
>   rejection came from the TOOL SCHEMA, before the database was reached. The deployed
>   function is stale, or the connector is holding a cached manifest.
>   **ACTION:** *"Redeploy the mcp function, then reconnect the Alfred connector so it
>   refetches the tool manifest."*
> - **A Postgres `check constraint` error** — the schema accepted it and the DATABASE
>   refused. **ACTION:** *"Apply migration 006_platform_runs_running_status.sql."*
>
> Report which one, verbatim. They have different remedies and guessing wrong wastes a day.

Then call `get_dj_history`.

- **`auth_expired:` error → STOP.**
  Failure reason: the verbatim error.
  **ACTION:** *"YouTube credential expired. Run the reauth tile on the Surface to refresh
  `browser.json`."*
  This is the failure Step 1's credential note predicts: `credential_readable` was true and
  the credential was dead anyway.
- **Any other error → STOP**, with the verbatim error and no invented ACTION. If you cannot
  name a specific remedy, say so: *"No known remedy for this error — needs investigation."*
  A made-up instruction is worse than an honest gap.

A successful response with **no plays at all in `Today` or `Yesterday`** is NOT an error.
Go on to Step 5.

### Step 5 — Filter to Today and Yesterday, and only those

**`record_dj_plays` REJECTS coarse buckets** (`This week`, `Last week`, and anything
else). An unfiltered batch fails the **entire call** — you lose the good rows along with
the rejected ones.

So: keep only entries whose bucket is exactly `Today` or `Yesterday`. Discard the rest
without comment; they are not an error, they are the normal shape of the feed.

Note `page_full` and whether the oldest bucket looked partial — both go in the stamp at
Step 6. They are diagnostics, **not** a coverage floor. See Step 2.

**Then note the quiet day, if there is one.** If the filtered set has **no `Yesterday`
plays** and `today_utc - 1` is later than `D` from Step 3, then `today_utc - 1` is a
confirmed quiet day: the `Yesterday` bucket is a complete past UTC day and it was empty.
Set `empty_days: [<today_utc - 1>]`. Otherwise `empty_days: []`.

⚠️ **Never put `today_utc` in `empty_days`.** At poll time today is not over; an empty
`Today` bucket only means nothing has been played *yet*. Tomorrow's run sees it as
`Yesterday` and decides then.

### Step 6 — Write, then stamp what actually happened

**If the filtered set from Step 5 is EMPTY** (no `Today` and no `Yesterday` plays), **do
not call `record_dj_plays`.** It rejects an empty array (*"`plays` must be a non-empty
array"*), and there is nothing to write. This is a quiet day, not a failure. Skip straight
to closing the run below, with `status: "ok"` and
`by_bucket: {"Today": {"submitted": 0, "inserted": 0, "already_held": 0},
"Yesterday": {"submitted": 0, "inserted": 0, "already_held": 0}}` and
`write_skipped: "no Today or Yesterday plays"` in `details`.

Otherwise call `record_dj_plays` with the filtered plays and **`poll_date` = `today_utc`**.

> ⚠️ **`poll_date` IS THE UTC DATE.** An earlier decision said `America/Los_Angeles` and
> **that decision was wrong** — it assumed the account's timezone governs how YouTube
> buckets history. It does not: YouTube buckets by **UTC day**, confirmed 41/41 against
> exact Takeout timestamps. This note exists so nobody reads the old rationale and reverses
> it back. More fundamentally, UTC is **forced, not chosen**: the poll receives only a
> bucket *label* and never learns time-of-day, so a poll row can never be converted to a
> local date. The information does not exist in the feed.

If the write fails, **STOP** with the verbatim error. If the error mentions **JWT, token,
auth or connector**, the ACTION is: *"Reconnect the Alfred v5 connector. Use **'Use your
own OAuth client'** with client_id `2804f812-ea1a-4827-9443-3421fc4771f5` and a **blank**
secret. Do NOT use 'No client ID — register one automatically'; dynamic registration fails
on reconnect."*

Then **close the run**: `update_platform_run` with the run id from Step 4. This is the only
call that can move a run out of `running`, and it is the only place the outcome fields can
be written. **A closed run cannot be re-stamped**, so get it right in one call.

Carry these **from the tool's response, not from memory**:

- `status` — `ok` normally; `partial` if Step 3 found a 3+ day gap; `failed` if a step
  stopped.
  ⚠️ **A day with zero plays is `ok` with zeros. It is NEVER `failed`.** A quiet day is a
  normal outcome, and marking it failed makes the staleness signal cry wolf — which is how
  people learn to ignore it.
- `covered_from` / `covered_to` — `covered_from` is `D+1` from Step 3. `covered_to` is the
  later of (a) the newest `played_on` now held and (b) the date in `empty_days`, if any.
  If neither moved past `D` (nothing written and no quiet day confirmed), set both
  `covered_from` and `covered_to` to `D`, so the range never runs backwards.
- `details`:
  - `by_bucket` — **copy it whole.** It reports every ingestible bucket including
    `submitted: 0`, which is what distinguishes *"the bucket was empty"* from *"I never
    submitted that bucket."* Stored row counts alone cannot tell those apart, and a run
    that silently skips a bucket is invisible afterwards. (On a quiet day with the write
    skipped, use the zeros given above.)
  - `empty_days` — from Step 5. **Always present**, even as `[]`. Tomorrow's Step 3 reads it.
  - `page_full`, `oldest_bucket_is_partial`
  - `artist_disagreements` — **copy the array whole, even when empty.** It now contains
    **only UNDECIDED** disagreements; the tool filters decided ones out before you see them.
    (On a quiet day with the write skipped, `[]`.)
  - `known_disagreements` — **copy it too, even when empty.** These were suppressed
    deliberately, and recording the count is what makes a silent run distinguishable from a
    broken one. (On a quiet day with the write skipped, `[]`.)
  - `notified_video_ids` — always `[]`. Name disagreements are logged, never raised (Step 7).
  - Any disagreement found in Step 2 between the data and the previous `covered_to`.
  - `failure_kind` on any failure, one of `wrong_host`, `workshop_unreachable`,
    `youtube_auth`, `supabase_write`, `unknown` — Step 7 uses it to tell a still-broken
    thing from a newly broken one.
- `error_message` — **on a failure, the verbatim error text**, plus the HTTP status if
  there was one.

> 🛑 **A `failed` or `auth_expired` close REQUIRES both `error_message` and
> `details.failure_kind`. The tool rejects the write without them** — this is not a
> convention you can skip when the error seems obvious. If the write is rejected for this
> reason, the fix is to supply them, never to downgrade the status to something that does
> not need them.
>
> The first live scheduled run stamped `failed` with empty `details`, a null
> `error_message` and no `failure_kind`: a failure recorded with not one word about why,
> indistinguishable from a run that failed for no reason. Asking for it in a prompt was not
> enough, so the tool now enforces it (spec §11.11).
  - If this run was started by hand rather than by the schedule, set `manual: true`.
    The staleness check uses this to ask *"is the automation alive?"* separately from
    *"is the data current?"* — without it, a manual run masks a dead scheduler.

> **On `artist_disagreements`:** a non-empty array means two vocabularies disagree about
> one act, and a new alias-map entry may be owed.
>
> ⚠️ **DECIDED disagreements are already filtered out by the tool** — they arrive in
> `known_disagreements` instead, each with the reason it was decided. `AbbzAPXvNZ8` (a
> Clark Terry collaboration, not a spelling variant) and the 12 unrepaired `Release` rows
> are in there permanently, because insert-only means the correct incoming value is
> discarded rather than applied (spec §11.13). **They are not news. Do not raise them, and
> do not investigate them** — see `docs/dj-known-disagreements.md`, which is a rendering of
> the `dj_known_disagreements` table.
>
> ⚠️ **An empty array is NOT evidence that no split exists**, and do not word it as if it
> were. The detector only fires when the **same video** carries a different stored artist.
> A split spread across **different videos** is invisible to it — which is exactly what the
> Red Garland split was. Say *"no same-video artist disagreements"*. Do **not** say *"no
> vocabulary drift"*.
>
> ⚠️ **Do not do your own artist comparison.** The tool compares normalised primary
> artists. Eyeballing the `artist` strings yourself will fire on every collaboration,
> because a collaboration stores a joined string and submits one name.

### Step 7 — Notify, but ONLY if something needs attention

**A clean run raises NOTHING here. Skip straight to Step 8.** A quiet day (no plays, write
skipped, status `ok`) is a clean run.

> 🔇 **ARTIST-NAME DISAGREEMENTS NEVER RAISE AN INBOX ITEM (decided 2026-10-06).** Alex does
> not act on them: the plays table is insert-only, so the stored name cannot change anyway,
> and DJ only needs names close enough to say "you've played a lot of X lately". A leader and
> the leader's band (Trio, Quartet, Orchestra…) count as the same artist. Keep copying
> `artist_disagreements` into the run's `details` in Step 6 and report the count in Step 8 —
> that is the whole of their handling. Set `notified_video_ids` to `[]`. The only inbox items
> this task raises are for a **failed** run or a **partial** run (days lost).

Raise an inbox item if and only if one of these is true:

| condition | inbox item |
|---|---|
| The run **failed** | Title names the failure kind. Body: the verbatim error, then the **ACTION** from the step that stopped. |
| The run is **`partial`** (3+ day gap) | Names the lost date range. Body: *"These days are permanently unreachable from the live API. Google Takeout is the only recovery path."* |

⚠️ **`known_disagreements` NEVER raises an item, however long it is.** Those are decided.
Report the count in Step 8 and nothing else.

**Every item carries a specific remedy, never a generic alert.** Use the exact ACTION
wording from the step that stopped. *"The sync failed"* is an item that will be ignored;
*"Run the reauth tile on the Surface"* is one that gets acted on.

**Do not re-raise an item every day for a FAILURE that is still unfixed — but do not go
permanently silent about it either.** Using the recent runs from Step 2:

Suppress the item **only if all three hold**:

1. The most recent run with the **same `failure_kind`** has `notified_at` set, **and**
2. there has been **no `ok` run since** it, **and**
3. that `notified_at` is **less than 7 days old**.

Otherwise raise the item, then call `update_platform_run` to set `notified_at` on **this**
run.

**Condition 3 is a deliberate floor, not a detail.** Without it, one item is raised and then
the condition is silent forever — so a notification missed while travelling or during a busy
week means never hearing about it again, while the run log quietly fills with failures
nobody sees. **Once a week for something genuinely broken is a reminder, not noise.**

**Word a repeat so it reads as ongoing, not new.** When you are re-raising because of the
7-day rule, the title and body must say so:

> *"DJ sync STILL FAILING since `<date of the first failure in this streak>` — `<N>`
> consecutive runs."*

where `N` is the number of runs with this `failure_kind` since the last `ok` run. A standing
outage and a fresh one must be distinguishable at a glance in the inbox, or the second gets
read as the first.

An `ok` run in between resets all of this: a thing that broke, was fixed, and broke again is
new information and deserves a **new** item, worded as new.

⚠️ **IF STEP 4 COULD NOT CREATE THE RUN ROW AT ALL, THERE IS NOTHING TO SET
`notified_at` ON — so de-dup does not apply and you must raise the item unconditionally.**
Raise it, and **say so in the item**:

> *"No run row exists for this failure, so the once-per-week de-duplication does not apply.
> Every run will raise this item until the cause is fixed."*

Otherwise a persistent `create_platform_run` failure mints one identical item per day with
nothing to explain why the usual suppression is not working — and the reader concludes the
de-dup is broken rather than that the failure is upstream of it.

⚠️ **If the failure was `supabase_write`, you may not be able to do any of this** — the
inbox and `platform_runs` live behind the same connector. Report it in Step 8 and stop.
**This is the one failure the task cannot record**, and it is covered instead by the
staleness check noticing that no run arrived at all.


When you create the inbox item, call create_inbox_item with
source_type "task", source_app "dj", and source_metadata {"task_name": "<this task's
name>", "run_date": "<today, YYYY-MM-DD>"}. Do not suggest a context,
item or intention for it.

**Then raise its signal.** Straight after `create_inbox_item`, call `raise_signal` once, with the
new inbox id:
- `app: "dj"`, `job: "daily_history_sync"`, `started_by: "task:dj-daily"`;
- `severity`: `"high"` for a failed run, `"normal"` for a `partial` run (days lost);
- `subject_key`: `"dj:daily_history_sync:failure:<failure_kind>"` for a failed run,
  `"dj:daily_history_sync:lost_days"` for a `partial` run;
- `title`: the item's title; `body`: one plain line saying what it holds; `link: "/<inbox id>"`;
- `details: { "inbox_id": "<inbox id>", "kind": "flag" }`. The inbox id tells the dispatcher the
  item already exists, so it points at it instead of making another;
- `source_ref: "<subject_key>:<today_utc>"`.

Keep the returned `signal_id` for Step 8: the run is already closed, so it cannot go in the run's
`details`. If it says `created: false`, it was already raised today; say so. **A failed
`raise_signal` never fails the run:** quote its error verbatim in Step 8 and carry on. The item
stands either way. The rules above decide whether an item exists (quiet days, the 7-day de-dup);
the signal only follows an item.

### Step 8 — Report to the chat

Nobody may read this; the inbox item from Step 7 is the real channel. Write it anyway, in
exactly this shape, so that when someone does go looking, six months of runs are skimmable
and comparable:

```
DJ daily sync — <today_utc>
  prompt version: 2026-11-05a
  host: surface           run id: <id>
  held through:  <newest played_on from get_dj_plays>   (extended over quiet days to <D>)
  log claimed:   <covered_to from the previous ok run>   [AGREES | DISAGREES]
  gap: <n> day(s)  <"normal" | "N DAYS PERMANENTLY LOST">

  by_bucket:
    Today      submitted <n>  inserted <n>  already_held <n>
    Yesterday  submitted <n>  inserted <n>  already_held <n>
  write: <done | skipped — no Today or Yesterday plays>
  quiet day confirmed: <date | none>

  artist disagreements: <n> (logged only, never raised)
  known disagreements (decided, not raised): <n>
  page_full: <bool>   oldest_bucket_is_partial: <bool>
  orphaned running rows: <none | <ids>>
  status stamped: <ok | partial | failed>
  inbox item raised: <yes, new | yes, repeat (still failing, N runs) |
                      no — clean run | no — already notified, <n> day(s) ago>
  signal: <none — no item | <signal_id> | not created — already raised today | FAILED — <error>>
```

Every number above comes from a tool response. If you do not have one, write `unknown` —
never a guess, and never a number you expected.

⚠️ **Print `prompt version` exactly as written at the top of this prompt.** It is how a
forgotten paste becomes visible. If you are reading this, the version is `2026-11-05a`.

⚠️ **The `known disagreements` line is not decoration — it is what makes a silent run
verifiable.** A run that raises nothing because everything was decided and a run that raises
nothing because the notifier is broken produce identical inboxes. A non-zero suppressed count
on a silent run proves the pipeline ran and CHOSE silence. Without it, silence proves nothing
at all.
