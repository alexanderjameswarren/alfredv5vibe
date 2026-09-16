-- NOTE (2026-09-16b): the column comments below were superseded by
-- docs/migrations/2026-09-16b-sam-passes-comment-wording.sql. They said NULL
-- meant "every row written before 2026-09-16", which reads as a midnight
-- boundary; the columns actually began recording when they were deployed,
-- part-way through that day. The SQL below is left exactly as it was run.
--
-- SAM passes: record playback speed alongside bpm, and derive effective tempo.
--
-- Run this in the Supabase SQL editor BEFORE deploying the app code and the
-- edge function. Both write/read the new columns; running them first against a
-- table that lacks the columns is a hard PostgREST error.
--
-- WHY: sam_passes records bpm alone. A pass reading 60 may have been played at
-- 80% speed, i.e. effectively 48, with no way to tell the two apart. Speed only
-- applies when a song has an MP3 attached (SAM shows Playback Speed % only for
-- audio-backed songs), so this affects a minority of passes — but the ones it
-- affects are silently wrong, which is worse than missing.
--
-- THE LINE THROUGH HISTORY: playback_speed is NULL for every existing row and
-- is deliberately NOT backfilled. NULL means "not recorded"; 100 means
-- "recorded, and it was full speed". Those are different claims and must stay
-- distinguishable. Rows written before this migration mean "bpm 60, speed
-- unknown" and cannot be corrected — the speed was never captured anywhere,
-- and inferring it from sam_sessions.settings.playbackSpeed (a start-of-session
-- snapshot) would be inventing data.
--
-- The table is already registered with platform.register_table(); adding
-- columns does not change its policy mode, audit setting, or user_id column, so
-- it is not re-registered. Conformance is re-checked at the end regardless.

alter table public.sam_passes
  add column if not exists playback_speed integer;

-- Generated and STORED, so Postgres computes it from bpm and playback_speed and
-- it cannot drift from its inputs. NULL in either input yields NULL here, which
-- is the correct reading: an unknown speed means an unknown effective tempo,
-- not an assumed one.
alter table public.sam_passes
  add column if not exists effective_bpm integer
    generated always as ((round((bpm * playback_speed) / 100.0))::integer) stored;

comment on column public.sam_passes.playback_speed is
  'Playback speed percentage in force when the pass completed (100 = normal). NULL means NOT RECORDED, not 100: every row written before 2026-09-16 predates this column and carries a bpm whose true speed is unknown and unrecoverable. Only audio-backed songs expose a speed control, so non-audio songs record 100.';

comment on column public.sam_passes.effective_bpm is
  'Generated: round(bpm * playback_speed / 100.0). The tempo actually heard, so 60 bpm at 80% reads 48. NULL whenever playback_speed is NULL — i.e. for every pass recorded before 2026-09-16 — because an unknown speed gives an unknown effective tempo. Read this for "how fast was it really"; read bpm for "what did the tempo box say".';

comment on column public.sam_passes.bpm is
  'Playback tempo in force at the instant the pass completed. If tempo changed mid-pass, this is the tempo at the finish line, not the start. NOTE: this is the score tempo and ignores playback speed — see effective_bpm for the tempo actually heard.';

-- Index the derived column: "how many passes at an effective 60 or above" is
-- the question this whole change exists to make answerable.
create index if not exists idx_passes_song_effective_bpm
  on public.sam_passes (song_id, effective_bpm);

-- Per the platform contract, every migration block ends here.
-- Expected: CONFORMANT, plus a table count.
select platform.check_conformance();
-- If the above errors because the platform schema is not exposed to your
-- session, the public wrapper is equivalent:
--   select public.platform_check_conformance();
