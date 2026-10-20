-- Inbox atomic (inbox_atomic-q7d): check migration 145. Read-only. Open and run the whole file.
-- Returns one JSON cell. "passed": true means both functions exist as security invoker,
-- callable by signed-in users and not by anon, with a comment, no use of intents.is_item,
-- and the platform is still conformant.
-- supabase/tests/inbox_atomic/1_verify.sql

with fns as (
  select p.proname,
         pg_get_function_identity_arguments(p.oid) as args,
         case when p.prosecdef then 'definer' else 'invoker' end as security,
         has_function_privilege('anon', p.oid, 'execute') as anon_can_execute,
         has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute,
         obj_description(p.oid, 'pg_proc') is not null as has_comment,
         pg_get_functiondef(p.oid) ilike '%is_item%' as mentions_is_item
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('process_inbox_item', 'archive_inbox_item')
)
select json_build_object(
  'passed',
    (select count(*) = 2
            and bool_and(security = 'invoker' and not anon_can_execute and authenticated_can_execute
                         and has_comment and not mentions_is_item)
       from fns)
    and not exists (select 1 from platform.conformance_failures),
  'functions', (select coalesce(json_agg(t order by t.proname), '[]'::json) from (select * from fns) t),
  'conformance_failures', (select coalesce(json_agg(t), '[]'::json) from (
    select * from platform.conformance_failures) t)
) as result;
