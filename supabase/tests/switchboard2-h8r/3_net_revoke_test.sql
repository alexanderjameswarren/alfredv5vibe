-- Switchboard 2.0 step 2.11: can this role close the net schema? Queued through the runner. A block tries the revokes and
-- the grants back, reads the privileges afterwards, then undoes itself, on a dry run and on Approve alike.
--
-- net's grants were made by supabase_admin. A revoke by anyone else can do nothing and say only a warning, so what
-- counts is the privileges read afterwards, in `after`, not whether the statement ran.
-- Result: one row. `answer` says whether claude_reader was shut out; `steps` is each statement's outcome; `would_lose`
-- lists scheduled jobs and functions that use net and whose owner would no longer reach it. No URLs or job text.
-- supabase/tests/switchboard2-h8r/3_net_revoke_test.sql

do $net$
declare
  v_steps jsonb := '{}'::jsonb;
  v_before jsonb;
  v_after jsonb;
  v_lose jsonb := '[]'::jsonb;
  v_uses jsonb;
  v_undone jsonb;
  v_stage text := 'start';
  v_sql text;
begin
  -- What each role can reach in net, tables and functions counted.
  create function pg_temp.net_rights() returns jsonb language sql as $f$
    select jsonb_object_agg(r.rolname, jsonb_build_object(
      'schema_usage', has_schema_privilege(r.rolname, 'net', 'usage'),
      'tables_selectable', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                             where n.nspname = 'net' and c.relkind in ('r', 'p', 'v') and has_table_privilege(r.rolname, c.oid, 'select')),
      'tables_writable', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname = 'net' and c.relkind in ('r', 'p', 'v') and has_table_privilege(r.rolname, c.oid, 'insert')),
      'functions_callable', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                              where n.nspname = 'net' and has_function_privilege(r.rolname, p.oid, 'execute'))))
      from pg_roles r
     where r.rolname in ('claude_reader', 'anon', 'authenticated', 'postgres', 'service_role', 'supabase_functions_admin')
  $f$;

  v_before := pg_temp.net_rights();

  begin
    foreach v_sql in array array[
      'revoke usage on schema net from public',
      'revoke usage on schema net from anon',
      'revoke usage on schema net from authenticated',
      'revoke all on all tables in schema net from public',
      'revoke all on all tables in schema net from anon',
      'revoke all on all tables in schema net from authenticated',
      'revoke all on all functions in schema net from public',
      'revoke all on all functions in schema net from anon',
      'revoke all on all functions in schema net from authenticated',
      'grant usage on schema net to postgres',
      'grant usage on schema net to service_role',
      'grant usage on schema net to supabase_functions_admin',
      'grant all on all tables in schema net to postgres',
      'grant all on all tables in schema net to service_role',
      'grant all on all tables in schema net to supabase_functions_admin',
      'grant execute on all functions in schema net to postgres',
      'grant execute on all functions in schema net to service_role',
      'grant execute on all functions in schema net to supabase_functions_admin'
    ] loop
      begin
        execute v_sql;
        v_steps := v_steps || jsonb_build_object(v_sql, 'ran');
      exception when others then
        v_steps := v_steps || jsonb_build_object(v_sql, sqlstate || ' ' || sqlerrm);
      end;
    end loop;

    v_after := pg_temp.net_rights();

    -- Scheduled jobs that mention net, by job name and login, and whether that login still reaches it.
    v_stage := 'scheduled jobs';
    begin
      execute $q$
        select coalesce(jsonb_agg(jsonb_build_object('job', j.jobname, 'runs_as', j.username, 'active', j.active,
          'still_has_usage', has_schema_privilege(j.username, 'net', 'usage'),
          'still_can_call', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                     where n.nspname = 'net' and p.proname = 'http_post' and has_function_privilege(j.username, p.oid, 'execute')))), '[]'::jsonb)
          from cron.job j where j.command ~* '\mnet\.'
      $q$ into v_lose;
    exception when others then
      v_lose := jsonb_build_array(jsonb_build_object('could_not_read_jobs', sqlstate || ' ' || sqlerrm));
    end;

    -- Functions anywhere outside net whose body mentions it: who owns them, and whether callers keep access.
    v_stage := 'functions using net';
    select coalesce(jsonb_agg(jsonb_build_object('function', p.oid::regprocedure::text, 'owner', pg_get_userbyid(p.proowner), 'definer', p.prosecdef,
        'owner_still_has_usage', has_schema_privilege(p.proowner, 'net', 'usage'))), '[]'::jsonb)
      into v_uses
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname <> 'net' and n.nspname not like 'pg\_%' and p.prosrc ~* '\mnet\.(http_|_http|http_request)';

    v_stage := 'done';
    raise exception 'NET_UNDO';
  exception when others then
    if sqlerrm <> 'NET_UNDO' then
      v_steps := v_steps || jsonb_build_object('stopped_at', v_stage || ': ' || sqlstate || ' ' || sqlerrm);
    end if;
  end;

  -- The block has rolled back: these must match `before`.
  v_undone := pg_temp.net_rights();

  perform set_config('switchboard.net_result', jsonb_build_object(
    'answer', jsonb_build_object(
      'claude_reader_shut_out',
        coalesce((v_after #>> '{claude_reader,schema_usage}')::boolean = false
          and (v_after #>> '{claude_reader,tables_selectable}')::integer = 0
          and (v_after #>> '{claude_reader,functions_callable}')::integer = 0, false),
      'undone', v_undone = v_before),
    'before', v_before,
    'after', v_after,
    'steps', v_steps,
    'scheduled_jobs_using_net', v_lose,
    'functions_using_net', v_uses)::text, true);
end
$net$;

select current_setting('switchboard.net_result')::jsonb as result;
