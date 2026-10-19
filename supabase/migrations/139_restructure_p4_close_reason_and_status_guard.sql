-- Purpose: Restructure P4, Step 11 — the database step. Schema change, applied once, in order.
--
-- a. (Moved out: the intents.is_item drop is its own migration, applied after the
--    ai-enrich and mcp redeploys — see _pending_restructure_p4-v9k_drop_is_item.sql.)
-- b. closed_reason on items and intents: 'done' | 'wont_do', nullable (null = unknown).
-- c. status_guard: closed -> someday is allowed within 10 minutes of the close (the Undo
--    window), and an app-supplied status_changed_at on a status change is kept when it is
--    no later than now() (Closed on; an Undo restoring the earlier value). Every other rule
--    is unchanged: nothing else returns to someday, and an update that does not change
--    status keeps the stored status_changed_at. The window is measured from a new
--    server-only column, status_written_at (now() at every status change), because
--    status_changed_at may now hold a past Closed on date.
-- d. reminders joins the supabase_realtime publication (reminder badges, Step 12).
-- e. executions.prior_event_date and executions.prior_intent_status: what Start Now
--    changed, so Delete Execution of an in-progress execution can put it back.
-- f. Backfill closed_reason = 'done' on the eight records Alex confirmed as completed
--    (closed rows only; an item's closed intentions too). Every other closed row stays null.
-- g. platform_search_items (get_items' reader) returns closed_reason.
--    No last_completed change is needed: executions_last_completed (100) already
--    recomputes on delete. The skipped-execution wording is in the MCP code, not here.
--
-- New columns only; no new tables, so no platform.register_table call. Run
-- check_platform_conformance after applying.

begin;

-- b. ---------------------------------------------------------------------------
alter table public.intents
  add column if not exists closed_reason text
  constraint intents_closed_reason_check check (closed_reason in ('done', 'wont_do'));
alter table public.items
  add column if not exists closed_reason text
  constraint items_closed_reason_check check (closed_reason in ('done', 'wont_do'));

comment on column public.intents.closed_reason is
  'Restructure P4. Why it was closed: done (Completed) | wont_do (Won''t do). Null = unknown (closed before P4, or never recorded). Written by the app''s Close pop-up and by the automatic close of a one-time intention on completion; not cleared on reopen.';
comment on column public.items.closed_reason is
  'Restructure P4. Why it was closed: done (Completed) | wont_do (Won''t do). Null = unknown (closed before P4, or never recorded). Written by the app''s Close pop-up; not cleared on reopen.';

-- c. ---------------------------------------------------------------------------
-- Added empty, filled from status_changed_at, THEN given its default: a default on the
-- add would stamp every existing row now() and open the Undo window on every closed row.
-- (The fill writes one audit row per intention and item.)
alter table public.intents add column if not exists status_written_at timestamptz;
alter table public.items   add column if not exists status_written_at timestamptz;
update public.intents set status_written_at = status_changed_at where status_written_at is null;
update public.items   set status_written_at = status_changed_at where status_written_at is null;
alter table public.intents alter column status_written_at set default now();
alter table public.items   alter column status_written_at set default now();

comment on column public.intents.status_written_at is
  'Restructure P4. Server time of the last status change, always now(); owned by status_guard, client writes ignored. Measures the 10-minute Undo window for closed -> someday, since status_changed_at may hold an app-supplied past date.';
comment on column public.items.status_written_at is
  'Restructure P4. Server time of the last status change, always now(); owned by status_guard, client writes ignored. Measures the 10-minute Undo window for closed -> someday, since status_changed_at may hold an app-supplied past date.';

create or replace function public.status_guard()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  -- Nothing returns to someday; this also defeats a stale whole-record write.
  -- Restructure P4: except the Undo of a close, within 10 minutes of it.
  if new.status = 'someday' and old.status is distinct from 'someday' then
    if not (old.status = 'closed'
            and old.status_written_at is not null
            and old.status_written_at > now() - interval '10 minutes') then
      new.status := old.status;
    end if;
  end if;

  if new.status is distinct from old.status then
    new.status_written_at := now();
    -- Restructure P4: a value the app supplies with the change (Closed on, or an
    -- Undo putting the earlier one back) is kept, if it is not in the future.
    if new.status_changed_at is distinct from old.status_changed_at
       and new.status_changed_at is not null
       and new.status_changed_at <= now() then
      null;
    else
      new.status_changed_at := now();
    end if;
  else
    new.status_written_at := old.status_written_at;
    new.status_changed_at := old.status_changed_at;
  end if;

  return new;
end;
$function$;

comment on function public.status_guard() is
  'Restructure P1, P4. BEFORE UPDATE on any table with status, status_changed_at and status_written_at (intents, items). Keeps the old status when an update would move it back to someday, except closed -> someday within 10 minutes of the close by status_written_at (Undo). On a status change, stamps status_written_at now(), keeps an app-supplied status_changed_at that is no later than now() and otherwise stamps now(); an update that does not change status keeps both stored values.';

comment on column public.intents.status_changed_at is
  'When status last changed. Owned by status_guard: stamped now() on a status change unless the app supplies a value no later than now() with it (Closed on; Undo). Ignored on updates that do not change status. Backfill: archived rows took updated_at, live rows the migration time.';
comment on column public.items.status_changed_at is
  'When status last changed. Owned by status_guard: stamped now() on a status change unless the app supplies a value no later than now() with it (Closed on; Undo). Ignored on updates that do not change status. Backfill: archived rows took updated_at, live rows the migration time.';

-- d. ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'reminders'
  ) then
    alter publication supabase_realtime add table public.reminders;
  end if;
end;
$$;

-- e. ---------------------------------------------------------------------------
alter table public.executions
  add column if not exists prior_event_date date,
  add column if not exists prior_intent_status text
    constraint executions_prior_intent_status_check
    check (prior_intent_status in ('someday', 'active', 'background'));

comment on column public.executions.prior_event_date is
  'Restructure P4. The live event''s date before Start Now moved it to today; null when Start Now moved nothing. Delete Execution of an in-progress execution puts it back when the event is still on the day it was moved to and this date is today or later.';
comment on column public.executions.prior_intent_status is
  'Restructure P4. The intention''s status before Start Now un-parked it (background); null when Start Now changed no status. Delete Execution of an in-progress execution restores it.';

-- f. ---------------------------------------------------------------------------
-- Alex confirmed these eight as completed (2026-10-19). Each may be an intention or an
-- item; only closed rows are touched, and an item's closed intentions get it too.
with confirmed(id) as (
  values ('mv6yeccg1oa121ig79n'), ('mv6yea9syk2x3xv03h'), ('mv46b90ch3dxe50ylsg'),
         ('mue50p2vjlonxqxsz'), ('mu1hjakl33wozaoavj7'), ('mtfwg4zyjt0m9hunisq'),
         ('mtfw991ql9m3924ty7'), ('mtiw3f8vjwewbnfrw7')
)
update public.intents t
   set closed_reason = 'done'
 where t.status = 'closed'
   and t.closed_reason is null
   and (t.id in (select id from confirmed) or t.item_id in (select id from confirmed));

with confirmed(id) as (
  values ('mv6yeccg1oa121ig79n'), ('mv6yea9syk2x3xv03h'), ('mv46b90ch3dxe50ylsg'),
         ('mue50p2vjlonxqxsz'), ('mu1hjakl33wozaoavj7'), ('mtfwg4zyjt0m9hunisq'),
         ('mtfw991ql9m3924ty7'), ('mtiw3f8vjwewbnfrw7')
)
update public.items i
   set closed_reason = 'done'
 where i.status = 'closed'
   and i.closed_reason is null
   and i.id in (select id from confirmed);

-- g. ---------------------------------------------------------------------------
create or replace function public.platform_search_items(
  p_context_id  text    default null,
  p_search_text text    default null,
  p_tags        text[]  default null,
  p_limit       integer default 20,
  p_status      text[]  default null)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  with filtered as (
    select i.id, i.name, i.description, i.context_id, i.tags, i.is_capture_target,
           i.created_at, i.status, i.closed_reason, i.last_completed_at
      from items i
     where i.user_id = auth.uid()
       and i.archived = false
       and (p_context_id  is null or i.context_id = p_context_id)
       and (p_search_text is null or
            i.name ilike '%' || p_search_text || '%' or
            i.description ilike '%' || p_search_text || '%' or
            exists (select 1 from notes n
                     where n.body ilike '%' || p_search_text || '%'
                       and ((n.target_type = 'item' and n.target_id = i.id)
                            or (n.target_type = 'intention'
                                and n.target_id in (select t.id from intents t where t.item_id = i.id))
                            or n.execution_id in (select x.id from executions x where x.item_ids ? i.id))))
       and (p_tags is null
            or array_length(p_tags, 1) is null
            or i.tags && p_tags)
       and (p_status is null
            or array_length(p_status, 1) is null
            or i.status = any(p_status))
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
$$;

comment on function public.platform_search_items(text, text, text[], integer, text[]) is
  'Alfred: get_items'' reader. Live items owned by the caller, filtered by context, search text, tags (any-of) and status (any-of) before the limit. Returns { rows, total }. Restructure P1 added status and p_status. Restructure P2: search text also matches notes on the item, its intentions and its executions; rows carry last_completed_at. Restructure P4: rows carry closed_reason.';

commit;

-- Verification, read-only, after applying (paste back the one result cell):
--
-- select json_build_object(
--   'new_columns', (select coalesce(json_agg(t), '[]'::json) from (
--       select table_name, column_name, data_type, column_default from information_schema.columns
--        where table_schema = 'public'
--          and ((table_name in ('intents', 'items') and column_name in ('closed_reason', 'status_written_at'))
--            or (table_name = 'executions' and column_name in ('prior_event_date', 'prior_intent_status')))
--        order by table_name, column_name) t),
--   'status_written_at_unfilled', (select coalesce(json_agg(t), '[]'::json) from (
--       select 'intents' as tbl, count(*) as n from public.intents where status_written_at is null
--       union all
--       select 'items', count(*) from public.items where status_written_at is null) t),
--   'reminders_in_realtime', (select coalesce(json_agg(t), '[]'::json) from (
--       select tablename from pg_publication_tables
--        where pubname = 'supabase_realtime' and tablename = 'reminders') t),
--   'backfilled', (select coalesce(json_agg(t), '[]'::json) from (
--       select 'intent' as kind, id, text as name, status, closed_reason from public.intents where closed_reason is not null
--       union all
--       select 'item', id, name, status, closed_reason from public.items where closed_reason is not null) t),
--   'guard_comment', (select coalesce(json_agg(t), '[]'::json) from (
--       select obj_description('public.status_guard()'::regprocedure) as comment) t),
--   'search_items_comment', (select coalesce(json_agg(t), '[]'::json) from (
--       select obj_description('public.platform_search_items(text, text, text[], integer, text[])'::regprocedure) as comment) t)
-- ) as result;
