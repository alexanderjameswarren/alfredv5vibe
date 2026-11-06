-- notification_routing-d7v step 12: verify claude_reader (get_sql_read) can read signals.decided_by, and nothing
-- more than before: no write on signals, no anon access, the other columns still readable. Runs after
-- 217_signals_reader_decided_by.sql, with --test. It undoes itself: the inner block ends in its own error, the checks survive in a
-- variable, and the result row says { ok, failed, check_count, checks }.
-- supabase/tests/notification_routing-d7v/8_reader_decided_by_verify.sql

do $$
declare
  c_done   constant text := 'NRD_UNDO';
  c        jsonb := '{}';
  v_result jsonb;
begin
  begin
    c := c || jsonb_build_object(
      'reader_reads_decided_by', has_column_privilege('claude_reader', 'public.signals', 'decided_by', 'select'),
      'reader_still_reads_state', has_column_privilege('claude_reader', 'public.signals', 'state', 'select'),
      'reader_cannot_update_it', not has_column_privilege('claude_reader', 'public.signals', 'decided_by', 'update'),
      'reader_cannot_insert', not has_table_privilege('claude_reader', 'public.signals', 'insert'),
      'reader_rule_still_there', exists (select 1 from pg_policies
                                          where schemaname = 'public' and tablename = 'signals'
                                            and policyname = 'claude_reader_read'),
      'anon_cannot_read_it', not has_column_privilege('anon', 'public.signals', 'decided_by', 'select'));

    v_result := jsonb_build_object(
      'ok', not exists (select 1 from jsonb_each(c) where value is distinct from 'true'::jsonb),
      'failed', (select coalesce(jsonb_agg(key order by key), '[]'::jsonb) from jsonb_each(c)
                  where value is distinct from 'true'::jsonb),
      'check_count', (select count(*) from jsonb_object_keys(c)),
      'checks', c);
    raise exception '%', c_done;
  exception when others then
    if sqlerrm <> c_done then
      v_result := jsonb_build_object('ok', false, 'error', sqlerrm, 'sqlstate', sqlstate, 'checks_so_far', c);
    end if;
  end;
  perform set_config('notification_routing.result', v_result::text, false);
end;
$$;

select current_setting('notification_routing.result')::jsonb as result;
