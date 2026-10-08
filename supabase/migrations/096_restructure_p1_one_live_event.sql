-- Purpose: Restructure P1. One live (unarchived) event per intention and at most one open (active or paused) execution per intention, enforced by two partial unique indexes. Archived events and closed executions are unlimited: they are the history.
-- Kind: schema change (two indexes, two comments)
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here. Alex runs every file himself.
--
-- Run in two parts.
--   PART 1 is read-only: it shows exactly what each index would reject. If
--   either *_dupes list is non-empty, PART 2 will fail on that index; resolve
--   those rows first (archive the extra event / close the extra execution).
--   PART 2 creates the indexes, as one block.
--
-- PART 1 run by Alex 2026-10-07: no duplicates for either index; 6 live events
-- (0 with null archived, 0 without an intention); 1 open execution (statuses
-- seen: active, closed).
--
-- `archived is not true` counts null as live, matching the app's `!e.archived`.
-- Open executions are status active or paused, matching useAlfredData's loads.
-- The browser already refuses both (Restructure P1 step 23); these make the
-- violation impossible from any path.

-- ============================================================================
-- PART 1 (read-only). Shows what each index would reject.
-- ============================================================================
select json_build_object(
  'events_live_dupes', (select coalesce(json_agg(t), '[]'::json) from (
    select e.intent_id, i.text as intention, i.status, i.archived as intention_archived,
           count(*) as live_events,
           json_agg(json_build_object('id', e.id, 'time', e.time, 'archived', e.archived, 'created_at', e.created_at)
                    order by e.time) as events
      from public.events e
      left join public.intents i on i.id = e.intent_id
     where e.archived is not true and e.intent_id is not null
     group by e.intent_id, i.text, i.status, i.archived
    having count(*) > 1) t),
  'events_live_total', (select coalesce(json_agg(t), '[]'::json) from (
    select count(*) filter (where archived is not true) as live,
           count(*) filter (where archived is null) as live_with_null_archived,
           count(*) filter (where archived is not true and intent_id is null) as live_without_intention
      from public.events) t),
  'executions_open_dupes', (select coalesce(json_agg(t), '[]'::json) from (
    select x.intent_id, i.text as intention, count(*) as open_executions,
           json_agg(json_build_object('id', x.id, 'status', x.status, 'event_id', x.event_id, 'started_at', x.started_at)
                    order by x.started_at) as executions
      from public.executions x
      left join public.intents i on i.id = x.intent_id
     where x.status in ('active', 'paused') and x.intent_id is not null
     group by x.intent_id, i.text
    having count(*) > 1) t),
  'executions_open_total', (select coalesce(json_agg(t), '[]'::json) from (
    select count(*) filter (where status in ('active', 'paused')) as open,
           count(*) filter (where status is null) as null_status,
           json_agg(distinct status) as statuses_seen
      from public.executions) t)
) as result;

-- ============================================================================
-- PART 2. Run as one block, after PART 1 shows both *_dupes empty.
-- ============================================================================
begin;

create unique index events_one_live_per_intent
  on public.events (intent_id)
  where archived is not true;

comment on index public.events_one_live_per_intent is
  'Restructure P1. At most one live (archived is not true; null counts as live) event per intention. An event is the plan for one day; the history is archived events. Recurrence archives before it creates the successor, so the order is safe.';

create unique index executions_one_open_per_intent
  on public.executions (intent_id)
  where status in ('active', 'paused');

comment on index public.executions_one_open_per_intent is
  'Restructure P1. At most one open (active or paused) execution per intention. Closed executions are unlimited: they are the history.';

commit;

-- ============================================================================
-- VERIFY (read-only). Expect both indexes, unique, with the predicates above.
-- ============================================================================
-- select json_build_object(
--   'indexes', (select coalesce(json_agg(t), '[]'::json) from (
--     select indexname, indexdef from pg_indexes
--      where schemaname = 'public'
--        and indexname in ('events_one_live_per_intent', 'executions_one_open_per_intent')) t)
-- ) as result;
