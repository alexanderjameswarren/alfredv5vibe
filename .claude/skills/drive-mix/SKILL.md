---
name: drive-mix
description: Manage Alex's Drive Mix car playlist: add artists or songs, cut songs or artists, make a road-trip-length mix, refresh it now, or answer questions about the pool.
---

# Drive Mix

Drive Mix is Alex's default car playlist: familiar pop, rock, alternative, a little country and rap, songs he knows or heard on the radio. A daily scheduled task ("Drive Mix daily refresh", 4:54 am Pacific) rebuilds it every morning from a song pool in Supabase. This skill covers everything Alex asks for in chat.

## Key facts

- YouTube playlist: **Drive Mix**, id `PLbtyzvGuByeU`, PRIVATE, recorded in DJ as kind `utility`. It is disposable: overwritten with `replace_dj_playlist`, never emptied.
- Pool table `drive_mix_songs` (status pending / active / retired; decade; genre; artist_key). Only `active` songs are picked.
- Slices: country_rap (genre country or rap, any decade), 1980s-and-earlier, 1990s-2000s, 2010s-2020s. Default shape for 50 songs: 6 / 10 / 22 / 12, scaled to any length.
- Picker rules (in the database, do not reimplement): least recently HEARD first; songs not heard since the last serving carry over; artist cap ceil(count/25); an artist heard in the last 2 days gets no NEW songs unless needed to fill.
- Alfred server limit: 60 calls per 5 minutes. Pace big jobs; on CALL BUDGET EXCEEDED wait 300 s; any other guardrail error means stop and tell Alex.
- All Alfred tool calls have an 8-second database limit. `get_drive_mix_simulation` refuses days x count > 6,000.

## Tools

Alfred: `get_drive_mix_songs`, `create_drive_mix_songs`, `update_drive_mix_songs`, `update_drive_mix_artist` (tier 3), `get_drive_mix_pick`, `get_drive_mix_simulation`, `create_drive_mix_serving`, `create_drive_mix_sweep`.
Workshop (Surface): `get_dj_artist_top_songs`, `search_dj_music`, `get_dj_album`, `replace_dj_playlist`.

## Adding an artist ("add R.E.M. to Drive Mix")

Alex wants an artist's real hits, by popularity, not deep cuts and not a fixed number.

1. Call `get_dj_artist_top_songs` with the artist name. If it returns candidates instead of songs, pick the channel with by far the most subscribers and recognisable top songs; if none clearly fits, ask Alex. (Garth Brooks is not on YouTube Music.)
2. Check what is already in the pool: `get_drive_mix_songs` with `artist` set to the lower-cased artist_key (e.g. `r.e.m.`), any status, limit 50. Compare by title ignoring case, bracketed text, " - " suffixes and feat. credits.
3. Show Alex a short list: **To add** (suggested songs not already in the pool, with plays), **Already in the pool** (count), **Left out** (the next few by plays, and any guest appearances). Flag:
   - Christmas or holiday songs: recommend dropping.
   - Big guest hits (the artist is featured, over about 500M plays, e.g. Coldplay's "Something Just Like This"): recommend adding as exceptions.
   - Re-recordings and live versions when no original exists (Bryan Adams' "Classic Version"s): fine to add.
   - Heavy or out-of-place songs for a morning drive: ask.
4. On approval, `create_drive_mix_songs` with source `artist_top`, every song with decade and genre so it lands active. Decade = the song's ORIGINAL release decade (re-recordings and remasters too; a genuine cover by another artist gets the cover's decade). Genre from the list below.
5. Confirm in one line: how many added, and the slice they went to.

**Several artists at once** (more than about three): do not do it in chat. Create a one-off scheduled task that only READS and posts a review list to the Alfred inbox (per artist: to add, already in pool, left out, flags). After Alex approves, create a second one-off task that adds the approved songs. Tell Alex he will get a notification.

## Adding a single song or an album

Use `search_dj_music` (songs) and take the original studio recording by the right artist; for a soundtrack, find the album and read it with `get_dj_album`, skipping spoken-word tracks. Add with decade and genre as above.

## Cutting

- **A song** ("cut Careless Whisper"): find it with `get_drive_mix_songs`, then `update_drive_mix_songs` with status `retired` and retired_reason `cut by Alex`. No confirmation needed; say it is reversible.
- **An artist** ("cut Luther Vandross"): `update_drive_mix_artist` with action retire and retired_reason `cut by Alex artist`. It returns a proposal listing the songs; show it, then confirm. The daily refresh retires any new song by an artist cut this way, so they stay out.
- **Trim an artist to a few songs** ("just keep Enter Sandman and Nothing Else Matters"): retire the rest individually with `cut by Alex`; the artist itself stays allowed.
- Undo: set status back to `active` (decade and genre are kept).

## Road trip or a longer mix ("give me 10 hours of Drive Mix")

1. Songs = hours x 17, capped at 200 (about 11.5 hours).
2. `get_drive_mix_pick` with today's UTC date and that `count`.
3. `replace_dj_playlist` on `PLbtyzvGuByeU` with the returned video_ids in order; check the proposal names "Drive Mix", then confirm.
4. `create_drive_mix_serving` for today only if today has no serving yet; if it refuses because one exists, that is fine, say nothing about it.
5. Tell Alex the mix is ready and that the next morning's refresh returns it to 50, carrying over what he did not reach.

## Refresh now

Same as the daily task: sweep, tag pending songs (rules below), `get_drive_mix_pick` for today, `replace_dj_playlist`, then record the serving if today has none.

## Tagging rules (sweep and manual adds)

Activate with decade and genre anything that is a normal song by a pop, rock, alternative, country, rap, R&B or dance artist, including deep cuts, live and acoustic versions. Never retire a song for being obscure or for its genre.
- Genres: pop, rock, alternative, country, rap, rnb, dance, other. 90s/2000s guitar bands = alternative; classic rock = rock; Sinatra, Fitzgerald, Armstrong, Holiday and Lady Gaga's standards = pop; Motown/soul and The Commitments = rnb; Tim McGraw, Jelly Roll, Kenny Chesney = country; Snoop Dogg, Dr. Dre, Cardi B = rap.
- Retire with these exact reasons: `jazz` (INSTRUMENTAL jazz only; vocal standards singers stay), `ambient or sleep` (instrumental mood music), `classical`, `holiday or soundtrack` (Christmas music, film scores, cast recordings; songs from films that were radio hits stay), `kids or novelty`, `not music`, `cut by Alex`, `cut by Alex artist`.

## Questions about the pool

`get_drive_mix_songs` with no filters returns counts by status and slice. Repeat interval for a slice is roughly (songs in slice / daily share) days. For "how would X change things", use `get_drive_mix_simulation` (keep days x count <= 6,000).

## Do not

- Change quotas, the artist cap or cooldown defaults by passing parameters on the daily refresh. Changes to picker rules are a code change through the CLI.
- Replace any playlist other than `PLbtyzvGuByeU`.
- Tag songs by guessing they are jazz from an artist's name alone; check the actual song.
