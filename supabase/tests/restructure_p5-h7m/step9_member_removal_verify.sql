-- Restructure P5 Step 9 follow-up: verify migration 149 (group member removal). Read-only;
-- run whole, paste back the one result cell.
-- Expect: conformant true, failures []; removed_at and removed_by present; the live-only
-- unique index and the removed index, and the old unique constraint gone; the stamp trigger;
-- all five functions mention removed_at; members of P5 Test Menu listed.
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (
    select * from platform.conformance_failures) t),
  'columns', (select coalesce(json_agg(t), '[]'::json) from (
    select column_name, data_type, is_nullable
      from information_schema.columns
     where table_schema = 'public' and table_name = 'item_group_members'
       and column_name in ('removed_at', 'removed_by')
     order by column_name) t),
  'indexes', (select coalesce(json_agg(t), '[]'::json) from (
    select indexname, indexdef from pg_indexes
     where schemaname = 'public' and tablename = 'item_group_members'
     order by indexname) t),
  'old_unique_constraint_gone', (select not exists (
    select 1 from pg_constraint where conname = 'item_group_members_group_id_member_type_member_id_key')),
  'triggers', (select coalesce(json_agg(t), '[]'::json) from (
    select tg.tgname as trigger_name, p.proname as function_name
      from pg_trigger tg
      join pg_class c on c.oid = tg.tgrelid
      join pg_proc p on p.oid = tg.tgfoid
     where c.relname = 'item_group_members' and not tg.tgisinternal
     order by tg.tgname) t),
  'functions_skip_removed', (select coalesce(json_agg(t), '[]'::json) from (
    select proname, prosrc like '%removed_at%' as skips_removed
      from pg_proc
     where pronamespace = 'public'::regnamespace
       and proname in ('recalc_last_completed_group', 'executions_last_completed', 'item_group_members_last_completed',
                       'status_activate_on_execution', 'events_group_freeze', 'item_group_members_stamp_removal')
     order by proname) t),
  'p5_test_menu_members', (select coalesce(json_agg(t), '[]'::json) from (
    select member_type, member_id, position, removed_at, removed_by
      from public.item_group_members
     where group_id = 'mvk4eyegzxjbl0c7fkg'
     order by removed_at nulls first, position) t)
) as result;
