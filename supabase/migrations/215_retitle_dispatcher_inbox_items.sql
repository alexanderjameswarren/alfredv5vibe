-- Purpose: notification routing step 11b. Retitle the inbox items the dispatcher made under its own job name.
--   deliver_signals used to set source_metadata.task_name to "dispatcher" on an item it made itself, and the card
--   shows task_name as the title. Each such item is retitled by the rule signals.ts now follows, using the signal
--   delivered into it (signals.inbox_id, state delivered):
--     a notification (outcome pop): "Notification: " plus the notification's title;
--     an inbox item: the task's details.item.source_metadata.task_name when it gave one, else the worded title.
--   These items were all made from the worded title, which is the item's first line, so that line is the title;
--   the signal's own title is the fallback. run_date and the other keys are kept. An item with no delivered signal
--   is left alone (there were none on 2026-11-06).
-- Kind: data repair, applied once (one update; 8 rows on 2026-11-06, 6 of them archived)
-- Applied: NO
--
-- Spec: docs/technical-spec-notification_routing-d7v.md section 4.3.
-- Safe to re-run: a retitled item no longer says "dispatcher", so a second run updates nothing.
-- supabase/migrations/215_retitle_dispatcher_inbox_items.sql

update public.inbox i
   set source_metadata = jsonb_set(i.source_metadata, '{task_name}', to_jsonb(t.task_name))
  from (
    select i2.id,
           case when s.outcome = 'pop'
                then 'Notification: ' || coalesce(nullif(split_part(i2.captured_text, E'\n', 1), ''), s.title)
                else coalesce(nullif(s.details -> 'item' -> 'source_metadata' ->> 'task_name', ''),
                              nullif(split_part(i2.captured_text, E'\n', 1), ''), s.title)
           end as task_name
      from public.inbox i2
      join lateral (
        select s1.outcome, s1.title, s1.details
          from public.signals s1
         where s1.inbox_id = i2.id and s1.state = 'delivered'
         order by s1.decided_at nulls last
         limit 1
      ) s on true
     where i2.source_metadata ->> 'task_name' = 'dispatcher'
  ) t
 where i.id = t.id;
