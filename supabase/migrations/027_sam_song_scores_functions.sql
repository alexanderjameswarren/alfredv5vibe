-- 027 - sam_song_scores: the freshness check and the wholesale replace
--
-- Analyzer port, M4. Spec: docs/technical-spec-analyzer-port.md §4 M4.
-- Run in the Supabase SQL editor as one block, after 026.
--
-- Two functions, both SECURITY INVOKER — they run as the caller, so the
-- parent-scoped RLS on sam_songs and sam_song_scores applies exactly as it does
-- to a direct query. Neither can see or touch another user's songs.
--
-- ============================================================================
-- WHY FUNCTIONS AT ALL
-- ============================================================================
-- 1. The freshness check must be the FIRST thing a compute does, and must not
--    read a single measure row. Lyric placement stamps measures_edited_at once
--    per syllable (371 times for Someone Like You), so a lyric session reaches
--    the compute path hundreds of times; each of those must cost one cheap
--    call. Comparing in SQL also keeps the timestamps exact: PostgREST returns
--    timestamptz with microseconds and JS Date would truncate them, so the
--    equality is never done in JavaScript.
-- 2. The replace must be delete-then-insert in ONE transaction. PostgREST runs
--    each request in its own transaction, so two requests could leave a song
--    with no scores, or half of them. A function call is one transaction.

-- ----------------------------------------------------------------------------
-- sam_song_scores_freshness(song, version)
-- ----------------------------------------------------------------------------
-- One row for a song the caller can see, none otherwise.
--   fresh               every stored row has this scores_version AND was
--                       computed from the song's current measures_edited_at
--                       (IS NOT DISTINCT FROM, so NULL matches NULL). False
--                       when there are no stored rows.
--   measures_edited_at  the value to stamp on rows computed now. Read HERE,
--                       before any measure is read: if the measures change
--                       mid-compute, the rows carry the older stamp and the
--                       next check recomputes — never the reverse.
--   stored_rows         how many score rows exist, so a song whose measures
--                       were all removed can have its old scores cleared.
-- Touches sam_songs and sam_song_scores only. Never sam_song_measures.
create or replace function public.sam_song_scores_freshness(
  p_song_id        uuid,
  p_scores_version integer
)
returns table (fresh boolean, measures_edited_at timestamptz, stored_rows integer)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    coalesce(
      bool_and(
        sc.scores_version = p_scores_version
        and sc.computed_from_edited_at is not distinct from s.measures_edited_at
      ),
      false
    )                             as fresh,
    s.measures_edited_at          as measures_edited_at,
    count(sc.song_id)::integer    as stored_rows
  from public.sam_songs s
  left join public.sam_song_scores sc on sc.song_id = s.id
  where s.id = p_song_id
  group by s.id, s.measures_edited_at
$$;

comment on function public.sam_song_scores_freshness(uuid, integer) is
  'SAM analyzer (M4). Is this song''s stored difficulty data current? Equality check: every row '
  'must carry p_scores_version and a computed_from_edited_at that IS NOT DISTINCT FROM the song''s '
  'measures_edited_at. Reads sam_songs and sam_song_scores only — never sam_song_measures — so a '
  'fresh song costs one cheap call. Returns no row for a song the caller cannot see.';

-- ----------------------------------------------------------------------------
-- replace_sam_song_scores(song, version, computed_from, rows)
-- ----------------------------------------------------------------------------
-- Deletes every score row for the song and inserts `p_rows` (a JSON array of
-- objects keyed by column name), stamping each with p_scores_version and
-- p_computed_from. One transaction. Returns the number of rows inserted.
-- An empty array clears the song's scores.
--
-- The column list below is also read by tools/sam-tools/test/samScores.test.js,
-- which fails if it drifts from the rows the Edge Function builds.
create or replace function public.replace_sam_song_scores(
  p_song_id        uuid,
  p_scores_version integer,
  p_computed_from  timestamptz,
  p_rows           jsonb
)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_inserted integer;
begin
  -- Under RLS a song the caller does not own is simply invisible, which would
  -- otherwise turn this into a silent no-op.
  if not exists (select 1 from public.sam_songs where id = p_song_id) then
    raise exception 'replace_sam_song_scores: song % not found', p_song_id
      using errcode = 'P0002';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'replace_sam_song_scores: p_rows must be a JSON array';
  end if;

  delete from public.sam_song_scores where song_id = p_song_id;

  insert into public.sam_song_scores (
    song_id, measure_number, beats, rh_onsets, lh_onsets, rh_stack, lh_stack,
    rh_stretch, lh_stretch, rh_jump, lh_jump, rhythm_variety, accidentals,
    scores_version, computed_from_edited_at
  )
  select
    p_song_id, r.measure_number, r.beats, r.rh_onsets, r.lh_onsets, r.rh_stack, r.lh_stack,
    r.rh_stretch, r.lh_stretch, r.rh_jump, r.lh_jump, r.rhythm_variety, r.accidentals,
    p_scores_version, p_computed_from
  from jsonb_to_recordset(p_rows) as r(
    measure_number integer,
    beats          double precision,
    rh_onsets      integer,
    lh_onsets      integer,
    rh_stack       integer,
    lh_stack       integer,
    rh_stretch     integer,
    lh_stretch     integer,
    rh_jump        integer,
    lh_jump        integer,
    rhythm_variety integer,
    accidentals    integer
  );

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

comment on function public.replace_sam_song_scores(uuid, integer, timestamptz, jsonb) is
  'SAM analyzer (M4). Replace one song''s difficulty rows wholesale — delete then insert in one '
  'transaction — stamping each with the scores version and the measures_edited_at value they were '
  'computed from. Called by the sam-scores Edge Function. Returns rows inserted; [] clears.';

-- Callable by signed-in users only (RLS still confines them to their songs).
revoke all on function public.sam_song_scores_freshness(uuid, integer) from public, anon;
revoke all on function public.replace_sam_song_scores(uuid, integer, timestamptz, jsonb) from public, anon;
grant execute on function public.sam_song_scores_freshness(uuid, integer) to authenticated;
grant execute on function public.replace_sam_song_scores(uuid, integer, timestamptz, jsonb) to authenticated;

-- ============================================================================
-- CONFORMANCE — every migration block ends here. Expected: CONFORMANT.
-- ============================================================================
select platform.check_conformance();
