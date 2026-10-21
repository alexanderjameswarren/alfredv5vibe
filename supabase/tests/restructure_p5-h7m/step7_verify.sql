-- Restructure P5 Step 7: verify migration 148 (groups). Read-only; run whole, paste back the one result cell.
-- Expect: conformant true, failures []; three group types and three context defaults; every
-- listed column present with executions.intent_id and event_id nullable; all indexes, including
-- the two existing one-live / one-open indexes; every trigger; notes check with 'group';
-- policies on the three new tables; three tables in realtime; all seven functions handle groups.
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (
    select * from platform.conformance_failures) t),
  'group_types_seeded', (select coalesce(json_agg(t), '[]'::json) from (
    select c.name as context, g.label_singular, g.label_plural, g.icon, g.execution_mode
      from public.group_types g join public.contexts c on c.id = g.context_id
     order by c.name) t),
  'context_defaults', (select coalesce(json_agg(t), '[]'::json) from (
    select c.name as context, g.label_singular as default_type
      from public.contexts c join public.group_types g on g.id = c.default_group_type_id
     order by c.name) t),
  'new_columns', (select coalesce(json_agg(t), '[]'::json) from (
    select table_name, column_name, data_type, is_nullable, column_default
      from information_schema.columns
     where table_schema = 'public'
       and ((table_name in ('group_types', 'item_groups', 'item_group_members'))
            or (table_name = 'contexts' and column_name = 'default_group_type_id')
            or (table_name in ('intents', 'events') and column_name = 'group_id')
            or (table_name = 'executions' and column_name in ('group_id', 'intent_id', 'event_id')))
     order by table_name, ordinal_position) t),
  'indexes', (select coalesce(json_agg(t), '[]'::json) from (
    select tablename, indexname, indexdef
      from pg_indexes
     where schemaname = 'public'
       and indexname in ('intents_one_per_group', 'idx_events_group', 'idx_executions_group',
                         'idx_item_groups_context', 'idx_item_group_members_member',
                         'item_group_members_group_id_member_type_member_id_key',
                         'events_one_live_per_intent', 'executions_one_open_per_intent')
     order by indexname) t),
  'triggers', (select coalesce(json_agg(t), '[]'::json) from (
    select c.relname as table_name, tg.tgname as trigger_name, p.proname as function_name
      from pg_trigger tg
      join pg_class c on c.oid = tg.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_proc p on p.oid = tg.tgfoid
     where n.nspname = 'public' and not tg.tgisinternal
       and (c.relname in ('group_types', 'item_groups', 'item_group_members')
            or tg.tgname in ('events_group_freeze', 'executions_group_tag', 'events_status_activate',
                             'executions_status_activate', 'executions_last_completed'))
     order by c.relname, tg.tgname) t),
  'checks', (select coalesce(json_agg(t), '[]'::json) from (
    select conrelid::regclass::text as table_name, conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
     where conname in ('notes_target_type_check', 'executions_has_subject')
     order by conname) t),
  'policies', (select coalesce(json_agg(t), '[]'::json) from (
    select tablename, policyname, cmd
      from pg_policies
     where schemaname = 'public' and tablename in ('group_types', 'item_groups', 'item_group_members', 'notes')
     order by tablename, policyname) t),
  'realtime', (select coalesce(json_agg(t), '[]'::json) from (
    select tablename from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public'
       and tablename in ('group_types', 'item_groups', 'item_group_members')
     order by tablename) t),
  'functions_with_groups', (select coalesce(json_agg(t), '[]'::json) from (
    select proname, prosrc like '%group%' as handles_groups
      from pg_proc
     where pronamespace = 'public'::regnamespace
       and proname in ('executions_last_completed', 'status_activate_on_execution', 'status_activate_on_event',
                       'recalc_last_completed_group', 'item_group_members_last_completed',
                       'events_group_freeze', 'executions_group_tag')
     order by proname) t)
) as result;
