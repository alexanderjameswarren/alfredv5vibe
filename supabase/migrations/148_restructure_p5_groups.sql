-- Purpose: Restructure P5 Step 7 (restructure_p5-h7m). Groups: a permanent grouping above items and intentions (Menu in Recipes, Project in Alfred, Series in Alex (body, mind, spirit)). New tables group_types, item_groups, item_group_members; contexts.default_group_type_id; group_id on intents, events and executions; recipe executions inside a menu may have no intention or event; notes on groups; status, last-completed and freeze triggers.
-- Kind: schema change (three new tables, new columns, replaced trigger functions, seed rows)
-- Applied: YES — 2026-10-21 by Alex, whole file, no errors. step7_verify.sql: conformant true, failures []; three group types and context defaults seeded; executions.intent_id and event_id nullable; all 8 indexes, triggers, both checks, policies, 3 realtime tables; all 7 functions handle groups.
--
-- Spec: docs/technical-spec-restructure-p5.md. Run as one block in the SQL editor, then
-- supabase/tests/restructure_p5-h7m/step7_verify.sql. Safe to re-run.
-- Additive only: events_one_live_per_intent and executions_one_open_per_intent are untouched
-- (a null intent_id is never a duplicate). The three replaced functions keep every existing
-- statement and add group statements after them.

begin;

-- 0. The three contexts must exist, once each, before anything changes.
do $$
declare
  v_name text;
  v_n    int;
begin
  foreach v_name in array array['Recipes', 'Alfred', 'Alex (body, mind, spirit)'] loop
    select count(*) into v_n from public.contexts where name = v_name and archived = false;
    if v_n <> 1 then
      raise exception 'groups migration: expected exactly one live context named "%", found %', v_name, v_n;
    end if;
  end loop;
end $$;

-- 1. group_types -------------------------------------------------------------
create table if not exists public.group_types (
  id             text primary key default gen_random_uuid()::text,
  user_id        uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id     text references public.contexts(id) on delete set null,
  label_singular text not null check (btrim(label_singular) <> ''),
  label_plural   text not null check (btrim(label_plural) <> ''),
  icon           text not null default 'Boxes',
  execution_mode text not null check (execution_mode in ('together', 'separately')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.group_types is
  'ALFRED. Restructure P5. What a group is called in a context and how it executes: Menu/Menus in Recipes (together), Project/Projects in Alfred and Series/Series in Alex (body, mind, spirit) (separately). Owner OR shared-context RLS (mirrors intents).';
comment on column public.group_types.context_id is 'The context this type belongs to. On context delete, set null.';
comment on column public.group_types.label_singular is 'Shown in the app: "Create Menu", a group row''s type.';
comment on column public.group_types.label_plural is 'Shown in the app: the browse tab ("Menus") and member counts.';
comment on column public.group_types.icon is 'A lucide-react icon name from the app''s icon set: UtensilsCrossed (menu), SquareKanban (project), ListOrdered (series). Boxes is the fallback for any other type.';
comment on column public.group_types.execution_mode is 'together: one tap executes every item member (menu). separately: members are executed on their own intentions and the group has no Start Now (project, series).';

drop trigger if exists set_updated_at on public.group_types;
create trigger set_updated_at before update on public.group_types
  for each row execute function public.update_updated_at();

select platform.register_table(
  'public.group_types',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Alfred. Restructure P5 group types. Owner OR shared-context RLS (mirrors intents).'
);
drop policy if exists group_types_access on public.group_types;
create policy group_types_access on public.group_types for all to authenticated
  using ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

insert into public.group_types (user_id, context_id, label_singular, label_plural, icon, execution_mode)
select c.user_id, c.id, s.singular, s.plural, s.icon, s.mode
  from (values
    ('Recipes',                   'Menu',    'Menus',    'UtensilsCrossed', 'together'),
    ('Alfred',                    'Project', 'Projects', 'SquareKanban',    'separately'),
    ('Alex (body, mind, spirit)', 'Series',  'Series',   'ListOrdered',     'separately')
  ) as s(context_name, singular, plural, icon, mode)
  join public.contexts c on c.name = s.context_name and c.archived = false
 where not exists (
   select 1 from public.group_types g where g.context_id = c.id and g.label_singular = s.singular);

-- 2. contexts.default_group_type_id ------------------------------------------
alter table public.contexts
  add column if not exists default_group_type_id text references public.group_types(id) on delete set null;
comment on column public.contexts.default_group_type_id is
  'Restructure P5. The group type the context page''s create button uses ("Create Menu"). Null = "Add Group". On type delete, set null.';

update public.contexts c
   set default_group_type_id = g.id
  from public.group_types g
 where g.context_id = c.id
   and c.archived = false
   and (c.name, g.label_singular) in (('Recipes', 'Menu'), ('Alfred', 'Project'), ('Alex (body, mind, spirit)', 'Series'))
   and c.default_group_type_id is null;

-- 3. item_groups -------------------------------------------------------------
create table if not exists public.item_groups (
  id                text primary key default gen_random_uuid()::text,
  user_id           uuid not null default auth.uid() references auth.users(id) on delete restrict,
  group_type_id     text not null references public.group_types(id) on delete restrict,
  context_id        text references public.contexts(id) on delete set null,
  name              text check (name is null or btrim(name) <> ''),
  description       text,
  status            text not null default 'someday'
                      check (status in ('someday', 'active', 'background', 'closed')),
  status_changed_at timestamptz not null default now(),
  status_written_at timestamptz default now(),
  closed_reason     text check (closed_reason in ('done', 'wont_do')),
  last_completed_at timestamptz,
  pinned            boolean not null default false,
  archived          boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.item_groups is
  'ALFRED. Restructure P5. A permanent group above items and intentions: a Menu, a Project, a Series (group_types). Own status, notes (notes.target_type ''group''), pin to Home; scheduled through its own intention (intents.group_id). No tags: search finds a group through its members. Groups do not contain groups. Owner OR shared-context RLS (mirrors intents).';
comment on column public.item_groups.group_type_id is 'What kind of group (group_types). Restrict on delete.';
comment on column public.item_groups.context_id is 'Set from the type at creation; editable. On context delete, set null. Members need not share it.';
comment on column public.item_groups.name is 'Null = derived: built at read time from member names in position order, joined with " + ". Never stored. Typing a name stops derivation; clearing it resumes.';
comment on column public.item_groups.status is 'Same lifecycle as items: someday | active | background | closed. The group''s own, never computed from members; closing never touches members. Moved someday -> active by status_activate_on_execution (its first execution, or a separately group''s first member execution) and status_activate_on_event (its first scheduled event). status_guard: nothing returns to someday except the Undo of a close.';
comment on column public.item_groups.status_changed_at is 'When status last changed; also the closed date. Owned by status_guard, as on items.';
comment on column public.item_groups.status_written_at is 'Server time of the last status change; owned by status_guard, as on items.';
comment on column public.item_groups.closed_reason is 'Why it was closed: done | wont_do, as on items. Null = unknown.';
comment on column public.item_groups.last_completed_at is 'Latest closed, done execution: one carrying this group_id, or (separately groups only) one of a member item or intention. Owned by triggers (executions_last_completed, item_group_members_last_completed); client writes ignored.';
comment on column public.item_groups.pinned is 'Shown in Home''s Pinned Groups, as contexts and collections pin.';
comment on column public.item_groups.archived is 'Should not have existed. Separate from closed.';

drop trigger if exists set_updated_at on public.item_groups;
create trigger set_updated_at before update on public.item_groups
  for each row execute function public.update_updated_at();
drop trigger if exists item_groups_status_guard on public.item_groups;
create trigger item_groups_status_guard before update on public.item_groups
  for each row execute function public.status_guard();
drop trigger if exists item_groups_last_completed_guard on public.item_groups;
create trigger item_groups_last_completed_guard before insert or update on public.item_groups
  for each row execute function public.last_completed_guard();
drop trigger if exists item_groups_delete_notes on public.item_groups;
create trigger item_groups_delete_notes after delete on public.item_groups
  for each row execute function public.notes_delete_for_target('group');

create index if not exists idx_item_groups_context on public.item_groups (context_id);

select platform.register_table(
  'public.item_groups',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Alfred. Restructure P5 groups (menus, projects, series). Owner OR shared-context RLS (mirrors intents).'
);
drop policy if exists item_groups_access on public.item_groups;
create policy item_groups_access on public.item_groups for all to authenticated
  using ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

-- 4. item_group_members ------------------------------------------------------
create table if not exists public.item_group_members (
  id          text primary key default gen_random_uuid()::text,
  group_id    text not null references public.item_groups(id) on delete cascade,
  member_type text not null check (member_type in ('item', 'intention')),
  member_id   text not null,
  position    integer not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (group_id, member_type, member_id)
);

comment on table public.item_group_members is
  'ALFRED. Restructure P5. The items and intentions in a group, in position order. member_id is items.id or intents.id by member_type, with no FK: reads leave out members that are deleted or archived. No context rule: a member may sit in another context. No user_id: access follows the parent group (item_groups RLS).';
comment on column public.item_group_members.member_type is 'item | intention: which table member_id names.';
comment on column public.item_group_members.member_id is 'items.id or intents.id, by member_type. No FK.';
comment on column public.item_group_members.position is 'Order in the group, ascending; set by drag reorder. The derived name follows it.';

create index if not exists idx_item_group_members_member on public.item_group_members (member_type, member_id);

drop trigger if exists set_updated_at on public.item_group_members;
create trigger set_updated_at before update on public.item_group_members
  for each row execute function public.update_updated_at();

select platform.register_table(
  'public.item_group_members',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Alfred. Restructure P5 group members. No user_id: RLS scoped to the parent group (item_groups policy).'
);
drop policy if exists item_group_members_access on public.item_group_members;
create policy item_group_members_access on public.item_group_members for all to authenticated
  using (exists (select 1 from public.item_groups g where g.id = item_group_members.group_id))
  with check (exists (select 1 from public.item_groups g where g.id = item_group_members.group_id));

-- 5. group_id on intents, events, executions ---------------------------------
alter table public.intents
  add column if not exists group_id text references public.item_groups(id) on delete set null;
comment on column public.intents.group_id is
  'Restructure P5. Set on a group''s own intention, which carries the group''s one live event. At most one non-archived intention per group (intents_one_per_group). Members'' own intentions never carry it.';
create unique index if not exists intents_one_per_group on public.intents (group_id)
  where group_id is not null and archived is not true;

alter table public.events
  add column if not exists group_id text references public.item_groups(id) on delete set null;
comment on column public.events.group_id is
  'Restructure P5. Set (by events_group_freeze) when the event is on a group''s intention.';
comment on column public.events.item_ids is
  'jsonb array of item ids consulted for this event. On a group''s intention, frozen at insert from the group''s item members in position order (events_group_freeze), so later group edits do not rewrite history.';
create index if not exists idx_events_group on public.events (group_id) where group_id is not null;

alter table public.executions
  add column if not exists group_id text references public.item_groups(id) on delete set null;
comment on column public.executions.group_id is
  'Restructure P5. The group this execution belongs to: a menu''s own execution (on the menu''s intention) and each recipe execution inside it. Copied from the intention by executions_group_tag when not given.';
create index if not exists idx_executions_group on public.executions (group_id) where group_id is not null;

alter table public.executions alter column intent_id drop not null;
alter table public.executions alter column event_id drop not null;
comment on column public.executions.intent_id is
  'The intention executed. Null only for a recipe execution inside a menu (group_id set, the recipe in item_ids), so recipes'' own events and open-execution rules are untouched. Restructure P5.';
comment on column public.executions.event_id is
  'The event executed. Null only when intent_id is null (a recipe execution inside a menu). Restructure P5.';
alter table public.executions drop constraint if exists executions_has_subject;
alter table public.executions add constraint executions_has_subject
  check (intent_id is not null or group_id is not null or coalesce(item_ids, '[]'::jsonb) <> '[]'::jsonb);

-- 6. notes on groups ---------------------------------------------------------
alter table public.notes drop constraint if exists notes_target_type_check;
alter table public.notes add constraint notes_target_type_check
  check (target_type in ('item', 'intention', 'group'));
comment on column public.notes.target_type is 'What target_id names: ''item'', ''intention'' or ''group'' (Restructure P5).';
comment on column public.notes.target_id is 'items.id, intents.id or item_groups.id, by target_type. No FK; notes_delete_for_target removes notes with their target. Execution notes target the execution''s intention.';

drop policy if exists notes_insert on public.notes;
create policy notes_insert on public.notes for insert to authenticated
  with check (
    (user_id = auth.uid())
    and (
      (target_type = 'item' and exists (
        select 1 from public.items i where i.id = notes.target_id and coalesce(i.archived, false) = false))
      or (target_type = 'intention' and exists (
        select 1 from public.intents t where t.id = notes.target_id and coalesce(t.archived, false) = false))
      or (target_type = 'group' and exists (
        select 1 from public.item_groups g where g.id = notes.target_id and g.archived = false))
    )
    and (execution_id is null or exists (select 1 from public.executions x where x.id = notes.execution_id))
  );

drop policy if exists notes_select on public.notes;
create policy notes_select on public.notes for select to authenticated
  using (
    (target_type = 'item' and exists (select 1 from public.items i where i.id = notes.target_id))
    or (target_type = 'intention' and exists (select 1 from public.intents t where t.id = notes.target_id))
    or (target_type = 'group' and exists (select 1 from public.item_groups g where g.id = notes.target_id))
  );

drop policy if exists notes_update on public.notes;
create policy notes_update on public.notes for update to authenticated
  using (user_id = auth.uid())
  with check (
    (user_id = auth.uid())
    and (
      (target_type = 'item' and exists (select 1 from public.items i where i.id = notes.target_id))
      or (target_type = 'intention' and exists (select 1 from public.intents t where t.id = notes.target_id))
      or (target_type = 'group' and exists (select 1 from public.item_groups g where g.id = notes.target_id))
    )
  );

-- 7. last_completed_at on groups ---------------------------------------------
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
                       and ((m.member_type = 'intention' and m.member_id = x.intent_id)
                            or (m.member_type = 'item'
                                and (x.item_ids ? m.member_id
                                     or x.intent_id in (select i.id from public.intents i where i.item_id = m.member_id))))))) s
   where g.id = p_group_id
     and g.last_completed_at is distinct from s.v;
$$;
comment on function public.recalc_last_completed_group(text) is
  'Restructure P5. Recompute item_groups.last_completed_at: latest closed, done execution carrying the group_id, or for a separately group one of a member item or intention. Done-only, as items. Called by executions_last_completed and item_group_members_last_completed.';
revoke all on function public.recalc_last_completed_group(text) from public, anon;

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
                            or new.member_id is distinct from old.member_id) then
    perform public.recalc_last_completed_group(new.group_id);
  end if;
  return null;
end;
$$;
comment on function public.item_group_members_last_completed() is
  'Restructure P5. A member added, removed or changed recomputes its group''s last_completed_at (matters for separately groups).';
revoke all on function public.item_group_members_last_completed() from public, anon;
drop trigger if exists item_group_members_last_completed on public.item_group_members;
create trigger item_group_members_last_completed after insert or update or delete on public.item_group_members
  for each row execute function public.item_group_members_last_completed();

-- 8. someday -> active -------------------------------------------------------
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

create or replace function public.status_activate_on_event() returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $$
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

  -- Restructure P5: a group's first scheduled event (someday only, as items).
  update public.item_groups
     set status = 'active'
   where status = 'someday'
     and id = new.group_id;
  return null;
exception when others then
  raise warning 'status_activate_on_event % failed: %', new.id, sqlerrm;
  return null;
end;
$$;

-- 9. group_id and frozen item_ids at insert ---------------------------------
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
       and coalesce(i.archived, false) = false;
    new.item_ids := v_ids;
  end if;
  return new;
end;
$$;
comment on function public.events_group_freeze() is
  'Restructure P5. BEFORE INSERT on events: on a group''s intention, sets group_id and, when item_ids is empty, freezes the group''s live item members into it in position order. status_activate_on_event then moves those items someday -> active (accepted: scheduling a menu is a commitment to cook its recipes; never out of background).';
drop trigger if exists events_group_freeze on public.events;
create trigger events_group_freeze before insert on public.events
  for each row execute function public.events_group_freeze();

create or replace function public.executions_group_tag() returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_group text;
begin
  if new.group_id is null and new.intent_id is not null then
    select group_id into v_group from public.intents where id = new.intent_id;
    new.group_id := v_group;
  end if;
  return new;
end;
$$;
comment on function public.executions_group_tag() is
  'Restructure P5. BEFORE INSERT on executions: an execution on a group''s intention carries that group_id when the app did not set it.';
drop trigger if exists executions_group_tag on public.executions;
create trigger executions_group_tag before insert on public.executions
  for each row execute function public.executions_group_tag();

-- 10. realtime ---------------------------------------------------------------
do $$
declare
  v_table text;
begin
  foreach v_table in array array['group_types', 'item_groups', 'item_group_members'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end $$;

commit;
