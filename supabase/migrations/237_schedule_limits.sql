-- Job health job_health-t4m s5/s5b: what the watchdog needs to know about each scheduled job. Kind: schema change
-- (six new platform_schedules columns, with checks and comments) plus one data update (13 rows).
-- Applied: NO (queued at s5b; only a run id shows it ran).
-- Spec: docs/technical-spec-job_health-t4m.md §4. Table touched: platform_schedules (no new table, view or function,
-- so no new grants; the table keeps the grants it has). Test: supabase/tests/job_health-t4m/1_schedule_limits_test.sql.
--
-- The new columns:
--   hourly_until      the job runs every hour from expected_by to this time (Pacific), not once a day;
--   max_run_minutes   a run still running after this long is stuck and is swept (s6);
--   catch_up          what to do about a missed run: self | skip | run_now (null: not checked for missed runs);
--   failure_subject   the job's own failure subject key; {kind} becomes the failure kind;
--   failure_severity  the severity the job uses for its own failures;
--   started_by        the job's started_by, so the watchdog raises signals as the job would.
-- Every column is null by default, so a schedule added later is simply not swept or checked until it is set.
-- The alfred/job_health_check row is not added here: s9 adds it with its task.
-- supabase/migrations/237_schedule_limits.sql

-- ── 1. Columns ───────────────────────────────────────────────────────────────

alter table public.platform_schedules
  add column if not exists hourly_until     time,
  add column if not exists max_run_minutes  integer,
  add column if not exists catch_up         text,
  add column if not exists failure_subject  text,
  add column if not exists failure_severity text,
  add column if not exists started_by       text;

alter table public.platform_schedules drop constraint if exists platform_schedules_hourly_until_check;
alter table public.platform_schedules add constraint platform_schedules_hourly_until_check
  check (hourly_until is null or (cadence = 'daily' and hourly_until > expected_by));

alter table public.platform_schedules drop constraint if exists platform_schedules_max_run_minutes_check;
alter table public.platform_schedules add constraint platform_schedules_max_run_minutes_check
  check (max_run_minutes is null or max_run_minutes > 0);

alter table public.platform_schedules drop constraint if exists platform_schedules_catch_up_check;
alter table public.platform_schedules add constraint platform_schedules_catch_up_check
  check (catch_up is null or catch_up in ('self', 'skip', 'run_now'));

-- With {kind} filled in, the subject must be a valid signals subject key (signals_subject_key_format).
alter table public.platform_schedules drop constraint if exists platform_schedules_failure_subject_check;
alter table public.platform_schedules add constraint platform_schedules_failure_subject_check
  check (failure_subject is null
         or replace(failure_subject, '{kind}', 'stuck') ~ '^[a-z0-9][a-z0-9:_.-]{0,199}$');

alter table public.platform_schedules drop constraint if exists platform_schedules_failure_severity_check;
alter table public.platform_schedules add constraint platform_schedules_failure_severity_check
  check (failure_severity is null or failure_severity in ('low', 'normal', 'high', 'urgent'));

alter table public.platform_schedules drop constraint if exists platform_schedules_started_by_check;
alter table public.platform_schedules add constraint platform_schedules_started_by_check
  check (started_by is null or public.started_by_valid(started_by));

comment on column public.platform_schedules.hourly_until is
  'When set, the job is expected every hour from expected_by to this time (America/Los_Angeles), not once a day. Daily cadence only, and later than expected_by. Null: once a day (or week).';
comment on column public.platform_schedules.max_run_minutes is
  'A run still running this many minutes after started_at is stuck: job_health_watchdog marks it failed (failure_kind stuck). Three times the p95 of recent runs, never under 10. Null: never swept.';
comment on column public.platform_schedules.catch_up is
  'What to do about a missed run: self (the next run covers it), skip (a missed run is not worth making up), run_now (run it by hand). Null: not checked for missed runs.';
comment on column public.platform_schedules.failure_subject is
  'The job''s own failure signal subject_key. {kind} is replaced by the failure kind (stuck); the result must match the signals subject format. Null: the watchdog raises no signal for this job.';
comment on column public.platform_schedules.failure_severity is
  'The severity the job uses for its own failure signals (low, normal, high, urgent); the watchdog uses the same.';
comment on column public.platform_schedules.started_by is
  'The job''s started_by (started_by_valid), used when the watchdog raises a signal on the job''s behalf.';

-- ── 2. Values (spec §4) ──────────────────────────────────────────────────────
-- One statement, 13 rows: every existing schedule. notify-dispatch writes no runs, so it stays all null.

update public.platform_schedules s
set hourly_until     = v.hourly_until,
    max_run_minutes  = v.max_run_minutes,
    catch_up         = v.catch_up,
    failure_subject  = v.failure_subject,
    failure_severity = v.failure_severity,
    started_by       = v.started_by
from (values
  ('alfred',        'claude_hourly_notifications', time '19:00', 10, 'skip',    'alfred:claude_hourly_notifications:failure:{kind}', 'high', 'task:claude-hourly-notifications'),
  ('alfred',        'inbox_enrich_hourly',         time '21:00', 10, 'self',    'alfred:inbox_enrich_hourly:failure:{kind}',         'high', 'task:hourly-inbox-enrichment'),
  ('alfred',        'notify-dispatch',             null,         null, null,    null,                                                null,   null),
  ('arnold',        'arnold_morning_review',       null,         10, 'skip',    'arnold:arnold_morning_review:failure',              'high', 'task:arnold-morning-review'),
  ('dj',            'daily_history_sync',          null,         15, 'run_now', 'dj:daily_history_sync:failure:{kind}',              'high', 'task:dj-daily'),
  ('dj',            'weekly_review',               null,         20, 'run_now', 'dj:weekly_review:failure',                          'high', 'task:dj-weekly-review'),
  ('drive_mix',     'daily_refresh',               null,         20, 'self',    'drive_mix:daily_refresh:failure:{kind}',            'high', 'task:drive-mix-daily-refresh'),
  ('ken',           'ken_seed_check',              null,         10, 'self',    'ken:ken_seed_check:failure:{kind}',                 'high', 'task:ken-seed-check'),
  ('overwatch',     'nightly',                     null,         30, 'self',    'overwatch:nightly:failure:{kind}',                  'high', 'task:overwatch-nightly'),
  ('overwatch',     'weekly',                      null,         30, 'run_now', 'overwatch:weekly:failure:{kind}',                   'high', 'task:overwatch-weekly'),
  ('sam',           'daily_plan_review',           null,         15, 'self',    'sam:daily_plan_review:failure:{kind}',              'high', 'task:sam-daily-review'),
  ('warren_buffet', 'wb_weekly_cleanup',           null,         20, 'self',    'warren_buffet:wb_weekly_cleanup:failure:{kind}',    'high', 'task:money-cleanup'),
  ('warren_buffet', 'wb-sync',                     null,         10, 'self',    'wb-sync:failure:kind:{kind}',                       'low',  'task:wb-sync')
) as v(app, job, hourly_until, max_run_minutes, catch_up, failure_subject, failure_severity, started_by)
where s.app = v.app and s.job = v.job;

-- ── 3. Conformance (mcp-platform Rule 5): expect CONFORMANT ──────────────────

select public.platform_check_conformance() as conformance;
