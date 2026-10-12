-- Purpose: Warren Buffet Phase 2, Step 7a (Migration B). Subscriptions: wb_subscriptions and wb_subscription_prices; wb_transactions.subscription_id and subscription_source; wb_merchants.not_subscription. wb_process_transactions links posted spend charges to their merchant's subscription (by price, within amount_tolerance, when the merchant has several) and keeps last_charged_on / next_expected_on current. wb_detect_subscriptions (called by wb-sync after processing) creates watching rows for monthly charges of similar size. wb_review_queue gains price_change and new_recurring; wb_subscription_overview shows the current price and overdue subscriptions.
-- Kind: schema change (two tables, three columns, five new functions, one replaced function, two replaced views, one new view)
-- Applied: YES — 2026-10-12 by Alex. Conformance passed; 121 all 39 checks true.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p2-m4t.md sections 4.8, 4.9 and 8 (Step 7).
-- No real financial data in this file. Run as one block, then 121_wb_phase2_step7_tests.sql;
-- check_platform_conformance must report CONFORMANT.
-- supabase/migrations/120_wb_phase2_step7_subscriptions.sql

begin;

-- ============================================================================
-- 1. wb_subscriptions
-- ============================================================================
create table if not exists public.wb_subscriptions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id        text not null references public.contexts(id),
  name              text not null,
  plan              text,
  merchant_id       uuid references public.wb_merchants(id) on delete set null,
  billed_through_id uuid references public.wb_subscriptions(id) on delete set null,
  bundle_id         uuid references public.wb_subscriptions(id) on delete set null,
  cadence           text not null default 'monthly',
  expected_amount   numeric(12,2),
  amount_tolerance  numeric(12,2) not null default 0,
  term_end_date     date,
  auto_renew        boolean,
  review_date       date,
  last_charged_on   date,
  next_expected_on  date,
  status            text not null default 'watching',
  owner             text,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint wb_subscriptions_name_check check (btrim(name) <> ''),
  constraint wb_subscriptions_cadence_check check (cadence in ('monthly', 'quarterly', 'annual', 'other')),
  constraint wb_subscriptions_status_check check (status in ('watching', 'active', 'paused', 'cancelled')),
  constraint wb_subscriptions_owner_check check (owner is null or owner in ('alex', 'elise', 'joint')),
  constraint wb_subscriptions_expected_check check (expected_amount is null or expected_amount > 0),
  constraint wb_subscriptions_tolerance_check check (amount_tolerance >= 0),
  constraint wb_subscriptions_billed_through_check check (billed_through_id is null or billed_through_id <> id),
  constraint wb_subscriptions_bundle_check check (bundle_id is null or bundle_id <> id)
);

create index if not exists wb_subscriptions_merchant_idx on public.wb_subscriptions (merchant_id);

comment on table public.wb_subscriptions is
  'App: Warren Buffet. The record of a recurring service: plan, cadence, prepaid term, auto-renew, review date, billed-through and bundle links, status and notes. The Subscription Label tag stays the per-transaction marker. Charges link through wb_transactions.subscription_id. Insurance gets no row (its merchants are not_subscription). Amounts are positive.';
comment on column public.wb_subscriptions.amount_tolerance is 'A charge within this many dollars of the current price counts as that price, for linking and for price_change. 0 = exact cents.';
comment on column public.wb_subscriptions.term_end_date is 'End of a prepaid term. No charge is expected, and none is overdue, before this date.';
comment on column public.wb_subscriptions.last_charged_on is 'Kept by processing: the Pacific date of the newest posted linked charge.';
comment on column public.wb_subscriptions.next_expected_on is 'Kept by processing: last_charged_on plus the cadence, or term_end_date when that is later. Null for cadence other with no term.';
comment on column public.wb_subscriptions.status is 'watching = detected, not yet confirmed; active; paused; cancelled. Cancelled rows get no new charges linked.';

-- Owner and context: given, or copied from the merchant (the sync and SQL editor have no auth.uid()).
create or replace function public.wb_subscriptions_fill_owner()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.merchant_id is not null and (new.context_id is null or new.user_id is null) then
    select coalesce(new.user_id, m.user_id), coalesce(new.context_id, m.context_id)
    into new.user_id, new.context_id
    from public.wb_merchants m
    where m.id = new.merchant_id;
  end if;
  return new;
end;
$$;

drop trigger if exists wb_subscriptions_fill_owner on public.wb_subscriptions;
create trigger wb_subscriptions_fill_owner before insert on public.wb_subscriptions
  for each row execute function public.wb_subscriptions_fill_owner();

drop trigger if exists wb_subscriptions_touch_updated_at on public.wb_subscriptions;
create trigger wb_subscriptions_touch_updated_at before update on public.wb_subscriptions
  for each row execute function public.wb_touch_updated_at();

-- ============================================================================
-- 2. wb_subscription_prices
-- ============================================================================
create table if not exists public.wb_subscription_prices (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id      text not null references public.contexts(id),
  subscription_id uuid not null references public.wb_subscriptions(id) on delete cascade,
  effective_on    date not null,
  amount          numeric(12,2) not null,
  source          text not null default 'manual',
  transaction_id  uuid references public.wb_transactions(id) on delete set null,
  notes           text,
  created_at      timestamptz not null default now(),

  constraint wb_subscription_prices_day_key unique (subscription_id, effective_on),
  constraint wb_subscription_prices_amount_check check (amount > 0),
  constraint wb_subscription_prices_source_check check (source in ('detected', 'claude', 'manual'))
);

comment on table public.wb_subscription_prices is
  'App: Warren Buffet. One row per price change of a subscription, positive amounts. The price on a date is the newest row on or before it (else the oldest row, else expected_amount). A charge that differs by more than amount_tolerance is flagged price_change in wb_review_queue, never accepted automatically: recording the new price here clears it. user_id and context_id are copied from the subscription by trigger.';

create or replace function public.wb_subscription_prices_copy_owner()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  select s.user_id, s.context_id into new.user_id, new.context_id
  from public.wb_subscriptions s
  where s.id = new.subscription_id;
  if not found then
    raise exception 'wb_subscription_prices: subscription % not found', new.subscription_id using errcode = '23503';
  end if;
  return new;
end;
$$;

drop trigger if exists wb_subscription_prices_copy_owner on public.wb_subscription_prices;
create trigger wb_subscription_prices_copy_owner before insert or update on public.wb_subscription_prices
  for each row execute function public.wb_subscription_prices_copy_owner();

-- ============================================================================
-- 3. New columns
-- ============================================================================
alter table public.wb_merchants add column if not exists not_subscription boolean not null default false;
comment on column public.wb_merchants.not_subscription is
  'True when this merchant''s regular charges are not a subscription (insurance, HOA, a store): detection skips it and its watching row leaves the review queue. Set when a detection is dismissed.';

alter table public.wb_transactions
  add column if not exists subscription_id uuid references public.wb_subscriptions(id) on delete set null,
  add column if not exists subscription_source text;
alter table public.wb_transactions drop constraint if exists wb_transactions_subscription_source_check;
alter table public.wb_transactions add constraint wb_transactions_subscription_source_check
  check (subscription_source is null or subscription_source in ('default', 'claude', 'manual'));
create index if not exists wb_transactions_subscription_idx on public.wb_transactions (subscription_id);
comment on column public.wb_transactions.subscription_source is
  'default = linked by processing or detection; claude or manual = set by hand (wb_link_subscription), never changed by processing, including a hand unlink (subscription_id null).';

-- ============================================================================
-- 4. Helpers
-- ============================================================================
create or replace function public.wb_subscription_price_on(p_subscription_id uuid, p_on date)
returns numeric
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(
    (select p.amount from public.wb_subscription_prices p
     where p.subscription_id = p_subscription_id and p.effective_on <= p_on
     order by p.effective_on desc limit 1),
    (select p.amount from public.wb_subscription_prices p
     where p.subscription_id = p_subscription_id
     order by p.effective_on limit 1),
    (select s.expected_amount from public.wb_subscriptions s where s.id = p_subscription_id));
$$;

comment on function public.wb_subscription_price_on(uuid, date) is
  'Warren Buffet: a subscription''s price on a date: the newest price row on or before it, else the oldest row, else expected_amount. Positive.';

-- last_charged_on and next_expected_on, written only when changed (so a reprocess audits nothing new).
create or replace function public.wb_refresh_subscriptions(p_ids uuid[])
returns int
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  n int;
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;
  with last as (
    select s.id, s.cadence, s.term_end_date,
           max((coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date) as last_on
    from public.wb_subscriptions s
    left join public.wb_transactions x on x.subscription_id = s.id and not x.pending
    where s.id = any (p_ids)
    group by s.id
  ),
  nxt as (
    select l.id, l.last_on,
           (case l.cadence
              when 'monthly'   then l.last_on + interval '1 month'
              when 'quarterly' then l.last_on + interval '3 months'
              when 'annual'    then l.last_on + interval '1 year'
            end)::date as base,
           l.term_end_date
    from last l
  )
  update public.wb_subscriptions s
  set last_charged_on  = n2.last_on,
      next_expected_on = case when n2.term_end_date is not null and (n2.base is null or n2.term_end_date > n2.base)
                              then n2.term_end_date else n2.base end
  from nxt n2
  where s.id = n2.id
    and (s.last_charged_on is distinct from n2.last_on
         or s.next_expected_on is distinct from
            case when n2.term_end_date is not null and (n2.base is null or n2.term_end_date > n2.base)
                 then n2.term_end_date else n2.base end);
  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function public.wb_refresh_subscriptions(uuid[]) is
  'Warren Buffet: recompute last_charged_on and next_expected_on for the given subscriptions, writing only rows that change. Security invoker.';

-- ============================================================================
-- 5. wb_process_transactions: as in 114, plus step 5b — link a posted spend
--    charge to its merchant's subscription — and refreshing the touched rows.
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
  v_sub        uuid;
  v_nsubs      int;
  v_subs       uuid[] := '{}';
  n_processed  int := 0;
  n_paired     int := 0;
  n_candidates int := 0;
  n_tags       int := 0;
  n_rules      int := 0;
  n_linked     int := 0;
begin
  if ids is null or cardinality(ids) = 0 then
    return jsonb_build_object('processed', 0, 'paired', 0, 'transfer_candidates', 0, 'rule_tags', 0, 'rules_updated', 0,
                              'subscriptions_linked', 0);
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

    v_date := (coalesce(t.posted_at, t.transacted_at) at time zone 'America/Los_Angeles')::date;

    -- 4. Transfer pairing: posted rows on household accounts, never claude/manual.
    --    A payment to a person is tried too, but only pairs; it is never a candidate.
    if not t.pending
       and t.transfer_pair_id is null
       and (v_kind = 'transfer' or v_p2p)
       and coalesce(v_ksource, 'default') not in ('claude', 'manual')
       and t.account_source = 'simplefin'
       and t.account_role not in ('closed', 'history_rollup')
    then
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

      -- 5b. Subscription: a posted spend charge links to its merchant's one
      --     non-cancelled subscription, or, when it has several, to the one whose
      --     price is within its tolerance. Hand links (claude/manual) stay.
      if coalesce(t.subscription_source, 'default') not in ('claude', 'manual') then
        v_sub := null;
        if cur.kind = 'spend' and t.amount < 0 and cur.merchant_id is not null then
          select count(*)::int, (array_agg(s.id))[1] into v_nsubs, v_sub
          from public.wb_subscriptions s
          where s.merchant_id = cur.merchant_id and s.status <> 'cancelled';
          if v_nsubs > 1 then
            select count(*)::int, (array_agg(s.id))[1] into v_nsubs, v_sub
            from public.wb_subscriptions s
            where s.merchant_id = cur.merchant_id and s.status <> 'cancelled'
              and abs(-t.amount - public.wb_subscription_price_on(s.id, v_date)) <= s.amount_tolerance;
            if v_nsubs <> 1 then
              v_sub := null;
            end if;
          end if;
        end if;
        if v_sub is distinct from t.subscription_id then
          update public.wb_transactions
          set subscription_id = v_sub, subscription_source = case when v_sub is null then null else 'default' end
          where id = t.id;
          if v_sub is not null then
            n_linked := n_linked + 1;
          end if;
        end if;
      end if;
    end if;
    if t.subscription_id is not null then
      v_subs := v_subs || t.subscription_id;
    end if;
    if v_sub is not null then
      v_subs := v_subs || v_sub;
    end if;
    v_sub := null;

    -- 6. Done.
    update public.wb_transactions
    set matched_rule_ids = v_matched, processed_at = now()
    where id = t.id;
    n_processed := n_processed + 1;
  end loop;

  perform public.wb_refresh_subscriptions(v_subs);

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
    'rules_updated', n_rules,
    'subscriptions_linked', n_linked);
end;
$$;

comment on function public.wb_process_transactions(uuid[]) is
  'Warren Buffet: clean, merchant, default kind, transfer pairing, rules and subscription links for the given transactions (spec §5, §4.8). Security invoker. Never changes a claude or manual kind, merchant, tag or subscription link, and never puts back a tag removed by hand (wb_tag_exclusions); pairs, tags and links posted rows only; a payment to a person pairs only on a unique match and is never a transfer candidate. Safe to re-run. Returns counts.';

-- ============================================================================
-- 6. wb_detect_subscriptions: monthly charges of similar size become watching rows
-- ============================================================================
create or replace function public.wb_detect_subscriptions(p_today date default null)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_today   date := coalesce(p_today, (now() at time zone 'America/Los_Angeles')::date);
  g         record;
  v_ok      boolean;
  v_sub     uuid;
  v_created uuid[] := '{}';
  n_linked  int := 0;
  n_rows    int;
begin
  for g in
    with c as (
      select x.id, x.merchant_id,
             (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date as d,
             -x.amount as a
      from public.wb_transactions x
      join public.wb_merchants m on m.id = x.merchant_id
      where not x.pending
        and x.kind = 'spend'
        and x.amount < 0
        and x.subscription_id is null
        and coalesce(x.subscription_source, 'default') not in ('claude', 'manual')
        and not m.not_subscription
        and not exists (select 1 from public.wb_subscriptions s where s.merchant_id = x.merchant_id)
    )
    select c.merchant_id,
           count(*)::int                                                  as n,
           (percentile_cont(0.5) within group (order by c.a))::numeric    as med,
           array_agg(c.id order by c.d, c.id)                             as ids,
           array_agg(c.d order by c.d, c.id)                              as ds,
           array_agg(c.a order by c.d, c.id)                              as amts
    from c
    where c.d between v_today - 120 and v_today
    group by c.merchant_id
    having count(*) >= 3
  loop
    -- About a month apart, every time, and each within 10% of the median.
    v_ok := true;
    for i in 2 .. g.n loop
      if g.ds[i] - g.ds[i - 1] not between 26 and 35 then
        v_ok := false;
      end if;
    end loop;
    for i in 1 .. g.n loop
      if abs(g.amts[i] - g.med) > 0.10 * g.med then
        v_ok := false;
      end if;
    end loop;
    continue when not v_ok;

    insert into public.wb_subscriptions (user_id, context_id, name, merchant_id, cadence, expected_amount, status, notes)
    select m.user_id, m.context_id, m.name, m.id, 'monthly', g.amts[g.n], 'watching',
           format('Detected %s from %s monthly charges.', v_today, g.n)
    from public.wb_merchants m
    where m.id = g.merchant_id
    returning id into v_sub;

    insert into public.wb_subscription_prices (subscription_id, effective_on, amount, source, transaction_id)
    values (v_sub, g.ds[g.n], g.amts[g.n], 'detected', g.ids[g.n]);

    update public.wb_transactions
    set subscription_id = v_sub, subscription_source = 'default'
    where id = any (g.ids);
    get diagnostics n_rows = row_count;
    n_linked  := n_linked + n_rows;
    v_created := v_created || v_sub;
  end loop;

  perform public.wb_refresh_subscriptions(v_created);
  return jsonb_build_object('created', cardinality(v_created), 'linked', n_linked);
end;
$$;

comment on function public.wb_detect_subscriptions(date) is
  'Warren Buffet: called by wb-sync after processing. For each merchant with no subscription row and not marked not_subscription: 3 or more posted, unlinked spend charges in the last 120 days, each 26-35 days after the one before and within 10% of their median, become a watching subscription (monthly, price = the latest charge, source detected) and are linked to it. Security invoker. Returns created and linked counts.';

-- ============================================================================
-- 7. wb_link_subscription: link or unlink transactions by hand
-- ============================================================================
create or replace function public.wb_link_subscription(
  p_transaction_ids uuid[],
  p_subscription_id uuid,
  p_source          text default 'manual')
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_old uuid[];
  n     int;
begin
  if p_source is null or p_source not in ('claude', 'manual') then
    raise exception 'wb_link_subscription: source must be claude or manual' using errcode = '22023';
  end if;
  if p_transaction_ids is null or cardinality(p_transaction_ids) = 0 then
    raise exception 'wb_link_subscription: give at least one transaction' using errcode = '22023';
  end if;
  if p_subscription_id is not null
     and not exists (select 1 from public.wb_subscriptions where id = p_subscription_id) then
    raise exception 'wb_link_subscription: no subscription % that you can see', p_subscription_id using errcode = '23503';
  end if;

  select coalesce(array_agg(distinct x.subscription_id) filter (where x.subscription_id is not null), '{}')
  into v_old
  from public.wb_transactions x
  where x.id = any (p_transaction_ids);

  update public.wb_transactions
  set subscription_id = p_subscription_id, subscription_source = p_source
  where id = any (p_transaction_ids);
  get diagnostics n = row_count;
  if n < cardinality(p_transaction_ids) then
    raise exception 'wb_link_subscription: a transaction id does not exist or you cannot see it' using errcode = '23503';
  end if;

  perform public.wb_refresh_subscriptions(v_old || p_subscription_id);
  return jsonb_build_object('linked', case when p_subscription_id is null then 0 else n end,
                            'unlinked', case when p_subscription_id is null then n else 0 end);
end;
$$;

comment on function public.wb_link_subscription(uuid[], uuid, text) is
  'Warren Buffet: link transactions to a subscription by hand (null unlinks), with source claude or manual, so processing never changes the link. Refreshes the old and new subscriptions'' dates. Security invoker.';

-- ============================================================================
-- 8. wb_review_queue: as in 103, plus price_change and new_recurring
-- ============================================================================
create or replace view public.wb_review_queue
with (security_invoker = true) as
with base as (
  select
    x.id                                                                       as transaction_id,
    x.account_id,
    coalesce(a.display_name, a.name)                                           as account_label,
    (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date as txn_date,
    x.amount,
    x.description,
    x.clean_description,
    x.payee,
    x.merchant_id,
    m.name                                                                     as merchant_name,
    x.merchant_source,
    x.kind,
    x.kind_source,
    x.pending,
    x.reviewed,
    x.transfer_candidate,
    x.transfer_pair_id
  from public.wb_transactions x
  join public.wb_accounts a on a.id = x.account_id
  left join public.wb_merchants m on m.id = x.merchant_id
),
reasons as (
  select b.transaction_id, 'no_kind'::text as reason, null::text as detail
  from base b
  where b.kind is null
  union all
  select b.transaction_id, 'missing_required_tag', g.name
  from base b
  join public.wb_tag_groups g on b.kind = any (g.required_for_kinds)
  where not b.pending
    and not b.reviewed
    and exists (
      select 1 from public.wb_splits s
      where s.transaction_id = b.transaction_id
        and not exists (select 1 from public.wb_split_tags st where st.split_id = s.id and st.group_id = g.id))
  union all
  select b.transaction_id, 'transfer_candidate', null
  from base b
  where b.transfer_candidate and b.transfer_pair_id is null and not b.pending and not b.reviewed
  union all
  select b.transaction_id, 'split_mismatch', format('%s split(s) sum to %s', coalesce(s.n, 0), coalesce(s.total, 0))
  from base b
  left join lateral (
    select count(*) as n, sum(sp.amount) as total from public.wb_splits sp where sp.transaction_id = b.transaction_id
  ) s on true
  where coalesce(s.n, 0) = 0 or s.total <> b.amount
  union all
  -- A charge on an active subscription that differs from its price by more than the tolerance.
  select b.transaction_id, 'price_change', format('%s: expected %s', s.name, p.price)
  from base b
  join public.wb_transactions x on x.id = b.transaction_id
  join public.wb_subscriptions s on s.id = x.subscription_id
  cross join lateral (select public.wb_subscription_price_on(s.id, b.txn_date) as price) p
  where s.status = 'active'
    and not b.pending
    and not b.reviewed
    and abs(-b.amount - p.price) > s.amount_tolerance
  union all
  -- The newest charge of each detected (watching) subscription, until it is confirmed or dismissed.
  select lc.id, 'new_recurring', s.name
  from public.wb_subscriptions s
  left join public.wb_merchants m on m.id = s.merchant_id
  cross join lateral (
    select x.id from public.wb_transactions x
    where x.subscription_id = s.id and not x.pending
    order by coalesce(x.posted_at, x.transacted_at) desc, x.id desc
    limit 1
  ) lc
  where s.status = 'watching'
    and not coalesce(m.not_subscription, false)
)
select
  r.reason,
  r.detail,
  b.*,
  coalesce((
    select array_agg(distinct tg.name order by tg.name)
    from public.wb_splits s
    join public.wb_split_tags st on st.split_id = s.id
    join public.wb_tags tg on tg.id = st.tag_id
    where s.transaction_id = b.transaction_id
  ), '{}'::text[]) as tag_names
from reasons r
join base b on b.transaction_id = r.transaction_id;

comment on view public.wb_review_queue is
  'App: Warren Buffet. One row per transaction and reason: no_kind, missing_required_tag (detail = group), transfer_candidate, split_mismatch, price_change (detail = subscription and expected price; active subscriptions, cleared by recording the new price or marking reviewed) and new_recurring (detail = subscription; the newest charge of a watching subscription, cleared by confirming or dismissing it). Tag, transfer and price reasons cover posted, unreviewed rows only; split_mismatch shows even when reviewed. security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 9. wb_transaction_list: as in 117, needs_review covers the two new reasons,
--    plus subscription_id, subscription_source and subscription_name at the end
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
    or (not x.pending and not x.reviewed and sub.status = 'active'
        and abs(-x.amount - public.wb_subscription_price_on(sub.id,
              (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date)) > sub.amount_tolerance)
    or (not x.pending and sub.status = 'watching'
        and not coalesce((select sm.not_subscription from public.wb_merchants sm where sm.id = sub.merchant_id), false)
        and x.id = (select y.id from public.wb_transactions y
                    where y.subscription_id = sub.id and not y.pending
                    order by coalesce(y.posted_at, y.transacted_at) desc, y.id desc limit 1))
  ) is true                                                                          as needs_review,
  coalesce((
    select jsonb_agg(jsonb_build_object(
             'tag_id', e.tag_id, 'tag_name', tg.name, 'rule_id', e.rule_id,
             'source', e.source, 'removed_at', e.created_at)
           order by tg.name)
    from public.wb_tag_exclusions e
    join public.wb_tags tg on tg.id = e.tag_id
    where e.transaction_id = x.id
  ), '[]'::jsonb)                                                                    as excluded_tags,
  x.notes,
  x.subscription_id,
  x.subscription_source,
  sub.name                                                                           as subscription_name
from public.wb_transactions x
join public.wb_accounts a on a.id = x.account_id
left join public.wb_merchants m on m.id = x.merchant_id
left join public.wb_subscriptions sub on sub.id = x.subscription_id;

comment on view public.wb_transaction_list is
  'App: Warren Buffet. Transactions with account label, merchant name, tag_names (text[], filter with overlaps), split_count, needs_review (true when the row is in wb_review_queue), excluded_tags (tags removed by hand, which no rule puts back: tag_id, tag_name, rule_id, source, removed_at), notes, and the linked subscription (subscription_id, subscription_source, subscription_name). No raw jsonb. security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 10. wb_subscription_overview: current price, last change, overdue
-- ============================================================================
create or replace view public.wb_subscription_overview
with (security_invoker = true) as
with today as (select (now() at time zone 'America/Los_Angeles')::date as d)
select
  s.id,
  s.name,
  s.plan,
  s.status,
  s.cadence,
  s.merchant_id,
  m.name                                                                    as merchant_name,
  coalesce(m.not_subscription, false)                                       as merchant_not_subscription,
  s.billed_through_id,
  bt.name                                                                   as billed_through_name,
  s.bundle_id,
  bu.name                                                                   as bundle_name,
  public.wb_subscription_price_on(s.id, today.d)                            as current_price,
  pr.previous_price,
  pr.last_change_on,
  pr.price_count,
  s.expected_amount,
  s.amount_tolerance,
  s.term_end_date,
  s.auto_renew,
  s.review_date,
  s.last_charged_on,
  s.next_expected_on,
  (select count(*) from public.wb_transactions x where x.subscription_id = s.id and not x.pending)::int as charge_count,
  -- A missing charge: active, more than 7 days past the expected date, and not
  -- inside a prepaid term (after the term, only when it renews).
  (s.status = 'active'
   and s.next_expected_on is not null
   and today.d > s.next_expected_on + 7
   and (s.term_end_date is null or (today.d > s.term_end_date and s.auto_renew is not false)))
                                                                            as overdue,
  case when s.next_expected_on is not null then today.d - s.next_expected_on end as days_past_expected,
  s.owner,
  s.notes,
  s.created_at,
  s.updated_at
from public.wb_subscriptions s
cross join today
left join public.wb_merchants m on m.id = s.merchant_id
left join public.wb_subscriptions bt on bt.id = s.billed_through_id
left join public.wb_subscriptions bu on bu.id = s.bundle_id
left join lateral (
  select count(*)::int as price_count,
         (array_agg(p.amount order by p.effective_on desc))[2]       as previous_price,
         case when count(*) > 1 then max(p.effective_on) end          as last_change_on
  from public.wb_subscription_prices p
  where p.subscription_id = s.id and p.effective_on <= today.d
) pr on true;

comment on view public.wb_subscription_overview is
  'App: Warren Buffet. One row per subscription with merchant, billed-through and bundle names, current_price (today), previous_price and last_change_on, charge_count, and overdue: active, more than 7 days past next_expected_on, and not before term_end_date (after it, only when auto_renew is not false). Missing charges live here, not in wb_review_queue. security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 11. Grants
-- ============================================================================
grant execute on function public.wb_subscription_price_on(uuid, date) to authenticated, service_role;
grant execute on function public.wb_refresh_subscriptions(uuid[]) to authenticated, service_role;
grant execute on function public.wb_process_transactions(uuid[]) to authenticated, service_role;
grant execute on function public.wb_detect_subscriptions(date) to authenticated, service_role;
grant execute on function public.wb_link_subscription(uuid[], uuid, text) to authenticated, service_role;
grant select on public.wb_review_queue           to authenticated, service_role;
grant select on public.wb_transaction_list       to authenticated, service_role;
grant select on public.wb_subscription_overview  to authenticated, service_role;

-- ============================================================================
-- 12. Register with the platform, then the shared-context policy (mirrors intents)
-- ============================================================================
select platform.register_table(
  'public.wb_subscriptions',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. Subscriptions: the record of each recurring service, its term, review date and links. Owner OR shared-context RLS (mirrors intents).'
);
select platform.register_table(
  'public.wb_subscription_prices',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. Price history per subscription, detected or entered. Owner OR shared-context RLS (mirrors intents).'
);

drop policy if exists wb_subscriptions_access on public.wb_subscriptions;
create policy wb_subscriptions_access on public.wb_subscriptions
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

drop policy if exists wb_subscription_prices_access on public.wb_subscription_prices;
create policy wb_subscription_prices_access on public.wb_subscription_prices
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

commit;

-- ============================================================================
-- 13. Conformance: this is the result the SQL editor shows. Expect conformant
--     true and failures []. Then run 121_wb_phase2_step7_tests.sql.
-- ============================================================================
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t)
) as result;
