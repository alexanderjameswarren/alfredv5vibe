-- Overwatch Step 18 check, after 174. Read-only. Paste back the single result cell.
-- Expected: backfilled_rows about 732; double_logged_closes 0; source_refs_repeated 0; cli_rows_per_tag 1;
-- conformance CONFORMANT. Re-running the preview (15_preview_activity_backfill.sql) should then show
-- would_insert_total 0.
-- supabase/tests/overwatch-q4n/16_verify_activity_backfill.sql

select json_build_object(
  'by_kind_app_source', (select coalesce(json_agg(t), '[]'::json) from (
      select kind, app_id, source, count(*) as rows from public.activity group by 1, 2, 3 order by 3, 1, 2) t),
  -- Rows written by this backfill: created after the first live trigger row, but about events before it, or CLI rows.
  'backfilled_rows', (select count(*) from public.activity a
                       where a.created_at > (select min(created_at) from public.activity where source = 'trigger')
                         and (a.source = 'cli'
                              or a.occurred_at < (select min(created_at) from public.activity where source = 'trigger'))),
  -- One close logged twice: an intention row and an execution row for the same intention within 10 minutes.
  'double_logged_closes', (select count(*) from public.activity ai
                            join public.executions e on ai.target_type = 'intention' and e.intent_id = ai.target_id
                            join public.activity ae on ae.source_ref = 'execution:' || e.id
                           where abs(extract(epoch from (ai.occurred_at - ae.occurred_at))) < 600),
  'source_refs_repeated', (select count(*) from (select source, source_ref from public.activity
                            where source_ref is not null group by 1, 2 having count(*) > 1) d),
  'cli_rows_per_tag', (select coalesce(max(n), 0) from (select count(*) as n from public.activity
                        where source = 'cli' group by source_ref) c),
  'overwatch_project_rows', (select count(*) from public.activity where group_id = 'mvnv8pa2v6zip3xnpm'),
  'conformance', (select public.platform_check_conformance())
) as result;
