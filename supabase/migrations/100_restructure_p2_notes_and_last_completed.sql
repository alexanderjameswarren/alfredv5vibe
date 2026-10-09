-- Purpose: Restructure Phase 2, step 1. A notes table for items, intentions and
--          executions; existing execution notes moved into it; last_completed_at
--          on items and intentions, kept by triggers; search functions read notes.
-- Kind: schema change, with a one-off backfill. Apply once, in order.
-- Applied: NO — awaiting Alex.
-- Progress: docs/restructure-p2-progress.md.
-- supabase/migrations/100_restructure_p2_notes_and_last_completed.sql
--
-- executions.notes is NOT dropped here: the app still writes it until step 2.
-- Step 5 copies anything written after this backfill and drops the column.

begin;

-- ============================================================================
-- A. notes
-- ============================================================================
create table public.notes (
  id            text primary key default gen_random_uuid()::text,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete restrict,
  target_type   text not null check (target_type in ('item', 'intention')),
  target_id     text not null,
  body          text not null check (length(btrim(body)) > 0),
  execution_id  text references public.executions(id) on delete cascade,
  applied_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index notes_target_idx on public.notes (target_type, target_id);
create index notes_execution_idx on public.notes (execution_id) where execution_id is not null;

comment on table public.notes is
  'ALFRED. Notes on an item or an intention, optionally written during one execution. '
  'Target is target_type + target_id with no FK: a trigger on items and intents deletes a '
  'record''s notes when the record is deleted. RLS follows the target: whoever can see the item '
  'or intention can read its notes and add to it (not while it is archived); only the author '
  'edits or deletes. Replaces executions.notes (Restructure P2).';
comment on column public.notes.id is 'Text id, like every Alfred record. Defaults to a uuid.';
comment on column public.notes.user_id is 'The author. Only the author can edit or delete the note.';
comment on column public.notes.target_type is 'What target_id names: ''item'' or ''intention''.';
comment on column public.notes.target_id is
  'items.id or intents.id, by target_type. No FK; notes_delete_for_target removes notes with their target. '
  'Execution notes target the execution''s intention.';
comment on column public.notes.body is 'The note. Never empty: an emptied note is deleted, not saved blank.';
comment on column public.notes.execution_id is
  'The execution the note was written during, or null for a general note. ON DELETE CASCADE: '
  'deleting an execution deletes its notes.';
comment on column public.notes.applied_at is
  'When the note''s lesson was applied back to its item. Unused until Phase 10''s note scan.';
comment on column public.notes.created_at is 'When the note was written. Backfilled notes take the execution''s start.';
comment on column public.notes.updated_at is 'Last edit, stamped by notes_touch_updated_at.';

create or replace function public.notes_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
comment on function public.notes_touch_updated_at() is 'Alfred: stamps notes.updated_at.';

create trigger notes_touch_updated_at
  before update on public.notes
  for each row execute function public.notes_touch_updated_at();

-- Custom RLS (contract case a), so policy_mode 'none'; register_table still
-- enables RLS, grants, strips anon and attaches the audit trigger.
select platform.register_table(
  'public.notes',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Alfred. Notes on items and intentions, optionally tied to an execution. '
                   'RLS via the target item or intention (EXISTS inherits their owner-or-shared-context '
                   'rules); author-only edit and delete.'
);

-- The EXISTS subqueries run under the caller's RLS on items and intents, so
-- notes inherit exactly who can see the target.
create policy notes_select on public.notes
  for select to authenticated
  using (
    (target_type = 'item'      and exists (select 1 from public.items  i where i.id = notes.target_id))
    or
    (target_type = 'intention' and exists (select 1 from public.intents t where t.id = notes.target_id))
  );

create policy notes_insert on public.notes
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and (
      (target_type = 'item'      and exists (select 1 from public.items  i
                                              where i.id = notes.target_id and coalesce(i.archived, false) = false))
      or
      (target_type = 'intention' and exists (select 1 from public.intents t
                                              where t.id = notes.target_id and coalesce(t.archived, false) = false))
    )
    and (execution_id is null or exists (select 1 from public.executions x where x.id = notes.execution_id))
  );

create policy notes_update on public.notes
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and (
      (target_type = 'item'      and exists (select 1 from public.items  i where i.id = notes.target_id))
      or
      (target_type = 'intention' and exists (select 1 from public.intents t where t.id = notes.target_id))
    )
  );

create policy notes_delete on public.notes
  for delete to authenticated
  using (user_id = auth.uid());

-- Deleting an item or intention deletes its notes. SECURITY DEFINER because a
-- collaborator deleting a shared record must also remove notes others wrote.
create or replace function public.notes_delete_for_target()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.notes where target_type = tg_argv[0] and target_id = old.id;
  return null;
end;
$$;
comment on function public.notes_delete_for_target() is
  'Restructure P2. AFTER DELETE on items (arg ''item'') and intents (arg ''intention''): deletes the record''s notes.';
revoke all on function public.notes_delete_for_target() from public, anon, authenticated;

create trigger items_delete_notes
  after delete on public.items
  for each row execute function public.notes_delete_for_target('item');

create trigger intents_delete_notes
  after delete on public.intents
  for each row execute function public.notes_delete_for_target('intention');

-- Backfill: every non-empty executions.notes becomes one note on the
-- execution's intention. Idempotent on execution_id.
insert into public.notes (user_id, target_type, target_id, body, execution_id, created_at, updated_at)
select x.user_id, 'intention', x.intent_id, x.notes, x.id,
       coalesce(x.started_at, x.created_at, now()),
       coalesce(x.closed_at, x.updated_at, now())
  from public.executions x
 where nullif(btrim(x.notes), '') is not null
   and exists (select 1 from public.intents t where t.id = x.intent_id)
   and not exists (select 1 from public.notes n where n.execution_id = x.id);

-- ============================================================================
-- B. last_completed_at on items and intentions
-- ============================================================================
-- "Completed" = status closed and outcome done (cancel deletes the row). The
-- time is closed_at, falling back to started_at.
alter table public.items   add column last_completed_at timestamptz;
alter table public.intents add column last_completed_at timestamptz;

comment on column public.items.last_completed_at is
  'Latest completion (closed + done execution) across every execution linked to this item, through '
  'executions.item_ids or through an intention whose item_id is this item. Owned by triggers '
  '(executions_last_completed, intents_last_completed): client writes are ignored. Restructure P2.';
comment on column public.intents.last_completed_at is
  'Latest completion (closed + done execution) of this intention. Owned by executions_last_completed: '
  'client writes are ignored. Recalculated on execution insert, update and delete. Restructure P2.';

-- Client writes are ignored, as status_guard does for status_changed_at. The
-- recalculation runs inside another trigger (depth > 1) and passes through.
create or replace function public.last_completed_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if pg_trigger_depth() <= 1 then
    if tg_op = 'INSERT' then
      new.last_completed_at := null;
    else
      new.last_completed_at := old.last_completed_at;
    end if;
  end if;
  return new;
end;
$$;
comment on function public.last_completed_guard() is
  'Restructure P2. BEFORE INSERT OR UPDATE on items and intents: last_completed_at only changes from inside the recalculation triggers.';

create trigger items_last_completed_guard
  before insert or update on public.items
  for each row execute function public.last_completed_guard();

create trigger intents_last_completed_guard
  before insert or update on public.intents
  for each row execute function public.last_completed_guard();

create or replace function public.recalc_last_completed_intent(p_intent_id text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.intents t
     set last_completed_at = s.v
    from (select max(coalesce(x.closed_at, x.started_at)) as v
            from public.executions x
           where x.intent_id = p_intent_id
             and x.status = 'closed' and x.outcome = 'done') s
   where t.id = p_intent_id
     and t.last_completed_at is distinct from s.v;
$$;

create or replace function public.recalc_last_completed_item(p_item_id text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.items i
     set last_completed_at = s.v
    from (select max(coalesce(x.closed_at, x.started_at)) as v
            from public.executions x
           where x.status = 'closed' and x.outcome = 'done'
             and (x.item_ids ? p_item_id
                  or x.intent_id in (select t.id from public.intents t where t.item_id = p_item_id))) s
   where i.id = p_item_id
     and i.last_completed_at is distinct from s.v;
$$;

comment on function public.recalc_last_completed_intent(text) is 'Restructure P2. Recomputes one intention''s last_completed_at. Trigger use only.';
comment on function public.recalc_last_completed_item(text) is 'Restructure P2. Recomputes one item''s last_completed_at. Trigger use only.';
revoke all on function public.recalc_last_completed_intent(text) from public, anon, authenticated;
revoke all on function public.recalc_last_completed_item(text)   from public, anon, authenticated;

create or replace function public.executions_last_completed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_intents text[];
  v_items   text[];
  v_id      text;
begin
  -- Nothing to do unless a completed execution appears, changes or disappears.
  if not (coalesce(tg_op <> 'INSERT' and old.status = 'closed' and old.outcome = 'done', false)
          or coalesce(tg_op <> 'DELETE' and new.status = 'closed' and new.outcome = 'done', false)) then
    return null;
  end if;
  if tg_op = 'UPDATE'
     and old.status     is not distinct from new.status
     and old.outcome    is not distinct from new.outcome
     and old.closed_at  is not distinct from new.closed_at
     and old.started_at is not distinct from new.started_at
     and old.intent_id  is not distinct from new.intent_id
     and old.item_ids   is not distinct from new.item_ids then
    return null;
  end if;

  v_intents := array_remove(array[
    case when tg_op <> 'INSERT' then old.intent_id end,
    case when tg_op <> 'DELETE' then new.intent_id end], null);

  select coalesce(array_agg(distinct v), '{}') into v_items from (
    select jsonb_array_elements_text(old.item_ids) as v
     where tg_op <> 'INSERT' and jsonb_typeof(old.item_ids) = 'array'
    union
    select jsonb_array_elements_text(new.item_ids)
     where tg_op <> 'DELETE' and jsonb_typeof(new.item_ids) = 'array'
    union
    select t.item_id from public.intents t
     where t.id = any(v_intents) and t.item_id is not null
  ) s;

  foreach v_id in array v_intents loop
    perform public.recalc_last_completed_intent(v_id);
  end loop;
  foreach v_id in array v_items loop
    perform public.recalc_last_completed_item(v_id);
  end loop;
  return null;
end;
$$;
comment on function public.executions_last_completed() is
  'Restructure P2. AFTER INSERT/UPDATE/DELETE on executions: recalculates last_completed_at on the '
  'intention(s) and item(s) touched by a completed execution — completing, reopening, editing or deleting one.';
revoke all on function public.executions_last_completed() from public, anon, authenticated;

create trigger executions_last_completed
  after insert or update or delete on public.executions
  for each row execute function public.executions_last_completed();

-- An intention moving to another item, or being deleted, changes which
-- executions count for the item(s) it pointed at.
create or replace function public.intents_last_completed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.item_id is not null then
    perform public.recalc_last_completed_item(old.item_id);
  end if;
  if tg_op = 'UPDATE' and new.item_id is not null and new.item_id is distinct from old.item_id then
    perform public.recalc_last_completed_item(new.item_id);
  end if;
  return null;
end;
$$;
comment on function public.intents_last_completed() is
  'Restructure P2. AFTER UPDATE OF item_id or DELETE on intents: recalculates the old and new item''s last_completed_at.';
revoke all on function public.intents_last_completed() from public, anon, authenticated;

create trigger intents_last_completed
  after update of item_id or delete on public.intents
  for each row execute function public.intents_last_completed();

-- Backfill. set_updated_at and the guard are paused so the backfill neither
-- stamps updated_at nor gets reverted (088's precedent).
alter table public.intents disable trigger set_updated_at;
alter table public.intents disable trigger intents_last_completed_guard;
update public.intents t
   set last_completed_at = s.v
  from (select x.intent_id, max(coalesce(x.closed_at, x.started_at)) as v
          from public.executions x
         where x.status = 'closed' and x.outcome = 'done'
         group by x.intent_id) s
 where t.id = s.intent_id;
alter table public.intents enable trigger intents_last_completed_guard;
alter table public.intents enable trigger set_updated_at;

alter table public.items disable trigger set_updated_at;
alter table public.items disable trigger items_last_completed_guard;
update public.items i
   set last_completed_at = (
         select max(coalesce(x.closed_at, x.started_at))
           from public.executions x
          where x.status = 'closed' and x.outcome = 'done'
            and (x.item_ids ? i.id
                 or x.intent_id in (select t.id from public.intents t where t.item_id = i.id)))
 where exists (
         select 1 from public.executions x
          where x.status = 'closed' and x.outcome = 'done'
            and (x.item_ids ? i.id
                 or x.intent_id in (select t.id from public.intents t where t.item_id = i.id)));
alter table public.items enable trigger items_last_completed_guard;
alter table public.items enable trigger set_updated_at;

-- ============================================================================
-- C. Search functions read notes. Same signatures, so grants are kept.
-- ============================================================================
create or replace function public.platform_search_items(
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
    select i.id, i.name, i.description, i.context_id, i.tags, i.is_capture_target,
           i.created_at, i.status, i.last_completed_at
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
$function$;

comment on function public.platform_search_items(text, text, text[], integer, text[]) is
  'Alfred: get_items'' reader. Live items owned by the caller, filtered by context, search text, tags (any-of) and status (any-of) before the limit. Returns { rows, total }. Restructure P1 added status and p_status. Restructure P2: search text also matches notes on the item, its intentions and its executions; rows carry last_completed_at.';

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
      x.context_id,
      (select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'created_at', n.created_at)
                                 order by n.created_at), '[]'::jsonb)
         from notes n where n.execution_id = x.id) as notes
      from executions x
      left join intents i  on i.id  = x.intent_id
      left join events  ev on ev.id = x.event_id
     where (p_intent_id  is null or x.intent_id  = p_intent_id)
       and (p_context_id is null or x.context_id = p_context_id)
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
  'must not be re-implemented here. See migration 077. Restructure P2: each row '
  'carries its notes (id, body, created_at), read under notes RLS.';

-- ============================================================================
-- D. Recent completions for item and intention detail pages
-- ============================================================================
create or replace function public.alfred_recent_completions(
  p_item_id   text default null,
  p_intent_id text default null,
  p_limit     integer default 3)
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(jsonb_agg(row_to_json(y) order by y.completed_at desc), '[]'::jsonb)
    from (
      select x.id as execution_id,
             x.intent_id,
             i.text as intent_text,
             coalesce(x.closed_at, x.started_at) as completed_at,
             (select coalesce(jsonb_agg(jsonb_build_object(
                        'id', n.id, 'user_id', n.user_id, 'body', n.body,
                        'created_at', n.created_at, 'updated_at', n.updated_at)
                      order by n.created_at), '[]'::jsonb)
                from notes n where n.execution_id = x.id) as notes
        from executions x
        left join intents i on i.id = x.intent_id
       where x.status = 'closed' and x.outcome = 'done'
         and ((p_intent_id is not null and x.intent_id = p_intent_id)
              or (p_item_id is not null and (x.item_ids ? p_item_id or i.item_id = p_item_id)))
       order by coalesce(x.closed_at, x.started_at) desc nulls last
       limit least(greatest(coalesce(p_limit, 3), 1), 50)
    ) y;
$function$;

comment on function public.alfred_recent_completions(text, text, integer) is
  'Alfred: the latest completed (closed + done) executions for an item (through item_ids or its '
  'intentions) or for one intention, newest first, each with its notes. Default 3, cap 50. '
  'SECURITY INVOKER: executions and notes RLS apply. Restructure P2, detail pages only.';

revoke all on function public.alfred_recent_completions(text, text, integer) from public, anon;
grant execute on function public.alfred_recent_completions(text, text, integer) to authenticated;

commit;

-- Then run: check_platform_conformance (expect CONFORMANT).
-- The verification query is in the step 1 report (run tag restructure_p2-q7m-s2b-r4tn).
