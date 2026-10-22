-- Purpose: Restructure P5 Step 9 follow-up (restructure_p5-h7m). Group members are removed by marking them (removed_at, removed_by) instead of deleting, so a group keeps a removal history and a removed member can be put back. Only one live row per member: the unique rule now applies to live rows only, so a removed member can be added again. Removed members are left out of last_completed_at, status activation and frozen event item_ids.
-- Kind: schema change (two columns, index swap, one new trigger, five replaced functions)
-- Applied: NO
--
-- Spec: docs/technical-spec-restructure-p5.md. Run as one block in the SQL editor, then
-- supabase/tests/restructure_p5-h7m/step9_member_removal_verify.sql. Safe to re-run.
-- Collections keep removals in a separate append-only table (collection_item_removals) and
-- delete the member; groups mark the member instead, as Alex asked, and Put back appends at
-- the end as collections do.

begin;

-- 1. Removal columns ---------------------------------------------------------
alter table public.item_group_members add column if not exists removed_at timestamptz;
alter table public.item_group_members
  add column if not exists removed_by uuid references auth.users(id) on delete set null;
comment on column public.item_group_members.removed_at is
  'Restructure P5. When the member was removed from the group; null = a live member. Removed rows are the group''s removal history and are left out of every read, the derived name, last_completed_at, status activation and frozen event item_ids.';
comment on column public.item_group_members.removed_by is
  'auth.uid() of the person who removed it, stamped by item_group_members_stamp_removal; null while live.';
comment on table public.item_group_members is
  'ALFRED. Restructure P5. The items and intentions in a group, in position order. member_id is items.id or intents.id by member_type, with no FK: reads leave out members that are deleted or archived. Removing a member sets removed_at (history; Put back clears it). One live row per member (item_group_members_live_unique). No context rule: a member may sit in another context. No user_id: access follows the parent group (item_groups RLS).';

-- 2. One LIVE row per member -------------------------------------------------
alter table public.item_group_members
  drop constraint if exists item_group_members_group_id_member_type_member_id_key;
create unique index if not exists item_group_members_live_unique
  on public.item_group_members (group_id, member_type, member_id) where removed_at is null;
create index if not exists idx_item_group_members_removed
  on public.item_group_members (group_id, removed_at desc) where removed_at is not null;

-- 3. Who removed it ----------------------------------------------------------
create or replace function public.item_group_members_stamp_removal() returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $$
begin
  if new.removed_at is null then
    new.removed_by := null;
  elsif tg_op = 'INSERT' or old.removed_at is null then
    new.removed_by := auth.uid();
  else
    new.removed_by := old.removed_by;
  end if;
  return new;
end;
$$;
comment on function public.item_group_members_stamp_removal() is
  'Restructure P5. BEFORE INSERT OR UPDATE on item_group_members: stamps removed_by with auth.uid() when a member is removed, clears it when put back.';
drop trigger if exists item_group_members_stamp_removal on public.item_group_members;
create trigger item_group_members_stamp_removal before insert or update on public.item_group_members
  for each row execute function public.item_group_members_stamp_removal();

-- 4. Removed members leave last_completed_at ---------------------------------
create or replace function public.recalc_last_completed_group(p_group_id text) returns void
  language sql security definer
  set search_path to 'public', 'pg_temp'
as $$
  update public.item_groups g
     set last_completed_at = s.v
    from (select max(coalesce(x.closed_at, x.started_at)) as v
            from public.executions x
           where x.status = 'closed' and x.outcome = 'done'
             and (x.group_id = p_group_id
                  or exists (
                    select 1
                      from public.item_groups g2
                      join public.group_types t on t.id = g2.group_type_id
                      join public.item_group_members m on m.group_id = g2.id
                     where g2.id = p_group_id
                       and t.execution_mode = 'separately'
                       and m.removed_at is null
                       and ((m.member_type = 'intention' and m.member_id = x.intent_id)
                            or (m.member_type = 'item'
                                and (x.item_ids ? m.member_id
                                     or x.intent_id in (select i.id from public.intents i where i.item_id = m.member_id))))))) s
   where g.id = p_group_id
     and g.last_completed_at is distinct from s.v;
$$;

create or replace function public.executions_last_completed() returns trigger
  language plpgsql security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_intents text[];
  v_items   text[];
  v_groups  text[];
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
     and old.item_ids   is not distinct from new.item_ids
     and old.group_id   is not distinct from new.group_id then
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

  -- Restructure P5: the execution's own group, and separately groups holding its item or intention.
  select coalesce(array_agg(distinct g), '{}') into v_groups from (
    select old.group_id as g where tg_op <> 'INSERT' and old.group_id is not null
    union
    select new.group_id where tg_op <> 'DELETE' and new.group_id is not null
    union
    select m.group_id
      from public.item_group_members m
      join public.item_groups ig on ig.id = m.group_id
      join public.group_types t on t.id = ig.group_type_id
     where t.execution_mode = 'separately'
       and m.removed_at is null
       and ((m.member_type = 'intention' and m.member_id = any(v_intents))
            or (m.member_type = 'item' and m.member_id = any(v_items)))
  ) s;
  foreach v_id in array v_groups loop
    perform public.recalc_last_completed_group(v_id);
  end loop;
  return null;
end;
$$;

create or replace function public.item_group_members_last_completed() returns trigger
  language plpgsql security definer
  set search_path to 'public', 'pg_temp'
as $$
begin
  if tg_op <> 'INSERT' then
    perform public.recalc_last_completed_group(old.group_id);
  end if;
  if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.group_id is distinct from old.group_id
                            or new.member_type is distinct from old.member_type
                            or new.member_id is distinct from old.member_id
                            or new.removed_at is distinct from old.removed_at) then
    perform public.recalc_last_completed_group(new.group_id);
  end if;
  return null;
end;
$$;

-- 5. Removed members leave status activation and frozen event item_ids -------
create or replace function public.status_activate_on_execution() returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $$
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

  -- Restructure P5: the execution's own group, and separately groups holding its item or intention.
  update public.item_groups g
     set status = 'active'
   where g.status = 'someday'
     and (g.id = new.group_id
          or g.id in (
            select m.group_id
              from public.item_group_members m
              join public.item_groups g2 on g2.id = m.group_id
              join public.group_types t on t.id = g2.group_type_id
             where t.execution_mode = 'separately'
               and m.removed_at is null
               and ((m.member_type = 'intention' and m.member_id = new.intent_id)
                    or (m.member_type = 'item' and m.member_id in (
                          select i.item_id from public.intents i
                           where i.id = new.intent_id and i.item_id is not null
                          union
                          select jsonb_array_elements_text(ids))))));
  return null;
exception when others then
  raise warning 'status_activate_on_execution % failed: %', new.id, sqlerrm;
  return null;
end;
$$;

create or replace function public.events_group_freeze() returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_group text;
  v_ids   jsonb;
begin
  select group_id into v_group from public.intents where id = new.intent_id;
  if v_group is null then
    return new;
  end if;
  new.group_id := v_group;
  if new.item_ids is null or new.item_ids = '[]'::jsonb then
    select coalesce(jsonb_agg(m.member_id order by m.position, m.member_id), '[]'::jsonb)
      into v_ids
      from public.item_group_members m
      join public.items i on i.id = m.member_id
     where m.group_id = v_group
       and m.member_type = 'item'
       and m.removed_at is null
       and coalesce(i.archived, false) = false;
    new.item_ids := v_ids;
  end if;
  return new;
end;
$$;

commit;
