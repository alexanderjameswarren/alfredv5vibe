# Runbook — DJ Phase 2b: the courier loop, end to end

**Paste this whole file into a FRESH conversation.** The MCP manifest freezes at
conversation start, so a session opened before the Phase 1 / 2a deploys cannot see the
tools this runbook uses.

**Reference:** `docs/technical-spec-dj.md`, `docs/progress-dj.md`.

---

## What you are doing

Phase 1 built the read leg (Workshop reads YouTube Music). Phase 2a built the write leg
(Alfred MCP writes Supabase). **Both are verified in isolation. They have never been
connected.** This is that connection, run once, by hand, with the result checked against
literal criteria.

## Rules for this run

1. **Follow the steps in order. Stop at the first failure and report it.** Do not improvise
   a fix and continue — a partial sync that gets stamped as successful is the exact failure
   mode the run log exists to detect.
2. **Every acceptance criterion below is literal.** Where a value is quoted, compare against
   that value. Where a relationship is stated (`X == Y`), check it arithmetically. Do not
   paraphrase a criterion and then judge yourself against the paraphrase.
3. **If a check cannot be exercised by the data, record "not exercised" — never "passed".**
   Steps 7 and 8 depend on this and say so explicitly.
4. **Do not mark Phase 2b complete on your own.** Report and wait.

---

## Step 0 — Delete the smoke rows FIRST

Two rows from Phase 2a are still in `platform_runs`: `job: "phase2a_smoke"` and the
timestamp-fix verification run `cd5398b9-8275-45d0-acb9-fb1fa0948060`.

**This must happen before anything else, and here is why it matters more than it looks.**
Step 2 reads the newest successful `dj` run to decide what window to cover. A stale test
row does not make that read *fail* — it makes it **succeed with a wrong answer**. The run
would compute its backfill window against a smoke test and stamp a coverage claim that
looks entirely reasonable. That is the failure mode that survives longest, because nothing
ever flags it.

**Alex runs this** in the browser console, on the Alfred tab, signed in. There is
deliberately no delete tool for `platform_runs` — §4.5 makes the *absence* of a row the
signal that a job never ran, so a tool that makes rows disappear would undermine the
mechanism the failure design rests on.

Paste `scripts/dj-runs-admin.js`, then:

```js
runsDelete({ app: "dj" })              // DRY RUN
```

**Acceptance:** the dry run lists **exactly 2 rows**. If it lists more or fewer, stop and
report — something else has written to the log and the scope of this run is not what we
think it is.

```js
runsDelete({ app: "dj", apply: true }) // apply
runsList()                             // confirm
```

**Acceptance:** `runsList()` shows **no rows with `app: "dj"`**.

---

## Step 1 — Confirm which host is answering

```
get_workshop_status  (no arguments)
```

**Acceptance, all four:**
- `host` is `"desktop"` — Phase 4 has not happened; the Surface is not deployed yet.
- `dependencies.ytmusicapi.available` is `true`
- `dependencies.ytmusicapi.credential_readable` is `true`
- `tools` contains both `get_dj_history` and `get_dj_playlists`

**If `host` is anything other than `"desktop"`, stop.**

> `credential_readable: true` means a credential file is present and readable on this host.
> It is **not** proof YouTube still accepts it. Only Step 3 proves that.

---

## Step 2 — Gap check (the read Phase 5 will make every day)

```
get_platform_runs
  app: "dj"
  job: "daily_history_sync"
  status: "ok"
  limit: 1
```

**Acceptance:** returns **`[]`** — an empty array.

This is the first-ever run, so there is no prior coverage. An empty result means "no
previous window", not "an error". **If it returns a row, Step 0 did not complete** — stop
and report.

---

## Step 3 — Read the history

Record the current UTC timestamp **before** this call, in ISO form
(`YYYY-MM-DDTHH:MM:SS.sssZ`). Call it `RUN_STARTED_AT`. You will pass it in Step 6, and it
is what makes the run's duration real rather than zero.

```
get_dj_history
  buckets: ["Today", "Yesterday"]
  limit: 200
```

**Acceptance, all five:**
- `returned == matched` — the filter cut nothing
- **No truncation NOTE appears.** Filtering is not truncation; if a NOTE appears, the limit
  cut the result and the scope of this run is wrong.
- `truncation_hint` is `null`
- Every element of `plays` has `played_bucket` equal to `"Today"` or `"Yesterday"`
- `page_size` is `200` and `page_full` is `true`

**Record these for later steps** — do not guess them, read them from the response:
`returned`, `page_size`, `page_full`, `oldest_bucket_in_page`, and the full
`buckets_in_page` object.

> Do not expect specific counts. On 2026-08-27 the page held Today 28 / Yesterday 3, but
> those change daily. The criteria above are relationships, and hold on any day.

---

## Step 4 — Map the plays

Transform each element of `plays` into the shape `record_dj_plays` expects. **Two fields
change shape — this is the step most likely to go wrong:**

| From `get_dj_history` | To `record_dj_plays` | Note |
|---|---|---|
| `video_id` | `video_id` | unchanged |
| `title` | `title` | unchanged |
| `artists: [{name, id}]` | `artists: ["Name", …]` | **array of NAME STRINGS, not objects** |
| `album: {name, id}` or `null` | `album: "Name"` or `null` | **the `name` string, not the object** |
| `duration_seconds` | `duration_seconds` | unchanged |
| `played_bucket` | `played_bucket` | unchanged |
| `occurrence` | `occurrence` | unchanged — **do not recompute it** |

**Drop everything else** (`position`, `bucket_play_count`, `like_status`, `video_type`).
They are not inputs to this tool.

**`occurrence` is computed by Workshop over the full 200-item page, counted from the oldest
end.** Recomputing it from the filtered 31-item list would restart the numbering and defeat
the dedupe key. Pass it through untouched.

Passing `artists` or `album` as objects will fail loudly at the database rather than
silently — but it will fail, so get it right here.

---

## Step 5 — Write

`poll_date` is **today's date in Alex's local timezone**, `YYYY-MM-DD`. The `"Today"`
bucket is relative to him, not to UTC. If you are running near midnight and the UTC date
differs from his local date, say so and ask before proceeding.

```
record_dj_plays
  plays: <the mapped array from Step 4>
  poll_date: "<today, YYYY-MM-DD>"
  source: "poll"
```

**Keep the exact arguments you sent. Step 9 re-sends them byte for byte.**

**Acceptance, all six:**
- `plays_submitted == returned` from Step 3 — everything you read, you sent
- `plays_inserted == plays_submitted` — nothing was already held; this is the first write
- `plays_already_held == 0`
- `tracks_seen` equals the number of **distinct** `video_id`s in your batch
- `covered_to` equals `poll_date`
- `covered_from` equals `poll_date` minus one day

`covered_from` is yesterday because `"Yesterday"` resolves to `poll_date − 1` and both
buckets are `precision: day`. **Every row written by this run has a genuinely correct date.
Nothing here depends on the estimate ladder** — which is the whole reason this scope was
chosen. If something is wrong, it is the write path, not the date resolution. Two variables
at once would make a failure ambiguous.

**Record `canonical_links_made` and `canonical_links`.** Step 7 needs them.

---

## Step 6 — Stamp the run

```
create_platform_run
  app: "dj"
  job: "daily_history_sync"
  executor: "claude"
  host: "desktop"
  status: "ok"
  started_at: "<RUN_STARTED_AT from Step 3>"
  covered_from: "<covered_from from Step 5>"
  covered_to: "<covered_to from Step 5>"
  details: {
    "scope": "first run — Today and Yesterday only, by deliberate choice",
    "buckets_written": ["Today", "Yesterday"],
    "buckets_available_not_written": ["This week", "Last week"],
    "covered_floor_is_deliberate": true,
    "page_full": true,
    "page_size": <page_size from Step 3>,
    "buckets_in_page": <buckets_in_page from Step 3>,
    "oldest_bucket_in_page": "<oldest_bucket_in_page from Step 3>",
    "plays_submitted": <from Step 5>,
    "plays_inserted": <from Step 5>,
    "tracks_created": <from Step 5>,
    "canonical_links_made": <from Step 5>
  }
```

### Why `covered_floor_is_deliberate` matters

**`covered_from` will be yesterday, but the page also held `This week` and `Last week` data
that we chose not to write.** So the floor understates what was *available*, not merely what
was *seen*.

**A later run must not treat that as a gap to backfill, because nothing is missing.**
Without this flag recorded, Phase 5's gap logic inherits a phantom hole — it would compute
a window reaching back before `covered_from`, find plays it thinks were lost, and re-import
data that was deliberately skipped. The flag is the only record that the narrow floor was a
decision rather than a shortfall.

**Acceptance, both:**
- A row comes back with an `id`
- `finished_at >= started_at`. They will **not** be equal here, because you passed a real
  `started_at` from Step 3 — expect a positive duration. (Equal timestamps are correct only
  when `started_at` is omitted.)

---

## Step 7 — Canonical grouping: report honestly

Look at `canonical_links_made` from Step 5.

**If `canonical_links_made >= 1`:** the auto-link path fired. Report the contents of
`canonical_links` — each entry names the `video_id`, `title`, `match_key` and the
`canonical_track_id` it was pointed at. Confirm each grouping looks correct by inspection.
**This counts as exercised.**

**If `canonical_links_made == 0`:** the path **was not exercised**. Say exactly that.

> 31 plays across ~15 distinct tracks may simply contain no variant pair — no remaster
> beside its clean cut, no live beside its studio version. That is a property of the data,
> not evidence the code works.
>
> **Record it in `progress-dj.md` as "canonical auto-linking: NOT EXERCISED — no variant
> pair present in the batch". Do not tick it as passed.** Phase 8's Takeout import produces
> variants in volume and is the real test. **A gate that passes because it was never
> triggered is worse than one openly deferred**, because it stops anyone looking again.

---

## Step 8 — Occurrence: report honestly (same rule)

From the Step 3 response, count how many plays had `bucket_play_count > 1`.

**If any did:** repeat listens of the same track in the same bucket were present, and Step 9
genuinely tests occurrence stability. Report how many.

**If none did** (every play had `bucket_play_count: 1`): Step 9 still proves the dedupe key
works, but **only for the single-occurrence case**. The multi-occurrence path — the one the
oldest-end numbering rule exists for — **was not exercised.** Record it that way in
`progress-dj.md`, same wording discipline as Step 7.

> The live page has previously contained **zero** repeated `(video_id, bucket)` pairs, so
> this is the likely outcome, not an edge case. Synthetic coverage exists in
> `workshop/tests/test_dj.py` and `supabase/functions/_shared/tools/dj-courier.test.mjs`.

---

## Step 9 — 🚧 HARD GATE: the double sync

**Re-invoke `record_dj_plays` with the IDENTICAL arguments from Step 5** — the same `plays`
array, the same `poll_date`, the same `source`.

**Do not call `get_dj_history` again to rebuild the array.** If Alex played anything in the
intervening minutes the feed will have changed, and a legitimately-larger result would make
the outcome ambiguous. Re-sending the exact payload isolates the dedupe path from feed
drift, and dedupe is what is being tested.

```
record_dj_plays
  plays: <byte-for-byte the same array as Step 5>
  poll_date: "<the same poll_date>"
  source: "poll"
```

**Acceptance — all four must hold exactly:**
- `plays_inserted` is **`0`**
- `plays_already_held == plays_submitted`
- `tracks_created` is **`0`**
- `canonical_links_made` is **`0`**

**Do NOT stamp a `platform_run` for this re-invocation.** It is a verification, not a sync;
a second row would appear in the log as a second day's work and corrupt the very history
Phase 5 reads.

### If `plays_inserted` is not 0

**Stop. Do not retry, and do not adjust anything to make it pass.** This is the failure the
gate exists to catch, and it means one of:

- occurrence numbering is unstable between calls, or
- `played_bucket` is arriving null or altered, or
- PostgREST's `ignoreDuplicates` is not behaving as the simulation assumed.

All three produce **silent duplicate rows that accumulate daily** and surface weeks later as
a wrongly-ordered cram list — a bug that will look like cram logic rather than import logic.
Report the exact numbers and the arguments you sent.

---

## Step 10 — Confirm the run log reads back

```
get_platform_runs
  app: "dj"
  job: "daily_history_sync"
  status: "ok"
  limit: 1
```

**Acceptance, all four:**
- Exactly one row
- Its `id` matches the row from Step 6
- `covered_from` and `covered_to` match Step 5
- `details.covered_floor_is_deliberate` is `true`

This is the read Phase 5 makes at the top of every run. It now returns a real answer.

---

## Step 11 — Report

Give Alex, in this order:

1. **Step-by-step pass/fail**, each against the literal criterion above.
2. **The numbers:** plays read, plays written, distinct tracks, tracks created,
   `covered_from` → `covered_to`, and the run `id`.
3. **The hard gate result** stated plainly: did the second invocation insert zero rows.
4. **Steps 7 and 8 as EXERCISED or NOT EXERCISED**, with the reason. Not as pass/fail.
5. **Anything that surprised you** — a field shaped differently than this runbook expects,
   an error message that read oddly, a count that did not match. Previous phases each turned
   up something real that only appeared on live data (`limit` being a fetch hint; `count`
   arriving as a string; a run that finished before it started). Assume there is one here
   too and look for it.

Then propose the `progress-dj.md` edits — including any NOT EXERCISED items, worded as
such — and **wait for Alex to confirm before marking Phase 2b complete.**
