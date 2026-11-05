-- Switchboard 2.0 s84c: verify switchboard_queue_git. Run after migration 208, through the queue with --test.
-- Throwaway rows, undone. Result: one row, with all_passed, failed and checks.
-- supabase/tests/switchboard2-h8r/7_verify_queue_git.sql

do $$
declare
  c_alex constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  v_checks jsonb := '{}'::jsonb;
  v_out jsonb;
  v_row public.switchboard_actions;
  v_ok boolean;
  v_result jsonb;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', c_alex, 'role', 'authenticated')::text, true);

    v_out := public.switchboard_queue_git('verify-queue-git', '{"command":"gitpush","mode":"finish","finish":"phase"}',
      'GITPUSH FINISH verify-queue-git: TEST', 'https://claude.ai/chat/x');
    select * into v_row from public.switchboard_actions where id = (v_out->>'action_id')::uuid;
    v_checks := v_checks
      || jsonb_build_object('good_payload_queued', v_row.id is not null)
      || jsonb_build_object('row_is_callers', v_row.user_id = c_alex)
      || jsonb_build_object('kind_git', v_row.kind = 'git')
      || jsonb_build_object('created_by_claude', v_row.created_by = 'claude')
      || jsonb_build_object('status_queued_no_link', v_row.status = 'queued' and v_row.link_hash is null)
      || jsonb_build_object('needs_click_true', v_row.needs_click)
      || jsonb_build_object('fingerprint_set', v_row.fingerprint = public.switchboard_fingerprint(v_row.payload))
      || jsonb_build_object('chat_url_kept', v_row.chat_url = 'https://claude.ai/chat/x');

    begin
      perform public.switchboard_queue_git('verify-queue-git', '{"command":"rm"}', 'TEST'); v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('unknown_command_refused', v_ok);

    begin
      perform public.switchboard_queue_git('verify-queue-git', '{"command":"gitpush"}', 'TEST'); v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('gitpush_without_mode_refused', v_ok);

    begin
      perform public.switchboard_queue_git('verify-queue-git', '["gitsync"]', 'TEST'); v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('non_object_refused', v_ok);

    begin
      perform public.switchboard_queue_git('Bad Code', '{"command":"gitsync"}', 'TEST'); v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('bad_project_code_refused', v_ok);

    begin
      perform public.switchboard_queue_git('verify-queue-git', '{"command":"gitsync"}', ' '); v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('empty_headline_refused', v_ok);

    perform set_config('request.jwt.claims', '', true);
    begin
      perform public.switchboard_queue_git('verify-queue-git', '{"command":"gitsync"}', 'TEST'); v_ok := false;
    exception when invalid_authorization_specification then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('no_user_refused', v_ok);

    v_checks := v_checks
      || jsonb_build_object('anon_cannot_call', not has_function_privilege('anon', 'public.switchboard_queue_git(text, jsonb, text, text)', 'execute'))
      || jsonb_build_object('authenticated_can_call', has_function_privilege('authenticated', 'public.switchboard_queue_git(text, jsonb, text, text)', 'execute'))
      || jsonb_build_object('security_definer', (select prosecdef from pg_proc where oid = 'public.switchboard_queue_git(text, jsonb, text, text)'::regprocedure))
      || jsonb_build_object('authenticated_still_cannot_insert', not has_table_privilege('authenticated', 'public.switchboard_actions', 'insert'));

    v_result := jsonb_build_object(
      'all_passed', not exists (select 1 from jsonb_each(v_checks) where value <> 'true'::jsonb),
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
