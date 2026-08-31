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

---

### Step 1 — Confirm you are on the right Workshop host

Call `get_workshop_status`.

- **`host` must be `"surface"`.** If it is anything else (`"dev"`, or missing), **STOP
  IMMEDIATELY** and report: *"Wrong Workshop host: got `<value>`, expected `surface`. The
  dev host was reachable instead of the Surface. Nothing was polled."*

  Why this matters enough to stop: both hosts expose **identically named tools**. If the
  dev desktop answers, the task silently polls a machine that is sometimes off, and the
  failure looks like "quiet listening days" for a week before anyone notices.

- If Workshop is **unreachable entirely**, STOP and report:
  *"Workshop is unreachable. ACTION: check the Surface is powered on and the Workshop
  service is running on it."* Quote the error verbatim.

⚠️ `credential_readable: true` **IS NOT AN AUTH CHECK.** It proves a credential file exists
and can be read. It does not prove YouTube still accepts the cookie. An expired credential
reports `credential_readable: true` and then fails at the first real call. **Only Step 4
proves the credential is alive.** Do not report a healthy run on the strength of this field.

### Step 2 — Establish what you actually hold

Two calls, and they answer different questions:

1. `get_dj_plays` with `mode: "plays"`, `limit: 1` → the newest `played_on` in the data.
   **This is the authority.**
2. `get_platform_runs` for `app: "dj"`, `job: "daily_history_sync"`, newest `ok` run →
   its `covered_to`. **This is a claim.**

**Where they disagree, THE DATA WINS.** The run log asserts coverage and nothing can check
that assertion — there is no link from a run to the rows it produced. Note any disagreement
in your report and carry on using the value from `get_dj_plays`.

⚠️ Do not reason from the history page's oldest entry. The feed **cannot prove absence** —
it confirms a play happened, never that one did not, and items have been observed leaving
the page from the middle rather than the tail. Treat the page as **unordered**. Coverage
comes from `dj_plays` and `covered_to`, never from how far back the page appears to reach.

### Step 3 — Work out the gap, and whether any of it is lost

Let `today_utc` be today's date in **UTC** — not local, not Pacific. Compute
`gap_days = today_utc - newest_played_on_you_hold`.

| gap | meaning | what to do |
|---|---|---|
| 0 or 1 day | normal | Nothing special. The `Yesterday` bucket covers it — this is why the cadence is daily. |
| 2+ days | **permanently lost** | Everything older than yesterday is unreachable from the live API. Coarse buckets are rejected by `record_dj_plays`. **Do not attempt a backfill** — it is guaranteed to fail and is only noise. Continue with Steps 4–6, then do Step 7. |

**The data is gone. Your job is to record that accurately, not to pretend otherwise.**

### Step 4 — Poll YouTube

Call `create_platform_run` first, with `app: "dj"`, `job: "daily_history_sync"`,
`status: "running"`. Do this **before** polling, so a task that dies mid-run leaves a
started-but-never-finished stamp — which is itself a signal.

Then call `get_dj_history`.

- If it returns an **`auth_expired:` error**, STOP and report:
  *"YouTube credential expired. ACTION: run the reauth tile on the Surface to refresh
  `browser.json`. Nothing was polled or written."*
  Then update the run to `status: "failed"` with the verbatim error in `details`. **This is
  the failure that proves Step 1's credential note.**
- Any other error: STOP, quote it verbatim, stamp the run failed.

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

If the write fails, STOP and report verbatim. If the error mentions **JWT, token, auth or
connector**, add: *"ACTION: reconnect the Alfred v5 connector. Use **'Use your own OAuth
client'** with client_id `2804f812-ea1a-4827-9443-3421fc4771f5` and a **blank** secret. Do
NOT use 'No client ID — register one automatically'; dynamic registration fails on
reconnect."*

Then `update_platform_run`, carrying **from the tool's response, not from memory**:

- `status` — `ok` normally; `partial` only if Step 3 found a 2+ day gap.
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
  - If this run was started by hand rather than by the schedule, set `manual: true`.
    The staleness check uses this to ask *"is the automation alive?"* separately from
    *"is the data current?"* — without it, a manual run masks a dead scheduler.

> **On `artist_disagreements`:** a non-empty array means two vocabularies disagree about
> one act, and a new alias-map entry may be owed. Report it prominently.
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

### Step 7 — Only if Step 3 found a 2+ day gap

Raise **ONE** inbox item naming the lost date range and saying plainly that **Google
Takeout is the only recovery path**. Then call `update_platform_run` to set `notified_at`,
so this does not repeat every day for a gap that will never close.

One item. Not one per missing day.

### Step 8 — Report

Structure it exactly like this, so six months of these are skimmable and comparable:

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
  status stamped: <ok | partial | failed>
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

**The failure this task cannot report, by construction:** if the Alfred connector is down,
the task cannot write `status: "failed"` — `platform_runs` is on the far side of the thing
that is broken. **Connector death is detectable only by ABSENCE**, i.e. no new run
appearing at all. That is what makes the Phase 6 staleness mitigations load-bearing rather
than a nicety, and it is why the staleness query must alarm on *nothing arriving*, not only
on runs stamped failed.

**Open question, to answer on day one rather than assume:** whether the scheduled-task
runtime refreshes the connector's OAuth access token transparently. The hourly token expiry
seen during the Phase 8 import was a **hand-copied browser session JWT** used only by the
import script — nothing in this task path uses it — and the connector holds a refresh token
that the platform is responsible for exchanging. That is expected to be transparent but has
not been observed here. **Let the first scheduled run fire unattended, then check
`get_platform_runs` for a stamped run.** Success means refresh works. An auth error on day
one costs nothing and settles it.
