-- Purpose: Warren Buffet Phase 4, Step 3 (run tag warren_buffet_p4-r6d-s3-v8nc; spec P4-D1). wb_rule_health_all as in 156, with never_fires' expected interval now the most common gap between the merchant's linked charges: gaps of up to 10 days count as a week, 11 to 17 days as two weeks, longer ones round to whole months (so 30 and 31 days are the same), and a tie goes to the longer gap. With fewer than 3 linked charges it falls back to the chain from 156, whose comment now says what the code does (the shortest subscription interval). wb_rule_health is restated over it, columns unchanged.
-- Kind: schema change (two replaced views)
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p4-r6d.md P4-D1.
-- The new numbers are in the params row: 3 (min_charges), 10 (week_gap_days) and 17 (two_week_gap_days). If you change one, update
-- rule_health.never_fires in src/money/helpText.js and ruleNumbers.js, and their test.
-- No real financial data in this file. Run as one block, then supabase/tests/warren_buffet_p4/1_interval_rule_tests.sql
-- and supabase/tests/warren_buffet_p3/5_rule_health_tests.sql; the conformance result at the end must be conformant true.
-- supabase/migrations/190_interval_rule.sql

begin;

-- ============================================================================
-- 1. wb_rule_health_all: as in 156, with the new interval (P4-D1)
-- ============================================================================
create or replace view public.wb_rule_health_all
with (security_invoker = true) as
with findings as (
  with
  today as (select (now() at time zone 'America/Los_Angeles')::date as d),
  -- never_fires numbers (A54, A55, P4-D1): flagged once the quiet days exceed both factor x the expected
  -- interval and floor_days; the interval falls back to annual_days or quarter_days from notes, then default_days.
  params as (select 1.5::numeric as factor, 30 as floor_days, 30 as default_days, 91 as quarter_days, 365 as annual_days,
                    3 as min_charges, 10 as week_gap_days, 17 as two_week_gap_days),
  rule_merchant as (
    select r.*, (r.match ->> 'merchant_id')::uuid as merchant_id
    from public.wb_rules r
    where r.active
  ),
  hits as (
    select r.id as rule_id, x.id as transaction_id, x.kind, x.kind_source,
           (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date as d
    from rule_merchant r
    join public.wb_transactions x on r.id = any (x.matched_rule_ids) and not x.pending
  ),
  -- How often a rule should match (P4-D1): the most common rounded gap between the merchant's linked charges,
  -- ties to the longer. With too few charges: the merchant's shortest subscription interval, else the median
  -- gap between the rule's matches, else the notes' annual or quarterly days, else default_days.
  rule_interval as (
    select r.id as rule_id,
           coalesce(
             (select b.days
              from (select case when g.gap <= p.week_gap_days then 7::numeric
                                when g.gap <= p.two_week_gap_days then 14::numeric
                                else greatest(round(g.gap / 30.4), 1) * 30.4 end as days,
                           count(*) over () as n_gaps
                    from (select dd.d - lag(dd.d) over (order by dd.d) as gap
                          from (select distinct (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date as d
                                from public.wb_transactions x
                                join public.wb_subscriptions s on s.id = x.subscription_id
                                where x.merchant_id = r.merchant_id and not x.pending and x.kind = 'spend'
                                  and s.status <> 'cancelled') dd) g
                    where g.gap is not null) b
              where b.n_gaps + 1 >= p.min_charges
              group by b.days
              order by count(*) desc, b.days desc
              limit 1),
             (select min(case when s.interval_unit = 'month' then s.interval_count * 30.4 else s.interval_count * 7 end)
              from public.wb_subscriptions s
              where s.merchant_id = r.merchant_id and s.status <> 'cancelled' and s.interval_count is not null),
             (select percentile_cont(0.5) within group (order by g.gap)
              from (select dd.d - lag(dd.d) over (order by dd.d) as gap
                    from (select distinct h.d from hits h where h.rule_id = r.id) dd) g
              where g.gap is not null),
             case when coalesce(r.notes, '') ~* '(annual|yearly)' then p.annual_days
                  when coalesce(r.notes, '') ~* 'quarter' then p.quarter_days end,
             p.default_days)::numeric as days
    from rule_merchant r
    cross join params p
  ),
  overrides as (
    select h.rule_id, h.transaction_id,
           exists (
             select 1 from public.wb_splits s
             join public.wb_split_tags st on st.split_id = s.id
             join public.wb_tags rt on rt.id = any (r.add_tag_ids)
             where s.transaction_id = h.transaction_id
               and st.source in ('claude', 'manual')
               and st.group_exclusive and st.group_id = rt.group_id
               and st.tag_id <> all (r.add_tag_ids))                                      as tag_swap,
           exists (
             select 1 from public.wb_tag_exclusions e
             where e.transaction_id = h.transaction_id and e.rule_id = h.rule_id)         as tag_removed,
           (r.set_kind is not null and h.kind_source in ('claude', 'manual') and h.kind is distinct from r.set_kind) as kind_changed,
           (cardinality(r.add_tag_ids) > 0
            and (select count(*) from public.wb_splits s where s.transaction_id = h.transaction_id) > 1) as re_split,
           -- A project the rule set, changed or removed by hand (a removal is a null project_id with
           -- source claude or manual).
           (r.set_project_id is not null and exists (
             select 1 from public.wb_splits s
             where s.transaction_id = h.transaction_id
               and s.project_source in ('claude', 'manual')
               and s.project_id is distinct from r.set_project_id))                       as project_changed
    from hits h
    join rule_merchant r on r.id = h.rule_id
  ),
  payee_keys as (
    select x.merchant_id,
           nullif(btrim(regexp_replace(regexp_replace(
             split_part(lower(coalesce(nullif(btrim(x.payee), ''), x.clean_description, '')), '*', 1),
             '[0-9]', '', 'g'), '\s+', ' ', 'g')), '') as payee
    from public.wb_transactions x
    where x.merchant_id is not null and not x.pending
  ),
  merchant_payees as (
    select k.merchant_id,
           count(*)::int as n_txns,
           coalesce(array_agg(distinct k.payee) filter (where k.payee is not null), '{}') as payees
    from payee_keys k
    group by k.merchant_id
  )
  -- never_fires (A16, A54, A55): quiet for more than factor x the expected interval AND more than
  -- floor_days, counted from the last match, or from creation when it never matched. n stays 0, so an
  -- acknowledgement holds until the rule fires.
  select 'never_fires'::text as finding, r.id as rule_id, r.name as rule_name, r.merchant_id, m.name as merchant_name,
         0 as n, null::int as of_n,
         format('%s; expected about every %s.',
                case when r.last_hit_at is null
                     then format('No match since it was created on %s', (r.created_at at time zone 'America/Los_Angeles')::date)
                     else format('Last match on %s', (r.last_hit_at at time zone 'America/Los_Angeles')::date) end,
                case when round(ri.days) <= 1 then 'day' else round(ri.days) || ' days' end) as detail
  from rule_merchant r
  join rule_interval ri on ri.rule_id = r.id
  cross join today
  cross join params p
  left join public.wb_merchants m on m.id = r.merchant_id
  where today.d - coalesce((r.last_hit_at at time zone 'America/Los_Angeles')::date, (r.created_at at time zone 'America/Los_Angeles')::date)
        > greatest(ceil(p.factor * ri.days)::int, p.floor_days)
  union all
  select 'too_broad', null, null, mp.merchant_id, m.name,
         cardinality(mp.payees), mp.n_txns,
         'Payees: ' || array_to_string((select array_agg(p order by p) from unnest(mp.payees) p), '; ')
  from merchant_payees mp
  join public.wb_merchants m on m.id = mp.merchant_id
  where cardinality(mp.payees) >= 3
    and exists (select 1 from rule_merchant r where r.merchant_id = mp.merchant_id)
  union all
  -- often_overridden detail (A55): "tag swapped on 2, removed on 2, kind changed on 1 (of 5)".
  select 'often_overridden', r.id, r.name, r.merchant_id, m.name, o.n, o.of_n,
         concat_ws(', ',
           case when o.swaps > 0 then format('tag swapped on %s', o.swaps) end,
           case when o.removals > 0 then format('%s on %s', case when o.swaps > 0 then 'removed' else 'tag removed' end, o.removals) end,
           case when o.kinds > 0 then format('kind changed on %s', o.kinds) end,
           case when o.splits > 0 then format('re-split on %s', o.splits) end,
           case when o.projects > 0 then format('project changed on %s', o.projects) end)
         || format(' (of %s)', o.of_n)
  from rule_merchant r
  left join public.wb_merchants m on m.id = r.merchant_id
  join lateral (
    select count(*) filter (where tag_swap or tag_removed or kind_changed or re_split or project_changed)::int as n,
           (select count(*) from hits h where h.rule_id = r.id)::int as of_n,
           count(*) filter (where tag_swap)::int as swaps,
           count(*) filter (where tag_removed)::int as removals,
           count(*) filter (where kind_changed)::int as kinds,
           count(*) filter (where re_split)::int as splits,
           count(*) filter (where project_changed)::int as projects
    from overrides ov where ov.rule_id = r.id
  ) o on true
  where o.n >= 2 and o.n * 4 >= o.of_n
  union all
  select 'duplicate_rules', null, null, r.merchant_id, m.name, count(*)::int, null,
         'Rules: ' || string_agg(r.name, '; ' order by r.priority, r.created_at)
  from rule_merchant r
  left join public.wb_merchants m on m.id = r.merchant_id
  where r.merchant_id is not null
  group by r.merchant_id, m.name
  having count(*) >= 2
  union all
  select 'rule_missing', null, null, m.id, m.name, t.n, null,
         format('%s transactions tagged by hand or by Claude, and no rule.', t.n)
  from public.wb_merchants m
  join lateral (
    select count(distinct x.id)::int as n
    from public.wb_transactions x
    join public.wb_splits s on s.transaction_id = x.id
    join public.wb_split_tags st on st.split_id = s.id
    where x.merchant_id = m.id and not x.pending and st.source in ('claude', 'manual')
  ) t on true
  where t.n >= 3
    and not exists (select 1 from rule_merchant r where r.merchant_id = m.id)
  union all
  select 'merchant_no_category', null, null, m.id, m.name, c.n, null,
         format('%s spend transactions, none with a Category.', c.n)
  from public.wb_merchants m
  join lateral (
    select count(*)::int as n,
           bool_or(exists (
             select 1 from public.wb_splits s
             join public.wb_split_tags st on st.split_id = s.id
             join public.wb_tag_groups g on g.id = st.group_id
             where s.transaction_id = x.id and g.name = 'Category')) as any_category
    from public.wb_transactions x
    where x.merchant_id = m.id and not x.pending and x.kind in ('spend', 'refund', 'fee')
  ) c on true
  where c.n > 0 and not coalesce(c.any_category, false)
)
select
  f.finding, f.rule_id, f.rule_name, f.merchant_id, f.merchant_name, f.n, f.of_n, f.detail,
  coalesce(f.rule_id, f.merchant_id)                 as subject_id,
  (a.id is not null and f.n <= a.acked_n)            as acknowledged,
  a.acked_n,
  a.reason                                           as ack_reason,
  a.updated_at                                       as acked_at
from findings f
left join public.wb_rule_health_acks a
  on a.finding = f.finding and a.subject_id = coalesce(f.rule_id, f.merchant_id);

comment on view public.wb_rule_health_all is
  'App: Warren Buffet. Every rule-health finding (see wb_rule_health) with subject_id (the rule, else the merchant) and its acknowledgement: acknowledged is true while n has not grown past acked_n, with ack_reason and acked_at. never_fires (A16, A54, A55, P4-D1): an active rule quiet for more than both 1.5 times its expected interval and 30 days, counted from its last match or, when it never matched, from its creation; the interval is the most common gap between the merchant''s linked charges (up to 10 days counts as a week, up to 17 as two weeks, longer rounds to whole months, a tie goes to the longer), and with fewer than 3 linked charges the merchant''s shortest subscription interval, else the median gap between its matches, else 365 or 91 days when its notes say annual or quarterly, else 30. detail gives the date and the interval ("expected about every day" or "every N days"). often_overridden counts tag swaps and removals, kind changes, re-splits, and a project the rule set that was changed or removed by hand; detail reads "tag swapped on 2, removed on 2 (of 5)". security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 2. wb_rule_health: as in 156, restated over the new view
-- ============================================================================
create or replace view public.wb_rule_health
with (security_invoker = true) as
select finding, rule_id, rule_name, merchant_id, merchant_name, n, of_n, detail
from public.wb_rule_health_all
where not acknowledged;

comment on view public.wb_rule_health is
  'App: Warren Buffet. One row per finding not acknowledged (finding, rule_id, rule_name, merchant_id, merchant_name, n, of_n, detail): never_fires (quiet for more than both 1.5 times the rule''s expected interval and 30 days, A54, A55, P4-D1), too_broad (merchant-level: 3+ distinct normalized payees on a merchant with a rule), often_overridden (n of of_n hits beaten by hand, at least 2 and 25%, a changed project included), duplicate_rules, rule_missing, merchant_no_category. An acknowledged finding (wb_rule_health_acks) is hidden until its n grows past the acknowledged n; wb_rule_health_all has them all. Read by get_wb_rule_health, wb_action_items and the weekly cleanup task, which proposes fixes and never writes them. security_invoker, so wb_ RLS applies.';

revoke all on public.wb_rule_health_all from public, anon;
revoke all on public.wb_rule_health from public, anon;
grant select on public.wb_rule_health_all to authenticated, service_role;
grant select on public.wb_rule_health to authenticated, service_role;

commit;

-- ============================================================================
-- Conformance: this is the result the SQL editor shows. Expect conformant
-- true and failures []. Then run the two test scripts named at the top.
-- ============================================================================
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t)
) as result;
