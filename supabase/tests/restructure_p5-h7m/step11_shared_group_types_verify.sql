-- Restructure P5 Step 11 follow-up: verify migration 150 (shared group types). Read-only;
-- run whole, paste back the one result cell.
-- Expect: conformant true, failures []; no context_id on group_types; the four policies
-- (read for everyone signed in, insert/update/delete for the owner) and no group_types_access;
-- the three types; the three contexts' defaults intact.
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (
    select * from platform.conformance_failures) t),
  'context_id_gone', (select not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'group_types' and column_name = 'context_id')),
  'policies', (select coalesce(json_agg(t), '[]'::json) from (
    select policyname, cmd, qual, with_check
      from pg_policies
     where schemaname = 'public' and tablename = 'group_types'
     order by policyname) t),
  'types', (select coalesce(json_agg(t), '[]'::json) from (
    select id, label_singular, label_plural, icon, execution_mode
      from public.group_types
     order by label_singular) t),
  'context_defaults', (select coalesce(json_agg(t), '[]'::json) from (
    select c.name as context, g.label_singular as default_type
      from public.contexts c join public.group_types g on g.id = c.default_group_type_id
     order by c.name) t)
) as result;
