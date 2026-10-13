-- Purpose: Warren Buffet Phase 2, Step 10. View wb_rule_health: one row per finding for the weekly cleanup task and get_wb_rule_health. Findings: never_fires (active rule, no hits, older than 14 days, not quarterly/annual by notes or by its merchant's subscription interval), too_broad (a merchant with a rule whose transactions carry 3 or more distinct payees, normalized: lowercase, cut at the first "*", no digits, spaces collapsed), often_overridden (at least 2 hits, and at least 25% of hits, where a person beat the rule: a hand tag in the rule tag's exclusive group, a removal of the rule's tag, a hand kind against the rule's kind, or a re-split), duplicate_rules (a merchant with 2 or more active rules), rule_missing (a merchant tagged by hand 3 or more times with no rule), merchant_no_category (a merchant whose spend never carries a Category tag).
-- Kind: schema change (one new view)
-- Applied: YES — 2026-10-13 by Alex ("Success. No rows returned"); 128 all 17 checks true.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p2-m4t.md section 4.9 and 8 (Step 10).
-- No real financial data in this file. Run as one block, then 128_wb_phase2_step10_rule_health_tests.sql.
-- supabase/migrations/127_wb_phase2_step10_rule_health.sql

begin;

create or replace view public.wb_rule_health
with (security_invoker = true) as
with
rule_merchant as (
  select r.*, (r.match ->> 'merchant_id')::uuid as merchant_id
  from public.wb_rules r
  where r.active
),
hits as (
  select r.id as rule_id, x.id as transaction_id, x.kind, x.kind_source
  from rule_merchant r
  join public.wb_transactions x on r.id = any (x.matched_rule_ids) and not x.pending
),
-- One row per hit a person overrode, with which kind of override it was.
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
          and (select count(*) from public.wb_splits s where s.transaction_id = h.transaction_id) > 1) as re_split
  from hits h
  join rule_merchant r on r.id = h.rule_id
),
-- Payees normalized before counting: lowercase, cut from the first "*" (order and
-- reference numbers), digits removed, spaces collapsed. "AMAZON MKTPL*AB12" -> "amazon mktpl".
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
-- never_fires
select 'never_fires'::text as finding, r.id as rule_id, r.name as rule_name, r.merchant_id, m.name as merchant_name,
       0 as n, null::int as of_n,
       format('No match since it was created on %s.', (r.created_at at time zone 'America/Los_Angeles')::date) as detail
from rule_merchant r
left join public.wb_merchants m on m.id = r.merchant_id
where r.hit_count = 0
  and r.created_at < now() - interval '14 days'
  and coalesce(r.notes, '') !~* '(quarter|annual|yearly)'
  and not exists (
    select 1 from public.wb_subscriptions s
    where s.merchant_id = r.merchant_id and s.status <> 'cancelled'
      and ((s.interval_unit = 'month' and s.interval_count >= 3) or (s.interval_unit = 'week' and s.interval_count >= 13)))
union all
-- too_broad: a merchant with an active rule whose transactions carry 3 or more distinct payees
select 'too_broad', null, null, mp.merchant_id, m.name,
       cardinality(mp.payees), mp.n_txns,
       'Payees: ' || array_to_string((select array_agg(p order by p) from unnest(mp.payees) p), '; ')
from merchant_payees mp
join public.wb_merchants m on m.id = mp.merchant_id
where cardinality(mp.payees) >= 3
  and exists (select 1 from rule_merchant r where r.merchant_id = mp.merchant_id)
union all
-- often_overridden: at least 2 overridden hits and at least 25% of hits
select 'often_overridden', r.id, r.name, r.merchant_id, m.name, o.n, o.of_n,
       concat_ws(', ',
         case when o.swaps > 0 then format('%s tag swapped', o.swaps) end,
         case when o.removals > 0 then format('%s tag removed', o.removals) end,
         case when o.kinds > 0 then format('%s kind changed', o.kinds) end,
         case when o.splits > 0 then format('%s re-split', o.splits) end)
from rule_merchant r
left join public.wb_merchants m on m.id = r.merchant_id
join lateral (
  select count(*) filter (where tag_swap or tag_removed or kind_changed or re_split)::int as n,
         (select count(*) from hits h where h.rule_id = r.id)::int as of_n,
         count(*) filter (where tag_swap)::int as swaps,
         count(*) filter (where tag_removed)::int as removals,
         count(*) filter (where kind_changed)::int as kinds,
         count(*) filter (where re_split)::int as splits
  from overrides ov where ov.rule_id = r.id
) o on true
where o.n >= 2 and o.n * 4 >= o.of_n
union all
-- duplicate_rules: a merchant with 2 or more active rules
select 'duplicate_rules', null, null, r.merchant_id, m.name, count(*)::int, null,
       'Rules: ' || string_agg(r.name, '; ' order by r.priority, r.created_at)
from rule_merchant r
left join public.wb_merchants m on m.id = r.merchant_id
where r.merchant_id is not null
group by r.merchant_id, m.name
having count(*) >= 2
union all
-- rule_missing: a merchant tagged by hand 3 or more times with no active rule
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
-- merchant_no_category: a merchant whose spend never carries a Category tag
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
where c.n > 0 and not coalesce(c.any_category, false);

comment on view public.wb_rule_health is
  'App: Warren Buffet. One row per finding (finding, rule_id, rule_name, merchant_id, merchant_name, n, of_n, detail): never_fires, too_broad (merchant-level: 3+ distinct payees on a merchant with a rule), often_overridden (n of of_n hits beaten by hand, at least 2 and 25%), duplicate_rules, rule_missing, merchant_no_category. Read by get_wb_rule_health and the weekly cleanup task, which proposes fixes and never writes them. security_invoker, so wb_ RLS applies.';

grant select on public.wb_rule_health to authenticated, service_role;

commit;
