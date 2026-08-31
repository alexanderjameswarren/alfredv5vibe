-- 006 — allow platform_runs.status = 'running'
--
-- WHY. The daily task opens a run BEFORE it polls, so a task killed mid-flight
-- (runtime timeout, host death — anything that is not a catchable error) leaves
-- a trace instead of vanishing. Without an open state there is no way to
-- distinguish "never ran" from "ran and died", and the first is exactly what a
-- staleness check must be able to see.
--
-- The enum was ok | failed | auth_expired | partial. There was no way to say
-- "started", so the first scheduled run substituted 'ok' when 'running' was
-- rejected — a run recorded as successful before it had done anything.
--
-- WHAT KEEPS THE LOG TRUSTWORTHY. 'running' is the ONLY status a run can be
-- moved out of. update_platform_run writes the outcome fields (covered_from,
-- covered_to, details, error_message) solely on a transition out of 'running',
-- and enforces it in the UPDATE's own WHERE clause, so it is atomic rather than
-- a check-then-act. A run that is open can be closed; a run that is closed
-- cannot be rewritten.
--
-- Run this BEFORE deploying the matching function change, and before pasting
-- the daily task prompt. Until it lands, create_platform_run with
-- status: 'running' fails the CHECK constraint.

alter table public.platform_runs
  drop constraint if exists platform_runs_status_check;

alter table public.platform_runs
  add constraint platform_runs_status_check
  check (status = any (array['running', 'ok', 'failed', 'auth_expired', 'partial']));

comment on column public.platform_runs.status is
  'running | ok | failed | auth_expired | partial. "running" means OPEN: the row '
  'was created before the work started so a task that dies mid-flight leaves a '
  'trace. It is the only status a run can be moved OUT of — update_platform_run '
  'closes a running run and refuses to re-stamp a closed one. A run still '
  '"running" long after started_at died without reporting; nothing closes those '
  'automatically, and the daily task observes them without touching them.';

comment on column public.platform_runs.finished_at is
  'NULL while status = ''running'' — an open run has not finished. Set at the '
  'moment update_platform_run closes it. For any other status it defaults to the '
  'same instant as started_at when the caller does not supply one, because equal '
  'timestamps are the honest answer to "I do not know how long this took"; a '
  'negative interval is not.';

comment on column public.platform_runs.error_message is
  'REQUIRED when status is ''failed'' or ''auth_expired'' — enforced by '
  'update_platform_run, which refuses the write without it. A failure logged '
  'without its cause is indistinguishable from one that failed for no reason. '
  'Pair it with details->>''failure_kind'', which is also required, and which the '
  'notification de-dup uses to tell a still-broken thing from a newly broken one.';
