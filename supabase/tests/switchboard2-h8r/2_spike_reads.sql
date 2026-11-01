-- Switchboard 2.0 step 2.10, the spike, second design: the CALLER sets read-only and the limits, with no query function.
-- Queued through the runner. The inner block always ends in an error of its own, so everything it made rolls back,
-- on a dry run and on Approve alike; only the result survives, in a transaction-local setting read by the last line.
--
-- The first line is its own command on purpose. Postgres arms statement_timeout when a command starts, so only a
-- caller's earlier command can arm it for the query. Here that command is the block, so the 10s runs from the block's
-- start, and it fires once.
--
-- spike_ask stands in for the 2.11 tool: read only, role, limits and claims set by the caller, one statement, always
-- undone. The tool would send the statement as its own command, by the extended protocol; here a cursor gives the
-- same one-statement rule. It never reports a row's contents from a table: counts and error text only.
--
-- Result: all_passed, failed (names), checks ({name: {pass, detail}}), and stopped_at if setup itself failed.
-- A failed check is a finding about the design, not a failed script.
-- supabase/tests/switchboard2-h8r/2_spike_reads.sql

set local statement_timeout = '10s';

do $spike$
declare
  c_alex  constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_other constant uuid := '00000000-0000-4000-8000-000000000001';
  v jsonb := '{}'::jsonb;
  v_stage text := 'start';
  a jsonb;
  v_took numeric;
  v_cols text;
  v_secret jsonb;
  v_text text;
begin
  begin
    create function pg_temp.spike_check(p_name text, p_pass boolean, p_detail text default null) returns jsonb
      language sql as $f$ select jsonb_build_object(p_name, jsonb_build_object('pass', coalesce(p_pass, false), 'detail', p_detail)) $f$;

    create function pg_temp.spike_ask(p_user uuid, p_sql text) returns jsonb
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
          raise exception 'SPIKE_ASK_DONE';
        exception when others or query_canceled then
          -- Undoes read only, the role, the claims and anything the query set: the caller's rollback.
          if sqlerrm <> 'SPIKE_ASK_DONE' then
            v_code := sqlstate;
            v_error := sqlerrm;
          end if;
        end;
        if v_code is not null then
          return jsonb_build_object('ok', false, 'code', v_code, 'error', v_error);
        end if;
        return jsonb_build_object('ok', true, 'result', jsonb_build_object('rows', v_rows, 'count', v_count, 'truncated', v_truncated));
      end $f$;

    create function pg_temp.spike_one(p_answer jsonb, p_key text) returns text
      language sql as $f$ select p_answer #>> array['result', 'rows', '0', p_key] $f$;

    -- Setup: anything that fails here is reported by name, and tells us the real migration has the same problem.
    v_stage := 'create role claude_reader';
    create role claude_reader nologin noinherit;
    v_stage := 'let this session take the role';
    grant claude_reader to current_user;
    v_stage := 'schema usage on public';
    grant usage on schema public to claude_reader;
    v_stage := 'schema usage on auth, for auth.uid()';
    grant usage on schema auth to claude_reader;
    v_stage := 'execute on auth.uid()';
    grant execute on function auth.uid() to claude_reader;
    v_stage := 'checks';

    -- First, while the 10s armed by the command before this block is still running. The query also tries to lift the
    -- timeout: a timer that fires anyway answers both questions.
    a := pg_temp.spike_ask(c_alex, 'select set_config(''statement_timeout'', ''0'', true) as lifted, pg_sleep(11)::text as slept');
    v_took := round(extract(epoch from clock_timestamp() - statement_timestamp())::numeric, 1);
    v := v || pg_temp.spike_check('timeout_really_fires_at_10s', a ->> 'code' = '57014' and v_took between 9.5 and 10.9,
      'block ran ' || v_took || 's: ' || coalesce(a ->> 'error', 'it ran to the end, so the timeout did not fire'));
    v := v || pg_temp.spike_check('timeout_cannot_be_lifted_from_inside_a_query', a ->> 'code' = '57014',
      coalesce(a ->> 'error', 'the query lifted it and slept to the end'));

    -- Who is asking.
    a := pg_temp.spike_ask(c_alex, 'select current_user::text as who, session_user::text as sess, 1 as n');
    v := v || pg_temp.spike_check('alex_gets_an_answer', pg_temp.spike_one(a, 'n') = '1', a ->> 'error');
    v := v || pg_temp.spike_check('runs_as_claude_reader', pg_temp.spike_one(a, 'who') = 'claude_reader', pg_temp.spike_one(a, 'who'));
    v := v || pg_temp.spike_check('session_user_is_not_claude_reader_under_set_role', pg_temp.spike_one(a, 'sess') <> 'claude_reader',
      'session user: ' || pg_temp.spike_one(a, 'sess'));

    -- One statement, reading only.
    a := pg_temp.spike_ask(c_alex, 'select 1 as a; select 2 as b');
    v := v || pg_temp.spike_check('two_statements_refused', (a ->> 'ok')::boolean = false, a ->> 'error');
    a := pg_temp.spike_ask(c_alex, 'delete from public.switchboard_settings where false');
    v := v || pg_temp.spike_check('plain_write_refused', (a ->> 'ok')::boolean = false, a ->> 'error');
    a := pg_temp.spike_ask(c_alex, 'with d as (delete from public.switchboard_settings where false returning 1) select * from d');
    v := v || pg_temp.spike_check('write_inside_a_select_refused', (a ->> 'ok')::boolean = false, a ->> 'error');
    a := pg_temp.spike_ask(c_alex, 'select 1 as n into pg_temp.spike_copy');
    v := v || pg_temp.spike_check('select_into_refused', (a ->> 'ok')::boolean = false, a ->> 'error');
    a := pg_temp.spike_ask(c_alex, 'select current_setting(''transaction_read_only'') as ro, current_setting(''lock_timeout'') as lt');
    v := v || pg_temp.spike_check('read_only_is_on', pg_temp.spike_one(a, 'ro') = 'on', coalesce(a ->> 'error', pg_temp.spike_one(a, 'ro')));
    v := v || pg_temp.spike_check('lock_wait_value_is_1s', pg_temp.spike_one(a, 'lt') = '1s', coalesce(a ->> 'error', pg_temp.spike_one(a, 'lt')));
    a := pg_temp.spike_ask(c_alex, 'select set_config(''transaction_read_only'', ''off'', true) as ro');
    v := v || pg_temp.spike_check('read_only_cannot_be_switched_off', (a ->> 'ok')::boolean = false, coalesce(a ->> 'error', pg_temp.spike_one(a, 'ro')));

    -- The row cap: the caller's job, by fetching no more than it wants.
    a := pg_temp.spike_ask(c_alex, 'select g from generate_series(1, 2000) g');
    v := v || pg_temp.spike_check('capped_at_1000_rows_and_says_so',
      (a #>> '{result,count}')::integer = 1000 and (a #>> '{result,truncated}')::boolean,
      coalesce(a ->> 'error', a #>> '{result,count}'));

    -- Other schemas and powerful functions.
    a := pg_temp.spike_ask(c_alex, 'select count(*) as n from auth.users');
    v := v || pg_temp.spike_check('auth_users_refused', a ->> 'code' = '42501', a ->> 'error');
    a := pg_temp.spike_ask(c_alex, 'select count(*) as n from auth.sessions');
    v := v || pg_temp.spike_check('auth_sessions_refused', a ->> 'code' = '42501', a ->> 'error');
    a := pg_temp.spike_ask(c_alex, 'select count(*) as n from vault.secrets');
    v := v || pg_temp.spike_check('vault_secrets_refused', (a ->> 'ok')::boolean = false, a ->> 'error');
    a := pg_temp.spike_ask(c_alex, 'select count(*) as n from vault.decrypted_secrets');
    v := v || pg_temp.spike_check('vault_decrypted_refused', (a ->> 'ok')::boolean = false, a ->> 'error');
    a := pg_temp.spike_ask(c_alex, 'select count(*) as n from platform.registry');
    v := v || pg_temp.spike_check('platform_schema_refused', (a ->> 'ok')::boolean = false, a ->> 'error');
    a := pg_temp.spike_ask(c_alex, 'select count(*) as n from pg_authid');
    v := v || pg_temp.spike_check('pg_authid_refused', a ->> 'code' = '42501', a ->> 'error');
    a := pg_temp.spike_ask(c_alex, 'select public.platform_read_settings() as s');
    v := v || pg_temp.spike_check('other_definer_functions_refused', a ->> 'code' = '42501', a ->> 'error');
    a := pg_temp.spike_ask(c_alex, 'select query_to_xml(''select count(*) as n from auth.users'', false, false, '''')::text as x');
    v := v || pg_temp.spike_check('query_to_xml_gets_no_further', (a ->> 'ok')::boolean = false, a ->> 'error');

    -- SET ROLE is judged against the session user, and under this design that is the runner's own login.
    a := pg_temp.spike_ask(c_alex, format('select set_config(''role'', %L, true) as r, current_user::text as who', session_user));
    v := v || pg_temp.spike_check('role_cannot_be_raised_from_inside_a_query', (a ->> 'ok')::boolean = false,
      coalesce(a ->> 'error', 'set_config accepted it; current_user then: ' || pg_temp.spike_one(a, 'who')));
    a := pg_temp.spike_ask(c_alex, format(
      'select (select set_config(''role'', %L, true)) as r, length(query_to_xml(''select count(*) as n from auth.users'', false, false, '''')::text) as got',
      session_user));
    v := v || pg_temp.spike_check('role_raise_cannot_reach_auth_users', (a ->> 'ok')::boolean = false,
      coalesce(a ->> 'error', 'it reached auth.users: the 2.11 tool must not connect as a login that can take any role'));

    -- A real table before any policy for claude_reader: the existing policies are TO authenticated.
    v_stage := 'column grants from platform_read_settings';
    select string_agg(format('%I', col ->> 'name'), ', '), s -> 'secret_columns'
      into v_cols, v_secret
      from jsonb_array_elements(public.platform_read_settings('switchboard_actions')) s,
           jsonb_array_elements(s -> 'columns') col
     group by s -> 'secret_columns';
    v := v || pg_temp.spike_check('settings_name_link_hash_as_secret', coalesce(v_secret ? 'link_hash', false), v_secret::text);
    execute format('grant select (%s) on public.switchboard_actions to claude_reader', v_cols);
    v_stage := 'checks';
    a := pg_temp.spike_ask(c_alex, 'select count(*) as n from public.switchboard_actions');
    v := v || pg_temp.spike_check('no_rows_without_its_own_policy', pg_temp.spike_one(a, 'n') = '0',
      coalesce(a ->> 'error', pg_temp.spike_one(a, 'n') || ' rows: the real migration must add a policy per table'));

    v_stage := 'policy for claude_reader on switchboard_actions';
    create policy spike_reader on public.switchboard_actions for select to claude_reader using (user_id = auth.uid());
    v_stage := 'checks';
    a := pg_temp.spike_ask(c_alex, 'select count(*) as n from public.switchboard_actions');
    v := v || pg_temp.spike_check('own_rows_seen_with_a_policy', pg_temp.spike_one(a, 'n')::integer > 0, coalesce(a ->> 'error', 'rows seen'));
    a := pg_temp.spike_ask(c_other, 'select count(*) as n from public.switchboard_actions');
    v := v || pg_temp.spike_check('claims_for_another_user_see_none_of_alexs', pg_temp.spike_one(a, 'n') = '0', coalesce(a ->> 'error', pg_temp.spike_one(a, 'n') || ' rows'));
    a := pg_temp.spike_ask(c_alex, 'select link_hash from public.switchboard_actions limit 1');
    v := v || pg_temp.spike_check('secret_column_refused', a ->> 'code' = '42501', a ->> 'error');
    a := pg_temp.spike_ask(c_alex, 'select * from public.switchboard_actions limit 1');
    v := v || pg_temp.spike_check('select_star_refused_where_a_column_is_secret', a ->> 'code' = '42501', a ->> 'error');
    a := pg_temp.spike_ask(c_alex, 'select id, status from public.switchboard_actions limit 1');
    v := v || pg_temp.spike_check('other_columns_allowed', (a ->> 'ok')::boolean, a ->> 'error');

    -- Another user's rows. A table with no key to auth.users, because no second real user exists to own a row.
    v_stage := 'throwaway table with two users'' rows';
    create table public.switchboard_read_log (id bigint generated always as identity primary key, user_id uuid not null, note text);
    alter table public.switchboard_read_log enable row level security;
    insert into public.switchboard_read_log (user_id, note) values (c_alex, 'mine'), (c_other, 'theirs');
    execute 'grant select (id, user_id, note) on public.switchboard_read_log to claude_reader';
    create policy spike_reader on public.switchboard_read_log for select to claude_reader using (user_id = auth.uid());
    v_stage := 'checks';
    a := pg_temp.spike_ask(c_alex, 'select count(*) as n, count(*) filter (where note = ''theirs'') as theirs from public.switchboard_read_log');
    v := v || pg_temp.spike_check('another_users_rows_invisible', pg_temp.spike_one(a, 'n') = '1' and pg_temp.spike_one(a, 'theirs') = '0',
      coalesce(a ->> 'error', pg_temp.spike_one(a, 'n') || ' seen, ' || pg_temp.spike_one(a, 'theirs') || ' theirs'));

    -- Can a query change who it is? set_config is open to every role, and these policies read the claims.
    v_text := format(
      'with f as materialized (select set_config(''request.jwt.claims'', %L, true) as c) select count(*) filter (where l.note = ''theirs'') as theirs from f, lateral (select * from public.switchboard_read_log offset 0) l where f.c is not null',
      json_build_object('sub', c_other, 'role', 'authenticated')::text);
    a := pg_temp.spike_ask(c_alex, v_text);
    v := v || pg_temp.spike_check('identity_cannot_be_forged_from_inside_a_query', pg_temp.spike_one(a, 'theirs') = '0' or (a ->> 'ok')::boolean = false,
      coalesce(a ->> 'error', pg_temp.spike_one(a, 'theirs') || ' of another user''s rows seen'));

    -- The alternative, if that fails: a policy naming Alex's id, which reads no claims and needs nothing from auth.
    v_stage := 'policy naming the user, and no usage on auth';
    drop policy spike_reader on public.switchboard_read_log;
    execute format('create policy spike_reader on public.switchboard_read_log for select to claude_reader using (user_id = %L::uuid)', c_alex);
    revoke execute on function auth.uid() from claude_reader;
    revoke usage on schema auth from claude_reader;
    v_stage := 'checks';
    a := pg_temp.spike_ask(c_alex, v_text);
    v := v || pg_temp.spike_check('fixed_user_policy_ignores_forged_claims', pg_temp.spike_one(a, 'theirs') = '0', coalesce(a ->> 'error', pg_temp.spike_one(a, 'theirs') || ' of another user''s rows seen'));
    a := pg_temp.spike_ask(c_alex, 'select count(*) as n from auth.users');
    v := v || pg_temp.spike_check('fixed_user_policy_refuses_the_whole_auth_schema', a ->> 'code' = '42501', a ->> 'error');
    a := pg_temp.spike_ask(c_alex, 'select count(*) as n from public.switchboard_read_log');
    v := v || pg_temp.spike_check('fixed_user_policy_still_shows_own_rows', pg_temp.spike_one(a, 'n') = '1', coalesce(a ->> 'error', pg_temp.spike_one(a, 'n')));

    v_stage := 'done';
    raise exception 'SPIKE_ROLLBACK';
  exception when others or query_canceled then
    -- Everything in the block above is gone now. `v` is a local variable, so it stays.
    if sqlerrm <> 'SPIKE_ROLLBACK' then
      v := v || jsonb_build_object('stopped_at', jsonb_build_object('pass', false, 'detail', v_stage || ': ' || sqlstate || ' ' || sqlerrm));
    end if;
  end;
  perform set_config('switchboard.spike_result', jsonb_build_object(
    'rolled_back', to_regrole('claude_reader') is null and to_regclass('public.switchboard_read_log') is null,
    'all_passed', not exists (select 1 from jsonb_each(v) e where not (e.value ->> 'pass')::boolean),
    'failed', (select coalesce(jsonb_agg(e.key), '[]'::jsonb) from jsonb_each(v) e where not (e.value ->> 'pass')::boolean),
    'checks', v)::text, true);
end
$spike$;

select current_setting('switchboard.spike_result')::jsonb as result;
