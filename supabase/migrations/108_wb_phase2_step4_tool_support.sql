-- Purpose: Warren Buffet Phase 2 Step 4 tool support. wb_rules.created_from_transaction_id; wb_split_tags.replaced_rule_id (a hand tag that replaced a rule tag, for Step 10); view wb_transaction_list (merchant name, tag_names text[], needs_review); invoker functions wb_rule_preview, wb_replace_splits, wb_set_transfer_pair and wb_apply_tags, so each multi-row tool write is one transaction.
-- Kind: schema change (two columns, one view, four functions)
-- Applied: YES — 2026-10-10 by Alex. 109 all 10 checks true (needs_review 301 = queue); conformance CONFORMANT (58 tables).
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p2-m4t.md sections 4.7, 6 and 6.1.
-- No real financial data in this file. Run as one block, then 109_wb_phase2_verify_step4.sql.
-- supabase/migrations/108_wb_phase2_step4_tool_support.sql

begin;

-- ============================================================================
-- 1. Columns
-- ============================================================================
alter table public.wb_rules
  add column if not exists created_from_transaction_id uuid references public.wb_transactions(id) on delete set null;
comment on column public.wb_rules.created_from_transaction_id is
  'The transaction an "Always do this" fix was made from (spec §6.1). Null for rules written directly.';

alter table public.wb_split_tags
  add column if not exists replaced_rule_id uuid references public.wb_rules(id) on delete set null;
alter table public.wb_split_tags drop constraint if exists wb_split_tags_replaced_check;
alter table public.wb_split_tags add constraint wb_split_tags_replaced_check
  check (replaced_rule_id is null or source <> 'rule');
comment on column public.wb_split_tags.replaced_rule_id is
  'For a claude or manual tag that replaced a rule''s tag in the same group, or took over a rule''s tag: that rule. Counts overrides for rule health (Step 10).';

-- ============================================================================
-- 2. wb_transaction_list: what the tools and the UI list
-- ============================================================================
-- needs_review mirrors wb_review_queue's reasons row by row (cheaper than
-- joining the view); keep the two in step.
create or replace view public.wb_transaction_list
with (security_invoker = true) as
select
  x.id,
  x.account_id,
  coalesce(a.display_name, a.name)                                                   as account_label,
  x.posted_at,
  x.transacted_at,
  (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date as txn_date,
  x.amount,
  x.description,
  x.clean_description,
  x.payee,
  x.memo,
  x.mcc,
  x.pending,
  x.merchant_id,
  m.name                                                                             as merchant_name,
  x.merchant_source,
  x.kind,
  x.kind_source,
  x.transfer_pair_id,
  x.transfer_candidate,
  x.reviewed,
  x.processed_at,
  x.first_seen_at,
  x.last_seen_at,
  coalesce((
    select array_agg(distinct tg.name order by tg.name)
    from public.wb_splits s
    join public.wb_split_tags st on st.split_id = s.id
    join public.wb_tags tg on tg.id = st.tag_id
    where s.transaction_id = x.id
  ), '{}'::text[])                                                                   as tag_names,
  (select count(*) from public.wb_splits s where s.transaction_id = x.id)::int        as split_count,
  (
    x.kind is null
    or (not x.pending and not x.reviewed and x.transfer_candidate and x.transfer_pair_id is null)
    or (not x.pending and not x.reviewed and exists (
          select 1
          from public.wb_tag_groups g
          join public.wb_splits s on s.transaction_id = x.id
          where x.kind = any (g.required_for_kinds)
            and not exists (select 1 from public.wb_split_tags st where st.split_id = s.id and st.group_id = g.id)))
    or coalesce((select sum(s.amount) from public.wb_splits s where s.transaction_id = x.id), 0) <> x.amount
  )                                                                                  as needs_review
from public.wb_transactions x
join public.wb_accounts a on a.id = x.account_id
left join public.wb_merchants m on m.id = x.merchant_id;

comment on view public.wb_transaction_list is
  'App: Warren Buffet. Transactions with account label, merchant name, tag_names (text[], filter with overlaps), split_count and needs_review (true when the row is in wb_review_queue). No raw jsonb. security_invoker, so wb_ RLS applies.';

revoke all on public.wb_transaction_list from public, anon;
grant select on public.wb_transaction_list to authenticated, service_role;

-- ============================================================================
-- 3. wb_rule_preview: dry-run count for a rule match, or for a merchant pattern
-- ============================================================================
-- With p_match: posted rows wb_rule_matches would match today.
-- With p_pattern: posted rows whose payee or description contains it, as a new
-- merchant pattern would. Returns count, up to p_samples samples, and all ids.
create or replace function public.wb_rule_preview(p_match jsonb default null, p_pattern text default null, p_samples int default 5)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_pattern text := lower(btrim(coalesce(p_pattern, '')));
  v_ids     uuid[];
  v_samples jsonb;
begin
  if (p_match is null) = (v_pattern = '') then
    raise exception 'wb_rule_preview: pass exactly one of p_match or p_pattern' using errcode = '22023';
  end if;
  if p_match is not null and (jsonb_typeof(p_match) <> 'object' or p_match = '{}'::jsonb) then
    raise exception 'wb_rule_preview: p_match must be a non-empty object' using errcode = '22023';
  end if;

  select coalesce(array_agg(x.id order by coalesce(x.posted_at, x.transacted_at) desc, x.id), '{}')
  into v_ids
  from public.wb_transactions x
  where not x.pending
    and case
          when p_match is not null then
            public.wb_rule_matches(p_match, x.account_id, x.amount, x.payee, x.description,
                                   x.clean_description, x.merchant_id, x.kind)
          else position(v_pattern in lower(coalesce(x.payee, ''))) > 0
               or position(v_pattern in lower(coalesce(x.description, ''))) > 0
        end;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'txn_date', l.txn_date, 'amount', l.amount, 'account_label', l.account_label,
           'clean_description', l.clean_description, 'payee', l.payee, 'merchant_name', l.merchant_name,
           'kind', l.kind, 'tag_names', l.tag_names)
         order by l.txn_date desc, l.id), '[]'::jsonb)
  into v_samples
  from public.wb_transaction_list l
  where l.id = any (v_ids[1:greatest(coalesce(p_samples, 5), 0)]);

  return jsonb_build_object('count', cardinality(v_ids), 'too_narrow', cardinality(v_ids) <= 1,
                            'samples', v_samples, 'ids', to_jsonb(v_ids));
end;
$$;

comment on function public.wb_rule_preview(jsonb, text, int) is
  'Warren Buffet: dry run for a rule (p_match, through wb_rule_matches, exactly as processing) or a merchant pattern (p_pattern, substring of payee or description). Posted rows only. Returns count, too_narrow (count <= 1), samples and ids. Writes nothing.';

-- ============================================================================
-- 4. wb_replace_splits: replace a transaction's splits (and their tags) at once
-- ============================================================================
-- p_splits: [{amount, description?, tax_year?, notes?, tag_ids?: [uuid]}]. The
-- deferred split-sum check runs at commit; this checks first for a clear message.
create or replace function public.wb_replace_splits(p_transaction_id uuid, p_splits jsonb, p_source text default 'claude')
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_amount numeric;
  v_sum    numeric;
  v_split  uuid;
  e        record;
begin
  if p_source not in ('claude', 'manual') then
    raise exception 'wb_replace_splits: source must be claude or manual' using errcode = '22023';
  end if;
  if jsonb_typeof(p_splits) <> 'array' or jsonb_array_length(p_splits) = 0 then
    raise exception 'wb_replace_splits: splits must be a non-empty array' using errcode = '22023';
  end if;
  select amount into v_amount from public.wb_transactions where id = p_transaction_id for update;
  if not found then
    raise exception 'wb_replace_splits: no transaction % that you can see', p_transaction_id using errcode = '23503';
  end if;
  select sum((s ->> 'amount')::numeric) into v_sum from jsonb_array_elements(p_splits) s;
  if v_sum is distinct from v_amount then
    raise exception 'wb_replace_splits: splits sum to %, but the transaction is %', v_sum, v_amount using errcode = '23514';
  end if;
  -- Two tags from one exclusive group on one split.
  if exists (
    select 1
    from jsonb_array_elements(p_splits) with ordinality as sp(s, pos)
    cross join lateral jsonb_array_elements_text(coalesce(sp.s -> 'tag_ids', '[]'::jsonb)) as t(tag_id)
    join public.wb_tags tg on tg.id = t.tag_id::uuid
    join public.wb_tag_groups g on g.id = tg.group_id and g.exclusive
    group by sp.pos, g.id
    having count(*) > 1
  ) then
    raise exception 'wb_replace_splits: a split has two tags from one exclusive group' using errcode = '23505';
  end if;

  delete from public.wb_splits where transaction_id = p_transaction_id;

  for e in select s, pos from jsonb_array_elements(p_splits) with ordinality as sp(s, pos) order by pos
  loop
    insert into public.wb_splits (transaction_id, amount, description, tax_year, notes, position)
    values (p_transaction_id, (e.s ->> 'amount')::numeric, nullif(btrim(e.s ->> 'description'), ''),
            (e.s ->> 'tax_year')::int, nullif(btrim(e.s ->> 'notes'), ''), e.pos::int - 1)
    returning id into v_split;
    insert into public.wb_split_tags (split_id, tag_id, source)
    select v_split, t.tag_id::uuid, p_source
    from jsonb_array_elements_text(coalesce(e.s -> 'tag_ids', '[]'::jsonb)) as t(tag_id)
    on conflict (split_id, tag_id) do nothing;
  end loop;

  return jsonb_build_object('transaction_id', p_transaction_id, 'splits', (
    select jsonb_agg(jsonb_build_object('id', s.id, 'position', s.position, 'amount', s.amount,
             'description', s.description, 'tax_year', s.tax_year,
             'tag_ids', coalesce((select jsonb_agg(st.tag_id) from public.wb_split_tags st where st.split_id = s.id), '[]'::jsonb))
           order by s.position)
    from public.wb_splits s where s.transaction_id = p_transaction_id));
end;
$$;

comment on function public.wb_replace_splits(uuid, jsonb, text) is
  'Warren Buffet: replace all splits of one transaction, with their tags (source claude or manual), in one transaction. Amounts must sum to the transaction amount.';

-- ============================================================================
-- 5. wb_set_transfer_pair: pair two rows, or unpair one (and its partner)
-- ============================================================================
-- Both rows get kind_source p_source, so processing leaves them alone.
create or replace function public.wb_set_transfer_pair(p_id uuid, p_pair_with uuid, p_source text default 'claude')
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  a record;
  b record;
begin
  if p_source not in ('claude', 'manual') then
    raise exception 'wb_set_transfer_pair: source must be claude or manual' using errcode = '22023';
  end if;
  select id, account_id, amount, transfer_pair_id into a from public.wb_transactions where id = p_id for update;
  if not found then
    raise exception 'wb_set_transfer_pair: no transaction % that you can see', p_id using errcode = '23503';
  end if;

  if p_pair_with is null then
    if a.transfer_pair_id is null then
      return jsonb_build_object('unpaired', '[]'::jsonb);
    end if;
    update public.wb_transactions
    set transfer_pair_id = null, kind_source = p_source, transfer_candidate = false
    where id in (a.id, a.transfer_pair_id);
    return jsonb_build_object('unpaired', jsonb_build_array(a.id, a.transfer_pair_id));
  end if;

  if p_pair_with = p_id then
    raise exception 'wb_set_transfer_pair: a transaction cannot pair with itself' using errcode = '22023';
  end if;
  select id, account_id, amount, transfer_pair_id into b from public.wb_transactions where id = p_pair_with for update;
  if not found then
    raise exception 'wb_set_transfer_pair: no transaction % that you can see', p_pair_with using errcode = '23503';
  end if;
  if a.account_id = b.account_id then
    raise exception 'wb_set_transfer_pair: both rows are on the same account' using errcode = '22023';
  end if;
  if sign(a.amount) = sign(b.amount) then
    raise exception 'wb_set_transfer_pair: a transfer needs one row out (negative) and one in (positive)' using errcode = '22023';
  end if;
  if (a.transfer_pair_id is not null and a.transfer_pair_id <> b.id)
     or (b.transfer_pair_id is not null and b.transfer_pair_id <> a.id) then
    raise exception 'wb_set_transfer_pair: one of the rows is already paired with another; unpair it first' using errcode = '23505';
  end if;

  update public.wb_transactions
  set transfer_pair_id = case when id = a.id then b.id else a.id end,
      kind = 'transfer', kind_source = p_source, transfer_candidate = false
  where id in (a.id, b.id);
  return jsonb_build_object('paired', jsonb_build_array(a.id, b.id),
                            'amounts_differ', a.amount <> -b.amount);
end;
$$;

comment on function public.wb_set_transfer_pair(uuid, uuid, text) is
  'Warren Buffet: pair two transactions as a transfer (different accounts, opposite signs), or with p_pair_with null unpair one and its partner. Both rows get kind_source claude or manual, so processing never re-pairs or unpairs them.';

-- ============================================================================
-- 6. wb_apply_tags: tag (and untag) the single split of each transaction
-- ============================================================================
-- In an exclusive group the new tag replaces the old one. Where the replaced or
-- taken-over tag came from a rule, replaced_rule_id records that rule.
create or replace function public.wb_apply_tags(
  p_transaction_ids uuid[], p_tag_ids uuid[], p_source text default 'claude', p_remove_tag_ids uuid[] default '{}')
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_tid        uuid;
  v_split      uuid;
  v_n          int;
  tg           record;
  v_had        boolean;
  v_old_id     uuid;
  v_old_tag    uuid;
  v_old_source text;
  v_old_rule   uuid;
  n_added      int := 0;
  n_replaced int := 0;
  n_removed  int := 0;
  v_multi    uuid[] := '{}';
  v_missing  uuid[] := '{}';
begin
  if p_source not in ('claude', 'manual') then
    raise exception 'wb_apply_tags: source must be claude or manual' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(coalesce(p_tag_ids, '{}') || coalesce(p_remove_tag_ids, '{}')) t(id)
             where not exists (select 1 from public.wb_tags x where x.id = t.id)) then
    raise exception 'wb_apply_tags: a tag id does not exist' using errcode = '23503';
  end if;
  if exists (
    select 1 from public.wb_tags x join public.wb_tag_groups g on g.id = x.group_id and g.exclusive
    where x.id = any (coalesce(p_tag_ids, '{}')) group by g.id having count(*) > 1
  ) then
    raise exception 'wb_apply_tags: two tags from one exclusive group' using errcode = '23505';
  end if;

  foreach v_tid in array coalesce(p_transaction_ids, '{}')
  loop
    select count(*)::int, (array_agg(s.id))[1] into v_n, v_split
    from public.wb_splits s where s.transaction_id = v_tid;
    if v_n = 0 then
      v_missing := v_missing || v_tid;
      continue;
    elsif v_n > 1 then
      v_multi := v_multi || v_tid;
      continue;
    end if;

    delete from public.wb_split_tags where split_id = v_split and tag_id = any (coalesce(p_remove_tag_ids, '{}'));
    get diagnostics v_n = row_count;
    n_removed := n_removed + v_n;

    for tg in
      select x.id, x.group_id, g.exclusive
      from public.wb_tags x join public.wb_tag_groups g on g.id = x.group_id
      where x.id = any (coalesce(p_tag_ids, '{}'))
    loop
      v_old_id := null; v_old_tag := null; v_old_source := null; v_old_rule := null;
      select st.id, st.tag_id, st.source, st.rule_id into v_old_id, v_old_tag, v_old_source, v_old_rule
      from public.wb_split_tags st
      where st.split_id = v_split
        and (st.tag_id = tg.id or (tg.exclusive and st.group_id = tg.group_id))
      order by (st.tag_id = tg.id) desc
      limit 1;
      v_had := found;

      if v_had and v_old_tag = tg.id then
        -- Already there: a hand tag takes it over, so a rule never removes it.
        update public.wb_split_tags
        set source = p_source, rule_id = null,
            replaced_rule_id = coalesce(replaced_rule_id, case when v_old_source = 'rule' then v_old_rule end)
        where id = v_old_id and source <> p_source;
      else
        if v_had then
          delete from public.wb_split_tags where id = v_old_id;
          n_replaced := n_replaced + 1;
        end if;
        insert into public.wb_split_tags (split_id, tag_id, source, replaced_rule_id)
        values (v_split, tg.id, p_source, case when v_old_source = 'rule' then v_old_rule end);
        n_added := n_added + 1;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('added', n_added, 'replaced', n_replaced, 'removed', n_removed,
                            'skipped_multi_split', to_jsonb(v_multi), 'not_found', to_jsonb(v_missing));
end;
$$;

comment on function public.wb_apply_tags(uuid[], uuid[], text, uuid[]) is
  'Warren Buffet: add tags (source claude or manual) to, and remove tags from, the single split of each transaction. An exclusive group''s new tag replaces the old one; a replaced or taken-over rule tag is recorded in replaced_rule_id. Multi-split transactions are skipped: use wb_replace_splits.';

revoke all on function public.wb_rule_preview(jsonb, text, int) from public, anon;
revoke all on function public.wb_replace_splits(uuid, jsonb, text) from public, anon;
revoke all on function public.wb_set_transfer_pair(uuid, uuid, text) from public, anon;
revoke all on function public.wb_apply_tags(uuid[], uuid[], text, uuid[]) from public, anon;
grant execute on function public.wb_rule_preview(jsonb, text, int) to authenticated, service_role;
grant execute on function public.wb_replace_splits(uuid, jsonb, text) to authenticated, service_role;
grant execute on function public.wb_set_transfer_pair(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.wb_apply_tags(uuid[], uuid[], text, uuid[]) to authenticated, service_role;

commit;
