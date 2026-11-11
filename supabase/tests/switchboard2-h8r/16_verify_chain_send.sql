-- Switchboard 2.0 s90a: verify the chained link's payload rule (then: {send: "<run tag>"}) on switchboard_actions.
-- Run after the chain_send migration, through the queue with --test. Throwaway rows, undone. Result: one row, with
-- all_passed, failed and checks.
-- supabase/tests/switchboard2-h8r/16_verify_chain_send.sql

do $$
declare
  c_alex constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  -- name, project code, payload. Each row has its own code: one live action per project.
  c_good constant jsonb := jsonb_build_array(
    jsonb_build_array('gitsync_then', 'vc-a1', '{"command":"gitsync","then":{"send":"vc-a1-s90a-ab12"}}'),
    jsonb_build_array('checkpoint_then', 'vc-a2', '{"command":"gitpush","mode":"checkpoint","paths":["a.js"],"then":{"send":"vc-a2-s90b-cd34"}}'),
    jsonb_build_array('push_then', 'vc-a3', '{"command":"gitpush","mode":"push","then":{"send":"vc-a3-s7-ef56"}}'),
    jsonb_build_array('two_letter_step', 'vc-a4', '{"command":"gitsync","then":{"send":"vc-a4-s89ab-gh78"}}'),
    jsonb_build_array('underscore_code', 'vc_under_a5', '{"command":"gitsync","then":{"send":"vc_under_a5-s3-ij90"}}'),
    -- Without then, as before.
    jsonb_build_array('gitcom_plain', 'vc-b1', '{"command":"gitcom","message":"m"}'),
    jsonb_build_array('gitnewtree_plain', 'vc-b2', '{"command":"gitnewtree"}'),
    jsonb_build_array('finish_plain', 'vc-b3', '{"command":"gitpush","mode":"finish","finish":"phase"}'),
    jsonb_build_array('gitsync_plain', 'vc-b4', '{"command":"gitsync"}'));
  c_bad constant jsonb := jsonb_build_array(
    jsonb_build_array('gitcom_then', 'vc-c1', '{"command":"gitcom","message":"m","then":{"send":"vc-c1-s1-ab12"}}'),
    jsonb_build_array('gitnewtree_then', 'vc-c2', '{"command":"gitnewtree","then":{"send":"vc-c2-s1-ab12"}}'),
    jsonb_build_array('finish_then', 'vc-c3', '{"command":"gitpush","mode":"finish","finish":"phase","then":{"send":"vc-c3-s1-ab12"}}'),
    jsonb_build_array('extra_key', 'vc-c4', '{"command":"gitsync","then":{"send":"vc-c4-s1-ab12","wait":true}}'),
    jsonb_build_array('send_not_string', 'vc-c5', '{"command":"gitsync","then":{"send":5}}'),
    jsonb_build_array('then_empty', 'vc-c6', '{"command":"gitsync","then":{}}'),
    jsonb_build_array('then_string', 'vc-c7', '{"command":"gitsync","then":"vc-c7-s1-ab12"}'),
    jsonb_build_array('then_null', 'vc-c8', '{"command":"gitsync","then":null}'),
    jsonb_build_array('other_project', 'vc-c9', '{"command":"gitsync","then":{"send":"vc-zz-s1-ab12"}}'),
    jsonb_build_array('code_prefix_only', 'vc-d1', '{"command":"gitsync","then":{"send":"vc-d1x-s1-ab12"}}'),
    jsonb_build_array('short_suffix', 'vc-d2', '{"command":"gitsync","then":{"send":"vc-d2-s1-ab1"}}'),
    jsonb_build_array('no_step_number', 'vc-d3', '{"command":"gitsync","then":{"send":"vc-d3-sa-ab12"}}'),
    jsonb_build_array('no_step', 'vc-d4', '{"command":"gitsync","then":{"send":"vc-d4-ab12"}}'),
    jsonb_build_array('upper_case', 'vc-d5', '{"command":"gitsync","then":{"send":"vc-d5-s1-AB12"}}'),
    jsonb_build_array('space', 'vc-d6', '{"command":"gitsync","then":{"send":"vc-d6-s1-ab12 "}}'),
    -- A 34-character code (valid) makes a 42-character tag.
    jsonb_build_array('over_40', 'vc-long-project-code-for-the-cap-x', '{"command":"gitsync","then":{"send":"vc-long-project-code-for-the-cap-x-s1-ab12"}}'),
    -- 207's rule still holds.
    jsonb_build_array('no_command', 'vc-e1', '{"then":{"send":"vc-e1-s1-ab12"}}'),
    jsonb_build_array('push_no_mode', 'vc-e2', '{"command":"gitpush","then":{"send":"vc-e2-s1-ab12"}}'));
  v_checks jsonb := '{}'::jsonb;
  v_result jsonb;
  v_wrong  text[] := '{}';
  v_case   jsonb;
begin
  begin
    for v_case in select value from jsonb_array_elements(c_good) loop
      begin
        insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
        values (c_alex, 'git', v_case->>1, (v_case->>2)::jsonb, 'CHAIN TEST', 'claude');
      exception when check_violation then
        v_wrong := v_wrong || (v_case->>0);
      end;
    end loop;
    v_checks := v_checks
      || jsonb_build_object('accepted_all_good', cardinality(v_wrong) = 0)
      || jsonb_build_object('good_refused', to_jsonb(v_wrong));

    v_wrong := '{}';
    for v_case in select value from jsonb_array_elements(c_bad) loop
      begin
        insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
        values (c_alex, 'git', v_case->>1, (v_case->>2)::jsonb, 'CHAIN TEST', 'claude');
        v_wrong := v_wrong || (v_case->>0);
      exception when check_violation then
        null;
      end;
    end loop;
    v_checks := v_checks
      || jsonb_build_object('refused_all_bad', cardinality(v_wrong) = 0)
      || jsonb_build_object('bad_accepted', to_jsonb(v_wrong))
      || jsonb_build_object('bad_case_count', jsonb_array_length(c_bad) = 18)
      -- The over-40 case must fail on length, not on its code: the code itself is a valid one.
      || jsonb_build_object('over_40_code_valid', 'vc-long-project-code-for-the-cap-x'::text ~ '^[a-z0-9_-]{1,40}$'
           and length('vc-long-project-code-for-the-cap-x-s1-ab12'::text) = 42)
      || jsonb_build_object('check_exists', exists (
           select 1 from pg_constraint where conname = 'switchboard_actions_git_payload' and contype = 'c'
             and conrelid = 'public.switchboard_actions'::regclass))
      || jsonb_build_object('existing_rows_meet_it', not exists (
           select 1 from pg_constraint where conname = 'switchboard_actions_git_payload' and not convalidated))
      || jsonb_build_object('payload_comment_names_then', col_description('public.switchboard_actions'::regclass,
           (select attnum from pg_attribute where attrelid = 'public.switchboard_actions'::regclass and attname = 'payload')) like '%"then": {"send"%')
      || jsonb_build_object('no_conformance_failures', not exists (
           select 1 from platform.conformance_failures where table_name::text = 'public.switchboard_actions'));

    v_result := jsonb_build_object(
      'all_passed', not exists (select 1 from jsonb_each(v_checks) where jsonb_typeof(value) = 'boolean' and value <> 'true'::jsonb),
      'passed', (select count(*) from jsonb_each(v_checks) where value = 'true'::jsonb),
      'total', (select count(*) from jsonb_each(v_checks) where jsonb_typeof(value) = 'boolean'),
      'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from jsonb_each(v_checks)
                  where jsonb_typeof(value) = 'boolean' and value <> 'true'::jsonb),
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
