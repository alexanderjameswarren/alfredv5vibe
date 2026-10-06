-- Purpose: Restructure P1 status. status + status_changed_at on items and intents (someday / active / background / closed), is_reference on items, suggested_status on inbox, the status guard, auto-activation on event and execution insert, and status in platform_search_items.
-- Kind: schema change (columns, backfill of archived rows, three trigger functions, function signature change)
-- Applied: YES — 2026-10-06 by Alex. Verified: items 396 active / 59 closed, intents 61 active / 132 closed, 0 mismatches, 4 triggers enabled, platform_search_items ACL unchanged; conformance CONFORMANT (45 tables).
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here. Alex runs every file himself.
--
-- Pre-flight run 2026-10-06: platform_search_items ACL was
-- {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres};
-- set_updated_at present on items and intents. Section G grants the same set.
-- Run as one block, then check_platform_conformance, then VERIFY. Event and
-- execution writes stay in the browser; the two activation triggers are a
-- safety net that fires after whatever wrote the row.
-- supabase/migrations/088_restructure_p1_status.sql

begin;

-- ============================================================================
-- A. Columns. Added with default 'active' so every existing row lands on
--    active without a row UPDATE, then the default becomes 'someday'.
-- ============================================================================
alter table public.items
  add column status text not null default 'active',
  add column status_changed_at timestamptz not null default now(),
  add column is_reference boolean not null default false;
alter table public.items alter column status set default 'someday';

alter table public.intents
  add column status text not null default 'active',
  add column status_changed_at timestamptz not null default now();
alter table public.intents alter column status set default 'someday';

alter table public.inbox
  add column suggested_status text not null default 'someday';

-- ============================================================================
-- B. Archived rows -> closed. set_updated_at is paused for this one UPDATE so
--    updated_at (Recycle Bin and "Last modified" order) is untouched; the audit
--    trigger still records it. status_changed_at takes the archive time.
-- ============================================================================
alter table public.items disable trigger set_updated_at;
update public.items
   set status = 'closed', status_changed_at = coalesce(updated_at, created_at, now())
 where archived is true;
alter table public.items enable trigger set_updated_at;

alter table public.intents disable trigger set_updated_at;
update public.intents
   set status = 'closed', status_changed_at = coalesce(updated_at, created_at, now())
 where archived is true;
alter table public.intents enable trigger set_updated_at;

-- ============================================================================
-- C. Checks
-- ============================================================================
alter table public.items add constraint items_status_check
  check (status in ('someday', 'active', 'background', 'closed'));
alter table public.intents add constraint intents_status_check
  check (status in ('someday', 'active', 'background', 'closed'));
alter table public.inbox add constraint inbox_suggested_status_check
  check (suggested_status in ('someday', 'active'));

-- ============================================================================
-- D. Column comments
-- ============================================================================
comment on column public.items.status is
  'Lifecycle: someday (never live, no history) | active (live now) | background (was active, is not now, has history) | closed (done, not coming back). Default someday. Nothing returns to someday (status_guard). Flipped to active by status_activate_on_execution. Independent of archived, which is visibility only: closing does not archive. Backfilled by Restructure P1: live rows active, archived rows closed.';
comment on column public.items.status_changed_at is
  'When status last changed. Owned by status_guard: client writes to it are ignored. Backfill: archived rows took updated_at (the archive time), live rows the migration time.';
comment on column public.items.is_reference is
  'Reference material rather than something to act on. NO UI YET — no chips, rendering or filtering read it. Added in Restructure P1 only so a later phase needs no second migration.';
comment on column public.intents.status is
  'Lifecycle: someday (never live, no history) | active (live now) | background (was active, is not now, has history) | closed (done, not coming back). Default someday. Nothing returns to someday (status_guard). Flipped to active by status_activate_on_event and status_activate_on_execution, from someday or background, never from closed. Independent of archived, which is visibility only: closing does not archive. Backfilled by Restructure P1: live rows active, archived rows closed.';
comment on column public.intents.status_changed_at is
  'When status last changed. Owned by status_guard: client writes to it are ignored. Backfill: archived rows took updated_at (the archive time), live rows the migration time.';
comment on column public.inbox.suggested_status is
  'Enrichment''s suggested status for the item and/or intention this capture becomes: someday (default) or active. One value covers both. Active only for a deadline, a named date, an explicit commitment, or a health or money urgency signal.';

-- ============================================================================
-- E. status_guard. Generic: any table with status + status_changed_at
--    (item_groups in Phase 5). BEFORE UPDATE.
-- ============================================================================
create or replace function public.status_guard()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  -- Nothing returns to someday; this also defeats a stale whole-record write.
  if new.status = 'someday' and old.status is distinct from 'someday' then
    new.status := old.status;
  end if;

  if new.status is distinct from old.status then
    new.status_changed_at := now();
  else
    new.status_changed_at := old.status_changed_at;
  end if;

  return new;
end;
$function$;

comment on function public.status_guard() is
  'Restructure P1. BEFORE UPDATE on any table with status and status_changed_at. Keeps the old status when an update would move it back to someday, stamps status_changed_at when status changes, and otherwise keeps the stored status_changed_at.';

create trigger items_status_guard
  before update on public.items
  for each row execute function public.status_guard();

create trigger intents_status_guard
  before update on public.intents
  for each row execute function public.status_guard();

-- ============================================================================
-- F. Activation. AFTER INSERT, SECURITY INVOKER so RLS still decides what the
--    writer may change. A failure here warns and never blocks the insert.
-- ============================================================================
create or replace function public.status_activate_on_event()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  update public.intents
     set status = 'active'
   where id = new.intent_id
     and status in ('someday', 'background');
  return null;
exception when others then
  raise warning 'status_activate_on_event % failed: %', new.id, sqlerrm;
  return null;
end;
$function$;

comment on function public.status_activate_on_event() is
  'Restructure P1. AFTER INSERT on events: scheduling is committing, so the intention moves to active from someday or background. Never from closed. A safety net behind the browser write; never blocks it.';

create trigger events_status_activate
  after insert on public.events
  for each row when (new.archived is not true)
  execute function public.status_activate_on_event();

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
     and status in ('someday', 'background');

  update public.items
     set status = 'active'
   where status in ('someday', 'background')
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
  'Restructure P1. AFTER INSERT on executions: the intention, its item and every id in item_ids move to active from someday or background. Never from closed. A safety net behind the browser write; never blocks it.';

create trigger executions_status_activate
  after insert on public.executions
  for each row execute function public.status_activate_on_execution();

-- ============================================================================
-- G. platform_search_items: status in the output, p_status filter. The
--    signature changes, so the old one is dropped rather than overloaded
--    (an overload makes PostgREST's named-argument call ambiguous). Body is
--    039's plus status; SECURITY DEFINER and the auth.uid() filter kept.
--    Grants match the pre-flight ACL exactly, PUBLIC and anon included.
-- ============================================================================
drop function public.platform_search_items(text, text, text[], integer);

create function public.platform_search_items(
  p_context_id text default null,
  p_search_text text default null,
  p_tags text[] default null,
  p_limit integer default 20,
  p_status text[] default null)
returns jsonb
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
  with filtered as (
    select id, name, description, context_id, tags, is_capture_target, created_at, status
      from items
     where user_id = auth.uid()
       and archived = false
       and (p_context_id  is null or context_id = p_context_id)
       and (p_search_text is null or
            (name ilike '%' || p_search_text || '%' or
             description ilike '%' || p_search_text || '%'))
       and (p_tags is null
            or array_length(p_tags, 1) is null
            or tags && p_tags)
       and (p_status is null
            or array_length(p_status, 1) is null
            or status = any(p_status))
  )
  select jsonb_build_object(
    'rows',
      coalesce(
        (select jsonb_agg(row_to_json(x) order by x.name)
           from (select * from filtered order by name limit p_limit) x),
        '[]'::jsonb),
    'total',
      (select count(*) from filtered)
  );
$function$;

comment on function public.platform_search_items(text, text, text[], integer, text[]) is
  'Alfred: get_items'' reader. Live items owned by the caller, filtered by context, search text, tags (any-of) and status (any-of) before the limit. Returns { rows, total }. Restructure P1 added status and p_status.';

grant execute on function public.platform_search_items(text, text, text[], integer, text[])
  to public, anon, authenticated, service_role;

commit;

-- Then run: check_platform_conformance (expect CONFORMANT).

-- ============================================================================
-- VERIFY (read-only). Expected (Water Plants archived first): items active
-- 396 / closed 59; intents active 61 / closed 132; someday 0 and background 0
-- on both; every inbox row someday; mismatches 0; updated_at touched only by
-- your own edits; four new triggers plus set_updated_at, all tgenabled O; one
-- platform_search_items with five arguments and the same five ACL entries.
-- ============================================================================
-- select json_build_object(
--   'items_by_status', (select coalesce(json_agg(t), '[]'::json) from (
--     select status, archived, count(*) as n from public.items group by 1, 2 order by 1, 2) t),
--   'intents_by_status', (select coalesce(json_agg(t), '[]'::json) from (
--     select status, archived, count(*) as n from public.intents group by 1, 2 order by 1, 2) t),
--   'inbox_by_suggested_status', (select coalesce(json_agg(t), '[]'::json) from (
--     select suggested_status, count(*) as n from public.inbox group by 1) t),
--   'mismatches', (select coalesce(json_agg(t), '[]'::json) from (
--     select 'items' as tbl, count(*) as n from public.items
--      where (archived is true) <> (status = 'closed')
--     union all
--     select 'intents', count(*) from public.intents
--      where (archived is true) <> (status = 'closed')
--     union all
--     select 'closed_changed_at_not_updated_at', count(*) from (
--       select status_changed_at, updated_at, created_at from public.items where status = 'closed'
--       union all
--       select status_changed_at, updated_at, created_at from public.intents where status = 'closed') c
--      where c.status_changed_at <> coalesce(c.updated_at, c.created_at)) t),
--   'updated_at_touched_last_hour', (select coalesce(json_agg(t), '[]'::json) from (
--     select 'items' as tbl, count(*) as n from public.items where updated_at > now() - interval '1 hour'
--     union all
--     select 'intents', count(*) from public.intents where updated_at > now() - interval '1 hour') t),
--   'triggers', (select coalesce(json_agg(t), '[]'::json) from (
--     select tgrelid::regclass::text as tbl, tgname, tgenabled from pg_trigger
--      where tgname in ('items_status_guard', 'intents_status_guard', 'events_status_activate',
--                       'executions_status_activate', 'set_updated_at')
--        and tgrelid in ('public.items'::regclass, 'public.intents'::regclass,
--                        'public.events'::regclass, 'public.executions'::regclass)
--      order by 1, 2) t),
--   'search_items_fn', (select coalesce(json_agg(t), '[]'::json) from (
--     select pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, p.proacl::text as acl
--       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public' and p.proname = 'platform_search_items') t)
-- ) as result;
