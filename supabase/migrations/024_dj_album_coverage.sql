-- 024 - "have I heard this album", as a fraction
--
-- ============================================================================
-- 🛑 A FRACTION, NEVER A BOOLEAN
-- ============================================================================
-- Albums are 8-12 tracks and three of them may have been heard. A boolean has
-- to pick a threshold, and then it needs a paragraph to be read correctly —
-- which §12.12 says means printing a different number. "You've heard 3 of 9"
-- needs no caveat. "unheard: false" needs an essay.
--
-- ⚠️ THE ARITHMETIC IS IN SQL FOR THE SAME REASON ENGAGEMENT'S IS. A second
-- implementation in the Edge Function would agree with this one until one of
-- them changed, and §14.6 records what that costs.
--
-- ============================================================================
-- ⚠️ CANONICAL GROUPS, NOT video_ids — "HAVE I HEARD THIS MUSIC", NOT "HAVE I
--    PLAYED THIS UPLOAD"
-- ============================================================================
-- DECIDED 2026-09-08. A play of ANY upload of a track counts toward hearing the
-- album. §4.1 exists because one song has many video ids, and an album's own
-- copy is just one of them — hearing Goodbye Pork Pie Hat on a compilation is
-- still hearing it.
--
-- ⚠️ THE COST, NAMED: this measures the MUSIC, not the RECORD. Someone who
-- wanted "have I sat through this album as an album" would need a different
-- query, and this one would answer confidently and wrongly. Stated here because
-- the two questions are one word apart in English.
--
-- ============================================================================
-- ⚠️ TWO DENOMINATORS, BECAUSE ONE OF THEM IS PARTLY UNMEASURABLE
-- ============================================================================
-- YouTube omits videoId for tracks unavailable in the region. Such a track is
-- REAL — it is on the album, it lengthens the record — but it can never match a
-- play, so counting it in the denominator caps coverage below 100% forever, and
-- dropping it makes a short album look fully heard.
--
--   tracks_total     every track on the album. What the record IS.
--   tracks_playable  those with a video_id. What CAN be measured.
--
-- 🛑 REPORT COVERAGE OVER tracks_playable AND SAY SO WHEN THE TWO DIFFER. An
-- album reading 7/7 with tracks_total 9 has two tracks nobody can check, and a
-- reader told only "7 of 7" would believe the album was finished.

create or replace function public.dj_album_coverage(
  p_status text default null,
  p_tag    text default null,
  p_limit  int  default 20
)
returns table (
  album_id        uuid,
  yt_album_id     text,
  title           text,
  artist          text,
  release_year    smallint,
  status          text,
  tags            text[],
  suggested_on    date,
  notes           text,
  tracks_total    int,
  tracks_playable int,
  tracks_heard    int,
  first_heard_on  date,
  last_heard_on   date
)
language sql
stable
as $$
  with picked as (
    select a.*
    from public.dj_albums a
    where (p_status is null or a.status = p_status)
      and (p_tag is null or a.tags @> array[p_tag])
  ),
  -- One row per album track that CAN be matched, carrying its canonical group.
  -- ⚠️ LEFT JOIN: a track whose video_id is unknown to dj_tracks has simply
  -- never been played, which is a real zero rather than a missing row.
  at_grp as (
    select at.album_id,
           at.position,
           at.video_id,
           coalesce(t.canonical_track_id, t.id) as grp
    from public.dj_album_tracks at
    left join public.dj_tracks t on t.video_id = at.video_id
    where at.video_id is not null
  ),
  -- Every track belonging to those groups, so a play of ANY upload counts.
  grp_track as (
    select distinct g.album_id, g.grp, t2.id as track_id
    from at_grp g
    join public.dj_tracks t2
      on coalesce(t2.canonical_track_id, t2.id) = g.grp
    where g.grp is not null
  ),
  heard as (
    select gt.album_id,
           count(distinct gt.grp)::int as tracks_heard,
           min(p.played_on) as first_heard_on,
           max(p.played_on) as last_heard_on
    from grp_track gt
    join public.dj_plays p on p.track_id = gt.track_id
    group by gt.album_id
  ),
  sized as (
    select at.album_id,
           count(*)::int as tracks_total,
           count(at.video_id)::int as tracks_playable
    from public.dj_album_tracks at
    group by at.album_id
  )
  select pk.id,
         pk.yt_album_id,
         pk.title,
         pk.artist,
         pk.release_year,
         pk.status,
         pk.tags,
         pk.suggested_on,
         pk.notes,
         -- ⚠️ count(*) OVER A LEFT JOIN COUNTS THE SYNTHESISED ROW — that was
         -- §14.12, and it cost a fortnight. These come from a GROUPED subquery
         -- with coalesce, so an album with no track list reads 0 and not 1.
         coalesce(s.tracks_total, 0),
         coalesce(s.tracks_playable, 0),
         coalesce(h.tracks_heard, 0),
         h.first_heard_on,
         h.last_heard_on
  from picked pk
  left join sized s on s.album_id = pk.id
  left join heard h on h.album_id = pk.id
  order by pk.status, coalesce(h.last_heard_on, '1900-01-01'::date) desc, pk.title
  limit p_limit;
$$;

comment on function public.dj_album_coverage(text, text, int) is
  'Albums with "how much of this have I heard" as a FRACTION. '
  '🛑 REPORT tracks_heard / tracks_playable, NOT a boolean. Albums are 8-12 '
  'tracks and three may have been heard; a boolean needs a threshold and then a '
  'paragraph to read correctly, which §12.12 says means printing a different '
  'number. '
  '⚠️ TWO DENOMINATORS AND THEY DIFFER FOR A REASON. tracks_total is what the '
  'record IS; tracks_playable is what CAN be measured. YouTube omits videoId for '
  'region-blocked tracks — real tracks that can never match a play. Counting '
  'them caps coverage below 100 per cent forever; dropping them makes a short album '
  'look finished. SAY SO when the two differ. '
  '⚠️ COUNTS CANONICAL GROUPS, so a play of any upload counts — this measures '
  'the MUSIC, not the RECORD. It does NOT answer "have I sat through this album '
  'as an album", and would answer that confidently and wrongly. '
  '⚠️ tracks_heard counts tracks with at least one play, EVER — there is no '
  'window, because "have I heard this" is not a recency question.';

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
do $$
declare
  n   int;
  bad int;
begin
  -- 1. It answers at all. dj_albums is empty at this point, so zero rows is
  --    the expected shape and not evidence of a broken join — assert the CALL
  --    rather than the count.
  select count(*) into n from public.dj_album_coverage(null, null, 500);
  raise notice 'dj_album_coverage returns % row(s) (0 expected until albums exist).', n;

  -- 2. 🛑 THE §14.12 CONTROL, APPLIED BEFORE IT CAN BITE. An album with NO
  --    track list must read 0/0, not 1/1. That defect took a fortnight to find
  --    last time because count(*) over a LEFT JOIN counts the synthesised row,
  --    and this function has two left joins.
  insert into public.dj_albums (user_id, title, status)
  select user_id, '__coverage_probe__', 'proposed'
  from public.dj_playlists limit 1;

  select count(*) into bad
  from public.dj_album_coverage(null, null, 500)
  where title = '__coverage_probe__'
    and (tracks_total <> 0 or tracks_playable <> 0 or tracks_heard <> 0);

  if bad <> 0 then
    raise exception
      'An album with no tracks does not read 0/0. count(*) over a LEFT JOIN '
      'counts the synthesised null row — that is §14.12, and it is back.';
  end if;

  delete from public.dj_albums where title = '__coverage_probe__';
  raise notice 'Empty-album control passed: 0 tracks reads 0, not 1.';
end $$;

-- ---------------------------------------------------------------------------
-- Then, per platform house rules, finish the block with:
--   check_platform_conformance()
-- EXPECT: CONFORMANT. Functions only; no tables created or altered.
-- ---------------------------------------------------------------------------
