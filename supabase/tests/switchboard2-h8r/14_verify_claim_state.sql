-- Switchboard 2.0 s87b: verify public.switchboard_claim_state. Run after the claim-state migration, through the queue
-- with --test. Throwaway rows, undone. Result: one row, with all_passed, failed and checks.
-- supabase/tests/switchboard2-h8r/14_verify_claim_state.sql

do $$
declare
  c_alex constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_repo constant text := 'C:\Users\Alex\projects\verify-claim-state';
  t constant text := 'public.switchboard_claim_state';
  v_checks jsonb := '{}'::jsonb;
  v_result jsonb;
begin
  begin
    v_checks := v_checks
      || jsonb_build_object('table_exists', to_regclass(t) is not null)
      || jsonb_build_object('unique_user_repo', exists (
           select 1 from pg_constraint where conname = 'switchboard_claim_state_repo_key' and contype = 'u'))
      || jsonb_build_object('rls_on', (select relrowsecurity from pg_class where oid = to_regclass(t)))
      || jsonb_build_object('registered', exists (select 1 from platform.registry where table_name = t))
      || jsonb_build_object('not_audited', (select not audited from platform.registry where table_name = t))
      || jsonb_build_object('anon_no_select', not has_table_privilege('anon', t, 'select'))
      || jsonb_build_object('anon_no_insert', not has_table_privilege('anon', t, 'insert'))
      || jsonb_build_object('authenticated_select', has_table_privilege('authenticated', t, 'select'))
      || jsonb_build_object('service_role_insert', has_table_privilege('service_role', t, 'insert'))
      || jsonb_build_object('every_column_commented', not exists (
           select 1 from pg_attribute a
            where a.attrelid = to_regclass(t) and a.attnum > 0 and not a.attisdropped
              and col_description(a.attrelid, a.attnum) is null))
      || jsonb_build_object('no_conformance_failures', not exists (
           select 1 from platform.conformance_failures where table_name::text = t));

    -- An upsert replaces the row rather than adding one.
    insert into public.switchboard_claim_state (user_id, repo, claims, blocks, posted_at, source_host)
    values (c_alex, c_repo, '[{"item":"a.js","owner":"p-a1","kind":"file","claimed_at":"2026-11-10T00:00:00Z"}]', '[]', now() - interval '1 minute', 'TEST')
    on conflict (user_id, repo) do update set claims = excluded.claims, blocks = excluded.blocks,
      posted_at = excluded.posted_at, source_host = excluded.source_host, updated_at = now();
    insert into public.switchboard_claim_state (user_id, repo, claims, blocks, posted_at, source_host)
    values (c_alex, c_repo, '[]', '[{"waiter":"p-b2","holder":"p-a1","item":"a.js","since":"2026-11-10T00:00:00Z"}]', now(), 'TEST')
    on conflict (user_id, repo) do update set claims = excluded.claims, blocks = excluded.blocks,
      posted_at = excluded.posted_at, source_host = excluded.source_host, updated_at = now();
    v_checks := v_checks
      || jsonb_build_object('upsert_one_row', (select count(*) = 1 from public.switchboard_claim_state where user_id = c_alex and repo = c_repo))
      || jsonb_build_object('upsert_replaced_claims', (select claims = '[]'::jsonb from public.switchboard_claim_state where user_id = c_alex and repo = c_repo))
      || jsonb_build_object('upsert_replaced_blocks', (select jsonb_array_length(blocks) = 1 from public.switchboard_claim_state where user_id = c_alex and repo = c_repo));

    -- The shape checks hold.
    begin
      insert into public.switchboard_claim_state (user_id, repo, claims, posted_at) values (c_alex, c_repo || '2', '{}', now());
      v_checks := v_checks || jsonb_build_object('claims_must_be_array', false);
    exception when check_violation then
      v_checks := v_checks || jsonb_build_object('claims_must_be_array', true);
    end;

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
