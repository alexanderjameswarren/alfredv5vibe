-- 030 - sam_session_events: accept 'extra', and write the scoring rules down
--
-- Run in the Supabase SQL editor as one block, AFTER 029, and BEFORE deploying
-- the app change that starts writing `extra` rows. Deploying first is not
-- harmful — every extra would simply be refused row by row and logged, and no
-- score or session would be affected — but no wrong keystrokes would be kept.
--
-- ============================================================================
-- WHAT 'extra' IS
-- ============================================================================
-- A keystroke that belonged to no expected beat: a wrong key, or a note so far
-- from its beat that the matcher refused it. Until now these were discarded, so
-- "which measures do I miss" could be answered but "what am I hitting instead"
-- could not. The value was already named in the old column comment; nothing
-- ever wrote it.
--
-- An 'extra' row is SCORELESS BY CONSTRUCTION. The app records it without
-- touching any counter, and no reader may count it toward attempts, hits,
-- misses, accuracy or timing averages.
--
-- 'wrong' remains legal but has never been written and is not expected to be:
-- an all-wrong chord is left pending and later timed out by the miss scanner as
-- a plain 'miss'. From 2026-09-18 the keys struck in that attempt are kept as
-- an accompanying 'extra' row instead.

alter table public.sam_session_events
  drop constraint if exists sam_session_events_result_check;

alter table public.sam_session_events
  add constraint sam_session_events_result_check
  check (result = any (array['hit', 'miss', 'partial', 'wrong', 'extra']));

-- ============================================================================
-- THE SCORING DEFINITIONS, ON THE TABLE ITSELF
-- ============================================================================
comment on table public.sam_session_events is
$$SAM. Per-beat practice telemetry: one row per expected beat per attempt, plus one row per
stray keystroke. HIGH VOLUME — audited => false. Never select it unaggregated across sessions;
query by session_id or by (song_id, measure_number). Full prose: docs/sam-scoring-definitions.md.

HOW SCORING WORKS (read before computing anything from this table):
* result is one of hit, miss, partial, extra. ('wrong' is permitted by the constraint but has
  never been written — see the result column comment.)
* ACCURACY IS hits / (hits + misses). A partial is NEITHER: it sits outside the ratio and is
  reported separately. An extra is outside everything.
* A WRONG KEY STRUCK AND CORRECTED WITHIN THE WINDOW STILL SCORES AS A HIT. That is deliberate:
  the score measures whether the passage was played, and punishing a recovered slip would make
  it less useful. The stray key is recorded as its own extra row, which changes no score.
* THE MATCHING WINDOW DECIDES HOW FORGIVING SCORING IS. It is per session, in
  sam_sessions.settings.windowMs (default 300 ms): a keystroke further from its beat than that
  matches nothing. ⚠️ THE SAME PASSAGE PRACTISED AT DIFFERENT WINDOW SETTINGS IS NOT
  COMPARABLE — tightening the window lowers accuracy on identical playing, and reading that
  as getting worse is a mistake. Always report the window(s) behind any figure.
* DATES THAT LIMIT THE DATA: events from 2026-02-14; 'partial' rows only from 2026-09-18
  onward, except where the 2026-09-18 backfill recovered earlier ones from sam_sessions.events;
  'extra' rows from 2026-09-18 onward only; sam_passes carries hits/misses/notes_played/
  accuracy_percent only from 2026-09-16. 285 ended sessions (tab closed mid-practice) have no
  rows here and never will. 3,295 backfilled rows have a null measure_id because their song was
  re-imported since; their measure_number is correct.$$;

comment on column public.sam_session_events.result is
  'What happened at this beat. hit — every expected note played within the window; a wrong key '
  'struck and corrected in time still counts as a hit, deliberately. miss — the beat passed '
  'unplayed, raised on elapsed time without consulting MIDI, so a session with no keyboard '
  'attached records a full count of misses. partial — some but not all of the beat''s notes; '
  'counts as NEITHER hit nor miss in the accuracy ratio and is reported separately. extra — a '
  'keystroke matching no expected beat (a wrong key, or one too far from its beat to match): '
  'SCORELESS, never counted toward attempts, hits, misses, accuracy or timing averages, with '
  'the struck pitch in played_notes and expected_notes empty. wrong — legal but never written: '
  'an all-wrong chord stays pending and is timed out as a plain miss, with the keys struck '
  'kept as an accompanying extra row (from 2026-09-18).';

comment on column public.sam_session_events.timing_delta_ms is
  'Signed milliseconds between the beat''s expected onset and when it was played: POSITIVE = '
  'EARLY (rushing), NEGATIVE = LATE (dragging). This is `targetTimeMs - elapsed` from '
  'src/sam/lib/noteMatching.js. ⚠️ The comment here said the opposite until 2026-09-18. NULL '
  'for a miss. THREE LIMITS ON ANY AVERAGE: (1) a keystroke further out than the session''s '
  'settings.windowMs matches no beat, so extremes are invisible and the mean is pulled toward '
  'zero; (2) any fixed MIDI or audio latency rides along as a constant offset on every row; '
  '(3) different windowMs values are not comparable. Comparisons WITHIN one session are far '
  'more reliable than absolute values. On an extra row it is the offset to the nearest pending '
  'beat, recorded for context only.';

comment on column public.sam_session_events.played_notes is
  'MIDI numbers actually struck for this beat. Empty for a miss raised by the scanner (nothing '
  'was played). On an extra row this is the stray keystroke — the answer to "what am I hitting '
  'instead".';

comment on column public.sam_session_events.expected_notes is
  'MIDI numbers the beat called for, in the session''s hand mode. Empty on an extra row, which '
  'belongs to no beat.';

comment on column public.sam_session_events.measure_number is
  'PLAYED measure number, repeats written out — the same numbering snippets and the score use. '
  'The printed number is sam_song_measures.source_measure, which differs wherever a bar '
  'repeats. measure_id may be null (song re-imported since) but this stays correct. On an '
  'extra row it is the measure of the nearest pending beat.';

comment on column public.sam_session_events.loop_iteration is
  'Which repetition of a looped range, 0-indexed. A drilled bar contributes one row per beat '
  'per cycle, so any per-measure rate must say how many iterations it is averaging over, or a '
  'heavily looped bar silently dominates. It resets when a mid-play setting change restarts '
  'the scroll, so it counts cycles rather than identifying them.';

-- ============================================================================
-- CONFORMANCE — every migration block ends here. Expected: CONFORMANT.
-- ============================================================================
select platform.check_conformance();
