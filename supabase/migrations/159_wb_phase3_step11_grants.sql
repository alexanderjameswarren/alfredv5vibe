-- Purpose: Warren Buffet Phase 3, Step 11 grants (Alex, 2026-10-23, run tags warren_buffet_p3-q5k-s32-c6rn and -s33-n2gy; spec A58). The project's default privileges gave public and anon execute on every Phase 3 wb_ function, and anon select on the Phase 3 views. No caller runs as anon: the app and MCP run as authenticated and wb-sync as service_role. Those grants are revoked, so the table grants are no longer the only lock. service_role loses execute on wb_delete_planned_item, which only the app calls (A46). authenticated and service_role keep everything else; each function already has explicit grants to both.
-- Kind: schema change (grants only)
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p3-q5k.md A46 and A58. Run after 158. Safe to run again from the top:
-- every statement is a revoke, which does nothing when the grant is already gone.
-- Callers checked 2026-10-23:
--   app (authenticated): wb_action_items, wb_confirm_planned_match, wb_unconfirm_planned_match, wb_suggest_planned_matches,
--     wb_delete_planned_item, wb_free_cash; views wb_burn_rate, wb_planned_unmatched, wb_project_summary, wb_true_cost.
--   MCP (authenticated, the user's token): wb_action_items, wb_cash_projection, wb_confirm_planned_match, wb_free_cash,
--     wb_planned_start_from_history, wb_suggest_planned_matches, wb_unconfirm_planned_match; views wb_burn_rate,
--     wb_planned_unmatched, wb_project_summary, wb_rule_health_all, wb_true_cost.
--   wb-sync (service_role): wb_process_transactions and wb_detect_subscriptions, which call wb_suggest_planned_matches,
--     wb_planned_occurrences and wb_planned_left inside; those keep service_role.
--   Nested calls under authenticated (wb_action_items, wb_free_cash, the views): wb_cash_projection, wb_burn_rate_on,
--     wb_subscription_occurrences, wb_monthly_equivalent, wb_planned_left, wb_planned_occurrences; all keep authenticated.
--   Trigger functions (wb_planned_matches_fill, wb_planned_skips_fill, wb_splits_fill_project_source) need no execute
--     grant to fire; only public and anon are revoked from them.
-- Not here (Alex's call, project-wide): the default privileges themselves, and the Phase 1 and 2 wb_ functions and views
-- that carry the same anon grant.
-- supabase/migrations/159_wb_phase3_step11_grants.sql

begin;

revoke all on function public.wb_burn_rate_on(date) from public, anon;
revoke all on function public.wb_cash_projection(boolean, date) from public, anon;
revoke all on function public.wb_confirm_planned_match(uuid, text, numeric) from public, anon;
revoke all on function public.wb_free_cash(boolean, date) from public, anon;
revoke all on function public.wb_monthly_equivalent(numeric, integer, text) from public, anon;
revoke all on function public.wb_planned_left(numeric, numeric, numeric) from public, anon;
revoke all on function public.wb_planned_occurrences(date, date, boolean) from public, anon;
revoke all on function public.wb_planned_start_from_history(uuid, numeric, numeric, date) from public, anon;
revoke all on function public.wb_subscription_occurrences(date, date, date) from public, anon;
revoke all on function public.wb_suggest_planned_matches(uuid[], uuid[]) from public, anon;
revoke all on function public.wb_unconfirm_planned_match(uuid) from public, anon;
revoke all on function public.wb_planned_matches_fill() from public, anon;
revoke all on function public.wb_planned_skips_fill() from public, anon;
revoke all on function public.wb_splits_fill_project_source() from public, anon;

-- A46: wb_delete_planned_item is the app's alone.
revoke all on function public.wb_delete_planned_item(uuid) from public, anon, service_role;

revoke all on public.wb_burn_rate, public.wb_planned_unmatched, public.wb_project_summary, public.wb_subscription_outflows,
  public.wb_true_cost, public.wb_rule_health, public.wb_rule_health_all from anon;

commit;

-- ============================================================================
-- The result the SQL editor shows: conformance, and every grant left on these objects to public or anon
-- (expect none) and to authenticated and service_role (expect them all, but no service_role on wb_delete_planned_item).
-- ============================================================================
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t),
  'functions_left_to_public_or_anon', (select coalesce(json_agg(t), '[]'::json) from (
     select p.proname, g.grantee
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
     cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     left join pg_roles r on r.oid = a.grantee
     cross join lateral (select coalesce(r.rolname, 'public') as grantee) g
     where p.proname in ('wb_burn_rate_on', 'wb_cash_projection', 'wb_confirm_planned_match', 'wb_free_cash',
                         'wb_monthly_equivalent', 'wb_planned_left', 'wb_planned_occurrences', 'wb_planned_start_from_history',
                         'wb_subscription_occurrences', 'wb_suggest_planned_matches', 'wb_unconfirm_planned_match',
                         'wb_planned_matches_fill', 'wb_planned_skips_fill', 'wb_splits_fill_project_source',
                         'wb_delete_planned_item')
       and g.grantee in ('public', 'anon')) t),
  'delete_planned_item_grantees', (select coalesce(json_agg(t), '[]'::json) from (
     select coalesce(r.rolname, 'public') as grantee
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
     cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     left join pg_roles r on r.oid = a.grantee
     where p.proname = 'wb_delete_planned_item') t),
  'views_left_to_anon', (select coalesce(json_agg(t), '[]'::json) from (
     select table_name, privilege_type from information_schema.role_table_grants
     where grantee = 'anon' and table_schema = 'public'
       and table_name in ('wb_burn_rate', 'wb_planned_unmatched', 'wb_project_summary', 'wb_subscription_outflows',
                          'wb_true_cost', 'wb_rule_health', 'wb_rule_health_all')) t)
) as result;
