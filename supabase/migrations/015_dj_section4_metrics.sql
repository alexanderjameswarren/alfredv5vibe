-- 015 - Section 4's metrics: touch days, gone-quiet as a CHANGE, and an artist rollup
--
-- ============================================================================
-- WHY `runs` WAS NEVER GOING TO WORK HERE
-- ============================================================================
-- The 2026-09-02 review run reported `runs: 0` for NINETEEN consecutive
-- non-concert playlists. That reads as a broken report, and it is not: `runs`
-- answers "have I learned this SET" — a threshold over the whole playlist,
-- built for concert prep (spec §12.9). Fourteen of those nineteen hit the
-- threshold cap of 20, so the question being asked was "did you play twenty
-- distinct songs off Yoga in one day", and the answer is always no.
--
-- ⚠️ SECTION 4 ASKS A DIFFERENT QUESTION: "is this still in rotation". For that,
-- "any track played" is exactly right — and §12.9 rejected it for reasons that
-- only ever applied to concert playlists (Everlong is in the Foo Fighters
-- playlist AND in general rotation, so one stray play would mark it as
-- listened). A utility playlist has no such confusion to guard against.
--
-- So `runs` is UNCHANGED and stays the concert metric. This migration adds the
-- rotation metric alongside it. Two numbers, two questions, both stated.
--
-- ============================================================================
-- ⚠️ THE RETURN TYPE CHANGES, SO THE FUNCTION IS DROPPED FIRST
-- ============================================================================
-- `create or replace function` cannot alter a function's return type. Dropping
-- and recreating is the only route, and it is safe here because the function
-- holds no state and nothing depends on it but the Edge Function that calls it.
--
-- ⚠️ security invoker (the default, stated for the reader): RLS is still the
-- gate. These functions see the caller's own rows and hold no privilege.

-- ---------------------------------------------------------------------------
-- dj_playlist_engagement - now carrying rotation as well as runs
-- ---------------------------------------------------------------------------
drop function if exists public.dj_playlist_engagement(uuid[], int);

create or replace function public.dj_playlist_engagement(
  p_playlist_ids uuid[],
  p_window_days  int default 90,
  -- The "recent" half of the warm-then-cold comparison. See went_quiet below.
  p_recent_days  int default 30
)
returns table (
  playlist_id           uuid,
  distinct_groups       int,
  threshold             int,
  window_days           int,
  recent_days           int,
  runs                  int,
  last_run_on           date,
  last_touched_on       date,
  -- ADDED 015: the rotation metric. Days in the window on which AT LEAST ONE
  -- track from the playlist was played. No threshold, deliberately.
  touch_days            int,
  touch_days_recent     int,
  touch_days_prior      int,
  went_quiet            boolean
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
         p_recent_days as recent_days,
         coalesce(count(*) filter (where dh.groups_played >= th.threshold), 0)::int as runs,
         max(dh.played_on) filter (where dh.groups_played >= th.threshold) as last_run_on,
         -- ⚠️ CHANGED 015: returned ALWAYS, not only when runs is 0. The old
         -- rule ("show it instead of a bare never") was written for Section 2,
         -- where a run is the headline. Section 4 has no runs to speak of and
         -- this is its primary signal — nulling it on the playlists that DO get
         -- run would hide rotation exactly where rotation is highest.
         max(dh.played_on) as last_touched_on,
         -- Rotation: days with ANY track, no threshold at all.
         coalesce(count(*), 0)::int as touch_days,
         coalesce(count(*) filter (
           where dh.played_on >= current_date - p_recent_days), 0)::int as touch_days_recent,
         coalesce(count(*) filter (
           where dh.played_on <  current_date - p_recent_days), 0)::int as touch_days_prior,
         -- 🛑 GONE QUIET IS A CHANGE, NEVER A LEVEL, AND THAT IS THE WHOLE POINT.
         --
         -- A cold list ranked by last_touched_on prints "Christmas jazz" and
         -- "Nightmare before Christmas" every September. A flag that fires on
         -- the normal case is ignored inside a month, and then it is worse than
         -- none (spec §11.7). Seasonal playlists are flat-cold — cold in BOTH
         -- halves — so they never fire. A playlist he actually dropped was warm
         -- and is now silent, and that is a fact worth a line.
         --
         -- The `>= 3` floor stops a single stray play 80 days ago from counting
         -- as "warm". ⚠️ A SILENCE SHORTER THAN p_recent_days CANNOT FIRE THIS,
         -- deliberately: a fortnight off is not a signal, and a flag that fired
         -- on one would be the noise this design exists to avoid.
         (coalesce(count(*) filter (
            where dh.played_on <  current_date - p_recent_days), 0) >= 3
          and coalesce(count(*) filter (
            where dh.played_on >= current_date - p_recent_days), 0) = 0) as went_quiet
  from thresh th
  left join day_hits dh on dh.playlist_id = th.playlist_id
  group by th.playlist_id, th.distinct_groups, th.threshold;
$$;

comment on function public.dj_playlist_engagement(uuid[], int, int) is
  'Spec §12.9 plus migration 015''s rotation metrics. '
  'runs = DAYS in the window on which at least `threshold` distinct canonical '
  'groups from the playlist were played; threshold = clamp(ceil(0.5 * '
  'distinct_groups), 4, 20). runs answers "have I LEARNED this set" and is the '
  'CONCERT metric. '
  '⚠️ touch_days answers a different question — "is this still in ROTATION" — and '
  'counts days with ANY track, no threshold. It exists because runs returned 0 for '
  'nineteen consecutive non-concert playlists on 2026-09-02, fourteen of them '
  'against the threshold cap of 20. That is not a library going unused; it is a '
  'concert metric asked a non-concert question. Report the one that matches the '
  'question, never both as if they were the same idea. '
  '⚠️ went_quiet is a CHANGE, not a level: warm before the last `recent_days` '
  '(3+ touch days) and silent within them. A level-based cold list would print '
  'every seasonal playlist every week and be ignored by the third one (§11.7). A '
  'silence shorter than recent_days cannot fire it, deliberately. '
  '⚠️ DAYS, NOT SESSIONS: dj_plays buckets by UTC day and the feed carries one '
  'entry per track per bucket, so two runs in one day are indistinguishable from '
  'one. '
  '⚠️ A track in two playlists counts toward both — named, not solved.';

-- ---------------------------------------------------------------------------
-- dj_artist_activity - Section 4's headline, and what was actually asked for
-- ---------------------------------------------------------------------------
--
-- The 2026-09-02 run could not answer "a summary by artist" at all. The only
-- artist-level aggregation in the system was dj_jazz_activity, which is the
-- same shape with a bucket filter bolted on — so Section 4 fell back to a
-- 50-row sample of 332 plays and said so.
--
-- ⚠️ THIS DOES NOT CLOSE §14.1. There is still no link between plays and artist
-- IDENTITY. This groups `dj_tracks.artist` as an exact string, which is enough
-- to say "you played a lot of Wes Montgomery this month" and NOT enough to
-- treat as an identity:
--
--   * "Oscar Peterson Trio" and "Oscar Peterson" do not unify (§4.1.4). Neither
--     do "Hank Mobley" and "Hank Mobley Quartet", both live in the data today.
--   * The column holds the JOINED display string, so a collaboration appears
--     under its full billing: "Miles Davis, Cannonball Adderley, Hank Jones,
--     Sam Jones" is one artist here, not four.
--   * §14.9: at least one row reads "Jazz and Blues Experience, 1.7M views" — a
--     scraped channel byline with a view count in it. It can never match
--     anything, and it will appear in this list looking like an artist.
--
-- Reported rather than cleaned, because dj_tracks is insert-only and `artist` is
-- written once (§4.1.2, §11.13). Any consumer must state the limitation with
-- the numbers, the same way §14.3 requires of the jazz definition.
create or replace function public.dj_artist_activity(
  p_window_days int default 90,
  p_limit       int default 20
)
returns table (
  artist          text,
  distinct_days   int,
  play_rows       int,
  distinct_groups int,
  first_played_on date,
  last_played_on  date,
  in_any_playlist boolean
)
language sql
stable
as $$
  with played as (
    select t.id, t.artist,
           coalesce(t.canonical_track_id, t.id) as grp,
           p.played_on
    from public.dj_plays p
    join public.dj_tracks t on t.id = p.track_id
    where p.played_on >= current_date - p_window_days
      and t.artist is not null
      and t.artist <> ''
  ),
  -- Whether the artist is represented in ANY managed playlist. Cheap context:
  -- an artist played heavily who is in no playlist is a different observation
  -- from one who is, and it costs one join to say which.
  in_pl as (
    select distinct t.artist
    from public.dj_playlist_tracks pt
    join public.dj_tracks t on t.id = pt.track_id
    where t.artist is not null and t.artist <> ''
  )
  select pl.artist,
         count(distinct pl.played_on)::int as distinct_days,
         count(*)::int                     as play_rows,
         count(distinct pl.grp)::int       as distinct_groups,
         min(pl.played_on)                 as first_played_on,
         max(pl.played_on)                 as last_played_on,
         (pl.artist in (select artist from in_pl)) as in_any_playlist
  from played pl
  group by pl.artist
  order by count(distinct pl.played_on) desc, count(*) desc, pl.artist
  limit p_limit;
$$;

comment on function public.dj_artist_activity(int, int) is
  'Section 4''s headline: what was actually played, by artist, over a trailing '
  'window. Same shape as dj_jazz_activity without the bucket filter. '
  '⚠️ distinct_days is DISTINCT DAYS PLAYED, not a play count — dj_plays buckets '
  'by UTC day and repeats do not stack (spec §5). '
  '🛑 THIS IS NOT AN ARTIST IDENTITY AND DOES NOT CLOSE §14.1. It groups '
  'dj_tracks.artist as an EXACT STRING. "Oscar Peterson Trio" and "Oscar Peterson" '
  'do not unify (§4.1.4); "Hank Mobley" and "Hank Mobley Quartet" both exist in the '
  'data. The column holds the JOINED display string, so a collaboration appears '
  'under its full billing as one artist. And §14.9: at least one row reads "Jazz '
  'and Blues Experience, 1.7M views" — a scraped channel byline that will appear '
  'here looking like an artist. State the limitation with the numbers.';

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
-- ⚠️ These SELECTs are the point of the migration block, not decoration. Run
-- them and read the output before calling this done — a migration that reports
-- success without verifying its EFFECT is a check that cannot fail (§11.15).
--
--   -- 1. The engagement function still answers, and now carries rotation.
--   --    EXPECT: runs unchanged from before this migration; touch_days > runs
--   --    on any playlist that gets partial listens.
--   select pl.name, e.runs, e.touch_days, e.touch_days_recent, e.touch_days_prior,
--          e.last_touched_on, e.went_quiet
--   from public.dj_playlists pl
--   join public.dj_playlist_engagement(
--          array(select id from public.dj_playlists), 90, 30) e
--     on e.playlist_id = pl.id
--   order by e.touch_days desc nulls last;
--
--   -- 2. ⚠️ THE NEGATIVE CONTROL FOR went_quiet, AND IT MUST NOT BE SKIPPED.
--   --    EXPECT: 'Christmas jazz' and 'Nightmare before Christmas' are NOT in
--   --    this list. If a seasonal playlist appears, the flag is level-based
--   --    again and will be ignored inside a month (§11.7).
--   select pl.name, e.touch_days_prior, e.touch_days_recent
--   from public.dj_playlists pl
--   join public.dj_playlist_engagement(
--          array(select id from public.dj_playlists), 90, 30) e
--     on e.playlist_id = pl.id
--   where e.went_quiet;
--
--   -- 3. last_touched_on is now populated even where runs > 0.
--   --    EXPECT: at least one row. Before 015 the Edge Function nulled these.
--   select count(*) from public.dj_playlist_engagement(
--            array(select id from public.dj_playlists), 90, 30)
--   where runs > 0 and last_touched_on is not null;
--
--   -- 4. The artist rollup answers, and the top of it is recognisable.
--   --    EXPECT (measured 2026-09-02, jazz arm): Wes Montgomery ~13 days,
--   --    Oscar Peterson ~12. Foo Fighters should be high too — the concert
--   --    playlist was run 11 times.
--   select * from public.dj_artist_activity(90, 20);
--
--   -- 5. ⚠️ THE LIMITATION, MADE VISIBLE RATHER THAN DESCRIBED. Expect to SEE
--   --    the split names and the scraped byline in this output. If they are
--   --    absent, the population changed and §14.9 needs re-checking.
--   select artist from public.dj_artist_activity(90, 50)
--   where artist like '%Trio%' or artist like '%Quartet%' or artist like '%views%';
--
-- Then, per platform house rules, finish the block with:
--   check_platform_conformance()
-- EXPECT: CONFORMANT. This migration creates no tables, so register_table does
-- not apply — but the check is what proves that, rather than the assumption.
