-- Read-only timing for MCP read access S5. Run it whole in the Supabase SQL Editor before and after each search migration
-- (163, then 164), and paste back the single result cell each time.
-- Each query runs 3 times with EXPLAIN ANALYZE as the authenticated user (Alex: the user who owns the most items, set
-- through request.jwt.claims), so row-level security applies exactly as it does for the app and for Claude.
-- Nothing is written: the only object created is a temporary function, which disappears with the session.
-- The search calls use only the five parameters both the old and the new platform_search_items accept.

create or replace function pg_temp.mcp_time(p_label text, p_sql text, p_runs int default 3)
returns jsonb
language plpgsql
as $$
declare
  v_uid   text;
  v_plan  json;
  v_times numeric[] := '{}';
  i       int;
begin
  select user_id::text into v_uid from public.items group by user_id order by count(*) desc limit 1;
  for i in 1..p_runs loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_uid, true);
    execute 'set local role authenticated';
    execute 'explain (analyze, format json) ' || p_sql into v_plan;
    execute 'reset role';
    v_times := v_times || round(((v_plan->0->>'Planning Time')::numeric + (v_plan->0->>'Execution Time')::numeric), 2);
  end loop;
  return jsonb_build_object(
    'query', p_label,
    'min_ms', (select min(t) from unnest(v_times) as t),
    'runs_ms', to_jsonb(v_times),
    'rows', (v_plan->0->'Plan'->>'Actual Rows')::numeric);
end;
$$;

select json_build_object(
  'measured_at', now(),
  'search_function_is_security_definer', (select bool_or(prosecdef) from pg_proc
                                           where proname = 'platform_search_items' and pronamespace = 'public'::regnamespace),
  'user_id_used', (select user_id from public.items group by user_id order by count(*) desc limit 1),
  'timings', json_build_array(
    pg_temp.mcp_time('old search_items: one phrase, name or description',
      $q$select id, name, description, context_id, tags from public.items
          where archived = false and (name ilike '%style consistency%' or description ilike '%style consistency%')
          order by name limit 20$q$),
    pg_temp.mcp_time('platform_search_items: four words',
      $q$select public.platform_search_items(p_search_text => 'style consistency design contract', p_limit => 20)$q$),
    pg_temp.mcp_time('platform_search_items: one common word',
      $q$select public.platform_search_items(p_search_text => 'recipe', p_limit => 20)$q$),
    -- Added for migration 164: a word that matches few names, so most of the work is the notes arm.
    pg_temp.mcp_time('platform_search_items: two words, mostly notes',
      $q$select public.platform_search_items(p_search_text => 'called plumber', p_limit => 20)$q$),
    pg_temp.mcp_time('platform_search_items: list, no search (get_items)',
      $q$select public.platform_search_items(p_limit => 20)$q$),
    pg_temp.mcp_time('items page under RLS',
      $q$select id, name, status from public.items where archived = false order by name limit 50$q$),
    pg_temp.mcp_time('intents page under RLS',
      $q$select id, text, status from public.intents where archived = false order by created_at desc limit 50$q$),
    pg_temp.mcp_time('notes text search under RLS',
      $q$select id from public.notes where body ilike '%design%' limit 50$q$),
    pg_temp.mcp_time('executions by item_ids ?',
      $q$select id from public.executions where item_ids ? (select id from public.items limit 1) limit 50$q$)
  )
) as result;
