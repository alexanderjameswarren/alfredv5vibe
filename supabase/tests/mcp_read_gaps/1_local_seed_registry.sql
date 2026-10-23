-- LOCAL DOCKER ONLY. Never run against the linked project.
-- Fixture for a local rebuild from supabase/schema-snapshot.sql: the snapshot is schema-only, so platform.registry is
-- empty and migration 160 refuses to set read settings on unregistered tables. This records every public table the way
-- live has it (audited when it carries audit_trigger; allowed_emails exempt). policy_mode is not exercised locally.
-- Order: snapshot, this file, migrations 158-162, then 2_local_grants_test.sql.

insert into platform.registry (table_name, policy_mode, audited, exempt, notes)
select 'public.' || c.relname,
       'none',
       exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'audit_trigger' and not t.tgisinternal),
       c.relname = 'allowed_emails',
       'local test seed'
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
on conflict (table_name) do nothing;

select count(*) as registry_rows from platform.registry;
