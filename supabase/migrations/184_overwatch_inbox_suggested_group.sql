-- Purpose: Overwatch Step 57 (Phase 8c). A suggested group on inbox items: inbox.suggested_group_id names the group a
-- capture belongs in (any group type: a Project, a Menu, a Series or another; set by enrichment through
-- create_inbox_item and update_inbox_item, Step 58), and process_inbox_item gains a `group` payload key
-- ({ group_id }) that adds the filed intention (or, with none, the item) to that group in the same transaction, so
-- filing and joining the group succeed or fail together. inbox_check_suggested_group refuses a suggestion that is
-- not one of the same user's open groups (not closed, not archived).
-- Kind: schema change (one column, one trigger function; process_inbox_item replaced)
-- Applied: NO — not yet run.
--
-- Spec: docs/technical-spec-overwatch-q4n.md 4.1 and 4.17. Run as one block in the SQL editor, then
-- supabase/tests/overwatch-q4n/28_inbox_suggested_group_test.sql and 29_verify_inbox_suggested_group.sql.
-- Safe to re-run: the column, function, trigger and the replaced RPC are idempotent.
-- supabase/migrations/184_overwatch_inbox_suggested_group.sql

begin;

-- ============================================================================
-- 1. inbox.suggested_group_id
-- ============================================================================
alter table public.inbox
  add column if not exists suggested_group_id text references public.item_groups (id) on delete set null;

comment on column public.inbox.suggested_group_id is
  'Overwatch 8c. The group this capture belongs in, as enrichment suggested it: any group type (Project, Menu, '
  'Series, …), the same user''s, not closed and not archived when set (inbox_check_suggested_group). Filing with the '
  'group key in process_inbox_item adds the filed record to it. Null when no group fits. Kept after filing, as a '
  'record of the suggestion.';

create or replace function public.inbox_check_suggested_group()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.suggested_group_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.suggested_group_id is not distinct from old.suggested_group_id then return new; end if;
  if not exists (
    select 1 from public.item_groups g
     where g.id = new.suggested_group_id and g.user_id = new.user_id and g.status <> 'closed' and not g.archived
  ) then
    raise exception 'inbox refused: suggested group % is not one of your open groups (not closed, not archived).',
      new.suggested_group_id using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.inbox_check_suggested_group() is
  'Overwatch 8c: a suggested_group_id, when it is set or changed, must be one of the same user''s groups of any type '
  'that is not closed and not archived. A group that later closes keeps the suggestion; filing then refuses it.';
revoke all on function public.inbox_check_suggested_group() from public, anon;

drop trigger if exists inbox_check_suggested_group on public.inbox;
create trigger inbox_check_suggested_group
  before insert or update of suggested_group_id on public.inbox
  for each row execute function public.inbox_check_suggested_group();

-- ============================================================================
-- 2. process_inbox_item: the group key (everything else as before)
-- ============================================================================
create or replace function public.process_inbox_item(p_inbox_id text, p_payload jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_user       uuid := auth.uid();
  v_inbox      public.inbox%rowtype;
  v_item       public.items%rowtype;
  v_intent     public.intents%rowtype;
  v_event      public.events%rowtype;
  v_member     public.collection_items%rowtype;
  v_group_row  public.item_group_members%rowtype;
  v_p          jsonb;
  v_item_id    text;
  v_member_item text;
  v_group_id   text;
  v_created    jsonb := '[]'::jsonb;
  v_moved      int := 0;
  v_source_app text;
begin
  if v_user is null then
    raise exception 'process_inbox_item: not signed in' using errcode = '42501';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'process_inbox_item: payload must be an object' using errcode = '22023';
  end if;

  select * into v_inbox from public.inbox
   where id = p_inbox_id and user_id = v_user
   for update;
  if not found then
    raise exception 'process_inbox_item: no inbox item % that you can write to. Nothing was changed.', p_inbox_id
      using errcode = 'P0002';
  end if;
  -- Also stops a double tap from filing the capture twice.
  if v_inbox.archived is true then
    raise exception 'process_inbox_item: inbox item % is already archived. Put it back first. Nothing was changed.', p_inbox_id
      using errcode = '55000';
  end if;

  if p_payload ? 'source_app' then
    v_source_app := nullif(btrim(p_payload ->> 'source_app'), '');
    if v_source_app is not null and not exists (select 1 from public.apps where id = v_source_app) then
      raise exception 'process_inbox_item: no app %. Nothing was changed.', v_source_app using errcode = '22023';
    end if;
  else
    v_source_app := v_inbox.source_app;
  end if;

  -- The group is checked before anything is written.
  v_p := nullif(p_payload -> 'group', 'null'::jsonb);
  if v_p is not null then
    v_group_id := nullif(btrim(v_p ->> 'group_id'), '');
    if v_group_id is null then
      raise exception 'process_inbox_item: group.group_id is required' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.item_groups g
       where g.id = v_group_id and g.user_id = v_user and g.status <> 'closed' and not g.archived
    ) then
      raise exception 'process_inbox_item: group % is not one of your open groups (not closed, not archived). Nothing was changed.',
        v_group_id using errcode = '22023';
    end if;
  end if;

  -- Item
  v_p := nullif(p_payload -> 'item', 'null'::jsonb);
  if v_p is not null then
    if nullif(btrim(v_p ->> 'name'), '') is null then
      raise exception 'process_inbox_item: item.name is required' using errcode = '22023';
    end if;
    insert into public.items (id, user_id, name, description, context_id, elements, tags,
                              is_capture_target, status, source_inbox_id)
    values (coalesce(nullif(btrim(v_p ->> 'id'), ''), gen_random_uuid()::text),
            v_user,
            v_p ->> 'name',
            coalesce(v_p ->> 'description', ''),
            nullif(v_p ->> 'context_id', ''),
            coalesce(nullif(v_p -> 'elements', 'null'::jsonb), '[]'::jsonb),
            array(select jsonb_array_elements_text(coalesce(nullif(v_p -> 'tags', 'null'::jsonb), '[]'::jsonb))),
            false,
            case when v_p ->> 'status' = 'active' then 'active' else 'someday' end,
            p_inbox_id)
    returning * into v_item;
    v_item_id := v_item.id;
    v_created := v_created || jsonb_build_object('table', 'items', 'id', v_item.id);
  end if;

  -- Intention, then the capture's reminders, then its event
  v_p := nullif(p_payload -> 'intent', 'null'::jsonb);
  if v_p is not null then
    if nullif(btrim(v_p ->> 'text'), '') is null then
      raise exception 'process_inbox_item: intent.text is required' using errcode = '22023';
    end if;
    insert into public.intents (id, user_id, text, description, is_intention, archived, item_id,
                                context_id, recurrence_config, target_start_date, end_date, tags,
                                status, source_inbox_id)
    values (coalesce(nullif(btrim(v_p ->> 'id'), ''), gen_random_uuid()::text),
            v_user,
            v_p ->> 'text',
            nullif(btrim(v_p ->> 'description'), ''),
            true,
            false,
            coalesce(nullif(v_p ->> 'item_id', ''), v_item_id),
            nullif(v_p ->> 'context_id', ''),
            nullif(v_p -> 'recurrence_config', 'null'::jsonb),
            nullif(v_p ->> 'target_start_date', '')::date,
            nullif(v_p ->> 'end_date', '')::date,
            array(select jsonb_array_elements_text(coalesce(nullif(v_p -> 'tags', 'null'::jsonb), '[]'::jsonb))),
            case when v_p ->> 'status' = 'active' then 'active' else 'someday' end,
            p_inbox_id)
    returning * into v_intent;
    v_created := v_created || jsonb_build_object('table', 'intents', 'id', v_intent.id);

    update public.reminders
       set intent_id = v_intent.id, inbox_id = null
     where inbox_id = p_inbox_id;
    get diagnostics v_moved = row_count;
  end if;

  v_p := nullif(p_payload -> 'event', 'null'::jsonb);
  if v_p is not null then
    if v_intent.id is null then
      raise exception 'process_inbox_item: an event needs an intent' using errcode = '22023';
    end if;
    if nullif(v_p ->> 'time', '') is null then
      raise exception 'process_inbox_item: event.time is required' using errcode = '22023';
    end if;
    -- events_status_activate (088) makes the intention and its item active.
    insert into public.events (id, user_id, intent_id, context_id, time, item_ids, archived, text,
                               source_inbox_id)
    values (coalesce(nullif(btrim(v_p ->> 'id'), ''), gen_random_uuid()::text),
            v_user,
            v_intent.id,
            coalesce(nullif(v_p ->> 'context_id', ''), v_intent.context_id),
            (v_p ->> 'time')::date,
            case when v_intent.item_id is null then '[]'::jsonb else jsonb_build_array(v_intent.item_id) end,
            false,
            coalesce(v_p ->> 'text', v_intent.text),
            p_inbox_id)
    returning * into v_event;
    v_created := v_created || jsonb_build_object('table', 'events', 'id', v_event.id);
  end if;

  -- Collection member. Already a member is not an error, as in addMembers.
  v_p := nullif(p_payload -> 'collection', 'null'::jsonb);
  if v_p is not null then
    v_member_item := coalesce(nullif(v_p ->> 'item_id', ''), v_item_id);
    if nullif(v_p ->> 'collection_id', '') is not null and v_member_item is not null then
      insert into public.collection_items (collection_id, item_id, quantity, position, added_by)
      values (v_p ->> 'collection_id',
              v_member_item,
              nullif(btrim(v_p ->> 'quantity'), ''),
              coalesce((select max(position) + 1 from public.collection_items
                         where collection_id = v_p ->> 'collection_id'), 0),
              v_user)
      on conflict (collection_id, item_id) do nothing
      returning * into v_member;
    end if;
  end if;

  -- Group member: the intention when one was filed, else the item, at the end of the live members
  -- (restoreMember's rule). Already a live member is not an error.
  if v_group_id is not null then
    if v_intent.id is null and v_item.id is null then
      raise exception 'process_inbox_item: a group needs an item or an intent to add. Nothing was changed.'
        using errcode = '22023';
    end if;
    insert into public.item_group_members (group_id, member_type, member_id, position)
    values (v_group_id,
            case when v_intent.id is not null then 'intention' else 'item' end,
            coalesce(v_intent.id, v_item.id),
            coalesce((select max(position) from public.item_group_members
                       where group_id = v_group_id and removed_at is null), 0) + 1)
    on conflict (group_id, member_type, member_id) where removed_at is null do nothing
    returning * into v_group_row;
  end if;

  -- Archive last: the capture is filed only if everything above was written.
  update public.inbox
     set archived = true,
         triaged_at = now(),
         archive_reason = 'processed',
         source_app = v_source_app,
         outcome = coalesce(outcome, '[]'::jsonb) || v_created
   where id = p_inbox_id
  returning * into v_inbox;

  return jsonb_build_object(
    'inbox', to_jsonb(v_inbox),
    'item', case when v_item.id is null then null else to_jsonb(v_item) end,
    'intent', case when v_intent.id is null then null else to_jsonb(v_intent) end,
    'event', case when v_event.id is null then null else to_jsonb(v_event) end,
    'collection_item', case when v_member.id is null then null else to_jsonb(v_member) end,
    'group_member', case when v_group_row.id is null then null else to_jsonb(v_group_row) end,
    'reminders_moved', v_moved,
    'outcome', v_created);
end;
$$;

comment on function public.process_inbox_item(text, jsonb) is
  'Alfred: process an inbox capture in one transaction: create its item, intention (taking the capture''s reminders) '
  'and event, add a collection member, add the intention (else the item) to a group (the group key, Overwatch 8c: any '
  'of the caller''s groups that is not closed or archived), then archive the capture as processed with outcome '
  'appended and source_app. Any failure writes nothing. Only the capture''s owner can process it. Does not use '
  'intents.is_item. Security invoker. Returns the rows written.';
revoke all on function public.process_inbox_item(text, jsonb) from public, anon;
grant execute on function public.process_inbox_item(text, jsonb) to authenticated, service_role;

commit;

-- ============================================================================
-- 3. Result: the column, the trigger, the function's grants, conformance (must say CONFORMANT)
-- ============================================================================
select json_build_object(
  'column', (select coalesce(json_agg(t), '[]'::json) from (
      select column_name, data_type, is_nullable,
             col_description('public.inbox'::regclass, ordinal_position::int) is not null as has_comment
        from information_schema.columns
       where table_schema = 'public' and table_name = 'inbox' and column_name = 'suggested_group_id'
    ) t),
  'trigger', (select coalesce(json_agg(t), '[]'::json) from (
      select tgname as trigger_name, tgfoid::regproc::text as function_name
        from pg_trigger where tgrelid = 'public.inbox'::regclass and tgname = 'inbox_check_suggested_group'
    ) t),
  'function_execute', (select coalesce(json_agg(t), '[]'::json) from (
      select r as role, has_function_privilege(r, 'public.process_inbox_item(text, jsonb)', 'execute') as can_execute
        from unnest(array['anon', 'authenticated', 'service_role']) r
    ) t),
  'conformance', public.platform_check_conformance()
) as result;
