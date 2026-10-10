-- Purpose: Warren Buffet Phase 2 Step 4 verification, after the tool-support migration: new columns, wb_transaction_list against wb_review_queue, the four functions' security and grants, and a dry-run preview.
-- Kind: read-only diagnostic (never "applied"; writes nothing)
-- Applied: YES — run 2026-10-10 by Alex after 108: all 10 checks true; needs_review 301; preview_kind_spend 287; preview_transfer_phrase 48. Read-only, safe to re-run.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p2-m4t.md sections 4.7, 6 and 6.1.
-- Expect every value under "checks" true. No real financial data in this file.
-- supabase/migrations/109_wb_phase2_verify_step4.sql

select json_build_object(
  'checks', json_build_object(
    'rules_created_from_column', exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'wb_rules' and column_name = 'created_from_transaction_id'),
    'split_tags_replaced_rule_column', exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'wb_split_tags' and column_name = 'replaced_rule_id'),
    'list_view_security_invoker', (
      select coalesce(c.reloptions, '{}') @> array['security_invoker=true']
      from pg_class c where c.oid = 'public.wb_transaction_list'::regclass),
    'list_has_every_transaction', (
      (select count(*) from public.wb_transaction_list) = (select count(*) from public.wb_transactions)),
    'needs_review_matches_queue', (
      (select count(*) from public.wb_transaction_list where needs_review)
      = (select count(distinct transaction_id) from public.wb_review_queue)),
    'tag_names_match_split_tags', (
      (select count(*) from public.wb_transaction_list where cardinality(tag_names) > 0)
      = (select count(distinct s.transaction_id) from public.wb_split_tags st join public.wb_splits s on s.id = st.split_id)),
    'functions_are_invoker', (
      select bool_and(not p.prosecdef) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('wb_rule_preview', 'wb_replace_splits', 'wb_set_transfer_pair', 'wb_apply_tags')),
    'four_functions_exist', (
      select count(*) = 4 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('wb_rule_preview', 'wb_replace_splits', 'wb_set_transfer_pair', 'wb_apply_tags')),
    'anon_blocked', (
      not has_table_privilege('anon', 'public.wb_transaction_list', 'select')
      and not has_function_privilege('anon', 'public.wb_rule_preview(jsonb, text, integer)', 'execute')
      and not has_function_privilege('anon', 'public.wb_replace_splits(uuid, jsonb, text)', 'execute')
      and not has_function_privilege('anon', 'public.wb_set_transfer_pair(uuid, uuid, text)', 'execute')
      and not has_function_privilege('anon', 'public.wb_apply_tags(uuid[], uuid[], text, uuid[])', 'execute')),
    'authenticated_can_call', (
      has_function_privilege('authenticated', 'public.wb_rule_preview(jsonb, text, integer)', 'execute')
      and has_function_privilege('authenticated', 'public.wb_apply_tags(uuid[], uuid[], text, uuid[])', 'execute')
      and has_table_privilege('authenticated', 'public.wb_transaction_list', 'select'))
  ),
  'needs_review_count', (select count(*) from public.wb_transaction_list where needs_review),
  'preview_transfer_phrase', (
    select json_build_object('count', (r ->> 'count')::int, 'too_narrow', (r ->> 'too_narrow')::boolean)
    from (select public.wb_rule_preview(null, 'transfer', 0) as r) q),
  'preview_kind_spend', (
    select json_build_object('count', (r ->> 'count')::int)
    from (select public.wb_rule_preview('{"kind": "spend"}'::jsonb, null, 0) as r) q)
) as result;
