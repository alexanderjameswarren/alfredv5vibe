-- dataops_alfred-d4x s4: verify the sf_dataop migration (docs/technical-spec-dataops_alfred-d4x.md, the payload
-- contract and the four layers): the kind and its payload check, needs_click always true whoever queues it, the
-- pickup's kinds and its 15-minute expiry (O6), the sf_read objects list, the read log's objects column and the
-- grants. Run after the migration, through the queue with --test. Throwaway rows; everything is undone, including
-- any real action a pickup call touches. Result: one row, with all_passed, failed and checks.
-- supabase/tests/dataops_alfred-d4x/1_verify_sf_dataop.sql

do $$
declare
  c_alex constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_good constant jsonb := '{"alias":"cd-prod","repo":"C:\\Users\\Alex\\projects\\common-defense","plan":"dataops/fixc-plan.json",
    "stamp":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","preflight_at":"2026-11-18T15:00:00.000Z",
    "object":"Demo_Gift__c","problem":"Forty-five gifts were saved without a link to their plan.","expected":45,
    "write":{"kind":"bulk"},
    "rows":[{"label":"Gifts in the list with no plan link","before":45,"goal":0},
            {"label":"Knock-on check: Plans whose paid total went up today","before":0,"goal":12,"knock_on":true}],
    "rehearsal":{"sandbox":"cd-dev1","at":"2026-11-18T16:00:00Z"}}';
  c_read constant jsonb := '{"alias":"cd-prod","production":true,"level":"metadata"}';
  v_bad    jsonb;
  v_checks jsonb := '{}'::jsonb;
  v_result jsonb;
  v_ok     boolean;
  v_kv     record;
  v_id     uuid;
  v_new    uuid;
  v_old    uuid;
  v_q      jsonb;
  v_pick   jsonb;
  v_seen   uuid[] := '{}';
  v_twenty jsonb;
  i        integer;
begin
  begin
    -- ---- schema and grants ----
    v_checks := v_checks || jsonb_build_object(
      'kind_check_has_sf_dataop', coalesce((select pg_get_constraintdef(oid) like '%sf_dataop%' from pg_constraint
        where conname = 'switchboard_actions_kind_valid' and conrelid = 'public.switchboard_actions'::regclass), false),
      'payload_check_exists', exists (select 1 from pg_constraint where conname = 'switchboard_actions_sf_dataop_payload'
        and conrelid = 'public.switchboard_actions'::regclass),
      'click_check_exists', exists (select 1 from pg_constraint where conname = 'switchboard_actions_sf_dataop_click'
        and conrelid = 'public.switchboard_actions'::regclass),
      'read_log_objects_column', exists (select 1 from information_schema.columns where table_schema = 'public'
        and table_name = 'switchboard_sf_read_log' and column_name = 'objects' and data_type = 'jsonb'),
      'pickup_old_signature_gone', to_regprocedure('public.switchboard_pickup_helper(uuid)') is null,
      'pickup_new_signature', to_regprocedure('public.switchboard_pickup_helper(uuid, text[])') is not null,
      'pickup_service_role_only',
        has_function_privilege('service_role', 'public.switchboard_pickup_helper(uuid, text[])', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_pickup_helper(uuid, text[])', 'execute')
        and not has_function_privilege('authenticated', 'public.switchboard_pickup_helper(uuid, text[])', 'execute'),
      'queue_helper_no_anon',
        has_function_privilege('authenticated', 'public.switchboard_queue_helper(text, text, jsonb, text, text)', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_queue_helper(text, text, jsonb, text, text)', 'execute'),
      'needs_click_no_anon',
        not has_function_privilege('anon', 'public.switchboard_needs_click(text, jsonb, text)', 'execute'));

    -- ---- layer 1: needs_click is true whoever queues it, and never changes ----
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by, needs_click)
    values (c_alex, 'sf_dataop', 'dataops-verify-cli', c_good, 'PRODUCTION DATA RUN TEST', 'cli', false)
    returning id into v_id;
    v_checks := v_checks || jsonb_build_object('good_payload_accepted', true,
      'needs_click_as_cli', (select needs_click from public.switchboard_actions where id = v_id));
    begin
      update public.switchboard_actions set needs_click = false where id = v_id;
      v_ok := false;
    exception when check_violation then
      v_ok := true;
    end;
    v_checks := v_checks || jsonb_build_object('needs_click_update_refused', v_ok);

    perform set_config('request.jwt.claim.sub', c_alex::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', c_alex, 'role', 'authenticated')::text, true);
    v_q := public.switchboard_queue_helper('sf_dataop', 'dataops-verify-claude', c_good, 'PRODUCTION DATA RUN TEST', null);
    v_checks := v_checks || jsonb_build_object('needs_click_as_claude', coalesce((select needs_click and created_by = 'claude'
      from public.switchboard_actions where id = (v_q->>'action_id')::uuid), false));
    begin
      perform public.switchboard_queue_helper('sf_dataop', null, c_good, 'PRODUCTION DATA RUN TEST', null);
      v_ok := false;
    exception when check_violation then
      v_ok := true;
    end;
    v_checks := v_checks || jsonb_build_object('queue_without_code_refused', v_ok);

    -- ---- the payload contract: each of these is refused ----
    for v_kv in select * from (values
      ('no_stamp',            c_good - 'stamp'),
      ('short_stamp',         jsonb_set(c_good, '{stamp}', '"0123abcd"')),
      ('upper_case_stamp',    jsonb_set(c_good, '{stamp}', to_jsonb(upper(c_good->>'stamp')))),
      ('extra_key_ids',       c_good || '{"ids":["a0D000000000001AAA"]}'),
      ('extra_key_soql',      c_good || '{"soql":"SELECT Id FROM Contact"}'),
      ('expected_zero',       jsonb_set(c_good, '{expected}', '0')),
      ('expected_text',       jsonb_set(c_good, '{expected}', '"45"')),
      ('expected_fraction',   jsonb_set(c_good, '{expected}', '4.5')),
      ('batch_no_class',      jsonb_set(c_good, '{write}', '{"kind":"batch"}')),
      ('bulk_with_class',     jsonb_set(c_good, '{write}', '{"kind":"bulk","class":"FixCBatch"}')),
      ('write_other_kind',    jsonb_set(c_good, '{write}', '{"kind":"apex"}')),
      ('write_scalar',        jsonb_set(c_good, '{write}', '"bulk"')),
      ('no_rows',             jsonb_set(c_good, '{rows}', '[]')),
      ('rows_41',             jsonb_set(c_good, '{rows}', (select jsonb_agg(jsonb_build_object('label', 'Row number ' || g, 'before', 1, 'goal', 0))
                                                           from generate_series(1, 41) g))),
      ('row_negative',        jsonb_set(c_good, '{rows}', '[{"label":"Gifts with no plan link","before":-1,"goal":0}]')),
      ('row_extra_key',       jsonb_set(c_good, '{rows}', '[{"label":"Gifts with no plan link","before":1,"goal":0,"soql":"x"}]')),
      ('row_knock_on_text',   jsonb_set(c_good, '{rows}', '[{"label":"Gifts with no plan link","before":1,"goal":0,"knock_on":"yes"}]')),
      ('problem_short',       jsonb_set(c_good, '{problem}', '"too short"')),
      ('plan_dot_dot',        jsonb_set(c_good, '{plan}', '"../other/plan.json"')),
      ('plan_not_json',       jsonb_set(c_good, '{plan}', '"dataops/plan.csv"')),
      ('repo_relative',       jsonb_set(c_good, '{repo}', '"projects\\common-defense"')),
      ('preflight_at_date',   jsonb_set(c_good, '{preflight_at}', '"2026-11-18"')),
      ('rehearsal_extra',     jsonb_set(c_good, '{rehearsal}', '{"sandbox":"cd-dev1","at":"2026-11-18T16:00:00Z","passed":true}')),
      ('rehearsal_scalar',    jsonb_set(c_good, '{rehearsal}', '"cd-dev1"')),
      ('label_over_200',      jsonb_set(c_good, '{rows}', jsonb_build_array(jsonb_build_object('label', repeat('x', 201), 'before', 1, 'goal', 0))))
    ) as t(key, value) loop
      begin
        insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
        values (c_alex, 'sf_dataop', 'dataops-verify-bad', v_kv.value, 'PRODUCTION DATA RUN TEST', 'claude');
        v_ok := false;
      exception when check_violation then
        v_ok := true;
      end;
      v_checks := v_checks || jsonb_build_object('refused_' || v_kv.key, v_ok);
    end loop;
    -- Without rehearsal, and as a batch, it is accepted.
    begin
      insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
      values (c_alex, 'sf_dataop', 'dataops-verify-batch',
              jsonb_set(c_good - 'rehearsal', '{write}', '{"kind":"batch","class":"FixCLinkBatch"}'), 'PRODUCTION DATA RUN TEST', 'claude');
      v_ok := true;
    exception when check_violation then
      v_ok := false;
    end;
    v_checks := v_checks || jsonb_build_object('accepted_batch_without_rehearsal', v_ok);

    -- ---- the sf_read objects list ----
    v_twenty := (select jsonb_agg('Obj' || g || '__c') from generate_series(1, 20) g);
    for v_kv in select * from (values
      ('objects_20',     true,  c_read || jsonb_build_object('objects', v_twenty)),
      ('objects_1',      true,  c_read || '{"objects":["Contact"]}'),
      ('object_still',   true,  c_read || '{"object":"Contact"}'),
      ('objects_21',     false, c_read || jsonb_build_object('objects', v_twenty || '["Contact"]'::jsonb)),
      ('objects_empty',  false, c_read || '{"objects":[]}'),
      ('objects_and_object', false, c_read || '{"objects":["Contact"],"object":"Account"}'),
      ('objects_dotted', false, c_read || '{"objects":["Account.Name"]}'),
      ('objects_at_data', false, '{"alias":"cd-prod","production":true,"level":"data","objects":["Contact"],"count":true}'::jsonb),
      ('objects_at_objects', false, '{"alias":"cd-prod","production":true,"level":"objects","objects":["Contact"]}'::jsonb)
    ) as t(key, want, value) loop
      begin
        insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
        values (c_alex, 'sf_read', 'dataops-verify-read', v_kv.value, 'SF READ TEST', 'claude');
        v_ok := v_kv.want;
      exception when check_violation then
        v_ok := not v_kv.want;
      end;
      v_checks := v_checks || jsonb_build_object((case when v_kv.want then 'read_accepted_' else 'read_refused_' end) || v_kv.key, v_ok);
    end loop;

    -- ---- the pickup (layer 1) ----
    -- v_id: queued, never clicked. v_new: clicked now. v_old: clicked 16 minutes ago. Each in its own project.
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
    values (c_alex, 'sf_dataop', 'dataops-verify-new', c_good, 'PRODUCTION DATA RUN TEST', 'claude') returning id into v_new;
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
    values (c_alex, 'sf_dataop', 'dataops-verify-old', c_good, 'PRODUCTION DATA RUN TEST', 'claude') returning id into v_old;
    update public.switchboard_actions
       set link_hash = md5(random()::text) || md5(random()::text), link_expires_at = now() + interval '30 minutes',
           link_used_at = now(), status = 'consumed'
     where id = v_new;
    update public.switchboard_actions
       set link_hash = md5(random()::text) || md5(random()::text), link_expires_at = now() + interval '30 minutes',
           link_used_at = now() - interval '16 minutes', status = 'consumed'
     where id = v_old;

    -- Today's runner (no kinds) and a helper naming the old four: never an sf_dataop. Drain every ready action.
    for i in 1..60 loop
      v_pick := public.switchboard_pickup_helper(c_alex);
      exit when v_pick is null;
      v_seen := v_seen || (v_pick->>'action_id')::uuid;
    end loop;
    for i in 1..60 loop
      v_pick := public.switchboard_pickup_helper(c_alex, array['git', 'sf_check', 'sb_setup', 'sf_read']);
      exit when v_pick is null;
      v_seen := v_seen || (v_pick->>'action_id')::uuid;
    end loop;
    v_checks := v_checks || jsonb_build_object(
      'no_kinds_and_old_kinds_never_get_sf_dataop', not (v_seen && array[v_id, v_new, v_old]),
      'expired_after_15_minutes', coalesce((select status = 'failed' from public.switchboard_actions where id = v_old), false),
      'expired_run_says_why', exists (select 1 from public.switchboard_runs where action_id = v_old
        and summary like 'expired: approved over 15 minutes ago and never picked up%' and finished_at is not null));

    -- A helper naming sf_dataop: gets the clicked one, never the unclicked or the expired one.
    v_seen := '{}';
    for i in 1..60 loop
      v_pick := public.switchboard_pickup_helper(c_alex, array['git', 'sf_check', 'sb_setup', 'sf_read', 'sf_dataop']);
      exit when v_pick is null;
      v_seen := v_seen || (v_pick->>'action_id')::uuid;
    end loop;
    v_checks := v_checks || jsonb_build_object(
      'clicked_sf_dataop_picked_when_named', v_new = any(v_seen),
      'unclicked_sf_dataop_never_picked', not (v_id = any(v_seen)),
      'expired_sf_dataop_never_picked', not (v_old = any(v_seen)));

    begin
      perform public.switchboard_pickup_helper(c_alex, array['git', 'sf_delete']);
      v_ok := false;
    exception when invalid_parameter_value then
      v_ok := true;
    end;
    v_checks := v_checks || jsonb_build_object('unknown_kind_refused', v_ok);

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
