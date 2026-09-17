-- 029 - sam_session_events: accept every result the app records, and correct
--       the timing sign in the column comment
--
-- Run in the Supabase SQL editor as one block. Run this BEFORE deploying the
-- matching app change, and before the backfill
-- (supabase/migrations/056_backfill_sam_session_events.sql).
--
-- ============================================================================
-- WHY
-- ============================================================================
-- The app scores four outcomes per beat — hit, partial, wrong (all from the
-- MIDI match in SamPlayer.handleChord) and miss (raised by ScrollEngine's miss
-- scanner when a beat passes unplayed). The check constraint accepted only
-- 'hit' and 'miss', so any insert batch containing a partial or a wrong note
-- was rejected WHOLESALE, and the writer stopped there: every later batch of
-- that session was skipped too.
--
-- The damage, measured 2026-09-17: 93,672 rows covering 1,137 of 2,204 ended
-- sessions, and only 'hit' and 'miss' values present. The jsonb copy in
-- sam_sessions.events, which no constraint filters, covers 1,919 of those
-- sessions. The rows that never landed are exactly the ones about mistakes —
-- the opposite of what per-measure analysis needs.
--
-- ⚠️ THE TIMING SIGN IN THE OLD COMMENT WAS BACKWARDS. The value comes from
-- `evt.targetTimeMs - elapsed` (src/sam/lib/noteMatching.js:54): a beat still
-- in the future is POSITIVE, and that means the player pressed EARLY. The old
-- comment said the opposite, so anything written against it read rushing as
-- dragging. Nothing in code was relying on it; the app's own displays follow
-- the code.

alter table public.sam_session_events
  drop constraint if exists sam_session_events_result_check;

alter table public.sam_session_events
  add constraint sam_session_events_result_check
  check (result = any (array['hit', 'miss', 'partial', 'wrong']));

comment on column public.sam_session_events.result is
  'What the player did with this expected beat. One of four values, all written by the app: '
  '''hit'' — every expected note of the beat played within the timing window; '
  '''partial'' — some but not all of the beat''s notes played (the app counts a partial as '
  'NEITHER a hit nor a miss: it sits outside the accuracy ratio, and is reported separately); '
  '''wrong'' — played, but with notes that do not belong to the beat; '
  '''miss'' — the beat passed unplayed, raised on elapsed time without consulting MIDI, so a '
  'session played with no keyboard attached is a full count of misses. '
  'Before migration 029 only ''hit'' and ''miss'' could be stored.';

comment on column public.sam_session_events.timing_delta_ms is
  'Signed milliseconds between the beat''s expected onset and the moment it was played: '
  'POSITIVE = EARLY (rushing), NEGATIVE = LATE (dragging). This is `targetTimeMs - elapsed` '
  'from src/sam/lib/noteMatching.js. ⚠️ The comment here said the opposite until 2026-09-18; '
  'the code has always been this way. NULL for a miss (nothing was played to time). '
  'Two caveats for any average: a keypress further from its beat than the session''s '
  'settings.windowMs (default 300) matches no beat at all and is never recorded, so the '
  'magnitude is truncated and the mean is pulled toward zero; and any fixed MIDI or audio '
  'latency lands in every row as a constant offset. Comparisons within one session are '
  'firmer than absolute values.';

-- ============================================================================
-- CONFORMANCE — every migration block ends here. Expected: CONFORMANT.
-- ============================================================================
select platform.check_conformance();
