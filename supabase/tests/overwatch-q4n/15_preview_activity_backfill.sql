-- Overwatch Step 18, preview. Read-only. Builds the rows the activity backfill would insert, with the triggers' own
-- rules and source_refs, and reports counts and samples. Writes nothing. Paste back the single result cell.
--
-- Windows:
--   * trigger-type rows (executions done, items and intentions closed done, Project groups shipped): the 30 days before
--     the first row a trigger ever wrote, so nothing overlaps the live triggers;
--   * CLI reports (one progress row per run tag): the last 30 days up to now, since nothing logs them yet.
-- A Close-pop-up close writes an execution that is created already closed (started_at = closed_at) after the intention
-- closes, so the intention's row wins; a finished session closes the execution first, so the execution's row wins.
-- supabase/tests/overwatch-q4n/15_preview_activity_backfill.sql

with
w as (
  select coalesce((select min(created_at) from public.activity where source = 'trigger'), now()) as go_live
),
win as (select go_live - interval '30 days' as since, go_live from w),
proj as (
  select g.id, g.name, g.context_id from public.item_groups g
    join public.group_types t on t.id = g.group_type_id and t.kind = 'project'
),
ex as (
  select e.*, i.text as i_text, i.tags as i_tags, i.context_id as i_ctx, i.group_id as i_own,
         i.status as i_status, i.closed_reason as i_reason, i.status_changed_at as i_changed, i.id as i_id,
         coalesce(i.item_id, case when jsonb_typeof(e.item_ids) = 'array' then e.item_ids ->> 0 end) as x_item
    from public.executions e
    left join public.intents i on i.id = e.intent_id
   cross join win
   where e.status = 'closed' and e.outcome = 'done' and e.closed_at >= win.since and e.closed_at < win.go_live
),
ex_rows as (
  select x.user_id, x.closed_at as occurred_at, coalesce(x.context_id, x.i_ctx, it.context_id) as context_id,
         (select p.id from proj p
           where p.id = x.group_id
              or p.id in (select m.group_id from public.item_group_members m
                           where m.removed_at is null
                             and ((m.member_type = 'intention' and m.member_id = x.intent_id)
                                  or (m.member_type = 'item' and m.member_id = x.x_item)))
           order by (p.id = x.group_id) desc nulls last limit 1) as group_id,
         'execution'::text as target_type, x.id as target_id, 'done'::text as kind,
         left(coalesce(nullif(x.i_text, ''), nullif(it.name, ''),
                       (select nullif(g.name, '') from public.item_groups g where g.id = x.group_id), 'Execution'), 300) as title,
         'trigger'::text as source, 'execution:' || x.id as source_ref,
         coalesce(nullif(x.i_tags, '{}'), it.tags, '{}') as tags
    from ex x
    left join public.items it on it.id = x.x_item
   where not (x.i_id is not null and x.i_status = 'closed' and x.i_reason = 'done'
              and abs(extract(epoch from (x.i_changed - x.closed_at))) < 600
              and x.started_at is not distinct from x.closed_at)
     and not (x.i_own is not null and exists (select 1 from proj p where p.id = x.i_own))
),
int_rows as (
  select i.user_id, i.status_changed_at as occurred_at, i.context_id,
         (select p.id from proj p join public.item_group_members m on m.group_id = p.id
           where m.removed_at is null and m.member_type = 'intention' and m.member_id = i.id limit 1) as group_id,
         'intention'::text, i.id, 'done'::text, left(coalesce(nullif(i.text, ''), 'Untitled'), 300),
         'trigger'::text, 'intents:' || i.id || ':' || extract(epoch from i.status_changed_at), coalesce(i.tags, '{}')
    from public.intents i cross join win
   where i.status = 'closed' and i.closed_reason = 'done'
     and i.status_changed_at >= win.since and i.status_changed_at < win.go_live
     and not (i.group_id is not null and exists (select 1 from proj p where p.id = i.group_id))
     and not exists (select 1 from public.executions e
                      where e.intent_id = i.id and e.status = 'closed' and e.outcome = 'done'
                        and abs(extract(epoch from (e.closed_at - i.status_changed_at))) < 600
                        and e.started_at is distinct from e.closed_at)
),
item_rows as (
  select it.user_id, it.status_changed_at, it.context_id,
         (select p.id from proj p join public.item_group_members m on m.group_id = p.id
           where m.removed_at is null and m.member_type = 'item' and m.member_id = it.id limit 1),
         'item'::text, it.id, 'done'::text, left(coalesce(nullif(it.name, ''), 'Untitled'), 300),
         'trigger'::text, 'items:' || it.id || ':' || extract(epoch from it.status_changed_at), coalesce(it.tags, '{}')
    from public.items it cross join win
   where it.status = 'closed' and it.closed_reason = 'done'
     and it.status_changed_at >= win.since and it.status_changed_at < win.go_live
     and not exists (select 1 from public.intents i
                      where i.item_id = it.id and i.status = 'closed' and i.closed_reason = 'done'
                        and abs(extract(epoch from (i.status_changed_at - it.status_changed_at))) < 600)
     and not exists (select 1 from public.executions e
                      where e.status = 'closed' and e.outcome = 'done'
                        and abs(extract(epoch from (e.closed_at - it.status_changed_at))) < 600
                        and ((jsonb_typeof(e.item_ids) = 'array' and e.item_ids ? it.id)
                             or e.intent_id in (select i.id from public.intents i where i.item_id = it.id)))
),
group_rows as (
  select g.user_id, g.status_changed_at, g.context_id, g.id, 'group'::text, g.id, 'shipped'::text,
         left(coalesce(nullif(g.name, ''), 'Unnamed project'), 300),
         'trigger'::text, 'item_groups:' || g.id || ':' || extract(epoch from g.status_changed_at), '{}'::text[]
    from public.item_groups g
    join proj p on p.id = g.id
   cross join win
   where g.status = 'closed' and g.closed_reason = 'done'
     and g.status_changed_at >= win.since and g.status_changed_at < win.go_live
),
cli as (
  select c.user_id, c.run_tag, min(c.created_at) as occurred_at,
         (array_agg(regexp_replace(coalesce(c.title, c.run_tag), '^\[[^]]*\]\s*', '') order by c.created_at desc))[1] as title
    from public.clips c
   where c.source = 'cli' and c.run_tag is not null and c.created_at >= now() - interval '30 days'
   group by c.user_id, c.run_tag
),
cli_rows as (
  select c.user_id, c.occurred_at, pg.context_id,
         pp.group_id, 'other'::text, null::text, 'progress'::text, left(coalesce(nullif(c.title, ''), c.run_tag), 300),
         'cli'::text, c.run_tag, '{}'::text[]
    from cli c
    left join public.project_plans pp
      on pp.project_code is not null and c.run_tag ~ ('^' || pp.project_code || '-s[0-9]+[a-z]?-[a-z0-9]{4}$')
    left join public.item_groups pg on pg.id = pp.group_id
),
candidates as (
  select r.*, coalesce((select ctx.app_id from public.contexts ctx where ctx.id = r.context_id), 'alfred') as app_id
    from (
      select * from ex_rows
      union all select * from int_rows
      union all select * from item_rows
      union all select * from group_rows
      union all select * from cli_rows
    ) r
),
marked as (
  select c.*, exists (select 1 from public.activity a
                       where a.user_id = c.user_id and a.source = c.source and a.source_ref = c.source_ref) as already_present
    from candidates c
)
select json_build_object(
  'window', (select json_build_object('trigger_rows_from', since, 'trigger_rows_until', go_live,
                                      'cli_rows_from', now() - interval '30 days') from win),
  'would_insert_by_kind_app_source', (select coalesce(json_agg(t), '[]'::json) from (
      select kind, app_id, source, count(*) as rows from marked where not already_present
       group by 1, 2, 3 order by 3, 1, 2) t),
  'already_present', (select count(*) from marked where already_present),
  'would_insert_total', (select count(*) from marked where not already_present),
  'with_group', (select count(*) from marked where not already_present and group_id is not null),
  'samples', (select coalesce(json_agg(t), '[]'::json) from (
      select occurred_at, app_id, kind, source, target_type, title, source_ref, tags, group_id
        from (select m.*, row_number() over (partition by source, kind order by occurred_at desc) as n
                from marked m where not already_present) s
       where n <= 2 order by source, kind, occurred_at desc limit 5) t)
) as result;
