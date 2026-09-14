# Verification — `get_dj_plays` + the tier-3 preview

**Paste into a FRESH conversation.** Self-contained; no prior context needed.

**Prerequisites, both already done by Alex:** dev Workshop restarted, and the Alfred MCP
function redeployed. Alfred should show **30 tools**, Workshop (Dev) **9**.

This is a verification pass, not a build. **Do not create, modify or delete anything.**
Every check below is read-only except D, which deliberately stops at a proposal.

Report each check as **PASS** or **FAIL** against the literal criterion. Where a criterion
says "expect N", compare the number; do not paraphrase and then judge yourself against the
paraphrase. **Stop and report on the first failure.**

---

## A — What is actually stored (diagnostic, no expected count)

⚠️ **This check deliberately asserts NO row count.** An earlier version expected 41 rows
for 2026-08-28 and was wrong: that number came from a reported convergence run, paired with
a date without checking the arithmetic. Establish the ground truth first, then compare.

```
get_dj_plays
  mode: "plays"
  limit: 50
```

(No date filter — newest first across everything.)

**Report, do not judge:**
- `total` across all dates
- the distinct `played_on` values present, and how many rows sit on each
- the distinct `observed_at` values, and how many rows share each one — **one shared
  timestamp is one poll batch**, so this is what reveals how many separate writes happened
- whether `_PYx8y5QMA4` (Happy Together) appears at all, and on which `played_on`

If `total` exceeds 50, re-run with `from_date` narrowed to the newest `played_on` you can
see and say so — do not draw conclusions from a truncated read.

**PASS means only:** the tool returned rows, each with an inlined `track`, and the numbers
are internally consistent (rows per date sum to `total`). **The counts themselves are
evidence to report, not criteria to meet.**

## B — `get_dj_plays`, familiarity mode over a range

```
get_dj_plays
  mode: "familiarity"
  from_date: "2026-08-01"
  limit: 50
```

**Acceptance, all five:**
- `groups` is sorted **ascending by `distinct_days`** — least familiar first. Check the
  first few and last few, do not assume.
- **`estimated_days` is `0` on every group.** The poll writes only `day` precision, so a
  non-zero value here means a coarse-bucket row got stored and something is wrong.
- Every group has `days_since_last` populated (these all have plays).
- `distinct_days` and `play_rows` are both present. **They are different quantities** —
  `distinct_days` is DAYS PLAYED, not a play count.
- `as_of` is echoed back.

---

## C — The zero-play rule (the important one)

This is the cram-ordering query Phase 7 will make, run for real.

```
get_dj_plays
  mode: "familiarity"
  video_ids: [
    "wxlfkFMjLZc", "ONhfmrKJ5kE", "FY-WftMUQ94", "BBZrELBT8sI",
    "fg_68MBzpzQ", "beX-9wW5rL0", "_PYx8y5QMA4", "xgtGpafvvcs",
    "6pMf91N1tNU", "r2dosVRzLSM", "LQcMOI8dMas", "cQzMHhRCTYw"
  ]
```

Those are the twelve songs of the "Weezer Concert 2026" setlist, in setlist order.

**Acceptance, all five:**
- **`returned` is exactly `12`.** Fewer means the zero-play rule is broken — a track with
  no plays produces no `dj_plays` row, and it must still come back.
- **The control track.** `_PYx8y5QMA4` (Happy Together) was expected to have plays, but
  check A may show it is not stored at all. **Use whatever check A found instead:** pick a
  `video_id` from A that IS present in `dj_plays` and confirm it reads `distinct_days >= 1`
  here. Some non-zero row is required — if every group reads 0, a broken video_id → track
  resolution is indistinguishable from a genuinely unplayed setlist, and the other eleven
  zeros mean nothing. If none of the twelve are stored, say so and treat this criterion as
  NOT EXERCISED rather than passed.
- **Tracks with no plays read `distinct_days: 0` AND `days_since_last: null`.** Both, on
  the same row. `0` is a fact; `null` means never — the distinction is deliberate.
- The list is sorted **least familiar first**, so the zero-play tracks come first and
  Happy Together sits below them.
- **No truncation NOTE, and `meta` is empty.** An enumerated subject is never clamped.

**Report the full twelve as a table:** video_id, canonical_title, distinct_days,
days_since_last, known_track.

---

## D — The tier-3 preview must describe its TARGET

⚠️ **Do NOT pass `confirmed`. Nothing should be deleted at any point in this check.**

### D1 — a real playlist

⚠️ **Run this against Workshop (Dev), not Workshop (Surface).** Both hosts now expose
identically-named tools, so name the host explicitly. If you cannot direct the call to a
specific host, run `get_workshop_status` first and confirm `host` is `"desktop"` — and if it
reports `"surface"`, STOP and report that rather than proceeding.

```
remove_from_dj_playlist
  playlist_id: "PLV2XoCH1Pv5yDqInwdzIcBZgbVjNkrfzU"
  mode: "delete_playlist"
```

**Acceptance, all four:**
- The response is a **proposal**, nothing was deleted
- It contains a **`target`** block — not merely an echo of the arguments
- `target.title` is **"Weezer Concert"**, `target.track_count` is **160**, and
  `target.resolved` is `true`
- `target.effect` names the playlist and the number of entries that would be lost

### D2 — a mistyped id

```
remove_from_dj_playlist
  playlist_id: "PLV2XoCH1Pv5yDqInwdzIcBZgbVjNkrfzX"
  mode: "delete_playlist"
```

(Same id as D1 with the final character changed.)

**Acceptance, both:**
- `target.resolved` is `false`
- `target.warning` says **do NOT confirm**

> Why this check exists: the gate stops accidental *execution*, but until now the proposal
> echoed only its arguments — so a mistyped id produced something that read exactly as
> reassuring as the correct one. A speed bump only works if a human can read it.

---

## E — Report

1. **A–D as PASS / FAIL**, each against the literal criterion.
2. **The twelve-row table from C.**
3. **Confirm nothing was created, modified or deleted.**
4. **Anything that surprised you.** Every check in this project so far has turned up
   something only live data showed — `limit` being a fetch hint, `count` arriving as a
   string, a run that finished before it began, one feed entry per track per bucket, a
   six-way title collision, `set_video_id` reused across playlists for different songs.
   Assume there is one here and go looking.

Then **wait** — do not propose or make any changes.
