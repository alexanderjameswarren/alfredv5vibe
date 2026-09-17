-- MOVED 2026-09-18 from docs/migrations/2026-09-16-sam-passes-accuracy.sql
-- Originally written 2026-09-16. Content unchanged below this header.
-- Purpose: Pass counter M5: add hits, misses, notes_played, hand_mode and the generated accuracy_percent to sam_passes.
-- Kind: schema change (generated column)
-- Applied: YES — hits/misses/notes_played/accuracy_percent exist
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here, not the order they were run; the original
-- date above is the historical record. Alex runs every file himself.

-- NOTE (2026-09-16b): the column comments below were superseded by
-- supabase/migrations/049_sam_passes_comment_wording.sql. They said NULL
-- meant "every row written before 2026-09-16", which reads as a midnight
-- boundary; the columns actually began recording when they were deployed,
-- part-way through that day. The SQL below is left exactly as it was run.
--
-- SAM passes: record how a playthrough went, not just that it happened.
--
-- Run this in the Supabase SQL editor BEFORE deploying the app code and the
-- edge function. Both write/read the new columns; running them first against a
-- table that lacks the columns is a hard PostgREST error.
--
-- WHY: sam_passes records that a playthrough completed and at what tempo, but
-- nothing about how it went. Reading pass history back, a real practice pass is
-- indistinguishable from a playback test with no keyboard — the only available
-- signals were the song's name and passes landing a suspiciously round number
-- of seconds apart. That is guessing around a missing fact.
--
-- A NOTE ON WHAT "NO KEYBOARD" ACTUALLY LOOKS LIKE. It is NOT zero hits and
-- zero misses. ScrollEngine raises a miss purely on elapsed time — see the
-- `elapsed > evt.targetTimeMs + timingWindowMs` branch, which never consults
-- MIDI — so a playthrough with no keyboard attached scores a miss on every
-- beat, giving 0 hits and N misses. That is byte-identical to playing every
-- note wrong, which is why `notes_played` exists: it counts MIDI notes that
-- actually arrived, and is the only honest discriminator between "unmeasured"
-- and "measured, and bad".
--
-- THE LINE THROUGH HISTORY: all four columns are NULL for existing rows and are
-- deliberately NOT backfilled, matching the playback_speed convention. NULL
-- means "not recorded". A reader must always be able to tell which side of the
-- line a row falls on.
--
-- The table is already registered with platform.register_table(); adding
-- columns does not change its policy mode, audit setting, or user_id column, so
-- it is not re-registered. Conformance is re-checked at the end regardless.

alter table public.sam_passes
  add column if not exists hits integer,
  add column if not exists misses integer,
  add column if not exists notes_played integer,
  add column if not exists hand_mode text;

-- Generated and STORED, for the same reason as effective_bpm: derived from the
-- stored facts by Postgres, so it cannot drift from them and cannot be written
-- to by mistake.
--
-- NULL is a distinct answer from 0 and the two must never collapse:
--   NULL -> nothing to measure. No notes arrived (playback test, or the player
--           walked away), or no beats were scored at all, or the row predates
--           this migration.
--   0    -> notes arrived and every one of them was wrong.
--
-- Partials are excluded from the ratio, matching `accuracyOf` in
-- usePracticeSession, so the pass and the session agree on what accuracy means.
alter table public.sam_passes
  add column if not exists accuracy_percent integer
    generated always as (
      case
        when coalesce(notes_played, 0) = 0 then null
        when coalesce(hits, 0) + coalesce(misses, 0) = 0 then null
        else (round((coalesce(hits, 0) * 100.0)
                    / (coalesce(hits, 0) + coalesce(misses, 0))))::integer
      end
    ) stored;

comment on column public.sam_passes.hits is
  'Notes played correctly during this pass, from the same per-playthrough counters usePracticeSession keeps for the live display. Partials are counted separately by the app and are NOT included here, matching accuracyOf(). NULL means not recorded: every row written before 2026-09-16 predates this column.';

comment on column public.sam_passes.misses is
  'Beats scored as missed or wrong during this pass. NOTE: a miss is raised on elapsed time alone and does not require MIDI input, so a pass played with no keyboard attached records 0 hits and a full count of misses. Use notes_played to tell that apart from playing badly. NULL means not recorded.';

comment on column public.sam_passes.notes_played is
  'Count of MIDI notes that actually arrived during this pass. 0 means nothing was played — a playback test, or the player was not at the keyboard — which is why accuracy_percent is NULL rather than 0 for those rows. This is the only reliable way to exclude test data from practice history. NULL means not recorded.';

comment on column public.sam_passes.accuracy_percent is
  'Generated: round(hits * 100 / (hits + misses)), or NULL when notes_played is 0, when no beats were scored, or when the row predates 2026-09-16. NULL means unmeasurable; 0 means measured and every note wrong. Do not treat NULL as 0 in any aggregate.';

comment on column public.sam_passes.hand_mode is
  'Which hand the player was SCORED on for this pass: both | lh | rh. Recoverable from the snippet for snippet passes, but not for whole-song passes, where it was previously indistinguishable — and hand mode is the likeliest explanation for an accuracy jump. NULL means not recorded.';

-- Excluding test data is the query this change exists to enable, and asking for
-- a song's real passes by accuracy is the payoff.
create index if not exists idx_passes_song_notes_played
  on public.sam_passes (song_id, notes_played);

-- Per the platform contract, every migration block ends here.
-- Expected: CONFORMANT, plus a table count.
select platform.check_conformance();
-- If the above errors because the platform schema is not exposed to your
-- session, the public wrapper is equivalent:
--   select public.platform_check_conformance();
