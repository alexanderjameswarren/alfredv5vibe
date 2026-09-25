-- 076 - READ-ONLY DUMP, part 2 of 2 (neighbours). Nothing here changes data.
--
-- MOVED HEADER: verification/extraction query. Never "applied".
--
-- Run 075 first. This returns every OTHER row that shares a title-half with a
-- candidate — the complete set of rows a re-key could merge with, and of rows
-- left behind in a group a candidate vacates. A re-key only ever changes the
-- primary half of the key, so "same title-half" is the exact boundary.
--
-- ⚠️ WITHOUT THIS, MERGES ARE INVISIBLE. The generator decides group leaders
-- from candidates AND neighbours together; given only candidates it would
-- rebuild a group around a row it cannot see. Both parts or neither.
--
-- Same compact format as 075.

with candidates as (
  select t.id, t.video_id, t.match_key
  from public.dj_tracks t
  where t.match_key is not null
    and (
      exists (select 1 from public.dj_album_tracks a where a.video_id = t.video_id)
      or t.video_id in ('onvLuR7E5sM','eapPwd8v5Xg','5TvNzAe3oGo',
                        'Pkn2rDQx0Ok','GbEM3eJ5Isk','dUt4eBkHWkY')
    )
    and (t.artist like '%,%'
         or t.video_id in ('onvLuR7E5sM','eapPwd8v5Xg','5TvNzAe3oGo',
                           'Pkn2rDQx0Ok','GbEM3eJ5Isk','dUt4eBkHWkY'))
),
titles as (select distinct split_part(match_key, '|', 2) as t from candidates),
neighbours as (
  select n.video_id, n.title, n.artist, n.match_key, n.created_at
  from public.dj_tracks n
  where n.match_key is not null
    and split_part(n.match_key, '|', 2) in (select t from titles)
    and n.id not in (select id from candidates)
)
select json_build_object(
  'part', 'neighbours',
  'format', 'compact-v1: [video_id, title, artist, match_key, created_epoch]',
  'count', (select count(*) from neighbours),
  'rows', (select coalesce(json_agg(r), '[]'::json) from (
    select json_build_array(video_id, title, artist, match_key,
                            extract(epoch from created_at)) as r
    from neighbours order by match_key, video_id
  ) x)
) as result;
