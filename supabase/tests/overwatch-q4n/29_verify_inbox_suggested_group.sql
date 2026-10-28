-- Overwatch Step 57: read-only check after migration 184 and its test. Paste back the single
-- result cell. Expected: the column (text, nullable, commented, a foreign key to item_groups on delete set null), the
-- trigger, no suggestions yet (enrichment sets them from Step 58), process_inbox_item executable by authenticated
-- and service_role but not anon, CONFORMANT.
-- supabase/tests/overwatch-q4n/29_verify_inbox_suggested_group.sql

select json_build_object(
  'column', (select coalesce(json_agg(t), '[]'::json) from (
      select column_name, data_type, is_nullable,
             col_description('public.inbox'::regclass, ordinal_position::int) is not null as has_comment
        from information_schema.columns
       where table_schema = 'public' and table_name = 'inbox' and column_name = 'suggested_group_id'
    ) t),
  'foreign_key', (select coalesce(json_agg(t), '[]'::json) from (
      select conname, pg_get_constraintdef(oid) as definition
        from pg_constraint
       where conrelid = 'public.inbox'::regclass and contype = 'f'
         and pg_get_constraintdef(oid) like '%suggested_group_id%'
    ) t),
  'trigger', (select coalesce(json_agg(t), '[]'::json) from (
      select tgname as trigger_name, tgfoid::regproc::text as function_name
        from pg_trigger where tgrelid = 'public.inbox'::regclass and tgname = 'inbox_check_suggested_group'
    ) t),
  'suggestions_so_far', (select coalesce(json_agg(t), '[]'::json) from (
      select count(*) as n from public.inbox where suggested_group_id is not null
    ) t),
  'function_execute', (select coalesce(json_agg(t), '[]'::json) from (
      select r as role, has_function_privilege(r, 'public.process_inbox_item(text, jsonb)', 'execute') as can_execute
        from unnest(array['anon', 'authenticated', 'service_role']) r
    ) t),
  'conformance', public.platform_check_conformance()
) as result;
