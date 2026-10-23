-- Restructure P5 Step 17: delete this phase's test data. NOT RUN; Alex runs it by hand.
--
-- PART 1 is read-only: run it alone first and paste back the one result cell. It lists
-- exactly what PART 2 deletes, plus `other_live_groups` (every live group NOT in the set)
-- so hand-made test groups can be added by id before running PART 2.
-- PART 2 deletes, in one transaction. It re-runs the same lookups into temp tables, so
-- what it deletes is what PART 1 listed (re-run PART 1 if anything changed in between).
--
-- In the set: P5 Test Menu (mvk4eyegzxjbl0c7fkg), P5 Test Project (mvk4r9sm8pyfz1ubpkw),
-- groups named "P5 Test Series" and "Test Series"; item P5 Undo test (mvik1grw8l80khd5y7l)
-- and its intentions; the item named "P5 Undo other"; the intention "test intention" in
-- Recipes; the group intentions mvl7i6orkbwhjnk5wb and mvl7loqhty7snitwz8 and every
-- intention of a group in the set; and their executions (menu cooks and their recipe runs
-- included), events, reminders, notes and member rows.
-- Never: Instant Pot Spanish Rice (msxevimvbf9lk6jghk8), Butternut Squash Red Lentil Dal,
-- or the intention "Retire the ai-enrich edge function" (guarded by name and id below).
-- Deleting a recipe run lets the last_completed triggers recompute the real recipes'
-- dates, which is intended (they were test cooks).

-- ============================================================================
-- PART 1 — preview (read-only). Run alone.
-- ============================================================================
with
  g as (
    select id from public.item_groups
     where id in ('mvk4eyegzxjbl0c7fkg', 'mvk4r9sm8pyfz1ubpkw')
        or name in ('P5 Test Series', 'Test Series')),
  i as (
    select id from public.items
     where (id = 'mvik1grw8l80khd5y7l' or name = 'P5 Undo other')
       and id <> 'msxevimvbf9lk6jghk8' and name <> 'Butternut Squash Red Lentil Dal'),
  n as (
    select id from public.intents
     where (id in ('mvl7i6orkbwhjnk5wb', 'mvl7loqhty7snitwz8')
            or group_id in (select id from g)
            or item_id in (select id from i)
            or (text = 'test intention' and context_id in (select id from public.contexts where name = 'Recipes')))
       and text is distinct from 'Retire the ai-enrich edge function'),
  x as (
    select id from public.executions
     where intent_id in (select id from n)
        or group_id in (select id from g)
        or exists (select 1 from i where public.executions.item_ids ? i.id))
select json_build_object(
  'groups', (select coalesce(json_agg(t), '[]'::json) from (
    select ig.id, ig.name, ig.archived, gt.label_singular as type
      from public.item_groups ig left join public.group_types gt on gt.id = ig.group_type_id
     where ig.id in (select id from g) order by ig.name) t),
  'items', (select coalesce(json_agg(t), '[]'::json) from (
    select id, name, status, archived from public.items where id in (select id from i)) t),
  'intentions', (select coalesce(json_agg(t), '[]'::json) from (
    select id, text, group_id, item_id, status, archived from public.intents where id in (select id from n)) t),
  'executions', (select coalesce(json_agg(t), '[]'::json) from (
    select id, intent_id, group_id, parent_execution_id, item_ids, status, outcome, closed_at
      from public.executions where id in (select id from x) order by started_at) t),
  'events', (select coalesce(json_agg(t), '[]'::json) from (
    select id, intent_id, group_id, time, archived from public.events
     where intent_id in (select id from n) or group_id in (select id from g)) t),
  'reminders', (select coalesce(json_agg(t), '[]'::json) from (
    select id, intent_id, state, due_at from public.reminders where intent_id in (select id from n)) t),
  'notes', (select coalesce(json_agg(t), '[]'::json) from (
    select id, target_type, target_id, execution_id, left(body, 60) as body from public.notes
     where execution_id in (select id from x)
        or (target_type = 'group' and target_id in (select id from g))
        or (target_type = 'item' and target_id in (select id from i))
        or (target_type = 'intention' and target_id in (select id from n))) t),
  'member_rows', (select coalesce(json_agg(t), '[]'::json) from (
    select id, group_id, member_type, member_id, removed_at from public.item_group_members
     where group_id in (select id from g)
        or (member_type = 'item' and member_id in (select id from i))
        or (member_type = 'intention' and member_id in (select id from n))) t),
  'protected_untouched', (select coalesce(json_agg(t), '[]'::json) from (
    select 'item' as kind, id, name as label, last_completed_at from public.items
     where id = 'msxevimvbf9lk6jghk8' or name = 'Butternut Squash Red Lentil Dal'
    union all
    select 'intention', id, text, last_completed_at from public.intents where text = 'Retire the ai-enrich edge function') t),
  'other_live_groups', (select coalesce(json_agg(t), '[]'::json) from (
    select ig.id, ig.name, gt.label_singular as type, c.name as context, ig.created_at
      from public.item_groups ig
      left join public.group_types gt on gt.id = ig.group_type_id
      left join public.contexts c on c.id = ig.context_id
     where ig.id not in (select id from g)
     order by ig.created_at) t)
) as result;

-- ============================================================================
-- PART 2 — delete (one transaction). Run alone, after checking PART 1.
-- To add a hand-made group, put its id in the first list below (and in PART 1).
-- ============================================================================
begin;

create temp table p5_g on commit drop as
  select id from public.item_groups
   where id in ('mvk4eyegzxjbl0c7fkg', 'mvk4r9sm8pyfz1ubpkw')
      or name in ('P5 Test Series', 'Test Series');
create temp table p5_i on commit drop as
  select id from public.items
   where (id = 'mvik1grw8l80khd5y7l' or name = 'P5 Undo other')
     and id <> 'msxevimvbf9lk6jghk8' and name <> 'Butternut Squash Red Lentil Dal';
create temp table p5_n on commit drop as
  select id from public.intents
   where (id in ('mvl7i6orkbwhjnk5wb', 'mvl7loqhty7snitwz8')
          or group_id in (select id from p5_g)
          or item_id in (select id from p5_i)
          or (text = 'test intention' and context_id in (select id from public.contexts where name = 'Recipes')))
     and text is distinct from 'Retire the ai-enrich edge function';
create temp table p5_x on commit drop as
  select id from public.executions
   where intent_id in (select id from p5_n)
      or group_id in (select id from p5_g)
      or exists (select 1 from p5_i where public.executions.item_ids ? p5_i.id);

-- Notes first (execution notes would cascade, record notes are deleted by trigger; explicit is clearer).
delete from public.notes
 where execution_id in (select id from p5_x)
    or (target_type = 'group' and target_id in (select id from p5_g))
    or (target_type = 'item' and target_id in (select id from p5_i))
    or (target_type = 'intention' and target_id in (select id from p5_n));
-- Recipe runs go with their menu run (parent_execution_id cascades); all are listed anyway.
delete from public.executions where id in (select id from p5_x);
delete from public.events where intent_id in (select id from p5_n) or group_id in (select id from p5_g);
delete from public.reminders where intent_id in (select id from p5_n);
delete from public.item_group_members
 where group_id in (select id from p5_g)
    or (member_type = 'item' and member_id in (select id from p5_i))
    or (member_type = 'intention' and member_id in (select id from p5_n));
delete from public.intents where id in (select id from p5_n);
delete from public.items where id in (select id from p5_i);
delete from public.item_groups where id in (select id from p5_g);

commit;
