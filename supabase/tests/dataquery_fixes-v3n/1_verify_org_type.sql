-- dataquery_fixes-v3n s4: verify migration 244 (docs/technical-spec-dataquery_fixes-v3n.md, Fix 2): an sf_dataquery
-- insert needs org_type "sandbox" or "production" (the guard); the payload check allows it missing, for rows from
-- before it, and refuses any other value; an existing row without it can still change status; other kinds are
-- untouched; the grants are kept. Run after 244, through the queue with --test. Throwaway rows; everything is undone,
-- including the status change on the existing row.
-- Result: one row, with all_passed, failed and checks.
-- supabase/tests/dataquery_fixes-v3n/1_verify_org_type.sql

do $$
declare
  c_alex  constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_code  constant text := 'dataquery-verify-v3n';
  c_r1    constant text := 'SELECT COUNT() FROM GiftTransaction WHERE Source__c = ''ActBlue'' AND GiftCommitmentId = null';
  v_base    jsonb;
  v_checks  jsonb := '{}'::jsonb;
  v_result  jsonb;
  v_ok      boolean;
  v_msg     text;
  v_old     uuid;
  v_kv      record;
begin
  begin
    v_base := jsonb_build_object('alias', 'actblue', 'repo', 'C:\Users\Alex\projects\actblue\common-defense',
      'run', 'data-ops/' || c_code || '/verify-2026-11-19', 'run_tag', c_code || '-s4-ab12',
      'request_sha256', repeat('0123456789abcdef', 4),
      'queries', jsonb_build_array(jsonb_build_object('step', 'rules', 'soql', c_r1,
        'sha256', encode(sha256(convert_to(c_r1, 'UTF8')), 'hex'), 'label', 'Installments with no gift commitment')));

    -- ---- the payload check alone ----
    v_checks := v_checks || jsonb_build_object(
      'payload_ok_missing_org_type', public.switchboard_dataquery_payload_ok(v_base, c_code),
      'payload_ok_sandbox', public.switchboard_dataquery_payload_ok(v_base || '{"org_type": "sandbox"}', c_code),
      'payload_ok_production', public.switchboard_dataquery_payload_ok(v_base || '{"org_type": "production"}', c_code),
      'payload_refuses_prod', not public.switchboard_dataquery_payload_ok(v_base || '{"org_type": "prod"}', c_code),
      'payload_refuses_capital', not public.switchboard_dataquery_payload_ok(v_base || '{"org_type": "Sandbox"}', c_code),
      'payload_refuses_non_string', not public.switchboard_dataquery_payload_ok(v_base || '{"org_type": true}', c_code),
      'payload_refuses_null', not public.switchboard_dataquery_payload_ok(v_base || '{"org_type": null}', c_code),
      'payload_still_refuses_other_keys', not public.switchboard_dataquery_payload_ok(v_base || '{"org": "sandbox"}', c_code));

    -- ---- inserts: sandbox and production pass ----
    for v_kv in select * from (values ('sandbox'), ('production')) as t(org) loop
      begin
        insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
        values (c_alex, 'sf_dataquery', c_code, v_base || jsonb_build_object('org_type', v_kv.org), 'VERIFY ' || v_kv.org, 'claude');
        v_ok := true;
      exception when others then
        v_ok := false;
      end;
      v_checks := v_checks || jsonb_build_object('insert_' || v_kv.org || '_passes', v_ok);
    end loop;

    -- ---- inserts: missing and "prod" are refused by the guard, saying why ----
    for v_kv in select * from (values ('missing', v_base), ('prod', v_base || '{"org_type": "prod"}'),
                                      ('null', v_base || '{"org_type": null}')) as t(key, payload) loop
      v_msg := null;
      begin
        insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
        values (c_alex, 'sf_dataquery', c_code, v_kv.payload, 'VERIFY REFUSED', 'claude');
        v_ok := false;
      exception when check_violation then
        v_msg := sqlerrm;
        v_ok := true;
      end;
      v_checks := v_checks || jsonb_build_object('insert_' || v_kv.key || '_refused', v_ok,
        'insert_' || v_kv.key || '_message_names_org_type', coalesce(v_msg like '%needs payload.org_type, exactly "sandbox" or "production"%', false));
    end loop;

    -- ---- an existing sf_dataquery row without org_type can still change status (the CHECK re-runs on update) ----
    select id into v_old from public.switchboard_actions
     where kind = 'sf_dataquery' and not (payload ? 'org_type') order by created_at limit 1;
    if v_old is null then
      v_checks := v_checks || jsonb_build_object('old_row_found', false);
    else
      begin
        update public.switchboard_actions set status = 'cancelled' where id = v_old;
        v_ok := (select status = 'cancelled' from public.switchboard_actions where id = v_old);
      exception when others then
        v_ok := false;
      end;
      v_checks := v_checks || jsonb_build_object('old_row_found', true, 'old_row_status_update_passes', v_ok);
    end if;

    -- ---- other kinds are untouched by the new insert rule ----
    begin
      insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
      values (c_alex, 'git', c_code, '{"command": "gitsync"}', 'VERIFY GIT', 'claude');
      v_ok := true;
    exception when others then
      v_ok := false;
    end;
    v_checks := v_checks || jsonb_build_object('git_insert_unaffected', v_ok);

    -- ---- grants kept, anon nothing ----
    v_checks := v_checks || jsonb_build_object(
      'payload_ok_grants',
        has_function_privilege('authenticated', 'public.switchboard_dataquery_payload_ok(jsonb, text)', 'execute')
        and has_function_privilege('service_role', 'public.switchboard_dataquery_payload_ok(jsonb, text)', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_dataquery_payload_ok(jsonb, text)', 'execute'),
      'guard_no_anon', not has_function_privilege('anon', 'public.switchboard_actions_guard()', 'execute'),
      'guard_trigger_still_attached', exists (select 1 from pg_trigger where tgname = 'switchboard_actions_guard'
        and tgrelid = 'public.switchboard_actions'::regclass and not tgisinternal),
      'conformant', coalesce(public.platform_check_conformance() like 'CONFORMANT%', false));

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
