-- Purpose: Warren Buffet Phase 2 Step 3 verification, after the one-time reprocess: kinds, transfer pairs, transfer candidates, investment-account kinds, cleaning samples, review queue and split sums.
-- Kind: read-only diagnostic (never "applied"; writes nothing)
-- Applied: YES — run 2026-10-09 by Alex after 105 and again after 107: unprocessed 0, 16 symmetric pairs, no candidates, no split mismatches. Read-only, safe to re-run.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p2-m4t.md section 5.
-- The output holds real transactions; this file holds none.
-- supabase/migrations/106_wb_phase2_verify_step3.sql

with t as (
  select
    x.*,
    coalesce(a.display_name, a.name)                                                   as account_label,
    a.role                                                                             as account_role,
    (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date as txn_date
  from public.wb_transactions x
  join public.wb_accounts a on a.id = x.account_id
)
select json_build_object(
  'totals', json_build_object(
    'transactions', (select count(*) from t),
    'pending',      (select count(*) from t where pending),
    'unprocessed',  (select count(*) from t where processed_at is null),
    'unprocessed_posted', (select count(*) from t where processed_at is null and not pending)),
  'by_kind', (select json_object_agg(coalesce(kind, '(null)'), n) from (
    select kind, count(*) as n from t group by kind) q),
  'by_kind_source', (select json_object_agg(coalesce(kind_source, '(null)'), n) from (
    select kind_source, count(*) as n from t group by kind_source) q),
  'transfer_pairs', (select json_agg(p order by p.out_date, p.out_account) from (
    select o.account_label as out_account, i.account_label as in_account,
           o.amount as out_amount, i.amount as in_amount,
           o.txn_date as out_date, i.txn_date as in_date,
           o.clean_description as out_clean, i.clean_description as in_clean
    from t o
    join t i on i.id = o.transfer_pair_id
    where o.amount < 0) p),
  'pair_links_symmetric', (
    select count(*) = 0 from t o join t i on i.id = o.transfer_pair_id where i.transfer_pair_id is distinct from o.id),
  'transfer_candidates', (select json_agg(c order by c.txn_date, c.account_label) from (
    select account_label, amount, txn_date, clean_description, kind_source
    from t where transfer_candidate and transfer_pair_id is null) c),
  'investment_account_kinds', (select json_agg(k order by k.account_label, k.kind) from (
    select account_label, account_role, kind, count(*) as n
    from t where account_role in ('retirement', 'taxable_investment')
    group by account_label, account_role, kind) k),
  'cleaning_samples', (select json_agg(s) from (
    select t.description as raw, t.clean_description as clean, m.name as merchant, t.payee
    from t left join public.wb_merchants m on m.id = t.merchant_id
    where t.description is distinct from t.clean_description
    order by t.txn_date desc, t.id
    limit 15) s),
  'review_queue', (select json_object_agg(reason, n) from (
    select reason, count(*) as n from public.wb_review_queue group by reason) q),
  'split_sum_mismatches', (select coalesce(json_agg(m), '[]'::json) from (
    select t.id, t.account_label, t.amount, s.n as splits, s.total
    from t
    join lateral (select count(*) as n, coalesce(sum(sp.amount), 0) as total
                  from public.wb_splits sp where sp.transaction_id = t.id) s on true
    where s.n = 0 or s.total <> t.amount) m)
) as result;
