-- Restructure P5 Step 12 follow-up: verify migration 152 (archived_at). Read-only;
-- run whole, paste back the one result cell.
-- Expect: conformant true, failures []; nine columns and nine set_archived_at triggers;
-- per table, archived_missing_date 0 and live_with_date 0; newest_archived shows the
-- latest archives first.
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (
    select * from platform.conformance_failures) t),
  'columns', (select coalesce(json_agg(t), '[]'::json) from (
    select table_name, data_type
      from information_schema.columns
     where table_schema = 'public' and column_name = 'archived_at'
     order by table_name) t),
  'triggers', (select coalesce(json_agg(t), '[]'::json) from (
    select c.relname as table_name, tg.tgenabled
      from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
     where tg.tgname = 'set_archived_at'
     order by c.relname) t),
  'user_triggers_disabled', (select coalesce(json_agg(t), '[]'::json) from (
    select c.relname, tg.tgname
      from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and not tg.tgisinternal and tg.tgenabled = 'D') t),
  'counts', (select coalesce(json_agg(t), '[]'::json) from (
    select 'contexts' as tbl, count(*) filter (where archived is true) as archived,
           count(*) filter (where archived is true and archived_at is null) as archived_missing_date,
           count(*) filter (where archived is not true and archived_at is not null) as live_with_date
      from public.contexts
    union all select 'events', count(*) filter (where archived is true), count(*) filter (where archived is true and archived_at is null), count(*) filter (where archived is not true and archived_at is not null) from public.events
    union all select 'inbox', count(*) filter (where archived is true), count(*) filter (where archived is true and archived_at is null), count(*) filter (where archived is not true and archived_at is not null) from public.inbox
    union all select 'intents', count(*) filter (where archived is true), count(*) filter (where archived is true and archived_at is null), count(*) filter (where archived is not true and archived_at is not null) from public.intents
    union all select 'item_collections', count(*) filter (where archived is true), count(*) filter (where archived is true and archived_at is null), count(*) filter (where archived is not true and archived_at is not null) from public.item_collections
    union all select 'item_groups', count(*) filter (where archived is true), count(*) filter (where archived is true and archived_at is null), count(*) filter (where archived is not true and archived_at is not null) from public.item_groups
    union all select 'items', count(*) filter (where archived is true), count(*) filter (where archived is true and archived_at is null), count(*) filter (where archived is not true and archived_at is not null) from public.items
    union all select 'sam_snippets', count(*) filter (where archived is true), count(*) filter (where archived is true and archived_at is null), count(*) filter (where archived is not true and archived_at is not null) from public.sam_snippets
    union all select 'sam_songs', count(*) filter (where archived is true), count(*) filter (where archived is true and archived_at is null), count(*) filter (where archived is not true and archived_at is not null) from public.sam_songs) t),
  'newest_archived', (select coalesce(json_agg(t), '[]'::json) from (
    select 'items' as tbl, name, archived_at, updated_at from public.items where archived is true
    union all select 'intents', text, archived_at, updated_at from public.intents where archived is true
    union all select 'item_groups', coalesce(name, '(derived)'), archived_at, updated_at from public.item_groups where archived is true
    order by archived_at desc nulls last
    limit 10) t)
) as result;
