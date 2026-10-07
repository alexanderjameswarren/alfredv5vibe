# Technical Spec: Drive Mix

Project code: `drive_mix-v7r`
Repos: alfred-v5 (database and MCP tools), Workshop (one new read tool)

## 1. Overview

Drive Mix is a daily-refreshed YouTube Music playlist of familiar pop, rock and alternative songs for the car. It replaces YouTube's static "All-Time Alt" playlist, whose fixed order makes it repetitive.

It works like Today's Jazz: one fixed YouTube playlist, overwritten each morning by a scheduled Claude task. The difference is that a **database function** chooses the songs, not Claude. That keeps the daily run fast, cheap and consistent, with no per-song searching or judgement.

Three parts:

1. **A song pool** in Supabase: a few thousand songs Alex knows, each tagged with decade and genre.
2. **A picker**: a Postgres function that chooses about 50 songs (roughly three hours) for a given day, following the variety rules in section 4.
3. **A daily scheduled task** that sweeps new songs into the pool from listening history, runs the picker, and replaces the Drive Mix playlist.

## 2. Settled decisions

- Playlist name: **Drive Mix**, PRIVATE.
- Length: about 50 songs per day.
- Taste: songs Alex knows or has likely heard on the radio. "Best of", not deep cuts.
- Era and genre mix per playlist:

| Slice | Share | Of 50 |
|---|---|---|
| 1960s–1980s | 15% | 8 |
| 1990s–2000s | 55% | 27 |
| 2010s–2020s | 20% | 10 |
| Country and rap (any decade) | 10% | 5 |

  A song tagged country or rap always counts in the country-and-rap slice, whatever its decade.
- **Song variety comes first, artist variety second.** No song repeats until every other eligible song has had its turn. Artist variety is a guardrail: at most 2 songs per artist per playlist (tunable), and never the same artist twice in a row.
- "Played at least twice" means **played on at least two different days**. YouTube history records one entry per track per day, so true repeat counts within a day cannot be known (see `get_dj_plays`).
- Pool sources:
  - Alex's non-jazz playlists, excluding sleep, massage and yoga playlists, best effort (reads stop at 200 tracks per playlist).
  - A named artist list, each expanded to the artist's top songs.
  - For artists Alex plays heavily: every song of theirs he has played, plus their top songs. Not the full catalogue.
  - An ongoing sweep of listening history (section 5).
- Skips: not reliably trackable from history. Retiring a song or artist is done by asking Claude. Thumbs-down readability is checked in the last step.

## 3. Data model

### `drive_mix_songs` — the pool

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid not null default auth.uid() | as other DJ tables |
| video_id | text not null | unique per user |
| title | text not null | |
| artist | text not null | display billing as YouTube gives it |
| artist_key | text not null | normalised primary artist used for the per-artist cap: lower-cased, trimmed, first name of a collaboration (split on `,` `&` `+` feat. ft. featuring with). Filled by a before-insert trigger when not supplied; settable by tool when the default is wrong |
| decade | smallint null | 1960, 1970 … 2020. Null until tagged |
| genre | text null | check: pop, rock, alternative, country, rap, rnb, dance, other. Null until tagged |
| status | text not null | check: pending, active, retired. Only `active` is picked |
| source | text not null | check: playlist_seed, artist_top, history_sweep, manual |
| retired_reason | text null | only allowed when status is retired |
| added_at | timestamptz default now() | |

`pending` means "in the pool but not yet tagged and reviewed". Swept songs arrive pending; the daily task tags them and either activates them or retires them (for example a calm track that is not radio pop).

### `drive_mix_servings` — what was served each day

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid not null default auth.uid() | |
| served_on | date not null | |
| position | int not null | 1-based order in the playlist |
| song_id | uuid fk → drive_mix_songs, on delete restrict | |
| video_id | text not null | |
| recorded_at | timestamptz default now() | |

Unique on (user_id, served_on, position) and on (user_id, served_on, song_id). This is a record of what actually went out to YouTube, used for debugging. It is written from the video_ids that were sent, never re-derived from the picker.

Both tables register with `platform.register_table()` (audited) and the migration ends with `check_platform_conformance` returning CONFORMANT.

## 4. The picker

### Recency: "last heard", not "last served"

Each song's recency is **the most recent day before the pick date that it appears in `dj_plays`** (any source). The pool stores only `video_id`, so the path is: pool `video_id` → the `dj_tracks` row with that video_id → its group `coalesce(canonical_track_id, id)` → plays of any track in that group. Accepted limits: a pool song whose video_id has no `dj_tracks` row (an artist top song never played) counts as never heard, and a variant that was never grouped under the canonical row does not count. Never-heard songs sort first. Ties are broken by `md5(date || song_id)`, which is deterministic without `setseed()`.

Why "heard" rather than "served": Alex's drive is short, so he will hear only part of each playlist. Songs he did not reach stay near the front of the queue and come back the next day, instead of being burned. A side benefit: songs he hears elsewhere (for example his Collective Soul playlist) are pushed back in the Drive Mix queue too.

Consequence to know: if the daily history sync fails, recency does not advance, and the next playlist will overlap heavily with the last. Acceptable; the daily task should report it.

### Algorithm, for a given date and count (default 50)

1. Eligible songs: `status = 'active'` with decade and genre set.
2. All randomness is `md5` of the date and the song id, so a dry run and the real run for the same date return the same playlist (as long as no new plays land in between).
3. For each slice, in this order — country and rap, 1960s–1980s, 2010s–2020s, 1990s–2000s — walk that slice's songs in recency order and take songs until the slice quota is met, skipping any whose `artist_key` has already reached the artist cap in this playlist. Songs from the 1950s or earlier fit no slice; they are reached only by step 4.
4. If a slice runs short, fill the remaining slots from all eligible songs in recency order, same artist cap.
5. Order the final list randomly (seeded), then fix any adjacent same-artist pairs by swapping.
6. Return: position, song id, video_id, title, artist, artist_key, slice (`fill` for step 4 songs), last heard.

Parameters with defaults: `p_date` (today, UTC), `p_count` (50), `p_artist_cap` (2), `p_quotas` (jsonb song counts per slice: `{"country_rap":5,"1960s-1980s":8,"2010s-2020s":10,"1990s-2000s":27}`; must sum to at most `p_count`, the rest is filled by step 4), and `p_recency` (internal, for the simulator: a song_id → last-heard map that replaces the `dj_plays` lookup).

### Simulator

A second function runs the picker for N consecutive days (cap 120) without writing anything. It is a `stable` plpgsql function that holds the simulated last-heard map in memory, starting from real recency before the start date, and passes it to the picker as `p_recency`; no temp tables. Between simulated days it treats the first `p_heard_per_day` songs of each playlist as heard (default: all of them), so recency advances as it would in real use. It returns:

- per-song: times served in the window,
- per-artist: times served, number of songs in pool,
- the minimum and median number of days between repeats of any song,
- slice shortfalls (days a slice could not be filled).

This is how the artist cap and quotas get tuned with real numbers before going live.

### Sweep

A function adds to the pool, as `pending`, every canonical group that:

- has been played on at least two different days (any variant of the group counts),
- is not already in the pool (matched by canonical group, not just video_id),
- has no track whose `dj_tracks.artist` exactly matches a `dj_artist_tags` row with `tag = 'jazz'` and **`status = 'active'`**. Rejected rows are decisions *not* to tag, and must not exclude anything. The tag list is keyed on the exact `dj_tracks.artist` string, not on `dj_artists` and not on a normalised name.
- is not credited to the artist "Release" (YouTube's fallback label for topic channels; see DJ notes).

It inserts the **canonical row's** video_id, title and artist, and returns the rows added. Decade and genre stay null for the daily task to fill. It refuses to run without a signed-in user, so it cannot pool every user's history from the SQL editor.

## 5. MCP tools (alfred-v5, via `defineTool`)

Tier choices below are proposals; the platform contract wins if it says otherwise.

| Tool | Tier | Purpose |
|---|---|---|
| `get_drive_mix_songs` | 1 | List pool songs. Filters: status, artist (matches artist_key), untagged only, source. Bounded by `clampLimit`. Also returns pool counts by status and slice. |
| `create_drive_mix_songs` | 1 | Add up to 50 songs in one call. Skips duplicates by video_id and reports them. Default status `pending` unless decade and genre are supplied, then `active`. |
| `update_drive_mix_songs` | 2 | Update by song ids: decade, genre, artist_key, status, retired_reason. |
| `update_drive_mix_artist` | 3 | Retire or reactivate every song for one artist_key. `propose` lists the songs affected. |
| `get_drive_mix_pick` | 1 | Dry run of the picker for a date. Writes nothing. |
| `get_drive_mix_simulation` | 1 | Runs the simulator for N days (cap 120). Writes nothing. |
| `create_drive_mix_serving` | 2 | Records the serving for a date from the video_ids that actually went to YouTube, in order, as given. Checks each is an active pool song and refuses otherwise. Does not re-run or compare against the picker: that comparison would fail in exactly the case it is meant to catch, and the record must match what went out. Refuses with a clear error if that date already has a serving; there is no replace option. No `propose`. |
| `create_drive_mix_sweep` | 1 | Runs the sweep and returns what was added. |

## 6. Workshop tool (Workshop repo, separate from alfred-v5)

`get_dj_artist_top_songs` — given an artist name or channel id, return that artist's top songs as YouTube Music lists them on the artist page (title, video_id, artists, album, year if present), default 5, cap 25. Read-only. Uses ytmusicapi's artist lookup. When the name matches more than one artist channel, return the candidates rather than choosing.

This repo has no claims system, so it is handled in its own CLI prompt.

## 7. The daily scheduled task (set up in chat, not code)

Runs early morning, after the existing DJ daily history sync:

1. Run the sweep. Tag each new pending song's decade and genre, and activate it, or retire it with a reason if it isn't radio pop.
2. Dry-run the pick for today.
3. Replace the Drive Mix playlist with those video_ids (Workshop `replace_dj_playlist`).
4. Only after the playlist write succeeds, record the serving.
5. Report one line: songs added, songs served, and any warning (sync looked stale, a slice ran short).

## 8. Success criteria

- Both tables CONFORMANT.
- A 60-day simulation on the seeded pool shows no song repeating sooner than (pool size ÷ 50) days minus a small margin, and every slice filled on every day.
- Drive Mix refreshes every morning without intervention for a week.
- "Add Bryan Adams" in chat adds his top five songs after Alex's review.
