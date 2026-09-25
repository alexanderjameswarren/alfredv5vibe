-- 071 - READ-ONLY DIAGNOSTIC. Nothing here changes data.
--
-- MOVED HEADER: this is a verification query, not a schema change and not a
-- backfill. It is never "applied". Run it, read it, and it is done.
--
-- PURPOSE. Preview exactly which rows migration 072 would change, BEFORE
-- running 072. Six videos from the 2026-09-22 sync are stored under the
-- compilation billing "Various Artists" while the poll submits the players:
-- "Charlie Parker, Dizzy Gillespie, Bud Powell, Max Roach".
--
-- WHAT TO CHECK IN THE RESULT
--   - `would_change` must be exactly 6. Fewer means a video_id is unknown or
--     already repaired; more is impossible (the list is enumerated).
--   - `artist` must read 'Various Artists' on all six. Any other value means
--     something already edited the row and 072's rollback comment is stale.
--   - `match_key` is shown but 072 DOES NOT TOUCH IT. Grouping is unchanged by
--     that migration, deliberately - re-keying is the separate 4.1.2 backfill
--     question and is not decided here.
--   - `other_various_artists_rows` is the wider blast radius: every OTHER track
--     still billed to a placeholder. 072 repairs only the six; this says how
--     many it leaves, so the number is a decision rather than a surprise.
--   - `placeholder_scan` confirms which placeholder spellings actually occur.
--     PLACEHOLDER_ARTISTS in dj-normalise.ts was seeded from "Various Artists"
--     plus the obvious equivalents; if this returns a spelling that is NOT in
--     that list, the list is short and should be extended.

select json_build_object(
  'would_change', (select coalesce(json_agg(t), '[]'::json) from (
    select video_id, title, artist, match_key, created_at
    from dj_tracks
    where video_id in ('onvLuR7E5sM','eapPwd8v5Xg','5TvNzAe3oGo',
                       'Pkn2rDQx0Ok','GbEM3eJ5Isk','dUt4eBkHWkY')
    order by video_id
  ) t),
  'would_change_count', (select coalesce(json_agg(t), '[]'::json) from (
    select count(*) as n
    from dj_tracks
    where video_id in ('onvLuR7E5sM','eapPwd8v5Xg','5TvNzAe3oGo',
                       'Pkn2rDQx0Ok','GbEM3eJ5Isk','dUt4eBkHWkY')
      and artist = 'Various Artists'
  ) t),
  'other_various_artists_rows', (select coalesce(json_agg(t), '[]'::json) from (
    select video_id, title, artist, match_key
    from dj_tracks
    where artist ilike 'various artists'
      and video_id not in ('onvLuR7E5sM','eapPwd8v5Xg','5TvNzAe3oGo',
                           'Pkn2rDQx0Ok','GbEM3eJ5Isk','dUt4eBkHWkY')
    order by title
    limit 100
  ) t),
  'placeholder_scan', (select coalesce(json_agg(t), '[]'::json) from (
    select artist, count(*) as tracks
    from dj_tracks
    where artist is not null
      and lower(btrim(split_part(artist, ',', 1))) in
          ('various artists','various','va','unknown artist','unknown','no artist')
    group by artist
    order by count(*) desc
  ) t)
) as result;
