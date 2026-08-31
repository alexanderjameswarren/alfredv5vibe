# DJ — daily history sync. The Claude scheduled task prompt.

**This file IS the automation.** There is no code to inspect: the prompt below is the
entire program. It is written to be read cold, months later, by someone debugging a run
that misbehaved. Length here is deliberate — compression would cost exactly the context a
cold reader needs.

- **Schedule:** daily, **17:00 UTC** (10:00 Pacific). Far from the UTC midnight boundary
  that governs how YouTube buckets history — a run near 00:00 UTC risks the feed rolling
  over mid-request, with some entries answered under one UTC day and some under the next
  and no way to tell which afterwards.
- **App / job:** `dj` / `daily_history_sync`.
- **Edit rule:** change this file, then paste it into the task. Never edit the task alone,
  or this file becomes a description of something that no longer exists.

## The record and the notification are SEPARATE, deliberately

| | when | where |
|---|---|---|
| **Record** | **every run**, success or failure | `platform_runs` — the durable log the staleness check reads |
| **Notification** | **only** failure, `partial`, or a non-empty `artist_disagreements` | one Alfred **inbox item** |

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

You are running the DJ daily history sync. Follow these steps in order. **Do not
improvise.**

### The three rules that override everything else

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

**Whenever a step below says STOP: go to Step 7, then Step 8, then finish.** Stopping still
means stamping the run and raising an inbox item. It does not mean going quiet.

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
   Also keep the last few runs from this call — Step 7 needs them to decide whether an
   inbox item has already been raised for a condition that is still unfixed.

**Where they disagree, THE DATA WINS.** The run log asserts coverage and nothing can check
that assertion — there is no link from a run to the rows it produced. Note any disagreement
in your report and carry on using the value from `get_dj_plays`.

⚠️ Do not reason from the history page's oldest entry. The feed **cannot prove absence** —
it confirms a play happened, never that one did not, and items have been observed leaving
the page from the middle rather than the tail. Treat the page as **unordered**. Coverage
comes from `dj_plays` and `covered_to`, never from how far back the page appears to reach.

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

Let `today_utc` be today's date in **UTC** — not local, not Pacific. Compute
`gap_days = today_utc - newest_played_on_you_hold`.

**Do the arithmetic explicitly — do not re-derive the threshold from memory.** Let `D` be
the newest `played_on` you hold.

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
> written out above so the threshold is read, not remembered.

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

### Step 5 — Filter to Today and Yesterday, and only those

**`record_dj_plays` REJECTS coarse buckets** (`This week`, `Last week`, and anything
else). An unfiltered batch fails the **entire call** — you lose the good rows along with
the rejected ones.

So: keep only entries whose bucket is exactly `Today` or `Yesterday`. Discard the rest
without comment; they are not an error, they are the normal shape of the feed.

Note `page_full` and whether the oldest bucket looked partial — both go in the stamp at
Step 6. They are diagnostics, **not** a coverage floor. See Step 2.

### Step 6 — Write, then stamp what actually happened

Call `record_dj_plays` with the filtered plays and **`poll_date` = `today_utc`**.

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
- `covered_from` / `covered_to`
- `details`:
  - `by_bucket` — **copy it whole.** It reports every ingestible bucket including
    `submitted: 0`, which is what distinguishes *"the bucket was empty"* from *"I never
    submitted that bucket."* Stored row counts alone cannot tell those apart, and a run
    that silently skips a bucket is invisible afterwards.
  - `page_full`, `oldest_bucket_is_partial`
  - `artist_disagreements` — **copy the array whole, even when empty.**
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

**A clean run raises NOTHING here. Skip straight to Step 8.**

Raise an inbox item if and only if one of these is true:

| condition | inbox item |
|---|---|
| The run **failed** | Title names the failure kind. Body: the verbatim error, then the **ACTION** from the step that stopped. |
| The run is **`partial`** (3+ day gap) | Names the lost date range. Body: *"These days are permanently unreachable from the live API. Google Takeout is the only recovery path."* |
| `artist_disagreements` is **non-empty** | Lists each `video_id` with its stored and submitted artist. Body: *"Two vocabularies disagree about one act. A new alias-map entry may be owed — see spec §4.1.4."* |

**Every item carries a specific remedy, never a generic alert.** Use the exact ACTION
wording from the step that stopped. *"The sync failed"* is an item that will be ignored;
*"Run the reauth tile on the Surface"* is one that gets acted on.

**Do not re-raise an item every day for a condition that is still unfixed — but do not go
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

### Step 8 — Report to the chat

Nobody may read this; the inbox item from Step 7 is the real channel. Write it anyway, in
exactly this shape, so that when someone does go looking, six months of runs are skimmable
and comparable:

```
DJ daily sync — <today_utc>
  host: surface           run id: <id>
  held through:  <newest played_on from get_dj_plays>
  log claimed:   <covered_to from the previous ok run>   [AGREES | DISAGREES]
  gap: <n> day(s)  <"normal" | "N DAYS PERMANENTLY LOST">

  by_bucket:
    Today      submitted <n>  inserted <n>  already_held <n>
    Yesterday  submitted <n>  inserted <n>  already_held <n>

  artist disagreements: <n>   <list them if any>
  page_full: <bool>   oldest_bucket_is_partial: <bool>
  orphaned running rows: <none | <ids>>
  status stamped: <ok | partial | failed>
  inbox item raised: <yes, new | yes, repeat (still failing, N runs) |
                      no — clean run | no — already notified, <n> day(s) ago>
```

Every number above comes from a tool response. If you do not have one, write `unknown` —
never a guess, and never a number you expected.

---

## Notes for the human reading this later

**What this task deliberately does NOT do:**

- **No backfill.** Anything older than yesterday is unreachable from the live API. See
  Step 3.
- **No page-tail reasoning.** Treating the history page's oldest entry as a coverage floor
  was considered and **rejected**, and the question of how the page tail behaves is
  **deliberately unresolved, not pending**. Understanding it could only ever license
  trusting the feed *more* — and the feed cannot prove absence, so the best possible outcome
  of that investigation is permission to do something already ruled out.
- **No auth inference from `credential_readable`.** See Step 1.
- **No notification on success.** See the table at the top of this file.

**Orphaned `running` rows are expected occasionally and are not an error in DJ.** The run
stamp is opened before polling precisely so a task that dies leaves a trace; the cost is a
row nothing closes. The task observes them and never touches them. A steady trickle is
normal; a regular pattern is evidence about the task runtime worth investigating on its own.

**The failure this task cannot report, by construction:** if the Alfred connector is down,
the task can write neither `status: "failed"` nor an inbox item — both live on the far side
of the thing that is broken. **Connector death is detectable only by ABSENCE**, i.e. no new
run appearing at all. That is what makes the Phase 6 staleness mitigations load-bearing
rather than a nicety, and it is why the staleness query must alarm on *nothing arriving*,
not only on runs stamped failed.

**On the connector's OAuth token — expected to work, and here is why.** The hourly token
expiry hit during the Phase 8 import was a **hand-copied browser session JWT**, used only by
the import script and pasted in by hand. **Nothing in this task path uses it.** The
connector authenticates by OAuth and holds a **refresh token**; minting fresh access tokens
is the platform's responsibility, not the task's. Different credential, different path, and
the import's failure mode does not transfer.

That reasoning cannot be *proved* before the first unattended run, and it does not need to
be: **the cost of being wrong is one skipped day and an unambiguous auth error**, which
Step 7 will put in the inbox with the reconnect instructions already written. So this is
recorded as *expected to work*, to be **confirmed or refuted by the first unattended run** —
not as an unknown blocking the phase.

**Day-one check:** after the first scheduled firing, call `get_platform_runs` for
`dj`/`daily_history_sync` and confirm a run was stamped. A stamped run means refresh works.
An auth error means it does not, and settles the question at the cost of one day.
