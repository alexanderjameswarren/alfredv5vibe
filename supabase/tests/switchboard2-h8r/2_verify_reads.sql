-- Switchboard 2.0 step 2.10: verify the reads migration. Queue it after the migration has run. A block undoes everything
-- it did, on a dry run and on Approve alike; the result is the last line's one row.
--
-- The migration gave the session no way into claude_reader, so the block grants itself one, for the length of the block.
-- This session can therefore still raise its role, which the real login can't: role raising is checked here from the
-- catalog, and by a real login once the password is set (2.11). Counts and error text only, never a row's contents.
-- Result: all_passed, failed (names), checks ({name: {pass, detail}}), and stopped_at if setup failed.
-- supabase/tests/switchboard2-h8r/2_verify_reads.sql

set local statement_timeout = '10s';

do $verify$
declare
  c_alex  constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_other constant uuid := '00000000-0000-4000-8000-000000000001';
  v jsonb := '{}'::jsonb;
  v_stage text := 'start';
  a jsonb;
  v_took numeric;
  v_text text;
  v_bad text;
  v_forged text;
begin
  begin
    create function pg_temp.check_one(p_name text, p_pass boolean, p_detail text default null) returns jsonb
      language sql as $f$ select jsonb_build_object(p_name, jsonb_build_object('pass', coalesce(p_pass, false), 'detail', p_detail)) $f$;

    -- Stands in for the 2.11 tool: read only, role, limits and claims set by the caller, one statement, always undone.
    create function pg_temp.ask(p_user uuid, p_sql text) returns jsonb
      language plpgsql as $f$
      declare
        c refcursor;
        r record;
        v_rows jsonb := '[]'::jsonb;
        v_count integer := 0;
        v_truncated boolean := false;
        v_code text;
        v_error text;
      begin
        begin
          perform set_config('transaction_read_only', 'on', true);
          perform set_config('lock_timeout', '1s', true);
          perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
          perform set_config('role', 'claude_reader', true);
          open c for execute p_sql;
          loop
            fetch c into r;
            exit when not found;
            if v_count = 1000 then
              v_truncated := true;
              exit;
            end if;
            v_rows := v_rows || to_jsonb(r);
            v_count := v_count + 1;
          end loop;
          close c;
          raise exception 'ASK_DONE';
        exception when others or query_canceled then
          if sqlerrm <> 'ASK_DONE' then
            v_code := sqlstate;
            v_error := sqlerrm;
          end if;
        end;
        if v_code is not null then
          return jsonb_build_object('ok', false, 'code', v_code, 'error', v_error);
        end if;
        return jsonb_build_object('ok', true, 'result', jsonb_build_object('rows', v_rows, 'count', v_count, 'truncated', v_truncated));
      end $f$;

    create function pg_temp.one(p_answer jsonb, p_key text) returns text
      language sql as $f$ select p_answer #>> array['result', 'rows', '0', p_key] $f$;

    -- The role, from the catalog, before this block touches it.
    select rolcanlogin and not rolinherit and not rolsuper and not rolcreaterole and not rolcreatedb and not rolreplication and not rolbypassrls
      into v_text from pg_roles where rolname = 'claude_reader';
    v := v || pg_temp.check_one('role_is_a_plain_login', v_text::boolean, v_text);
    select string_agg(g.roleid::regrole::text, ', ') into v_bad
      from pg_auth_members g where g.member = 'claude_reader'::regrole;
    v := v || pg_temp.check_one('role_is_a_member_of_nothing', v_bad is null, v_bad);
    select string_agg(rolname, ', ') into v_bad
      from pg_roles where rolname <> 'claude_reader' and rolname not like 'pg\_%' and pg_has_role('claude_reader', oid, 'member');
    v := v || pg_temp.check_one('role_can_take_no_other_role', v_bad is null, v_bad);
    select rolconfig::text into v_text from pg_roles where rolname = 'claude_reader';
    v := v || pg_temp.check_one('role_defaults_to_read_only_and_limits',
      v_text like '%default_transaction_read_only=on%' and v_text like '%statement_timeout=10s%' and v_text like '%lock_timeout=1s%', v_text);

    -- What it can reach, whichever query it tries.
    select string_agg(nspname, ', ') into v_bad
      from pg_namespace
     where nspname not in ('public', 'pg_catalog', 'information_schema') and nspname not like 'pg\_%'
       and has_schema_privilege('claude_reader', oid, 'usage');
    v := v || pg_temp.check_one('no_schema_but_public', v_bad is null, v_bad);
    select string_agg(p.oid::regprocedure::text, ', ') into v_bad
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef and has_function_privilege('claude_reader', p.oid, 'execute');
    v := v || pg_temp.check_one('no_definer_function_in_public_can_be_called', v_bad is null, v_bad);

    v_stage := 'let this session take the role, for this block';
    grant claude_reader to current_user;
    v_stage := 'checks';

    -- First, while the 10s armed by the command before this block is running. The query also tries to lift it.
    a := pg_temp.ask(c_alex, 'select set_config(''statement_timeout'', ''0'', true) as lifted, pg_sleep(11)::text as slept');
    v_took := round(extract(epoch from clock_timestamp() - statement_timestamp())::numeric, 1);
    v := v || pg_temp.check_one('caller_timeout_fires_at_10s', a ->> 'code' = '57014' and v_took between 9.5 and 10.9,
      'block ran ' || v_took || 's: ' || coalesce(a ->> 'error', 'it ran to the end'));
    v := v || pg_temp.check_one('timeout_cannot_be_lifted_from_a_query', a ->> 'code' = '57014', coalesce(a ->> 'error', 'it slept to the end'));

    a := pg_temp.ask(c_alex, 'select current_user::text as who, current_setting(''transaction_read_only'') as ro, current_setting(''lock_timeout'') as lt');
    v := v || pg_temp.check_one('runs_as_claude_reader', pg_temp.one(a, 'who') = 'claude_reader', coalesce(a ->> 'error', pg_temp.one(a, 'who')));
    v := v || pg_temp.check_one('caller_read_only_is_on', pg_temp.one(a, 'ro') = 'on', pg_temp.one(a, 'ro'));
    v := v || pg_temp.check_one('caller_lock_wait_is_1s', pg_temp.one(a, 'lt') = '1s', pg_temp.one(a, 'lt'));
    a := pg_temp.ask(c_alex, 'select set_config(''transaction_read_only'', ''off'', true) as ro');
    v := v || pg_temp.check_one('read_only_cannot_be_switched_off', (a ->> 'ok')::boolean = false, coalesce(a ->> 'error', pg_temp.one(a, 'ro')));
    a := pg_temp.ask(c_alex, 'delete from public.switchboard_settings where false');
    v := v || pg_temp.check_one('plain_write_refused', (a ->> 'ok')::boolean = false, a ->> 'error');
    a := pg_temp.ask(c_alex, 'with d as (delete from public.switchboard_settings where false returning 1) select * from d');
    v := v || pg_temp.check_one('write_inside_a_select_refused', (a ->> 'ok')::boolean = false, a ->> 'error');
    a := pg_temp.ask(c_alex, 'select 1 as a; select 2 as b');
    v := v || pg_temp.check_one('two_statements_refused', (a ->> 'ok')::boolean = false, a ->> 'error');
    a := pg_temp.ask(c_alex, 'select g from generate_series(1, 2000) g');
    v := v || pg_temp.check_one('capped_at_1000_rows_and_says_so', (a #>> '{result,count}')::integer = 1000 and (a #>> '{result,truncated}')::boolean, coalesce(a ->> 'error', a #>> '{result,count}'));

    -- Refused schemas and catalog secrets.
    foreach v_text in array array['auth.users', 'auth.sessions', 'vault.secrets', 'vault.decrypted_secrets', 'platform.registry', 'pg_authid'] loop
      a := pg_temp.ask(c_alex, format('select count(*) as n from %s', v_text));
      v := v || pg_temp.check_one(replace(v_text, '.', '_') || '_refused', a ->> 'code' = '42501' or a ->> 'code' = '42P01', a ->> 'error');
    end loop;
    a := pg_temp.ask(c_alex, 'select query_to_xml(''select count(*) as n from auth.users'', false, false, '''')::text as x');
    v := v || pg_temp.check_one('query_to_xml_gets_no_further', (a ->> 'ok')::boolean = false, a ->> 'error');
    a := pg_temp.ask(c_alex, 'select public.platform_read_settings() as s');
    v := v || pg_temp.check_one('platform_read_settings_refused', a ->> 'code' = '42501', a ->> 'error');

    -- Columns.
    a := pg_temp.ask(c_alex, 'select link_hash from public.switchboard_actions limit 1');
    v := v || pg_temp.check_one('secret_column_refused', a ->> 'code' = '42501', a ->> 'error');
    a := pg_temp.ask(c_alex, 'select * from public.switchboard_actions limit 1');
    v := v || pg_temp.check_one('select_star_refused_where_a_column_is_secret', a ->> 'code' = '42501', a ->> 'error');
    a := pg_temp.ask(c_alex, 'select count(*) as n from public.switchboard_actions');
    v := v || pg_temp.check_one('own_rows_seen', pg_temp.one(a, 'n')::integer > 0, coalesce(a ->> 'error', 'rows seen'));
    a := pg_temp.ask(c_alex, 'select reads_enabled from public.switchboard_settings');
    v := v || pg_temp.check_one('kill_switch_readable', (a #>> '{result,count}')::integer = 1, coalesce(a ->> 'error', a #>> '{result,count}'));

    -- Another user's rows, and forged claims: the log, freed of its key to auth.users for this block only.
    v_stage := 'a row for another user';
    execute 'alter table public.switchboard_read_log drop constraint switchboard_read_log_user_id_fkey';
    insert into public.switchboard_read_log (user_id, query_text, ok) values (c_alex, 'mine', true), (c_other, 'theirs', true);
    v_stage := 'checks';
    a := pg_temp.ask(c_alex, 'select count(*) as n, count(*) filter (where query_text = ''theirs'') as theirs from public.switchboard_read_log');
    v := v || pg_temp.check_one('another_users_rows_invisible', pg_temp.one(a, 'theirs') = '0' and pg_temp.one(a, 'n')::integer >= 1,
      coalesce(a ->> 'error', pg_temp.one(a, 'n') || ' seen, ' || pg_temp.one(a, 'theirs') || ' theirs'));
    a := pg_temp.ask(c_other, 'select count(*) filter (where query_text = ''theirs'') as theirs, count(*) filter (where query_text = ''mine'') as mine from public.switchboard_read_log');
    v := v || pg_temp.check_one('claims_change_nothing', pg_temp.one(a, 'theirs') = '0' and pg_temp.one(a, 'mine') = '1', coalesce(a ->> 'error', pg_temp.one(a, 'theirs') || ' theirs, ' || pg_temp.one(a, 'mine') || ' mine'));
    v_forged := format(
      'with f as materialized (select set_config(''request.jwt.claims'', %L, true) as c) select count(*) filter (where l.query_text = ''theirs'') as theirs from f, lateral (select * from public.switchboard_read_log offset 0) l where f.c is not null',
      json_build_object('sub', c_other, 'role', 'authenticated')::text);
    a := pg_temp.ask(c_alex, v_forged);
    v := v || pg_temp.check_one('forged_claims_inside_a_query_change_nothing', pg_temp.one(a, 'theirs') = '0', coalesce(a ->> 'error', pg_temp.one(a, 'theirs') || ' theirs'));

    -- The helper keeps new tables and changed lists covered.
    v_stage := 'register a new table';
    create table public.switchboard_verify_new (id uuid primary key default gen_random_uuid(), user_id uuid not null, note text, private_note text);
    comment on table public.switchboard_verify_new is 'Throwaway for this test.';
    perform platform.register_table('public.switchboard_verify_new', p_audited => false, p_secret_columns => array['private_note']);
    v_stage := 'checks';
    a := pg_temp.ask(c_alex, 'select count(*) as n, count(note) as notes from public.switchboard_verify_new');
    v := v || pg_temp.check_one('new_table_covered_by_register_table', pg_temp.one(a, 'n') = '0', coalesce(a ->> 'error', pg_temp.one(a, 'n')));
    v := v || pg_temp.check_one('new_table_secret_column_withheld', not has_column_privilege('claude_reader', 'public.switchboard_verify_new', 'private_note', 'select'));
    v := v || pg_temp.check_one('new_table_has_the_rule_naming_alex', exists (
      select 1 from pg_policy p where p.polrelid = 'public.switchboard_verify_new'::regclass and p.polname = 'claude_reader_read'
        and pg_get_expr(p.polqual, p.polrelid) like '%26f0707f-b586-4a3e-841c-8c313d6ab1e5%' and pg_get_expr(p.polqual, p.polrelid) not like '%auth%'));
    v_stage := 'change its secret list';
    perform platform.set_read_settings('public.switchboard_verify_new', p_secret_columns => array['note']);
    v_stage := 'checks';
    v := v || pg_temp.check_one('set_read_settings_moves_the_grants',
      not has_column_privilege('claude_reader', 'public.switchboard_verify_new', 'note', 'select')
      and has_column_privilege('claude_reader', 'public.switchboard_verify_new', 'private_note', 'select'));
    v_stage := 'hide it';
    perform platform.set_read_settings('public.switchboard_verify_new', p_mcp_read => 'hidden');
    v_stage := 'checks';
    v := v || pg_temp.check_one('hiding_a_table_takes_access_away',
      not has_column_privilege('claude_reader', 'public.switchboard_verify_new', 'private_note', 'select')
      and not exists (select 1 from pg_policy p where p.polrelid = 'public.switchboard_verify_new'::regclass and p.polname = 'claude_reader_read'));

    v_stage := 'done';
    raise exception 'VERIFY_UNDO';
  exception when others or query_canceled then
    -- Everything in the block above is gone now. `v` is a local variable, so it stays.
    if sqlerrm <> 'VERIFY_UNDO' then
      v := v || jsonb_build_object('stopped_at', jsonb_build_object('pass', false, 'detail', v_stage || ': ' || sqlstate || ' ' || sqlerrm));
    end if;
  end;
  perform set_config('switchboard.verify_result', jsonb_build_object(
    'undone', to_regclass('public.switchboard_verify_new') is null,
    'all_passed', not exists (select 1 from jsonb_each(v) e where not (e.value ->> 'pass')::boolean),
    'failed', (select coalesce(jsonb_agg(e.key), '[]'::jsonb) from jsonb_each(v) e where not (e.value ->> 'pass')::boolean),
    'checks', v)::text, true);
end
$verify$;

select current_setting('switchboard.verify_result')::jsonb as result;
