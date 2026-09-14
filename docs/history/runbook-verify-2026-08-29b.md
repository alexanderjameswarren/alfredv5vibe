# Verification — zero-fill, Perfect Situation, `by_bucket`

**Paste into a FRESH conversation.** Self-contained.

**Today is 2026-08-29.** That matters for check 3 — use the real date, not this one, if you
are reading this later.

Report each check **PASS / FAIL** against the literal criterion. Where a criterion names a
number or a value, compare it; do not paraphrase and judge yourself against the paraphrase.
**Stop at the first failure and report.**

⚠️ **Checks 2 and 3 WRITE.** Check 1 is read-only. Nothing here deletes anything.

---

## 1 — Zero-fill, with a case that can actually fail

```
get_dj_plays
  mode: "familiarity"
  video_ids: ["cQzMHhRCTYw", "zzzNOTAREALIDzz"]
```

`cQzMHhRCTYw` is Buddy Holly and has plays. **`zzzNOTAREALIDzz` is deliberately fake.**

**This is the point of the check:** if zero-fill is broken this returns **1**; if it works it
returns **2**. An earlier version of this check passed twelve ids that all had plays, so it
would have returned twelve either way — it could not have detected the feature's absence
(spec §11.1).

**Acceptance, all five:**
- `returned` is **2**
- The fake id appears in `groups` with `distinct_days: 0`, `days_since_last: null`,
  `known_track: false`
- `cQzMHhRCTYw` has `distinct_days` **≥ 1** — the control; if this reads 0 then video_id →
  track resolution is broken and the other zero means nothing
- `all_requested_returned` is `true`
- `unknown_ids_returned_as_zeros` is `["zzzNOTAREALIDzz"]` **and that id is ALSO in
  `groups`** — the list annotates the results, it does not replace them

> This exercises the unknown-id case. The known-track-with-no-plays case is check 2.

---

## 2 — Add *Perfect Situation* to the setlist

**This is a setlist decision on its own merits**, not a test fixture. Twelve songs is short —
spec §7 notes a touring Weezer show runs 18–22 — and *Perfect Situation* sat at position 12
of the old playlist's head, so a previous version of this setlist already included it.

### 2a — add it to YouTube

```
edit_dj_playlist
  playlist_id: "PLGhCMggoJnIc"
  mode: "add"
  video_ids: ["Mpp3vUZKuzc"]
```

**Acceptance:** `tracks_added` is `1`, upstream status is a success.

### 2b — re-read to capture fresh handles

```
get_dj_playlists
  mode: "contents"
  playlist_id: "PLGhCMggoJnIc"
  limit: 50
```

**Acceptance:** `track_count` is **13**, Perfect Situation is at the end (position 12,
zero-indexed), every entry has a non-null `set_video_id`.

⚠️ **Use the `set_video_id` values from THIS read.** They are per-playlist handles that are
reused across playlists for different songs — a handle from anywhere else can match a real
but wrong entry.

### 2c — record all thirteen

```
record_dj_playlist
  yt_playlist_id: "PLGhCMggoJnIc"
  name: "Weezer Concert 2026"
  kind: "concert"
  concert_id: "c3085a27-6b73-4dd4-b24b-06412526c168"
  tracks: [ <all 13, role "body", positions 1..13, yt_set_video_id from 2b,
             added_reason "import"> ]
```

**Acceptance:** `by_role` is `{ "body": 13, "cram": 0 }`, `membership_rows_written` is `13`,
`playlist_created` is `false` (it already exists).

### 2d — does this give us a zero-play subject? Check, do not assume.

```
get_dj_plays
  mode: "familiarity"
  video_ids: ["Mpp3vUZKuzc"]
```

- **`distinct_days: 0` and `days_since_last: null`** → the known-track-with-no-plays case now
  has a live subject. Report it as **EXERCISED**.
- **`distinct_days` ≥ 1** → Alex has played it, there is still no live subject for that case,
  and that is simply the honest state. Report **NOT EXERCISED — no zero-play track exists in
  dj_tracks**. Do **not** work around it by inventing one.

Either answer is fine. **The setlist decision stands regardless** — the zero-play subject was
always a side effect, not the reason.

---

## 3 — `by_bucket`, and the convergence check

Two polls, deliberately. The first demonstrates a skipped bucket; the second is the real
sync and settles a question that is currently marked verified on evidence a later read could
not reproduce.

### 3a — a deliberately partial poll

```
get_dj_history   buckets: ["Today"]   limit: 200
record_dj_plays  plays: <mapped, Today only>   poll_date: "2026-08-29"   source: "poll"
```

Map each play: `video_id`, `title`, `artists` as an array of **name strings**, `album` as its
**name string or null**, `duration_seconds`, `played_bucket`, `occurrence` — pass `occurrence`
through untouched, do not recompute it.

**Acceptance, both:**
- `by_bucket` contains **`Today`** with real numbers **and `Yesterday` with
  `submitted: 0, inserted: 0, already_held: 0`**
- **`Yesterday` is PRESENT, not absent.** That explicit zero is the entire feature: a run
  that skips a bucket must not look identical to a run where the bucket was empty.

Stamp it under its own job name so it does not pollute the daily lineage:

```
create_platform_run
  app: "dj"   job: "phase5_bucket_check"   executor: "claude"   host: "desktop"
  status: "ok"   covered_from: "2026-08-29"   covered_to: "2026-08-29"
  details: { "by_bucket": <the by_bucket object verbatim>, "manual": true,
             "scope": "Today only, deliberately partial" }
```

### 3b — the real sync, and the convergence check

```
get_dj_history   buckets: ["Today", "Yesterday"]   limit: 200
record_dj_plays  plays: <mapped, both buckets>   poll_date: "2026-08-29"   source: "poll"
```

**Acceptance, all four:**
- `by_bucket` now shows **both** buckets with `submitted` > 0
- **`Today` shows `inserted: 0` and `already_held` equal to its `submitted`** — 3a already
  wrote those
- **🚧 CONVERGENCE: `Yesterday` rows resolve to `played_on: 2026-08-28` and mostly
  `already_held`.** There are 30 rows stored at that date; expect the great majority of the
  Yesterday bucket to re-match rather than insert. `Yesterday` resolves to `poll_date − 1`,
  landing on the same `played_on` the `Today` capture used yesterday — **that convergence is
  the entire reason the dedupe key could move to `played_on`.**
- **Report `Yesterday`'s `submitted` / `inserted` / `already_held` explicitly.** A handful of
  inserts is expected and fine — the feed is lossy and can serve plays it did not serve
  before (spec §11.3). A large number of inserts, or `already_held: 0`, means convergence is
  NOT working and Block F's status is wrong.

Then stamp the real run:

```
create_platform_run
  app: "dj"   job: "daily_history_sync"   executor: "claude"   host: "desktop"
  status: "ok"   started_at: "<ISO recorded before the get_dj_history call>"
  covered_from: "2026-08-28"   covered_to: "2026-08-29"
  details: { "by_bucket": <verbatim>, "buckets_written": ["Today","Yesterday"],
             "buckets_available_not_written": ["This week","Last week"],
             "covered_floor_is_deliberate": true, "page_full": <from the read>,
             "oldest_bucket_is_partial": <from the read> }
```

---

## 4 — Report

1. **1, 2a–2d, 3a, 3b as PASS / FAIL.**
2. **Check 2d stated as EXERCISED or NOT EXERCISED**, with which it was and why.
3. **The convergence numbers from 3b** — `Yesterday` submitted / inserted / already_held.
4. **Both `by_bucket` objects verbatim.**
5. **Anything that surprised you.** Every pass in this project has turned up something only
   live data showed: `limit` being a fetch hint, `count` arriving as a string, a run that
   finished before it began, one feed entry per track per bucket, a six-way title collision,
   `set_video_id` reused across playlists, a stored play vanishing from the feed. Assume
   there is one here and go looking.

Then **wait** — propose changes, do not make them.
