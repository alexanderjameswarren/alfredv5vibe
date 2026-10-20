-- Inbox atomic (inbox_atomic-q7d): remove the throwaway captures from the app test, and
-- everything they became. Changes data. Open and run the whole file, once, after the test.
--
-- Touches only captures whose text starts "TEST atomic" (any case), and the items,
-- intentions, events, executions, reminders and collection rows made from them. Notes on
-- those intentions and items go with them (their delete triggers). The final query should
-- show every count as 0 under "left_after_cleanup".
-- supabase/tests/inbox_atomic/3_cleanup_app_test.sql

-- The SQL Editor runs the file as one transaction; the summary is the last statement so it shows.
drop table if exists t_caps, t_intents, t_items;
create temp table t_caps as
  select id from public.inbox where captured_text ilike 'TEST atomic%';
create temp table t_intents as
  select id from public.intents where source_inbox_id in (select id from t_caps);
create temp table t_items as
  select id from public.items where source_inbox_id in (select id from t_caps);

delete from public.reminders  where inbox_id in (select id from t_caps) or intent_id in (select id from t_intents);
delete from public.executions where intent_id in (select id from t_intents);
delete from public.events     where source_inbox_id in (select id from t_caps) or intent_id in (select id from t_intents);
delete from public.intents    where id in (select id from t_intents);
delete from public.collection_items where item_id in (select id from t_items);
delete from public.items      where id in (select id from t_items);
delete from public.inbox      where id in (select id from t_caps);

select json_build_object(
  'captures_removed', (select count(*) from t_caps),
  'intentions_removed', (select count(*) from t_intents),
  'items_removed', (select count(*) from t_items),
  'left_after_cleanup', json_build_object(
    'captures', (select count(*) from public.inbox where captured_text ilike 'TEST atomic%'),
    'items', (select count(*) from public.items where name ilike 'TEST atomic%'),
    'intentions', (select count(*) from public.intents where text ilike 'TEST atomic%'))
) as result;
