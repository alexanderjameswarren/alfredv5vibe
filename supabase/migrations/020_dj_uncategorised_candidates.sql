-- 020 - the candidate list means UNCATEGORISED, not "untagged for jazz"
--
-- ============================================================================
-- 🛑 THE FIRST RUN PROPOSED WEEZER AS A JAZZ CANDIDATE
-- ============================================================================
-- The 2026-09-02 item's tagging table listed Weezer, Foo Fighters, The Smashing
-- Pumpkins, The Killers and No Doubt under "your most-played uncategorised
-- artists". Three of the eight were real.
--
-- ⚠️ THE QUERY AND THE HEADING MEANT DIFFERENT THINGS. dj_tag_candidates
-- excluded artists with a decision FOR p_tag, so it answered "who has no JAZZ
-- tag" — under which Weezer is a correct answer and a useless one. The section
-- said "uncategorised", under which Weezer is simply wrong: the system holds a
-- concert row, a playlist and an mbid for him.
--
-- ⚠️ AND IT POISONED THE PROJECTION. "23.7% to 61%" was arithmetically true and
-- rested on tagging Weezer as jazz. A headline number whose path runs through
-- decisions the reader would never make is worse than no number.
--
-- ============================================================================
-- 🛑 "EXCLUDE ARTISTS WITH A dj_artists ROW" WAS THE OBVIOUS FIX AND IT IS WRONG
--    THREE WAYS. RECORDED BECAUSE IT IS THE FIRST THING ANYONE WILL REACH FOR.
-- ============================================================================
-- 1. IT EXCLUDES A REAL CANDIDATE. Lady Gaga has a dj_artists row and was one of
--    the three genuine proposals in that very run. Having been to a concert says
--    nothing about whether the system knows what kind of act someone is.
--
-- 2. IT CANNOT BE IMPLEMENTED RELIABLY. There is no join between dj_artists.name
--    and dj_tracks.artist (§14.1) — and the two disagree on exactly these acts:
--    dj_tracks says "The Smashing Pumpkins" and "The Killers", dj_artists says
--    "Smashing Pumpkins" and "Killers". An exact-string exclusion would MISS the
--    two acts it was written to catch (§14.7, the same article problem).
--
-- 3. IT ANSWERS THE WRONG QUESTION. dj_artists is a setlist-lookup table keyed on
--    mbid. Its 22 rows exist so setlist.fm can be queried, not to record what
--    kind of music something is.
--
-- ============================================================================
-- WHAT ACTUALLY SEPARATES A REAL CANDIDATE FROM WEEZER
-- ============================================================================
-- **Weezer is already categorised — by a CONCERT PLAYLIST.** The system holds a
-- durable, recorded fact about him: this is an act Alex tracks as a live act.
-- Miles Davis, Lady Gaga and A$AP Rocky have no such fact attached to them.
--
-- So the fix is two changes that go together:
--
--   1. A CANDIDATE IS AN ARTIST WITH NO TAG AT ALL — any tag, any status — not
--      one lacking a specific tag. The heading becomes literally true.
--   2. CONCERT PLAYLIST MEMBERSHIP DERIVES A `concert` TAG, the same way jazz
--      playlist membership derives a `jazz` one (018). Weezer is categorised by
--      a fact the system already held and never wrote down.
--
-- ⚠️ AND THE ASK CHANGES WITH IT. The question stops being "is this jazz?" and
-- becomes "what is this?", with an open vocabulary. "Weezer → rock" is a sensible
-- answer; "Weezer → not jazz" was a rejection recorded against a question nobody
-- would have asked. That also drains the list: one answer per artist, forever,
-- whatever the answer.
--
-- ============================================================================
-- ⚠️ ONLY TWO PLAYLIST KINDS DERIVE A TAG, AND THE EXCLUSIONS ARE THE POINT
-- ============================================================================
--   jazz     -> 'jazz'      a genre claim about the act
--   concert  -> 'concert'   an act tracked as a live act
--
-- 🛑 artist, discovery AND utility DERIVE NOTHING, DELIBERATELY. They describe
-- what the PLAYLIST is for, not what the ACT is. Utility is the dangerous one:
-- "Elise's fun list" alone holds 363 distinct groups, so deriving from it would
-- tag several hundred artists with a word that says nothing about any of them —
-- clearing the backlog by redefining "categorised" to mean "appears in a playlist
-- Alex made for the gym". That is a metric improving itself.
--
-- ⚠️ NAMED EDGE CASE: Nirvana is in the Foo Fighters concert playlist, because
-- Grohl wrote Marigold and Alex put it there years ago (§12.10 records this as
-- deliberate). Nirvana therefore acquires a `concert` tag and leaves the
-- candidate list. That is loose — he is not an act Alex is going to see — and it
-- is accepted: the tag is visible in get_dj_artist_tags with source='playlist',
-- and it costs one artist a proposal rather than costing a wrong answer.
--
-- ⚠️ A JAZZ ACT WITH A CONCERT PLAYLIST WOULD NEVER BE PROPOSED FOR JAZZ, since
-- any tag removes an artist from the candidate list. None exists today. When one
-- does, the jazz tag is added by hand — record_dj_artist_tag takes any tag and an
-- artist may hold several.

-- ---------------------------------------------------------------------------
-- Seed the concert arm — the fact the system already held
-- ---------------------------------------------------------------------------
insert into public.dj_artist_tags (user_id, artist, tag, source, status, note)
select distinct t.user_id, t.artist, 'concert', 'playlist', 'active',
       'Derived: this artist is on a track in a kind=concert playlist — an act '
       'tracked as a live act. Migration 020. Not a genre claim.'
from public.dj_playlists pl
join public.dj_playlist_tracks pt on pt.playlist_id = pl.id
join public.dj_tracks t on t.id = pt.track_id
where pl.kind = 'concert'
  and t.artist is not null
  and t.artist <> ''
on conflict (user_id, artist, tag) do nothing;

-- ---------------------------------------------------------------------------
-- dj_tag_candidates — UNCATEGORISED artists, whatever the tag would be
-- ---------------------------------------------------------------------------
-- ⚠️ SIGNATURE AND RETURN TYPE BOTH CHANGE, so the old one is dropped. p_tag is
-- GONE: the exclusion is no longer tag-specific, and keeping a parameter that no
-- longer governs the answer is how a caller keeps believing it does.
drop function if exists public.dj_tag_candidates(text, int, int);

create or replace function public.dj_tag_candidates(
  p_window_days int default 90,
  p_limit       int default 20
)
returns table (
  artist          text,
  distinct_days   int,
  play_rows       int,
  distinct_groups int,
  last_played_on  date,
  in_any_playlist boolean,
  derivable_as    text[]
)
language sql
stable
as $$
  with kind_tag as (
    -- The whole map, in one place. See the header for why the other three
    -- playlist kinds derive nothing.
    select * from (values ('jazz', 'jazz'), ('concert', 'concert')) as m(kind, tag)
  ),
  derivable as (
    select distinct t.artist, k.tag
    from public.dj_playlists pl
    join kind_tag k on k.kind = pl.kind
    join public.dj_playlist_tracks pt on pt.playlist_id = pl.id
    join public.dj_tracks t on t.id = pt.track_id
    where t.artist is not null and t.artist <> ''
  ),
  -- ⚠️ ANY TAG, ANY STATUS. An artist tagged 'concert' is categorised; an artist
  -- whose jazz tag was REJECTED is decided. Both are answers, and neither should
  -- be asked about again.
  decided as (
    select distinct at.artist from public.dj_artist_tags at
  ),
  in_pl as (
    select distinct t.artist
    from public.dj_playlist_tracks pt
    join public.dj_tracks t on t.id = pt.track_id
    where t.artist is not null and t.artist <> ''
  ),
  played as (
    select t.artist,
           coalesce(t.canonical_track_id, t.id) as grp,
           p.played_on
    from public.dj_plays p
    join public.dj_tracks t on t.id = p.track_id
    where p.played_on >= current_date - p_window_days
      and t.artist is not null and t.artist <> ''
      and t.artist not in (select artist from decided)
  )
  select pl.artist,
         count(distinct pl.played_on)::int as distinct_days,
         count(*)::int                     as play_rows,
         count(distinct pl.grp)::int       as distinct_groups,
         max(pl.played_on)                 as last_played_on,
         (pl.artist in (select artist from in_pl)) as in_any_playlist,
         -- Non-null means a tag can be DERIVED rather than judged. After this
         -- migration's seed it should be empty for everyone: the seed and this
         -- expression read the same map, so a non-null here means drift.
         (select array_agg(distinct d.tag order by d.tag)
            from derivable d where d.artist = pl.artist) as derivable_as
  from played pl
  group by pl.artist
  order by (exists (select 1 from derivable d where d.artist = pl.artist)) desc,
           count(*) desc,
           count(distinct pl.played_on) desc,
           count(distinct pl.grp) desc,
           pl.artist
  limit p_limit;
$$;

comment on function public.dj_tag_candidates(int, int) is
  'Played artists carrying NO tag of any kind — the weekly item''s "what are '
  'these?" proposal. '
  '🛑 UNCATEGORISED, NOT "UNTAGGED FOR JAZZ" (changed 020). The old version '
  'excluded only artists decided for one tag, so it proposed Weezer as a jazz '
  'candidate: correct under "who lacks a jazz tag", nonsense under the heading '
  'the item actually printed. '
  '⚠️ THE ASK IS "WHAT IS THIS?", NOT "IS THIS JAZZ?" — an open vocabulary. '
  '"Weezer -> rock" is an answer; a jazz-rejection against a question nobody '
  'would ask is not. Any answer removes the artist permanently. '
  '⚠️ `derivable_as` NON-NULL MEANS NO JUDGEMENT IS NEEDED: playlist membership '
  'implies the tag. Write it with record_dj_artist_tag and do not ask. It should '
  'be empty in normal operation — the seeds keep it so — and a non-null row means '
  'a playlist changed since the last seed. '
  '⚠️ ORDERED BY play_rows, the unit coverage is measured in, so the top N are '
  'the N answers that categorise the most listening.';

-- ---------------------------------------------------------------------------
-- dj_tag_coverage — two different numbers, and they are not interchangeable
-- ---------------------------------------------------------------------------
-- 🛑 THE PROJECTION WAS MEASURING THE WRONG THING. "Tagging these eight takes
-- coverage from 23.7% to 61%" computed JAZZ coverage while proposing artists
-- whose true answer is "rock". The arithmetic was right and the premise was not.
--
--   CATEGORISATION coverage answers "how much of my listening does the system
--   know anything about". It moves whatever the answer is, so it is the honest
--   metric for the backlog and for the projection.
--
--   JAZZ share answers "how much of my listening is jazz". It is a fact about
--   listening, NOT a progress bar — tagging Weezer 'rock' must not move it, and
--   under the old design it did.
--
-- Both ship, named apart, from one call.
drop function if exists public.dj_tag_coverage(text, int);

create or replace function public.dj_tag_coverage(
  p_tag         text default 'jazz',
  p_window_days int default 90
)
returns table (
  tag                     text,
  window_days             int,
  played_artists          int,
  played_rows             int,
  -- The tag asked about: a listening fact, not a progress metric.
  tagged_active           int,
  tagged_rejected         int,
  tagged_rows             int,
  -- Tag-agnostic: the backlog, and what the projection must use.
  categorised_artists     int,
  categorised_rows        int,
  uncategorised_artists   int,
  uncategorised_rows      int,
  uncategorised_derivable int
)
language sql
stable
as $$
  with rows_by_artist as (
    select t.artist, count(*)::int as play_rows
    from public.dj_plays p
    join public.dj_tracks t on t.id = p.track_id
    where p.played_on >= current_date - p_window_days
      and t.artist is not null and t.artist <> ''
    group by t.artist
  ),
  kind_tag as (
    select * from (values ('jazz', 'jazz'), ('concert', 'concert')) as m(kind, tag)
  ),
  derivable as (
    select distinct t.artist
    from public.dj_playlists pl
    join kind_tag k on k.kind = pl.kind
    join public.dj_playlist_tracks pt on pt.playlist_id = pl.id
    join public.dj_tracks t on t.id = pt.track_id
    where t.artist is not null and t.artist <> ''
  ),
  for_tag as (
    select at.artist, at.status
    from public.dj_artist_tags at
    where at.tag = p_tag
  ),
  -- ⚠️ CATEGORISED means holding an ACTIVE tag of any kind. A rejected-only
  -- artist is DECIDED but not categorised — the system still knows nothing about
  -- what he is — so he is out of the candidate list and out of this numerator.
  -- That is why these buckets do not sum to played_rows.
  categorised as (
    select distinct at.artist from public.dj_artist_tags at where at.status = 'active'
  ),
  decided as (
    select distinct at.artist from public.dj_artist_tags at
  ),
  uncategorised as (
    select r.artist, r.play_rows,
           (r.artist in (select artist from derivable)) as is_derivable
    from rows_by_artist r
    where r.artist not in (select artist from decided)
  )
  select p_tag,
         p_window_days,
         (select count(*) from rows_by_artist)::int,
         (select coalesce(sum(play_rows), 0) from rows_by_artist)::int,
         (select count(*) from for_tag where status = 'active')::int,
         (select count(*) from for_tag where status = 'rejected')::int,
         (select coalesce(sum(r.play_rows), 0) from rows_by_artist r
           where r.artist in (select artist from for_tag where status = 'active'))::int,
         (select count(*) from rows_by_artist r
           where r.artist in (select artist from categorised))::int,
         (select coalesce(sum(r.play_rows), 0) from rows_by_artist r
           where r.artist in (select artist from categorised))::int,
         (select count(*) from uncategorised)::int,
         (select coalesce(sum(play_rows), 0) from uncategorised)::int,
         (select count(*) from uncategorised where is_derivable)::int;
$$;

comment on function public.dj_tag_coverage(text, int) is
  '🛑 TWO DIFFERENT NUMBERS AND THEY ARE NOT INTERCHANGEABLE. '
  'CATEGORISATION (categorised_rows / played_rows) answers "how much of my '
  'listening does the system know anything about". It moves whatever answer is '
  'given, so it is the metric for the backlog and the ONLY one a tagging '
  'projection may use. '
  'THE TAG SHARE (tagged_rows / played_rows) answers "how much of my listening is '
  'jazz". It is a listening FACT, not a progress bar — tagging Weezer ''rock'' '
  'must not move it, and under the pre-020 design it did. '
  '⚠️ A REJECTED-ONLY ARTIST IS DECIDED BUT NOT CATEGORISED, so the buckets do '
  'not sum to played_rows. Deliberate: a rejection records that a question was '
  'answered, not that the system learned what the act is. '
  '⚠️ uncategorised_derivable should be 0 in normal operation. Non-zero means a '
  'playlist gained an artist since the last seed — a fact to write, not a '
  'judgement to ask about.';

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
do $$
declare
  cov       record;
  weezer_n  int;
  concert_n int;
  cand_n    int;
begin
  -- 1. 🛑 THE ACTUAL DEFECT, REPRODUCED AS A CONTROL (§11.16). Weezer is in a
  --    concert playlist, so he must now be categorised and absent from the
  --    candidate list. This is the exact row the first run got wrong.
  select count(*) into concert_n
  from public.dj_artist_tags where tag = 'concert' and source = 'playlist';
  if concert_n = 0 then
    raise exception
      'No concert tags were written. The seed matched nothing, so every concert '
      'act is still an "uncategorised" candidate and the section will propose '
      'Weezer again.';
  end if;
  raise notice 'Concert arm stored as % tag row(s).', concert_n;

  select count(*) into weezer_n
  from public.dj_tag_candidates(90, 500) where artist = 'Weezer';
  if weezer_n <> 0 then
    raise exception
      'Weezer is still a tagging candidate. The candidate list means '
      'UNCATEGORISED; an artist with a concert playlist is categorised.';
  end if;

  -- 2. ⚠️ AND THE NEGATIVE CONTROL, WHICH MATTERS AS MUCH. Over-excluding would
  --    empty the section and look like success. Miles Davis is in no jazz and no
  --    concert playlist and must STILL be proposed.
  select count(*) into cand_n
  from public.dj_tag_candidates(90, 500) where artist = 'Miles Davis';
  if cand_n <> 1 then
    raise exception
      'Miles Davis is no longer a candidate. The exclusion has widened past '
      '"already categorised" and is now hiding real proposals.';
  end if;

  select * into cov from public.dj_tag_coverage('jazz', 90);

  -- 3. The seed and the candidate query read the same kind->tag map. If they
  --    disagree, the section proposes facts as judgements every week while the
  --    seed believes it is finished.
  if cov.uncategorised_derivable <> 0 then
    raise exception
      '% derivable artist(s) remain uncategorised immediately after the seed. '
      'The seed and dj_tag_candidates disagree about what playlist membership '
      'implies.', cov.uncategorised_derivable;
  end if;

  -- 4. Categorisation is a share of a real denominator.
  if cov.categorised_rows > cov.played_rows then
    raise exception
      'categorised_rows (%) exceeds played_rows (%).',
      cov.categorised_rows, cov.played_rows;
  end if;

  raise notice
    'Categorised: % of % play rows (% pct). % artists still uncategorised.',
    cov.categorised_rows, cov.played_rows,
    round(100.0 * cov.categorised_rows / nullif(cov.played_rows, 0), 1),
    cov.uncategorised_artists;
  raise notice
    'Jazz share (a listening fact, NOT progress): % of % play rows.',
    cov.tagged_rows, cov.played_rows;
end $$;

-- ---------------------------------------------------------------------------
-- Then, per platform house rules, finish the block with:
--   check_platform_conformance()
-- EXPECT: CONFORMANT. Functions and one seed; no tables created or altered.
-- ---------------------------------------------------------------------------
