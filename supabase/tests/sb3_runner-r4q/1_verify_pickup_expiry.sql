-- sb3_runner-r4q r2: verify the pickup expiry migration (switchboard repo docs/technical-spec-sb3_plumbing-n7c.md, A2
-- and M): an action of every helper kind approved 16 minutes ago is failed, with the reason, at the next pickup by
-- either function and never handed out; one approved 5 minutes ago is handed out; a repeated pickup id returns the
-- same action and run; the grants and the new signatures; s1b: failure_reason is 'expired_not_picked_up' on an
-- expiry's run and null on any other failure. Run after the migration, through the queue with --test.
-- Throwaway rows; everything is undone, including any real action a pickup call touches.
-- Result: one row, with all_passed, failed, errors and checks.
-- supabase/tests/sb3_runner-r4q/1_verify_pickup_expiry.sql

do $$
declare
  c_alex  constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_code  constant text := 'r4q-verify-base';
  c_kinds constant text[] := array['git', 'sf_check', 'sf_read', 'sb_setup', 'sf_dataop', 'sf_dataquery', 'sf_datawrite'];
  c_why   constant jsonb := '{"ok": false, "expired": true, "reason": "expired_not_picked_up"}';
  c_req   constant text := '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  c_sel   constant text := E'SELECT Id, GiftCommitmentId FROM GiftTransaction WHERE Source__c = ''ActBlue'' AND CreatedDate < 2026-11-18T00:00:00Z\n';
  c_broad constant text := 'SELECT Id, GiftCommitmentId, Amount, LastModifiedById FROM GiftTransaction WHERE Source__c = ''ActBlue''';
  c_r1    constant text := 'SELECT COUNT() FROM GiftTransaction WHERE Source__c = ''ActBlue'' AND GiftCommitmentId = null';
  c_r2    constant text := 'SELECT COUNT() FROM GiftCommitment WHERE Rollup_Pending__c = true';
  -- An sf_dataop payload as 240 takes it (dataops_alfred-d4x's test).
  c_dataop constant jsonb := '{"alias":"cd-prod","repo":"C:\\Users\\Alex\\projects\\common-defense","plan":"dataops/fixc-plan.json",
    "stamp":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","preflight_at":"2026-11-18T15:00:00.000Z",
    "object":"Demo_Gift__c","problem":"Forty-five gifts were saved without a link to their plan.","expected":45,
    "write":{"kind":"bulk"},"rows":[{"label":"Gifts in the list with no plan link","before":45,"goal":0}]}';
  v_selsha   text;
  v_payloads jsonb;
  v_checks   jsonb := '{}'::jsonb;
  v_errors   jsonb := '{}'::jsonb;
  v_result   jsonb;
  v_kind     text;
  v_set      text;
  v_proj     text;
  v_id       uuid;
  v_ids      jsonb := '{}'::jsonb;   -- '<set>:<kind>' -> action id
  v_nolink   uuid;
  v_pid1     uuid := gen_random_uuid();
  v_pid2     uuid := gen_random_uuid();
  v_first    jsonb;
  v_again    jsonb;
  v_pick     jsonb;
  v_plain    jsonb;
  v_seen     uuid[] := '{}';
  i          integer;
begin
  begin
    -- ---- a valid payload of each kind, from the tests that added them ----
    v_selsha := encode(sha256(convert_to(c_sel, 'UTF8')), 'hex');
    v_payloads := jsonb_build_object(
      'git', '{"command": "gitsync"}'::jsonb,
      'sf_check', '{"check": "org-verify", "alias": "ti-dev1"}'::jsonb,
      'sf_read', '{"alias": "ti-dev1", "production": false, "level": "objects"}'::jsonb,
      'sb_setup', '{"command": "org add", "client": "r4q-verify", "orgs": [{"alias": "acme-dev", "type": "developer",
                    "level": "objects", "login": "integration", "cli_deploy": true, "shared": false}]}'::jsonb,
      'sf_dataop', c_dataop,
      -- dataop_link-k7d's counts payload.
      'sf_dataquery', jsonb_build_object('alias', 'cd-prod', 'org_type', 'production', 'repo', 'C:\Users\Alex\projects\common-defense',
        'run', 'data-ops/' || c_code || '/fixc-2026-11-19', 'run_tag', c_code || '-s4-ab12', 'request_sha256', c_req,
        'queries', jsonb_build_array(
          jsonb_build_object('step', 'rules', 'soql', c_r1, 'sha256', encode(sha256(convert_to(c_r1, 'UTF8')), 'hex'), 'label', 'Installments with no gift commitment'),
          jsonb_build_object('step', 'rules', 'soql', c_r2, 'sha256', encode(sha256(convert_to(c_r2, 'UTF8')), 'hex'), 'label', 'Commitments whose totals are still updating'))),
      -- dataop_write-j5w's batch payload.
      'sf_datawrite', jsonb_build_object('alias', 'cd-prod', 'org_type', 'production', 'repo', 'C:\Users\Alex\projects\common-defense',
        'run', 'data-ops/' || c_code || '/fixc-2026-11-19', 'run_tag', c_code || '-s9-ab12', 'request_sha256', c_req,
        'selection_sha256', v_selsha, 'object', 'GiftTransaction',
        'problem', 'Forty-five installments were saved without a link to their gift commitment.', 'expected', 45,
        'write', jsonb_build_object('kind', 'batch', 'class', 'FixCLinkBatch'),
        'queries', jsonb_build_array(
          jsonb_build_object('step', 'gate', 'soql', c_sel, 'sha256', v_selsha, 'file', 'selection.soql'),
          jsonb_build_object('step', 'gate', 'soql', c_broad, 'sha256', encode(sha256(convert_to(c_broad, 'UTF8')), 'hex'), 'label', 'gate: broad snapshot'),
          jsonb_build_object('step', 'after', 'soql', c_broad, 'sha256', encode(sha256(convert_to(c_broad, 'UTF8')), 'hex'), 'label', 'after: broad snapshot'),
          jsonb_build_object('step', 'after', 'soql', c_sel, 'sha256', v_selsha, 'label', 'after: selection'),
          jsonb_build_object('step', 'after-counts', 'soql', c_r1, 'sha256', encode(sha256(convert_to(c_r1, 'UTF8')), 'hex'),
            'label', 'Installments with no gift commitment'),
          jsonb_build_object('step', 'after-counts', 'soql', c_r2, 'sha256', encode(sha256(convert_to(c_r2, 'UTF8')), 'hex'),
            'label', 'Commitments whose totals are updating: wait', 'wait', jsonb_build_object('stable_minutes', 2, 'limit_minutes', 30)))));

    -- ---- signatures and grants ----
    v_checks := v_checks || jsonb_build_object(
      'old_signatures_gone',
        to_regprocedure('public.switchboard_pickup_helper(uuid, text[])') is null
        and to_regprocedure('public.switchboard_pickup_git(uuid)') is null,
      'pickup_helper_grants',
        has_function_privilege('service_role', 'public.switchboard_pickup_helper(uuid, text[], uuid)', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_pickup_helper(uuid, text[], uuid)', 'execute')
        and not has_function_privilege('authenticated', 'public.switchboard_pickup_helper(uuid, text[], uuid)', 'execute'),
      'pickup_git_grants',
        has_function_privilege('service_role', 'public.switchboard_pickup_git(uuid, uuid)', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_pickup_git(uuid, uuid)', 'execute')
        and not has_function_privilege('authenticated', 'public.switchboard_pickup_git(uuid, uuid)', 'execute'),
      'failure_reason_column_text_no_default', exists (select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'switchboard_runs' and column_name = 'failure_reason'
          and data_type = 'text' and column_default is null and is_nullable = 'YES')
        and col_description('public.switchboard_runs'::regclass,
              (select attnum from pg_attribute where attrelid = 'public.switchboard_runs'::regclass
                 and attname = 'failure_reason')::integer) is not null,
      'failure_reason_readable_by_claude_reader',
        has_column_privilege('claude_reader', 'public.switchboard_runs', 'failure_reason', 'select'));

    -- ---- the actions: each in its own project; 'old1' and 'old2' approved 16 minutes ago, 'new' and 'new2' 5 minutes
    --      ago. The 1 sets are for pickup_git, the 2 sets for pickup_helper ----
    foreach v_set in array array['old1', 'old2', 'new', 'new2'] loop
      foreach v_kind in array c_kinds loop
        v_proj := 'r4q-v-' || v_set || '-' || replace(v_kind, '_', '-');
        begin
          insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by, created_at)
          values (c_alex, v_kind, v_proj, replace((v_payloads->v_kind)::text, c_code, v_proj)::jsonb, 'R4Q PICKUP TEST',
                  'claude', now() - interval '20 minutes')
          returning id into v_id;
          update public.switchboard_actions
             set link_hash = md5(random()::text) || md5(random()::text), link_expires_at = now() + interval '30 minutes',
                 link_used_at = now() - case when v_set like 'new%' then interval '5 minutes' else interval '16 minutes' end,
                 status = 'consumed'
           where id = v_id;
          v_ids := v_ids || jsonb_build_object(v_set || ':' || v_kind, v_id);
        exception when others then
          v_errors := v_errors || jsonb_build_object(v_set || ':' || v_kind, sqlerrm);
        end;
        v_checks := v_checks || jsonb_build_object('inserted_' || v_set || '_' || v_kind, v_ids ? (v_set || ':' || v_kind));
      end loop;
    end loop;
    -- A git action consumed with no link, queued 20 minutes ago: the coalesce falls back to created_at.
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by, created_at)
    values (c_alex, 'git', 'r4q-v-nolink-git', '{"command": "gitsync"}', 'R4Q PICKUP TEST', 'claude', now() - interval '20 minutes')
    returning id into v_nolink;
    update public.switchboard_actions set status = 'consumed' where id = v_nolink;
    -- The 2 sets must be untouched by pickup_git: held back as link_issued until the helper phase.
    update public.switchboard_actions set status = 'link_issued'
     where id in (select value::uuid from jsonb_each_text(v_ids) where key like 'old2:%' or key like 'new2:%');

    -- ---- switchboard_pickup_git: fails every kind's stale action, hands out the fresh git one ----
    v_first := public.switchboard_pickup_git(c_alex, v_pid1);
    v_again := public.switchboard_pickup_git(c_alex, v_pid1);
    v_seen := v_seen || (v_first->>'action_id')::uuid;
    foreach v_kind in array c_kinds loop
      v_id := (v_ids->>('old1:' || v_kind))::uuid;
      v_checks := v_checks || jsonb_build_object(
        'git_pickup_failed_old_' || v_kind,
          coalesce((select status = 'failed' and picked_up_at is null from public.switchboard_actions where id = v_id), false),
        'git_pickup_old_run_says_why_' || v_kind,
          exists (select 1 from public.switchboard_runs where action_id = v_id and result = c_why and finished_at is not null
                    and summary like 'expired: approved over 15 minutes ago and never picked up%'
                    and failure_reason = 'expired_not_picked_up'));
    end loop;
    v_checks := v_checks || jsonb_build_object(
      'git_pickup_failed_no_link_by_created_at',
        coalesce((select status = 'failed' from public.switchboard_actions where id = v_nolink), false),
      'git_first_pickup_found_one', v_first is not null,
      'git_repeat_same_action', v_again->>'action_id' is not distinct from v_first->>'action_id',
      'git_repeat_same_run', v_again->>'run_id' is not distinct from v_first->>'run_id',
      'git_repeat_opened_no_second_run',
        (select count(*) from public.switchboard_runs where action_id = (v_first->>'action_id')::uuid and finished_at is null) = 1,
      'git_run_carries_pickup_id',
        coalesce((select result = jsonb_build_object('pickup_id', v_pid1) from public.switchboard_runs
                   where id = (v_first->>'run_id')::uuid), false));
    -- A new id while ready actions remain must get a different one, not the repeat.
    v_pick := public.switchboard_pickup_git(c_alex, gen_random_uuid());
    v_checks := v_checks || jsonb_build_object(
      'git_new_id_gets_no_repeat', v_pick is null or v_pick->>'action_id' is distinct from v_first->>'action_id');
    if v_pick is not null then
      v_seen := v_seen || (v_pick->>'action_id')::uuid;
    end if;
    for i in 1..60 loop
      v_pick := public.switchboard_pickup_git(c_alex);
      exit when v_pick is null;
      v_plain := coalesce(v_plain, v_pick);
      v_seen := v_seen || (v_pick->>'action_id')::uuid;
    end loop;
    v_again := public.switchboard_pickup_git(c_alex, v_pid1);
    v_checks := v_checks || jsonb_build_object(
      'git_fresh_handed_out', coalesce((v_ids->>'new:git')::uuid = any(v_seen), false),
      'git_old_never_handed_out', v_ids ? 'old1:git'
                                  and not (v_seen && array[(v_ids->>'old1:git')::uuid, v_nolink]),
      'git_left_fresh_non_git_alone', (select count(*) = 6 from public.switchboard_actions
        where id in (select value::uuid from jsonb_each_text(v_ids) where key like 'new:%' and key <> 'new:git')
          and status = 'consumed' and picked_up_at is null),
      'git_repeat_still_same_later', v_again->>'action_id' is not distinct from v_first->>'action_id'
                                     and v_again->>'run_id' is not distinct from v_first->>'run_id',
      'plain_pick_result_null', v_plain is null
        or coalesce((select result is null from public.switchboard_runs where id = (v_plain->>'run_id')::uuid), false));

    -- ---- switchboard_pickup_helper, all seven kinds: fails every stale one, hands out every fresh one ----
    update public.switchboard_actions set status = 'consumed'
     where id in (select value::uuid from jsonb_each_text(v_ids) where key like 'old2:%' or key like 'new2:%');
    v_seen := '{}';
    v_first := public.switchboard_pickup_helper(c_alex, c_kinds, v_pid2);
    v_again := public.switchboard_pickup_helper(c_alex, c_kinds, v_pid2);
    v_seen := v_seen || (v_first->>'action_id')::uuid;
    foreach v_kind in array c_kinds loop
      v_id := (v_ids->>('old2:' || v_kind))::uuid;
      v_checks := v_checks || jsonb_build_object(
        'helper_pickup_failed_old_' || v_kind,
          coalesce((select status = 'failed' and picked_up_at is null from public.switchboard_actions where id = v_id), false),
        'helper_pickup_old_run_says_why_' || v_kind,
          exists (select 1 from public.switchboard_runs where action_id = v_id and result = c_why and finished_at is not null
                    and summary like 'expired: approved over 15 minutes ago and never picked up%'
                    and failure_reason = 'expired_not_picked_up'));
    end loop;
    v_checks := v_checks || jsonb_build_object(
      'helper_first_pickup_found_one', v_first is not null,
      'helper_repeat_same_action', v_again->>'action_id' is not distinct from v_first->>'action_id',
      'helper_repeat_same_run', v_again->>'run_id' is not distinct from v_first->>'run_id',
      'helper_repeat_same_kind', v_again->>'kind' is not distinct from v_first->>'kind',
      'helper_run_carries_pickup_id',
        coalesce((select result = jsonb_build_object('pickup_id', v_pid2) from public.switchboard_runs
                   where id = (v_first->>'run_id')::uuid), false));
    for i in 1..60 loop
      v_pick := public.switchboard_pickup_helper(c_alex, c_kinds);
      exit when v_pick is null;
      v_seen := v_seen || (v_pick->>'action_id')::uuid;
    end loop;
    foreach v_kind in array c_kinds loop
      v_checks := v_checks || jsonb_build_object(
        'helper_fresh_handed_out_' || v_kind, coalesce((v_ids->>('new2:' || v_kind))::uuid = any(v_seen), false),
        'helper_old_never_handed_out_' || v_kind, v_ids ? ('old2:' || v_kind)
          and not coalesce((v_ids->>('old2:' || v_kind))::uuid = any(v_seen), false));
    end loop;

    -- A failure that is not an expiry leaves failure_reason null: the helper-picked run closed as failed, the way the
    -- runner's /result does, and a fresh pickup run that is still open.
    update public.switchboard_runs
       set summary = 'R4Q TEST: failed in the window', result = '{"ok": false, "exit_code": 1}', finished_at = now()
     where id = (v_first->>'run_id')::uuid;
    update public.switchboard_actions set status = 'failed' where id = (v_first->>'action_id')::uuid;
    v_checks := v_checks || jsonb_build_object(
      'non_expired_failure_reason_null',
        coalesce((select failure_reason is null and finished_at is not null from public.switchboard_runs
                   where id = (v_first->>'run_id')::uuid), false),
      'picked_runs_reason_null', not exists (select 1 from public.switchboard_runs r
        where r.action_id = any(v_seen) and r.summary = 'picked up by the helper' and r.failure_reason is not null));

    v_result := jsonb_build_object(
      'all_passed', not exists (select 1 from jsonb_each(v_checks) where value <> 'true'::jsonb),
      'passed', (select count(*) from jsonb_each(v_checks) where value = 'true'::jsonb),
      'total', (select count(*) from jsonb_each(v_checks)),
      'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from jsonb_each(v_checks) where value <> 'true'::jsonb),
      'errors', v_errors,
      'checks', v_checks);
    raise exception 'switchboard_verify_undo';
  exception when others then
    if sqlerrm <> 'switchboard_verify_undo' then
      v_result := jsonb_build_object('all_passed', false, 'error', sqlerrm, 'errors', v_errors, 'checks', v_checks);
    end if;
  end;
  perform set_config('switchboard.verify_result', v_result::text, true);
end;
$$;

select current_setting('switchboard.verify_result')::jsonb as result;
