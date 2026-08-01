-- Migration: Drop sam_sessions.duration_seconds
-- Run this in the Supabase SQL Editor (https://supabase.com/dashboard → SQL Editor)
--
-- The column was declared in 001_sam_tables.sql but usePracticeSession.endSession()
-- was never wired to write it, so every row has duration_seconds = NULL. All read
-- paths (usePracticeStats, the get_sam_sessions MCP tool after this migration
-- lands) derive elapsed time from ended_at - started_at instead. Rather than
-- backfill + wire the write, we drop the column so there is one source of truth.
--
-- Guard first — if anything wrote a value since the audit, abort so we don't
-- silently discard data. Fix the writer, verify NULL-only again, then re-run.

DO $$
DECLARE
  populated_count INTEGER;
BEGIN
  SELECT count(*) INTO populated_count
  FROM public.sam_sessions
  WHERE duration_seconds IS NOT NULL;

  IF populated_count > 0 THEN
    RAISE EXCEPTION
      'Aborting: % row(s) in public.sam_sessions have a non-NULL duration_seconds. '
      'The audit that authorized this drop assumed the column was NULL-only. '
      'Investigate the writer, decide whether to preserve the values, and re-run.',
      populated_count;
  END IF;
END $$;

ALTER TABLE public.sam_sessions DROP COLUMN duration_seconds;

COMMENT ON COLUMN public.sam_sessions.ended_at IS
  'When the practice session ended cleanly. Practice time is derived as '
  '(ended_at - started_at); there is no stored duration column. '
  'NULL means the session was abandoned without a clean end (browser close, '
  'lyric-check, navigation away) and MUST contribute zero to practice-time '
  'totals — not be treated as a zero-length session. If a distinction between '
  'wall-clock elapsed and engaged/attentive time is ever needed, add a '
  'separately named column such as active_seconds; do not overload this one.';
