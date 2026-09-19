-- 060 — SCHEMA CHANGE. Apply once, in order.
--
-- Folds artist CASE at every point where a string is compared against
-- dj_artist_tags.artist. Closes the stranded-tag half of §14.56.
--
-- ============================================================================
-- WHAT THIS FIXES, MEASURED BY 059
-- ============================================================================
--
-- Six acts are stored under two spellings differing only in case. The measured
-- cost was small and is stated exactly rather than estimated:
--
--     Queens of the Stone Age / Queens Of The Stone Age   "My God Is the Sun"
--                                                         untagged rock
--     the Chordettes / The Chordettes                     one track untagged jazz
--
-- Two stranded tags, one track each. ⚠️ THAT IS THE WHOLE DIRECT COST, and on its
-- own it would not justify a migration.
--
-- 🛑 THE REASON TO DO IT IS THE SECOND-ORDER LEAK, WHICH 059 DID NOT MEASURE.
-- dj_tag_candidates excludes artists already DECIDED by exact string. A
-- case-split spelling is therefore never excluded, so it is proposed for tagging
-- again every week, for the rest of the project — §11.7 exactly, and the same
-- failure §14.24 added `status='rejected'` to prevent. The tag is not merely
-- missing on one spelling; the system keeps ASKING about an artist it has
-- already decided.
--
-- ============================================================================
-- 🛑 FOLD THE JOIN. DO NOT INSERT ROWS.
-- ============================================================================
--
-- The obvious repair is to write a second dj_artist_tags row for the other
-- spelling. DO NOT. tagged_single_track (021) counts active tags whose artist
-- string appears on exactly ONE track, and is documented as "where the junk is" —
-- the signal that finds "Dec 29, 2023" and "Cavendish Music" tagged as jazz.
--
-- Every case-split spelling here holds exactly one track. Inserting tag rows for
-- them would add one to that counter per split, WITH NO JUNK PRESENT — degrading
-- the only metric that finds real junk, in the act of fixing something else.
--
-- Folding the comparison adds no rows, moves no counter, and leaves
-- tagged_single_track measuring precisely what it did before.
--
-- ============================================================================
-- WHY NOT ALSO FOLD THE ROLLUP — a decision, not an omission
-- ============================================================================
--
-- get_dj_plays mode=artists still groups on the RAW display string, and that is
-- deliberate (Alex, 2026-09-19).
--
-- Folding case there would fix six acts and leave every SEMANTIC split exactly as
-- before — "Eddie Higgins Trio" vs "Eddie Higgins", "Oscar Peterson" vs "Oscar
-- Peterson Trio", "Hank Mobley" vs "Hank Mobley Quartet". ⚠️ A ROLLUP THAT
-- HANDLES CASE BUT NOT THOSE READS AS "ARTIST SPLITS ARE HANDLED", which is worse
-- than one that plainly does not and says so in its `gaps`. The honesty of that
-- caveat depends on the grouping being visibly crude.
--
-- The data supports it further: the splits are LOPSIDED. Each minor spelling holds
-- a single track, so the main rollup row is already nearly right and the residual
-- distortion is cosmetic. Every consumer where the split changed a DECISION rather
-- than a number — the tag filter, coverage, candidates — is fixed here.
--
-- in_any_playlist is likewise left unfolded. It is a rollup column, and extending
-- the fold to it would be exactly the scope creep the paragraph above rejects.
--
-- ============================================================================
-- NOT A BACKFILL
-- ============================================================================
--
-- match_key is ALREADY case-insensitive — normalisePart() opens with
-- raw.toLowerCase().trim(). Verified against all six real pairs; every one folds
-- to one key. So no stored row, no match_key and no canonical_track_id changes
-- here. This is read-time only, which is why it is cheap enough to be worth doing.

-- ---------------------------------------------------------------------------
-- The fold, as one named function so every call site is greppable.
-- ---------------------------------------------------------------------------
-- IMMUTABLE so it can be used in an index later if the comparisons ever get hot;
-- btrim because a trailing space is the same class of accident as a capital.
create or replace function public.dj_fold_artist(p_artist text)
returns text
language sql
immutable
as $$
  select lower(btrim(coalesce(p_artist, '')))
$$;

comment on function public.dj_fold_artist(text) is
  'Case/whitespace fold for comparing artist DISPLAY strings against '
  'dj_artist_tags.artist. Mirrors what normalisePart() already does inside '
  'match_key, so the two agree by construction. 🛑 NOT an artist identity — it '
  'folds spelling, never semantics: "Oscar Peterson" and "Oscar Peterson Trio" '
  'remain distinct and need a human (§14.1). ⚠️ USE IT ON BOTH SIDES OF A '
  'COMPARISON. A raw left side against a folded list never matches, so a '
  'half-applied fold silently excludes nothing — worse than no fold at all.';

create or replace function public.dj_artist_activity(
  p_window_days int default 90,
  p_limit       int default 20,
  p_tag         text default null
)
returns table (
  artist          text,
  distinct_days   int,
  play_rows       int,
  distinct_groups int,
  first_played_on date,
  last_played_on  date,
  in_any_playlist boolean,
  tags            text[]
)
language sql
stable
as $$
  with active_tags as (
    select at.artist, at.tag
    from public.dj_artist_tags at
    where at.status = 'active'
  ),
  tagged as (
    select a.artist, array_agg(distinct a.tag order by a.tag) as tags
    from active_tags a
    group by a.artist
  ),
  played as (
    select t.id, t.artist,
           coalesce(t.canonical_track_id, t.id) as grp,
           p.played_on
    from public.dj_plays p
    join public.dj_tracks t on t.id = p.track_id
    where p.played_on >= current_date - p_window_days
      and t.artist is not null
      and t.artist <> ''
      and (
        p_tag is null
        or public.dj_fold_artist(t.artist) in (
          select public.dj_fold_artist(a2.artist) from active_tags a2
          where a2.tag = p_tag
        )
      )
  ),
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
         (pl.artist in (select artist from in_pl)) as in_any_playlist,
         coalesce((select tg.tags from tagged tg
                   where public.dj_fold_artist(tg.artist)
                       = public.dj_fold_artist(pl.artist)),
                  '{}'::text[])            as tags
  from played pl
  group by pl.artist
  order by count(distinct pl.played_on) desc, count(*) desc, pl.artist
  limit p_limit;
$$;

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
      and public.dj_fold_artist(t.artist) not in (
            select public.dj_fold_artist(artist) from decided)
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

create or replace function public.dj_tag_coverage(
  p_tag         text default 'jazz',
  p_window_days int default 90
)
returns table (
  tag                     text,
  window_days             int,
  played_artists          int,
  played_rows             int,
  tagged_active           int,
  tagged_rejected         int,
  tagged_rows             int,
  categorised_artists     int,
  categorised_rows        int,
  uncategorised_artists   int,
  uncategorised_rows      int,
  uncategorised_derivable int,
  -- ADDED 021. Active tags for p_tag whose artist string appears on exactly ONE
  -- dj_tracks row. A FACT about evidence, not a claim that they are junk — but
  -- it is where the junk is, and the section that prints tagged_rows should be
  -- able to qualify it in one line without a second call.
  tagged_single_track     int
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
  tracks_by_artist as (
    select t.artist, count(*)::int as n
    from public.dj_tracks t
    where t.artist is not null and t.artist <> ''
    group by t.artist
  ),
  for_tag as (
    select at.artist, at.status
    from public.dj_artist_tags at
    where at.tag = p_tag
  ),
  categorised as (
    select distinct at.artist from public.dj_artist_tags at where at.status = 'active'
  ),
  decided as (
    select distinct at.artist from public.dj_artist_tags at
  ),
  uncategorised as (
    select r.artist, r.play_rows,
           (public.dj_fold_artist(r.artist) in (
             select public.dj_fold_artist(artist) from derivable)) as is_derivable
    from rows_by_artist r
    where public.dj_fold_artist(r.artist) not in (
            select public.dj_fold_artist(artist) from decided)
  )
  select p_tag,
         p_window_days,
         (select count(*) from rows_by_artist)::int,
         (select coalesce(sum(play_rows), 0) from rows_by_artist)::int,
         (select count(*) from for_tag where status = 'active')::int,
         (select count(*) from for_tag where status = 'rejected')::int,
         (select coalesce(sum(r.play_rows), 0) from rows_by_artist r
           where public.dj_fold_artist(r.artist) in (
             select public.dj_fold_artist(artist) from for_tag
             where status = 'active'))::int,
         (select count(*) from rows_by_artist r
           where public.dj_fold_artist(r.artist) in (
             select public.dj_fold_artist(artist) from categorised))::int,
         (select coalesce(sum(r.play_rows), 0) from rows_by_artist r
           where public.dj_fold_artist(r.artist) in (
             select public.dj_fold_artist(artist) from categorised))::int,
         (select count(*) from uncategorised)::int,
         (select coalesce(sum(play_rows), 0) from uncategorised)::int,
         (select count(*) from uncategorised where is_derivable)::int,
         (select count(*) from for_tag f
            join tracks_by_artist tb on tb.artist = f.artist
           where f.status = 'active' and tb.n = 1)::int;
$$;

create or replace function public.dj_tag_review(
  p_tag         text default null,
  p_source      text default null,
  p_window_days int  default 90,
  p_limit       int  default 20
)
returns table (
  artist             text,
  tag                text,
  status             text,
  source             text,
  note               text,
  distinct_tracks    int,
  distinct_playlists int,
  play_rows          int,
  distinct_days      int,
  last_played_on     date
)
language sql
stable
as $$
  with tracks_by_artist as (
    select t.artist, count(*)::int as n
    from public.dj_tracks t
    where t.artist is not null and t.artist <> ''
    group by t.artist
  ),
  playlists_by_artist as (
    select t.artist, count(distinct pt.playlist_id)::int as n
    from public.dj_playlist_tracks pt
    join public.dj_tracks t on t.id = pt.track_id
    where t.artist is not null and t.artist <> ''
    group by t.artist
  ),
  plays_by_artist as (
    select t.artist,
           count(*)::int as play_rows,
           count(distinct p.played_on)::int as distinct_days,
           max(p.played_on) as last_played_on
    from public.dj_plays p
    join public.dj_tracks t on t.id = p.track_id
    where p.played_on >= current_date - p_window_days
      and t.artist is not null and t.artist <> ''
    group by t.artist
  )
  select at.artist,
         at.tag,
         at.status,
         at.source,
         at.note,
         coalesce(tb.n, 0),
         coalesce(pb.n, 0),
         coalesce(pl.play_rows, 0),
         coalesce(pl.distinct_days, 0),
         pl.last_played_on
  from public.dj_artist_tags at
  left join tracks_by_artist    tb on public.dj_fold_artist(tb.artist)
                                  = public.dj_fold_artist(at.artist)
  left join playlists_by_artist pb on public.dj_fold_artist(pb.artist)
                                  = public.dj_fold_artist(at.artist)
  left join plays_by_artist     pl on public.dj_fold_artist(pl.artist)
                                  = public.dj_fold_artist(at.artist)
  where (p_tag is null or at.tag = p_tag)
    and (p_source is null or at.source = p_source)
  -- 🛑 WEAKEST EVIDENCE FIRST. This is an ORDERING FOR A HUMAN, not a ruling.
  -- A one-track, one-playlist, never-played string is the cheapest thing to
  -- check; a 94-song artist is not worth anyone's attention. Nothing here
  -- inspects the text.
  order by coalesce(tb.n, 0) asc,
           coalesce(pl.play_rows, 0) asc,
           coalesce(pb.n, 0) asc,
           at.artist
  limit p_limit;
$$;
-- ---------------------------------------------------------------------------
-- VERIFY — a fold that changed nothing would deploy silently and look applied.
-- ---------------------------------------------------------------------------
do $$
declare
  n_split      int;
  n_stranded   int;
  cov_after    int;
begin
  -- 1. The fold itself.
  if public.dj_fold_artist('  Queens Of The Stone Age ')
     <> public.dj_fold_artist('queens of the stone age') then
    raise exception 'dj_fold_artist does not fold case and whitespace.';
  end if;
  if public.dj_fold_artist('Oscar Peterson')
     = public.dj_fold_artist('Oscar Peterson Trio') then
    raise exception
      'dj_fold_artist merged a SEMANTIC split. It folds spelling only (§14.1).';
  end if;

  -- 2. 🛑 THE NEGATIVE CONTROL. If no case split exists, every assertion below
  --    passes VACUOUSLY and this migration would report success having proved
  --    nothing (§11.16). 059 measured six; fewer than one means the premise is
  --    gone and this should be re-read before being trusted.
  select count(*) into n_split from (
    select lower(artist) from public.dj_tracks
    where artist is not null and artist <> ''
    group by lower(artist) having count(distinct artist) > 1
  ) s;
  if n_split = 0 then
    raise exception
      'No artist case splits exist, so this migration cannot be shown to do '
      'anything. 059 measured six on 2026-09-19. Re-check before trusting it.';
  end if;
  raise notice '% artist case split(s) present.', n_split;

  -- 3. The leak that justified the work: a DECIDED artist still proposed under
  --    its other spelling. This must now be zero.
  select count(*) into n_stranded
  from public.dj_tracks t
  where t.artist is not null and t.artist <> ''
    and public.dj_fold_artist(t.artist) in (
          select public.dj_fold_artist(at.artist) from public.dj_artist_tags at)
    and t.artist not in (select at2.artist from public.dj_artist_tags at2);
  raise notice
    '% track row(s) whose artist is decided under another spelling — these were '
    'proposed weekly before this migration and are now excluded.', n_stranded;

  -- 4. Coverage must not FALL. Folding can only ever decide MORE artists, so a
  --    drop means a comparison was folded on one side only.
  select categorised_artists into cov_after
  from public.dj_tag_coverage('jazz', 90);
  if cov_after is null then
    raise exception 'dj_tag_coverage returned no row after the fold.';
  end if;
  raise notice 'jazz categorised_artists after fold: %', cov_after;
end $$;
