# DJ — Technical Specification

**Status:** Phases 0, 1, 2a, 2b, 3a, 3b complete. Phase 8 blocked on one SQL statement
(the `played_on` schema comment); nothing imported. Phases 4, 5, 6, 7 outstanding.
**Last updated:** 2026-08-29

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

### 12.4 Covers resolve against the PERFORMING artist

Weezer's *Happy Together*, not The Turtles'. **If YouTube Music does not have their version,
it is not in the playlist** — no judgement about whether a cover "counts". This already worked
in Phase 3b, where the Teal Album cut resolved correctly and disproved the live-only hazard
note that had been written against it. `cover_of` is returned by the tool as information for a
human, never as a gate.

### 12.5 PROPOSAL ONLY — nothing writes to YouTube unattended

The weekly job reads setlists, diffs against the recorded body, and raises **one** inbox item.
Acting on it is a separate, human step.

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

---

## 13. The concert-playlist skill (planned, not built)

**Do not build until the weekly diff works.** Recorded now while the reasoning is fresh.

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
