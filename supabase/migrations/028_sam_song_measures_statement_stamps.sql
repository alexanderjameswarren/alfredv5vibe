-- 028 - sam_song_measures: stamp the song on INSERT and DELETE, once per statement
--
-- Analyzer port, M6. Spec: docs/technical-spec-analyzer-port.md §4 M6.
-- Run in the Supabase SQL editor as one block. Verify with
-- supabase/migrations/055_verify_analyzer_port_m6.sql.
--
-- ============================================================================
-- WHY
-- ============================================================================
-- Stored scores are fresh when their computed_from_edited_at EQUALS the song's
-- measures_edited_at. That check can only fail safe (recompute when it need
-- not) as long as every change to a song's measures moves the stamp. Before
-- this migration, one did not:
--
--   * bump_parent_edited_at stamps on UPDATE only.
--   * INSERT and DELETE of measure rows stamped nothing. Import
--     (fanOutMeasures), append_sam_measures and the backfill script each stamp
--     from app code, in a SEPARATE request after the write. If that request
--     fails, or a future writer or raw SQL forgets it, the measures change,
--     the stamp does not, and stale scores read as FRESH. That was the one
--     failure mode in the design that reports stale as fresh.
--
-- These triggers stamp in the same transaction as the write, for every writer.
--
-- ============================================================================
-- SHAPE
-- ============================================================================
-- * STATEMENT-level, with transition tables: one UPDATE of sam_songs per
--   affected song per statement, however many measure rows the statement
--   touched. A 160-measure import is one DELETE statement plus one INSERT per
--   batch (500 rows), so about two stamps, not 320. sam_songs is audited and
--   its audit rows carry the measures blob, which is why the count matters.
-- * Two triggers, one function. Postgres allows transition tables only on
--   single-event triggers, so INSERT and DELETE are separate triggers; the
--   function picks its transition table by TG_OP.
-- * Stamps with now(), the database clock. Nothing compares this value with
--   another timestamp; the scores check is equality, so the two-clock problem
--   (app code stamps with the client clock) does not reach scores.
-- * No "already equal" guard: each statement stamps each of its songs exactly
--   once. That keeps the once-per-statement property directly testable.
-- * SECURITY INVOKER. The writer can already see the parent song (the measures
--   RLS is parent-scoped), so the stamp runs under the same RLS as the write.
-- * A song being deleted: its measures cascade, this trigger fires, and the
--   UPDATE finds no row to stamp. The verification proves that rather than
--   assuming it. (stamp_song_edited already does the same for lyrics.)
--
-- LEFT ALONE, deliberately: the per-row UPDATE trigger bump_parent_edited_at,
-- and the app-code stamps (they still set measures_compiled_at, which the
-- blob recompile relies on).

create or replace function public.stamp_songs_from_measure_statement()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.sam_songs s
       set measures_edited_at = now()
     where s.id in (select distinct n.song_id from new_rows n);
  elsif tg_op = 'DELETE' then
    update public.sam_songs s
       set measures_edited_at = now()
     where s.id in (select distinct o.song_id from old_rows o);
  end if;
  return null;
end;
$$;

comment on function public.stamp_songs_from_measure_statement() is
  'SAM analyzer (M6). Statement-level trigger function on sam_song_measures INSERT and DELETE: '
  'sets measures_edited_at = now() once for each song the statement touched, in the same '
  'transaction as the write, so no writer can change measures without invalidating stored '
  'scores. UPDATE is covered separately by the per-row bump_parent_edited_at trigger.';

revoke all on function public.stamp_songs_from_measure_statement() from public, anon;

drop trigger if exists stamp_song_on_measures_insert on public.sam_song_measures;
create trigger stamp_song_on_measures_insert
  after insert on public.sam_song_measures
  referencing new table as new_rows
  for each statement
  execute function public.stamp_songs_from_measure_statement();

drop trigger if exists stamp_song_on_measures_delete on public.sam_song_measures;
create trigger stamp_song_on_measures_delete
  after delete on public.sam_song_measures
  referencing old table as old_rows
  for each statement
  execute function public.stamp_songs_from_measure_statement();

comment on trigger stamp_song_on_measures_insert on public.sam_song_measures is
  'SAM analyzer (M6). Once per INSERT statement, stamps sam_songs.measures_edited_at for every song inserted into.';
comment on trigger stamp_song_on_measures_delete on public.sam_song_measures is
  'SAM analyzer (M6). Once per DELETE statement, stamps sam_songs.measures_edited_at for every song deleted from (a song being deleted matches no row).';

-- 027's comment named the Edge Function by its old name (renamed in M6).
comment on function public.replace_sam_song_scores(uuid, integer, timestamptz, jsonb) is
  'SAM analyzer (M4). Replace one song''s difficulty rows wholesale — delete then insert in one '
  'transaction — stamping each with the scores version and the measures_edited_at value they were '
  'computed from. Called via computeSongScores (the sam-song-scores Edge Function and the '
  'get_sam_song_scores MCP tool). Returns rows inserted; [] clears.';

-- ============================================================================
-- CONFORMANCE — every migration block ends here. Expected: CONFORMANT.
-- ============================================================================
select platform.check_conformance();
