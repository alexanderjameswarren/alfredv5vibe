-- Purpose: Restructure P5 Step 16 (restructure_p5-h7m). platform_search_executions (get_execution_history's reader) gains p_item_id: an item's executions, through its intentions or carried in item_ids, so a recipe's cooks inside a menu (no intention, item_ids [recipe]) are found. Each row now also carries intent_id, event_id, group_id and parent_execution_id. A recipe run inside a menu has no event of its own: its event_date is the menu run's event's, so date filters find it too.
-- Kind: schema change (function replaced with one more parameter)
-- Applied: NO
--
-- Run as one block in the SQL editor, then supabase/tests/restructure_p5-h7m/step16_search_executions_verify.sql.
-- Safe to re-run. The 5-argument version is dropped first: with an added defaulted parameter,
-- leaving it would make every 5-argument call ambiguous. The live mcp function calls it with
-- named arguments, all of which the new version still takes, so it keeps working until the
-- step 16 deploy. SECURITY INVOKER, as before: executions RLS stays the only gate.
-- No table change, so conformance is unaffected.

begin;

drop function if exists public.platform_search_executions(text, text, date, date, integer);

create or replace function public.platform_search_executions(
  p_intent_id  text default null,
  p_context_id text default null,
  p_date_from  date default null,
  p_date_to    date default null,
  p_limit      integer default 20,
  p_item_id    text default null)
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  with filtered as (
    select
      x.id                    as execution_id,
      x.intent_id,
      x.event_id,
      x.group_id,
      x.parent_execution_id,
      i.text                  as intent_text,
      i.item_id               as intent_item_id,
      coalesce(ev.time, pev.time) as event_date,
      x.started_at,
      x.closed_at,
      x.status,
      x.outcome,
      x.item_ids,
      x.context_id,
      (select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'created_at', n.created_at)
                                 order by n.created_at), '[]'::jsonb)
         from notes n where n.execution_id = x.id) as notes
      from executions x
      left join intents i     on i.id   = x.intent_id
      left join events  ev    on ev.id  = x.event_id
      left join executions px on px.id  = x.parent_execution_id
      left join events  pev   on pev.id = px.event_id
     where (p_intent_id  is null or x.intent_id  = p_intent_id)
       and (p_context_id is null or x.context_id = p_context_id)
       and (p_item_id    is null or x.item_ids ? p_item_id or i.item_id = p_item_id)
       and (p_date_from is null or (coalesce(ev.time, pev.time) is not null and coalesce(ev.time, pev.time) >= p_date_from))
       and (p_date_to   is null or (coalesce(ev.time, pev.time) is not null and coalesce(ev.time, pev.time) <= p_date_to))
  )
  select jsonb_build_object(
    'rows',
      coalesce(
        (select jsonb_agg(row_to_json(y) order by y.started_at desc nulls last,
                                                  y.execution_id desc)
           from (select * from filtered
                  order by started_at desc nulls last, execution_id desc
                  limit p_limit) y),
        '[]'::jsonb),
    'total',
      (select count(*) from filtered)
  );
$function$;

comment on function public.platform_search_executions(text, text, date, date, integer, text) is
  'Alfred: get_execution_history''s reader. Filters intent, context, item (Restructure P5: through its intentions or carried in item_ids, so a recipe''s cooks inside a menu are found) and the event DATE RANGE in Postgres before the limit. A recipe run inside a menu has no event: its date is its parent menu run''s event''s. Rows carry intent_id, event_id, group_id and parent_execution_id (P5) and their notes (P2). Returns { rows, total } from one snapshot for an honest truncation note. SECURITY INVOKER on purpose: executions RLS is owner-OR-shared-context and must not be re-implemented here. See migrations 077, 100.';

grant execute on function public.platform_search_executions(text, text, date, date, integer, text) to authenticated, service_role;

commit;
