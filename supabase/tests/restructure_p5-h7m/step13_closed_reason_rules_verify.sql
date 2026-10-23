-- Restructure P5 Step 13 follow-up: verify migration 153 (closed_reason rules). Read-only;
-- run whole, paste back the one result cell.
-- Expect: conformant true, failures []; three validated constraints; status_guard clears the
-- reason and keeps the Undo exception; three status_guard triggers enabled; no breaches;
-- P5 Test Project and its intention with no reason unless closed.
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (
    select * from platform.conformance_failures) t),
  'constraints', (select coalesce(json_agg(t), '[]'::json) from (
    select conrelid::regclass::text as table_name, conname, convalidated, pg_get_constraintdef(oid) as def
      from pg_constraint
     where conname in ('items_closed_reason_only_closed', 'intents_closed_reason_only_closed', 'item_groups_closed_reason_only_closed')
     order by conname) t),
  'status_guard_clears_reason', (select prosrc like '%new.closed_reason := null%' from pg_proc
     where proname = 'status_guard' and pronamespace = 'public'::regnamespace),
  'status_guard_keeps_undo_exception', (select prosrc like '%interval ''10 minutes''%' from pg_proc
     where proname = 'status_guard' and pronamespace = 'public'::regnamespace),
  'status_guard_triggers', (select coalesce(json_agg(t), '[]'::json) from (
    select c.relname as table_name, tg.tgname, tg.tgenabled
      from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
     where tg.tgfoid = 'public.status_guard'::regproc
     order by c.relname) t),
  'breaches', (select coalesce(json_agg(t), '[]'::json) from (
    select 'items' as tbl, id, status, closed_reason from public.items where status <> 'closed' and closed_reason is not null
    union all
    select 'intents', id, status, closed_reason from public.intents where status <> 'closed' and closed_reason is not null
    union all
    select 'item_groups', id, status, closed_reason from public.item_groups where status <> 'closed' and closed_reason is not null) t),
  'p5_test_project', (select coalesce(json_agg(t), '[]'::json) from (
    select 'group' as kind, id, status, closed_reason, status_changed_at from public.item_groups where id = 'mvk4r9sm8pyfz1ubpkw'
    union all
    select 'own intention', id, status, closed_reason, status_changed_at from public.intents
     where group_id = 'mvk4r9sm8pyfz1ubpkw' and archived is not true) t)
) as result;
