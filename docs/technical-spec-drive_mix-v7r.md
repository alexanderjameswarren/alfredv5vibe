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
| 1980s and earlier (any decade ≤ 1980, 1950s included) | 20% | 10 |
| 1990s–2000s | 44% | 22 |
| 2010s–2020s | 24% | 12 |
| Country and rap (any decade) | 12% | 6 |

  These are the step 7 quotas. Until then they were 8 / 27 / 10 / 5.

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
| decade | smallint null | 1950, 1960 … 2020. Null until tagged |
| genre | text null | check: pop, rock, alternative, country, rap, rnb, dance, other. Null until tagged |
| status | text not null | check: pending, active, retired. Only `active` is picked |
| source | text not null | check: playlist_seed, artist_top, history_sweep, manual |
| retired_reason | text null | only allowed when status is retired |
| thumbs | text null | step 10. check: up, down. Alex's latest thumb. `down` is never picked, whatever the status; `up` always counts as familiar |
| thumbs_at | timestamptz null | step 10. When the latest thumb, or its clearing, happened. Required when thumbs is set. A thumb older than this is ignored, so the latest thumb wins |
| added_at | timestamptz default now() | |

`pending` means "in the pool but not yet tagged and reviewed". Swept songs arrive pending; the daily task tags them and either activates them or retires them (for example a calm track that is not radio pop).

**Thumbs (step 10).** A thumbs down no longer retires a song. It keeps the song's status, and the picker skips it until a later thumbs up. A thumbs up on a song retired as `cut by Alex` or `cut by Alex (not known)` reactivates it (pending if untagged). A thumbs up never revives a song retired for any other reason: jazz, ambient or sleep, holiday or soundtrack, classical, kids or novelty. The step 10 migration moved songs retired as "thumbs down" to active (pending if untagged), with thumbs down and the reason cleared.

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

1. Eligible songs: `status = 'active'` with decade and genre set, and not thumbs down. Recency is computed for every pool song, whatever its status, because the cooldown in step 4 reads all of them.
   - **Familiar or new (step 10).** A song is familiar when its canonical group was heard on at least `p_familiar_days` (5) distinct days, through the same canonical mapping as recency, or when it is thumbs up. Every other song is new. The day count is a `count(distinct played_on)` in the same aggregate as recency, so there is no extra scan.
   - The rule is deliberately simple. Alex reviewed 20 songs with fewer than 5 play days and knew 8 of them. Era, source and 1-2 play days all failed to predict which; thumbs correct it over time.
2. All randomness is `md5` of the date and the song id, so a dry run and the real run for the same date return the same playlist, as long as no new plays or servings land in between.
3. **Carry-over (step 7).** Take the most recent serving before D. Every song in it that is still eligible and has **not been heard since that serving's date** goes into today's list first, marked `carried`. "Not heard since" means no `dj_plays` for its canonical group on or after `served_on` and before D.
   - Carried songs count toward their slice's quota and toward the artist cap, but are never dropped by either.
   - They are exempt from the cooldown.
   - If they alone exceed the count, the least recently heard are kept.
   - Carried songs chain: one still unheard tomorrow was in today's serving, so it carries again.
4. **Slices.** In this order — country and rap, 1980s and earlier, 2010s–2020s, 1990s–2000s — each slice is topped up to its quota, less what was carried, in recency order. New songs are skipped when:
   - their `artist_key` has reached the artist cap (carried songs count), or
   - their artist is **cooling down**: any pool song by that artist_key, any status, was heard in the `p_cooldown_days` days before D, via the canonical-group mapping. With the default of 2, a play on D-1 or D-2 blocks new songs on D; 0 turns the cooldown off.

   The list never goes past the count. So when carried songs push one slice over its quota, the remaining slices still fill only to the total count, and the slices filled last (1990s–2000s) give way. Every tagged song is in exactly one slice. Since step 6, "1980s and earlier" takes any decade ≤ 1980; before that it was 1960s–1980s, and older songs were fill only.

   **The familiar/new blend (step 10).**
   - New songs fill at most floor(`p_new_share` × count) of the list: 12 of 50 at 0.25. That cap is split across slices in proportion to their quotas, by largest remainder like the quotas, which gives 2 / 2 / 3 / 5 for country_rap / 1980s / 2010s / 1990s at 50. The rest of each quota is that slice's familiar share.
   - Each slice runs four passes, all in recency order:
     1. familiar songs, up to the familiar share;
     2. new songs, up to the new share;
     3. more familiar songs, if new ran short;
     4. more new songs, if familiar ran short. These are marked `new_over_cap`.
   - Carried songs count against their side's share.
   - **Familiar gap.** A familiar song heard fewer than `p_familiar_gap_days` (7) days before D is skipped in every pass, so its slot goes to a new song in the same slice. 0 turns it off. Carried songs are exempt.
   - **Exempt slices (migration 102).** Every song in a `p_familiar_slices_exempt` slice counts as familiar: that slice takes no new share, and the cap is split over the other slices. The default is `{1980s-and-earlier}`, which gives 2 / 0 / 4 / 6 at 50. Alex expects to know unplayed oldies, and that slice had only 9 familiar songs of 281.
   - **Familiar breaks the cooldown (102).** With `p_familiar_breaks_cooldown` (default true), a slice tries familiar songs by cooling artists, up to the familiar share, before any new song. The fill pass does the same. They are marked `cooling`. The per-list artist cap is never broken.
   - **new_over_cap (102)** marks every new song past its natural slice's new share, counted in selection order, so carried songs are counted first. Under 101 only the backfill passes set it, so carried new songs were never flagged.
   - **Why 102.** With 101 the new share averaged 0.469 in a 30-day simulation at 50. The reasons familiar songs were skipped, per day: mostly the artist cap (about 140), then the cooldown (about 20), then the 7-day gap (about 7). Familiar songs cluster by artist because they are heard album by album. Diagnostic simulations of the variants: as 101, 0.469; oldies exempt, 0.313; oldies exempt with familiar songs breaking the cooldown, 0.246 (chosen); oldies exempt with a 5-day gap, 0.277. A pick without carry-over was already exactly on target (12 new); today's real pick was high only because of 24 new songs carried over from the old picker's serving.
5. If a slice runs short, the remaining slots are filled from all eligible songs in recency order (slice `fill`), familiar first, under the same artist cap, cooldown and familiar gap. The last resort then takes, in order: familiar songs by cooling artists, new songs by cooling artists, and finally familiar songs inside the gap. `cooling` is true when the artist really was cooling. A list can still come up short, and the shortfall is reported.
6. **Order (step 10): spread, not shuffled.**
   - The chosen songs are grouped by natural slice and by familiar/new: 8 groups. A song taken as `fill` still belongs to its natural slice here.
   - Inside each group the songs are ordered by md5(date, song). Song r of a group of k aims at position (r − 0.5) × n / k, plus a jitter from md5(date, song) of up to a quarter of the group's spacing either way.
   - The list is sorted by aim. So every slice, and its new songs, are spaced evenly from start to end. Until step 10 a plain seeded shuffle front-loaded 1980s-and-earlier songs and back-loaded country, rap and 2010s–2020s songs.
   - Adjacent same-artist pairs are then fixed by swapping with the **nearest** position that leaves both spots clean, so the spacing survives. It stays deterministic for a date.
7. Return: position, song id, video_id, title, artist, artist_key, slice (`fill` for step 5 songs), song_slice (the natural slice), carried, cooling, last heard, distinct_days, familiar and new_over_cap.

Parameters with defaults:
- `p_date`: today, UTC.
- `p_count`: 50.
- `p_artist_cap`: 2.
- `p_quotas`: jsonb song counts per slice, `{"country_rap":6,"1980s-and-earlier":10,"2010s-2020s":12,"1990s-2000s":22}`. They must sum to at most `p_count`; the rest is filled by step 5.
- `p_cooldown_days`: 2, range 0–30.
- `p_new_share`: 0.25, range 0–1 (step 10).
- `p_familiar_days`: 5, range 1–365 (step 10).
- `p_familiar_gap_days`: 7, range 0–60 (step 10).
- `p_familiar_slices_exempt`: `{1980s-and-earlier}`, any of the four slices, or `{}` (102).
- `p_familiar_breaks_cooldown`: true (102).
- `p_recency`, `p_play_days` and `p_last_serving`: internal, for the simulator.
  - They are a song_id → last-heard map, a song_id → distinct-days map, and `{served_on, song_ids}`.
  - When given, they replace the `dj_plays` and `drive_mix_servings` reads, so a simulated day runs the same code as a real one.

Step 10 changed the signature, so the function was dropped and recreated rather than replaced. The tools call it by parameter name.

Why step 7 changed the picker: on the seeded pool (1,440 active), big catalogues such as Alanis Morissette (42 songs) and Foo Fighters (45) appeared nearly every day even at artist_cap 1. The cooldown ties artist variety to what Alex actually heard. Carry-over stops a short drive from burning the songs he never reached.

### Simulator

A second function runs the picker for N consecutive days (cap 120) without writing anything. It is a `stable` plpgsql function with no temp tables. It holds the simulated last-heard map and the previous day's list in memory, starting from real recency and the real last serving before the start date, and passes them to the picker as `p_recency` and `p_last_serving`. Each day, the first `p_heard_per_day` songs (default: all) count as heard **on that day**, for both recency and the cooldown; the rest carry over, exactly as in real use. It takes `p_cooldown_days` like the picker. It returns:

- per-song: times served and times heard,
- per-artist: times served, **days_appeared** (distinct days with at least one song, to check the cooldown), and songs in the pool,
- `repeat_gap`: min and median days between serves of a song; carry-over makes 1-day gaps normal on short drives,
- `heard_gap`: min and median days between hearings of a song, which is the listener's real repetition,
- `carried_per_day_avg`,
- slice shortfalls: days a slice, or the whole list, could not be filled,
- `new_songs` (step 10): the cap per day; the new share's average, average from day 2 (day 1 carries over the real last serving), minimum and maximum; `over_cap_total`; and each day's new and over-cap counts,
- `cooling_breaks` (102): familiar songs served by a cooling artist,
- `slices` (step 10): per natural slice, `avg_position` (fair is `ideal_avg_position`, (count + 1) / 2), `familiar_served`, `new_served`, and `familiar_min_repeat_gap`, the fewest days between two serves of a familiar song.

It takes `p_new_share`, `p_familiar_days` and `p_familiar_gap_days` like the picker, and keeps a play-days map in memory. A simulated hearing adds a play day, so new songs become familiar during a run.

This is how the artist cap and quotas get tuned with real numbers before going live.

### Length independence (step 7)

- The count is 1–200 for pick, simulation and serving. About 50 songs is 3 hours; about 170 is 10 hours.
- Quotas are always proportions, scaled to the count by largest remainder, with ties to the earlier slice. So counts that already sum to the count come back unchanged.
  - The default shape is 6/10/12/22. That gives 6/10/12/22 at 50 and 20/34/41/75 at 170.
- The artist cap defaults to ceil(count / 25): 2 at 50, 7 at 170. An explicit cap wins.
- Carry-over never exceeds the count, so a 170-song day followed by a 50-song day carries at most 50.
- The cooldown is a preference. A fourth pass takes cooling artists, in recency order and under the cap, only when the list would otherwise be short (`cooling = true`). The tool reports these as `cooling_used`, and the simulator as `cooling_fills`, total and per day.

### Performance (measured 2026-10-08, as `authenticated`)

🛑 **Measure as `authenticated`, never as postgres.** The SQL editor runs as postgres, which bypasses RLS, so its timings do not show the real path. Step 7's editor numbers (pick 451 ms) hid a pick that took about 10 s as `authenticated` and timed out through MCP. Time it inside a transaction:

```
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<uid>","role":"authenticated"}';
set local statement_timeout = '120s';
-- the query to time
```

The pool had 1,768 songs, against 6,700 dj_tracks and 18,491 dj_plays.

| Operation, as `authenticated` | 098 (correlated recency) | 099 (set-based recency) |
|---|---|---|
| `drive_mix_pick(today, 50)` | 10,095 ms | 461 ms |
| `drive_mix_pick(today, 170)` | 10,118 ms | 42 ms |
| `drive_mix_simulate`, 30 days at 50 | 5,138 ms | 1,150 ms (about 0.8 ms per song-day) |

- **Why 098 was slow:** recency was a correlated subquery per pool song. Its join `t.id = g OR t.canonical_track_id = g` cannot use an index, so it seq-scanned all of `dj_tracks` once per song: 1,500 loops × 6,700 rows. RLS made that worse.
- **What 099 changed:** recency is one aggregate per call, `dj_plays` × `dj_tracks` grouped by `coalesce(canonical_track_id, id)`, with every table filtered by `user_id = auth.uid()` (read once into a variable). That one result is reused for last-heard order, carry-over and the cooldown.
- **Results are unchanged:** fingerprints of pick 50, pick 170 and a 30-day simulation were identical before and after.
- **The registered owner policies** are `user_id = auth.uid()`, not wrapped in `(select auth.uid())`. Here that showed up only as a one-time filter, a minor cost. Changing it would be a `register_table` (platform) decision and was not made.
- **With no signed-in user,** both functions refuse instead of reading every user's rows.
- **The binding limit is `statement_timeout = 8s` on the `authenticated` role,** which every MCP call runs as. At about 0.8 ms per song-day, `get_drive_mix_simulation` refuses any request where days × count > 6,000 song-days before it calls the database. 60 days at 100 songs is allowed, as is 30 days at 200; 120 × 200 is refused.

### Step 7 simulation results (seeded pool, 60 days, count 50)

| Heard per day | repeat_gap | heard_gap | Carried per day | Shortfalls | Cooling fills | Distinct heard |
|---|---|---|---|---|---|---|
| 50 | min 17, median 23 | min 17, median 23 | 0 | 0 | 0 | 1,362 |
| 15 | min 1, median 1 | none repeated | 34.4 | 0 | 0 | 900 |

- **Heard 50:** the big catalogues dropped to about 20 days of 60: Alanis, Oasis, Coldplay, Katy Perry and the Beatles 20 each; Foo Fighters and Taylor Swift 19.
- **Heard 15:** carry-over dominates and only about 16 new songs a day are drawn, so artists with many never-heard songs show up on many days: Oasis, Alanis and Michael Jackson 43 each, The Commitments 41, Foo Fighters 29, Taylor Swift 12.

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
| `get_drive_mix_songs` | 1 | List pool songs. Filters: status, artist (matches artist_key), untagged only, source, thumbs. Bounded by `clampLimit`. Also returns pool counts by status, by thumbs, and by slice (active, tagged, not thumbs down). |
| `create_drive_mix_songs` | 1 | Add up to 50 songs in one call. Skips duplicates by video_id and reports them. Default status `pending` unless decade and genre are supplied, then `active`. |
| `update_drive_mix_songs` | 2 | Update by song ids: decade, genre, artist_key, status, retired_reason. |
| `update_drive_mix_artist` | 3 | Retire or reactivate every song for one artist_key. `propose` lists the songs affected. |
| `get_drive_mix_pick` | 1 | Dry run of the picker for a date. Writes nothing. Step 10 adds `new_share`, `familiar_days`, `familiar_gap_days`, `familiar_slices_exempt` and `familiar_breaks_cooldown`. It reports `new_cap`, `new_songs`, `new_over_cap`, `cooling_breaks`, and per song distinct_days, familiar, new_over_cap and song_slice. |
| `get_drive_mix_simulation` | 1 | Runs the simulator for N days (cap 120). Writes nothing. Takes the same step 10 params and returns `new_songs`, `cooling_breaks` and `slices`. |
| `update_drive_mix_thumbs` | 2 | Step 10. Takes up to 200 of {video_id, thumbs: up/down/clear, at}. The latest `at` wins, within the call and against the stored thumbs_at, and the write re-checks thumbs_at. A thumbs up revives only songs cut by Alex (section 3). Returns updated, revived and skipped. |
| `create_drive_mix_serving` | 2 | Records the serving for a date from the video_ids that actually went to YouTube, in order, as given. Checks each is an active pool song and refuses otherwise. Does not re-run or compare against the picker: that comparison would fail in exactly the case it is meant to catch, and the record must match what went out. Refuses with a clear error if that date already has a serving; there is no replace option. No `propose`. |
| `create_drive_mix_sweep` | 1 | Runs the sweep and returns what was added. |

## 6. Workshop tool (alfred-v5's `workshop/` folder)

`get_dj_artist_top_songs`, in `workshop/workshop/tools/dj_write.py`, tier 1, read-only. It finds an artist's hits ranked by **YouTube Music play counts** (not Alex's plays), and proposes which ones to pool.

- **Input:** `artist` (a name) or `channel_id` (UC...), exactly one. `limit` is the scan cap: default 30 (50 until step 6), cap 100. `suggest_ratio` defaults to 0.1 and `suggest_floor` to 10,000,000.
- **Resolve:** an artist-filtered search. A name resolves only when exactly one result matches it exactly (case-insensitive). Otherwise `resolved: false`, with `candidates` and no songs, and a human chooses. When several match, each candidate is enriched from its artist page with subscribers and three top song titles. "Toto" returns three channels: the band with 1.51M subscribers, and two namesakes with 20 and 8.
- **Scan:** the artist page's songs, then the full songs list (`get_playlist` on the section's browseId), in YouTube's order, up to `limit`.
- **Dedupe:** normalise each title by lower-casing it and removing anything in () or [], anything after " - ", feat./ft./featuring credits, and punctuation, then collapsing spaces. The same normalised title is the same song.
- **Variant flag:** a marker word in the title's *decoration* only, meaning the bracketed parts and anything after " - ", never the core title, so "Live Forever" is not flagged. The words are live, acoustic, unplugged, remix, mix, edit, demo, version, re-recorded, remaster, instrumental, karaoke, extended, reprise, mono, orchestral and session. "Taylor's Version" on its own is not a variant.
- **Plays:** the artist page and songs list carry no play count (`views` is always None; probed 2026-10-07). So there is one song search per deduped song, for "<artist> <normalised title>". A hit is matched to a version by video_id, else by normalised title with the same artist (by name or channel id). `views` text ("3.1B", "133M", "2.4K") is parsed to an integer. A song's plays are the highest of any matched hit. With no match, plays are null and the song is never suggested.
- **Representative:** the original (non-variant) version if one exists, else the most-played version. Bryan Adams' re-recorded "Classic Version"s are accepted as representatives.
- **original_candidate:** when every version is a variant, the best non-variant search hit with the same title by the same artist, as video_id, title, album and plays. It is offered, never substituted.
- **Suggested:** songs are sorted by plays, highest first. A song is `suggested` when plays ≥ suggest_ratio × the top song's plays and plays ≥ suggest_floor. This is a proposal for Alex to approve. Alex confirmed the 10% and 10M defaults: a-ha gives only Take on Me, and Toto gives four.
  - **Step 10: the bar stays, and the review decides.** On 2026-10-09 Alex chose Take a Bow, Ray of Light and Express Yourself, all below Madonna's bar. He rejected Billy Joel's Honesty and Vienna, his #4 and #5 by plays. No play-count rule separates those, and anchoring the bar to the 5th song only made both lists deeper.
  - So the tool is unchanged. When adding an artist, the drive-mix skill calls it with limit 60 and shows Alex every suggested song plus about 10 below the bar. Nothing is added without his pick. At scan 30, Ray of Light and Express Yourself were not even scanned.
- **Guest spots:** a song is suggested only when the requested artist is the **first** credited artist on its representative version. When the artist is credited second or later (Pavarotti's "'O Sole Mio" with Bryan Adams, or a feat. on someone else's song), the song gets `guest: true`, stays in the list, and is never suggested. The top-plays bar is set by the artist's own songs only, so a big guest spot cannot raise it.
- **Returns per song:** position, title, video_id, artists, album, plays, suggested, variant, variant_word, versions_merged (count and titles), and original_candidate. The response also carries artist, channel_id, scanned, distinct_songs, suggested_count, thresholds (with top_plays and plays_needed), and lookup_errors.
- **year is dropped.** It was None on page songs, songs-list tracks and search results alike.
- **Speed and the time budget:**
  - Play-count searches run 8 at a time (5 until step 6; 8 ran clean live), and the ambiguity page reads run together.
  - `time_budget_seconds` defaults to 20 (25 until step 6), with a range of 5 to 55. It covers the **whole call**: artist search, candidate enrichment, the artist page, the songs list and the lookups all share one hard deadline at budget + 3s grace.
  - When the artist search or artist page misses that deadline, the call fails with a retryable `upstream_timeout`. A songs list that misses it leaves just the page's songs (`songs_list_read: timed_out`). No lookup starts after the budget, and in-flight ones are dropped at the hard deadline.
  - Step 6 made this change because on the Surface the 5e build took 22.9 to 27.1s, over its 25s budget: the page reads were not counted.
  - A song not looked up gets plays null and is never suggested. `not_looked_up` counts those songs, `meta.truncated` is (looked up, distinct songs), and the reading says to re-call with a smaller limit.
  - Results are gathered first, then read back in YouTube's order, so completion order cannot change the answer. One failed lookup leaves that song at plays null and is listed in `lookup_errors`; only all of them failing fails the call.
  - Speed is preferred over perfect dedupe: an occasional duplicate version is acceptable.
- **Live run (desktop, unauthenticated, 2026-10-07), at the default scan of 50:**

  | Artist | Sequential (5d) | Concurrent ×5 (5e) | Suggested |
  |---|---|---|---|
  | Bryan Adams | 23.6s | 8.1s | 10 (top Heaven (Live), 138M; bar 13.8M) |
  | Toto (band channel) | 24.1s | 5.9s | 4: Africa 1.9B, Hold the Line 717M, Rosanna 227M, I'll Be Over You 191M |
  | a-ha | 20.6s | 5.8s | 1: Take on Me 3.1B (bar 310M) |

  The ambiguous "Toto" call took 0.9s. There were no lookup errors at concurrency 5.

  **Step 6** (desktop, scan 30, concurrency 8): Bryan Adams 5.8s with 10 suggested ('O Sole Mio flagged as a guest), the Toto band 5.1s with 4 suggested, a-ha 11.7s with 1 suggested. There were no lookup errors.

## 7. The daily scheduled task (set up in chat, not code)

Runs early morning, after the existing DJ daily history sync:

1. Run the sweep. Tag each new pending song's decade and genre, and activate it, or retire it with a reason if it isn't radio pop.
   - Thumbs (step 10): pass every thumb read to `update_drive_mix_thumbs` with video_id, thumbs and `at`. Never retire a song for a thumbs down.
2. Dry-run the pick for today.
3. Replace the Drive Mix playlist with those video_ids (Workshop `replace_dj_playlist`).
4. Only after the playlist write succeeds, record the serving.
5. Report one line: songs added, songs served, and any warning (sync looked stale, a slice ran short).

## 8. Success criteria

- Both tables CONFORMANT.
- A 60-day simulation on the seeded pool shows no song repeating sooner than (pool size ÷ 50) days minus a small margin, and every slice filled on every day.
- Drive Mix refreshes every morning without intervention for a week.
- "Add Bryan Adams" in chat adds his top five songs after Alex's review.
