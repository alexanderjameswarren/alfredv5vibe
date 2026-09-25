-- 077_platform_search_executions.sql
--
-- SCHEMA CHANGE. Apply once, in order.
--
-- get_execution_history filters date_from / date_to in TypeScript AFTER the
-- row limit, so it filters one page instead of the table — the same bug just
-- fixed in get_intents. This migration provides the only clean way to fix it.
--
-- ---------------------------------------------------------------------------
-- WHY THIS CANNOT BE DONE IN POSTGREST
-- ---------------------------------------------------------------------------
--
-- The date lives on events.time, not on executions. Filtering it before the
-- limit needs a join, and PostgREST can only embed (`events!inner(time)`) when
-- a FOREIGN KEY or another declared relationship puts the pair in its schema
-- cache. There is none:
--
--   executions constraints: executions_pkey, executions_user_id_fkey
--
-- `executions.event_id` is a plain text column with an index (idx_executions_
-- event) and no FK, so `events!inner(...)` fails with PGRST200, "could not
-- find a relationship". Same situation as clips.inbox_id, which migration 063
-- documents.
--
-- ---------------------------------------------------------------------------
-- WHY A FUNCTION AND NOT A FOREIGN KEY
-- ---------------------------------------------------------------------------
--
-- Adding executions.event_id -> events.id would also enable the embed, and it
-- was rejected: it changes what the APP is allowed to do, to fix a read tool.
-- A new constraint fails outright if any execution references a missing event,
-- and from then on it governs every delete of an events row — a behaviour
-- change in the React app, which nothing in this task asked for. The RPC
-- touches no constraint and no write path.
--
-- The precedent is platform_search_items (migration 039), which exists for
-- exactly this reason: get_items needed its tag filter applied before the
-- limit, and it is the pattern get_intents' comment now points at.
--
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER, DELIBERATELY — AND NOT LIKE platform_search_items
-- ---------------------------------------------------------------------------
--
-- platform_search_items is SECURITY DEFINER with an explicit
-- `user_id = auth.uid()` test, because items are owner-only. Executions are
-- NOT: policy executions_access is
--
--   user_id = auth.uid() OR context_id IN (select id from contexts where shared)
--
-- Re-typing that inside a DEFINER function would copy a live policy into a
-- second place and let the two drift — and a drift in this direction leaks
-- another user's sessions. SECURITY INVOKER (the default, stated here so the
-- choice is visible) runs under the caller's own RLS, so this function returns
-- exactly what the caller could already read, and it keeps tracking the policy
-- if the policy ever changes. It reads three tables and the caller's RLS is
-- applied to all three.
--
-- ---------------------------------------------------------------------------
-- SHAPE
-- ---------------------------------------------------------------------------
--
-- Returns { rows, total } from ONE snapshot, like platform_search_items, so
-- the truncation NOTE's "N of M" cannot be computed from two different reads.
-- `total` counts every matching row; `rows` is the first p_limit of them.
--
-- The row shape is what the handler assembles today (execution_id, intent_text,
-- intent_item_id, event_date, started_at, closed_at, status, outcome, item_ids,
-- context_id), so the tool's output does not change. The two extra round trips
-- the handler makes for intent text and event dates become part of the join.
--
-- Ordering is started_at desc, unchanged, with id as a tiebreak so a tie
-- cannot shuffle rows between two calls and hide one at the page boundary.
-- NULLS LAST because started_at is nullable and a null start is not recent.

begin;

create or replace function public.platform_search_executions(
  p_intent_id  text default null,
  p_context_id text default null,
  p_date_from  date default null,
  p_date_to    date default null,
  p_limit      integer default 20)
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  with filtered as (
    select
      x.id                as execution_id,
      i.text              as intent_text,
      i.item_id           as intent_item_id,
      ev.time             as event_date,
      x.started_at,
      x.closed_at,
      x.status,
      x.outcome,
      x.item_ids,
      x.context_id
      from executions x
      -- LEFT JOIN, not inner: an execution whose intent or event row is gone
      -- still happened, and dropping it would silently shrink the history.
      -- The date filter below is what excludes rows, and it is explicit about
      -- what a missing event means.
      left join intents i  on i.id  = x.intent_id
      left join events  ev on ev.id = x.event_id
     where (p_intent_id  is null or x.intent_id  = p_intent_id)
       and (p_context_id is null or x.context_id = p_context_id)
       -- A row with no event date CANNOT satisfy a date filter, and saying so
       -- here matches the TypeScript this replaces (`r.event_date && ...`).
       -- With no date filter asked for, those rows stay in.
       and (p_date_from is null or (ev.time is not null and ev.time >= p_date_from))
       and (p_date_to   is null or (ev.time is not null and ev.time <= p_date_to))
  )
  select jsonb_build_object(
    'rows',
      coalesce(
        (select jsonb_agg(row_to_json(y) order by y.started_at desc nulls last,
                                                  y.execution_id desc)
           from (select * from filtered
                  order by started_at desc nulls last, execution_id desc
                  limit p_limit) y),
        '[]'::jsonb),
    'total',
      (select count(*) from filtered)
  );
$function$;

comment on function public.platform_search_executions(text, text, date, date, integer) is
  'Alfred: get_execution_history''s reader. Filters intent, context and the '
  'event DATE RANGE in Postgres before the limit — the date lives on '
  'events.time and executions has no FK to events, so PostgREST cannot embed '
  'the join and the handler used to filter dates in memory after the limit. '
  'Returns { rows, total } from one snapshot for an honest truncation note. '
  'SECURITY INVOKER on purpose: executions RLS is owner-OR-shared-context and '
  'must not be re-implemented here. See migration 077.';

grant execute on function public.platform_search_executions(text, text, date, date, integer)
  to authenticated;

commit;


-- ===========================================================================
-- VERIFICATION — run AFTER the commit. Read-only.
-- ===========================================================================

-- V1. The function exists, is INVOKER (prosecdef = false), and authenticated
--     can execute it. Expect one row: prosecdef false, has_execute true.
select p.proname,
       p.prosecdef                                             as is_security_definer,
       pg_get_function_identity_arguments(p.oid)                as args,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as has_execute
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'platform_search_executions';

-- V2. The fix actually changes the answer. Unfiltered total vs a date-filtered
--     total, and the orphan count that would have blocked a foreign key.
--     `executions_with_missing_event` > 0 is the concrete reason 077 is a
--     function and not an FK.
select json_build_object(
  'executions_total', (select coalesce(json_agg(t), '[]'::json) from (
    select count(*) as n from executions
  ) t),
  'executions_with_missing_event', (select coalesce(json_agg(t), '[]'::json) from (
    select count(*) as n from executions x
     where not exists (select 1 from events ev where ev.id = x.event_id)
  ) t),
  'rpc_unfiltered', (select coalesce(json_agg(t), '[]'::json) from (
    select (public.platform_search_executions(null, null, null, null, 20) -> 'total') as total,
           jsonb_array_length(public.platform_search_executions(null, null, null, null, 20) -> 'rows') as returned
  ) t),
  'rpc_dated_2026', (select coalesce(json_agg(t), '[]'::json) from (
    select (public.platform_search_executions(null, null, '2026-01-01'::date, '2026-12-31'::date, 20) -> 'total') as total,
           jsonb_array_length(public.platform_search_executions(null, null, '2026-01-01'::date, '2026-12-31'::date, 20) -> 'rows') as returned
  ) t)
) as result;

-- V3. Platform conformance. No table was created here, so this should be
--     unchanged — run it anyway, per the house rule that a schema migration
--     ends with it. Expect CONFORMANT.
select public.platform_check_conformance();
