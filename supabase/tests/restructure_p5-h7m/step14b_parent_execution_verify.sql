-- Restructure P5 Step 14b: verify migration 154 (parent_execution_id). Read-only;
-- run whole, paste back the one result cell.
-- Expect: conformant true, failures []; the column (text, nullable); the cascade FK; the
-- partial index; the check, validated; no recipe run without a parent; no parent on a run
-- with an intention.
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (
    select * from platform.conformance_failures) t),
  'column', (select coalesce(json_agg(t), '[]'::json) from (
    select data_type, is_nullable from information_schema.columns
     where table_schema = 'public' and table_name = 'executions' and column_name = 'parent_execution_id') t),
  'constraints', (select coalesce(json_agg(t), '[]'::json) from (
    select conname, contype, convalidated, pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid = 'public.executions'::regclass
       and (conname = 'executions_parent_is_recipe_run' or pg_get_constraintdef(oid) like '%parent_execution_id%')) t),
  'index', (select coalesce(json_agg(t), '[]'::json) from (
    select indexname, indexdef from pg_indexes where schemaname = 'public' and indexname = 'idx_executions_parent') t),
  'recipe_runs_without_parent', (select coalesce(json_agg(t), '[]'::json) from (
    select id, group_id, status, closed_at from public.executions
     where group_id is not null and intent_id is null and parent_execution_id is null) t),
  'parents_on_intention_runs', (select count(*) from public.executions
     where parent_execution_id is not null and intent_id is not null)
) as result;
