-- 013 - playlist engagement and jazz activity, as SQL functions
--
-- ============================================================================
-- WHY FUNCTIONS AND NOT TOOL CODE
-- ============================================================================
-- Spec §12.9 defines `runs` as "days in the trailing 90 on which at least
-- `threshold` DISTINCT CANONICAL GROUPS from the playlist were played".
--
-- PostgREST cannot express that. It is a per-day COUNT(DISTINCT ...) over a
-- join from membership through canonical grouping into the play log, compared
-- against a threshold derived from the playlist's own size. The alternative was
-- pulling ~17,000 play rows and all membership into the Edge Function and
-- aggregating in JavaScript on every call — which works, is slow, and puts a
-- definition the spec pins in one place into a second implementation.
--
-- ⚠️ security invoker (the default, stated for the reader): RLS is still the
-- gate. These functions see exactly the caller's own rows and hold no
-- privilege of their own. They are computation, not access.
--
-- ============================================================================
-- CANONICAL GROUPS, NOT video_ids — EVERYWHERE
-- ============================================================================
-- dj_tracks.canonical_track_id is null when the row IS canonical, so the group
-- key is coalesce(canonical_track_id, id). Counting by video_id would treat an
-- album cut and its remaster as two songs and inflate every number here.

-- ---------------------------------------------------------------------------
-- dj_playlist_engagement — spec §12.9
-- ---------------------------------------------------------------------------
create or replace function public.dj_playlist_engagement(
  p_playlist_ids uuid[],
  p_window_days  int default 90
)
returns table (
  playlist_id      uuid,
  distinct_groups  int,
  threshold        int,
  window_days      int,
  runs             int,
  last_run_on      date,
  last_touched_on  date
)
language sql
stable
as $$
  with member as (
    -- One row per (playlist, canonical group). Membership may repeat a track
    -- since migration 012, so DISTINCT is load-bearing: Archived Weezer is 160
    -- rows and ~50 songs, and a threshold derived from 160 would be unreachable.
    select distinct pt.playlist_id,
           coalesce(t.canonical_track_id, t.id) as grp
    from public.dj_playlist_tracks pt
    join public.dj_tracks t on t.id = pt.track_id
    where pt.playlist_id = any(p_playlist_ids)
  ),
  sized as (
    select m.playlist_id, count(*)::int as distinct_groups
    from member m group by m.playlist_id
  ),
  thresh as (
    -- clamp(ceil(0.5n), 4, 20). The CAP of 20 is not cosmetic: half of a
    -- 379-track playlist is 190, which is not a threshold but a guarantee of
    -- zero. Twenty distinct songs is about an hour, which is what "half" means
    -- on a 30-track concert playlist — so the metric measures one consistent
    -- idea across playlists spanning 1 to 379 tracks.
    select s.playlist_id, s.distinct_groups,
           greatest(4, least(20, ceil(s.distinct_groups::numeric / 2)::int)) as threshold
    from sized s
  ),
  -- Every group in these playlists, expanded to every variant video that
  -- belongs to it, so a play of ANY variant counts (spec §4.1).
  grp_track as (
    select distinct m.playlist_id, m.grp, t.id as track_id
    from member m
    join public.dj_tracks t on coalesce(t.canonical_track_id, t.id) = m.grp
  ),
  day_hits as (
    select gt.playlist_id, p.played_on,
           count(distinct gt.grp)::int as groups_played
    from grp_track gt
    join public.dj_plays p on p.track_id = gt.track_id
    where p.played_on >= current_date - p_window_days
    group by gt.playlist_id, p.played_on
  )
  select th.playlist_id,
         th.distinct_groups,
         th.threshold,
         p_window_days as window_days,
         coalesce(count(*) filter (where dh.groups_played >= th.threshold), 0)::int as runs,
         max(dh.played_on) filter (where dh.groups_played >= th.threshold) as last_run_on,
         -- last_touched_on is ANY track on any day. Shown only when there has
         -- never been a run: "you've not run it, but three of its songs came up
         -- on 29 August" is useful; a bare "never" on a partly-heard playlist is
         -- wrong in feel and invites a correction.
         max(dh.played_on) as last_touched_on
  from thresh th
  left join day_hits dh on dh.playlist_id = th.playlist_id
  group by th.playlist_id, th.distinct_groups, th.threshold;
$$;

comment on function public.dj_playlist_engagement(uuid[], int) is
  'Spec §12.9. runs = DAYS in the window on which at least `threshold` distinct '
  'canonical groups from the playlist were played; threshold = '
  'clamp(ceil(0.5 * distinct_groups), 4, 20). '
  '⚠️ DAYS, NOT SESSIONS: dj_plays buckets by UTC day and the feed carries one '
  'entry per track per bucket, so two runs in one day are indistinguishable from '
  'one. The unit is days and the name must not imply otherwise. '
  '⚠️ A track in two playlists counts toward both — named, not solved. For '
  'concert playlists the overlap is small; for jazz and discovery it will not be.';

-- ---------------------------------------------------------------------------
-- dj_jazz_activity — the jazz bucket's "what have I been playing"
-- ---------------------------------------------------------------------------
--
-- 🛑 JAZZ IS DEFINED BY PLAYLIST MEMBERSHIP, BECAUSE NOTHING MARKS A TRACK AS
-- JAZZ. dj_tracks has no genre, its `tags` array is unpopulated, and dj_artists
-- (which does have tags) holds 22 concert acts against 1,206 distinct artists in
-- the play history. There is no genre model to query, so the definition is a
-- PROXY and the report must say so — the definition IS part of the finding.
--
-- ⚠️ MEMBERSHIP ALONE WOULD MISS MOST OF IT. Herbie Hancock, Red Garland, Oscar
-- Peterson, Bill Evans, Thelonious Monk and Wes Montgomery are heavy in the
-- Takeout history and largely arrived through PLAYS, not through either jazz
-- playlist — the Oscar Peterson Tokyo set among them. So the rule is:
--
--     a play is jazz if the track is in a jazz playlist,
--     OR its artist is an artist who appears in one.
--
-- That is derived from the playlists rather than guessed, and it catches an
-- Oscar Peterson track played outside them.
--
-- ⚠️ THE ARTIST ARM MATCHES dj_tracks.artist AS AN EXACT STRING, and that is a
-- real limitation rather than a rounding error. "Oscar Peterson Trio" and
-- "Oscar Peterson" are different strings, and §4.1.4's alias map exists because
-- the export and the poll disagree about exactly this. The seeding artist list
-- is returned so the reader can see what the definition actually covered
-- instead of trusting it.
create or replace function public.dj_jazz_activity(
  p_window_days int default 90
)
returns table (
  artist          text,
  distinct_days   int,
  play_rows       int,
  distinct_groups int,
  first_played_on date,
  last_played_on  date,
  in_playlist     boolean
)
language sql
stable
as $$
  with jazz_tracks as (
    select distinct pt.track_id
    from public.dj_playlist_tracks pt
    join public.dj_playlists pl on pl.id = pt.playlist_id
    where pl.kind = 'jazz'
  ),
  jazz_artists as (
    select distinct t.artist
    from jazz_tracks jt
    join public.dj_tracks t on t.id = jt.track_id
    where t.artist is not null and t.artist <> ''
  ),
  in_scope as (
    select t.id, t.artist,
           coalesce(t.canonical_track_id, t.id) as grp,
           (t.id in (select track_id from jazz_tracks)) as in_playlist
    from public.dj_tracks t
    where t.id in (select track_id from jazz_tracks)
       or t.artist in (select artist from jazz_artists)
  )
  select s.artist,
         count(distinct p.played_on)::int as distinct_days,
         count(*)::int                    as play_rows,
         count(distinct s.grp)::int       as distinct_groups,
         min(p.played_on)                 as first_played_on,
         max(p.played_on)                 as last_played_on,
         bool_or(s.in_playlist)           as in_playlist
  from in_scope s
  join public.dj_plays p on p.track_id = s.id
  where p.played_on >= current_date - p_window_days
  group by s.artist
  order by count(distinct p.played_on) desc, s.artist;
$$;

comment on function public.dj_jazz_activity(int) is
  'The jazz bucket''s "what have I been playing". '
  '🛑 JAZZ IS A PROXY, NOT A GENRE: nothing marks a track as jazz — dj_tracks has '
  'no genre column, and dj_artists (which has tags) holds 22 concert acts against '
  '1,206 distinct artists in the history. A play counts as jazz if the track is in '
  'a kind=jazz playlist OR its artist appears in one. Membership alone would miss '
  'most of it, since the heavily-played pianists arrived through plays rather than '
  'playlists. '
  '⚠️ The artist arm is an EXACT STRING match on dj_tracks.artist, so "Oscar '
  'Peterson Trio" and "Oscar Peterson" do not unify — see spec §4.1.4. Report the '
  'definition alongside the numbers; the definition is part of the finding.';

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
  ff uuid;
  eng record;
  jazz_rows int;
begin
  -- ⚠️ NOT "the function exists". Calling it and checking the SHAPE of the answer
  -- is the only thing that distinguishes a working definition from a compiling
  -- one — a query with a wrong join returns rows just as happily (§11.15).
  select id into ff from public.dj_playlists
   where yt_playlist_id = 'PLV2XoCH1Pv5y4eryZrOdxG2XlSxfdW32l';
  if ff is null then
    raise exception 'cannot verify 013: the Foo Fighters playlist is not recorded. '
      'Do NOT mark this done — every check below would pass vacuously.';
  end if;

  select * into eng from public.dj_playlist_engagement(array[ff], 90);
  if eng.playlist_id is null then
    raise exception 'dj_playlist_engagement returned no row for a playlist that exists.';
  end if;
  -- 30 body rows, no duplicates, so groups should be 30 and threshold 15.
  if eng.distinct_groups <> 30 then
    raise exception 'expected 30 distinct groups for Foo Fighters Concert, got %. '
      'The membership join or the canonical grouping is wrong.', eng.distinct_groups;
  end if;
  if eng.threshold <> 15 then
    raise exception 'expected threshold 15 for 30 groups (clamp(ceil(0.5*30),4,20)), got %.',
      eng.threshold;
  end if;
  if eng.runs < 0 or eng.runs > eng.window_days then
    raise exception 'runs=% is impossible in a %-day window.', eng.runs, eng.window_days;
  end if;
  -- last_run_on must be null exactly when runs is 0. A date with no runs, or
  -- runs with no date, means the filtered aggregates disagree with each other.
  if (eng.runs = 0) <> (eng.last_run_on is null) then
    raise exception 'runs=% but last_run_on=% — the two aggregates disagree.',
      eng.runs, eng.last_run_on;
  end if;

  -- The clamp, at both ends, on real playlists rather than in the abstract.
  select count(*) into n
    from public.dj_playlists p,
         lateral public.dj_playlist_engagement(array[p.id], 90) e
   where e.threshold < 4 or e.threshold > 20;
  if n > 0 then
    raise exception '% playlist(s) produced a threshold outside [4,20].', n;
  end if;

  select count(*) into jazz_rows from public.dj_jazz_activity(3650);
  raise notice '013 verified: engagement shape correct on Foo Fighters '
    '(groups=%, threshold=%, runs=%), thresholds clamped on all playlists, '
    'dj_jazz_activity returned % artist row(s) over 10 years.',
    eng.distinct_groups, eng.threshold, eng.runs, jazz_rows;

  if exists (select 1 from platform.conformance_failures) then
    raise exception 'platform.conformance_failures is not empty after this migration.';
  end if;
end $$;

-- Belt and braces, from a tool call rather than SQL:
--   check_platform_conformance   ->  must report CONFORMANT (28 tables)
