-- Purpose: Restructure P1 fix (Test 8). status_activate_on_event now promotes the intention's item and every id in item_ids as well as the intention, matching status_activate_on_execution. Before this, scheduling a someday item's intention left the item someday.
-- Kind: schema change (function body and two comments)
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here. Alex runs every file himself.
--
-- The intention keeps its rule: someday OR background -> active on a new event.
-- Items move from someday ONLY. An event insert cannot tell a deliberate
-- schedule from a recurrence successor, which copies the previous event's
-- item_ids, so a background item would be unparked on every recurrence. The
-- intention is safe from that because triggerRecurrence only runs for an active
-- intention; nothing guards the items. Run as one block.

begin;

create or replace function public.status_activate_on_event()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  ids jsonb := case when jsonb_typeof(new.item_ids) = 'array' then new.item_ids else '[]'::jsonb end;
begin
  update public.intents
     set status = 'active'
   where id = new.intent_id
     and status in ('someday', 'background');

  update public.items
     set status = 'active'
   where status = 'someday'
     and id in (
       select i.item_id from public.intents i
        where i.id = new.intent_id and i.item_id is not null
       union
       select jsonb_array_elements_text(ids)
     );
  return null;
exception when others then
  raise warning 'status_activate_on_event % failed: %', new.id, sqlerrm;
  return null;
end;
$function$;

comment on function public.status_activate_on_event() is
  'Restructure P1. AFTER INSERT on events (unarchived): scheduling is committing, so the intention moves to active from someday or background, and its item and every id in item_ids move to active from someday ONLY (a recurrence successor copies item_ids, so a background item would be unparked on every recurrence). Never from closed. A safety net behind the browser write; never blocks it.';

comment on column public.items.status is
  'Lifecycle: someday (never live, no history) | active (live now) | background (was active, is not now, has history) | closed (done, not coming back). Default someday. Nothing returns to someday (status_guard). Moved to active from someday ONLY, by status_activate_on_event and status_activate_on_execution (the intention''s item and every id in item_ids); never from background or closed. Independent of archived, which is visibility only: closing does not archive. Backfilled by Restructure P1: live rows active, archived rows closed.';

commit;

-- ============================================================================
-- VERIFY (read-only). Expect: touches_items and items_someday_only both true;
-- the trigger enabled (O); the test rows as they stand. "Someday test two"
-- stays someday until a NEW event is scheduled after this runs, then reads active.
-- ============================================================================
-- select json_build_object(
--   'event_function', (select coalesce(json_agg(t), '[]'::json) from (
--     select position('public.items' in pg_get_functiondef(p.oid)) > 0 as touches_items,
--            position('status = ''someday''' in pg_get_functiondef(p.oid)) > 0 as items_someday_only
--       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public' and p.proname = 'status_activate_on_event') t),
--   'trigger', (select coalesce(json_agg(t), '[]'::json) from (
--     select tgname, tgenabled from pg_trigger where tgname = 'events_status_activate') t),
--   'test_rows', (select coalesce(json_agg(t), '[]'::json) from (
--     select it.name, it.status as item_status, i.status as intention_status,
--            (select count(*) from public.events e
--              where e.intent_id = i.id and e.archived is not true) as live_events
--       from public.items it left join public.intents i on i.item_id = it.id
--      where it.name in ('Someday test', 'Someday test two')) t)
-- ) as result;
