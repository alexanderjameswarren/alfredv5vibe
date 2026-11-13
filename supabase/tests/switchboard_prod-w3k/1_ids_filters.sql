-- switchboard_prod-w3k s7: verify the ids filter rule (spec 7) against switchboard_actions_sf_read_payload. An ids
-- read filtering on a non-Id field is accepted; an ids read asking for a non-Id field back is still refused, with or
-- without such a filter. Run after the ids_filters migration, through the queue with --test. Throwaway rows, undone.
-- Result: one row, with all_passed, failed and checks.
-- supabase/tests/switchboard_prod-w3k/1_ids_filters.sql

do $$
declare
  c_alex constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_good constant jsonb := jsonb_build_object(
    'ids_count_filter_other_field', '{"alias":"ti-dev1","production":false,"level":"ids","object":"Contact","count":true,
                                      "filters":[{"field":"Email","op":"=","value":"x"}]}',
    'ids_fields_filter_in_other',   '{"alias":"ti-prod","production":true,"level":"ids","object":"Contact","fields":["Id","CreatedDate"],
                                      "limit":50,"filters":[{"field":"Recurring_Status__c","op":"in","value":["Active","Paused"]}]}',
    'ids_filter_id_still_ok',       '{"alias":"ti-dev1","production":false,"level":"ids","object":"Contact","count":true,
                                      "filters":[{"field":"CreatedDate","op":">=","value":"2026-11-01T00:00:00Z"}]}');
  c_bad constant jsonb := jsonb_build_object(
    'ids_other_field_back',             '{"alias":"ti-dev1","production":false,"level":"ids","object":"Contact","fields":["Id","Email"],"limit":5}',
    'ids_other_field_back_with_filter', '{"alias":"ti-dev1","production":false,"level":"ids","object":"Contact","fields":["Name"],"limit":5,
                                          "filters":[{"field":"Email","op":"=","value":"x"}]}',
    'ids_filter_relationship',          '{"alias":"ti-dev1","production":false,"level":"ids","object":"Contact","count":true,
                                          "filters":[{"field":"Account.Name","op":"=","value":"A"}]}');
  v_checks jsonb := '{}'::jsonb;
  v_result jsonb;
  v_ok     boolean;
  v_kv     record;
begin
  begin
    v_checks := v_checks || jsonb_build_object('constraint_exists', exists (
      select 1 from pg_constraint where conname = 'switchboard_actions_sf_read_payload'
        and conrelid = 'public.switchboard_actions'::regclass));

    for v_kv in select key, value from jsonb_each(c_good) loop
      begin
        insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
        values (c_alex, 'sf_read', 'sf-verify-ids-' || left(md5(v_kv.key), 8), (v_kv.value #>> '{}')::jsonb, 'SF READ TEST', 'claude');
        v_ok := true;
      exception when check_violation then
        v_ok := false;
      end;
      v_checks := v_checks || jsonb_build_object('accepted_' || v_kv.key, v_ok);
    end loop;

    for v_kv in select key, value from jsonb_each(c_bad) loop
      begin
        insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
        values (c_alex, 'sf_read', 'sf-verify-ids-' || left(md5(v_kv.key), 8), (v_kv.value #>> '{}')::jsonb, 'SF READ TEST', 'claude');
        v_ok := false;
      exception when check_violation then
        v_ok := true;
      end;
      v_checks := v_checks || jsonb_build_object('refused_' || v_kv.key, v_ok);
    end loop;

    v_result := jsonb_build_object(
      'all_passed', not exists (select 1 from jsonb_each(v_checks) where value <> 'true'::jsonb),
      'passed', (select count(*) from jsonb_each(v_checks) where value = 'true'::jsonb),
      'total', (select count(*) from jsonb_each(v_checks)),
      'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from jsonb_each(v_checks) where value <> 'true'::jsonb),
      'checks', v_checks);
    raise exception 'switchboard_verify_undo';
  exception when others then
    if sqlerrm <> 'switchboard_verify_undo' then
      v_result := jsonb_build_object('all_passed', false, 'error', sqlerrm, 'checks', v_checks);
    end if;
  end;
  perform set_config('switchboard.verify_result', v_result::text, true);
end;
$$;

select current_setting('switchboard.verify_result')::jsonb as result;
