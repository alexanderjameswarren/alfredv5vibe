-- 018 - the jazz tags become a SYSTEM, and Section 3 stops being a second definition
--
-- ============================================================================
-- WHAT THIS DECIDES
-- ============================================================================
-- 1. dj_jazz_activity is DROPPED. Section 3 becomes dj_artist_activity filtered
--    to tag='jazz' — one function, one definition.
-- 2. The playlist arm is NOT dropped. It is CONVERTED from a query-time
--    inference into a stored fact: every artist on a track in a kind='jazz'
--    playlist is tagged here, once, automatically.
-- 3. A tag can be REJECTED as well as applied, so "asked and answered no" is a
--    recorded decision rather than an absence.
--
-- ============================================================================
-- 🛑 "WE DROPPED THE PLAYLIST ARM" AND "THE PLAYLIST ARM NOW WRITES TAGS
--    INSTEAD OF BEING RECOMPUTED" ARE DIFFERENT CLAIMS. ONLY THE SECOND IS TRUE.
-- ============================================================================
-- The old arm 2 asked, at every query: "is this artist on a track that is in a
-- jazz playlist?" That question has a definite answer and it does not depend on
-- who is asking or when. It was never a judgement — which is exactly why it
-- could be evaluated by a machine at read time.
--
-- So it survives, as an INSERT rather than a JOIN. The seed below writes one
-- row per playlist-derived artist with `source = 'playlist'`, and
-- `dj_tag_candidates` reports any that appear later so drift is visible and
-- closeable without asking anyone.
--
-- ⚠️ WHAT ACTUALLY CHANGES, AND IT IS A REAL COST: the arm no longer
-- self-updates. Add a track to Christmas jazz tomorrow and its artist is NOT
-- tagged until something writes the row. That is the price of one definition,
-- and it is paid deliberately — §14.19's contradiction (in_playlist vs
-- in_any_playlist reading opposite ways for Wes Montgomery) is what two
-- overlapping definitions produce, and it will produce another one.
--
-- ⚠️ THE PRICE IS PAID VISIBLY, NOT SILENTLY. dj_tag_candidates separates
-- `derivable` (in a matching playlist, untagged — a FACT, write it without
-- asking) from proposals (a judgement). A stored fact that has gone stale shows
-- up as a derivable candidate, which is a self-announcing kind of drift.
--
-- ============================================================================
-- ⚠️ REJECTION IS A STATE, BECAUSE ABSENCE RE-PROPOSES FOREVER
-- ============================================================================
-- ADDED HERE AND NOT ASKED FOR, so it is flagged rather than slipped in.
--
-- The flow is: the report proposes untagged artists, Alex approves, the thread
-- writes. If "no" leaves no trace, the same names come back next week and the
-- week after. `Harrison` — 4 distinct days, possibly a scraped byline (§14.9) —
-- would be proposed every single week forever.
--
-- 🛑 THAT IS §11.7 EXACTLY: a proposal that fires on the normal case gets
-- ignored, and then it is worse than none. A curated allowlist whose curation
-- cannot record a NO is not curated; it is a list that keeps asking.
--
-- So `status` is 'active' or 'rejected'. Both count as DECIDED and neither is
-- proposed again. Only 'active' counts as tagged.

-- ---------------------------------------------------------------------------
-- Schema: provenance and decision state
-- ---------------------------------------------------------------------------
alter table public.dj_artist_tags
  add column if not exists source text not null default 'manual',
  add column if not exists status text not null default 'active',
  add column if not exists decided_at timestamptz not null default now();

-- ⚠️ 016 OMITTED THIS AND EVERY OTHER TABLE IN THE PROJECT HAS IT. Without a
-- default, a tool must supply user_id itself — and the only value it has is
-- `ctx.userId`, which the platform contract is explicit is the UNVERIFIED JWT
-- `sub`, for logging rather than for authorisation. RLS would reject a forged
-- one, so the omission was not a hole; but making a row's OWNER come from an
-- unverified header and relying on a second mechanism to catch it is a worse
-- shape than letting the database decide. platform_schedules, platform_runs and
-- every sam_* table already do it this way.
alter table public.dj_artist_tags
  alter column user_id set default auth.uid();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'dj_artist_tags_source_ck') then
    alter table public.dj_artist_tags add constraint dj_artist_tags_source_ck
      check (source in ('playlist', 'manual'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dj_artist_tags_status_ck') then
    alter table public.dj_artist_tags add constraint dj_artist_tags_status_ck
      check (status in ('active', 'rejected'));
  end if;
end $$;

comment on column public.dj_artist_tags.source is
  '⚠️ WHERE THE TAG CAME FROM, AND IT GOVERNS WHAT MAY BE REWRITTEN. '
  '''playlist'' = DERIVED: the artist is on a track in a playlist whose kind '
  'matches the tag. A fact, re-derivable, safe for a machine to write without '
  'asking — this is migration 013''s artist arm, converted from a query-time '
  'join into a stored row. ''manual'' = a human judgement (or a rejection), and '
  'NOTHING may overwrite it automatically. The distinction exists so a resync of '
  'the derived rows can never touch a curated one.';

comment on column public.dj_artist_tags.status is
  '''active'' = tagged. ''rejected'' = considered and declined. '
  '🛑 BOTH MEAN DECIDED AND NEITHER IS EVER PROPOSED AGAIN. Absence is the only '
  'state that means "not yet asked". Without a rejected state, saying no to a '
  'proposed artist leaves no trace and the report proposes it again next week, '
  'forever — §11.7, a signal that fires on the normal case gets ignored. '
  'Only ''active'' rows are counted as tagged by dj_artist_activity.';

-- ---------------------------------------------------------------------------
-- 🛑 SEED THE DERIVED ARM. This is migration 013's arm 2, stored rather than
--    recomputed — the rows it used to produce at query time, produced once.
-- ---------------------------------------------------------------------------
-- Same join shape as 017: user_id comes FROM the data, so a row can only exist
-- for an artist string that actually appears in dj_tracks.
--
-- ⚠️ `on conflict do nothing` IS LOAD-BEARING. 017's twelve curated rows already
-- exist and every one of them is a judgement about an artist in NO playlist.
-- If any of them ever became playlist-derived, overwriting `source` would erase
-- the record that a human made the call.
insert into public.dj_artist_tags (user_id, artist, tag, source, status, note)
select distinct t.user_id, t.artist, 'jazz', 'playlist', 'active',
       'Derived: this artist is on a track in a kind=jazz playlist. Migration '
       '013''s artist arm, stored rather than recomputed at query time (018).'
from public.dj_playlist_tracks pt
join public.dj_playlists pl on pl.id = pt.playlist_id
join public.dj_tracks t on t.id = pt.track_id
where pl.kind = 'jazz'
  and t.artist is not null
  and t.artist <> ''
on conflict (user_id, artist, tag) do nothing;

-- ---------------------------------------------------------------------------
-- dj_artist_activity — now the ONLY artist-level definition
-- ---------------------------------------------------------------------------
-- ⚠️ RETURN TYPE UNCHANGED, but the tag semantics are not: only status='active'
-- counts. A rejected row must not filter an artist IN, and must not appear in
-- `tags` — it is a decision about the artist, not a property of him.
drop function if exists public.dj_artist_activity(int, int, text);

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
        or t.artist in (select a2.artist from active_tags a2 where a2.tag = p_tag)
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
         coalesce((select tg.tags from tagged tg where tg.artist = pl.artist),
                  '{}'::text[])            as tags
  from played pl
  group by pl.artist
  order by count(distinct pl.played_on) desc, count(*) desc, pl.artist
  limit p_limit;
$$;

comment on function public.dj_artist_activity(int, int, text) is
  'THE artist-level definition. Sections 3 and 4 of the weekly item are both this '
  'function: Section 4 unfiltered, Section 3 with p_tag => ''jazz''. '
  '🛑 ONE FUNCTION, ONE DEFINITION, DECIDED 2026-09-02. dj_jazz_activity is '
  'dropped. Two overlapping definitions produced §14.19 — `in_playlist` and '
  '`in_any_playlist` reading opposite ways for Wes Montgomery, both correct — and '
  'would produce another one. '
  '⚠️ Only status=''active'' tags filter or appear in `tags`. A ''rejected'' row '
  'means the artist was considered and declined; it is a decision about him, not '
  'a property of him, and it must never filter him in. '
  '⚠️ A TAG-FILTERED READ CANNOT SEE WHAT IS UNTAGGED. Pair it with '
  'dj_tag_coverage / dj_tag_candidates or the section silently reports only what '
  'someone remembered to tag. '
  '🛑 STILL NOT AN ARTIST IDENTITY (§14.1). Exact-string grouping on '
  'dj_tracks.artist: "Oscar Peterson Trio" and "Oscar Peterson" do not unify, '
  'collaborations appear under their full joined billing, and §14.9''s scraped '
  'byline is in the population.';

-- ---------------------------------------------------------------------------
-- 🛑 dj_jazz_activity IS DROPPED. One definition means one function.
-- ---------------------------------------------------------------------------
-- ⚠️ IT IS DROPPED RATHER THAN LEFT AS A WRAPPER, DELIBERATELY. A wrapper is a
-- second NAME for one idea, and the next reader has to discover they are the
-- same. A dropped function fails loudly at the call site, which is the failure
-- worth having: anything still calling it gets an error rather than an answer
-- computed a slightly different way.
drop function if exists public.dj_jazz_activity(int);

-- ---------------------------------------------------------------------------
-- dj_tag_coverage — WHAT THE TAG-FILTERED SECTION CANNOT SEE
-- ---------------------------------------------------------------------------
-- 🛑 THE REPORT MUST SAY WHAT IT IS BLIND TO, AND THIS IS THE FIELD THAT LETS IT.
--
-- A tag-filtered Section 3 reports exactly what is tagged. That is the whole
-- point and it is also the whole risk: a thin section and a thin listening habit
-- look identical, which is the SAME failure mode as migration 013's definition
-- string — a number that describes its own coverage as if it described the
-- world. Monk was invisible for a quarter under a definition nobody re-checked.
--
-- One row. Cheap enough to call every time the section is built, and the section
-- should not be printed without it.
create or replace function public.dj_tag_coverage(
  p_tag         text default 'jazz',
  p_window_days int default 90
)
returns table (
  tag                  text,
  window_days          int,
  played_artists       int,
  tagged_active        int,
  tagged_rejected      int,
  untagged_total       int,
  untagged_derivable   int,
  untagged_proposals   int
)
language sql
stable
as $$
  with played as (
    select distinct t.artist
    from public.dj_plays p
    join public.dj_tracks t on t.id = p.track_id
    where p.played_on >= current_date - p_window_days
      and t.artist is not null and t.artist <> ''
  ),
  decided as (
    select at.artist, at.status
    from public.dj_artist_tags at
    where at.tag = p_tag
  ),
  -- An artist on a track in a playlist whose KIND matches the tag. For 'jazz'
  -- this is migration 013's arm 2, and tagging one is a fact rather than a
  -- judgement — so it is counted apart from the proposals.
  derivable as (
    select distinct t.artist
    from public.dj_playlist_tracks pt
    join public.dj_playlists pl on pl.id = pt.playlist_id
    join public.dj_tracks t on t.id = pt.track_id
    where pl.kind = p_tag and t.artist is not null and t.artist <> ''
  ),
  untagged as (
    select pd.artist, (pd.artist in (select artist from derivable)) as is_derivable
    from played pd
    where pd.artist not in (select artist from decided)
  )
  select p_tag,
         p_window_days,
         (select count(*) from played)::int,
         (select count(*) from decided where status = 'active')::int,
         (select count(*) from decided where status = 'rejected')::int,
         (select count(*) from untagged)::int,
         (select count(*) from untagged where is_derivable)::int,
         (select count(*) from untagged where not is_derivable)::int;
$$;

comment on function public.dj_tag_coverage(text, int) is
  '🛑 WHAT A TAG-FILTERED SECTION CANNOT SEE. Print it WITH the section, always. '
  'A tag-filtered read reports only what is tagged, so a thin section and a thin '
  'listening habit are indistinguishable without this — the same failure as '
  'migration 013''s definition string, a number describing its own coverage as if '
  'it described the world. '
  '`untagged_derivable` are FACTS (the artist is on a track in a playlist whose '
  'kind matches the tag) and may be written without asking. `untagged_proposals` '
  'are JUDGEMENTS and must be approved by a human — some of those strings are '
  'scraped bylines (§14.9). '
  '⚠️ tagged_rejected counts artists considered and DECLINED. They are decided, '
  'not missing, and must never be re-proposed.';

-- ---------------------------------------------------------------------------
-- dj_tag_candidates — the untagged artists, facts first
-- ---------------------------------------------------------------------------
create or replace function public.dj_tag_candidates(
  p_tag         text default 'jazz',
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
  derivable       boolean
)
language sql
stable
as $$
  with decided as (
    select at.artist from public.dj_artist_tags at where at.tag = p_tag
  ),
  derivable as (
    select distinct t.artist
    from public.dj_playlist_tracks pt
    join public.dj_playlists pl on pl.id = pt.playlist_id
    join public.dj_tracks t on t.id = pt.track_id
    where pl.kind = p_tag and t.artist is not null and t.artist <> ''
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
      -- ⚠️ EXCLUDES REJECTED AS WELL AS ACTIVE. Both are decided. Proposing a
      -- declined artist again is the behaviour §11.7 says will be ignored.
      and t.artist not in (select artist from decided)
  )
  select pl.artist,
         count(distinct pl.played_on)::int as distinct_days,
         count(*)::int                     as play_rows,
         count(distinct pl.grp)::int       as distinct_groups,
         max(pl.played_on)                 as last_played_on,
         (pl.artist in (select artist from in_pl)) as in_any_playlist,
         (pl.artist in (select artist from derivable)) as derivable
  from played pl
  group by pl.artist
  -- Facts before judgements: a derivable row needs no decision at all, and
  -- burying it under a list of judgement calls invites it to be treated as one.
  order by (pl.artist in (select artist from derivable)) desc,
           count(distinct pl.played_on) desc, count(*) desc, pl.artist
  limit p_limit;
$$;

comment on function public.dj_tag_candidates(text, int, int) is
  'Played artists in the window carrying NO decision for this tag — neither '
  'active nor rejected. The input to the weekly item''s "shall I tag these?" '
  'proposal. '
  '🛑 `derivable: true` IS A FACT, NOT A PROPOSAL. The artist is on a track in a '
  'playlist whose kind matches the tag, which is migration 013''s artist arm; '
  'write those without asking, with source=''playlist''. Ordered first for that '
  'reason — burying a fact in a list of judgements invites it to be treated as '
  'one. '
  '⚠️ `derivable: false` IS A JUDGEMENT and needs a human. §14.9: at least one '
  'artist string is a scraped channel byline with a view count in it, and '
  'tagging an unknown to make a list longer is how a curated allowlist stops '
  'being curated. '
  '⚠️ REJECTED ARTISTS ARE EXCLUDED. They are decided, not missing.';

-- ---------------------------------------------------------------------------
-- VERIFY — the merge preserved the arm rather than deleting it
-- ---------------------------------------------------------------------------
do $$
declare
  derived_n   int;
  monk_tags   text[];
  cov         record;
  jazz_n      int;
  still_there int;
begin
  -- 1. 🛑 THE CLAIM THIS MIGRATION MAKES ABOUT ITSELF. "The playlist arm now
  --    writes tags instead of being recomputed" is only true if the rows exist.
  --    Twelve artists reached the old jazz report on 2026-09-02; the playlist
  --    arms accounted for all of them.
  select count(*) into derived_n
  from public.dj_artist_tags where tag = 'jazz' and source = 'playlist';

  if derived_n = 0 then
    raise exception
      'No playlist-derived jazz tags were written. The seed matched nothing, so '
      'the playlist arm has been DELETED rather than converted — which is the '
      'one claim this migration must not make falsely.';
  end if;
  raise notice 'Playlist arm stored as % tag row(s).', derived_n;

  -- 2. 017's curated rows survived with their provenance intact. Overwriting
  --    `source` on a human judgement would erase the record that anyone decided.
  select count(*) into still_there
  from public.dj_artist_tags where tag = 'jazz' and source = 'manual';
  if still_there < 12 then
    raise exception
      'Expected 017''s 12 curated tags to survive as source=manual, found %. '
      'The seed has overwritten a human judgement.', still_there;
  end if;

  -- 3. Monk still arrives, through the merged definition rather than the old one.
  select tags into monk_tags
  from public.dj_artist_activity(3650, 500) where artist = 'Thelonious Monk';

  if monk_tags is null or not ('jazz' = any(monk_tags)) then
    raise exception
      'Thelonious Monk is not carrying the jazz tag through dj_artist_activity. '
      'The merged Section 3 cannot see the artist whose invisibility was the '
      'reason for merging it.';
  end if;

  -- 4. The filtered read returns rows, and is a SUBSET of the unfiltered one.
  select count(*) into jazz_n from public.dj_artist_activity(90, 500, 'jazz');
  if jazz_n = 0 then
    raise exception
      'dj_artist_activity(90, 500, ''jazz'') returned nothing. The tag filter '
      'matches no played artist, so Section 3 would print empty.';
  end if;
  raise notice 'Section 3 over 90 days: % tagged artist(s) played.', jazz_n;

  -- 5. ⚠️ COVERAGE ANSWERS, AND ITS PARTS AGREE. An invariant rather than a
  --    plausibility check: the split must exhaust the total, or the report's
  --    "what I cannot see" number is quietly wrong in one of the two directions
  --    that matters.
  select * into cov from public.dj_tag_coverage('jazz', 90);
  if cov.untagged_total <> cov.untagged_derivable + cov.untagged_proposals then
    raise exception
      'dj_tag_coverage: untagged_total (%) <> derivable (%) + proposals (%).',
      cov.untagged_total, cov.untagged_derivable, cov.untagged_proposals;
  end if;
  raise notice
    'Coverage: % played artists, % tagged, % untagged (% derivable, % to propose).',
    cov.played_artists, cov.tagged_active, cov.untagged_total,
    cov.untagged_derivable, cov.untagged_proposals;

  -- 6. 🛑 NEGATIVE CONTROL FOR THE SEED ITSELF. Having just written every
  --    playlist-derived artist, there must be NO derivable candidates left. If
  --    there are, the seed and the candidates query disagree about what
  --    "derivable" means — and the report would propose facts as judgements
  --    every week while the seed believed it was done.
  if cov.untagged_derivable <> 0 then
    raise exception
      '% derivable artist(s) remain untagged immediately after the seed ran. '
      'The seed and dj_tag_candidates disagree about what counts as derivable.',
      cov.untagged_derivable;
  end if;

  -- 7. dj_jazz_activity is gone. A merge that leaves the old function callable
  --    has not merged anything — it has added a third definition.
  if exists (
    select 1 from pg_proc pr
    join pg_namespace n on n.oid = pr.pronamespace
    where n.nspname = 'public' and pr.proname = 'dj_jazz_activity'
  ) then
    raise exception
      'dj_jazz_activity still exists. One definition means one function; '
      'leaving the old one callable adds a definition rather than removing one.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Then, per platform house rules, finish the block with:
--   check_platform_conformance()
-- EXPECT: CONFORMANT. No new tables — dj_artist_tags was registered by 016 — but
-- this file ALTERS it, and the check is what proves the registration still holds
-- rather than the assumption that adding a column cannot break it.
-- ---------------------------------------------------------------------------
