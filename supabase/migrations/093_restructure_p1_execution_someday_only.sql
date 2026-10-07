-- Purpose: Restructure P1 fix. status_activate_on_execution promotes someday -> active only; background stays background. Doing an event a parked intention kept is not unparking it, and the old rule let a recurring intention in background spawn its successor.
-- Kind: schema change (function body and two comments)
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here. Alex runs every file himself.
--
-- status_activate_on_event is unchanged: a NEW event still moves background to
-- active, because scheduling is a fresh commitment. Run as one block.

begin;

create or replace function public.status_activate_on_execution()
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
     and status = 'someday';

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
  raise warning 'status_activate_on_execution % failed: %', new.id, sqlerrm;
  return null;
end;
$function$;

comment on function public.status_activate_on_execution() is
  'Restructure P1. AFTER INSERT on executions: the intention, its item and every id in item_ids move to active from someday ONLY. Background stays background (doing an event a parked intention kept is not unparking it); closed is never touched. A safety net behind the browser write; never blocks it.';

comment on column public.intents.status is
  'Lifecycle: someday (never live, no history) | active (live now) | background (was active, is not now, has history) | closed (done, not coming back). Default someday. Nothing returns to someday (status_guard). Moved to active by status_activate_on_event from someday or background, and by status_activate_on_execution from someday only; never from closed. Independent of archived, which is visibility only: closing does not archive. Backfilled by Restructure P1: live rows active, archived rows closed.';

commit;

-- ============================================================================
-- VERIFY (read-only). Expect: the execution function body tests status = 'someday'
-- and never mentions 'background'; the event function still lists both; the
-- trigger is enabled (O).
-- ============================================================================
-- select json_build_object(
--   'functions', (select coalesce(json_agg(t), '[]'::json) from (
--     select p.proname,
--            position('''background''' in pg_get_functiondef(p.oid)) > 0 as mentions_background,
--            position('status = ''someday''' in pg_get_functiondef(p.oid)) > 0 as someday_only_test
--       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public'
--        and p.proname in ('status_activate_on_execution', 'status_activate_on_event')) t),
--   'trigger', (select coalesce(json_agg(t), '[]'::json) from (
--     select tgname, tgenabled from pg_trigger where tgname = 'executions_status_activate') t)
-- ) as result;
