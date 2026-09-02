# DJ — Technical Specification

**Status:** Phases 0, 1, 2a, 2b, 3a, 3b, 6b, 6c, 8 complete. Phase 8 imported 16,766 rows on
2026-08-31; Phase 6b recorded the whole 41-playlist library on 2026-09-01; Phase 6c added
get_dj_concerts, update_dj_concert and record_dj_feedback (39 MCP tools). Phases 4, 5, 6, 7
outstanding; Phase 7's gate is built and its proposal shape is specified in §12.8–§12.13.
Phase 7 works for every act: 22 of 22 artists have an mbid as of 2026-09-01, each verified by
a live setlist read.
**Last updated:** 2026-09-01

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


#### 4.1.4 Artist aliases — one act, two vocabularies

**The precise diagnosis: nothing is mis-GROUPED. The damage was in `dj_tracks.artist`.**

`match_key` is `artist|title`, so two tracks group only if BOTH halves match — and there are
**0 same-title-different-video pairs** for either affected act. So the differing artist
prefixes never caused a wrong grouping. What they did cause is **two strings for one act in
the `artist` column**, which is what an artist-level query reads. "You haven't listened to
Red Garland in a while" was the thing that broke: a confident wrong answer, not a
mis-merged track.

**Measured 2026-08-30, across all 94 poll tracks and all 4,563 export videos:**

| | Poll (YouTube Music metadata) | Takeout (`- Topic` channel) | Stored | Export-only |
|---|---|---|---|---|
| Eddie Higgins | `Eddie Higgins Trio` | `Eddie Higgins` | 5 | 25 |
| Red Garland | `Red Garland` | `The Red Garland Trio` | 12 | 4 |

**⚠️ The direction REVERSES between the two.** For Eddie Higgins the metadata carries the
ensemble name; for Red Garland the channel does. **That is why no automatic rule works** —
"prefer the longer form" or "strip a trailing Trio/Quartet" fixes one and breaks the other.

**Both vocabularies are internally consistent.** 0 split pairs among the export's 1,206
artists, 0 among the poll's. This is not a naming mess; it is two consistent systems meeting
at one boundary, which is why a map needs so few entries.

**The map is a CONSTANT in `dj-normalise.ts`, not a table.** A table is read at runtime while
`match_key` is frozen at write, so an edit on a Tuesday would make rows written Monday and
Wednesday differ — no code change, no deploy, nothing recording why. That is §11.6 with its
worst axis: table state as a silent input to identity, leaving no trace. A constant is in git
and versioned with its reader. **Changing it is a migration (§4.1.2), not a deploy.**

**Direction: canonicalise to the POLL's vocabulary**, even though the export is the larger
population. **"Which source keeps writing" beats "larger population":** Takeout is a one-time
import, the poll runs forever. Translating toward the poll applies the map once at import and
never again, and leaves the 17 already-stored rows **already correct — no UPDATE needed**,
so the insert-only guarantee is never bent.

**Every entry records WHY it is correct**, not just the mapping. Hand-curation is only better
than a derived rule if the reasoning survives for whoever adds the third entry.

**⚠️ MILES DAVIS IS DELIBERATELY NOT AN ENTRY — the case that shows this cannot be
automated.** He is the export's largest artist at 132 videos, and led quintets, sextets and
large ensembles across four decades. Whether `Miles Davis` and `The Miles Davis Quintet` are
one act *for familiarity purposes* is a genuine judgment call — someone deep in *Kind of
Blue* has not thereby heard *Bitches Brew*. **No such split exists in the data today.** If one
arises it needs deciding, not inferring.

**⚠️ KNOWN-PERMANENT DISAGREEMENTS ARE LISTED IN `docs/dj-known-disagreements.md`.** Some
entries are decided and will fire forever — `AbbzAPXvNZ8` (a Clark Terry collaboration, not
a spelling variant) and the 12 unrepaired `Release` rows. Check that page before
investigating: an entry on it has been decided, an entry not on it is new.

**Detection, so the third split is not silent.** `resolveTrackIds` already fetches existing
tracks by `video_id`; it also carries `artist` and `match_key`, and returns
**`artist_disagreements`** in every `record_dj_plays` and `dry_run_dj_plays` response. Empty
is the normal case; any entry is a new alias candidate. **Phase 5's task prompt must read it
into the run stamp**, because a signal nobody looks at is the failure this project keeps
finding. This also covers the ~1,241 export artists the map cannot anticipate.

**⚠️ THE COMPARISON IS ON NORMALISED PRIMARY ARTISTS, BOTH READ FROM `match_key`.** Not on
`dj_tracks.artist`, which holds the *joined display string* (`artists.join(", ")`). The first
version compared that column against a Takeout submission and fired on **all six
collaborations in batch 1** — `"Coldplay, BTS"` vs `"Coldplay"` — where nothing was wrong:
`match_key` uses `artists[0]`, both sides agreed on the primary, and the rows grouped
identically. Two representations of one fact, not a vocabulary split.

*A detector that fires on every collaboration is one its reader learns to ignore, and then it
will not catch the real case* — the same shape as marking an empty day `failed`.

Splitting the joined column on `", "` is **not** an equivalent fix: artist names contain
commas (*Earth, Wind & Fire*; *Crosby, Stills & Nash*; *Tyler, The Creator*), so it would
produce a wrong primary and reintroduce the same false positive somewhere harder to see.
`tidy` replaces every non-letter/non-digit run, so a `|` cannot survive normalisation and the
**first `|` in a `match_key` is unambiguously the separator** — the text before it is the
stored primary exactly as the grouping rules saw it. Both sides are read the same way, so
they cannot drift apart.

**⚠️ KNOWN GAP, UNCHANGED BY THAT FIX — AND IT IS THE IMPORTANT ONE.** `artist_disagreements`
fires **only when the SAME `video_id` carries a different stored artist.** A split spread
across **different videos** is invisible to it.

**That is precisely what Red Garland was.** `Red Garland` and `The Red Garland Trio` were
never two spellings on one video; they were two channels holding *different recordings*. So
**the detector built to catch future splits would not have caught the one that prompted
it.** Stated plainly because the reassuring reading — "detection is handled" — is wrong, and
an empty `artist_disagreements` is not evidence that no split exists.

Closing the gap needs the full stored artist vocabulary compared against incoming artists on
a normalised basis, independent of `video_id`. **Not built.** Until then the real safeguard
is the periodic split scan run by hand (progress log, 2026-08-31), which found exactly the
two known entries across all 1,241 export artists. ⚠️ That scan must be run with the stored
alias targets seeded as a **positive control**: both known splits are cross-source, so a scan
of export artists alone returns 0 whether or not it works.

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

> 🛑 **`played_on` MEANS THE UTC DATE OF THE PLAY. Both sources. Not "local", not
> "the account's day" — UTC, named.**
>
> **And this is FORCED, not chosen.** The poll only ever receives a bucket LABEL
> (`Today`, `Yesterday`). It never learns time-of-day, so a poll row can NEVER be converted
> to a local date — the information required does not exist in the feed. Poll rows can
> therefore only carry UTC dates, and Takeout must match THEM rather than the reverse.
> **The weaker source dictates the definition, because the stronger one can adapt and the
> weaker one cannot.**
>
> Confirmed empirically 2026-08-29 by cross-referencing every poll row against its exact
> Takeout timestamp: **41 of 41 disagreements fell in the discriminating window** (UTC hour
> < 8, where a UTC date and a Pacific date differ), **every in-window pair disagreed, and
> every one matched the UTC date.** No mixed cases. YouTube buckets by UTC day.
>
> **⚠️ KNOWN, BOUNDED DISTORTION.** UTC midnight is 17:00 Pacific in summer, 16:00 in
> winter — the middle of a listening day, not the middle of the night. A track heard Monday
> evening and Tuesday afternoon can collapse into one UTC day; one heard either side of
> 17:00 splits across two. **Bounded at ±1 day in both directions**, so it roughly cancels
> for a relative measure like §5's distinct-days. Recorded rather than papered over.
>
> **One genuine upside: UTC has no DST.** The Pacific boundary moves twice a year; the UTC
> one never does. A definition that does not shift under you is worth something.
>
> The ~94 existing poll rows **need no correction** — they already carry UTC dates. Under
> the corrected definition they were right all along; only the documentation was wrong.



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

**Measured on arrival, 2026-08-29: 18,188 entries spanning 2024-09-19 to 2026-08-29 —
~23.3 months, every month present.** Auto-delete has probably NOT pruned it: Google's
settings are 3 / 18 / 36 months, whose boundaries from that date fall at 2026-05-29,
2025-02-28 and 2023-08-29, and the oldest entry matches none of them. A pruned history would
end ON a boundary. 15,525 entries carry `header: "YouTube Music"`; 16,766 sit on a
`- Topic` channel. **Those two filters disagree by 1,241 entries — that gap is precisely
what the classification review is for.**

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

### 11.5 A claim about what data MEANS is as falsifiable as a claim about what it contains

Fifth instance, and a new variety. The previous four were **records disagreeing with the
thing they described**. This one is a record that was **CORRECT while its DOCUMENTATION was
wrong**: `dj_plays` rows always held UTC dates, and §4.2 asserted they were actual local
dates. Nothing was inconsistent. No query returned a wrong number. The meaning was simply
misstated — and it went unexamined for weeks **because the data looked fine, which it was**.

**A semantic claim needs checking the same way a factual one does.** "This column holds the
local date" is a hypothesis with a falsification condition, and it can be tested — here, by
finding rows where a local date and a UTC date would differ and seeing which one the data
matched. Nothing about the rows themselves would ever have prompted the question.

The tell: **a documented meaning that has never been checked against a case where the
alternatives diverge.** Everywhere the candidate interpretations agree, the documentation is
unfalsifiable, and unfalsifiable documentation drifts silently.

### 11.6 In an insert-only table, IMPORT ORDER IS A SILENT INPUT TO IDENTITY

Sixth variety of the same family, and the least visible yet.

`dj_tracks` is insert-only: whichever spelling of an artist arrives **first** becomes that
track's `match_key`, permanently. So when two sources disagree about a name — the poll takes
YouTube Music's artist metadata, Takeout takes the `- Topic` channel name — **the winner is
decided by which day the user happened to listen**, not by any property of the data.

Nothing errors. Nothing disagrees. Both spellings are correct in their own source. The
arbitrariness is **invisible after the fact**: looking at the stored rows later, there is no
trace that the outcome could have gone the other way, and no signal distinguishing "this is
the right name" from "this one merely arrived on a Tuesday".

**Measured instance:** `Eddie Higgins Trio` (poll, 3 tracks, written 2026-08-27) versus
`Eddie Higgins` (Takeout channel, 27 further videos). One act, two `match_key` groups,
because of a listening session's date. See §9.

**The tell:** any field written once, derived from a source that is not the only source. Ask
*which source arrives first, and does anything make that the right one?* If the answer is
"whichever happens to run first", identity is being decided by scheduling.

**Not the same as §11.4.** There, a record disagreed with the thing it described. Here every
record is accurate and mutually consistent; it is the **choice between them** that was never
made deliberately.

### 11.7 A detector that fires on the normal case will be ignored, and then it is worse than none

`artist_disagreements` compared `dj_tracks.artist` — a *joined* display string — against a
Takeout submission carrying one artist, and reported all six collaborations in batch 1 as
disagreements. Every one was correct data: `match_key` uses `artists[0]`, both sides agreed
on the primary, the rows grouped identically.

The cost is not the six lines. It is that **a signal which fires on the normal case teaches
its reader to skip it**, and it is then reliably silent about the abnormal one. Alex, on
seeing them: *"A detector that fires on every collaboration is one I'll learn to ignore, and
then it won't catch the real case."*

Same shape as marking an empty day `failed` (§11.2): both dress a routine state as an
exception, and both are repaired the same way — **compare on the same basis the system
actually uses to decide.** Here that meant comparing the normalised primary artist, read from
`match_key` on both sides, rather than two representations of the same fact.

⚠️ **The repair needs its own failing case.** "It reports nothing now" is satisfied equally by
a correct detector and a broken one. The fix ships with a test that a genuinely different
primary artist *is* still reported (§11.1).

### 11.8 Generated scripts: ASCII in console output, and save as UTF-8 with BOM

**Rule, for every generated `.ps1`/`.cmd`/`.bat`: ASCII only in anything printed to a
console, and write the file as UTF-8 *with* BOM.** Both, not either.

Non-ASCII has now broken three separate things in this build — console output on the `∞`
track, an artist name misread as mojibake during the Takeout encoding check, and an import
script that would not parse at all. The third is the instructive one:

Without a BOM, PowerShell 5.1 reads a `.ps1` as Windows-1252. `—` (U+2014) is `E2 80 94` and
`─` (U+2500) is `E2 94 80` — **both contain byte `0x94`, which is `U+201D RIGHT DOUBLE
QUOTATION MARK` in Windows-1252, and PowerShell accepts curly quotes as string delimiters.**
Each one inside a `Write-Host` string injects a phantom closing quote. One script had 39, an
odd number, so the final string never closed; the parser reported a missing terminator on the
**last line of the file** plus brace errors 70 lines earlier, none of them near the cause.

Why both halves of the rule: the BOM alone fixes parsing but is easy to lose to an editor, a
`.gitattributes` filter, or a copy-paste; ASCII alone fixes it but a future dash reintroduces
it. **Verify with the parser, not by eye** — `PSParser::Tokenize` plus
`[Language.Parser]::ParseFile`, and a byte check that nothing exceeds 127.

The general form: **an encoding is a silent input to a parser.** A file that is valid under
the encoding it was written in can be invalid under the one it is read in, and the resulting
error points at where the parser gave up, not at what broke.

### 11.9 A control must be a COPY, not a reconstruction

Bisecting a server-side 500, the failing batch was split into halves and the **unchanged
original** was emitted alongside them as a control - precisely so that "both halves
passed" could not be misread as a size limit when it might just be a transient fault
that had stopped.

The control was **rebuilt** with `json.dumps`, not copied. It carried the same data and
different bytes: the real batch files are pure ASCII because `json.dumps` escapes
non-ASCII by default, while the rebuilt file carried raw UTF-8. PowerShell 5.1 corrupts
non-ASCII in a string request body, so the probe files were mangled in transit and the
real ones could not be. **Every result in that run measured the splitter.**

The control was the one component whose whole job was to make the run falsifiable, and
it was the component that was wrong.

**The rule: reconstructing an artefact re-runs the code that produced it, and that code
is part of what is under test.** Copy the bytes. Then assert the copy is identical -
`dj_split_batch.py` now aborts if any emitted file contains a byte over 127.

Generalises past encoding: any control regenerated from source rather than captured
verbatim silently swaps "is this input broken?" for "does my generator reproduce this
input?" Those differ exactly when the generator is involved in the bug - which is when a
control matters.

⚠️ **Related but distinct from 11.8.** There, an encoding was a silent input to a
*parser*. Here it was a silent input to a *comparison*: two artefacts that compared equal
as data were not equal as bytes, and only the bytes travelled.

### 11.10 Never report that a call failed without reporting what it said

The import script's error path printed `$_.ErrorDetails.Message`, which is empty for
these responses under PowerShell 5.1. Every failure therefore rendered as:

```
  REQUEST FAILED (dry_run)

```

The response body, present on every one of those requests, said:

```
{"error":"platform_check_call_budget failed: JWT expired"}
```

**An hour of token lifetime, diagnosed as a data corruption problem.** What followed: a
bisect of the failing batch, a character-encoding investigation, a transport measurement
against a local HttpListener, and two probe runs whose results were void - all to find a
token that had timed out. The answer was in the first failed response.

**The rule: a failure report that omits the failure's own explanation is worse than no
report**, because it looks like diagnosis. It licenses exactly the kind of inference that
followed here - "reproducible, and only on these batches, so it must be their content."

Concretely: read the response body, print the status code, and fall back to the response
stream when the convenience property is empty. Test the error path with a real error - it
is the path least likely to have been exercised and most likely to be needed.

⚠️ **AND THE REASON IT LOOKED LIKE DATA: in a long sequential job, elapsed time correlates
with position.** Any time-based failure - an expiring credential, a rotating key, a
rate-limit window, a lease - impersonates a position-based one. Batches 1-29 passed and
30 failed because batch 30 is where the hour ran out; 31 passed on a fresh token; 32
failed on the next stale one and "recovered" later on another fresh one. That pattern
reads as *these specific rows are bad* and is entirely an artefact of when each request
was sent.

**Before concluding that item N is special, check what else changes monotonically with
N.** Here it was the clock. The cheap discriminator is to re-run an item known to have
PASSED: if the known-good item now fails too, nothing is specific to item N. That control
was missing from the first two probe runs and present in the third, which is the run that
answered it in four requests.

### 11.11 A rule the prompt only ASKS for is a rule that will be broken, once, at the worst moment

The first live scheduled DJ run, `42bc9fd0` at 20:09 UTC. Three rules governed it. It broke
one, obeyed one, and left a row that violates the third.

1. `create_platform_run` rejected `status: "running"` — the enum was
   `ok | failed | auth_expired | partial` and the prompt asked for a state the schema had no
   word for. **The run substituted `"ok"`.** That is a run recorded as SUCCESSFUL before it
   had done anything, in a durable log, written by a task whose first standing rule is *do
   not improvise*.
2. It then **caught itself** and re-stamped the run `failed` — the same rule, obeyed at the
   second decision point.
3. But the failed stamp carried **empty `details`, a null `error_message` and no
   `failure_kind`** — while `notified_at` was set. A failure recorded with not one word
   about why, **indistinguishable from a run that failed for no reason**, and marked as
   already notified so the de-dup would suppress the next one.

**The instructive part is not that a rule was broken. It is WHERE.** The rule held at the
second decision point and failed at the first — because at the first, obeying it meant
stopping with nothing done, and a plausible substitute was one token away. *A rule is
weakest at the moment following it is most inconvenient*, which is exactly the moment it
exists for.

**So: a constraint that matters must be enforced by the thing that receives the write, not
requested by the thing that makes it.** The prompt already said "quote the error verbatim"
and "never summarise a failure". It was not enough, and no amount of rewording would have
been, because the prompt is advice and the tool is a gate.

Changed in response:

- `platform_runs.status` gained **`running`** (migration 006), so the state the design needs
  is a state the schema can express. **A prompt asking for something the schema forbids is
  an improvisation generator** — it puts the writer in a position where every available
  action is wrong, and then relies on it choosing to stop.
- `update_platform_run` **REFUSES** to close a run as `failed` or `auth_expired` without
  both `error_message` and `details.failure_kind`. Not a convention: the write fails.
- The outcome fields are writable only on the transition **out of** `running`, enforced in
  the UPDATE's own WHERE clause. **A run that is open can be closed; a run that is closed
  cannot be rewritten** — which preserves "a log you can rewrite is a log you cannot trust"
  while allowing the open-then-close pattern that makes a died-mid-flight run visible.

⚠️ **The test for this class of rule is not "did the prompt say it" but "what happens if
the writer ignores it".** If the answer is "a row lands anyway", the rule is decoration.
Wherever this project relies on a caller doing the right thing, that is a gap in the tool
that has not surfaced yet.

### 11.12 An invariant check proves CONSISTENCY, not CORRECTNESS. Say which one you have.

`dj-grouping-check.js` passed cleanly across 4,732 tracks: 256 groups, zero `UNDER_FIRED`,
zero `CROSS_KEY`, zero `CHAINED`, zero `DANGLING`. It was reported as **"GROUPING
VERIFIED"**.

**An hour later a real wrong merge surfaced that the check had passed over.** Two different
acts sit in one canonical group under `release|deck the halls`, because both arrived with
the artist `Release` — a YouTube fallback channel label, not an act (§4.1.4). The group has
exactly one leader, no chains, no cross-key pointers, no dangling ids. **It satisfies every
invariant the check tests, and it is wrong.**

The check asks: *given these `match_key`s, is the grouping structurally sound?* It cannot
ask: *are these `match_key`s right?* — because it derives the expectation from the same
column it is checking. **A check built from the data it validates can only ever report
self-consistency.**

That is not a flaw in the check; it is its scope. The flaw was the label. **"Grouping
verified" reads as the stronger claim** and would have been cited later as evidence that
merges had been reviewed. It now reports **"grouping is internally consistent"**, and the
two claims are named separately wherever they appear.

**Correctness needs an outside source.** Here, three, none derivable from `dj_tracks`:
the channel id (one real artist maps to exactly one channel; `Release` spans **20**),
YouTube Music's own artist metadata, and a human reading the largest groups. The eyeball
pass over the 15 largest groups was the only correctness check performed — and it did not
reach `Deck the Halls`, a 2-member group far down the list.

⚠️ **The general form: when a check and the thing it checks share a source, the check
reports agreement with itself.** Before believing a green result, name what could have been
wrong and still passed. For this check that list is short and worth stating: *a wrong
`match_key`, consistently applied.* Which is exactly what happened.

### 11.13 Insert-only means a defect cannot heal itself, even when the correct value arrives

`dj_tracks` inserts use `ON CONFLICT (user_id, video_id) DO NOTHING`. So when the poll
submits the right artist for a track already stored with a wrong one, **the existing row
wins and the correct value is discarded.** It surfaces only as an `artist_disagreements`
entry - every time that track is played, forever, and it never repairs anything.

This was worth checking rather than assuming, because the intuition runs the other way. The
`Release` defect is takeout-only: YouTube Music's own metadata is correct and only the
Takeout channel name is the fallback label, so **any of those tracks played today would be
written correctly - if it were not already stored.** It looks self-healing and is not.
Insert-only converts "the right answer will turn up eventually" into "the right answer will
be discarded on arrival, repeatedly".

**The consequences to hold on to:**

1. **A defect in an insert-only table has a permanent floor.** It can only be repaired by a
   reviewed migration; time and use will not erode it.
2. **`artist_disagreements` is therefore not only a detector, it is a standing symptom.** The
   12 unrepaired `Release` rows will keep firing it. A reader who does not know that will
   read recurring entries as new drift.
3. **The cost of leaving a row unresolved is not zero**, and it is not just wrongness: it is
   recurring noise in the one signal built to catch a different problem.

That said, leaving 12 rows honestly wrong still beat guessing them - `match_key` is written
once, and a confident wrong key is unrepairable by the same argument. **The point is that
"we can fix it later when better data arrives" is FALSE here**, and any design leaning on it
in an insert-only table is leaning on nothing.

### 11.14 A constraint written in two places is a constraint that will be enforced in one

`platform_runs.status` gained `running` in three places, and I updated two of them:

| where | what it is | updated |
|---|---|---|
| the Postgres `CHECK` constraint | the database's rule | ✅ migration 006 |
| `VALID_RUN_STATUS` in `dj-courier.ts` | the handler's rule | ✅ |
| a hand-written `z.enum` in `mcp/index.ts` | **the MCP input schema** | ❌ missed |

The third rejects the call **before the handler runs**, so the live task failed with:

```
MCP error -32602: Input validation error … expected one of "ok"|"failed"|"auth_expired"|"partial"
```

while two other copies of the same list said five. I had reported the function as deployed
and "only the constraint outstanding" — **the deploy was real and the claim was still
wrong**, because the thing I deployed was not the thing rejecting the call.

Two lessons, and the second is the load-bearing one.

**1. Derive, do not duplicate.** The zod enum is now built from the exported
`VALID_RUN_STATUS`, so a list that exists once cannot disagree with itself. The same pass
found `get_platform_runs` unable to filter `status: "running"` — which would have silently
broken the orphan sweep the daily task depends on, a second victim of the same duplication.

**2. "I deployed it" is not "the caller can reach it".** A tool has at least four layers
that can each reject a call — the client's cached manifest, the server's input schema, the
handler's own validation, and the database constraint — and a change to one is not a change
to the others. ⚠️ **Verify at the layer the caller actually hits, not the layer you edited.**
Where that cannot be done from here (the deployed MCP schema is not introspectable without a
client), **say so** rather than reporting a deploy as a fix.

Related to §11.11 but distinct: there, a rule was ASKED for and not enforced. Here it was
ENFORCED, correctly, by a copy nobody had updated.

### 11.15 An operation that reports success without verifying its EFFECT is a check that cannot fail

Three instances in a single day, all the same shape, each one sending an investigation to
the wrong place:

| # | what reported success | what it actually confirmed | what it did not |
|---|---|---|---|
| 1 | a script's `catch` printing `$_.ErrorDetails.Message` | that a request failed | **what the failure said** — the property is empty under PowerShell 5.1, so every failure rendered blank |
| 2 | `supabase functions deploy` returning `Deployed Functions.` | that the upload succeeded | **that the caller could reach the change** — a stale enum in a different layer still rejected the call |
| 3 | a Python patch script's `.replace()` | that it produced a string | **that it matched anything** — the anchor was wrong, so the edit silently vanished |

**The common defect: the success signal is decoupled from the effect.** A deploy reports the
upload. A replace returns a string whether or not it matched. A catch reports that something
threw. None of them report that the thing you wanted is now true — and each was read as
though it had.

Instance 3 is the sharpest, because the same script got it right eleven times: every other
edit used `assert OLD in s`, and that one used `if ... not in ...` instead. **One guard
downgraded from an assertion to a conditional, and a whole deploy went out with a missing
binding.**

**The rule: assert on the postcondition, not on the operation.**
- Patch scripts: **every** `replace` asserts its anchor exists, with no exceptions — a
  conditional edit is an edit you have not verified.
- Deploys: verify by exercising the deployed thing, at the layer the caller hits (§11.14).
- Error paths: print the response body, and test the error path with a real error.

⚠️ **The tell is a report phrased in terms of the ACTION rather than the STATE.** "Deployed",
"patched", "request failed" — versus "the enum now contains five values", "the file now
defines RUN_STATUS", "the server said JWT expired". If a report cannot be false when the
work did not happen, it is decoration.

### 11.16 A negative control must reproduce the ACTUAL defect, not a plausible neighbour

A control exists to prove a check can fail. **It only does that if the thing it injects is
the thing that was wrong.** Three instances, and the third was caught only by luck of
checking twice:

1. **Check C** (zero-play familiarity). Subjects were twelve tracks that all had plays, so
   the check would have returned twelve whether or not zero-fill worked. It could not fail.
2. **The alias split scan.** Both known splits are CROSS-source — the export holds one side,
   `dj_tracks` the other — so a scan of export artists alone returns 0 regardless. Fixed by
   a **positive** control: seed the two stored names and require both to fire before
   believing a 0.
3. **The `RUN_STATUS` regression test.** The control moved the `const` below its first use,
   expecting a temporal-dead-zone error. **It passed.** Module evaluation completes before
   any request, so by the time `createMcpServer` runs the binding is initialised. The real
   defect was that the definition **did not exist at all** — and reproducing *that* failed
   all six tests.

In case 3 the control was green and the test was good; the near-miss was concluding "the
test cannot catch this" from a control that tested the wrong thing. **A green control is not
reassurance — it is a failed reproduction, and it means you do not yet know whether the
check works.**

**The two controls, and they answer different questions:**

| control | how | proves |
|---|---|---|
| **negative** | inject the real defect; the check must FAIL | the check is sensitive to what actually went wrong |
| **positive** | seed a known-true case; the check must FIRE | the check is capable of firing at all |

**A check with neither is a check nobody has tested.** And when a negative control passes,
the first hypothesis is that the injection is wrong — not that the defect is uncatchable.

### 11.17 When the authority is queryable, never copy it into a file

Migration 009 called `platform.register_table()` with a signature that does not exist:

```
ERROR: function platform.register_table(unknown, audited => boolean, exempt => boolean)
does not exist
```

It was copied from `000_RECONSTRUCTED_platform_runs_schedules.sql`, **a file whose own header
says its `register_table` invocations are best-effort guesses.** The real signature is
schema-qualified, `p_`-prefixed, and takes a `p_policy_mode` the reconstructed file omits
entirely.

⚠️ **And there was no correct example on disk to have copied instead.** No migration in this
repo creates a table — every `CREATE TABLE` in this system was run outside the migrations
directory — so the reconstructed guesses were the *only* `register_table` calls present.
**Checking a second file would not have helped. Only asking the database would.**

**The contract is stored in the database, as the `platform` schema's comment, specifically so
there is no copy to keep in sync.** `get_platform_contract` returns it, along with the live
registry and a conformance report. One call would have been right; reading a file was wrong.

**Two lessons, and the second is the one worth generalising.**

**1. A "best-effort" label describes a file's confidence. It does not say WHICH parts are
guessed** — so a reader treats the concrete-looking parts as fact, because they look exactly
like the correct parts. The header had said best-effort since the day it was written, and it
did not stop either of us. It now carries a banner naming the specific wrong thing, and each
call is annotated inline beside the real form. **A file that is wrong in a specific way must
say which way**, at the place the reader will actually look.

**2. Prefer the queryable authority to any transcription of it.** Where a fact can be asked
for at the moment it is needed — a function signature, a schema, a tool manifest, a live
config — reading a file *about* that fact adds a copy that can drift and gives no signal when
it has. This is the same failure as §11.14's duplicated enum, one level up: there, two copies
of a list; here, a copy of an interface. **Derive, or ask. Do not transcribe.**

⚠️ Corollary, and this is what made it expensive: the wrong copy was in a **migration**, which
is the one artefact class that looks most authoritative. A reader reasonably assumes a file
under `migrations/` describes something that actually ran. `000_RECONSTRUCTED` does not — it
exists so the schema has a source outside the database — and that distinction is invisible
from the filename alone.

### 11.18 A check that reads the SOURCE cannot prove the module LOADS

`dj_setlists.py` was verified with `ast.parse` and reported as *"parses cleanly"*. It did.
It also raised at the first line of the decorator the moment anything imported it:

```
TypeError: define_tool() missing 1 required keyword-only argument: 'input_schema'
```

**Both statements are true, and only one of them was the question.** `ast.parse` answers *is
this valid Python?* Nobody wanted to know that. The question was *does the server start?* —
and a missing required argument, an undefined name, a decorator that raises, a bad constant
at module scope are all perfectly valid Python that fail at import.

⚠️ **THE ONLY CHECK FOR "DOES IT IMPORT" IS IMPORTING IT.** This is §11.15 in its purest
form: an operation reported success without verifying the effect anyone cared about. It is
also §11.9 — a parse is a *reconstruction* of what the interpreter does, not a copy of it.

**Why it was expensive here rather than merely wrong:**

- `tools/__init__.py` imports every tool module **eagerly** — deliberately, so a missing
  import is an import-time error rather than a silently-absent tool. The same property makes
  **one bad module kill the whole server.**
- Workshop autostarts under **`pythonw.exe`, which has no console.** The traceback goes
  nowhere. Running `run.py` under `python.exe` is what finally showed it.
- So the symptom is not "Workshop crashed". It is **a 502 from the tunnel** — the tunnel is
  up, nothing is listening behind it — which reads as a network or deploy fault and sends the
  investigation to Cloudflare, to the deploy, to anywhere but the traceback.

**The fix is a test, not more care.** `tests/test_tools_import.py` imports `workshop.tools`
in a **fresh subprocess** and asserts the registry contains the expected tool set. Alfred
closed exactly this gap in `index.test.mjs` after the RUN_STATUS crash; Workshop had no
equivalent until now. Same fix, same reasoning, other language.

Two details that are load-bearing rather than incidental:

1. **A subprocess, not an in-process import.** `test_platform.py` calls
   `_reset_registry_for_tests()`, and Python caches modules — so an in-process
   `import workshop.tools` after that reset re-binds an already-imported package **without
   re-running a single decorator**, and the registry reads empty. The test would then pass or
   fail on TEST ORDER. A fresh interpreter also *is* what the server does, so the test
   reproduces startup instead of approximating it.
2. **The negative control reproduces the ACTUAL defect** (§11.16): a `@define_tool` call
   missing `input_schema`. Not a syntax error — a syntax error would be caught by the very
   `ast.parse` check that failed here, so a control built on one would prove nothing about
   the gap. The suite asserts **both** that `ast.parse` accepts the broken module **and**
   that importing it fails. Those two assertions next to each other are the lesson.

**Verified by reverting the fix and re-running:** the suite drops from 68 passing to
`FAILED (failures=2, errors=1)` and prints the real traceback. A test that has never been
seen to fail is a test that has not been checked (§11.1).

### 11.19 A failure signal surrounded by reassuring output is a failure signal that will be missed

The deploy looked successful. Commit, push, refresh tile, health check — and **the health
check did report unhealthy.** It was not missed because it was absent. It was missed because
of what was printed beside it: the log tail showed **historical `uvicorn` lines from before
the crash**, which read as ordinary healthy activity.

⚠️ **A tail is not timestamped against the event it is supposed to describe.** `tail -n 20`
answers *"what are the last 20 lines in this file?"*, never *"what did this process say when
it just tried to start?"* — and when the process died before logging anything, those are
**the previous run's lines**, indistinguishable from the current run's by inspection.

This is §11.15 one level out. There, an operation reported success without checking its
effect. Here, a check correctly reported failure and **the surrounding output made the
failure look like noise** — which costs the same as not checking, while feeling like
diligence.

**Two rules, and the second is the general one:**

1. **The log tail accompanying a health check must be bounded to the current attempt** — by
   timestamp against the restart, or by a start-marker line written on boot. Unbounded, it is
   evidence about a different run.
2. **When a check fails, its verdict must be the LOUDEST thing on screen.** Supporting output
   exists to explain a verdict, never to sit at the same visual weight as one. This is
   §11.7's argument in reverse: there, a detector that fires on the normal case gets ignored;
   here, a detector that fires correctly gets ignored anyway because the page around it looks
   normal. **Either way the outcome is a real signal that nobody acts on.**

### 11.20 A diagnostic that infers a CAUSE from one symptom and states a REMEDY as fact is worse than no diagnostic

`get_dj_playlists mode=contents` returned a `truncation_hint` whenever `returned < total`. It
had one symptom and it named a cause:

> *"Cut by `limit`, not by an upstream page boundary — all 108 are reachable. Re-call with
> limit: 108 (cap 200) to get them in one call."*

Measured on Jazz songs Mix, 2026-09-01: YouTube reports `trackCount` 108, and a read **at limit
200** returns 107 entries. **Every clause of that hint is false.** It was not cut by `limit` —
the limit was never reached. All 108 are not reachable. And re-calling with a higher limit
changes nothing, because the 108th entry is deleted or fully private: counted by YouTube and
never serialised, obtainable by no call that exists.

⚠️ **THE DAMAGE IS NOT THE WRONG ANSWER, IT IS THE CONFIDENT ONE.** A hint is read exactly when
the reader has least context — something looked odd and they went looking for an explanation.
Handing them a specific, plausible, actionable remedy at that moment ends the investigation.
Someone would have spent an afternoon re-calling with `limit: 108`, then chasing a track that
does not exist, and the real finding — *this playlist can never be read completely* — would
have been buried under a remedy that was tried and "didn't work".

**Silence would have been better.** With no hint, the reader compares 107 to 108 and asks why.
With the hint, they stop asking.

**The rule.** A diagnostic may state what it OBSERVED without limit. It may state a cause only
when it has evidence that distinguishes that cause from the alternatives. When it cannot, it
must say **"cause unknown"** and say what was ruled out — which is genuinely useful, and is not
the same as guessing.

The distinguishing evidence here was available and simply not consulted: the requested `limit`.
A result short of both the total **and** the requested limit was not cut by the limit, whatever
else is true. One extra parameter separates three outcomes that had been collapsed into one:

| observation | verdict |
|---|---|
| `returned == total` | complete |
| `returned == limit` and `total > limit` | clipped by `limit` — a higher one helps |
| `returned < limit` and `returned < total` | **NOT truncation. Cause unknown; a higher limit will not help.** |

⚠️ **AND THE THIRD CASE HAD A NEAR-NEIGHBOUR THAT WOULD HAVE MISLED AGAIN.** The obvious guess
is "unplayable tracks are dropped" — wrong. Three tracks in that same playlist come back with
`is_available: false`, so unplayable entries ARE returned. Stating the plausible cause would
have replaced one false certainty with another. The corrected hint names what was ruled out
and stops there.

**Same family as §11.19.** There, a real failure signal is lost inside reassuring output; here,
a real anomaly is lost inside a confident explanation. Both end with a true signal that nobody
acts on, and in both the surrounding text is what does the damage — the health check whose log
tail reads as normal activity is the same shape as a hint whose remedy reads as a diagnosis.

**Applies to:** `truncation_hint`, `reading` fields, health checks, error messages that suggest
a fix, and any `note` a tool attaches to a payload. The test to apply before writing one:
*could this sentence be false while the numbers beside it are true?* If yes, it needs evidence
or it needs to say less.

### 11.21 A second write that the first one IMPLIES must be SURFACED, not performed

`dj_concerts.status` has a column comment that is unusually explicit: *"missed = did not go
BUT still want to see them. The lingering want in missed is a fact about the ARTIST, so it is
recorded as artist feedback; this column only records what happened that night."*

So setting a concert to `missed` **implies a second write, in a different table** — a
`dj_feedback` row against the artist. Two obvious answers, both wrong:

**Writing it automatically is wrong.** A write smuggled into a status change is a write nobody
remembers happened. Months later *"why is there a `curious` feedback row for Alanis dated
2026-09-01?"* has no answer in any conversation, because no conversation ever mentioned
creating one. The audit log records that it happened and cannot record that it was **intended**
— and the whole value of `dj_feedback` is that it is a log of *stated* preference. A row nobody
stated is not preference, it is inference wearing preference's clothes, and every later read
treats the two identically.

**Dropping it is also wrong**, and it is the failure §13.3 was written about: recording only
the concert loses exactly the part that makes `missed` actionable later. The wanting is why the
playlist is worth building at all.

**The answer is to return it as a PROPOSED CALL and write nothing.** `update_dj_concert`
responds with:

```
feedback_owed: {
  reason: "status is now 'missed', which per the column comment means did NOT go
           but STILL WANT to see them. That want is a fact about the artist, not
           about this night, and it is not recorded yet.",
  suggested_call: { tool: "record_dj_feedback", artist_id: ..., sentiment: "curious", ... }
}
```

⚠️ **A READY CALL, NOT A REMINDER.** *"You should also record feedback"* is a to-do that will be
read, agreed with, and not acted on. A filled-in call is one step from done, and — more
importantly — it makes the proposal **checkable**: a reader can see which artist, which
sentiment, and disagree with either. Prose cannot be disagreed with precisely.

**⚠️ THIS IS NOT WHAT TIER 3 IS FOR, and conflating them produces the wrong design.** A tier-3
gate asks *"are you sure about the write you requested?"* — same write, delayed. This is a
**different** write, in a different table, that the caller never requested and may not know is
implied. Gating the status change behind a confirmation would be answering a question nobody
asked while still not surfacing the one that matters.

**The rule generalises:** when a write's MEANING implies a write elsewhere — because a column
comment says so, or because a status is defined in terms of something the table does not hold —
the tool performs the write it was asked for, and returns the other as a proposal. It never
does both, and it never silently does neither.

⚠️ **AND THE FLAG MUST NOT FIRE ON THE NORMAL CASE (§11.7).** `feedback_owed` is null for
`attended`, `rejected`, `screening` and the rest — it appears only for `missed`, the one status
whose definition reaches outside its own table. A field that appeared on every response would
be scrolled past by the third call, and then the one time it mattered it would be scrolled past
too. There is a test asserting it stays null for other statuses, for exactly that reason.

### 11.22 When two limits govern one operation, fixing the one that FIRED moves the failure rather than removing it

Two playlists could not be imported: General Running (223 tracks) and Elise's fun list (379).
The failure was a read capped at 200, so the question asked was *"is the 200 ours or YouTube's,
and can it be raised?"*

**It was ours** — `clamp_limit(cap=200)`, enforced by a slice. ytmusicapi paginates internally
and returns all 379 when asked for 400. Pagination was never needed.

⚠️ **AND RAISING IT ALONE WOULD HAVE PRODUCED A SECOND, DIFFERENT-LOOKING FAILURE.**
`record_dj_playlist` carried `TRACKS_CAP = 300`. A 379-track playlist would have been fetched
successfully and then refused on the WRITE with *"379 tracks exceeds the cap of 300. Nothing
was written."* Same root cause — a ceiling chosen for a payload that no longer applies — but a
different tool, a different message, and every appearance of a fresh problem discovered after
the first was "fixed".

**The shape.** An operation crossing more than one component is governed by every limit on the
path, and only the FIRST one reached ever fires. Fixing it does not remove the constraint, it
advances the failure to the next limit — which then presents as a new bug, in a different file,
with no visible connection to the change that "fixed" the last one. The second investigation
starts from scratch because nothing in the second error mentions the first.

**The rule.** Before raising a limit, ENUMERATE EVERY LIMIT ON THE PATH the work takes, and say
what each one is for. Not "is this limit correct?" but "what else is going to say no?" Read
cap, write cap, request body size, statement timeout, rate budget — the path here had five
plausible ceilings and two real ones. The enumeration is cheap and it is the only thing that
turns *"raise it and see"* into a change with a predictable outcome.

⚠️ **A LIMIT IS ONLY RAISABLE WHEN ITS PURPOSE IS NAMED**, and the two here had different
purposes that a single number concealed:

- The **read** cap bounds what enters a MODEL'S CONTEXT — 379 projected tracks is tens of
  thousands of tokens, and `get_dj_playlists mode=contents` is called directly by a model.
- The **write** cap bounds a payload a model COMPOSED and sent through a conversation.

Neither purpose applies to a script that reads YouTube and POSTs to Supabase with nothing in
between. So the answer was not a bigger number in both places: **the caps belong at the MCP
boundary, and the underlying read and write hold no policy of their own.** `read_playlist_contents`
takes the caller's limit; `get_dj_playlists` applies 200; the importer asks for 400. Same
projection, different ceilings — the same split as `preparePlaylistInput` between validation
and the thing that must not diverge.

⚠️ **RAISING BOTH GLOBALLY WAS THE TEMPTING WRONG ANSWER.** It works today and removes the
protection exactly when a model next asks for a 379-track playlist — and that failure arrives
as a blown context window, which is an expensive way to rediscover why the number was 200.

⚠️ **AND THE HIGHER CEILING MUST BE A NAMED, VISIBLE TOOL, NOT A HIDDEN PARAMETER.** An
undocumented argument that raises a limit reads as a backdoor, and the next person adding a
caller cannot tell which ceiling they are entitled to. `record_dj_playlist_bulk` is a separate
export, deliberately absent from the MCP manifest — the same pattern as `dry_run_dj_plays` —
so it costs no reconnect and is impossible to reach by accident.

⚠️ **RAISING A LIMIT MEANS FINDING EVERYTHING THAT *ASSUMES* IT, NOT JUST EVERYTHING THAT
*ENFORCES* IT — and the enumeration above only found the enforcers.** Read cap and `TRACKS_CAP`
were the two places that said no. A THIRD site merely *read* the number: the import endpoint's
truncation guard held its own `const CONTENTS_CAP = 200` and compared against it. It enforced
nothing, so it did not appear in a search for enforcement — and it broke immediately, reporting
every read over 200 as clipped.

**A site that only reads a limit is harder to find and fails more confusingly than one that
enforces it.** An enforcer that is wrong refuses work that should succeed, and says so in its
own words. A *reader* that is wrong keeps working and produces a wrong verdict about somebody
else's work — here, `379 of 379` reported as a cap hit, with an instruction to skip.

**The fix is not a better constant, it is no constant.** The guard now takes the ceiling the
CALLER used, as a required parameter beside the count. Any check comparing against a limit it
did not itself apply is measuring one path and reporting on another, and it will disagree with
the reader the moment either changes.

⚠️ **AND THE ORDERING WAS A SEPARATE BUG THAT THE STALE CONSTANT HID.** The guard consulted the
cap BEFORE checking completeness, so `read == library` — the definition of a complete read, and
a fact needing no cap at all — lost to the cap branch. Fixing only the constant would have left
a 400-track playlist read completely at a 400 ceiling still reported as clipped. **Check the
unambiguous condition first; consult the limit only for the cases that are genuinely ambiguous.**

⚠️ **The wrong verdict then asserted a false remedy (§11.20), for the second time in this
project** — *"the rest is unreachable... SKIP this playlist"* when nothing was unreachable.
Worse than the earlier case: this one **contradicted its own numbers in the same sentence**,
having printed `379` and `379` immediately before. A diagnostic that can disagree with the data
it just displayed is not reporting, it is narrating.

**And keep the guard that is now unlikely to fire.** With the read at 400, nothing in the
current library is over the cap, so the importer's `clipped_by_cap` branch is unreachable
today. It is correct, not dead: libraries grow, and the ceiling is still real. Deleting a
correct guard because the data has not reached it yet is how the next 200-track surprise
arrives unannounced.

### 11.23 A LIMIT THAT SHOWS UP AS DATA RATHER THAN AS AN ERROR WILL BE READ AS DATA

PostgREST caps every response at `db-max-rows` and reports the cut **nowhere in the body** — no
error, no flag, no short-count field. A response holding 1000 rows and one holding 1000 of 2400
are byte-identical to the caller.

On 2026-09-02 `get_dj_managed_playlists` mode=list reported *Smashing Pumpkins Concert: 0 tracks*
against a real 15. **The tell was not in the failing case. It was that the reported body counts
across all 41 playlists summed to EXACTLY 1000** — the cap wearing the costume of a measurement.
Nobody looking at the Pumpkins row alone would have seen it; the number was plausible, and "that
playlist is empty" is a thing that can be true.

⚠️ **THIS IS THE SAME SHAPE AS THE 200-TRACK PLAYLIST CAP, ONE LAYER DOWN.** A boundary that
truncates and returns 200 looks exactly like a playlist with 200 tracks. Both are limits that
arrive as content, and content is what a caller acts on.

**So: any limit that can silently shorten a result must be either PAGED PAST or REPORTED.** Never
left to be inferred, and never trusted to look wrong — it will look right. `get_dj_artists`
returning exactly 20 of 22 artists was the same defect, quieter, and it dropped Weezer off the
end of the alphabet.

⚠️ **AND IT DEFEATS GUARDS BUILT ON TOP OF IT.** `get_dj_plays` familiarity counted first, refused
above `SCAN_CAP` = 5000, then read with `.limit(5000)` — and was served 1000. The guard measured
the right thing and the read did not honour it (§11.15). A cap below your own ceiling makes the
ceiling decorative.

**A test suite cannot catch this unless its fake enforces the cap.** Ours did not, and stayed
green through all of the above: it was measuring a database that does not exist (§11.16).

### 11.24 THE FIX FOR A SILENT TRUNCATION CAN REPRODUCE IT, WEARING PAGINATION

The first pager written for §11.23 terminated when a page came back **shorter than the page
size** — the standard idiom, and wrong here for the exact reason the original was wrong.

**"Short page means last page" assumes the server returns what you asked for.** That is precisely
the assumption that failed. Ask for 1000 rows against a cap of 500 and *every* page is short, so
the loop stops after the first one and returns the same truncated answer — now with a pager in
front of it, which reads as evidence the problem was handled.

It was caught only because the test fake had been taught to enforce a cap **smaller than the page
size**, which the real server's cap is not. A fake that mirrored production exactly would have
passed.

**So: terminate on an EMPTY page, and advance by the rows ACTUALLY RETURNED.** It costs one extra
round-trip at the end and cannot be defeated by a cap whose value the code does not know.

⚠️ **THE GENERAL FORM.** When fixing a failure caused by an assumption, check whether the fix
rests on the same assumption. It usually can, and it will look like progress: the mechanism
changed, the defect did not, and the visible presence of a remedy makes the next reader stop
looking.

## 12. Concert playlists — the body of work (phase 7)

A concert playlist is **what to learn before the lights go down.** It is built from what the
act has ACTUALLY been playing, not from their catalogue and not from what I already know.

### 12.1 Source and identity

**setlist.fm, keyed on `dj_artists.mbid`.** Never on name: there is more than one act called
*Live*, more than one *Nirvana*, and a setlist for the wrong band is worse than no setlist.
`get_dj_setlists` refuses a name outright rather than falling back to search, so the failure
is *"you have not set the mbid"* and never *"here is somebody else's show"*.

### 12.2 The window is the LAST 10 SHOWS, and it is INCLUSIVE

A song appearing in **any** of those 10 goes in.

**⚠️ DO NOT QUIETLY TIGHTEN THIS LATER.** The asymmetry is the whole argument, and it is the
same one that settled the Takeout `header` gate: **an extra song costs one listen. A missing
song is a song I do not know when the lights go down.** Those are not comparable, so the
filter belongs on the over-including side. A future reader looking at a 40-song playlist and
thinking "we could raise the threshold to 3 of 10" is optimising the cheap direction.

**Empty setlists are skipped, not counted.** setlist.fm returns UPCOMING shows in the same
feed with no songs — on 2026-09-01 the Weezer feed held sixteen future dates ahead of a single
played one. A window taken naively would be mostly empties, each consuming a slot and
contributing nothing, and the diff would silently compare against far less than it claimed.
`get_dj_setlists` skips them and returns `empty_entries_skipped` separately, because *"we read
10 shows"* and *"we read 10 entries, 6 of them empty"* are different claims.

### 12.3 DECIDED 2026-09-01: promo appearances COUNT as shows

TV slots, radio sessions and corporate one-offs are shows for this purpose. Under the
inclusive rule they are in, and that is right on the merits: when Weezer played *C.E.O.* and
*Hoops* on the Today Show in August 2026, those were the new album's live debuts and certain
to appear on the tour.

**Recorded as a DECISION rather than left as a side effect of whatever the source returns** —
because for a band between tours it can be the *entire* window. Measured on 2026-09-01, the
last 10 Weezer setlists spanned six and a half months and were four promo spots, two
corporate gigs, a café show, a festival and a stadium slot. Not one tour show.

⚠️ **THE CONSEQUENCE: `N of 10` IS NOT COMPARABLE ACROSS SHOWS OF DIFFERENT LENGTH.** A song
in a 1-song *Tonight Show* slot scores exactly like one in a 24-song stadium set. So
`get_dj_setlists` returns `song_count` per show, and **any proposal quoting "appeared in N of
10" must show the shape of the denominator.** The number was requested to make an inbox item
actionable; unqualified, it would mislead instead.

⚠️ **THIS GOVERNS THE ANALYSIS, NOT THE PROSE — see §12.12.** Followed literally in the written
item it produced a caveat paragraph nobody could act on. The denominator goes INSIDE the
sentence: *"only at the Hollywood Bowl show"*, not *"1 of 10"* plus an explanation.

### 12.4 Covers resolve against the PERFORMING artist

Weezer's *Happy Together*, not The Turtles'. **If YouTube Music does not have their version,
it is not in the playlist** — no judgement about whether a cover "counts". This already worked
in Phase 3b, where the Teal Album cut resolved correctly and disproved the live-only hazard
note that had been written against it. `cover_of` is returned by the tool as information for a
human, never as a gate.

### 12.5 PROPOSAL ONLY — nothing writes to YouTube unattended

The weekly job reads setlists, diffs against the recorded body, and raises **one** inbox item.
Acting on it is a separate, human step.

**What that item looks like is specified in §12.8–§12.13, with a worked example in §12.13.**
The diff is half of it: §12.10's cram ordering is the other half, and the first item shipped
without it.

⚠️ **A CONSEQUENCE THAT MUST NOT READ AS CLOSED:** §5's interleaving rule and the
known-but-unplayed zero-play case **stay deferred**. Both need a cram row to exist, and under
proposal-only a cram row appears only when a suggestion is accepted. They are open, not done.

### 12.6 DECIDED 2026-09-01: the acceptance test runs NOW, against Foo Fighters

Weezer was the original subject and is the wrong one **today**: The Gathering opens 8
September 2026, so on 1 September zero tour shows exist and the window is entirely promo.

Foo Fighters are mid-tour on *Take Cover*, playing 18–24 song sets, so their last 10 setlists
are real full-length shows — which makes the window genuinely tour-shaped **and** makes
`N of 10` comparable, dissolving 12.3's caveat rather than working around it. Subject
playlist: `PLV2XoCH1Pv5y4eryZrOdxG2XlSxfdW32l`, 30 tracks.

**Weezer remains a second, later test with a known answer.** Re-run around 20 September, once
The Gathering has 10 shows behind it, and check that *C.E.O.*, *Hoops* and *We Might as Well
Be Strangers* surface from **real tour sets** rather than from the August TV appearances.
**If the diff surfaces nothing once the tour is underway, the diff logic is wrong.**

### 12.7 Title → `video_id` carries the Phase 8 rule

A setlist gives a title; familiarity and playlists need a `video_id`. Each proposed song is
resolved through `search_dj_music`, and **each resolution is a place a wrong match enters**.

**Match on the exact `video_id` or treat it as NOT FOUND. Never a plausible-looking result.**
That rule is what made the Takeout artist repair safe — it can only answer *found* or *not
found*, never *probably*. One search for *Happy Together* returned six different recordings.

⚠️ **"SEVERAL PLAUSIBLE CANDIDATES" IS A DIFFERENT STATE FROM "NO MATCH", AND §12.11 RESOLVES
IT.** Collapsing the two turns a resolvable tie into a question the human cannot answer — which
is exactly what happened to *Razor* on 2026-09-01.

### 12.8 REVISED 2026-09-01: the weekly proposal's SHAPE

**The first weekly item was wrong in shape, not in content.** The four songs and *"shall I add
them?"* were buried under three paragraphs on how to read *"1 of 10"*, and two items were
escalated as decisions that could not be made from what was presented. A proposal arrived as a
methodology paper with homework attached.

⚠️ **THE CAUSE IS WORTH NAMING, BECAUSE BOTH INPUTS WERE CORRECT.** §12.3 requires the
denominator's shape to be visible. §12.7 requires refusing to guess. Followed literally and
together, they produce 90% epistemics and 10% proposal. The rules were right; the balance was
not. **§12.3 and §12.7 govern the ANALYSIS. §12.12 governs what is PRINTED.** They are not the
same document, and conflating them is what went wrong.

**REVISED 2026-09-02: the weekly item has FOUR sections, in this order, and nothing else.**

⚠️ **THIS PARAGRAPH SAID "TWO" UNTIL 2026-09-02 AND THE ITEM HAD FOUR.** Sections 3 and 4 were
being asked for in the prompt and produced every week while the spec said they did not exist —
so the document that governs the item was not the document describing it. Recorded rather than
quietly corrected, because a spec that has drifted once will be trusted the same way next time.

| | section | source |
|---|---|---|
| 1 | concerts needing a status | `get_dj_concerts` — `needs_status` **and** `undecided` |
| 2 | upcoming concerts | `get_dj_managed_playlists` + `diff_dj_setlists` |
| 3 | jazz | `get_dj_plays mode=artists tag=jazz` |
| 4 | everything else | `get_dj_plays mode=artists` |

**The operational prompt is `docs/dj-weekly-review-prompt.md`.** ⚠️ Where it and this section disagree, THIS SECTION WINS and the prompt is stale — §14.25 records the two drifting apart once already, with neither document able to reveal it.

🛑 **SECTIONS 3 AND 4 ARE ONE TOOL AND ONE DEFINITION, DECIDED 2026-09-02.** Section 3 is Section
4 with a filter. `dj_jazz_activity` and `get_dj_jazz_activity` are **removed**. See SECTION 3 below.

#### SECTION 1 — CONCERTS THAT HAVE PASSED AND NEED A STATUS

Rows in `dj_concerts` whose date is in the past while `status` is still `screening`,
`interested` or `committed`. **One line each: act, date, venue.** Ask whether he went.

⚠️ **DO NOT GUESS, AND DO NOT INFER FROM LISTENING.** `attended` vs `missed` is a fact about
Alex that no table holds. A spike in plays around the date is not evidence — it is equally
consistent with cramming for a show he then skipped.

⚠️ **`missed` carries a second write.** Per the column comment, *missed = did not go BUT still
want to see them*, and the lingering want is a fact about the ARTIST — so it implies a
`dj_feedback` row, not just a status change (§13.3). Section 1 must not present `missed` as a
one-field update.

If no concert needs a status, **the section is omitted entirely.** Not "nothing to report" —
omitted. A section that appears every week saying nothing trains him to skip it (§11.7).

#### ADDED 2026-09-02: UNDATED `screening` ROWS THAT HAVE GONE QUIET

⚠️ **THE "I NEVER DECIDED" SIGNAL APPEARS NOWHERE TODAY, AND IT IS A DIFFERENT QUESTION FROM
"DID YOU GO?"** `needs_status` excludes undated rows by construction, and correctly — a watchlist
entry is not a show he might have attended. But that leaves a standing `screening` row with an
untouched playlist invisible forever: not past, not upcoming, not `needs_status`.

Measured 2026-09-02: **Oasis** (playlist run once, 2026-08-04) and **Black Eyed Peas** (run once,
2026-06-20, 74 days) — two acts worth seeing whenever they tour, against playlists barely
listened to. Neither has ever appeared in a weekly item.

**Surface an undated `screening` row when its playlist has gone quiet** — `runs` low and
`last_run_on` old, or never run at all. One line each: act, how much the playlist has been
played, when. The question is *"still interested?"*, not *"did you go?"*.

⚠️ **THE FIRST RUN GOT THE LIVE CASE WRONG BY LOOKING AT THE DATED ROW INSTEAD.** Smashing
Pumpkins (2026-10-30, `screening`) reads like the same shape and is not: 10 runs in 90 days, and
its least-familiar track has 7 distinct days. **It is not an undecided screening — it is a
playlist that went quiet 28 days ago**, which is a Section 2 observation about a show he is
probably going to. Two different sentences; do not let the shared status word merge them.

⚠️ **ALSO INVISIBLE, AND NAMED HERE RATHER THAN SOLVED: an undated `missed` row.** Alanis
Morissette is one. Per §12.8 `missed` implies a `dj_feedback` write (§13.3); if that write never
happened, **nothing will ever surface it again** — undated, so not past, not upcoming, not
`needs_status`. Hers was written and nothing is owed. The next one is a silent loss.

#### SECTION 2 — UPCOMING CONCERTS

One block per upcoming concert. Each block shows exactly five things:

| field | source |
|---|---|
| date of the concert | `dj_concerts.date` |
| the playlist name | `dj_playlists.name` |
| how often he has listened to that playlist | `runs` — §12.9 |
| when he last listened to it | `last_run_on` — §12.9 |
| songs missing from recent setlists | the §12.2 diff |

⚠️ **REVISED 2026-09-02: `cram_stale` STAYS IN THE PAYLOAD AND LEAVES THE PRINTED ITEM.** It
cannot fire yet. §12.10 state (b) needs a track *in* the cram block, and under proposal-only
(§12.5) a cram row exists only once a suggestion has been accepted — there are **zero cram rows
in the entire library**. State (a) needs a `distinct_days: 0` track and no upcoming playlist has
one. So the field reads `false` every week, for a reason that has nothing to do with the cram
list being healthy.

**That is §11.7 inverted: not a flag that fires on the normal case, a flag that cannot fire at
all.** A line saying `false` for two months teaches him to skip the section it is in, and then it
is worse than absent when it finally means something. **Bring it back the week there is a cram
row to be stale.** The tool keeps returning it — a field nobody can read is a field nobody can
check (§11.4) — the weekly item simply does not print it.

**Both halves are required and they answer different questions.** The diff asks *"what is in
the setlist that is not in my playlist?"* The cram list asks *"what is in my playlist that I
have barely heard?"* The first item shipped only the first, which made a
playlist-completeness check read as concert prep.

---

#### SECTION 3 — JAZZ, AND SECTION 4 — EVERYTHING ELSE

**ADDED 2026-09-02.** Both were being produced weekly while §12.8 said the item had two sections.

**Both are `get_dj_plays mode=artists`.** Section 3 passes `tag: "jazz"`; Section 4 does not.
One function, one definition, one set of field names.

##### 🛑 WHY THEY WERE MERGED, AND IT WAS NOT TIDINESS

The old Section 3 had its own definition — playlist membership, widened to the artists appearing
in those playlists. It produced two failures that are the same failure:

- **§14.13.** The definition could not reach outside the two jazz playlists **by construction**,
  while its own text named six pianists as evidence that it could. **Thelonious Monk — 20
  distinct days, 81 distinct canonical groups, the broadest repertoire of any artist in the
  library — was invisible to the jazz section for a quarter.**
- **§14.19.** Section 3 printed `in_playlist: false` for Wes Montgomery and Section 4 printed
  `in_any_playlist: true` for the same artist, in the same report. **Both were correct.** That is
  what two overlapping definitions produce, and renaming the field only fixed the instance.

**One definition cannot disagree with itself.** That is the whole argument.

##### ⚠️ WHAT THE MERGE COSTS, STATED BECAUSE IT IS A REAL LOSS

A jazz artist who is in a jazz playlist but **untagged drops out of Section 3.** The old
definition caught him automatically; this one does not.

🛑 **BUT "WE DROPPED THE PLAYLIST ARM" IS FALSE, AND ONLY THIS IS TRUE: THE PLAYLIST ARM NOW
WRITES TAGS INSTEAD OF BEING RECOMPUTED.** *"Is this artist on a track in a `kind='jazz'`
playlist?"* has a definite answer that does not depend on who is asking or when — it was never a
judgement, which is exactly why a machine could evaluate it at read time. It survives as an
**INSERT rather than a JOIN**: migration 018 writes one `dj_artist_tags` row per such artist with
`source = 'playlist'`.

⚠️ **WHAT ACTUALLY CHANGES is that the arm no longer self-updates.** Add a track to *Christmas
jazz* tomorrow and its artist is not tagged until something writes the row. **The cost is paid
visibly:** `dj_tag_candidates` reports any such artist as `derivable: true`, which is drift that
announces itself, and writing those rows requires no decision from anyone.

##### 🛑 A TAG-FILTERED SECTION MUST SAY WHAT IT CANNOT SEE. THIS IS A RULE, NOT A NOTE.

Section 3 reports exactly what is tagged. **A thin section and a thin listening habit are
indistinguishable without a coverage number** — and that is precisely how §14.13 happened: a
number describing its own reach as if it described the world.

**So `coverage` is fetched with the rows, never as a separate optional call**, and Section 3 is
not printed without `untagged_total` in it. An optional call is a call somebody skips on the week
it matters.

##### The tagging loop — the report proposes, Alex approves, the thread writes

**Twelve hand-seeded rows is a seed. This is the system that stops it rotting.**

`tag_candidates` splits into two kinds, and ⚠️ **THEY ARE NOT THE SAME ASK:**

- **`derivable: true` is a FACT.** The artist is on a track in a playlist whose kind matches the
  tag — the stored form of the old playlist arm. **Write it with `record_dj_artist_tag` without
  asking.** These are ordered first, because burying a fact in a list of judgement calls invites
  it to be treated as one.
- **`derivable: false` is a JUDGEMENT.** Propose it with the numbers — *"you played Dizzy
  Gillespie on 6 days, Charlie Parker 5, Wynton Kelly 5, none tagged. Jazz?"* — and let Alex
  answer. ⚠️ **NEVER AUTOMATIC**, for §14.9's reason: at least one artist string in this data is
  a scraped channel byline with a view count in it, and tagging an unknown to make a list longer
  is how a curated allowlist stops being curated.

🛑 **A "NO" IS A WRITE. RECORD IT WITH `status: 'rejected'`.** If declining leaves no trace, the
same names are proposed next week and every week after — §11.7, a signal that fires on the normal
case gets ignored, and then it is worse than none. **Absence is the only state meaning "not yet
asked"**, and it has to stay that way to be worth anything. *Harrison* is the live case.

⚠️ **NOTHING HARD-DELETES.** `rejected` is a soft delete carrying a reason, reversible by another
call and by the audit log. `record_dj_artist_tag` is **tier 2** for exactly this: a curated
allowlist that cannot be un-curated is not curated, and a mistaken approval must cost a sentence
rather than a migration.

##### What Section 3 does NOT gain

⚠️ **THIS IS STILL NOT AN ARTIST IDENTITY AND DOES NOT CLOSE §14.1.** `dj_artist_tags.artist` is
the exact `dj_tracks.artist` string — a match key, not a name. *"Oscar Peterson Trio"* and
*"Oscar Peterson"* are two rows if both appear. It is a curated allowlist over play strings, the
same shape as §4.1.4's `ARTIST_ALIASES`, hand-curated for the reason §14.7 gives: *"prefer the
longer form"* fixes Eddie Higgins and breaks Red Garland in one stroke.

⚠️ **SUBGENRE AND UNPLAYED ALBUMS REMAIN UNAVAILABLE** (§14.2, §14.3). And the section still
cannot propose an artist nobody has played — *"try Andrew Hill"* comes from the conversation,
never from listening history.

---

### 12.9 The two listening metrics — DEFINED HERE, because nothing stores them

**Neither exists today.** Nothing records "plays of a playlist"; both are derived from
`dj_plays` against `dj_playlist_tracks`. *"Listened to the playlist"* could mean any track in
it, or a run through most of it, and those are very different numbers — so the definition is
written down rather than invented in passing at implementation time.

#### `runs` — how often he has listened to it

**The number of DAYS in the trailing 90 on which at least `threshold` distinct canonical
groups from the playlist were played**, where:

```
threshold = clamp(ceil(0.5 * distinct_groups_in_playlist), 4, 20)
```

- **Why days and not sessions.** `dj_plays` buckets by UTC day (§4.2) and the feed carries one
  entry per track per bucket, so repeats do not stack (§5). Two runs in one day are
  indistinguishable from one. The unit is days, and the field name must not imply otherwise.
- **Why not "any track played".** *Everlong* is in the concert playlist and in general
  rotation. One unrelated play would mark the playlist as listened, every week, forever.
- **Why half.** Half of a 30-track playlist is about an hour of continuous listening — not
  something that happens by coincidence.
- **Why the floor of 4.** On a 6-track playlist, half is 3, which is comfortably reachable by
  accident. Short playlists need a higher proportional bar, not a lower one.
- ⚠️ **Why the CAP of 20 — added 2026-09-01, and it is not cosmetic.** Half of *General
  Running* (223 tracks) is 112, and half of *Elise's fun list* (379) is 190. Those are not
  thresholds, they are guarantees of zero: `runs` would read 0 forever on every large playlist
  and the metric would look broken rather than absent. 20 distinct tracks is about an hour of
  listening, which is the same thing "half" means on a 30-track concert playlist — so the cap
  keeps the metric measuring one consistent idea across a library whose playlists span 1 to
  379 tracks. **This became load-bearing the moment the whole library was recorded**, not
  before; the original caveat about jazz and discovery was the same problem seen early.
- **Canonical groups, not `video_id`s** — so a play of any variant counts, consistent with
  `get_dj_plays` familiarity mode.

⚠️ **A track in two playlists counts toward both.** Named, not solved. For concert playlists
(act-specific, largely disjoint) the overlap is small; for jazz and discovery playlists it will
not be, and this metric should not be reused there without revisiting the threshold.

#### `last_run_on` — when he last listened to it

The most recent day meeting that threshold. `null` if it has never been met.

**When `last_run_on` is null, show `last_touched_on` instead** — the most recent day ANY track
from the playlist was played. *"You've not run it, but three of its songs came up on 29
August"* is useful; a bare *"never"* on a playlist he has partly heard is wrong in feel and
invites a correction.

#### Where it is computed

`get_dj_plays` familiarity returns per-group aggregates, not the per-day co-occurrence this
needs, so **neither metric is obtainable from the current tools.**

**Build it as a third mode on `get_dj_managed_playlists`: `mode=engagement`.** That tool
already resolves membership, so the join `dj_playlist_tracks → canonical group → dj_plays` is
local to it. It returns `runs`, `last_run_on`, `last_touched_on`, and — non-negotiably —
`threshold_used` and `window_days`, because a bare `runs: 3` is uninterpretable and would be
the next thing to need three paragraphs of explanation.

---

### 12.10 The cram section — least-familiar-first ACROSS THE WHOLE PLAYLIST

§5 defines cram as least-familiar-first by distinct days. **That ordering has never been
computed on real data.** The first weekly item did not look at it at all.

**A song played twice a year ago is a better cram candidate than one played weekly.** Recency
and volume are different axes and both matter.

**The order.** Every track in the playlist, both zones, sorted by:

1. `distinct_days` **ascending** — never-played first (`distinct_days: 0`)
2. then `days_since_last` **descending, nulls first** — longest unheard first
3. then body `position` ascending — a deterministic tie-break, so the list does not reshuffle
   between runs for no reason

Take the top `cram_cap` (default 8).

⚠️ **DEDUPE BY CANONICAL GROUP BEFORE TAKING THE TOP N — added 2026-09-01.** Since migration
012 a playlist body may hold the same song more than once (Family party, Awesome, 5K, Yoga and
Archived Weezer all do; Archived Weezer is 160 rows and roughly 50 distinct songs). Sorting
rows and slicing would let **one song take several of the eight slots**, all with identical
familiarity because they resolve to the same canonical group — a cram list that looks full and
is teaching three songs. Collapse to one entry per canonical group first, then take the top N.

#### ADDED 2026-09-02: `cram_complete` — the state §12.10 did not have

**Not stale, not fresh. COMPLETE.** Measured 2026-09-02, the Weezer playlist held thirteen songs
whose *least* familiar had eight distinct days. The ordering was real and its purpose had
evaporated: a cram list of songs he already knows. `cram_stale` read `false` — correctly, and
uselessly.

```
COMPLETE = every canonical group in the playlist has distinct_days >= 5
```

⚠️ **THE 5 IS §12.10(b)'s EXISTING DEFINITION OF LEARNED, REUSED ON PURPOSE.** Two constants that
both mean "learned" is a constraint written twice, and it would be enforced in one (§11.14).

⚠️ **IT SELF-HEALS, WHICH IS WHY A FLOOR IS SAFE HERE.** Accept one song from a §12.2 diff and
the playlist stops being complete, because the new song sits at `distinct_days: 0`. The state
cannot latch on, which is the failure mode a threshold usually has.

**Three exhaustive states**, and the tool returns which: `complete` → nothing to cram, and any
existing cram rows should be CLEARED (under COMPLETE every cram row is by definition a learned
song holding a slot, which is state (b)); `stale` → (a) or (b) holds; `working` → neither.

Against the 2026-09-02 data: Weezer floor 8 → complete. Smashing Pumpkins floor 7 → complete.
Foo Fighters floor 2 → working.

##### 🛑 `cram_complete` NEVER APPEARS WITHOUT SETLIST COVERAGE BESIDE IT. THIS IS A RULE, NOT A NOTE.

**COMPLETE is a fact about the PLAYLIST. It is not a fact about the SHOW.** Weezer's thirteen
learned songs sit against **34 distinct songs** across the last ten setlists — `in_body` was 12.
*"You know this one"* is true of the playlist and false of the evening, and printing it alone
would wrong-foot him on the night.

**So every appearance of COMPLETE carries `in_body / distinct_setlist_songs` from the §12.2
diff**, which the diff already returns and which needs no new tool. Measured 2026-09-02: Weezer
12/34, Smashing Pumpkins 12/32, Foo Fighters 27/40.

**A complete playlist covering a third of the setlist is a WARNING, not a reassurance**, and the
sentence must read that way. `get_dj_managed_playlists mode=cram` cannot compute coverage, so it
states the requirement in its own `reading` rather than leaving it to the prompt — a rule the
prompt only asks for is a rule that will be broken, once, at the worst moment (§11.11).

#### ADDED 2026-09-02: a VARIANT CUT never takes a cram slot from its own studio recording

**The rule worked and the outcome was wrong.** Two of the Foo Fighters playlist's eight cram
slots were *Marigold*: Nirvana's studio original at body position 12, and the 2006 Pantages live
cut at 29. Genuinely different recordings by different artists, so the canonical-group dedupe
above correctly declined to merge them — and eight slots taught seven songs.

⚠️ **THE NIRVANA ROW IS DELIBERATE AND IS NOT A RESOLUTION ERROR.** Grohl wrote *Marigold*; it is
a Nirvana B-side, and Alex put it in the Foo Fighters playlist years ago. Any rule here must
leave it alone.

**The rule.** Within one playlist, when two cram candidates share a normalised title and at least
one of them is NOT a variant cut, the variant ones stand down. Variant is `isVariantCut` /
`_VARIANT_RE` — the same vocabulary §12.11 rule 2 already uses to refuse resolving a setlist entry
to a live recording. **You learn a song from the studio cut.**

⚠️ **IT NEVER MERGES TWO STUDIO RECORDINGS, WHICH IS THE ONLY REASON IT IS SAFE.** Deduping on
title alone would collapse Weezer's *Happy Together* onto The Turtles' — a cover and its original
are two songs to learn, and one of them would then never be crammed. This rule can only ever drop
a cut that is *marked* a variant, and only when a non-variant sibling is present in the same
playlist. **A playlist holding only a live cut still crams it.**

**When the tie is not a variant tie — two non-variant recordings sharing a title — nothing stands
down and `duplicate_titles_in_cram` reports it**, carrying artist and video_id so it is
settleable. That case is a judgement about this library, not a tie to break, and it is not made
silently.

#### `cram_stale` — the flag, and why it is NOT "the sort changed"

⚠️ **A flag that fires every week is worse than no flag (§11.7).** On a playlist being actively
listened to, familiarity moves constantly and a recomputed top-8 will differ most weeks. That
flag would be noise inside a month.

**`cram_stale` fires only on a STATE, never on sort drift. Two states, either sufficient:**

- **(a) An unlearned song is not being crammed** — a playlist track with `distinct_days: 0`
  that holds no cram row.
- **(b) A learned song is holding a cram slot** — a track in the cram block with
  `distinct_days >= 5`.

Both mean the cram list has stopped doing its job. A changed sort order does not.

---

### 12.11 NEVER ESCALATE AN AMBIGUITY WITHOUT A RECOMMENDATION AND A WAY TO RESOLVE IT

**"I cannot decide it, so *Razor* stays out" is a failure, not caution.** Two studio recordings
one second apart is something the system resolves or drops. It is not something to arbitrate to
a human who has less information than the system does.

⚠️ **THIS DOES NOT WEAKEN §12.7.** *Exact match or NOT FOUND* still stands, and a wrong
`video_id` is still the failure being guarded against. What changes is that **"several
plausible candidates" is not the same state as "no match"**, and it gets its own resolution
path instead of collapsing into a question.

**The tie-break, in order:**

1. **Artist must match** (§12.7). Covers, karaoke, tribute bands and "Originally Performed
   By…" are non-matches however well the title fits.
2. **Drop live / acoustic / remix variants**, unless the setlist entry is itself live-specific.
3. **Durations within 2 seconds → the same master.** Take the one on the artist's original
   studio album, say so in one line, do not ask.
4. **Durations differ by more than 2 seconds → a genuinely different recording.** Only now is
   it his call, and it arrives with **a recommendation, the reason, and a link to each so it is
   settleable by ear in seconds.**
5. **No artist match at all → NOT FOUND.** It goes in a one-line "couldn't find these" note,
   never as a question.

**Worked against the real case.** *Razor* returned `FBnH6sBvnl0` (*In Your Honor*, 4:54) and
`JSTGZqaEtkA` (*Catch And Release*, 4:53). One second apart → rule 3 → *In Your Honor*, the
original album. **One line in the item, no question asked.** What shipped instead was a
paragraph and a decision he had no way to make.

⚠️ **NEVER A QUESTION HE CANNOT ANSWER FROM WHAT IS IN FRONT OF HIM.** If answering means
opening YouTube, the item has failed §12.8 whatever else it got right.

---

### 12.12 Tone

**Concerts are fun. This is not a compliance report.**

- Short sentences. Friendly. Write like someone who is also looking forward to the show.
- **No paragraph explaining how to read a number correctly.** If a number needs caveats to be
  read right, **present a different number.**
- **This is how §12.3 is satisfied without a lecture: put the denominator in the sentence.**
  Not *"1 of 10 — but note the 22-08 show was 15 songs against a 25–27 median, so…"*. Just
  **"only at the Hollywood Bowl show"**. Same fact, no essay, and impossible to misread.
  Likewise *"he plays this most nights"* rather than *"9 of 10"*.
- No hedging. No "it may be worth considering".
- Absence is stated plainly and moved past: *"No setlists yet — the tour opens 8 September."*
  Not a paragraph on why the window is empty.
- **End with one question: "Want me to make these changes?"** That is the only question in the
  item. Everything above it is either a statement or a one-line recommendation.

  ⚠️ **REFINED 2026-09-02, BECAUSE THE RULE CONTRADICTED THE SECTIONS.** This was written when
  the item had two sections and one kind of change. It now carries three kinds of answer —
  concert statuses, artist tags, playlist adds — and Sections 1a, 1b and the tagging proposal are
  all requests for a decision. Written naturally they produce four or five question marks under a
  rule saying "one question".

  **The rule is ONE QUESTION MARK, and it is the last line.** Decisions above it are presented as
  **labelled items under a heading that says they are waiting on him**, not as question
  sentences — *"<act> — playlist run once, months ago. Still interested?"* loses its question
  mark and keeps its meaning. The closing question then **names the kinds of answer actually on
  the table that week** and drops the clauses that do not apply: *"So: any statuses to change,
  any of those artists to tag, and shall I add the missing songs?"*

---

### 12.13 WORKED EXAMPLE — the finished item

**Rules alone produced what shipped on 2026-09-01. This example is what the weekly job is
written against.** Numbers below are illustrative where the metric does not exist yet
(§12.9); the Foo Fighters songs, counts and video ids are real, from the 2026-09-01 run.

---

> **Two concerts coming up, and one I need to ask you about.**
>
> **Did you go to the Smashing Pumpkins?**
> 22 August, The Forum. It's still down as "screening" so I don't know how it went.
> Went / missed it / didn't end up going but still want to see them?
>
> ---
>
> **Foo Fighters — 17 October, Sphere**
> *Foo Fighters Concert* · 30 tracks · you've run it 3 times, last on 31 August
>
> **Five songs to add.** They've been playing these and you don't have them:
>
> - **Caught In The Echo** — off *Your Favorite Toy*, played at three of the last ten shows
> - **Of All People** — also off *Your Favorite Toy*, played once
> - **Home** — only at the Hollywood Bowl show
> - **I Should Have Known** — also only at the Hollywood Bowl show
> - **Razor** — also Hollywood Bowl. Two versions on YouTube Music a second apart, so it's the
>   same master; I've taken the *In Your Honor* one.
>
> That Hollywood Bowl show was the odd one out — a short set full of deep cuts. Three of these
> came from it alone.
>
> Couldn't find Foo Fighters versions of *London Calling*, *A320*, or the five-song jam medley
> they've been opening with. Leaving those out.
>
> **Your cram list needs a refresh.** Five of these you've never heard at all, so they go
> straight to the top:
>
> 1. Caught In The Echo — never played
> 2. Home — never played
> 3. I Should Have Known — never played
> 4. Of All People — never played
> 5. Razor — never played
> 6. Marigold *(live)* — 2 days, not since 22 August
> 7. Marigold *(Nirvana)* — 3 days
> 8. Window — 3 days
>
> *Everlong*, *The Pretender* and *Best of You* you've heard 40+ days each. They're safe.
>
> ---
>
> **Weezer — 3 November, Chase Center**
> *Weezer Concert 2026* · 13 tracks · you haven't run it since 20 July
>
> No setlists yet — The Gathering opens 8 September. I'll check again next week.
>
> Worth a listen before then, though — it's been six weeks.
>
> ---
>
> **Want me to make these changes?**

---

**What that example is demonstrating, point by point:**

- Section 1 first, one line, a real question, three answers offered — including the one that
  means *missed*, phrased as he'd say it rather than as a status value.
- Six fields per concert, in the §12.8 order, and no seventh.
- **Denominators inside sentences.** "three of the last ten shows", "only at the Hollywood Bowl
  show", "played once". §12.3 satisfied, §12.12 respected, no caveat paragraph.
- The Hollywood Bowl anomaly is **one sentence** — the finding survives, the essay does not.
- *Razor* resolved by §12.11 rule 3, one clause, no question.
- NOT FOUND items get **one line and no apology**, because they are the correct answer.
- The cram list is **the whole playlist by familiarity**, not the diff again — and it visibly
  connects to the add list, since never-played songs top it.
- The reassurance line (*"they're safe"*) exists so the cram list reads as focus, not as a
  backlog.
- Weezer shows absence handled in one line, plus a nudge that is useful rather than a
  paragraph on why the window is empty.
- **One question, at the end.**

---

## 13. The concert-playlist skill (planned, not built)

**Do not build until the weekly diff works.** Recorded now while the reasoning is fresh.

### 🛑 THE BOUNDARY AGAINST `dj-weekly-review` — STATED HERE AND THERE, ON PURPOSE

The `dj-weekly-review` skill (built 2026-09-02) acts on a weekly review item: concert statuses,
tagging answers, and **adding songs the report already resolved to an EXISTING concert playlist.**
It stops there.

**Everything else is THIS skill's job and none of it exists yet:** creating or naming a playlist,
creating a **dated** concert row, deciding a date or venue, deciding what a new playlist should
contain, reordering or clearing a cram block.

⚠️ **REVISED 2026-09-02 — THE LINE IS *ORIGINATE* vs *COMPLETE*, NOT "never writes dj_concerts".**
The weekly skill may create an **undated `screening`** row, because that COMPLETES a decision
already made in the conversation: same artist, no date, no playlist, every field determined by the
answer. The first phrasing blocked it, and blocking it meant a lingering want ended up as free
text on a rejected row where nothing would ever read it (§14.36).

⚠️ **BOTH DOCUMENTS CARRY THIS BOUNDARY.** Two skills that each assume the other handles playlist
creation is how nobody does it — or how both do, differently. A boundary written once is a
boundary only one side knows about (§11.14).

### 13.1 Three phrasings, three different setlist queries

| what I say | window | `dj_concerts.status` |
|---|---|---|
| "Metallica is coming to the Sphere, build a concert playlist" | last 10 shows | `screening` |
| "I missed Third Eye Blind, make a concert playlist" | last 10 shows | `missed` |
| "I saw Adele at the Colosseum in October 2023, make a playlist" | **THAT show** | `attended` |

The first two are the same query. **The third is a different one, and it has no tool yet.**

### 13.2 🛑 The third phrasing needs a lookup `get_dj_setlists` cannot do

As built, the tool reads `/artist/{mbid}/setlists` — newest first, paginated. A show from
October 2023 is hundreds of entries back.

**setlist.fm's API does support it**, via `/search/setlists` with `artistMbid`, `year`,
`venueName`, `cityName`, `date`. So this is a second mode or a second Workshop tool, and
therefore **another manifest change and another fresh conversation.** Naming it now so it is
not discovered mid-build.

**THE FALLBACK, and it must never substitute silently:**

1. **Search by `artistMbid` + `year` + `venueName`** — not by exact date. *"October 2023"* is
   a memory, and memories are wrong by a month more often than by a venue.
2. **Exactly one match → use it.**
3. **No match, or several → STOP AND ASK.** Present the nearest shows by date with their
   dates and venues, and let a human pick. **Do not take the nearest one.** A show three
   weeks later on the same tour is an excellent proxy; one from a different tour is a
   different setlist entirely, and nothing in the data distinguishes them.
4. **⚠️ "Listed but empty" is a THIRD outcome and needs its own words.** setlist.fm may hold
   the show with no songs, because nobody submitted it. That is not *"the show did not
   happen"* and must not be reported as *"not found"*. Say so, then offer the nearest dated
   show from the same tour **as an explicitly labelled substitute**.

This is 12.7's rule at the level of a whole show: **exact match or ask. Never plausible.**

### 13.3 The skill creates the concert row too, and `missed` carries a second write

The skill writes the `dj_concerts` row as well as the playlist. Status per the table above.

⚠️ **`missed` is not merely a status.** The column comment is explicit: *"missed = did not go
BUT still want to see them. The lingering want in missed is a fact about the ARTIST, so it is
recorded as artist feedback; this column only records what happened that night."*

**So "I missed Third Eye Blind" implies a `dj_feedback` row against the artist, not just a
concert row.** Recording only the concert loses exactly the part that makes it actionable
later — the wanting is why the playlist is worth building at all.

### 13.4 Prerequisites that do not exist yet

- **`dj_venues` has no tools**, and `dj_concerts.venue_id` points at it. "Metallica at the
  Sphere" implies a venue row. Same gap `dj_artists` had, one table over.
- **`create_dj_concert`'s behaviour when the artist or venue is absent is unverified.**
  `artist_id` is `not null` with `on delete restrict`, so the chain is
  **artist → (venue) → concert**, and the skill must not assume the first two exist.

### 13.5 Naming: concert playlists are `"<Act> Concert"`, exactly

**Not a style preference — a functional constraint.** Google Assistant has to find these by
voice in the car, and it matches on the spoken name. `"Metallica Concert"`. Not *"Metallica —
Concert Prep"*, not *"Metallica (Sphere 2026)"*.

**Everything else Claude names by suggestion, and I confirm.** Concert playlists are the one
case where the name is dictated by a consumer outside this system.

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

**⚠️ ARTIST VOCABULARY SPLIT — RESOLVED by the alias map (§4.1.4).** The poll reads YouTube
Music's artist metadata; Takeout reads the `- Topic` channel name. Two acts differed —
Eddie Higgins and Red Garland — and the direction reversed between them, so no automatic
rule could fix both. Now handled by a two-entry hand-curated constant canonicalising toward
the poll's vocabulary, with `artist_disagreements` surfacing any future case. Verified: all
94 poll videos now produce identical `match_key`s to their Takeout counterparts, and 46 of
4,563 export videos are translated on import. **`dj_artists.mbid` remains the eventual real
answer** and phase 7 needs it anyway for setlist.fm, but it would have meant fuzzy-matching
1,206 artists to solve a two-row problem.

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

---

## 14. Named gaps — FOUND, NOT FIXED

Recorded here rather than left in a conversation. None of these is a bug: each is a thing the
schema does not hold, discovered while building something that wanted it. They are written down
so the next person to want them finds a decision rather than a surprise.

### 14.1 🛑 There is no link between plays and artist identity

`dj_tracks.artist` is **text**. `dj_artists` has `name`, `mbid` and `tags`. **There is no
foreign key between them**, so going from "what I played" to "what kind of act that is" means
matching a play-derived string against an artist row.

⚠️ **AND THE POPULATIONS ARE NOT COMPARABLE.** `dj_artists` holds **22 rows**, every one a
concert act put there by Phase 6b or the mbid backfill. The Takeout import measured **1,206
distinct artists** in the history. So for the overwhelming majority of listening there is no
artist row at all — no tags, no mbid, no exploration state.

**The consequence, stated plainly: SUBGENRE IS UNAVAILABLE FOR ALMOST EVERYTHING ALEX LISTENS
TO.** §1 capability 5 (discovery, going deeper into artists already mildly familiar) and any
future taste modelling both want exactly this join, and it does not exist.

**Not fixed here, and the fix is not obvious.** Adding `dj_tracks.artist_id` would need
back-filling 1,206 artists through the same two-vocabularies boundary §4.1.4's alias map
manages, into an insert-only table. Naming it is the honest step; doing it is a phase.

### 14.2 🛑 `dj_albums` has no writer and no data

No MCP tool creates or updates it. `dj_tracks.album`'s own comment says albums **must** be
populated from a real lookup or from Takeout and never from the history feed — an instruction
that has not been carried out.

⚠️ **§1 CAPABILITY 4 IS EXPLICITLY ABOUT TRACKING FAVOURITE ALBUMS**, and jazz is the case the
table was designed for: *"albums worth tracking as whole works, which matters for jazz in a way
it does not for rock."* So the weekly review's *"albums by artists I already play that I have
NOT played"* is not a query written badly — it is a query with no data on one side.

**Its own phase**, and it needs deciding where albums come from: a YouTube Music lookup per
artist, or the Takeout export, or by hand as they come up.

### 14.3 🛑 Nothing marks a track as jazz

No genre column on `dj_tracks`; its `tags` array is unpopulated. `dj_artists.tags` exists and is
the right home, but see §14.1 — it covers 22 acts.

**So the weekly review defines jazz by PLAYLIST MEMBERSHIP**, widened to artists appearing in
those playlists (`dj_jazz_activity`, migration 013). That is a proxy, it is derived rather than
guessed, and it is available today.

⚠️ **THE DEFINITION IS PART OF THE FINDING AND MUST BE REPORTED WITH THE NUMBERS.** A jazz
summary that does not say what counted as jazz invites the reader to assume a genre model
exists. It does not, and the numbers move if the definition does.

⚠️ Its artist arm is an **exact string match**, so "Oscar Peterson Trio" and "Oscar Peterson"
do not unify — §4.1.4 again, one table over.

### 14.4 Artist-identity collisions are not detectable

MusicBrainz blocks direct page fetches without JavaScript, so the 2026-09-01 mbid backfill drew
every id from Wikidata cross-references and search snippets. All 22 verified against live
setlist reads — but **no exhaustive candidate list with disambiguation text was ever seen**,
including for Chicago and Oasis.

Three near-misses were caught by corroboration rather than by seeing the candidates: Paul
Di'Anno's Killers, a Liverpool Ed Sheeran, and Skellern's 1980s Oasis. ⚠️ **A verification that
succeeds by corroboration cannot report how close it came to failing.**

**Consequence for tools:** a resolver can detect that a SEARCH returned several artists. It
cannot detect two real-world acts sharing one name. §13.1's *"Metallica is coming to the
Sphere"* resolves by name, and the skill cannot ask about an ambiguity it cannot see — §13.2's
*exact match or ask*, one level up. **A route to the MusicBrainz search API
(`/ws/2/artist?query=`, which returns disambiguation text and needs no JavaScript) is a
prerequisite for that skill**, and any tool that resolves an artist must state this gap rather
than imply coverage it lacks.

### 14.5 🛑 A PostgREST read stops at `db-max-rows` and says so NOWHERE — FIXED 2026-09-02, and it was a WRONG ANSWER, not a short one

`get_dj_managed_playlists` mode=list reported **Smashing Pumpkins Concert: 0 tracks** against a
real 15, Motley Crue 0 against 14, Weezer 4 against 13. The tell: **every reported body count
across all 41 playlists summed to EXACTLY 1000** — the row cap showing through as data. The read
stopped mid-playlist and every playlist past the cut became a zero.

⚠️ **THE FAILURE MODE IS THE POINT.** There is no error, no flag, no short-count field. A
response holding 1000 rows and one holding 1000 of 2400 are byte-identical. A weekly job that
trusted it would say *"your concert playlist is empty"* six weeks before the show.

⚠️ **IT HID BECAUSE ONLY THE FAN-OUT PATH CROSSED THE CAP.** mode=tracks reads ONE playlist
(≤379 rows) and mode=engagement does its arithmetic in SQL — both were right, which made the
disagreement look like a question about which mode to trust rather than a defect in the third.
**Two modes agreeing is not corroboration when they share no code path with the one that is
wrong** (§11.9).

**Fixed** by routing every unbounded read in `dj-reads.ts` through `selectAllRows`, which pages
with a stable `order("id")`. ⚠️ **Termination is on an EMPTY page, never a SHORT one.** "Short
page means last page" assumes the server returns what was asked for — the exact assumption that
failed. Against a cap smaller than the page size every page is short, and the loop reproduces
the defect wearing pagination.

⚠️ **THE SAME CAP DEFEATED `SCAN_CAP`.** `get_dj_plays` familiarity counted first, refused above
5,000 rows, then read with `.limit(5000)` — which the server silently served 1,000 of. The guard
measured the right thing and the read did not honour it (§11.15). Cram order sorts on the
`distinct_days` that came out of it.

**The test fake now enforces a row cap.** Without one the suite was measuring a database that
does not exist, and stayed green through all of the above (§11.16).

### 14.6 A rule implemented in two runtimes drifted — FIXED 2026-09-02, and the complete version already existed

`diff_dj_setlists` reported **Today**, **Luna** and **Cherub Rock** as missing from the Smashing
Pumpkins playlist while all three sat in its body; two then resolved to the exact `video_id`
already recorded there. Weezer's **Go Away** did the same against a body row reading *Go Away
(feat. Best Coast)*.

**Cause:** `dj_setlists.py` recognised `(Remastered 2012)` and missed `(2011 Remaster)`, and had
no feature-suffix rule at all. **`dj-normalise.ts` already handled both.** The suffix list looked
complete because the cases it missed had not appeared yet — and the complete list existed, in
the other language.

⚠️ **THE DUPLICATION CANNOT BE REMOVED.** `dj-normalise.ts` feeds `match_key`, frozen at write
(§4.1.2) — changing it is a backfill migration, not a deploy. The Python copy runs at read time,
on another host, over setlist.fm titles that never pass through Alfred. Neither can call the
other across the courier boundary.

**So the invariant is a shared fixture, not care.** `shared/dj-title-cases.json` is asserted by
`dj-normalise.test.mjs` AND `workshop/tests/test_dj_diff.py`. A vocabulary entry added on one
side and not the other fails a test in the runtime nobody edited (§11.14). **One deliberate
divergence is pinned in the same file**: Python folds accents because it compares two
independent editorial systems; TypeScript does not, because it compares YouTube to YouTube.

### 14.7 The artist compare was exact-string, across two vocabularies — FIXED 2026-09-02

setlist.fm bills the act as **"The Smashing Pumpkins"** (from the mbid, so it is the verified
identity). YouTube Music's metadata says **"Smashing Pumpkins"**. An exact compare called that a
non-match and dropped three songs — two already in the body, and **Disarm**, genuinely absent and
played at 7 of 10 shows.

⚠️ **THIS IS NOT §4.1.4's ALIAS MAP, AND REACHING FOR IT WOULD BE THE WRONG FIX.**
`ARTIST_ALIASES` translates *Takeout channel names* into the *poll's* vocabulary, applied once at
import to a column frozen at write. This is a different boundary (setlist.fm ↔ YouTube Music),
evaluated at read time, on another host, about a systematic orthographic difference rather than a
per-act fact. The map is explicit that it is hand-curated because rules like *"prefer the longer
form"* break Red Garland the moment they fix Eddie Higgins — **a leading article is precisely the
case where a rule does hold**, and the map holds no entry that would have helped.

⚠️ **IT WIDENS §14.4's COLLISION SURFACE, SO IT IS REPORTED, NEVER SILENT.** "The Killers" and
Paul Di'Anno's "Killers" are two real acts, and folding the article is what lets one stand in for
the other. Every resolution now carries `artist_match: exact | article_insensitive`, and a folded
match says so in `why`. **An exact match always wins outright**, so the fold can only ever decide
a case that would otherwise have been NOT FOUND — widening the rule cannot change an answer that
was already right. A widened rule that announces itself is checkable; the same rule applied
quietly is §14.4 arriving through the front door.

### 14.8 Medley parts have no cover attribution, and the resolver used to invent one — FIXED 2026-09-02

setlist.fm records **one** cover marker for a whole `' / '`-joined medley row. Copying it onto
every split part invents an attribution for the parts it does not describe; copying its *absence*
asserts "not a cover" just as wrongly.

The visible symptom was reasoning, not verdict: **One Headlight** — a Wallflowers song — was
explained as though Foo Fighters simply had no version of their own, citing §12.4. NOT FOUND was
right; the reason was fabricated. **A right answer reached wrongly is the one that breaks when
the case changes.**

Every medley part now carries `cover_of_known: false` and, where the row had one,
`medley_cover_marker` as information about the *row* rather than the part. The not-found text
says the attribution is not in the source. A part that also appears standalone elsewhere in the
window is upgraded — a real per-song marker is better evidence than a medley's silence.

### 14.9 Recorded so it is not re-raised: `dj_tracks.artist` carries scraped bylines

At least one row stores the artist as **`"Jazz and Blues Experience, 1.7M views"`**, with the
title `"Oscar Peterson, Ben Webster - During This Time (Full Live Concert Video)"` — a YouTube
channel byline with a view count baked in. Because §14.3's jazz arm and any future artist rollup
match artist strings **exactly**, a row like this can never unify with anything.

**Not fixed, and deliberately.** `dj_tracks` is insert-only and `artist` is written once (§4.1.2,
§11.13) — repairing it is a migration with a hand-built value table, the shape of migration 007,
not a code change. Recorded here so the next artist-level feature knows the population is not
clean before it assumes it is.

### 14.10 Recorded so it is not re-raised: `dj_playlist_tracks.canonical_track_id` is unpopulated

Across every playlist body read on 2026-09-02, **one** row carried a `canonical_track_id`; the
rest were null. Nothing is broken — `mode=cram` and `mode=engagement` resolve canonical groups at
query time and never read the column — but **anything that reads it directly will get nulls and
no error.** Either populate it or drop it; leaving a column that looks authoritative and is empty
is the §11.4 shape.

### 14.11 CHECKED AND NOT A DEFECT: the 13-character YouTube playlist id

`Weezer Concert 2026` is stored as **`PLGhCMggoJnIc`** — 13 characters, where every other
playlist in the library is 34 (`PLV2XoCH1Pv5…`). It reads as a truncated value and it was flagged
as one on 2026-09-02.

**It is genuine.** A live `get_dj_playlists mode=library` read returns that exact id, titled
*Weezer Concert 2026*, 13 tracks, owned. YouTube issues short ids as well as long ones.

⚠️ **Recorded because the next reader will notice the same thing.** A plausible-looking anomaly
that has already been checked costs nothing to write down and an investigation to rediscover —
and the honest version of "it looked wrong" is "it looked wrong and it is fine."

---

## 14bis. The second review run — 2026-09-02, after the first round of fixes

The first run found nine problems. Three were fixed (§14.5, §14.6, §14.7) and the second run was
pulled to check them **by behaviour rather than by SHA**. All three hold, with arithmetic rather
than an absence of complaints:

- **§14.5 (row cap).** Body counts across 41 playlists now sum to **2194**, not exactly 1000.
  Smashing Pumpkins 15 (was 0), Motley Crue 14 (was 0), Weezer 13 (was 4). The one remaining
  zero — *The Weeknd Concert* — was checked against YouTube directly and is a genuinely empty
  playlist, not a residual.
- **§14.6 (normaliser).** Smashing Pumpkins `in_body` moved **12 → 15 of 32**; Today, Luna and
  Cherub Rock are in the body and no longer proposed. Weezer `in_body` moved **12 → 13 of 13**
  when setlist *"Go Away"* matched the body row *"Go Away (feat. Best Coast)"*.
- **§14.7 (article fold).** **Disarm** resolves to `x5GG_fr8WyM` with
  `artist_match: article_insensitive` and the widening stated in `why`. Played at 7 of 10 shows.

It then found six more. Two were wrong data and are fixed in migration 016.

### 14.12 🛑 `touch_days` counted the LEFT JOIN's null row — FIXED 016

Migration 015 wrote `coalesce(count(*), 0) as touch_days` over a `left join day_hits`. When a
playlist has no matching rows the join still emits one, with every `dh` column null — and
`count(*)` counts **rows**, not values. Twelve playlists reported:

```
touch_days: 1, last_touched_on: null, touch_days_recent: 0, touch_days_prior: 0
```

Contradictory **three ways in one row**: 1 ≠ 0 + 0, and a playlist touched once has a date.

⚠️ **THE REST OF THE ROW WAS RIGHT, WHICH IS WHY IT READ AS AN ODD NUMBER RATHER THAN A BUG.**
The filtered counts use `filter (where dh.played_on …)` and a null satisfies no comparison, so
they correctly returned 0. `runs` and `went_quiet` were right for the same reason. Only the
unfiltered total was wrong.

**The harm is exactly the distinction the metric exists to draw.** *Post Malone Concert* has
genuinely been touched once (2026-06-14). *Chicago Concert* has never been touched. They printed
identically — and the null-vs-zero distinction is deliberate everywhere else in this system.

🛑 **AND 015's OWN VERIFY BLOCK COULD NOT HAVE CAUGHT IT. THIS IS THE §11.1 SHAPE INSIDE A
VERIFICATION BLOCK WRITTEN TO ENFORCE §11.1.** Five checks shipped under a stern note that they
are "the point of the migration block, not decoration". They were run and they passed. Step 1
asserted `touch_days > runs` on **partially listened** playlists; step 2 was the seasonal
control for `went_quiet`, which reads the correct half; step 3 checked rows with `runs > 0`;
steps 4–5 were about the artist rollup. **Every step selected a playlist that had plays in it.
The bug lives only where there are none.** Writing the rule at the top of the file does not apply
it to the file.

**Fixed** with `count(dh.played_on)`. The `coalesce` is dropped rather than kept — `count()`
never returns null, so it was dead code that *read* like a null guard, which is the belief that
let this through. The new control is an **invariant over every row**
(`touch_days = touch_days_recent + touch_days_prior`) plus a negative control on
`last_touched_on is null` — arithmetic a wrong answer cannot satisfy, on the population the old
checks could not reach.

### 14.13 🛑 The jazz definition described a mechanism that cannot do what it claims — FIXED 016

Migration 013, and the Edge Function repeating it to every caller, said:

> *"Membership alone would miss most of it — the heavily-played pianists (Herbie Hancock, Red
> Garland, Oscar Peterson, Bill Evans, Thelonious Monk, Wes Montgomery) arrived through PLAYS
> rather than through either playlist."*

`dj_jazz_activity(90)` returned **two of those six**.

**It is not a tuning problem.** The artist arm reads `t.artist in (select artist from
jazz_artists)`, and `jazz_artists` is derived **from tracks already in a jazz playlist**. The arm
widens membership from track-level to artist-level and cannot reach outside the playlists at all.
An artist with no track in either playlist is unreachable however much he is played.

**Thelonious Monk: 20 distinct days, 206 play rows, 81 distinct canonical groups — the broadest
repertoire of any artist in the library, Weezer included.** He beats the tool's own top row (Wes
Montgomery, 13 days) and Section 3 could not see him.

⚠️ **IT SURVIVED BECAUSE IT WAS PHRASED AS A JUSTIFICATION.** It reads as the *reason* the artist
arm exists, and a rationale does not invite anyone to check it against output. It was a
falsifiable claim about what the data means, and it was false (§11.5).

**Fixed** with a third arm sourced from `dj_artist_tags`, and `source` on every row saying which
arm caught it. `by_source` totals them, so a thin tag set is visible in the payload rather than
read as a thin listening habit.

#### 🛑 Why `dj_artist_tags` and NOT `dj_artists.tags`

`dj_artists.tags` is the obvious home and it is the wrong one, for a reason already recorded in
this repo. `upsert_dj_artist` carries a comment written to stop the question being reopened:
*"`dj_artists.name` is a different system entirely … **NOTHING JOINS THE TWO**"* — the two being
`dj_artists.name` and `dj_tracks.artist`.

- `dj_artists` holds 22 rows, every one an **mbid-keyed concert act**. `get_dj_artists` warns
  that a null mbid means setlists cannot be read at all. Jazz artists have no mbid and need none;
  the table would hold two kinds of row under two contracts.
- The tag must be applied to **the string as `dj_tracks` spells it**, because that is the only
  join key available (§14.1). That means rows reading *"Eddie Higgins Trio"* and *"Oscar Peterson
  Trio"* — display strings, not identities — which would make `dj_artists.name` mean two things.

⚠️ **THIS DOES NOT CLOSE §14.1 AND MUST NOT BE DESCRIBED AS DOING SO.** It is a curated
allowlist over play strings, the same shape as §4.1.4's `ARTIST_ALIASES` and hand-curated for the
same reason §14.7 gives: *"prefer the longer form"* fixes Eddie Higgins and breaks Red Garland in
the same stroke.

⚠️ **THE MIGRATION IS HALF-APPLIED UNTIL THE TAGS ARE SEEDED**, and its verify block says so with
a `notice` rather than passing quietly. Until then the tool answers the old, narrower question.

### 14.14 A promo appearance and a stadium set counted the same — FIXED 016

Six of the ten Weezer shows in the window were 1–6 song promo spots (Fallon 1, Today Show 2,
SiriusXM 5, Apple Music 5, Snap 5, Hinano Cafe 6). The other four were real sets (Halifax 24,
Yellowstone 24, Allegiant 13, Amazon MGM 12). So *"We Might as Well Be Strangers — 4 shows"* was
three television appearances and one concert: a true number reading as four times the evidence it
is.

⚠️ **§12.3 DECIDED PROMOS COUNT AND THEY STILL DO. This labels them; it excludes nothing.**

⚠️ **SHIPPING `song_count` PER SHOW WAS NOT ENOUGH.** It made the fact *recoverable*, which means
every consumer re-derives it, differently — and §12.12 forbids explaining it in a paragraph. A
number the report needs is a number the payload carries.

`full_set_min_songs` is **8**, in the payload rather than in prose. A TV spot is 1–3 songs and a
radio session 4–6; a concert is rarely under 8. It is **absolute rather than a fraction of the
window's median**, because the median is dragged down by the promos themselves — Weezer's is 5.5,
so "half the median" would certify the five-song SiriusXM session as a full set. **The boundary
case is named rather than hidden:** Smashing Pumpkins played 7 songs at the LA Memorial Coliseum
and is classed a short set. That is the row that moves if anyone retunes this, and it is pinned
by a test.

`missing` now sorts on full sets first — the raw count put the weakest evidence at the top of the
list a human reads first.

### 14.15 `not_found` had one shape for four different answers — FIXED 016

Classifying not-founds meant **reading the `why` prose**, which will break silently the first
time a sentence is reworded — and did break immediately: the first report counted five Foo
Fighters medley parts where there were six, missing *"Happy Birthday to You"* at a single show,
and that number went into a coverage figure.

`not_found_cause` is now a field:

| cause | closeable? | |
|---|---|---|
| `medley_part` | never | one part of a `' / '`-joined row; rarely has a studio recording |
| `other_artists_only` | never | the title exists, by someone else (§12.4) |
| `no_such_title` | never | YouTube Music has nothing under that title |
| `variant_only` | 🛑 **yes** | the artist HAS the song; only a studio cut is missing |

⚠️ **A MEDLEY PART IS CLASSIFIED BY WHAT IT IS, NOT BY WHICH BRANCH IT FELL OUT OF.** *One
Headlight* finds The Wallflowers; *Seven* finds nothing. Both are structurally unavailable for
the same reason, and splitting them across two buckets would quietly shrink the uncloseable
count.

**`coverage` now carries two denominators and neither replaces the other.** `total` is every
distinct song in the window — what he will hear, the right denominator beside any
`cram_complete` (§12.10). `gettable` subtracts the three uncloseable causes — the right
denominator for *"is this playlist finished"*. Foo Fighters measured **27/40 total and 27/32
gettable**. Reporting only `gettable` would improve the number by redefining the show.

⚠️ **`variant_only` IS DELIBERATELY NOT SUBTRACTED.** Folding it into "unobtainable" would hide
the only not-found anyone can act on.

### 14.16 A major song's NOT FOUND looked identical to a hopeless one — FIXED 016

**Mayonaise** (Smashing Pumpkins, 5 of 10 shows) and **Muzzle** returned `not_found` with
`other_artists_found: []` and a sentence of prose — byte-identical in **shape** to *A320*, where
piano covers genuinely are all that exists. One is a ten-second decision; the other is nothing.

The verdict was right: §12.11 rule 2 drops variant cuts and §12.7 is exact-match-or-not-found.
**What was wrong is that the payload was shaped like the hopeless cases**, and §12.11 requires
that an ambiguity never escalate without a recommendation and a way to resolve it.
`duplicate_titles_in_cram` got that treatment; this did not.

`variant_only` now carries `variant_candidates` (with album and duration — the two fields that
distinguish a released live album from a loose upload) and `recommended_video_id`, picked by
*album present, then longest cut*, with the rule stated in `why`.

⚠️ **IT REMAINS `not_found`.** Promoting it to `resolved` would put a live recording into a
playlist by machine, which is precisely what rule 2 exists to prevent. The recommendation is for
a human, and taking it means learning the song from a live cut — a real cost, and his call.

### 14.17 Section 1's question had no field, so the thresholds were invented — FIXED 016

`went_quiet` is a **change** detector built for Section 4 (§11.7). Section 1 asks a **level**
question: *was this ever decided?* Oasis — one of the two cases §12.8 names — does **not** fire
`went_quiet`, because two touch days inside the recent window keep it warm. The first run
surfaced it anyway by hand-applying *"runs low and last_run_on old"* with cutoffs chosen by eye
that exist in no file and would be chosen differently the following week.

**`get_dj_concerts mode="undecided"`** returns undated `screening` rows with their playlist
engagement joined. ⚠️ **NO THRESHOLD, DELIBERATELY.** The population is tiny and **self-clearing**
— answering moves the row out of `screening` and it never returns — so §11.7's "fires on the
normal case" risk does not apply, and a cutoff would only shrink a list that is already short.
It orders by `quiet_for_days`, which falls back to the **concert row's own age** when the
playlist has never been touched: a watchlist entry unplayed since creation is the strongest case
for asking, and a null would sort arbitrarily.

### 14.18 A dated `screening` row is a decision with a deadline, and nothing asked — FIXED 016

Smashing Pumpkins sat at `screening` for a show on 2026-10-30, 58 days out. `needs_status` fires
only once a date has **passed**, so the question surfaces on the first day it can no longer be
answered.

**`decision_pending`** is now on every row: `true` when the status is `screening` and the date is
still ahead, with `days_until` beside it. ⚠️ **THIS IS A SECTION 2 LINE, NOT A SECTION 1 ONE**,
and §12.8 already records the first run getting exactly this wrong. Three questions share the
word *screening* — `needs_status` (*did you go?*), `undecided` (*still interested?*),
`decision_pending` (*you have not decided and the show is in N days*) — and the shared word is
what merges them. The partition is asserted by a test rather than described.

### 14.19 Two fields one word apart meant different things — FIXED 016

Section 3 printed `in_playlist: false` for Wes Montgomery; Section 4 printed
`in_any_playlist: true` for the same artist. **Both were correct** — one asks about the two
`kind='jazz'` playlists, the other about every managed playlist — and side by side they read as
the tool contradicting itself. `dj_jazz_activity` now returns **`in_jazz_playlist`**, and both
tools' guidance names the other field explicitly.

### 14.20 The cram/diff join the spec REQUIRES was the one that would fail — FIXED 016

`get_dj_managed_playlists mode=cram` reports the raw `dj_tracks` title
(*"Jellybelly (Remastered 2012)"*); `diff_dj_setlists` reports setlist.fm's (*"Jellybelly"*).
Both are right for their source and they will never match. §12.10 **requires** reading the two
together — `cram_complete` may not be printed without `in_body / distinct_setlist_songs` beside
it — so the one join the spec mandates is the one that would have failed silently on titles.

`in_body` entries now carry **`video_id`**. Join on that, never on the title.

### 14.21 Recorded, no action taken

- **Migration 015's verify step 5 is only half-satisfied.** It expects the split names *and*
  §14.9's scraped byline visible in `dj_artist_activity(90, 50)`. Split names are there (Eddie
  Higgins Trio, Dave Brubeck Quartet, Enzo Orefice trio). The *"…1.7M views"* row is **below the
  cut, not absent** — so the limitation is described rather than demonstrated, which is what that
  step was written to avoid. A wider limit would show it.
- **§14.10 unchanged.** 58 body rows read across the three concert playlists on 2026-09-02; zero
  carried a `canonical_track_id`.
- **`The Weeknd Concert` is an empty playlist against a `rejected` concert**, verified live on
  YouTube. Nothing flags it. Harmless, and its engagement row returns nulls across every field
  including `touch_days` — a *different* null from §14.12's wrong 1, and indistinguishable to a
  reader who does not know why.
- **`cram_stale` still cannot fire.** `current_cram_size: 0` on all three upcoming playlists and
  zero cram rows library-wide. §12.8's decision to keep it in the payload and out of the printed
  item stands, confirmed rather than assumed.
- **`'Harrison'` (4 distinct days) is deliberately untagged.** It may be a truncated or scraped
  byline (§14.9) rather than an artist. Tagging an unknown to make a list longer is how a curated
  allowlist stops being curated.

### 14.22 🛑 OPEN, AND IT IS THE FINDING RATHER THAN A DEFECT: jazz is half the listening and almost none of it is managed

Six of the top twenty artists by distinct days are jazz artists **in no playlist at all** —
Thelonious Monk (20 days, 81 songs), Eddie Higgins Trio (16), Bill Evans (11), Herbie Hancock
(8), Red Garland (7), Keith Jarrett (7) — plus Green Day (16) and The All-American Rejects (7),
neither jazz nor in any playlist.

**Section 3 reports on two playlists. The question actually being asked of it is "what am I
listening to and what am I missing", and Section 4's rollup is closer to that than Section 3 is.**

Migration 016 makes the merge *available* without making it: `dj_artist_activity` takes a
`p_tag` filter, so the jazz section can **be** the rollup filtered by tag — same numbers, one
definition — rather than a second definition that has to agree with it. **§12.8's section list HAS now changed — see §14.23.** This entry stands as the
finding that drove it.

### 14.23 Section 3 merged into the rollup — DECIDED 2026-09-02, migration 018

§14.22 is closed as a **decision**, not as a defect fix. Section 3 is now
`get_dj_plays mode=artists tag=jazz` — Section 4 with a filter. `dj_jazz_activity` and
`get_dj_jazz_activity` are dropped. The full shape is in §12.8's SECTION 3 entry; recorded here
are the three things that would otherwise be re-litigated.

**1. The tool was REMOVED, not left as a wrapper.** A wrapper keeps a second *name* for one idea
and the next reader has to discover they are the same. A removed tool fails loudly at the call
site — the failure worth having. `mcp/index.test.mjs` asserts its **absence**, so re-adding it as
a convenience fails a test.

**2. 🛑 THE PLAYLIST ARM WAS CONVERTED, NOT DROPPED, AND THE TWO CLAIMS ARE NOT
INTERCHANGEABLE.** *"Is this artist on a track in a `kind='jazz'` playlist?"* has a definite
answer independent of who asks and when. It was never a judgement — which is precisely why a
machine could evaluate it at read time — so it survives as an INSERT rather than a JOIN.
Migration 018 writes one row per such artist with `source = 'playlist'`. **What is genuinely lost
is that the arm no longer self-updates**, and that loss is made visible rather than absorbed:
`dj_tag_candidates` reports any newly-derivable artist, and writing those rows needs no
decision. 018's verify block asserts the seed wrote rows at all, because *"the arm was converted"*
is a claim that is false if it wrote none.

**3. `source` is derived server-side and cannot be passed by a caller.** A caller asserting
provenance could launder a guess into a fact, which is the one thing the column exists to
prevent. `record_dj_artist_tag` computes it from playlist membership; a mutation test pins it.

### 14.24 ⚠️ REJECTION IS A STATE — ADDED WITHOUT BEING ASKED FOR, SO IT IS FLAGGED HERE

The requested flow was: the report proposes untagged artists, Alex approves, the thread writes.
**As specified, a "no" leaves no trace** — so the same names return next week, and the week
after. *Harrison* (4 distinct days, possibly a scraped byline per §14.9) would be proposed every
week for the rest of the project.

🛑 **THAT IS §11.7 EXACTLY: a proposal that fires on the normal case gets ignored, and then it is
worse than none.** A curated allowlist whose curation cannot record a NO is not curated; it is a
list that keeps asking.

`dj_artist_tags.status` is `'active'` or `'rejected'`. **Both mean DECIDED and neither is
proposed again.** Only `active` counts as tagged. **Absence is the only state meaning "not yet
asked"**, and it has to stay that way to be worth reading.

⚠️ **THIS IS ALSO WHY THE WRITE TOOL IS TIER 2 RATHER THAN TIER 1.** An append-only tool cannot
express a rejection or reverse one, so a single mistaken approval would need a migration to undo
— and the whole argument for curating by hand (§14.7) is that the automatic rules get it wrong.
Nothing hard-deletes; `rejected` is a soft delete carrying a reason, reversible by another call
and by `platform.rollback_audit_entry`.

### 14.25 §12.8 said "two sections" while the item had four — FIXED 2026-09-02

Sections 3 and 4 were requested in the weekly prompt and produced every week, while the spec
paragraph governing the item's shape read *"The weekly item has two sections, in this order, and
nothing else."*

⚠️ **THE DOCUMENT THAT GOVERNS THE ITEM WAS NOT THE DOCUMENT DESCRIBING IT**, and nothing in
either would have revealed that — the prompt did not cite §12.8 and §12.8 did not know about the
prompt. Recorded rather than quietly corrected, because a spec that has drifted once will be
trusted the same way next time.

### 14.26 The tag backlog is 368 and the count is the wrong number — SHAPED 2026-09-02, migration 019

Measured immediately after 018: **393 artists played in 90 days, 87 tagged, 368 untagged, 0
derivable.** At eight proposals a week that is eighteen months, and a weekly section carrying an
eighteen-month queue is §11.7 at a scale nothing survives.

🛑 **BUT THE COUNT WILL NEVER REACH ZERO, BY CONSTRUCTION.** The candidate pool is *played in the
trailing window*, and the window slides — new one-off artists arrive every week. Reporting
progress as *"368 remaining"* guarantees a number that does not move however many decisions get
made, which is the definition of decoration.

**So coverage is measured in PLAY ROWS.** Every `dj_plays` row has exactly one artist string, so
play rows **partition**: `tagged_rows + untagged_rows = played_rows`. A share computed from them
is a real fraction of listening rather than a fraction of a name list, and it closes.

⚠️ **THAT IS WHAT MAKES THE TOP OF THE LIST WORTH ANSWERING AND THE TAIL SAFE TO IGNORE.**
Deciding Weezer moves the share by 336 rows; deciding a one-off moves it by one. The section can
say *"these eight take you from 43% to 71%"* — true, finite, and the same arithmetic — instead of
*"359 to go"*.

⚠️ **A REJECTED ARTIST IS DECIDED BUT NOT COVERED**, so his rows are in neither bucket and the
two stop summing once anything is rejected. Deliberate: folding rejections into "tagged" would
inflate the share with artists deliberately excluded from the section.

#### The ordering changed to `play_rows`, and the real backlog is why

018 ordered candidates by `distinct_days`. Against the measured list that put five rock acts
ahead of the only jazz artist in the top ten:

| | days | songs | play rows | rank under `distinct_days` |
|---|---|---|---|---|
| Green Day | 16 | 20 | 27 | 5th |
| Miles Davis | 15 | 49 | 83 | 6th |

**A thin artist heard on many days outranked a deep one**, which is the opposite of the point.

🛑 **`play_rows` IS THE SORT KEY BECAUSE IT IS THE SAME UNIT AS THE OBJECTIVE.** Coverage is
measured in play rows, so the top N candidates are exactly the N decisions that buy the most
coverage — sort key and thing-being-maximised are one quantity, with no composite score to tune
and nothing needing a paragraph to read correctly (§12.12). It also absorbs both signals rather
than choosing: Monk is 94 songs over 21 days = 226 rows; Green Day is 20 over 16 = 27.

`distinct_days` and `distinct_groups` are still returned and belong in the printed line, because
*"Miles Davis, 49 songs across 15 days"* is what is actually being decided.

#### The cap is 8, and facts do not count against it

Five reads as trivial next to a backlog this size; twelve reads as a form. Eight is also
`cram_cap` — this project's existing answer to *how many things will a human act on in one
sitting*. ⚠️ **They are deliberately NOT the same constant**: a cram slot and a tagging decision
are different objects, and coupling them would be a constraint written twice (§11.14).

A `derivable` candidate is written without asking, so it costs no attention and takes no slot.
The tool requests `cap + untagged_derivable` rows, exact rather than guessed, because coverage
has already been fetched.

### 14.27 The tag list was write-only — FIXED 2026-09-02

`dj_artist_tags` could be written and read only *through* `dj_artist_activity`, which shows tags
on artists **played in the window** — 25 of the 87. Three things were invisible:

- **Rejections.** The one state whose entire purpose is to be remembered had no reader. *"What
  did I already say no to?"* had no answer outside the SQL editor, and a decision you cannot
  review is one you will make again differently.
- **Tags on artists not played recently** — 62 of them.
- **Provenance.** Which rows are derived facts and which are human judgements is what makes a
  resync safe, and it could not be checked.

`get_dj_artist_tags` (tier 1) is the review surface. ⚠️ **It answers "what is on the list and who
put it there", never "what am I listening to"** — keeping those apart is why §14.19 happened once
and should not happen twice.

⚠️ **AND ITS FIRST IMPLEMENTATION SORTED REJECTIONS LAST WHILE A COMMENT CLAIMED OTHERWISE.**
`'active'` precedes `'rejected'` alphabetically, so `ascending: true` put the rows that exist
purely to be read back at the bottom of the list. Caught by a test, not by reading the code — the
comment above it asserted the correct behaviour the whole time.

### 14.28 Section 1 and Section 2's new signals, verified against live data — 2026-09-02

`mode=undecided` and `decision_pending` had only run against fakes. Confirmed live:

- **`mode=undecided`** returns exactly Oasis and Black Eyed Peas, ordered by `quiet_for_days`
  (53, 11), engagement joined. ⚠️ **Oasis appears despite `went_quiet: false`** — two touch days
  inside the recent window keep it warm — which is the whole reason the mode applies no
  threshold. Under any flag-based filter it would be invisible, and it is one of the two cases
  §12.8 names.
- **`decision_pending`** is `true` on Smashing Pumpkins (2026-10-30, 58 days out, `screening`)
  and `false` on both committed shows.

### 14.29 A RAISE arity mistake kills a whole migration at COMPILE time — FIXED 2026-09-02, and now checkable

Migration 019 failed to apply:

```
ERROR: 42601: too many parameters specified for RAISE
CONTEXT: compilation of PL/pgSQL function "inline_code_block" near line 27
```

The format string was `'Coverage: %/% play rows tagged (%%), % untagged ...'` with five
arguments. **In a PL/pgSQL RAISE, `%%` is an ESCAPED LITERAL PERCENT and consumes no argument** —
so the string carried four placeholders against five arguments.

⚠️ **AND THE OBVIOUS REPAIR DOES NOT WORK EITHER.** Writing `%%%` to mean *"placeholder, then a
percent sign"* fails: the scanner reads left to right, takes `%%` first, and renders the sign
**before** the number. The fix is to not put a percent sign in a RAISE format string at all — the
word *"pct"* costs nothing and cannot be got wrong.

🛑 **THE FAILURE MODE IS WHY THIS IS RECORDED AT ALL.** It is a COMPILE-time error in an anonymous
block, so it does not fail the one `RAISE` — **it rejects the entire `do $$ ... $$` block**, which
is where every verification in every migration in this project lives. A migration's checks are
the part most likely to contain a long interpolated message and the part least likely to be
executed before the migration is run for real. A typo in a diagnostic takes down the diagnostics.

**`scripts/check-raise-arity.py` now counts placeholders against arguments across every migration**
(78 statements, all clean). Run it before applying anything.

⚠️ **ITS FIRST VERSION PRODUCED A FALSE POSITIVE ON WORKING CODE**, and that is worth as much as
the check. It found the statement's terminating `;` with a naive search, which landed on a
semicolon *inside* a string literal — `'has zero touch days; "never" and …'` — truncating the
statement and hiding its argument. Migration 016 had already applied cleanly, which is what
exposed it. **A checker whose false positives are indistinguishable from its true ones is worse
than no checker**, so the scanner now tracks quote state (§11.2: prefer failures that are loud
over answers that are reassuring, and that cuts both ways).

**Verified by reproducing the defect** (§11.16): reintroducing `(%%)` makes the script report
*"4 placeholder(s), 5 argument(s)"* at the right line, and removing it returns the suite to clean.

### 14.30 The prompt got CRITIQUED instead of run — FIXED 2026-09-02

Handed to a fresh Claude, `docs/dj-weekly-review-prompt.md` produced a review of itself rather
than a weekly item.

🛑 **THE DOCUMENT'S FORM CONTRADICTED ITS PURPOSE.** Roughly four fifths of it was guardrails and
rationale — *why* each rule exists, which failure it prevents, which spec section governs it. That
is the right content for a spec and the wrong shape for an instruction: **a page that argues reads
as a page to evaluate.** The "do this" was buried under the reasoning that justified it.

**Fixed by inverting it.** The file now opens with *"YOU ARE RUNNING THIS JOB, NOT REVIEWING
IT"*, then a call table, then the writes, then the sections. Every measurement moved to a
**clearly-marked appendix headed "EXAMPLES, NOT CURRENT FACTS"**, and rationale is compressed to
one clause per rule.

⚠️ **THE SAME MISTAKE IS AVAILABLE EVERYWHERE IN THIS PROJECT**, whose house style is exactly this
density of reasoning. It is right in a spec, in a migration, and in a tool's `reading` field —
all of which are read by someone deciding whether something is correct. It is wrong in the one
document read by someone deciding what to *do*.

#### The critique's findings, all acted on

**Dated facts baked in as rules.** Measurements from 2026-09-02 were written as though permanent.
Two were load-bearing and are now **self-checking rather than asserted**: `cram_stale` is
suppressed by testing `current_cram_size` rather than by the file claiming there are no cram rows,
and derived tag facts are driven by `untagged_derivable` rather than by the file claiming it is 0.

**The call budget assumed a small list.** Now stated as arithmetic — `8 + 3n` — with a defined
degradation: above eight concerts, do the eight nearest in full and give the rest one line each
from the engagement call already made, **naming what was shortened**. The fallback costs no extra
calls.

**"One question at the end" contradicted Sections 1a and 1b.** Resolved in §12.12 above.

**`missed` implied an unauthorised third write.** The header authorised two writes; §13.3's
`dj_feedback` row was a third. Now authorised explicitly, with the pairing stated: **`missed` is
two writes, and saying so is what stops the second going missing.**

**"The spec wins" was not checkable.** A Claude thread has MCP and no filesystem, so it cannot
read the spec to apply the rule. The authority order is now: **the tool payload wins over the
prompt** — `reading`, `gaps` and `definition` travel *with the data* and therefore cannot be stale
relative to the numbers in hand — then the prompt for the item's shape, then the spec *if it can
actually be read*.

#### 🛑 One critique finding was WRONG, and it is the one that would have done damage

It reported that only Foo Fighters had an mbid and Weezer did not. **False.** All 22 artist rows
carry one (`without_mbid: 0`), each verified by a live setlist read during the 2026-09-01
backfill. Its likely source is §14.1's true statement that the ~1,206 *played* artists have no
artist row — *"no tags, no mbid, no exploration state"* — which is about the play population, not
the 22 concert acts.

⚠️ **THE FAILURE IT WOULD HAVE CAUSED IS WORTH RECORDING, BECAUSE THE TWO CAUSES LOOK IDENTICAL.**
A missing mbid and a tour that has not started both produce an empty setlist read. Acting on the
false claim, the item would have printed *"no setlists yet"* about an act with ten readable
shows. The prompt now says: **if a setlist read comes back empty, check `get_dj_artists` before
reporting absence.**

⚠️ **AND THE REVIEW WAS STILL WORTH HAVING.** Six of its seven findings were real and are fixed
above. A review that is right six times out of seven is a good review; the lesson is that its
output is evidence, not a verdict — the same rule this project applies to every other tool.

### 14.31 The tagging proposal offered Weezer as a jazz candidate — FIXED 2026-09-02, migration 020

The first real weekly item's tagging table listed **Weezer, Foo Fighters, The Smashing Pumpkins,
The Killers and No Doubt** under *"your most-played uncategorised artists"*. Three of the eight
rows were real.

⚠️ **THE QUERY AND THE HEADING MEANT DIFFERENT THINGS.** `dj_tag_candidates` excluded artists
with a decision **for `p_tag`**, so it answered *"who has no jazz tag"* — under which Weezer is a
correct answer and a useless one. The heading said *"uncategorised"* — under which he is simply
wrong: the system holds a concert row, a playlist and an mbid for him.

🛑 **AND IT POISONED THE HEADLINE NUMBER.** *"23.7% to 61%"* was arithmetically true and rested on
tagging Weezer as jazz. **A projection whose path runs through decisions the reader would never
make is worse than no projection**, because the arithmetic gives it an authority the premise has
not earned.

#### "Exclude artists with a `dj_artists` row" is the obvious fix and it is wrong three ways

Recorded because it is the first thing anyone will reach for — it was the first thing *Alex*
reached for.

1. **It excludes a real candidate.** Lady Gaga has a `dj_artists` row and was one of the three
   genuine proposals in that very run. Having been to a concert says nothing about whether the
   system knows what kind of act someone is.
2. **It cannot be implemented reliably.** There is no join between `dj_artists.name` and
   `dj_tracks.artist` (§14.1), and the two disagree on exactly these acts: `dj_tracks` says *"The
   Smashing Pumpkins"* and *"The Killers"*, `dj_artists` says *"Smashing Pumpkins"* and
   *"Killers"*. An exact-string exclusion would **miss the two acts it was written to catch**
   (§14.7, the same leading-article problem).
3. **It answers the wrong question.** `dj_artists` is a setlist-lookup table keyed on mbid. Its 22
   rows exist so setlist.fm can be queried, not to record what kind of music something is.

#### What actually separates a real candidate from Weezer

**Weezer is already categorised — by a CONCERT PLAYLIST.** The system holds a durable recorded
fact about him: *an act Alex tracks as a live act*. Miles Davis, Lady Gaga and A$AP Rocky have no
such fact attached.

Two changes, which only work together:

1. **A candidate is an artist with NO TAG AT ALL** — any tag, any status — not one lacking a
   specific tag. The heading becomes literally true.
2. **Concert-playlist membership derives a `concert` tag**, exactly as jazz-playlist membership
   derives a `jazz` one (§14.23). Weezer is categorised by a fact the system already held and had
   never written down.

⚠️ **AND THE ASK CHANGES WITH THEM.** The question stops being *"is this jazz?"* and becomes
*"what is this?"*, with an open vocabulary. **"Weezer → rock" is an answer; "Weezer → not jazz"
was a rejection recorded against a question nobody would have asked.** It also drains the list:
one answer per artist, forever, whatever the answer.

#### Only two playlist kinds derive a tag, and the exclusions are the point

`jazz → jazz` (a genre claim about the act) and `concert → concert` (an act tracked as a live
act). 🛑 **`artist`, `discovery` and `utility` derive nothing.** They describe what the *playlist*
is for, not what the *act* is. **Utility is the dangerous one:** *"Elise's fun list"* alone holds
363 distinct groups, so deriving from it would tag several hundred artists with a word that says
nothing about any of them — clearing the backlog by redefining *categorised* to mean *"appears in
a playlist Alex made for the gym"*. **That is a metric improving itself.**

⚠️ **Named edge case:** Nirvana is in the Foo Fighters concert playlist because Grohl wrote
*Marigold* (§12.10 records that as deliberate), so Nirvana acquires a `concert` tag and leaves the
candidate list. Loose, and accepted: the tag is visible in `get_dj_artist_tags` with
`source='playlist'`, and it costs one artist a proposal rather than costing a wrong answer.

#### Two coverage numbers, named apart

- **CATEGORISATION** (`categorised_rows / played_rows`) — *how much of my listening does the
  system know anything about.* It moves whatever the answer is, so it is the backlog metric and
  **the only one a tagging projection may use.**
- **TAG SHARE** (`tagged_rows / played_rows`) — *how much of my listening is jazz.* A **listening
  fact, not a progress bar.** Tagging Weezer `rock` must not move it, and under the pre-020 design
  it did.

⚠️ A rejected-only artist is **decided but not categorised**, so the buckets do not sum to
`played_rows`. Deliberate: a rejection records that a question was answered, not that the system
learned what the act is.

### 14.32 One clause fixes a contradiction that is not one

Section 3 lists Monk, Eddie Higgins Trio and Bill Evans as tagged jazz. Section 4 says the same
artists are in no playlist. **Both true, and side by side they read as the tool disagreeing with
itself** — the same shape as §14.19, arriving through content rather than through field names.

The fix is one clause where the names first appear: **a tag is not a playlist. Tagging categorises
an artist; it does not add him to anything.** That an artist can be tagged and unplaylisted is the
finding, not a contradiction.

### 14.33 The delivery shape: three artifacts, and the third did not exist

The scheduled task writes an **inbox item**; Alex pastes it into a thread and has the
conversation. That is three artifacts:

1. **`docs/dj-weekly-review-prompt.md`** — tells the scheduled task how to GENERATE the report.
2. **The report** — the item's body.
3. **`.claude/skills/dj-weekly-review/SKILL.md`** — tells the follow-up conversation how to ACT.
   **Built 2026-09-02; did not exist before.**

🛑 **A SKILL RATHER THAN MORE PROSE IN THE ITEM, FOR A REASON §14.25 ALREADY PROVED.** Instructions
carried inside an item are frozen at the moment it was written, and every item already sitting in
the inbox keeps whatever was true then — permanently, and with nothing able to reveal the drift.
A skill lives in one place and changes without editing anything already filed.

⚠️ **THE ITEM MUST SAY "LOAD THE SKILL" IN SO MANY WORDS.** Skills load by name. A thread that does
not know to load one reads the item as a document, which is precisely how the first prompt got
critiqued instead of run (§14.30). The item body is therefore fixed at: a dated title, the
load-the-skill line, and the report. **Nothing else.**

⚠️ **AND THE TWO INSTRUCTION FILES STAY DISTINCT.** The prompt addresses a task that GENERATES;
the skill addresses a conversation that ACTS. Different audiences, different verbs. Merging them
produces something that reads as a spec — §14.30 again.

### 14.34 The skill assumed the report had been read — FIXED 2026-09-02

The first live round trip worked: the item landed, the skill loaded, it acted rather than
critiquing, and it **refused a wrong status** — `missed` means the show happened, so a future date
is `rejected`, not `missed`.

🛑 **BUT IT ASKED QUESTIONS ABOUT A DOCUMENT ALEX HAD NEVER OPENED.** He pasted the item in
without reading it — pasting is not reading — so *"two songs would mean learning from a live
recording"* and *"any of the eight artists to tag?"* had no context to land in.

⚠️ **THIS IS §14.30 ONE LAYER ALONG: WRITTEN FOR SOMEONE WHO ALREADY KNOWS.** The prompt failed by
burying its instructions under rationale; the skill failed by presenting decisions without the
facts behind them. **Both were written from inside the system's knowledge rather than from what
the reader arrives with.**

**Fixed:** the skill's first job is now to **present the item** — headline, each concert in two or
three lines, every decision carrying its own context — before asking anything. **The tag table
with suggested tags goes in that first reply**, not when asked for.

⚠️ **THE SUGGESTED TAG IS EXPLICITLY MARKED AS GENERAL KNOWLEDGE, NOT DERIVED.** Miles Davis →
`jazz` comes from knowing who Miles Davis is; **nothing in the data knows what genre anything is**
(§14.3). A suggestion presented as though it came from the listening history is precisely the
failure that made the jazz section wrong for a quarter (§14.13). Unknown string → suggest nothing.

### 14.35 🛑 The derived arm wrote garbage with the authority of a derivation — SURFACED 2026-09-02, migration 021

After the 018 and 020 seeds, 118 artist strings carried tags. Among the jazz ones, written as
FACTS with `source='playlist'`:

> `"Dec 29, 2023"` · `"Anything_F_744"` · `"aron!"` · `"Cavendish Music"`

**Every one is TRUE as a statement about membership** — the string really does appear as
`dj_tracks.artist` on a track in a `kind='jazz'` playlist. **Every one is FALSE as the thing the
tag says**, which is that this is a jazz artist.

⚠️ **THE DERIVATION ASSERTS MORE THAN IT KNOWS. It knows MEMBERSHIP and writes a CLAIM ABOUT AN
ACT.** The gap between those is §14.9, already recorded — and the derived arm propagated it with
the authority of a fact rather than the hesitancy of a guess.

🛑 **IT IS WORSE THAN THE UNTAGGED CASE IT REPLACED.** An untagged junk string sits in the
candidate list where a human eventually looks at it. A junk string tagged `source='playlist'` is
marked *no judgement needed*, counts toward coverage, and **will never be proposed again** — the
pollution is now load-bearing for a number the weekly item prints.

#### No rule decides which strings are real

**Every such rule is a guess about text**, and this project has already priced them: §14.7's
*"prefer the longer form"* fixes Eddie Higgins and breaks Red Garland in one stroke. A regex
catching `"Dec 29, 2023"` also catches a band with a number in its name, and it would delete a
curated row silently.

**So: surface, do not decide.** `dj_tag_review` orders tags by **how much evidence exists that the
string names an act**, using four facts already in the database — `distinct_tracks`,
`distinct_playlists`, `play_rows`, `distinct_days` — weakest first.

⚠️ **NOTHING IN IT INSPECTS THE STRING.** A real act accumulates tracks, playlists and plays; a
byline scraped onto one upload accumulates one track and stops. **That asymmetry is factual, and
it is an ordering for a human, never a verdict.** A test asserts no `suspect`-style field ever
appears on a row.

`dj_tag_coverage` gains **`tagged_single_track`** so the weekly item can qualify its own share in
one clause without a second call.

🛑 **THE CLEANUP IS A NAMED, UNSTARTED JOB.** Rejecting polluted tags is a hand-reviewed pass over
a ranked list. Doing it inside the weekly item would put an irreversible judgement about a hundred
rows inside a conversation about concerts, and both the tool payload and the skill forbid it.

### 14.36 A lingering want needs a row that COMES BACK, not a note — FIXED 2026-09-02

Asked about a show he decided against, Alex said *"we still might see them if they come back"*.
That ended up as free text in a `notes` field on a **rejected** concert row.

🛑 **NOTHING WILL EVER READ IT.** A rejected row is not past, not upcoming, and not
`needs_status`. The want disappeared the moment the conversation ended — the exact shape §12.8
already records for an undated `missed` row: *"the next one is a silent loss."*

**The right home is an undated `screening` row**, the same shape as the standing watchlist entries
Section 1b surfaces every week. It is the only shape that **comes back**.

#### The boundary is restated as ORIGINATE vs COMPLETE

§14.33's boundary said the weekly skill never creates a `dj_concerts` row. That phrasing blocked a
write that obviously should happen, so it is replaced with the distinction that actually matters:

- **COMPLETING a decision made in the conversation** — same artist, no date, `screening`, no
  playlist involved, every field determined by his answer. **Allowed**, and `create_dj_concert`
  touches no playlist, which is what makes it safe.
- **ORIGINATING a concert pipeline** — a dated row, a date or venue decision, a playlist, its
  contents, a cram block. **Still §13's job, still unbuilt.**

⚠️ **THIS IS THE SECOND TIME A DECISION IMPLIED A WRITE THE SKILL COULD NOT MAKE.** §13.3's
`missed` → `dj_feedback` was the first, and it was authorised. **Two of two suggests the pattern
is the rule rather than the exception:** an answer that changes a status usually implies a second
write somewhere, and the skill should be read as owning the completion of whatever it asks about.
The skill now also **asks** — *"still want to see them sometime?"* — rather than waiting for the
want to be volunteered.

### 14.37 What worked in the first round trip, recorded so it does not get edited away

- **It refused a wrong status and explained why** rather than writing what it was told.
- **It flagged the exact-string grouping limitation unprompted**, where it was load-bearing.
- **It said plainly that nothing had been written.**

⚠️ **Recorded in the skill itself under "What must not change".** Three rounds of revision have
each removed something; a behaviour nobody wrote down is one nobody protects.
