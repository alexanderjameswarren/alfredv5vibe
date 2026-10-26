-- Overwatch Step 10 cleanup, for Finish. Deletes the live test intention "OW Test close done" (mvmwqau76q5bx129p2),
-- the execution and event its close created, and its activity row. Nothing else. Its item, if it has one, is kept and
-- reported. Run as one block; returns what it deleted.
-- supabase/tests/overwatch-q4n/9_cleanup_step10_live_test.sql

begin;

create temporary table ow_gone on commit drop as
select 'activity' as tbl, id::text as id from public.activity
 where target_id = 'mvmwqau76q5bx129p2'
    or source_ref like 'intents:mvmwqau76q5bx129p2:%'
    or source_ref in (select 'execution:' || e.id from public.executions e where e.intent_id = 'mvmwqau76q5bx129p2')
union all select 'executions', id from public.executions where intent_id = 'mvmwqau76q5bx129p2'
union all select 'events', id from public.events where intent_id = 'mvmwqau76q5bx129p2'
union all select 'intents', id from public.intents where id = 'mvmwqau76q5bx129p2' and text = 'OW Test close done'
union all select 'item_kept', item_id from public.intents where id = 'mvmwqau76q5bx129p2' and item_id is not null;

delete from public.activity   where id::text in (select id from ow_gone where tbl = 'activity');
delete from public.executions where id in (select id from ow_gone where tbl = 'executions');
delete from public.events     where id in (select id from ow_gone where tbl = 'events');
delete from public.intents    where id in (select id from ow_gone where tbl = 'intents');

select json_build_object(
  'deleted', (select coalesce(json_agg(t), '[]'::json) from (
      select tbl, count(*) as rows from ow_gone where tbl <> 'item_kept' group by tbl order by tbl) t),
  'item_kept', (select id from ow_gone where tbl = 'item_kept'),
  'intention_left', exists (select 1 from public.intents where id = 'mvmwqau76q5bx129p2')
) as result;

commit;
