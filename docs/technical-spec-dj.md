# DJ — Technical Specification

**Status:** Phases 0, 1, 2a, 2b complete. The courier loop runs end to end — Workshop
reads YouTube, Claude carries, Alfred MCP writes Supabase. Migration Block F (re-key
`dj_plays` on `played_on`; null poll-sourced albums) is the current work.
**Last updated:** 2026-08-27

---

## 1. Purpose

DJ is a music companion app in the Alfred ecosystem. Claude reads and writes YouTube
Music on the user's behalf, and Supabase holds the durable listening record and taste
model that YouTube itself cannot provide.

Seven capabilities, in the user's own framing:

1. See YouTube Music playlists and play history.
2. Build concert playlists from setlists, to build familiarity before a show.
3. Edit those playlists — dedupe, reorder, add.
4. Build jazz playlists and track favourite albums, to broaden and deepen appreciation.
   Primarily instrumental; occasionally vocal.
5. Discover new artists, and go deeper into artists already mildly familiar
   (90s/2000s especially) rather than replaying favourites.
6. Screen upcoming concerts — build a playlist of an act's live staples to decide
   whether to go.
7. A weekly Friday review of listening history.

**Standing bias: addition over reduction.** Adding songs, artists and albums is
cheap and welcome. Removing things needs a reason.

---

## 2. Architecture: the courier model

### The problem

Three constraints emerged from the Workshop platform:

- **Workshop has no scheduler.** Its job scaffolding is on-demand only:
  `long_running=True` enqueues, a worker executes, `get_job_status` polls. Nothing
  fires on a timer.
- **Workshop cannot write to Supabase.** It holds no secrets by design and validates
  tokens against a public JWKS. On-demand calls pass through the caller's JWT — but a
  *scheduled* job has no caller and therefore no token.
- Every workaround is unattractive: a service-role key on a portable tablet bypasses
  RLS and never expires; a long-lived refresh token expires silently; a dedicated
  service account is a real design task that changes Workshop's threat model.

### The decision

**Claude is the scheduler and the courier.**

```
  Claude scheduled task
        |
        |  (1) calls Workshop tool, carrying the user's JWT
        v
  Workshop (Surface)  --- ytmusicapi --->  YouTube Music
        |
        |  (2) returns plays / playlists as data. Writes nothing.
        v
  Claude
        |
        |  (3) normalises, then writes via Alfred MCP (user's own auth)
        v
  Supabase
```

**Workshop never writes to Supabase; it DOES write to YouTube Music, which is the only
system it holds a credential for.**

⚠️ This paragraph previously said Workshop is "read-only", which was always scoped to
Supabase but did not say so — and read on its own it says Workshop mutates nothing, which
was never the design. §1 has always had Claude *writing* YouTube Music, and §5's edit
mechanics describe Workshop issuing moves. Clarified in phase 3, because the next person
reading §2 stops at "read-only" and concludes phases 3 and 7 are impossible.

Workshop stays **on-demand**. It never holds a Supabase credential and never needs a
scheduler. Claude is the only component that touches both systems, and it is already
authenticated to each.

Concretely, Workshop's YouTube writes are tier-gated (spec §8): creating and adding are
tier 2; removing entries and deleting a playlist are tier 3 and return a proposal until
re-invoked with `confirmed: true`. That keeps phase 7's cram clearing automatable while
forcing every destructive call to state its intent.

### What this costs

- Plays travel through Claude's context rather than machine-to-machine. Fine at ~50
  plays/day; would not work at 50,000.
- **A missed Claude task means a missed poll.** See §6 on why this is tolerable.

### Known limitation, named rather than solved

If the scheduled task never fires, nothing notices. Claude cannot report a failure it
never woke for. Mitigation is in §6.

---

## 3. Schema

Twelve tables. Platform-conformant as of 2026-08-27 (27 non-exempt tables total).

DJ follows SAM/Ken conventions, not Alfred's legacy ones: `uuid` PKs, `uuid` user_id,
`text[]` tags.

### DJ tables

| Table | Purpose | Audited | Policy |
|---|---|---|---|
| `dj_tracks` | Canonical track identity + variant grouping | yes | owner |
| `dj_plays` | Append-only listening log | no | owner |
| `dj_playlists` | Managed playlists, YouTube mapping | yes | owner |
| `dj_playlist_tracks` | Playlist membership, cram/body zones | yes | none (parent) |
| `dj_concerts` | Concert pipeline, screening → attended | yes | owner |
| `dj_venues` | Venues + durable room-quality notes | yes | owner |
| `dj_artists` | Artist identity, tags, exploration state | yes | owner |
| `dj_albums` | Albums as whole works (jazz especially) | yes | owner |
| `dj_feedback` | Append-only preference log | yes | owner |

### Platform tables (shared, not DJ-specific)

| Table | Purpose | Audited | Policy |
|---|---|---|---|
| `platform_runs` | Job run log across all apps | no | owner |
| `platform_schedules` | Cadence definitions | yes | owner |

`platform_runs` and `platform_schedules` were generalised out of an original
`dj_sync_runs` because scheduled-job observability is a pattern SAM and Alfred will
also need. `executor` (`workshop` / `claude` / `alfred`) distinguishes differently
brittle runners without splitting the table.

Full column definitions live in the migration SQL and in `COMMENT ON` — the database
is the source of truth, not this document.

---

## 4. Key design decisions

### 4.1 Canonical track grouping

The same song has multiple YouTube video IDs — album cut, single, remaster, live.
Counting familiarity by `video_id` would make a song played thirty times across three
sources look like three lightly-played songs, and it would never leave a cram list.

`dj_tracks.canonical_track_id` points variants at one canonical row (null = this row
*is* canonical). **All familiarity counting groups by canonical id.**

`match_key` holds a normalised `artist|title` written by the importer, used to propose
grouping. It is written, not generated, because normalisation must strip things like
`(Remastered 1999)` and `- Live` that a generated column cannot express.

Confirmed real: the first probe returned
`The Pleasure Is Mine (Remastered 1999)` — Herbie Hancock.

**Where the normaliser runs:** inside the `record_dj_plays` Edge Function handler, never
in Claude's context. If Claude derived `match_key` conversationally it would drift between
conversations, and grouping must be identical across the daily poll, phase 8's Takeout
backfill, and any manual import. A drifted key does not error — it silently fails to
group, which is the exact failure this section exists to prevent.

#### 4.1.1 The stripping rules, stated explicitly

Documented here rather than left implicit in code, because §4.1.2 makes changing them
expensive.

```
match_key = normalise(primary_artist) + "|" + normalise(title)
```

**Primary artist only.** `artists[]` often varies between variants of the same song —
`Weezer` on one cut, `Weezer, Bethany Cosentino` on another. Only the first artist feeds
the key. The full list is still stored in `dj_tracks.artist`.

**Applied to both halves, in order:**

1. Lowercase, trim, collapse runs of whitespace.
2. Strip **qualifier** parentheticals and brackets — see vocabulary below.
3. Strip **feature clauses**: `feat.` / `ft.` / `featuring` / `(with X)`, to end of the
   parenthetical or to end of string.
4. Strip **dash-suffix qualifiers**: ` - Live`, ` - Remastered 1999`, ` - 2011 Remaster`.
5. `&` → `and`.
6. Drop punctuation (apostrophes, periods, commas); collapse whitespace again.

**Qualifier vocabulary** — the only tokens that trigger stripping:

| Group | Matches |
|---|---|
| Remaster | `remaster`, `remastered`, with a year on either side (`2011 Remaster`, `Remastered 1999`) |
| Live | `live`, and `live at …` / `live from …` |
| Edition | `deluxe`, `deluxe edition`, `anniversary edition`, `expanded edition` |
| Version | `single version`, `album version`, `radio edit`, `radio version`, `extended`, `extended version`, `extended mix` |
| Mix | `mono`, `stereo` |
| Misc | `bonus track`, `explicit`, `clean`, `acoustic`, `demo` |
| Feature | `feat.`, `ft.`, `featuring`, `with` (parenthetical only) |

**⚠️ Matching is by vocabulary, never by position.** A rule like "strip everything after
a dash" destroys **`Undone - The Sweater Song`** — a real title in the Weezer playlist,
where the dashed half *is* the song name. `- The Sweater Song` matches nothing in the
vocabulary, so it survives. Anything unrecognised is kept, always. `(Reprise)` stays,
because a reprise is a different piece of music.

**Deliberately NOT stripped:** `instrumental`. In a library with a jazz arm, an
instrumental cut is plausibly a distinct recording worth counting separately. Revisit
with evidence, not by assumption.

#### 4.1.2 Consequence of write-once: a normaliser change is a migration

`dj_tracks` writes are insert-only (`ON CONFLICT (user_id, video_id) DO NOTHING`), and
`canonical_track_id` is set **only at insert, never re-pointed**. Nothing ever updates a
track row, which is what makes hand-curated grouping safe by construction.

The cost of that guarantee: **`match_key` and `canonical_track_id` are written once.**

**So changing the stripping rules later will NOT regroup existing tracks.** A smarter
rule shipped in phase 8 leaves everything already imported grouped under the old
algorithm, and the two populations disagree invisibly. **A `match_key` change is a
backfill migration, not just a deploy.** Get the rules as right as is reasonable now;
revisiting is expensive rather than free.

#### 4.1.3 Expected merge behaviour, including the surprising cases

**Canonical assignment:** the earliest-inserted member of a `match_key` group is
canonical. Later variants point at it. If a remaster is seen first, the clean version
points at the remaster — that is fine. **Grouping is what matters, not which member is
nominally canonical.**

Two consequences worth stating before they surprise someone:

- **A live and a studio version with the same stripped title WILL group.** For
  familiarity counting this is *correct* — you have heard the song. It is not a bug.
- **Two genuinely different tracks sharing a title by the same artist will also merge.**
  Rare and low-stakes, but real. Nothing detects it automatically.

Only **exact** normalised equality auto-links. Anything fuzzier stays a proposal for a
human, per the "propose" wording above.

### 4.2 Play dates are resolved estimates, and say so

YouTube's history feed returns **day buckets, not timestamps**: `Today`, `Yesterday`,
`This week`, `Last week`. Only the first two convert to a date cleanly. In the probe,
that was 31 of 200 items.

Nullable dates were rejected — every query would pay for a precision the use case
doesn't need. Instead **every row gets a usable date plus a `precision` flag**:

| `precision` | Source | `played_on` resolution |
|---|---|---|
| `exact` | Takeout (real timestamps) | actual |
| `day` | `Today` / `Yesterday` | actual |
| `week` | `This week` | poll date − 2 days |
| `fortnight` | `Last week` | poll date − 9 days |

**Estimates skew to the recent end of the bucket, deliberately.** The question this
data answers is "how long since I heard this," and a recent-skewed guess makes that
answer conservative rather than falsely alarming.

Rule: aggregate `week`/`fortnight` rows; never plot them as if they were dates.

⚠️ **Phase 2b: the daily poll no longer WRITES `week` or `fortnight` rows at all.** Those
estimates are relative to the poll date, so they move daily and re-insert under any
date-based key — see §4.3. The ladder above still describes what the labels mean, and the
coarse buckets are still read for gap detection, but the only sources that produce stored
`week`/`fortnight` rows now are manual imports. In practice stored rows are `day` (poll) or
`exact` (Takeout).

### 4.3 Dedupe keys on the date — and the poll ingests precise buckets only

> **Rewritten in phase 2b.** The original rule keyed dedupe on `played_bucket`, reasoning
> that coarse dates are invented so keying on `played_on` would re-insert a play as it
> drifted. The reasoning about coarse dates was right. The conclusion was wrong, and the
> bucket key was **broken in both directions at once.**

**Too unstable.** A play's label changes as it ages. Keyed on the label, one real play
mints a fresh row at every stage — `Today`, then `Yesterday`, then `This week`, then
`Last week`. Four rows for one play.

**Not discriminating enough.** Two genuinely different plays, days apart, both arrive
labelled `Today`. They form the same key, and `ON CONFLICT DO NOTHING` silently drops the
second. No error, no count, nothing in the run log. **A track played on twenty days gets
one row, dated the first capture.**

Together those invert the system: the tracks returned to most often are under-counted
worst, and "how long since I heard this" answers with the *first* time rather than the
most recent — the opposite of what §4.2 was carefully built to deliver.

**The key is `(user_id, track_id, played_on, occurrence, source)`.**

That alone is not sufficient, because coarse buckets resolve through the §4.2 ladder to
`poll_date − 2` and `poll_date − 9`, and **those move every day.** A play sitting in
`This week` resolves to a different `played_on` on Thursday than on Friday and re-inserts.

**So the daily poll ingests PRECISE buckets only — `Today` and `Yesterday`.** Those
resolve to a stable date:

| Day | Label | Resolves to |
|---|---|---|
| Tue | `Today` | Tue − 0 = **Tue** |
| Wed | `Yesterday` | Wed − 1 = **Tue** |

The same play crossing the boundary produces the same `played_on`, so it dedupes rather
than duplicating. The key and the ingest rule are one mechanism; **neither is correct
without the other**, which is why the restriction is enforced in the `record_dj_plays`
handler rather than left to the caller.

**Coarse buckets are still READ** — they tell us plays exist that we did not capture,
which is gap detection — **but never written by the poll.** This is tolerable precisely
because the poll is daily: plays are almost always caught while still precise. It is also
consistent with §6 — a gap beyond the ~200-item page is unrecoverable from the live API
regardless.

`played_bucket` remains as a **diagnostic column only.** Takeout (`precision: exact`, real
timestamps, per-play rows) is the only source that can ingest history at any age.

### 4.4 Preference is an append-only log, never a column

`dj_feedback` has five nullable foreign keys (artist, concert, album, track, venue) with
a constraint that exactly one is filled. This keeps real foreign keys and real joins,
which a generic `subject_type`/`subject_id` pair would throw away.

**No table carries a current stance column.** Current stance is derived from the newest
feedback row at read time. A second copy of the same truth can drift from the log —
the same twin-site problem being unpicked in `Alfred.jsx`.

A changed opinion is a new row. Feedback is never updated.

### 4.5 Expected runs are derived, never materialised

`platform_schedules` stores cadence, not pre-created occurrence rows. Materialising
would require a job to create those rows — and that job could fail silently, which is
the exact problem the table exists to detect.

**Absence of a run row is the only signal for both failure modes:** Claude never fired
(no row), or Claude fired but couldn't reach Supabase (also no row). Detecting absence
isn't one feature among several — it is the whole mechanism.

---

## 5. The cram-list rule

Applies only to `dj_playlists.kind = 'concert'`.

### Two zones

- **Body** — the canonical setlist in concert order. Stable.
- **Cram** — a volatile block at the top. Rebuilt and cleared freely.

**Rendered YouTube order = all cram rows by position, then all body rows by position.**
Nothing else determines placement.

### Duplicates are load-bearing

A track may hold one row per zone, so the same song appears twice in the playlist.
This is deliberate. "Clear the cram list" becomes *delete every row where role =
'cram'*, and the concert order survives untouched. With deduplication, clearing cram
would delete the song outright and erode the setlist over time.

### Ordering: least familiar first

**Familiarity = the number of DISTINCT DAYS on which the track's canonical group
appeared**, since the playlist was created. Sort ascending.

> **Rewritten in phase 2b. This used to say "play count", and that number cannot be
> measured.**
>
> YouTube's history feed carries **one entry per track per bucket**, positioned at that
> track's most recent play. Repeats do not stack. Measured directly: a track played three
> times in one day appeared **once**, with `bucket_play_count: 1`, and the day's total went
> 28 → 29 rather than 28 → 31. Re-checked 70 minutes later: still one. Twelve *different*
> tracks played in the same window moved it 29 → 41, exactly +12 — one entry each.
>
> So polling can establish **that** a track was played on a day. It can never establish
> **how many times.** Three plays and twenty plays are indistinguishable.

Distinct-day counting is a **different quantity** from play count, deliberately adopted as
the familiarity proxy rather than pretending counts are real. It is defensible on its own
terms — a song heard on six separate days is more familiar than one heard six times in a
single sitting — but it is a proxy, and nothing downstream should describe it as a count.

A useful property: it is immune to the same track being recorded by both the poll and the
Takeout import, since both collapse to one distinct day.

One rule still covers both cases with no special path:
- A newly discovered setlist song has zero days → floats to the top.
- A song at the end of the setlist that never gets reached has few days → rises.

**True play counts are obtainable only from Takeout** (§7 phase 8), which has real
per-play rows. Any query that genuinely needs a count must filter `source = 'takeout'` and
accept that it covers only the backfilled window.

### Entry into cram

| `added_reason` | Trigger | Confirmation |
|---|---|---|
| `new_setlist` | Song found in recent setlists, missing from playlist | automatic |
| `neglected` | Low play count vs. rest of playlist | **user confirms** |
| `manual` | User asks directly | n/a |

Newly discovered setlist songs go into **both** zones: inserted at the correct
`setlist_position` in the body (shifting later songs down), *and* given a cram row.
When cram is cleared, the setlist is complete and correctly ordered.

Capped at `dj_playlists.cram_cap` (default 8). Past that, cram stops focusing
attention and becomes the playlist again.

### Non-concert playlists

`artist`, `jazz` and `discovery` playlists are flat — no setlist body, no cram block.
"Build a Garbage playlist, they aren't touring" creates a plain artist playlist.
"Build a Metallica playlist, they're at the Sphere Oct 15 – Nov 11" creates a concert
playlist *plus* a `dj_concerts` row at `screening`.

### Edit mechanics

YouTube requires reading a playlist to learn each entry's `setVideoId` before any move
or remove. So a cram rebuild is: add items → re-read playlist → issue moves.
`dj_playlist_tracks.yt_set_video_id` caches this, but it is **a cache only** — refresh
on every read, treat as possibly stale.

### ⚠️ `setVideoId` is NOT unique to a song, and NOT unique across playlists

Measured 2026-08-28 during the phase-3b rebuild. Of the twelve handles on a freshly
created playlist, **eleven already existed in a different playlist**, and three of those
denoted a *different song* there:

| Handle | In the new playlist | In the old playlist |
|---|---|---|
| `9495DFD78D359043` | Go Away | **I Just Threw Out the Love of My Dreams** |
| `F63CD4D04198B046` | I Just Threw Out the Love of My Dreams | **Go Away** |
| `D0A0EF93DCE5742B` | Buddy Holly | **Say It Ain't So** |

Within a single playlist the values ARE unique — 160 entries, 160 distinct handles. So
**the `(video_id, set_video_id)` pair scoped to its originating `playlist_id`
disambiguates, and nothing weaker does.**

**Why this is more dangerous than staleness.** A stale handle no longer exists, so the
operation fails and you find out. A handle carried in from another playlist **matches a
real entry and succeeds** — a move or a remove performed on the wrong song, reported as
success. That is the "wrong answer that looks right" class, and nothing downstream would
notice.

**Rules, enforced in the tools rather than left to callers:**

- **Always carry `video_id` and `set_video_id` together.** `edit_dj_playlist` mode `move`
  now *requires* both, and `remove_from_dj_playlist` already did.
- **Always scope a handle to the playlist it was read from.** Never cache a bare
  `set_video_id`, and never reuse one across playlists.
- **Both tools re-read the target playlist and verify the pair before acting**, turning a
  foreign handle into a clean `stale_or_foreign_handle` error instead of a silent
  wrong-target write. That costs one extra read per operation, which is affordable
  precisely because §5 already puts cram rebuilding in the weekly job rather than an
  instant response.

⚠️ **Phase 7 is the consumer of this.** Cram reordering moves entries in bulk, which is
exactly the pattern that would otherwise cache handles and reuse them.

This chattiness is why cram rebuilding belongs in the weekly job, not in an instant
response.

---

## 6. Failure handling

### What Claude can see directly

A scheduled Claude task *runs the code*, so it observes failures in full: Workshop
unreachable, auth rejected, zero plays returned, Supabase write erroring. The
notification path is therefore just a tool call — **write an Alfred inbox item**,
a surface already checked daily, and the ecosystem's existing pattern for "needs
attention."

Claude distinguishes failure kinds. Expired YouTube credentials → "run the reauth
tile." Network blip → retry.

### What it cannot see

A task that never fires. Three mitigations, in order of reliability:

1. **The task checks itself.** Every run begins by reading the newest successful
   `platform_runs` row for its job. Older than expected → backfill the gap. Makes a
   single missed day self-healing.
2. **Alfred surfaces staleness at app-open.** A different system, a different network
   path, triggered by the user rather than a timer. This is the one that catches the
   task not firing at all. Built late (§7, phase 9).
3. **The Friday review notices.** "I only have two days of listening this week." Slow
   but real.

### The recovery window — measured, not assumed

Probe on 2026-08-27 returned **200 items spanning Today / Yesterday / This week /
Last week.** So roughly a two-week window *at the current listening rate*.

**⚠️ Corrected in phase 1: the window is measured in PLAYS, not days — and 200 is a
hard ceiling.** `ytmusicapi.get_history()` sends a single browse request and never
follows a continuation; there is no pagination loop in it. No parameter reaches past
~200 items, and no tool change can, because the data is not offered.

So days-of-coverage is a function of listening volume:

| Rate | 200 plays covers |
|---|---|
| ~15/day (the 2026-08-27 two-day average) | ~13 days |
| ~28/day (that day's own rate) | ~7 days |

**Consequence: a daily poll is still comfortably safe** — losing data requires 200
plays to accumulate between polls. The twice-daily idea stays dropped. But the failure
budget is **~200 plays of downtime, not ~2 weeks**, and a heavy listening stretch
shortens it in days.

**Consequence for phase 5:** a gap longer than ~200 plays is **unrecoverable from the
live API**. Only the Takeout backfill (phase 8) can fill it. A sync that sees
`page_full: true` *and* a gap since the last successful `platform_runs` row should
record that some plays are permanently missing from the live source rather than
reporting a clean backfill.

**Note `page_full: true` is the normal steady state for an active listener**, not an
alarm — at ~200 items the page is essentially always full. It is a floor marker, not an
error signal. What matters is `page_full` combined with a gap.

`notified_at` on `platform_runs` stops one broken credential minting an identical
inbox item every day.

---

## 7. Build phases

Phase 0 is complete. Each phase is verified before the next begins.

### Phase 0 — Schema and auth proof ✅ COMPLETE

- 12 tables created across migration blocks A–E. `CONFORMANT` at 27 tables.
- `ytmusicapi==1.12.2` installed in the desktop venv.
- Browser-header credential captured, `data/dj/browser.json` written.
- Probe confirmed: 43 playlists readable, 200 history items, full field shape.

### Phase 1 — Workshop DJ read tools (dev host only)

New module in `workshop/workshop/tools/`, imported in `tools/__init__.py`.
Tier 1, read-only. No Supabase anywhere in this phase.

Tools (prefer few with a `mode` param over many narrow ones — manifest budget):
- history read
- library playlists read
- single playlist contents read (returns `setVideoId` per entry)

**Verification:** tool count rises from 3 on the dev host; a fresh conversation can
call each tool and get the same data the probe returned.

### Phase 2a — The Alfred MCP write tools

**Split out of phase 2 once it emerged that the courier had no write leg at all.**
`supabase/functions/` contained zero `dj_` references: the arrow marked "(3) writes via
Alfred MCP" in §2 was a design, not code. Building it is Edge Function work with a
deploy and a manifest freeze in the middle — the same shape as phase 1, not a step
inside phase 2.

Three tools in `supabase/functions/_shared/tools/dj-courier.ts`, registered in
`mcp/index.ts`:

- `record_dj_plays` — tier 1. Tracks and plays in **one** call. Each element carries its
  track identity inline; the handler upserts tracks, resolves ids server-side, and
  inserts plays. Split into two tools, Claude would have to carry ~200 UUIDs back across
  the conversation and re-associate them by hand — a mapping step that can silently pair
  a play with the wrong track.
- `create_platform_run` — tier 1. Separate **because the runs that matter most have no
  plays to write**: a failed poll still has to stamp `failed` / `auth_expired`.
- `get_platform_runs` — tier 1 read. Newest successful run for an `app`+`job`. This is
  §6 mitigation 1: every run starts by reading it and backfilling any gap.

**Verification:** deploy, confirm MCP auth survived (see §8), tool count rises by three,
and a fresh conversation can call each one.

### Phase 2b — The courier loop, end to end

User asks Claude to sync a day. Claude calls Workshop, receives plays, passes them to
`record_dj_plays`, stamps `platform_runs`.

**First write. First real test of the match-key normaliser** — specifically whether
`(Remastered 1999)` groups correctly.

**Verification:** row counts in `dj_tracks` / `dj_plays`; spot-check that variants
grouped; `platform_runs` has an `ok` row with correct `covered_from`/`covered_to`.

🚧 **HARD GATE: sync the same day twice; the second run must insert zero rows.** This is
the first live exercise of the occurrence rule — the history page contains no repeated
`(video_id, bucket)` pair, so real data has never tested it and a broken implementation
would pass a smoke test unchallenged. If numbering is wrong it fails silently and
duplicates accumulate daily. Phase 2b does not close without this passing.

### Phase 3 — Weezer rebuild (first playlist writes)

The Weezer Concert playlist (160 tracks) is broken — it's a discography, not a setlist.
It is the exception among the concert playlists, and is the ideal first write target
because there is nothing to lose.

Exercises playlist create, add, and reorder in one go.

**Seed setlist — body zone, in this order.** Taken from the 2026 promo run (the same
set was played at Allegiant Stadium, Las Vegas, April 2026):

1. My Name Is Jonas
2. Undone - The Sweater Song
3. Pork and Beans
4. Beverly Hills
5. Hash Pipe
6. Island in the Sun
7. Happy Together *(The Turtles cover)*
8. Shine Again
9. Go Away *(with Bethany Cosentino)*
10. I Just Threw Out the Love of My Dreams *(with Bethany Cosentino)*
11. Say It Ain't So
12. Buddy Holly

**This list is knowingly incomplete, and that is the point.** WEEZER: The Gathering
opens 8 Sep 2026 in Sacramento and no true tour setlist exists yet. A touring Weezer
show runs ~90 minutes / 18–22 songs, so twelve is short by design. The gap is what
phase 7 fills — see below.

**Search hazards — REWRITTEN from observed catalogue data (2026-08-28).**
All four original notes were written from recall in one message; all four have now been
checked against the live catalogue, and two were wrong. Treat the versions below as
observed, and the originals as a lesson about writing hazard notes from memory.

| Title | Resolved | Note |
|---|---|---|
| *Happy Together* | `_PYx8y5QMA4` — Weezer, **Weezer (Teal Album)** | ❌ Original said "no Weezer studio recording, live-only." **Wrong.** The Teal Album is Weezer's 2019 covers record and this is on it. ⚠️ Six distinct recordings share this exact title — Weezer, The Turtles, Gerard Way, Filter, Johnny Cash, King Princess w/ Mark Ronson. Match on artist, not title. |
| *Shine Again* | `xgtGpafvvcs` — Weezer, album **Shine Again** | ✅ Original correct. Confirmed a real release, so the lone single-occurrence entry in the old playlist is legitimate rather than a stale bad match. |
| *Go Away* | `6pMf91N1tNU` — Weezer, **Everything Will Be Alright In The End** | ⚠️ Credited **`feat. Best Coast`**, NOT "with Bethany Cosentino". Same person — she fronts Best Coast — but searching her name misses it. |
| *I Just Threw Out the Love of My Dreams* | `r2dosVRzLSM` — Weezer, **Pinkerton - Deluxe Edition** | ✅ B-side as described, and it resolves cleanly. ⚠️ ASIAN KUNG-FU GENERATION also have a track under this exact title — another artist collision. |

Also observed: ***We Might as Well Be Strangers*** exists as a released track
(`uaSTJlDqPqI`, feat. Wednesday) — relevant to phase 7, which lists it as a strong
candidate for the real tour setlist.

**The old playlist is a lookup table, not a setlist.** 160 entries but only **50 distinct
songs**: twelve appear four times, thirty-seven three times, one once. It is a 49-song block
repeated three times with a 13-song head. ⚠️ **Anything treating those 160 entries as 160
songs is wrong by a factor of three.** Its value is the 50 already-resolved video ids.

**Privacy: the original is UNLISTED**, but `create_dj_playlist` defaults to PRIVATE. Set
privacy explicitly on the rebuild or it will not match the other concert playlists.

**Verification:** playlist visible and correctly ordered in the YouTube Music app.

### Phase 4 — Surface deployment ⚠️ TREAT AS A FULL PHASE

**This phase has a history of being harder than it looks.** RDP to the Surface has
previously produced user-account problems. Do not fold it into another phase.

Two separate things must reach the Surface, by two different routes:

**Code and dependency — via git.**
1. Pin `ytmusicapi==1.12.2` in `workshop/requirements.txt`. This is the sole
   dependency manifest; nothing else is read by the refresh script.
2. Commit and push.
3. Tap the **Refresh Workshop** Start tile on the Surface. It runs five stages:
   `git fetch` + `git reset --hard origin/main` (never pull — a merge conflict on a
   touch-only tablet is a wedged machine), `pip install -r requirements.txt`,
   restart the scheduled task, sleep, then health-check `127.0.0.1:7777/health`.

**Credential — by hand. It cannot travel by git.**
`browser.json` lives in gitignored `data/`, which is exactly what makes
`git reset --hard` safe on the Surface. So:

4. Either redo the Firefox header capture *on the Surface*, or copy
   `data/dj/browser.json` across. Copying is valid — the credential is tied to the
   Google account, not the machine. **Never solve this by committing the file.**
5. **Check file ownership.** The Surface repo was built by `rdpuser` and Workshop runs
   as `alexa`. This mismatch previously produced a `git_sha: unknown` symptom and a
   permissions cascade. Anything new written under `data/` must be readable by
   `alexa`, not merely by whoever was RDP'd in when it was created.
6. **Expect no console output on failure.** Workshop autostarts under `pythonw.exe`.
   A library that prompts, opens a browser, or writes to stderr produces *nothing
   visible*. Verify through `get_workshop_status` and `data/workshop.log`, not by
   watching a window.

**Then pin execution to the Surface:**
7. Disable the **Workshop (Dev)** connector in Claude settings during normal
   operation. Both hosts expose identically-named tools and Claude picks one — a
   daily task silently running against a desktop that is sometimes off is a failure
   that looks like something else for a week.
8. The scheduled task's prompt begins by calling `get_workshop_status` and confirming
   `host: surface`. A check that runs daily, not only at setup.

**Verification:** tool count on the Surface matches dev; a DJ read tool called with
dev disabled returns real data; `get_workshop_status` reports `host: surface`.

### Phase 5 — Scheduled daily task

Create the Claude recurring task. Seed the `platform_schedules` row *last* — the
schedule definition is the final step of standing a job up, not the first.

Task shape: confirm Surface → read newest successful `platform_runs` → backfill any
gap → poll → normalise → write → stamp run.

### Phase 6 — Failure tests

Deliberately break each path and confirm the right thing happens:
- Workshop unreachable → inbox item, `status: failed`
- Credential invalidated → inbox item saying *run the reauth tile*, `status: auth_expired`
- Task skipped a day → next run detects the gap and backfills
- Repeated failure → `notified_at` prevents duplicate inbox items

### Phase 7 — setlist.fm and cram logic

setlist.fm REST API v1.0. Free for non-commercial use, `x-api-key` header, keyed by
MusicBrainz artist ID (`dj_artists.mbid`) — name search can match the wrong band.

Weekly: pull recent setlists for upcoming concerts, diff against playlist body, insert
new songs into both zones, recompute cram order.

**Weezer is the live acceptance test, and the expected outcome is known in advance.**
The user attends a Vegas date in October; the tour opens 8 September. So by the time
this phase runs, real Gathering setlists will exist and the diff should surface songs
absent from the phase-3 seed.

Strong candidates, from repeated August 2026 TV and radio appearances (Tonight Show,
Today Show, SiriusXM, Apple Music Studios): **C.E.O.**, **Hoops**, **We Might as Well
Be Strangers**. A band promoting new material on television plays it on tour.

If the setlist diff does *not* surface these once the tour is underway, the diff logic
is wrong — this is a real test with a checkable answer, not a smoke test.

### Phase 8 — Takeout backfill ⚠️ LOAD-BEARING, NOT A CONVENIENCE

**Promoted in phase 2b.** This was scoped as "nice to have more history". It is now the
only source of two things the system cannot otherwise obtain:

1. **True play counts.** The history feed carries one entry per track per bucket (§5), so
   polling can never count repeats. Takeout has real per-play rows.
2. **Any exercise of multi-occurrence dedupe.** `occurrence > 1` cannot arise from polling
   — not rarely, *never*. Takeout is the only thing that will ever produce it.

It is also the only source that can ingest history at **any age**, since it carries real
timestamps rather than labels that move (§4.3).

If Takeout is never imported, distinct-day familiarity (§5) is all the system will ever
have, and `dj_plays.occurrence` stays permanently 1.


The Google Takeout export (requested 2026-08-27, scheduled to start 2026-08-29) gives
`watch-history.json` with **real timestamps** → `precision: 'exact'`.

Music entries are mixed with ordinary video watches. Filter on `- Topic` channels;
`videoType: MUSIC_VIDEO_TYPE_ATV` from the live API is a cleaner signal where available.
**Review the classification before committing rows.**

If the Google account has activity auto-delete enabled, history beyond that window is
already gone and cannot be recovered.

### Phase 9 — Alfred surfaces

- **Staleness banner** on the home view: newest successful run per app vs. expected
  interval from `platform_schedules`.
- **Sync history page**: reverse-chronological `platform_runs` with status, duration,
  error text.

Both read via `createUserClient(token)` like anything else — same database, owner
policy, no new plumbing.

⚠️ **Sequencing trap:** a new page means a new route, and `viewPaths.test.js`
hard-codes route/view counts. If the planned rewrite (deriving assertions from the
route table) lands first, this costs nothing. If not, expect to hand-update a
hard-coded number — the exact anti-pattern the rewrite exists to kill.

---

## 8. Platform constraints that govern this work

From the `mcp-platform` skill and `COMMENT ON SCHEMA platform`:

- **Never import the Supabase client in a tool file.** `ctx.db` from `defineTool` is
  the only DB path.
- **Every new table calls `platform.register_table()`**, schema-qualified, in the same
  migration.
- **Every migration block ends with `check_platform_conformance`.** `CONFORMANT` or
  it isn't done.
- **Declare a tier.** Reads and append-only writes are tier 1. Row updates are tier 2.
  Destructive or superseding writes are tier 3 and gate on `confirmed: true`.
- **Every param the handler reads must appear in the input schema.** Registration
  asserts this.
- **Clamp limits** (default 20, cap 50). Push every filter into the query before
  `LIMIT` — never filter a capped result in memory.
- **Two error classes.** Guardrail denials keep do-not-retry wording verbatim.
  Operational failures (expired YouTube auth, network) must *not* borrow it.
- **Register the module in `tools/__init__.py`** or the decorators never run and the
  tool silently doesn't exist.
- **The MCP manifest freezes at conversation start.** New tools need a fresh
  conversation. The settings-panel tool count is the reliable deploy confirmation —
  not the log, not `/health`.
- **Deploy with `npx supabase functions deploy mcp --no-verify-jwt`.** The flag is
  mandatory: the function runs its own OAuth/Bearer check, and without it Supabase's
  built-in JWT verification rejects requests before they reach any code.
  ⚠️ **The flag has silently reset on redeployment before.** Verify MCP auth after every
  deploy rather than assuming it held — the symptom is every tool failing at once with an
  auth error that looks like an expired connector rather than a deploy setting.

---

## 11. Verification principles

Standing rules, not phase notes. Each was learned by getting it wrong.

### 11.1 A verification needs a case that FAILS if the thing is broken

Before writing a check, ask: **would this have returned the same answer if the feature were
absent?** If yes, it is not a check.

Bitten three times:

| What happened | Why it read as fine |
|---|---|
| A stale `phase2a_smoke` row satisfied the newest-successful-run query | Gap detection *succeeded* — with a wrong answer |
| `finished_at` preceded `started_at` | Both timestamps were individually plausible |
| Twelve setlist tracks all had plays, so the zero-play check returned twelve | It would have returned twelve with zero-fill entirely broken |

The third is the purest form: the check was written *specifically* to test zero-fill, and
could not have detected its absence. **A subject where the property holds either way proves
nothing**, however carefully the criteria are worded.

Practical consequences:
- Pick a subject where the feature CHANGES the answer. If none exists, say so and record
  **NOT EXERCISED** — never a pass.
- Include a negative case. The tier-3 preview check only became meaningful when a
  deliberately mistyped id was added alongside the valid one.
- Phases 5 and 8 both have checks that could be written this way. Gap detection "finding no
  gap" and a Takeout import "inserting no duplicates" are both answers that a broken
  implementation returns just as readily as a working one.

### 11.2 Prefer failures that are loud over answers that are reassuring

Every silent failure this project has produced has erred in the comforting direction:
coverage looking complete, a duplicate looking absorbed, an album looking known. **Errors
that look like success are the ones that survive**, because nobody investigates them.

Where truncation would corrupt an answer rather than shorten it, **fail the call** — the
500-play submission cap and the 5000-row aggregate cap both do this. Where a value is an
estimate, name it as one (`estimated_days`, `precision`). Where a tool cannot tell two
situations apart, make it report both explicitly rather than collapsing them — which is why
`record_dj_plays` reports every ingestible bucket including those with `submitted: 0`.

### 11.3 The feed cannot be used to prove ABSENCE

YouTube's history feed can confirm a play **happened**. It can never confirm one **did
not**. Three independent observations (§9): items leave the page from the middle rather than
the tail; the oldest bucket is truncated at the page edge; and a stored play vanished from
the feed entirely.

**So gap logic must never reason "we saw back to X, therefore everything after X is
covered."** That inference fails in the reassuring direction — a dropout makes coverage look
complete — which is the direction nobody investigates (§11.2).

`dj_plays` is the authority on what was heard. A re-poll returning fewer rows than are
stored is legitimate and is **never** a deletion signal.

### 11.4 A record that cannot be checked against the thing it describes will eventually disagree with it, silently

`platform_runs` asserts coverage. **Nothing can verify that assertion against `dj_plays`** —
there is no link from a run to the rows it produced. Today the two happen to be
reconcilable because `dj_plays.observed_at` clusters into visible batches, but **that is a
coincidence of how the data looks, not a property of the design.** Two writers a second
apart would be indistinguishable.

So gap detection reading `platform_runs` is trusting a record it cannot audit. Concretely:
a run that writes plays and fails to stamp leaves coverage the log does not know about —
the data ahead of the record, with nothing flagging it. And a manual run keeps coverage
current, masking a scheduled task that has died.

**The rule: where a derived record and the underlying data disagree, THE DATA WINS.**
"What is the newest `played_on` I actually hold?" is answerable from `dj_plays` and cannot
drift. "What does the log say I covered?" can. Reconcile, do not trust.

This is the same principle §11.3 applies to the feed, applied to our own log — and it is
the fourth instance of one shape:

| Instance | The record | What it disagreed with |
|---|---|---|
| Stale `phase2a_smoke` row | newest successful run | what had actually been synced |
| `finished_at` before `started_at` | a run's duration | the order events happened in |
| Skipped bucket invisible in row counts | what a run covered | what it submitted |
| Unstamped run | coverage in `platform_runs` | rows in `dj_plays` |

**A foreign key from plays to runs is NOT the fix being proposed** — that is a schema change
and phase 5 does not need it. The fix is that every consumer of a derived record reconciles
it against the source rather than treating it as authoritative.

---

## 9. Reference

**Playlists (from probe, 2026-08-27):** 43 total. Concert playlists include Foo
Fighters (30), Weezer (160 — broken), Smashing Pumpkins (15), No Doubt (29), Goo Goo
Dolls (23), Ed Sheeran (29), Blues Traveler (27), The Weeknd (0), Alanis Morissette
(23), Kenny Chesney (26), Coldplay (24), Jelly Roll (21), Post Malone (30), Chicago
(18), Styx (17), Motley Crue (14), Oasis (19), Black Eyed Peas (20), Killers (21).
Jazz: "Jazz songs Mix" (108), "Christmas jazz" (83).

**Concert seed data:**
- **Weezer** — Las Vegas, October 2026, WEEZER: The Gathering — `committed`
- **Foo Fighters** — upcoming — `committed`
- **Smashing Pumpkins** — 30 Oct — `interested`
- **Metallica** — Sphere, 15 Oct – 11 Nov — `screening`
- **No Doubt** — attended 2026 — `attended`
- **Coldplay**, **Jelly Roll**, **Post Malone** — attended 2025 — `attended`

The Vegas date being *late* in the tour run is favourable: weeks of real setlists will
exist before the show, so the cram loop has genuine data to work from.

**Concert statuses:** `screening` (deciding), `interested` (want to, not committed),
`committed` (going), `attended` (went), `missed` (didn't go **but still want to see
them**), `rejected` (not for me). The lingering want in `missed` is a fact about the
artist, so it is recorded as artist feedback — the concert row records only what
happened that night.

**Venue notes** are durable facts about the room (the Sphere has good and bad seats;
the Colosseum is excellent even from the worst seats). Reactions to a specific night
go in `dj_feedback`, not `dj_venues.notes`.

**⚠️ ytmusicapi returns numeric fields as strings.** `get_library_playlists` reports
`count: '160'`; `get_playlist` reports `trackCount: 160`. Same quantity, two types — and
a text sort places `'95'` above `'160'`. **Treat every ytmusicapi numeric field as a
string until verified**, and coerce at the tool boundary rather than downstream. Found in
phase 1; relevant to phase 7's setlist cross-referencing and to any write-side tool.

**⚠️ `limit` IS A FETCH HINT THROUGHOUT ytmusicapi — a general property of the library,
not a per-method quirk.** Confirmed three times across three different methods:
`get_playlist(id, limit=100)` returned all 160 tracks; `search(query, limit=3)` returned 20;
`get_library_playlists` behaves the same way. In each case the first response already held
more than was asked for, so the library never paginated and never trimmed.
**A declared cap is enforced by slicing in the handler or it is not enforced at all.**
Assume it of every ytmusicapi call that takes a `limit`, including ones not yet used.

**⚠️ THE HISTORY FEED IS LOSSY, NOT MERELY TRUNCATED.** Three independent observations:
items leave the page from the MIDDLE rather than the tail (`Today` 28→29 while `This week`
105→104); `oldest_bucket_is_partial` cuts a bucket at the page edge; and **a play stored
yesterday vanished from the feed entirely while still present in `dj_plays`.** Together
these mean the feed cannot be treated as authoritative about the past.
**`dj_plays` is the authority on what was heard.** Re-polling a covered window can
legitimately return fewer rows than are stored; that is not a bug and never a deletion
signal — `dj_plays` is append-only. Phase 5 gap logic must not reason "we saw back to X,
therefore everything after X is covered": a dropout makes coverage look complete, so the
error is silent and in the reassuring direction.

**⚠️ The history feed carries one entry per track per bucket.** Positioned at that track's
most recent play; repeats do not stack. Measured in phase 2b (§5). Consequences: play
counts are not obtainable from polling, and `occurrence` will never exceed 1 from the poll.

**⚠️ `dj_tracks.album` is unreliable when the source is a mix or radio station.** Of the 31
rows written by the first courier run, **30 record `"Summer Jazz: Herbie Hancock"` —
including tracks by Wayne Shorter, Jackie McLean and Lionel Loueke**, who have nothing to
do with that compilation. The field records **what was listened THROUGH, not what the track
is FROM.** `dj_albums` cannot be fed from the history feed. Decision owed in phase 3: null
it when untrustworthy, or carry a reliability flag. Cheap to settle at 31 rows, expensive
after Takeout.

**⚠️ UNEXPLAINED — the page tail does not behave as a simple queue.** Adding one play to
`Today` should push one item off the oldest end. Observed instead: `Today` 28 → 29,
`This week` 105 → 104, `Last week` 64 → 64. The departing item came from the middle, not
the tail. **Logged as unexplained; not theorised about.** It undermines treating
`oldest_bucket_in_page` as a stable coverage floor.

**⚠️ `video_id` is not unique within a playlist.** Weezer Concert holds Island In The Sun
at positions 5, 13 and 62, each copy with its own distinct `setVideoId`. This is the same
property §5 relies on to make cram zones work. **Key playlist entries on `set_video_id` or
`position`, never on `video_id`.**

**Reconnecting the Alfred MCP connector — do NOT use automatic registration.**

⚠️ **"No client ID — register one automatically" FAILS on reconnect.** Dynamic Client
Registration mints a *fresh* registration every time, so each reconnect attempt creates a
new client rather than reusing the working one. The MCP server itself is fully compliant —
**the failure is on Claude's side of the DCR handshake**, so there is nothing to fix
server-side and no amount of redeploying will help.

Use **"Use your own OAuth client"** with:

| Field | Value |
|---|---|
| client_id | `2804f812-ea1a-4827-9443-3421fc4771f5` |
| client secret | **blank** |

It is a public client already registered with Claude's redirect URI. Recorded here because
this is exactly the kind of procedure that is stale by the time it is next needed, and the
symptom (auth failing on a server that is working correctly) points in the wrong direction.

**Paths:**
- Workshop: `C:\Users\Alex\projects\alfred-v5\workshop`
- venv: `workshop\.venv` (VS Code does not auto-activate; use the explicit
  interpreter path)
- Credential: `workshop\data\dj\browser.json` (gitignored, per-host, unbacked-up)
- Re-auth: recopy Firefox request headers → `data\dj\headers.txt` →
  `python scripts\dj_auth.py`

**Header capture is Firefox-only in practice.** Chrome 151 removed "Copy request
headers" from the context menu and hides the Raw toggle. Firefox: Ctrl+Shift+E,
filter `browse`, right-click a **POST** with status 200, Copy → Copy Request Headers.

⚠️ **The headers file contains a full Google session cookie** — not merely a YouTube
credential. It must never be pasted into a chat, a note, or anywhere but the target
file. Only a Google password change invalidates a leaked one.

---

## 10. Open questions

- ~~**Weezer rebuild source.**~~ **RESOLVED.** Seed setlist supplied manually in
  phase 3; phase 7 fills the gap once the tour opens. Phase order unchanged.
- **Discovery mechanics.** "Deeper cuts from artists I'm mildly familiar with" is
  clear as intent; the selection algorithm is not designed yet.
- **Jazz path.** An album-a-week route through the genre was discussed but not
  designed. `dj_albums` supports it; the curriculum doesn't exist.
- **Weekly conversation shape.** The "you played Metallica three times, how do you feel
  about them?" prompt falls out of the Friday job naturally, but its exact form —
  what it asks, how answers land in `dj_feedback` — is undesigned.
