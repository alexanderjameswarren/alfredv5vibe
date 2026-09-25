-- 075 - READ-ONLY DUMP, part 1 of 2 (candidates). Nothing here changes data.
--
-- MOVED HEADER: verification/extraction query. Never "applied".
--
-- 🛑 WHY THIS REPLACES 074. 074's output was 153 candidates + 71 neighbours as
-- pretty-printed JSON OBJECTS, and it BLEW THE PASTE LIMIT - the tail of the
-- candidates and the whole of `neighbours` never arrived. A truncated dump that
-- LOOKS complete is the worst input a backfill can have, so this fixes the
-- cause rather than asking for a bigger paste:
--
--   1. COMPACT ROWS. Arrays, not objects: [video_id, title, artist, match_key,
--      created_epoch]. Same data, roughly a fifth of the characters.
--   2. NARROWED TO WHAT IS ACTUALLY IN SCOPE. 074 dumped every comma byline;
--      the generator then DISCARDED every row the album path did not write.
--      This joins dj_album_tracks up front, which is the same rule applied
--      earlier. Purely structural - still no normalisation in SQL.
--   3. SPLIT IN TWO. Neighbours are 076. Two small pastes beat one that fails.
--
-- created_epoch is `extract(epoch from created_at)`: same ordering, a third of
-- the characters. It is used ONLY to pick the earliest-created group leader.
--
-- WHAT TO DO: run it, paste the single result cell back. Then run 076.

with candidates as (
  select t.id, t.video_id, t.title, t.artist, t.match_key, t.created_at
  from public.dj_tracks t
  where t.match_key is not null
    and (
      -- The album path wrote it. This is the defect's actual footprint.
      exists (select 1 from public.dj_album_tracks a where a.video_id = t.video_id)
      -- ...plus the six 072 repaired, which no album wrote.
      or t.video_id in ('onvLuR7E5sM','eapPwd8v5Xg','5TvNzAe3oGo',
                        'Pkn2rDQx0Ok','GbEM3eJ5Isk','dUt4eBkHWkY')
    )
    and (t.artist like '%,%'
         or t.video_id in ('onvLuR7E5sM','eapPwd8v5Xg','5TvNzAe3oGo',
                           'Pkn2rDQx0Ok','GbEM3eJ5Isk','dUt4eBkHWkY'))
)
select json_build_object(
  'part', 'candidates',
  'format', 'compact-v1: [video_id, title, artist, match_key, created_epoch]',
  -- ⚠️ THE GENERATOR REFUSES TO RUN IF THIS DISAGREES WITH THE ROW COUNT IT
  -- RECEIVES. That is the guard against exactly what went wrong with 074.
  'count', (select count(*) from candidates),
  'rows', (select coalesce(json_agg(r), '[]'::json) from (
    select json_build_array(video_id, title, artist, match_key,
                            extract(epoch from created_at)) as r
    from candidates order by match_key, video_id
  ) x)
) as result;
