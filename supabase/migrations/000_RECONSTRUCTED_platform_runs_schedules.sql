-- ===========================================================================
-- DJ Migration Block D — platform_runs + platform_schedules
--
-- ⚠️ RECONSTRUCTED FROM INTROSPECTION on 2026-08-29. This is NOT the original
-- DDL. Block D was run in the Supabase SQL editor and never written to a file,
-- so the only source was `get_database_schema`. It reproduces the columns,
-- types, defaults, constraints, indexes and comments that the live tables
-- actually have — but statement ORDER, formatting, and anything introspection
-- cannot see (e.g. how register_table was invoked) are best-effort.
--
-- Numbered 000 deliberately: it predates 001_sam_tables in intent, and giving
-- it a later number would imply these tables were created after SAM's, which
-- they were not. Do NOT run this against the live database — the tables exist.
-- It is here so the schema has a source outside the database.
--
-- ⚠️ THE SAME GAP APPLIES TO BLOCKS A, B, C AND E. Nine more tables —
-- dj_tracks, dj_plays, dj_playlists, dj_playlist_tracks, dj_concerts,
-- dj_venues, dj_artists, dj_albums, dj_feedback — exist ONLY in the database.
-- See docs/progress-dj.md. This file covers Block D because that is the one
-- that actually blocked work (a tool could not be built without the columns).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- platform_runs — one row per attempted job, across all apps
-- ---------------------------------------------------------------------------

create table if not exists public.platform_runs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid(),
  app           text not null,
  job           text not null,
  executor      text not null,
  host          text,
  status        text not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  covered_from  date,
  covered_to    date,
  details       jsonb not null default '{}'::jsonb,
  error_message text,
  notified_at   timestamptz,

  constraint platform_runs_app_check
    check (app = any (array['dj','sam','alfred','workshop'])),
  constraint platform_runs_executor_check
    check (executor = any (array['workshop','claude','alfred'])),
  constraint platform_runs_status_check
    check (status = any (array['ok','failed','auth_expired','partial']))
);

create index if not exists platform_runs_recent_idx
  on public.platform_runs using btree (user_id, app, job, started_at desc);

-- Partial index: only non-ok rows are ever triaged for notification.
create index if not exists platform_runs_unnotified_idx
  on public.platform_runs using btree (user_id, status, notified_at)
  where (status <> 'ok');

comment on table public.platform_runs is
  'Platform: one row per attempted job — scheduled or on-demand — across all apps. Generic because "did it work, when, and what broke" is the same question for every job; only the payload differs, which is what details is for.';

comment on column public.platform_runs.app is
  'Constrained rather than free text so a typo fails loudly instead of creating a row that no staleness query will ever match. Adding an app is one line in a migration.';

comment on column public.platform_runs.executor is
  'Who actually ran it. Workshop and Claude fail in different ways. Deliberately a column and not a separate table: the shape is identical, and splitting would make every staleness query a union of two tables that must be kept in step.';

comment on column public.platform_runs.status is
  'partial means it ran and wrote something but not everything. auth_expired is separated because it is the one status with a human remedy rather than a retry.';

comment on column public.platform_runs.covered_from is
  'Period this incremental run covered. Generic to any catch-up job, not DJ-specific — compared against the previous run, it detects a lost window rather than assuming one.';

comment on column public.platform_runs.notified_at is
  'When this failure was surfaced to the human. Stops one broken credential minting an identical inbox item every day until the backlog needs triaging itself.';

-- Audit intentionally OFF: this is high-volume observability telemetry, and
-- auditing a log produces a log of a log.
select platform.register_table('platform_runs', audited => false, exempt => false);


-- ---------------------------------------------------------------------------
-- platform_schedules — what is SUPPOSED to run
-- ---------------------------------------------------------------------------

create table if not exists public.platform_schedules (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  app         text not null,
  job         text not null,
  executor    text not null,
  cadence     text not null,
  day_of_week smallint,
  expected_by time not null default '08:00:00'::time,
  grace_hours smallint not null default 6,
  enabled     boolean not null default true,
  notes       text,
  created_at  timestamptz not null default now(),

  constraint platform_schedules_user_id_app_job_key unique (user_id, app, job),
  constraint platform_schedules_app_check
    check (app = any (array['dj','sam','alfred','workshop'])),
  constraint platform_schedules_executor_check
    check (executor = any (array['workshop','claude','alfred'])),
  constraint platform_schedules_cadence_check
    check (cadence = any (array['daily','weekly'])),
  constraint platform_schedules_day_of_week_check
    check (day_of_week >= 0 and day_of_week <= 6),
  -- A weekly job with no day is a definition that cannot be evaluated.
  constraint platform_schedules_weekly_needs_day
    check (cadence <> 'weekly' or day_of_week is not null)
);

comment on table public.platform_schedules is
  'Platform: what is SUPPOSED to run, and how often. Stores the cadence, NOT materialised expected occurrences — materialising would need a job to create those rows, and that job could fail silently, which is the exact problem this table exists to detect. Staleness is derived at read time by comparing the due occurrence against platform_runs. Absence of a row is the only signal when Claude never fires OR fires but cannot reach Supabase.';

comment on column public.platform_schedules.day_of_week is
  'Postgres dow convention: 0 = Sunday. Required for weekly, null for daily.';

comment on column public.platform_schedules.grace_hours is
  'How late before absence counts as a problem. A job due at 08:00 should not alarm at 08:01. Set higher for jobs on a machine that sleeps.';

comment on column public.platform_schedules.enabled is
  'False suspends staleness checking without deleting the definition — a paused job should not alarm, and should not have to be reconstructed from memory later.';

select platform.register_table('platform_schedules', audited => true, exempt => false);


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- check_platform_conformance() — expect CONFORMANT.
