-- Purpose: Inbox atomic (inbox_atomic-q7d). Processing a capture becomes one call and one transaction. process_inbox_item does every write the app's Process button makes (item, intention, reminders move, event, collection member, archiving the capture with outcome and source_app); archive_inbox_item does the MCP tool's archive plus link-back. A failure anywhere writes nothing.
-- Kind: schema change (two new functions)
-- Applied: YES — 2026-10-20 by Alex, whole file, no errors.
--
-- No new tables, so no platform.register_table call. Run as one block in the SQL editor,
-- then supabase/tests/inbox_atomic/ (1_verify.sql, 2_failure_test.sql), then
-- check_platform_conformance. Safe to re-run.
-- Neither function names intents.is_item, so both work before and after it is dropped.
--
-- Security invoker, both: every write goes through the same RLS policies as the app's
-- direct writes today. inbox_access is owner-only (no sharing), and each function also
-- locks the capture with user_id = auth.uid(), so nobody can process another user's
-- capture. Items, intentions and events in shared contexts behave as they do now.
-- supabase/migrations/145_inbox_atomic_process_inbox_item.sql

begin;

-- ============================================================================
-- 1. process_inbox_item — the app's Process button
-- ============================================================================
-- p_payload (snake_case; every section optional, ids optional — generated when missing):
--   "item":       {id, name, description, context_id, elements, tags, status}
--   "intent":     {id, text, description, item_id, context_id, recurrence_config,
--                  target_start_date, end_date, tags, status}
--                 item_id defaults to the item created above.
--   "event":      {id, time, context_id, text}  — needs "intent"; item_ids come from the intention.
--   "collection": {collection_id, item_id, quantity} — item_id defaults to the item created above.
--   "source_app": app id, or null to clear. Left out, the capture keeps its app.
-- The capture's reminders move to the new intention when there is one.
-- Returns {inbox, item, intent, event, collection_item, reminders_moved, outcome}: the rows written.
create or replace function public.process_inbox_item(p_inbox_id text, p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user       uuid := auth.uid();
  v_inbox      public.inbox%rowtype;
  v_item       public.items%rowtype;
  v_intent     public.intents%rowtype;
  v_event      public.events%rowtype;
  v_member     public.collection_items%rowtype;
  v_p          jsonb;
  v_item_id    text;
  v_member_item text;
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
    'reminders_moved', v_moved,
    'outcome', v_created);
end;
$$;

comment on function public.process_inbox_item(text, jsonb) is
  'Alfred: process an inbox capture in one transaction: create its item, intention (taking the capture''s reminders) and event, add a collection member, then archive the capture as processed with outcome appended and source_app. Any failure writes nothing. Only the capture''s owner can process it. Does not use intents.is_item. Security invoker. Returns the rows written.';

revoke all on function public.process_inbox_item(text, jsonb) from public, anon;
grant execute on function public.process_inbox_item(text, jsonb) to authenticated;

-- ============================================================================
-- 2. archive_inbox_item — the MCP tool's archive plus link-back
-- ============================================================================
-- p_args, the tool's own parameters: {archived (default true), reason ('processed' default |
-- 'discarded'), outcome [{table, id}] (archiving only), source_app (key present = set; null clears)}.
-- The tool checks source_app against apps before calling; this checks again.
-- Link-back stamps source_inbox_id on the caller's own items, intents, events and
-- job_applications listed in outcome that have none yet.
-- Returns the capture's columns plus linked_back ["table:id", ...].
create or replace function public.archive_inbox_item(p_inbox_id text, p_args jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user       uuid := auth.uid();
  v_args       jsonb := coalesce(p_args, '{}'::jsonb);
  v_archived   boolean := true;
  v_reason     text := 'processed';
  v_outcome    jsonb;
  v_inbox      public.inbox%rowtype;
  v_merged     jsonb;
  v_source_app text;
  v_e          jsonb;
  v_hit        int;
  v_linked     text[] := '{}';
begin
  if v_user is null then
    raise exception 'archive_inbox_item: not signed in' using errcode = '42501';
  end if;

  if nullif(v_args -> 'archived', 'null'::jsonb) is not null then
    if jsonb_typeof(v_args -> 'archived') <> 'boolean' then
      raise exception 'archive_inbox_item: archived must be true or false (got %).', v_args -> 'archived'
        using errcode = '22023';
    end if;
    v_archived := (v_args ->> 'archived')::boolean;
  end if;

  if nullif(v_args -> 'reason', 'null'::jsonb) is not null then
    v_reason := v_args ->> 'reason';
    if v_reason not in ('processed', 'discarded') then
      raise exception 'archive_inbox_item: reason must be "processed" or "discarded". Got %.', v_args -> 'reason'
        using errcode = '22023';
    end if;
  end if;

  v_outcome := nullif(v_args -> 'outcome', 'null'::jsonb);
  if v_outcome is not null and not public.inbox_outcome_valid(v_outcome) then
    raise exception 'archive_inbox_item: outcome must be a list of { table, id }. Got %.', v_outcome
      using errcode = '22023';
  end if;
  if v_outcome is not null and not v_archived then
    raise exception 'archive_inbox_item: outcome is recorded when archiving; it cannot go with archived: false.'
      using errcode = '22023';
  end if;

  select * into v_inbox from public.inbox
   where id = p_inbox_id and user_id = v_user
   for update;
  if not found then
    raise exception 'archive_inbox_item: no inbox item % that you can write to — it may not be yours. Nothing was changed.', p_inbox_id
      using errcode = 'P0002';
  end if;

  if v_args ? 'source_app' then
    v_source_app := nullif(btrim(v_args ->> 'source_app'), '');
    if v_source_app is not null and not exists (select 1 from public.apps where id = v_source_app) then
      raise exception 'archive_inbox_item: no app %. Nothing was changed.', v_source_app using errcode = '22023';
    end if;
  else
    v_source_app := v_inbox.source_app;
  end if;

  -- Appended, so an outcome the app already recorded is kept; repeats are skipped.
  v_merged := coalesce(v_inbox.outcome, '[]'::jsonb);
  if v_outcome is not null then
    v_merged := v_merged || coalesce((
      select jsonb_agg(jsonb_build_object('table', btrim(e ->> 'table'), 'id', btrim(e ->> 'id')) order by ord)
        from jsonb_array_elements(v_outcome) with ordinality as x(e, ord)
       where not exists (
         select 1 from jsonb_array_elements(v_inbox.outcome) o
          where o ->> 'table' = btrim(e ->> 'table') and o ->> 'id' = btrim(e ->> 'id'))), '[]'::jsonb);
  end if;

  update public.inbox
     set archived = v_archived,
         triaged_at = case when v_archived then now() else null end,
         archive_reason = case when v_archived then v_reason else null end,
         outcome = v_merged,
         source_app = v_source_app
   where id = p_inbox_id
  returning * into v_inbox;

  for v_e in select jsonb_build_object('table', btrim(e ->> 'table'), 'id', btrim(e ->> 'id'))
               from jsonb_array_elements(coalesce(v_outcome, '[]'::jsonb)) e
  loop
    v_hit := 0;
    case v_e ->> 'table'
      when 'items' then
        update public.items set source_inbox_id = p_inbox_id
         where id = v_e ->> 'id' and user_id = v_user and source_inbox_id is null;
        get diagnostics v_hit = row_count;
      when 'intents' then
        update public.intents set source_inbox_id = p_inbox_id
         where id = v_e ->> 'id' and user_id = v_user and source_inbox_id is null;
        get diagnostics v_hit = row_count;
      when 'events' then
        update public.events set source_inbox_id = p_inbox_id
         where id = v_e ->> 'id' and user_id = v_user and source_inbox_id is null;
        get diagnostics v_hit = row_count;
      when 'job_applications' then
        if v_e ->> 'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          raise exception 'archive_inbox_item: job_applications id % is not a uuid. Nothing was changed.', v_e ->> 'id'
            using errcode = '22023';
        end if;
        update public.job_applications set source_inbox_id = p_inbox_id
         where id = (v_e ->> 'id')::uuid and user_id = v_user and source_inbox_id is null;
        get diagnostics v_hit = row_count;
      else
        null; -- a table with no source_inbox_id: recorded in outcome only
    end case;
    if v_hit > 0 then
      v_linked := v_linked || ((v_e ->> 'table') || ':' || (v_e ->> 'id'));
    end if;
  end loop;

  return jsonb_build_object(
    'id', v_inbox.id,
    'source_type', v_inbox.source_type,
    'captured_text', v_inbox.captured_text,
    'archived', v_inbox.archived,
    'triaged_at', v_inbox.triaged_at,
    'archive_reason', v_inbox.archive_reason,
    'source_app', v_inbox.source_app,
    'outcome', v_inbox.outcome,
    'linked_back', to_jsonb(v_linked));
end;
$$;

comment on function public.archive_inbox_item(text, jsonb) is
  'Alfred: archive or un-archive an inbox capture in one transaction, for the archive_inbox_item MCP tool. Archiving stamps triaged_at and archive_reason (processed | discarded), appends outcome (skipping repeats) and sets source_app; then links back each of the caller''s own items, intents, events and job_applications in outcome that has no source_inbox_id. Any failure writes nothing. Only the capture''s owner can archive it. Security invoker. Returns the capture plus linked_back.';

revoke all on function public.archive_inbox_item(text, jsonb) from public, anon;
grant execute on function public.archive_inbox_item(text, jsonb) to authenticated;

commit;
