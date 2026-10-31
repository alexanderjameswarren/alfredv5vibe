-- Arnold V1 step 8: verify the claude_notification_settings migration. Read-only; run whole, paste back the one cell.
-- Expected: rls_enabled true, without_comment 0, has_table_comment true, policies 1 or more; authenticated and
-- service_role crud true, anon_has_any false; 1 registry row; the guard trigger listed; both functions exist with
-- anon_exec false; validators_behave all true; arnold_app has the new description; conformance CONFORMANT.
-- supabase/tests/arnold_v1-k7m/3_notification_settings_verify.sql

select json_build_object(
  'table', (select coalesce(json_agg(t), '[]'::json) from (
      select c.relname as table_name,
             c.relrowsecurity as rls_enabled,
             (select count(*) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns,
             (select count(*) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                 and col_description(c.oid, a.attnum) is null) as without_comment,
             obj_description(c.oid, 'pg_class') is not null as has_table_comment,
             (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'claude_notification_settings'
    ) t),
  'table_grants', (select coalesce(json_agg(t), '[]'::json) from (
      select (select bool_and(has_table_privilege('authenticated', 'public.claude_notification_settings', p))
                from unnest(array['select', 'insert', 'update', 'delete']) p) as authenticated_crud,
             (select bool_and(has_table_privilege('service_role', 'public.claude_notification_settings', p))
                from unnest(array['select', 'insert', 'update', 'delete']) p) as service_role_crud,
             (select bool_or(has_table_privilege('anon', 'public.claude_notification_settings', p))
                from unnest(array['select', 'insert', 'update', 'delete']) p) as anon_has_any
    ) t),
  'registry', (select coalesce(json_agg(t), '[]'::json) from (
      select table_name, policy_mode, audited, mcp_read
        from platform.registry
       where table_name = 'public.claude_notification_settings'
    ) t),
  'constraints_and_triggers', (select coalesce(json_agg(t), '[]'::json) from (
      select 'constraint' as kind, conname as name from pg_constraint
       where conrelid = to_regclass('public.claude_notification_settings')
      union all
      select 'trigger', tgname from pg_trigger
       where tgrelid = to_regclass('public.claude_notification_settings') and not tgisinternal
       order by 1, 2
    ) t),
  'functions', (select coalesce(json_agg(t), '[]'::json) from (
      select f as signature,
             to_regprocedure(f) is not null as exists,
             case when to_regprocedure(f) is not null then has_function_privilege('authenticated', f, 'execute') end as authenticated_exec,
             case when to_regprocedure(f) is not null then has_function_privilege('anon', f, 'execute') end as anon_exec,
             case when to_regprocedure(f) is not null
                  then (select not prosecdef from pg_proc where oid = to_regprocedure(f)) end as security_invoker
        from unnest(array[
          'public.claude_notification_settings_problem(text,text,integer,integer,jsonb)',
          'public.claude_notification_settings_guard()'
        ]) f
    ) t),
  'validators_behave', (select coalesce(json_agg(t), '[]'::json) from (
      select
        public.claude_notification_settings_problem('05:00', '20:00', 3, null,
          '[{"app":"arnold","enabled":true,"plan_tool":"get_arnold_plan","progress_tool":"get_arnold_progress"}]'::jsonb)
          is null as valid_row_passes,
        public.claude_notification_settings_problem('20:00', '05:00', 3, null, '[]'::jsonb) is not null as reversed_window_refused,
        public.claude_notification_settings_problem('5am', '20:00', 3, null, '[]'::jsonb) is not null as bad_time_refused,
        public.claude_notification_settings_problem('05:00', '20:00', 25, null, '[]'::jsonb) is not null as hour_cap_refused,
        public.claude_notification_settings_problem('05:00', '20:00', 3, 201, '[]'::jsonb) is not null as day_cap_refused,
        public.claude_notification_settings_problem('05:00', '20:00', 3, null,
          '[{"app":"arnold","enabled":true,"plan_tool":"get_arnold_plan"}]'::jsonb) is not null as missing_key_refused,
        public.claude_notification_settings_problem('05:00', '20:00', 3, null,
          '[{"app":"arnold","enabled":true,"plan_tool":"a","progress_tool":"b"},
            {"app":"arnold","enabled":false,"plan_tool":"a","progress_tool":"b"}]'::jsonb) is not null as duplicate_refused,
        public.claude_notification_settings_problem('05:00', '20:00', 3, null,
          '[{"app":"arnold","enabled":"yes","plan_tool":"a","progress_tool":"b"}]'::jsonb) is not null as enabled_type_refused
    ) t),
  'arnold_app', (select coalesce(json_agg(t), '[]'::json) from (
      select id, description from public.apps where id = 'arnold'
    ) t),
  'conformance', (select public.platform_check_conformance())
) as result;
