-- 057 - sam_session_events: correct two column comments after piano testing
--
-- COMMENTS ONLY. No schema change, no data change. Run in the Supabase SQL
-- editor. Migration 030 is already applied and is left untouched; this
-- supersedes two of its comments.
--
-- Kind: comment-only change (apply once)
--
-- ============================================================================
-- WHY
-- ============================================================================
-- Two things 030 described are no longer true of what the app writes:
--
-- 1. A MISS CAN CARRY PITCHES. 030 said played_notes is "empty for a miss
--    raised by the scanner". Two paths put notes on a miss:
--      - the ordinary scoring path, where a chord with SOME wrong notes and a
--        missing expected note scores a miss (matchChord returns miss whenever
--        a played note is wrong and an expected one is absent) — this has
--        always been so;
--      - from 2026-09-18, an ALL-wrong chord: it leaves the beat pending, and
--        when the scanner times the beat out the keys struck are attached to
--        that miss. Part 1 briefly wrote a separate `extra` row for this, which
--        made one fumble two rows; that is withdrawn. ONE BEAT, ONE ROW.
--    Notes carried this way are NOT counted: they never reach notesPlayed, so
--    no score moves. The miss stays a miss.
--
-- 2. AN EXTRA'S OFFSET IS OFTEN MEANINGLESS. An `extra` is a keystroke that
--    matched no beat, so its "offset" is the distance to the nearest pending
--    beat — which live data showed reaching 4,389 ms. That is not early or
--    late, it is unattached, and a reader could average it. From 2026-09-18 the
--    offset is stored only when it is within TWICE the session's matching
--    window (settings.windowMs), and NULL otherwise. Twice the window was
--    chosen over a fraction of a beat because windowMs is already the app's own
--    definition of "close enough to be an attempt at this beat", so the rule
--    scales with how strict the session was rather than with its tempo.

comment on column public.sam_session_events.played_notes is
  'MIDI numbers struck for this beat. On a hit or a partial, what was played. On a MISS it is '
  'either empty (the beat passed with nothing struck at it) or the wrong keys that were struck '
  'at it — from the ordinary scoring path, where a chord with some wrong notes and a missing '
  'expected note scores a miss, or (from 2026-09-18) from an all-wrong chord that left the beat '
  'pending until the scanner timed it out. Wrong keys carried on a miss are NOT counted toward '
  'notesPlayed or any score: the miss stays a miss. On an EXTRA row this is the stray keystroke '
  'itself — the answer to "what am I hitting instead". ONE FUMBLE IS ONE ROW: an all-wrong chord '
  'no longer also writes a companion extra row (it did briefly on 2026-09-18), so a per-measure '
  'count of wrong notes cannot double-count it.';

comment on column public.sam_session_events.timing_delta_ms is
  'Signed milliseconds between the beat''s expected onset and when it was played: POSITIVE = '
  'EARLY (rushing), NEGATIVE = LATE (dragging). This is `targetTimeMs - elapsed` from '
  'src/sam/lib/noteMatching.js. ⚠️ The comment here said the opposite until 2026-09-18. NULL for '
  'a miss (nothing was played to time). ON AN EXTRA ROW it is the offset to the nearest pending '
  'beat, and is NULL whenever that beat is further away than TWICE the session''s matching '
  'window (settings.windowMs): a keystroke that far from anything is unattached rather than '
  'early or late, and storing the number invites a meaningless average. Before 2026-09-18 '
  'extras stored it regardless, and values of several seconds exist — treat extra offsets from '
  'before that date as noise. THREE LIMITS ON ANY AVERAGE: (1) a keystroke further out than '
  'windowMs matches no beat, so extremes are invisible and the mean is pulled toward zero; '
  '(2) any fixed MIDI or audio latency rides along as a constant offset; (3) different windowMs '
  'values are not comparable. Comparisons WITHIN one session are far more reliable than '
  'absolute values.';

comment on column public.sam_session_events.result is
  'What happened at this beat. hit — every expected note played within the window; a wrong key '
  'struck and corrected in time still counts as a hit, deliberately. miss — the beat was not '
  'played correctly: either nothing was struck at it, or what was struck was wrong (see '
  'played_notes). partial — some but not all of the beat''s notes; counts as NEITHER hit nor '
  'miss in the accuracy ratio and is reported separately. extra — a keystroke that was NOT AN '
  'ATTEMPT AT ANY BEAT: it matched nothing within the window. Scoreless, never counted toward '
  'attempts, hits, misses, accuracy or timing averages, with the struck pitch in played_notes '
  'and expected_notes empty. An attempt at a beat that was simply wrong is a MISS carrying its '
  'pitches, not an extra. wrong — legal but never written.';

-- ============================================================================
-- CONFORMANCE — every migration block ends here. Expected: CONFORMANT.
-- ============================================================================
select platform.check_conformance();
