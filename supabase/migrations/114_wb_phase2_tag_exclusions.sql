-- Purpose: Warren Buffet Phase 2, Step 5 follow-up. A tag removed by hand stays removed: wb_tag_exclusions records the removal per transaction (tag, the rule that had applied it, who, when). wb_process_transactions skips an excluded rule tag but still applies the rule's other tags; wb_apply_tags writes an exclusion on removal and clears it when the tag is added back by hand; wb_replace_splits clears exclusions for tags it adds by hand; wb_transaction_list shows excluded_tags.
-- Kind: schema change (one table, three replaced functions, one replaced view)
-- Applied: YES — 2026-10-11 by Alex. Conformance passed; 115 all 13 checks true.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p2-m4t.md sections 4.6 and 5.
-- No real financial data in this file. Run as one block, then 115_wb_phase2_tag_exclusions_tests.sql;
-- check_platform_conformance must report CONFORMANT.
-- supabase/migrations/114_wb_phase2_tag_exclusions.sql

begin;

-- ============================================================================
-- 1. wb_tag_exclusions
-- ============================================================================
-- Keyed on the transaction, not the split, so replacing splits or the default
-- split trigger can never lose it.
create table if not exists public.wb_tag_exclusions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id     text not null references public.contexts(id),
  transaction_id uuid not null references public.wb_transactions(id) on delete cascade,
  tag_id         uuid not null references public.wb_tags(id) on delete cascade,
  rule_id        uuid references public.wb_rules(id) on delete set null,
  source         text not null,
  removed_by     uuid default auth.uid() references auth.users(id) on delete set null,
  notes          text,
  created_at     timestamptz not null default now(),

  constraint wb_tag_exclusions_transaction_tag_key unique (transaction_id, tag_id),
  constraint wb_tag_exclusions_source_check check (source in ('claude', 'manual'))
);

create index if not exists wb_tag_exclusions_tag_idx on public.wb_tag_exclusions (tag_id);

comment on table public.wb_tag_exclusions is
  'App: Warren Buffet. Tags removed from a transaction by hand (or by Claude), so no rule puts them back. One row per transaction and tag, with the rule that had applied it (if any), the source, who (removed_by) and when (created_at). Adding the tag back by hand deletes the row. user_id and context_id are copied from the transaction by trigger.';
comment on column public.wb_tag_exclusions.removed_by is 'The signed-in user who removed the tag; null when the SQL editor or the service role did it.';

create or replace function public.wb_tag_exclusions_copy_owner()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  select t.user_id, t.context_id into new.user_id, new.context_id
  from public.wb_transactions t
  where t.id = new.transaction_id;
  if not found then
    raise exception 'wb_tag_exclusions: transaction % not found', new.transaction_id using errcode = '23503';
  end if;
  return new;
end;
$$;

drop trigger if exists wb_tag_exclusions_copy_owner on public.wb_tag_exclusions;
create trigger wb_tag_exclusions_copy_owner before insert or update on public.wb_tag_exclusions
  for each row execute function public.wb_tag_exclusions_copy_owner();

-- ============================================================================
-- 2. wb_process_transactions: as in 107, plus one line in step 5 — a rule tag
--    excluded for this transaction is skipped; the rule's other tags still apply.
-- ============================================================================
create or replace function public.wb_process_transactions(ids uuid[])
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_id         uuid;
  t            record;
  cur          record;
  r            record;
  v_tag        record;
  v_merchant   uuid;
  v_msource    text;
  v_mkind      text;
  v_clean      text;
  v_kind       text;
  v_ksource    text;
  v_p2p        boolean;
  v_date       date;
  v_fwd        int;
  v_rev        int;
  v_match      record;
  v_split      uuid;
  v_nsplits    int;
  v_matched    uuid[];
  n_processed  int := 0;
  n_paired     int := 0;
  n_candidates int := 0;
  n_tags       int := 0;
  n_rules      int := 0;
begin
  if ids is null or cardinality(ids) = 0 then
    return jsonb_build_object('processed', 0, 'paired', 0, 'transfer_candidates', 0, 'rule_tags', 0, 'rules_updated', 0);
  end if;

  for v_id in
    select x.id from public.wb_transactions x
    where x.id = any(ids)
    order by coalesce(x.posted_at, x.transacted_at), x.id
  loop
    -- Read fresh each time: pairing an earlier row may have changed this one.
    select x.*, a.role as account_role, a.source as account_source
    into t
    from public.wb_transactions x
    join public.wb_accounts a on a.id = x.account_id
    where x.id = v_id;
    continue when not found;

    -- 2. Merchant (before cleaning, which strips the city only when one matched).
    if t.merchant_source in ('claude', 'manual') then
      v_merchant := t.merchant_id;
      v_msource  := t.merchant_source;
    else
      v_merchant := null;
      if t.payee is not null then
        select m.id into v_merchant
        from public.wb_merchants m, unnest(m.match_patterns) p
        where position(lower(p) in lower(t.payee)) > 0
        order by length(p) desc, m.name, m.id
        limit 1;
      end if;
      if v_merchant is null and t.description is not null then
        select m.id into v_merchant
        from public.wb_merchants m, unnest(m.match_patterns) p
        where position(lower(p) in lower(t.description)) > 0
        order by length(p) desc, m.name, m.id
        limit 1;
      end if;
      v_msource := case when v_merchant is null then null else 'default' end;
    end if;
    select default_kind into v_mkind from public.wb_merchants where id = v_merchant;

    -- 1. Clean.
    v_clean := public.wb_clean_description(coalesce(nullif(btrim(t.description), ''), t.payee), v_merchant is not null);

    -- 3. Default kind.
    v_kind    := t.kind;
    v_ksource := t.kind_source;
    if coalesce(t.kind_source, 'default') not in ('claude', 'manual') and t.transfer_pair_id is null then
      v_kind    := public.wb_default_kind(t.account_role, t.amount, t.description, t.payee, v_mkind);
      v_ksource := 'default';
    end if;
    v_p2p := public.wb_is_p2p_phrase(concat_ws(' ', t.description, t.payee));

    update public.wb_transactions
    set clean_description  = v_clean,
        merchant_id        = v_merchant,
        merchant_source    = v_msource,
        kind               = v_kind,
        kind_source        = v_ksource,
        transfer_candidate = false
    where id = t.id;

    -- 4. Transfer pairing: posted rows on household accounts, never claude/manual.
    --    A payment to a person is tried too, but only pairs; it is never a candidate.
    if not t.pending
       and t.transfer_pair_id is null
       and (v_kind = 'transfer' or v_p2p)
       and coalesce(v_ksource, 'default') not in ('claude', 'manual')
       and t.account_source = 'simplefin'
       and t.account_role not in ('closed', 'history_rollup')
    then
      v_date := (coalesce(t.posted_at, t.transacted_at) at time zone 'America/Los_Angeles')::date;

      select count(*)::int into v_fwd
      from public.wb_transactions c
      join public.wb_accounts ca on ca.id = c.account_id
      where c.id <> t.id
        and c.amount = -t.amount
        and not c.pending
        and c.transfer_pair_id is null
        and coalesce(c.kind_source, 'default') not in ('claude', 'manual')
        and ca.source = 'simplefin'
        and ca.role not in ('closed', 'history_rollup')
        and public.wb_transfer_match(t.account_id, t.amount, v_date, c.account_id, c.amount,
              (coalesce(c.posted_at, c.transacted_at) at time zone 'America/Los_Angeles')::date);

      v_rev := 0;
      if v_fwd = 1 then
        select c.id, c.account_id, c.amount,
               (coalesce(c.posted_at, c.transacted_at) at time zone 'America/Los_Angeles')::date as d
        into v_match
        from public.wb_transactions c
        join public.wb_accounts ca on ca.id = c.account_id
        where c.id <> t.id
          and c.amount = -t.amount
          and not c.pending
          and c.transfer_pair_id is null
          and coalesce(c.kind_source, 'default') not in ('claude', 'manual')
          and ca.source = 'simplefin'
          and ca.role not in ('closed', 'history_rollup')
          and public.wb_transfer_match(t.account_id, t.amount, v_date, c.account_id, c.amount,
                (coalesce(c.posted_at, c.transacted_at) at time zone 'America/Los_Angeles')::date);

        select count(*)::int into v_rev
        from public.wb_transactions c
        join public.wb_accounts ca on ca.id = c.account_id
        where c.id <> v_match.id
          and c.amount = -v_match.amount
          and not c.pending
          and c.transfer_pair_id is null
          and coalesce(c.kind_source, 'default') not in ('claude', 'manual')
          and ca.source = 'simplefin'
          and ca.role not in ('closed', 'history_rollup')
          and public.wb_transfer_match(v_match.account_id, v_match.amount, v_match.d, c.account_id, c.amount,
                (coalesce(c.posted_at, c.transacted_at) at time zone 'America/Los_Angeles')::date);
      end if;

      if public.wb_pair_decision(v_fwd, v_rev) = 'pair' then
        update public.wb_transactions
        set transfer_pair_id = v_match.id, kind = 'transfer', kind_source = 'default', transfer_candidate = false
        where id = t.id;
        update public.wb_transactions
        set transfer_pair_id = t.id, kind = 'transfer', kind_source = 'default', transfer_candidate = false
        where id = v_match.id;
        v_kind     := 'transfer';
        v_ksource  := 'default';
        n_paired   := n_paired + 1;
      elsif v_kind = 'transfer' then
        update public.wb_transactions set transfer_candidate = true where id = t.id;
        n_candidates := n_candidates + 1;
      end if;
    end if;

    -- 5. Rules: posted rows only. Rule tags are replaced; claude/manual tags stay,
    --    and a tag removed by hand (wb_tag_exclusions) is never put back.
    v_matched := '{}';
    if not t.pending then
      select count(*)::int, (array_agg(s.id order by s.position, s.id))[1]
      into v_nsplits, v_split
      from public.wb_splits s
      where s.transaction_id = t.id;

      delete from public.wb_split_tags st
      using public.wb_splits s
      where st.split_id = s.id and s.transaction_id = t.id and st.source = 'rule';

      select x.kind, x.kind_source, x.merchant_id, x.merchant_source, x.transfer_pair_id, x.clean_description
      into cur
      from public.wb_transactions x
      where x.id = t.id;

      for r in
        select * from public.wb_rules where active order by priority, created_at, id
      loop
        continue when not public.wb_rule_matches(r.match, t.account_id, t.amount, t.payee, t.description,
                                                 cur.clean_description, cur.merchant_id, cur.kind);
        v_matched := v_matched || r.id;

        if r.set_kind is not null
           and coalesce(cur.kind_source, 'default') not in ('claude', 'manual')
           and cur.transfer_pair_id is null
        then
          update public.wb_transactions set kind = r.set_kind, kind_source = 'rule' where id = t.id;
          cur.kind := r.set_kind;
          cur.kind_source := 'rule';
        end if;

        if r.set_merchant_id is not null and coalesce(cur.merchant_source, 'default') not in ('claude', 'manual') then
          update public.wb_transactions set merchant_id = r.set_merchant_id, merchant_source = 'rule' where id = t.id;
          cur.merchant_id := r.set_merchant_id;
          cur.merchant_source := 'rule';
        end if;

        -- Tags only on a single-split transaction; multi-split ones are left to people.
        if v_nsplits = 1 then
          for v_tag in
            select tg.id, tg.group_id, g.exclusive
            from unnest(r.add_tag_ids) with ordinality as x(tag_id, ord)
            join public.wb_tags tg on tg.id = x.tag_id and tg.is_active
            join public.wb_tag_groups g on g.id = tg.group_id
            order by x.ord
          loop
            continue when exists (
              select 1 from public.wb_tag_exclusions e where e.transaction_id = t.id and e.tag_id = v_tag.id);
            continue when v_tag.exclusive and exists (
              select 1 from public.wb_split_tags where split_id = v_split and group_id = v_tag.group_id);
            insert into public.wb_split_tags (split_id, tag_id, source, rule_id)
            values (v_split, v_tag.id, 'rule', r.id)
            on conflict (split_id, tag_id) do nothing;
            if found then
              n_tags := n_tags + 1;
            end if;
          end loop;
        end if;
      end loop;
    end if;

    -- 6. Done.
    update public.wb_transactions
    set matched_rule_ids = v_matched, processed_at = now()
    where id = t.id;
    n_processed := n_processed + 1;
  end loop;

  -- Rule hit counts, recomputed (not incremented) and written only when changed.
  with h as (
    select ru.id,
           count(x.id)::int as n,
           max(coalesce(x.posted_at, x.transacted_at)) as last_hit
    from public.wb_rules ru
    left join public.wb_transactions x on ru.id = any(x.matched_rule_ids)
    group by ru.id
  )
  update public.wb_rules ru
  set hit_count = h.n, last_hit_at = h.last_hit
  from h
  where ru.id = h.id
    and (ru.hit_count is distinct from h.n or ru.last_hit_at is distinct from h.last_hit);
  get diagnostics n_rules = row_count;

  return jsonb_build_object(
    'processed', n_processed,
    'paired', n_paired,
    'transfer_candidates', n_candidates,
    'rule_tags', n_tags,
    'rules_updated', n_rules);
end;
$$;

comment on function public.wb_process_transactions(uuid[]) is
  'Warren Buffet: clean, merchant, default kind, transfer pairing and rules for the given transactions (spec §5). Security invoker. Never changes a claude or manual kind, merchant or tag, and never puts back a tag removed by hand (wb_tag_exclusions); pairs and tags posted rows only; a payment to a person pairs only on a unique match and is never a transfer candidate. Safe to re-run. Returns counts.';

-- ============================================================================
-- 3. wb_apply_tags: as in 108, plus — removal writes an exclusion (with the
--    rule that had applied the tag); adding a tag back clears its exclusion.
-- ============================================================================
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
  v_rm         uuid;
  v_had        boolean;
  v_old_id     uuid;
  v_old_tag    uuid;
  v_old_source text;
  v_old_rule   uuid;
  n_added      int := 0;
  n_replaced   int := 0;
  n_removed    int := 0;
  n_excluded   int := 0;
  n_restored   int := 0;
  v_multi      uuid[] := '{}';
  v_missing    uuid[] := '{}';
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

    -- Removals: delete the tag and remember it, so no rule puts it back.
    foreach v_rm in array coalesce(p_remove_tag_ids, '{}')
    loop
      v_old_source := null; v_old_rule := null;
      delete from public.wb_split_tags
      where split_id = v_split and tag_id = v_rm
      returning source, coalesce(rule_id, replaced_rule_id) into v_old_source, v_old_rule;
      if found then
        n_removed := n_removed + 1;
      end if;
      insert into public.wb_tag_exclusions (transaction_id, tag_id, rule_id, source)
      values (v_tid, v_rm, v_old_rule, p_source)
      on conflict (transaction_id, tag_id) do update
        set rule_id = coalesce(excluded.rule_id, public.wb_tag_exclusions.rule_id),
            source = excluded.source, removed_by = auth.uid(), created_at = now();
      n_excluded := n_excluded + 1;
    end loop;

    for tg in
      select x.id, x.group_id, g.exclusive
      from public.wb_tags x join public.wb_tag_groups g on g.id = x.group_id
      where x.id = any (coalesce(p_tag_ids, '{}'))
    loop
      -- Added back by hand: the removal no longer applies.
      delete from public.wb_tag_exclusions where transaction_id = v_tid and tag_id = tg.id;
      if found then
        n_restored := n_restored + 1;
      end if;

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
                            'excluded', n_excluded, 'restored', n_restored,
                            'skipped_multi_split', to_jsonb(v_multi), 'not_found', to_jsonb(v_missing));
end;
$$;

comment on function public.wb_apply_tags(uuid[], uuid[], text, uuid[]) is
  'Warren Buffet: add tags (source claude or manual) to, and remove tags from, the single split of each transaction. An exclusive group''s new tag replaces the old one; a replaced or taken-over rule tag is recorded in replaced_rule_id. A removal is recorded in wb_tag_exclusions so no rule puts the tag back; adding the tag back by hand clears it. Multi-split transactions are skipped: use wb_replace_splits.';

-- ============================================================================
-- 4. wb_replace_splits: as in 108, plus — a tag it adds by hand clears that
--    tag's exclusion for the transaction.
-- ============================================================================
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

  -- Tags put on by hand here are wanted again: their removals no longer apply.
  delete from public.wb_tag_exclusions x
  where x.transaction_id = p_transaction_id
    and x.tag_id in (
      select t.tag_id::uuid
      from jsonb_array_elements(p_splits) sp(s)
      cross join lateral jsonb_array_elements_text(coalesce(sp.s -> 'tag_ids', '[]'::jsonb)) as t(tag_id));

  return jsonb_build_object('transaction_id', p_transaction_id, 'splits', (
    select jsonb_agg(jsonb_build_object('id', s.id, 'position', s.position, 'amount', s.amount,
             'description', s.description, 'tax_year', s.tax_year,
             'tag_ids', coalesce((select jsonb_agg(st.tag_id) from public.wb_split_tags st where st.split_id = s.id), '[]'::jsonb))
           order by s.position)
    from public.wb_splits s where s.transaction_id = p_transaction_id));
end;
$$;

comment on function public.wb_replace_splits(uuid, jsonb, text) is
  'Warren Buffet: replace all splits of one transaction, with their tags (source claude or manual), in one transaction. Amounts must sum to the transaction amount. A tag added here by hand clears its wb_tag_exclusions row.';

-- ============================================================================
-- 5. wb_transaction_list: as in 108, plus excluded_tags at the end
-- ============================================================================
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
  )                                                                                  as needs_review,
  coalesce((
    select jsonb_agg(jsonb_build_object(
             'tag_id', e.tag_id, 'tag_name', tg.name, 'rule_id', e.rule_id,
             'source', e.source, 'removed_at', e.created_at)
           order by tg.name)
    from public.wb_tag_exclusions e
    join public.wb_tags tg on tg.id = e.tag_id
    where e.transaction_id = x.id
  ), '[]'::jsonb)                                                                    as excluded_tags
from public.wb_transactions x
join public.wb_accounts a on a.id = x.account_id
left join public.wb_merchants m on m.id = x.merchant_id;

comment on view public.wb_transaction_list is
  'App: Warren Buffet. Transactions with account label, merchant name, tag_names (text[], filter with overlaps), split_count, needs_review (true when the row is in wb_review_queue) and excluded_tags (tags removed by hand, which no rule puts back: tag_id, tag_name, rule_id, source, removed_at). No raw jsonb. security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 6. Register with the platform, then the shared-context policy (mirrors intents)
-- ============================================================================
select platform.register_table(
  'public.wb_tag_exclusions',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. Tags removed from a transaction by hand, so rules never put them back. Owner OR shared-context RLS (mirrors intents).'
);

drop policy if exists wb_tag_exclusions_access on public.wb_tag_exclusions;
create policy wb_tag_exclusions_access on public.wb_tag_exclusions
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

commit;

-- ============================================================================
-- 7. Conformance: this is the result the SQL editor shows. Expect conformant
--    true and failures []. Then run the tag-exclusion test file.
-- ============================================================================
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t)
) as result;
