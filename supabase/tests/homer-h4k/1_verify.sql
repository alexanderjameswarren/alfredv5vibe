-- Homer s5: verify the core migration. Read-only; queue with --test.
-- Result: one row with all_passed, failed and checks; details for anything that failed.
-- supabase/tests/homer-h4k/1_verify.sql

with
tbl(name) as (
  select unnest(array['homer_plans', 'homer_readers', 'homer_devices', 'homer_series', 'homer_books', 'homer_reads',
                      'homer_verdicts', 'homer_taste_profiles', 'homer_genres', 'homer_genre_series', 'homer_queue_items'])
),
tables as (
  select t.name,
         c.oid is not null as exists,
         coalesce(c.relrowsecurity, false) as rls,
         obj_description(c.oid, 'pg_class') is not null as table_comment,
         (select count(*) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
             and col_description(c.oid, a.attnum) is null) as columns_without_comment,
         (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = t.name) as policies,
         c.oid is not null and (select bool_and(has_table_privilege('authenticated', c.oid, p))
            from unnest(array['select', 'insert', 'update', 'delete']) p) as authenticated_crud,
         c.oid is not null and (select bool_and(has_table_privilege('service_role', c.oid, p))
            from unnest(array['select', 'insert', 'update', 'delete']) p) as service_role_crud,
         c.oid is not null and (select bool_or(has_table_privilege('anon', c.oid, p))
            from unnest(array['select', 'insert', 'update', 'delete']) p) as anon_any,
         exists (select 1 from platform.registry r where r.table_name = 'public.' || t.name and r.audited) as registered_audited
    from tbl t
    left join pg_class c on c.relname = t.name and c.relnamespace = 'public'::regnamespace
),
fns(sig, needs_exec) as (
  values ('public.create_homer_plan(text, jsonb, text, text)', true),
         ('public.homer_plan_settings_problem(jsonb)', true),
         ('public.homer_scores_problem(jsonb, jsonb)', true),
         ('public.homer_plans_guard()', false),
         ('public.homer_reads_fill_reader()', false),
         ('public.homer_devices_carry_reader()', false),
         ('public.homer_verdicts_guard()', false),
         ('public.homer_taste_scores_check()', false)
),
functions as (
  select f.sig,
         to_regprocedure(f.sig) is not null as exists,
         case when to_regprocedure(f.sig) is null then false
              else not has_function_privilege('anon', f.sig, 'execute') end as anon_none,
         case when not f.needs_exec then true when to_regprocedure(f.sig) is null then false
              else has_function_privilege('authenticated', f.sig, 'execute') end as authenticated_ok,
         coalesce((select not prosecdef from pg_proc where oid = to_regprocedure(f.sig)), false) as security_invoker
    from fns f
),
trig(tbl, name) as (
  values ('homer_plans', 'homer_plans_guard'), ('homer_reads', 'homer_reads_fill_reader'),
         ('homer_devices', 'homer_devices_carry_reader'), ('homer_verdicts', 'homer_verdicts_guard'),
         ('homer_taste_profiles', 'homer_taste_scores_check')
),
idx(name) as (
  select unnest(array['homer_plans_one_active', 'homer_reads_one_per_book_device', 'homer_reads_import_key',
                      'homer_verdicts_one_series', 'homer_verdicts_one_book', 'homer_verdicts_one_author',
                      'homer_series_user_asin', 'homer_queue_one_live_asin'])
),
checks as (
  select jsonb_build_object(
    'tables_exist',            (select bool_and(exists) from tables),
    'rls_on',                  (select bool_and(rls) from tables),
    'table_comments',          (select bool_and(table_comment) from tables),
    'column_comments',         (select sum(columns_without_comment) = 0 from tables),
    'policies',                (select bool_and(policies > 0) from tables),
    'authenticated_crud',      (select bool_and(authenticated_crud) from tables),
    'service_role_crud',       (select bool_and(service_role_crud) from tables),
    'anon_nothing_tables',     (select not bool_or(anon_any) from tables),
    'registered_audited',      (select bool_and(registered_audited) from tables),
    'functions_exist',         (select bool_and(exists) from functions),
    'anon_nothing_functions',  (select bool_and(anon_none) from functions),
    'authenticated_exec',      (select bool_and(authenticated_ok) from functions),
    'security_invoker',        (select bool_and(security_invoker) from functions),
    'triggers',                (select bool_and(exists (select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid
                                   where c.relname = t.tbl and g.tgname = t.name and g.tgenabled <> 'D')) from trig t),
    'indexes',                 (select bool_and(exists (select 1 from pg_indexes i where i.schemaname = 'public'
                                   and i.indexname = x.name)) from idx x),
    'no_homer_conformance_failures', (select count(*) = 0 from platform.conformance_failures where table_name::text like 'public.homer\_%'),
    'conformant',              public.platform_check_conformance() like 'CONFORMANT%'
  ) as c
)
select jsonb_build_object(
  'all_passed', not exists (select 1 from jsonb_each(c) where value <> 'true'::jsonb),
  'failed',     (select coalesce(jsonb_agg(key), '[]'::jsonb) from jsonb_each(c) where value <> 'true'::jsonb),
  'checks',     c,
  'tables_detail', (select jsonb_agg(to_jsonb(t)) from tables t
                     where not (exists and rls and table_comment and columns_without_comment = 0 and policies > 0
                                and authenticated_crud and service_role_crud and not anon_any and registered_audited)),
  'functions_detail', (select jsonb_agg(to_jsonb(f)) from functions f
                        where not (exists and anon_none and authenticated_ok and security_invoker)),
  'conformance', public.platform_check_conformance()
) as result
from checks;
