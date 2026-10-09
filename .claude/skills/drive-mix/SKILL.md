---
name: drive-mix
description: Manage Alex's Drive Mix car playlist: add artists or songs, cut songs or artists, record thumbs, change today's mix (longer, more or less of an artist or genre), "too much X / more X", refresh it now, or answer questions about the pool.
---

# Drive Mix

Drive Mix is Alex's default car playlist: familiar pop, rock, alternative, a little country and rap, songs he knows or heard on the radio. A daily scheduled task ("Drive Mix daily refresh", 4:54 am Pacific) rebuilds it every morning from a song pool in Supabase. This skill covers everything Alex asks for in chat.

## Key facts

- YouTube playlist: **Drive Mix**, id `PLbtyzvGuByeU`, PRIVATE, recorded in DJ as kind `utility`. It is disposable: overwritten with `replace_dj_playlist`, never emptied.
- Pool table `drive_mix_songs` (status pending / active / retired; decade; genre; artist_key). Only `active` songs are picked.
- Slices: country_rap (genre country or rap, any decade), 1980s-and-earlier, 1990s-2000s, 2010s-2020s. Default shape for 50 songs: 6 / 10 / 22 / 12, scaled to any length.
- Picker rules live in the database; do not reimplement them:
  - Least recently HEARD first, and songs not heard since the last serving carry over.
  - The artist cap is ceil(count/25). An artist heard in the last 2 days gets no NEW songs unless they are needed to fill.
  - Thumbs-down songs are never picked.
  - Familiar means heard on 5 or more days, or thumbs up; every 1980s-and-earlier song counts as familiar. NEW songs are at most 25% of a list (12 of 50).
  - A familiar song may break the 2-day artist cooldown rather than lose its slot to a new song. It never breaks the per-list artist cap.
  - A familiar song heard in the last 7 days waits, and a new song takes its slot.
  - Every slice, and the new songs, are spread evenly through the list.
- Alfred server limit: 60 calls per 5 minutes. Pace big jobs; on CALL BUDGET EXCEEDED wait 300 s; any other guardrail error means stop and tell Alex.
- All Alfred tool calls have an 8-second database limit. `get_drive_mix_simulation` refuses days x count > 6,000.

## Tools

Alfred: `get_drive_mix_songs`, `create_drive_mix_songs`, `update_drive_mix_songs`, `update_drive_mix_artist` (tier 3), `update_drive_mix_thumbs`, `get_drive_mix_pick`, `get_drive_mix_simulation`, `create_drive_mix_serving`, `create_drive_mix_sweep`.
Workshop (Surface): `get_dj_artist_top_songs`, `search_dj_music`, `get_dj_album`, `replace_dj_playlist`.

## Adding an artist ("add R.E.M. to Drive Mix")

Alex wants the songs he KNOWS, and play counts cannot predict which those are. For Madonna he chose Take a Bow, Ray of Light and Express Yourself, all below the bar. For Billy Joel he rejected Honesty and Vienna, his #4 and #5 by plays. So Alex picks every song; nothing is added without his pick.

1. Call `get_dj_artist_top_songs` with the artist name and **limit 60** (time_budget_seconds 45). If it returns candidates instead of songs, pick the channel with by far the most subscribers and recognisable top songs. If none clearly fits, ask Alex. (Garth Brooks is not on YouTube Music.)
2. Check what is already in the pool: `get_drive_mix_songs` with `artist` set to the lower-cased artist_key (e.g. `r.e.m.`), any status, limit 50. Compare by title, ignoring case, bracketed text, " - " suffixes and feat. credits.
3. Show Alex ONE ranked list, by plays: every `suggested` song, then about the next 10 below the bar. Each line gives the title, the plays (e.g. 89M) and the mark **suggested** or **below bar**. Leave out songs already in the pool, and give their count in one line. Flag:
   - Christmas or holiday songs: recommend dropping.
   - Guest spots (`guest: true`): list them below the bar. A big one, over about 500M (e.g. Coldplay's "Something Just Like This"), is worth asking about.
   - Re-recordings and live versions when no original exists (Bryan Adams' "Classic Version"s): fine to add.
   - Heavy or out-of-place songs for a morning drive: ask.
4. Add only the songs Alex picks: `create_drive_mix_songs` with source `artist_top`, every song with decade and genre so it lands active. Decade is the song's ORIGINAL release decade, re-recordings and remasters included; a genuine cover by another artist gets the cover's decade. Genre comes from the list below.
5. Confirm in one line: how many were added, and the slices they went to. New songs start as NEW: they arrive gradually (at most 25% of a list) and become familiar after 5 play days. To make one familiar at once, record a thumbs up.

**Several artists at once** (more than about three): do not do it in chat. Create a one-off scheduled task that only READS and posts a review list to the Alfred inbox (per artist: to add, already in pool, left out, flags). After Alex approves, create a second one-off task that adds the approved songs. Tell Alex he will get a notification.

## Adding a single song or an album

Use `search_dj_music` (songs) and take the original studio recording by the right artist; for a soundtrack, find the album and read it with `get_dj_album`, skipping spoken-word tracks. Add with decade and genre as above.

## Cutting

- **A song** ("cut Careless Whisper"): find it with `get_drive_mix_songs`, then `update_drive_mix_songs` with status `retired` and retired_reason `cut by Alex`. No confirmation needed; say it is reversible.
- **An artist** ("cut Luther Vandross"): `update_drive_mix_artist` with action retire and retired_reason `cut by Alex artist`. It returns a proposal listing the songs; show it, then confirm. The daily refresh retires any new song by an artist cut this way, so they stay out.
- **Trim an artist to a few songs** ("just keep Enter Sandman and Nothing Else Matters"): retire the rest individually with `cut by Alex`; the artist itself stays allowed.
- Undo: set status back to `active` (decade and genre are kept).

## Thumbs ("thumbs down Careless Whisper", "I like this one", or thumbs read from YouTube)

Use `update_drive_mix_thumbs` with `{video_id, thumbs, at}`; `at` is when the thumb was given, or omit it for now. The latest thumb wins.
- **down:** the song is never picked again until a later thumbs up. Its status does not change, so do NOT also retire it.
- **up:** the song always counts as familiar. If it was retired as `cut by Alex` or `cut by Alex (not known)`, the up brings it back. It never revives a song retired as jazz, ambient or sleep, holiday or soundtrack, classical or kids or novelty; to bring one of those back, ask Alex and use `update_drive_mix_songs`.
- **clear:** removes the thumb.
- Find the video_id with `get_drive_mix_songs`. `thumbs: "down"` lists every thumbed-down song.

## "Too much X" / "more X"

This is a lasting change, so change the POOL, not today's list. How often an artist plays depends on how many of their songs are active.
- **Too much X:** show Alex X's active songs (`get_drive_mix_songs`, artist X), and offer to retire the ones he knows least, with `cut by Alex`. Suggest keeping his favourites. Never change the cap or the cooldown.
- **More X:** add songs, as in "Adding an artist" (limit 60, and he picks). Or reactivate songs he cut before.
- Say how many of X's songs are active before and after, and that each one comes round about every (slice size / slice share) days.

## One-day overrides ("8 hours of music", "more Madonna today", "no country today")

Claude may rebuild or hand-edit TODAY's playlist outside the picker's rules. An override changes only today, and it is **never recorded as a serving**: do not call `create_drive_mix_serving`. The next morning's refresh goes back to the rules and carries over from the last real serving.
- **Longer or shorter** ("8 hours", "10 hours for the road trip"): songs = hours x 17, capped at 200 (about 11.5 hours). Call `get_drive_mix_pick` with today's UTC date and that `count`, and use its video_ids in order.
- **More of an artist today** ("more Madonna today"): start from `get_drive_mix_pick` for today. Add or swap in a few of the artist's active pool songs, spaced through the list and never two in a row.
- **Less, or none, of something today** ("no country today", "no Taylor Swift today"): start from today's pick, remove the matching songs (slice `country_rap`, or the artist), and fill the gaps from a larger pick (e.g. count 80), skipping the excluded ones.
- **Hand edits** ("take out the second song", "put Africa first"): edit the list directly.
- Thumbs-down songs stay out of overrides too.
- Then `replace_dj_playlist` on `PLbtyzvGuByeU` with the final video_ids in order. Check that the proposal names "Drive Mix", then confirm.
- Tell Alex it is ready, and that tomorrow's refresh returns to the normal 50 by the rules. If he wants a change to last, that is "too much X / more X" above.

## Refresh now

Same as the daily task: sweep, tag pending songs (rules below), `get_drive_mix_pick` for today, `replace_dj_playlist`, then record the serving if today has none. This is a by-the-rules refresh, not an override.

## Tagging rules (sweep and manual adds)

Activate with decade and genre anything that is a normal song by a pop, rock, alternative, country, rap, R&B or dance artist, including deep cuts, live and acoustic versions. Never retire a song for being obscure or for its genre.
- Genres: pop, rock, alternative, country, rap, rnb, dance, other. 90s/2000s guitar bands = alternative; classic rock = rock; Sinatra, Fitzgerald, Armstrong, Holiday and Lady Gaga's standards = pop; Motown/soul and The Commitments = rnb; Tim McGraw, Jelly Roll, Kenny Chesney = country; Snoop Dogg, Dr. Dre, Cardi B = rap.
- Retire with these exact reasons: `jazz` (INSTRUMENTAL jazz only; vocal standards singers stay), `ambient or sleep` (instrumental mood music), `classical`, `holiday or soundtrack` (Christmas music, film scores, cast recordings; songs from films that were radio hits stay), `kids or novelty`, `not music`, `cut by Alex`, `cut by Alex (not known)`, `cut by Alex artist`. Never retire for a thumbs down; record the thumb instead.

## Questions about the pool

`get_drive_mix_songs` with no filters returns counts by status and slice. Repeat interval for a slice is roughly (songs in slice / daily share) days. For "how would X change things", use `get_drive_mix_simulation` (keep days x count <= 6,000).

## Do not

- Change quotas, the artist cap, the cooldown, new_share or the familiar gap by passing parameters on the daily refresh. Changes to picker rules are a code change through the CLI. A one-day override is the only exception, and it is never recorded as a serving.
- Replace any playlist other than `PLbtyzvGuByeU`.
- Tag songs by guessing they are jazz from an artist's name alone; check the actual song.
