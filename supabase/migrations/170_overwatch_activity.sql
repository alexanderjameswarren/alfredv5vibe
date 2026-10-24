-- Purpose: Overwatch Step 10 (Phase 2). public.activity, the log of what got done, and the three triggers that write it
-- from Alfred's own closes: executions (done), items and intents (closed as done with no execution logged), and Project
-- groups (closed as done: shipped). Also group_types.kind, the stable name the Project test needs (moved here from
-- Step 11 because two of the triggers depend on it).
-- Kind: schema change (one column with backfill, one new table, three trigger functions, four triggers)
-- Applied: NO
--
-- Spec: docs/technical-spec-overwatch-q4n.md section 4.2. Run as one block in the SQL editor.
-- Then run supabase/tests/overwatch-q4n/8_activity_triggers_test.sql.
-- Safe to re-run: every create, add and backfill is idempotent.
--
-- WHAT THE NEW TRIGGERS CANNOT DO TO WHAT IS ALREADY THERE
--   * They are AFTER triggers and only INSERT or DELETE rows in public.activity. They never touch the row that fired
--     them or any other table, so the existing BEFORE triggers (status_guard, last_completed_guard, set_archived_at,
--     executions_group_tag, set_updated_at) see exactly what they saw before, and the AFTER ones
--     (executions_last_completed, status_activate_on_execution, audit_trigger, notes and reminders triggers) run unchanged.
--   * Each body is wrapped in an exception handler that raises a WARNING and returns: a failure in activity logging can
--     never fail or roll back the close, the execution, or the Undo that fired it (the status_activate pattern).
--   * The items, intents and item_groups triggers fire only on UPDATE OF status, closed_reason, status_changed_at, with a
--     WHEN clause requiring one of them to change, so last_completed_at recalcs and other edits never reach them.
--   * SECURITY DEFINER, so the insert never depends on the caller's RLS; user_id is copied from the row that fired it.
--
-- DE-DUPLICATION (the close flow and the execution flow write the record and its execution with the same timestamp;
-- 10 minutes' tolerance covers status_guard replacing a client time that ran ahead of the database clock):
--   * closeRecords (src/intentions/useIntentionActions.js): intention closed done, THEN a closed done execution inserted.
--     The intention logs; the execution trigger sees the intention closed done at its closed_at and skips.
--   * closeExecution (src/executions/useExecutionActions.js): execution closed done, THEN the intention closed done.
--     The execution logs; the intents trigger sees that execution and skips.
--   * An item closed with its intention: the item trigger skips when that intention or an execution covers it.
--   * A Project group's own intention, and executions on it, never log: the group's shipped row covers them.
--   * Undo deletes the execution (its row goes) or reopens the record (its row goes).
-- supabase/migrations/170_overwatch_activity.sql

begin;

-- ============================================================================
-- 1. group_types.kind
-- ============================================================================
-- "kind", not "key": conformance treats any column name with a "key" part as a possible credential.
alter table public.group_types add column if not exists kind text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conrelid = 'public.group_types'::regclass and conname = 'group_types_kind_values'
  ) then
    alter table public.group_types
      add constraint group_types_kind_values check (kind is null or kind in ('project', 'menu', 'series'));
  end if;
end
$$;

update public.group_types
   set kind = case label_singular when 'Project' then 'project' when 'Menu' then 'menu' when 'Series' then 'series' end
 where kind is null and label_singular in ('Project', 'Menu', 'Series');

comment on column public.group_types.kind is
  'Stable name for the three seeded types: project, menu or series; null for types added in Settings. Code finds '
  'Project groups by kind = ''project'', never by label, so renaming a type changes nothing. Backfilled from the '
  'seeded labels in Overwatch Step 10.';

-- ============================================================================
-- 2. activity
-- ============================================================================
create table if not exists public.activity (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users (id),
  occurred_at timestamptz not null,
  app_id      text        not null default 'alfred' references public.apps (id),
  context_id  text        references public.contexts (id) on delete set null,
  group_id    text        references public.item_groups (id) on delete set null,
  target_type text        not null,
  target_id   text,
  kind        text        not null,
  title       text        not null,
  summary     text,
  source      text        not null,
  source_ref  text,
  tags        text[]      not null default '{}',
  created_at  timestamptz not null default now(),

  constraint activity_target_type_values
    check (target_type in ('item', 'intention', 'group', 'execution', 'job_application', 'other')),
  constraint activity_kind_values check (kind in ('shipped', 'done', 'progress', 'used')),
  constraint activity_source_values check (source in ('trigger', 'claude', 'cli', 'nightly', 'manual')),
  constraint activity_title_length check (length(title) between 1 and 500)
);

comment on table public.activity is
  'OVERWATCH. The log of what got done, across every app. Inserted by the activity_from_* triggers (Alfred''s own '
  'closes), by log_activity (Claude and CLI reports) and by the nightly job; never edited. The UI may delete a wrong '
  'row. One row per (user_id, source, source_ref) when source_ref is set, so nothing is logged twice. '
  'Spec: docs/technical-spec-overwatch-q4n.md section 4.2.';
comment on column public.activity.id is 'Row id.';
comment on column public.activity.user_id is 'Owner. Copied from the row that fired the trigger, or auth.uid(). Owner RLS.';
comment on column public.activity.occurred_at is
  'When the work happened: the execution''s closed_at, or the record''s status_changed_at at close.';
comment on column public.activity.app_id is 'The app it belongs to: the context''s app_id, else alfred.';
comment on column public.activity.context_id is 'The context of the record, when there is one.';
comment on column public.activity.group_id is
  'The Project group it counts toward: the execution''s or intention''s own Project group, else a Project group the '
  'intention or item is a member of. Null when none.';
comment on column public.activity.target_type is
  'What the row is about: item, intention, group, execution, job_application or other.';
comment on column public.activity.target_id is 'The id of that record, or null.';
comment on column public.activity.kind is
  'shipped (a Project closed as done), done (a task or session finished), progress (a step of a longer piece of '
  'work), used (an app was used that day).';
comment on column public.activity.title is 'One line: the intention''s text, item''s name or group''s name, cut to 300 characters.';
comment on column public.activity.summary is 'Short text, or null. Triggers leave it null.';
comment on column public.activity.source is 'Who wrote it: trigger, claude, cli, nightly or manual.';
comment on column public.activity.source_ref is
  'The source record''s identity, so a second write is a no-op: execution:<id>, items:<id>:<epoch>, intents:<id>:<epoch>, '
  'item_groups:<id>:<epoch> for triggers; the run tag for cli; <app>:<date> for nightly.';
comment on column public.activity.tags is
  'A snapshot of the record''s tags when the row was written, so history shows how a thing was tagged then.';
comment on column public.activity.created_at is 'When the row was written.';

create unique index if not exists activity_source_ref_once
  on public.activity (user_id, source, source_ref) where source_ref is not null;
create index if not exists activity_user_occurred_idx on public.activity (user_id, occurred_at desc);
create index if not exists activity_group_idx on public.activity (group_id) where group_id is not null;
create index if not exists activity_tags_idx on public.activity using gin (tags);

-- ============================================================================
-- 3. Trigger: executions
-- ============================================================================
create or replace function public.activity_from_execution()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_was     boolean := coalesce(tg_op <> 'INSERT' and old.status = 'closed' and old.outcome = 'done', false);
  v_is      boolean := coalesce(tg_op <> 'DELETE' and new.status = 'closed' and new.outcome = 'done', false);
  v_intent  public.intents%rowtype;
  v_item    public.items%rowtype;
  v_item_id text;
  v_own     text;
  v_group   text;
  v_context text;
begin
  if v_was and not v_is then
    delete from public.activity
     where user_id = old.user_id and source = 'trigger' and source_ref = 'execution:' || old.id;
    return null;
  end if;
  if not v_is or v_was then
    return null;
  end if;

  select * into v_intent from public.intents where id = new.intent_id;
  v_own := v_intent.group_id;

  -- closeRecords logged this on the intention already.
  if v_intent.id is not null and v_intent.status = 'closed' and v_intent.closed_reason = 'done'
     and abs(extract(epoch from (v_intent.status_changed_at - new.closed_at))) < 600 then
    return null;
  end if;
  -- A Project's own intention: the group's shipped row covers it.
  if v_own is not null and exists (
       select 1 from public.item_groups g join public.group_types t on t.id = g.group_type_id
        where g.id = v_own and t.kind = 'project') then
    return null;
  end if;

  v_item_id := coalesce(v_intent.item_id,
                        case when jsonb_typeof(new.item_ids) = 'array' then new.item_ids ->> 0 end);
  if v_item_id is not null then
    select * into v_item from public.items where id = v_item_id;
  end if;

  select g.id into v_group
    from public.item_groups g join public.group_types t on t.id = g.group_type_id
   where t.kind = 'project'
     and (g.id = new.group_id
          or g.id in (select m.group_id from public.item_group_members m
                       where m.removed_at is null
                         and ((m.member_type = 'intention' and m.member_id = new.intent_id)
                              or (m.member_type = 'item' and m.member_id = v_item_id))))
   order by (g.id = new.group_id) desc nulls last
   limit 1;

  v_context := coalesce(new.context_id, v_intent.context_id, v_item.context_id);

  insert into public.activity
    (user_id, occurred_at, app_id, context_id, group_id, target_type, target_id, kind, title, source, source_ref, tags)
  values
    (new.user_id, coalesce(new.closed_at, now()),
     coalesce((select c.app_id from public.contexts c where c.id = v_context), 'alfred'),
     v_context, v_group, 'execution', new.id, 'done',
     left(coalesce(nullif(v_intent.text, ''), nullif(v_item.name, ''),
                   (select nullif(g.name, '') from public.item_groups g where g.id = new.group_id), 'Execution'), 300),
     'trigger', 'execution:' || new.id,
     coalesce(nullif(v_intent.tags, '{}'), v_item.tags, '{}'))
  on conflict (user_id, source, source_ref) where source_ref is not null do nothing;
  return null;
exception when others then
  raise warning 'activity_from_execution % failed: %', coalesce(new.id, old.id), sqlerrm;
  return null;
end;
$$;

comment on function public.activity_from_execution() is
  'Overwatch: an execution closed with outcome done writes one done activity row; leaving that state (Undo deletes the '
  'execution) removes it. Skips what an intention close or a Project''s shipped row already logged. Never blocks.';
revoke all on function public.activity_from_execution() from public, anon;

drop trigger if exists activity_from_execution on public.executions;
create trigger activity_from_execution
  after insert or update or delete on public.executions
  for each row execute function public.activity_from_execution();

-- ============================================================================
-- 4. Trigger: items and intents
-- ============================================================================
create or replace function public.activity_from_record_close()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_was     boolean := coalesce(old.status = 'closed' and old.closed_reason = 'done', false);
  v_is      boolean := coalesce(new.status = 'closed' and new.closed_reason = 'done', false);
  v_moved   boolean := old.status_changed_at is distinct from new.status_changed_at;
  v_row     jsonb := to_jsonb(new);
  v_is_int  boolean := tg_table_name = 'intents';
  v_own     text;
  v_group   text;
  v_context text := v_row ->> 'context_id';
begin
  if v_was and (not v_is or v_moved) then
    delete from public.activity
     where user_id = old.user_id and source = 'trigger'
       and source_ref = tg_table_name || ':' || old.id || ':' || extract(epoch from old.status_changed_at);
  end if;
  if not v_is or (v_was and not v_moved) then
    return null;
  end if;

  if v_is_int then
    v_own := v_row ->> 'group_id';
    -- A Project's own intention: the group's shipped row covers it.
    if v_own is not null and exists (
         select 1 from public.item_groups g join public.group_types t on t.id = g.group_type_id
          where g.id = v_own and t.kind = 'project') then
      return null;
    end if;
    -- closeExecution logged this on the execution already.
    if exists (select 1 from public.executions e
                where e.intent_id = new.id and e.status = 'closed' and e.outcome = 'done'
                  and abs(extract(epoch from (e.closed_at - new.status_changed_at))) < 600) then
      return null;
    end if;
  else
    -- Closed with its intention, or finished by an execution: that row covers it.
    if exists (select 1 from public.intents i
                where i.item_id = new.id and i.status = 'closed' and i.closed_reason = 'done'
                  and abs(extract(epoch from (i.status_changed_at - new.status_changed_at))) < 600)
       or exists (select 1 from public.executions e
                   where e.status = 'closed' and e.outcome = 'done'
                     and abs(extract(epoch from (e.closed_at - new.status_changed_at))) < 600
                     and ((jsonb_typeof(e.item_ids) = 'array' and e.item_ids ? new.id)
                          or e.intent_id in (select i.id from public.intents i where i.item_id = new.id))) then
      return null;
    end if;
  end if;

  select g.id into v_group
    from public.item_groups g join public.group_types t on t.id = g.group_type_id
   where t.kind = 'project'
     and g.id in (select m.group_id from public.item_group_members m
                   where m.removed_at is null
                     and m.member_type = case when v_is_int then 'intention' else 'item' end
                     and m.member_id = new.id)
   limit 1;

  insert into public.activity
    (user_id, occurred_at, app_id, context_id, group_id, target_type, target_id, kind, title, source, source_ref, tags)
  values
    (new.user_id, new.status_changed_at,
     coalesce((select c.app_id from public.contexts c where c.id = v_context), 'alfred'),
     v_context, v_group, case when v_is_int then 'intention' else 'item' end, new.id, 'done',
     left(coalesce(nullif(v_row ->> 'text', ''), nullif(v_row ->> 'name', ''), 'Untitled'), 300),
     'trigger', tg_table_name || ':' || new.id || ':' || extract(epoch from new.status_changed_at),
     coalesce(array(select jsonb_array_elements_text(coalesce(v_row -> 'tags', '[]'::jsonb))), '{}'))
  on conflict (user_id, source, source_ref) where source_ref is not null do nothing;
  return null;
exception when others then
  raise warning 'activity_from_record_close %.% failed: %', tg_table_name, new.id, sqlerrm;
  return null;
end;
$$;

comment on function public.activity_from_record_close() is
  'Overwatch: an item or intention closed with closed_reason done writes one done activity row, unless an execution or '
  'its intention already logged the close or it is a Project''s own intention; reopening removes it. Never blocks.';
revoke all on function public.activity_from_record_close() from public, anon;

drop trigger if exists activity_from_record_close on public.items;
create trigger activity_from_record_close
  after update of status, closed_reason, status_changed_at on public.items
  for each row
  when (old.status is distinct from new.status
        or old.closed_reason is distinct from new.closed_reason
        or old.status_changed_at is distinct from new.status_changed_at)
  execute function public.activity_from_record_close();

drop trigger if exists activity_from_record_close on public.intents;
create trigger activity_from_record_close
  after update of status, closed_reason, status_changed_at on public.intents
  for each row
  when (old.status is distinct from new.status
        or old.closed_reason is distinct from new.closed_reason
        or old.status_changed_at is distinct from new.status_changed_at)
  execute function public.activity_from_record_close();

-- ============================================================================
-- 5. Trigger: Project groups
-- ============================================================================
create or replace function public.activity_from_group_close()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_was   boolean := coalesce(old.status = 'closed' and old.closed_reason = 'done', false);
  v_is    boolean := coalesce(new.status = 'closed' and new.closed_reason = 'done', false);
  v_moved boolean := old.status_changed_at is distinct from new.status_changed_at;
begin
  if not exists (select 1 from public.group_types t where t.id = new.group_type_id and t.kind = 'project') then
    return null;
  end if;
  if v_was and (not v_is or v_moved) then
    delete from public.activity
     where user_id = old.user_id and source = 'trigger'
       and source_ref = 'item_groups:' || old.id || ':' || extract(epoch from old.status_changed_at);
  end if;
  if not v_is or (v_was and not v_moved) then
    return null;
  end if;

  insert into public.activity
    (user_id, occurred_at, app_id, context_id, group_id, target_type, target_id, kind, title, source, source_ref, tags)
  values
    (new.user_id, new.status_changed_at,
     coalesce((select c.app_id from public.contexts c where c.id = new.context_id), 'alfred'),
     new.context_id, new.id, 'group', new.id, 'shipped',
     left(coalesce(nullif(new.name, ''), 'Unnamed project'), 300),
     'trigger', 'item_groups:' || new.id || ':' || extract(epoch from new.status_changed_at), '{}')
  on conflict (user_id, source, source_ref) where source_ref is not null do nothing;
  return null;
exception when others then
  raise warning 'activity_from_group_close % failed: %', new.id, sqlerrm;
  return null;
end;
$$;

comment on function public.activity_from_group_close() is
  'Overwatch: a Project group (group_types.kind = project) closed with closed_reason done writes one shipped activity '
  'row; reopening removes it. Never blocks.';
revoke all on function public.activity_from_group_close() from public, anon;

drop trigger if exists activity_from_group_close on public.item_groups;
create trigger activity_from_group_close
  after update of status, closed_reason, status_changed_at on public.item_groups
  for each row
  when (old.status is distinct from new.status
        or old.closed_reason is distinct from new.closed_reason
        or old.status_changed_at is distinct from new.status_changed_at)
  execute function public.activity_from_group_close();

-- ============================================================================
-- 6. Register activity: owner RLS, explicit grants (no anon), audited
-- ============================================================================
select platform.register_table(
  'public.activity',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Overwatch. The log of what got done. Written by the activity_from_* triggers, log_activity and the nightly job; never edited by tools.'
);

commit;

-- ============================================================================
-- 7. Result: kinds backfilled, the new triggers, registration, and conformance (must say CONFORMANT)
-- ============================================================================
select json_build_object(
  'group_type_kinds', (select coalesce(json_agg(t), '[]'::json) from (
      select label_singular, kind, count(*) as types from public.group_types group by 1, 2 order by 1
    ) t),
  'new_triggers', (select coalesce(json_agg(t), '[]'::json) from (
      select tgrelid::regclass::text as table_name, tgname
        from pg_trigger where not tgisinternal and tgname like 'activity_from_%' order by 1, 2
    ) t),
  'activity_rows', (select count(*) from public.activity),
  'registry', (select coalesce(json_agg(t), '[]'::json) from (
      select table_name, policy_mode, audited, mcp_read from platform.registry where table_name = 'public.activity'
    ) t),
  'conformance', public.platform_check_conformance()
) as result;
