-- 025 - coverage for ONE album, so status can be derived at write time
--
-- ============================================================================
-- WHY
-- ============================================================================
-- The first real album recorded — Bewitched, 13 of 13 heard — landed as
-- status='proposed'. That is wrong and it is not a bug in the write: an album
-- Alex finished in August is not an unanswered suggestion.
--
-- 🛑 AND THE SHARPER VERSION: A BOOKMARKED ALBUM WAS NEVER *PROPOSED* AT ALL.
-- `proposed` means the thread put it forward and is waiting for an answer. A
-- bookmark is Alex's own curation — already accepted before anything asked. So
-- seeding the other 21 bookmarks would create 21 rows claiming the thread had
-- asked about albums it has never mentioned, and then it would suggest him
-- records he finished months ago.
--
-- ⚠️ THE TOOL CANNOT COMPUTE COVERAGE BEFORE IT WRITES THE TRACK LIST — coverage
-- is zero until the tracks exist. So the derivation happens AFTER the write, in
-- the same call, and needs to ask about one album rather than scanning them all.
--
-- ⚠️ A PARAMETER RATHER THAN A SECOND FUNCTION. §14.6 records a rule living in
-- two runtimes and drifting; two coverage functions would be the same shape one
-- table over. One definition, filtered.

drop function if exists public.dj_album_coverage(text, text, int);

create or replace function public.dj_album_coverage(
  p_status   text default null,
  p_tag      text default null,
  p_limit    int  default 20,
  -- ADDED 025. When given, the other filters are irrelevant and one row comes
  -- back — the album just written, so its status can be set from what it says.
  p_album_id uuid default null
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
    where (p_album_id is not null and a.id = p_album_id)
       or (p_album_id is null
           and (p_status is null or a.status = p_status)
           and (p_tag is null or a.tags @> array[p_tag]))
  ),
  at_grp as (
    select at.album_id,
           at.position,
           at.video_id,
           coalesce(t.canonical_track_id, t.id) as grp
    from public.dj_album_tracks at
    left join public.dj_tracks t on t.video_id = at.video_id
    where at.video_id is not null
  ),
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
  select pk.id, pk.yt_album_id, pk.title, pk.artist, pk.release_year,
         pk.status, pk.tags, pk.suggested_on, pk.notes,
         -- ⚠️ §14.12's control still applies: these come from a GROUPED
         -- subquery with coalesce, never count(*) over the left join.
         coalesce(s.tracks_total, 0),
         coalesce(s.tracks_playable, 0),
         coalesce(h.tracks_heard, 0),
         h.first_heard_on,
         h.last_heard_on
  from picked pk
  left join sized s on s.album_id = pk.id
  left join heard h on h.album_id = pk.id
  order by pk.status, coalesce(h.last_heard_on, '1900-01-01'::date) desc, pk.title
  limit case when p_album_id is not null then 1 else p_limit end;
$$;

comment on function public.dj_album_coverage(text, text, int, uuid) is
  'Albums with "how much of this have I heard" as a FRACTION. '
  '🛑 REPORT tracks_heard / tracks_playable, NOT a boolean. A boolean needs a '
  'threshold and then a paragraph to read correctly, which §12.12 says means '
  'printing a different number. '
  '⚠️ TWO DENOMINATORS AND THEY DIFFER FOR A REASON. tracks_total is what the '
  'record IS; tracks_playable is what CAN be measured — YouTube gives no videoId '
  'for region-blocked tracks. Counting them caps coverage below 100 per cent '
  'forever; dropping them makes a short album look finished. SAY SO when they '
  'differ. '
  '⚠️ COUNTS CANONICAL GROUPS, so a play of any upload counts — this measures the '
  'MUSIC, not the RECORD. It does NOT answer "have I sat through this album as an '
  'album" and would answer that confidently and wrongly. '
  '⚠️ p_album_id (025) returns ONE album and ignores the other filters. It exists '
  'so record_dj_album can set status from coverage immediately after writing the '
  'track list — coverage is zero until the tracks exist, so the derivation cannot '
  'happen before the write.';

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
do $$
declare
  probe uuid;
  n     int;
  cov   record;
begin
  insert into public.dj_albums (user_id, title, status)
  select user_id, '__coverage_probe_025__', 'proposed'
  from public.dj_playlists limit 1
  returning id into probe;

  -- 1. p_album_id returns exactly that album, ignoring a status filter that
  --    would otherwise exclude it. If the filters were ANDed instead of ORed,
  --    the derivation would silently get no row and status would never be set.
  select count(*) into n
  from public.dj_album_coverage('known', 'canon', 20, probe);
  if n <> 1 then
    raise exception
      'p_album_id returned % row(s) with conflicting filters; expected 1. The '
      'filters must be bypassed, not ANDed — otherwise record_dj_album gets no '
      'row back and quietly leaves the status alone.', n;
  end if;

  -- 2. §14.12 control, still: an album with no tracks reads 0/0, not 1/1.
  select * into cov from public.dj_album_coverage(null, null, 20, probe);
  if cov.tracks_total <> 0 or cov.tracks_playable <> 0 or cov.tracks_heard <> 0 then
    raise exception
      'An album with no tracks reads %/%/% instead of 0/0/0 — count(*) over a '
      'LEFT JOIN is back (§14.12).',
      cov.tracks_total, cov.tracks_playable, cov.tracks_heard;
  end if;

  -- 3. The unfiltered form still works and did not lose the probe.
  select count(*) into n from public.dj_album_coverage(null, null, 500);
  if n < 1 then
    raise exception 'The unfiltered form returned no rows while an album exists.';
  end if;

  delete from public.dj_albums where id = probe;
  raise notice 'p_album_id bypasses filters; empty-album control holds.';
end $$;

-- ---------------------------------------------------------------------------
-- Then, per platform house rules, finish the block with:
--   check_platform_conformance()
-- EXPECT: CONFORMANT. Functions only.
-- ---------------------------------------------------------------------------
