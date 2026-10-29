-- Arnold V1 step 2: verify the plans, goals and notifications migration. Read-only; run whole, paste back the one cell.
-- Expected: every table has rls_enabled true and without_comment 0; anon_has_any false everywhere; authenticated and
-- service_role true everywhere; 3 registry rows; every index and trigger listed; conformance CONFORMANT.
-- supabase/tests/arnold_v1-k7m/1_verify.sql

select json_build_object(
  'tables', (select coalesce(json_agg(t), '[]'::json) from (
      select c.relname as table_name,
             c.relrowsecurity as rls_enabled,
             (select count(*) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns,
             (select count(*) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                 and col_description(c.oid, a.attnum) is null) as without_comment,
             obj_description(c.oid, 'pg_class') is not null as has_table_comment,
             (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname in ('arnold_plans', 'arnold_goals', 'claude_notifications')
       order by c.relname
    ) t),
  'table_grants', (select coalesce(json_agg(t), '[]'::json) from (
      select tbl as table_name,
             (select bool_and(has_table_privilege('authenticated', 'public.' || tbl, p))
                from unnest(array['select', 'insert', 'update', 'delete']) p) as authenticated_crud,
             (select bool_and(has_table_privilege('service_role', 'public.' || tbl, p))
                from unnest(array['select', 'insert', 'update', 'delete']) p) as service_role_crud,
             has_table_privilege('anon', 'public.' || tbl, 'select')
               or has_table_privilege('anon', 'public.' || tbl, 'insert')
               or has_table_privilege('anon', 'public.' || tbl, 'update')
               or has_table_privilege('anon', 'public.' || tbl, 'delete') as anon_has_any
        from unnest(array['arnold_plans', 'arnold_goals', 'claude_notifications']) tbl
    ) t),
  'registry', (select coalesce(json_agg(t), '[]'::json) from (
      select table_name, policy_mode, audited, mcp_read
        from platform.registry
       where table_name in ('public.arnold_plans', 'public.arnold_goals', 'public.claude_notifications')
       order by table_name
    ) t),
  'indexes', (select coalesce(json_agg(t), '[]'::json) from (
      select tablename, indexname, indexdef
        from pg_indexes
       where schemaname = 'public' and tablename in ('arnold_plans', 'arnold_goals', 'claude_notifications')
       order by tablename, indexname
    ) t),
  'triggers', (select coalesce(json_agg(t), '[]'::json) from (
      select c.relname as table_name, tg.tgname as trigger_name, p.proname as function_name,
             tg.tgenabled <> 'D' as enabled
        from pg_trigger tg
        join pg_class c on c.oid = tg.tgrelid
        join pg_proc p on p.oid = tg.tgfoid
       where not tg.tgisinternal and c.relname in ('arnold_plans', 'arnold_goals', 'claude_notifications')
       order by c.relname, tg.tgname
    ) t),
  'functions', (select coalesce(json_agg(t), '[]'::json) from (
      select f as signature,
             to_regprocedure(f) is not null as exists,
             case when to_regprocedure(f) is not null then has_function_privilege('authenticated', f, 'execute') end as authenticated_exec,
             case when to_regprocedure(f) is not null then has_function_privilege('service_role', f, 'execute') end as service_role_exec,
             case when to_regprocedure(f) is not null then has_function_privilege('anon', f, 'execute') end as anon_exec,
             case when to_regprocedure(f) is not null
                  then (select not prosecdef from pg_proc where oid = to_regprocedure(f)) end as security_invoker
        from unnest(array[
          'public.arnold_create_plan(jsonb, jsonb)',
          'public.log_claude_notification(text, text, text, text, text, text, text, text, date, text, jsonb)',
          'public.arnold_hhmm_valid(text)',
          'public.arnold_notification_settings_problem(jsonb)',
          'public.arnold_prompt_templates_problem(jsonb)',
          'public.arnold_pace_checkpoints_problem(jsonb, integer)'
        ]) f
    ) t),
  'trigger_functions', (select coalesce(json_agg(t), '[]'::json) from (
      select f as signature, to_regprocedure(f) is not null as exists,
             case when to_regprocedure(f) is not null then has_function_privilege('anon', f, 'execute') end as anon_exec
        from unnest(array[
          'public.arnold_plans_guard_update()',
          'public.arnold_reject_update()',
          'public.claude_notifications_guard_update()'
        ]) f
    ) t),
  'validators_behave', (select coalesce(json_agg(t), '[]'::json) from (
      select
        public.arnold_notification_settings_problem('{"window_start":"05:00","window_end":"20:00","max_nudges_per_day":3,
          "max_encouragements_per_day":2,"inbox_waiting_delay_minutes":120}'::jsonb) is null as good_settings_pass,
        public.arnold_notification_settings_problem('{"window_start":"05:00","window_end":"20:00","max_nudges_per_day":3,
          "max_encouragements_per_day":2,"inbox_waiting_delay_minutes":120,"messages":{}}'::jsonb) as unknown_key_message,
        public.arnold_pace_checkpoints_problem('[{"time":"10:00","count":1},{"time":"14:00","count":3},
          {"time":"19:00","count":5}]'::jsonb, 5) is null as good_checkpoints_pass,
        public.arnold_pace_checkpoints_problem('[{"time":"14:00","count":3},{"time":"10:00","count":1}]'::jsonb, 5)
          as out_of_order_message,
        public.arnold_prompt_templates_problem('{"missed":"Arnold: I missed yoga on {day}."}'::jsonb) is null
          as good_templates_pass,
        public.arnold_prompt_templates_problem('{"missed":"I missed yoga."}'::jsonb) as no_prefix_message
    ) t),
  'apps_has_arnold', exists (select 1 from public.apps where id = 'arnold'),
  'conformance', public.platform_check_conformance()
) as result;
