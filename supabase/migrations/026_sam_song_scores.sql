-- 026 - sam_song_scores: per-measure difficulty facts, tempo-independent
--
-- Analyzer port, M3. Spec: docs/technical-spec-analyzer-port.md §4 M3.
-- Run in the Supabase SQL editor as one block. Nothing writes to this table
-- until M4.
--
-- ============================================================================
-- WHAT GOES IN, AND WHAT DELIBERATELY DOES NOT
-- ============================================================================
-- One row per played measure: the output of analyzeSongFacts() in
-- supabase/functions/_shared/analyze.ts, which takes no tempo.
--
-- 🛑 NO notes_per_second AND NO FLAGS. notesPerSecond is the one metric that
-- depends on tempo, and the NS flag gates it, so either stored value is only
-- true at the tempo it was computed at. Both are derived on read by
-- measureAtTempo(facts, bpm), against the THRESHOLDS in code. Counts are
-- stored rather than rates (rh_onsets, not notes-per-beat): the rate is the
-- count divided by beats, and storing the division means multiplying back.
--
-- ============================================================================
-- THE KEY
-- ============================================================================
-- 🛑 (song_id, measure_number) — NEVER a foreign key to sam_song_measures.id.
-- fanOutMeasures deletes every measure row for a song and reinserts it on each
-- import, so row ids change; a cascading FK to them would silently wipe the
-- scores. measure_number is sam_song_measures.number, the PLAYED number — the
-- same number snippets (start_measure/end_measure) and simplifier plans use.
-- The only foreign key is to the song, and deleting the song takes its scores.
--
-- ============================================================================
-- FRESHNESS
-- ============================================================================
-- computed_from_edited_at holds the sam_songs.measures_edited_at value the row
-- was computed from. Scores are fresh iff, for the song,
--     computed_from_edited_at IS NOT DISTINCT FROM sam_songs.measures_edited_at
--     AND scores_version = <the analyzer's current SCORES_VERSION>
-- An EQUALITY check, not a timestamp comparison: measures_edited_at is written
-- by client clocks on different machines, and equality never compares two of
-- them. IS NOT DISTINCT FROM so that a song whose measures_edited_at is null
-- compares equal to a row computed from null.

create table public.sam_song_scores (
  song_id                 uuid not null
                            references public.sam_songs(id) on delete cascade,
  measure_number          integer not null check (measure_number >= 1),

  beats                   double precision not null check (beats >= 0),
  rh_onsets               integer not null check (rh_onsets >= 0),
  lh_onsets               integer not null check (lh_onsets >= 0),
  rh_stack                integer not null check (rh_stack >= 0),
  lh_stack                integer not null check (lh_stack >= 0),
  rh_stretch              integer not null check (rh_stretch >= 0),
  lh_stretch              integer not null check (lh_stretch >= 0),
  rh_jump                 integer not null check (rh_jump >= 0),
  lh_jump                 integer not null check (lh_jump >= 0),
  rhythm_variety          integer not null check (rhythm_variety >= 0),
  accidentals             integer check (accidentals >= 0),

  scores_version          integer not null check (scores_version >= 1),
  computed_from_edited_at timestamptz,
  computed_at             timestamptz not null default now(),

  primary key (song_id, measure_number)
);

-- The primary key's index serves both read paths: every row for a song, and a
-- measure range within one (song_id = $1 and measure_number between $2 and $3).
-- No further index is needed.

comment on table public.sam_song_scores is
  'SAM. Per-measure difficulty facts from the analyzer (supabase/functions/_shared/analyze.ts, '
  'analyzeSongFacts), one row per PLAYED measure. TEMPO-INDEPENDENT ONLY: notes-per-second and '
  'flags are derived on read at a resolved tempo (explicit argument -> sam_songs.goal_effective_bpm '
  '-> error; never goal_bpm, never default_bpm) and are never stored. DERIVED DATA: rows are '
  'replaced wholesale per song and are safe to delete and recompute. Keyed on (song_id, '
  'measure_number), never on sam_song_measures.id, because import deletes and reinserts measure '
  'rows. RLS inherited via the parent song.';

comment on column public.sam_song_scores.song_id is
  'The song. ON DELETE CASCADE: deleting a song deletes its scores.';
comment on column public.sam_song_scores.measure_number is
  'sam_song_measures.number — the PLAYED measure number (1-based, repeats written out), the same '
  'number snippets and simplifier plans use. Not the printed number (source_measure).';
comment on column public.sam_song_scores.beats is
  'Measure length in QUARTER-NOTE beats, from the time signature: beats * 4 / beatType. A 6/8 bar '
  'is 3.0. double precision so the value round-trips exactly with the analyzer''s JS number.';
comment on column public.sam_song_scores.rh_onsets is
  'Right-hand sounding events in the measure (rests excluded; a chord is one onset). A count, not a '
  'rate: notes-per-beat is rh_onsets / beats, and notes-per-second is (rh_onsets + lh_onsets) / '
  '(beats * 60 / bpm), both derived on read.';
comment on column public.sam_song_scores.lh_onsets is
  'Left-hand sounding events in the measure (rests excluded; a chord is one onset). A count, not a '
  'rate — see rh_onsets.';
comment on column public.sam_song_scores.rh_stack is
  'Most simultaneous notes in one right-hand event.';
comment on column public.sam_song_scores.lh_stack is
  'Most simultaneous notes in one left-hand event.';
comment on column public.sam_song_scores.rh_stretch is
  'Widest right-hand chord, in semitones (top minus bottom of one event).';
comment on column public.sam_song_scores.lh_stretch is
  'Widest left-hand chord, in semitones (top minus bottom of one event).';
comment on column public.sam_song_scores.rh_jump is
  'Largest move, in semitones, between consecutive right-hand events, following the TOP note. '
  'Rests do not break the line.';
comment on column public.sam_song_scores.lh_jump is
  'Largest move, in semitones, between consecutive left-hand events, following the BOTTOM note. '
  'Rests do not break the line.';
comment on column public.sam_song_scores.rhythm_variety is
  'Distinct duration tokens per hand, the larger of the two hands (rests count as tokens). Per hand, '
  'not pooled: pooling rose when a simplification added a token, punishing the simplification.';
comment on column public.sam_song_scores.accidentals is
  'Note occurrences (not distinct pitches) outside the key signature''s diatonic set, both hands. '
  'NULL when the song''s key (fifths) is unknown — unmeasurable, not zero; never treat NULL as 0.';
comment on column public.sam_song_scores.scores_version is
  'Version of the analyzer''s metric DEFINITIONS that produced this row (SCORES_VERSION in code). '
  'Bumped whenever a definition changes — rhythm_variety already changed once, pooled -> per hand — '
  'so a row computed before a fix can be told apart and recomputed. Version 1 = the definitions at '
  'the analyzer port (branch analyzer-port, M2).';
comment on column public.sam_song_scores.computed_from_edited_at is
  'The sam_songs.measures_edited_at value these scores were computed from. The row is fresh iff it '
  'IS NOT DISTINCT FROM the song''s current measures_edited_at and scores_version is current — an '
  'equality check, never a timestamp comparison (the stamps come from different machines'' clocks). '
  'NULL when the song''s measures_edited_at was NULL at compute time.';
comment on column public.sam_song_scores.computed_at is
  'When this row was computed. Informational only — freshness is decided by '
  'computed_from_edited_at and scores_version, never by this.';

-- ============================================================================
-- PLATFORM REGISTRATION
-- ============================================================================
-- p_policy_mode => 'none': this table has no user_id. Ownership is reached
-- through the parent song, like sam_song_measures, sam_song_lyrics and
-- sam_song_fingerings, so the policy is written by hand below.
-- register_table still enables RLS, issues grants and strips anon.
--
-- p_audited => false, deliberately. The audit log exists to show who changed
-- what and to undo it. These rows are DERIVED: recomputed wholesale from
-- sam_song_measures, carrying no user intent, and reproducible by re-running
-- the analyzer. Auditing would record thousands of delete/insert pairs per
-- backfill that say nothing a re-run could not reproduce — the same reasoning
-- as the high-volume telemetry carve-out (sam_session_events), stated here
-- rather than assumed. The intent-bearing change (a measure edit) is audited
-- where it happens, on sam_song_measures and sam_songs.
select platform.register_table(
  'public.sam_song_scores',
  p_policy_mode => 'none',
  p_audited     => false,
  p_exempt      => false,
  p_notes       => 'SAM: per-measure difficulty facts, tempo-independent. RLS via parent song. '
                   'Audit OFF: derived rows, replaced wholesale from sam_song_measures, no user '
                   'intent; safe to delete and recompute.'
);

-- Parent-scoped ownership, mirroring sam_song_lyrics ("Users see own song
-- lyrics"). FOR ALL with USING only: Postgres applies the USING expression as
-- the WITH CHECK for inserts and updates too, so a user can neither see nor
-- write another user's song's scores. TO authenticated: anon has no business
-- here (register_table has already stripped anon's grants).
create policy "Users see own song scores"
  on public.sam_song_scores
  for all
  to authenticated
  using (
    exists (
      select 1 from public.sam_songs
      where sam_songs.id = sam_song_scores.song_id
        and sam_songs.user_id = auth.uid()
    )
  );

-- ============================================================================
-- CONFORMANCE — every migration block ends here. Expected: CONFORMANT.
-- ============================================================================
select platform.check_conformance();
-- If the platform schema is not exposed to your session, the public wrapper is
-- equivalent:
--   select public.platform_check_conformance();
-- Details on anything other than CONFORMANT:
--   select * from platform.conformance_failures;
