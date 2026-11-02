-- Purpose: Warren Buffet Phase 4, Step 8g (run tag warren_buffet_p4-r6d-s8g-c2xn; spec P4-D10). Item category tags (wb_set_order_item_tags); splitting each matched Amazon charge by its items' categories (wb_split_order_charges), marked with wb_splits.from_order; and wb_process_transactions leaving those splits alone.
-- Kind: schema change (three new columns, three new functions, one replaced function)
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p4-r6d.md P4-D10.
-- No real order data in this file. Run as one block, then supabase/tests/warren_buffet_p4/4_item_splits_tests.sql;
-- the conformance result at the end must be conformant true.
-- supabase/migrations/195_item_splits.sql

begin;

-- ============================================================================
-- 1. Columns
-- ============================================================================
alter table public.wb_order_items add column if not exists tag_source text;
alter table public.wb_order_items drop constraint if exists wb_order_items_tag_source_check;
alter table public.wb_order_items add constraint wb_order_items_tag_source_check check (
  (tag_id is null and tag_source is null)
  or (tag_id is not null and tag_source is not null and tag_source in ('claude', 'manual')));
comment on column public.wb_order_items.tag_source is 'Who set the category: claude or manual. Empty until it is set.';

alter table public.wb_splits add column if not exists from_order boolean not null default false;
comment on column public.wb_splits.from_order is
  'True when wb_split_order_charges made this split from order detail. Tag rules and wb_process_transactions leave these alone (P4-D10).';

alter table public.wb_order_matches add column if not exists split_state jsonb;
comment on column public.wb_order_matches.split_state is
  'The charge''s splits as wb_split_order_charges left them. If they differ next run, someone changed them by hand and the charge is left alone.';

-- ============================================================================
-- 2. Setting an item's category
-- ============================================================================
create or replace function public.wb_set_order_item_tags(
  p_tag_id uuid,
  p_item_ids uuid[] default null,
  p_asin text default null,
  p_site text default null,
  p_source text default 'claude')
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  n int;
begin
  if p_source is null or p_source not in ('claude', 'manual') then
    raise exception 'wb_set_order_item_tags: source must be claude or manual' using errcode = '22023';
  end if;
  if num_nonnulls(p_item_ids, p_asin, p_site) <> 1 then
    raise exception 'wb_set_order_item_tags: pass exactly one of item ids, an ASIN or a site' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.wb_tags t join public.wb_tag_groups g on g.id = t.group_id
    where t.id = p_tag_id and t.is_active and g.name = 'Category'
  ) then
    raise exception 'wb_set_order_item_tags: the tag must be an active tag in the Category group' using errcode = '23514';
  end if;

  update public.wb_order_items i
  set tag_id = p_tag_id, tag_source = p_source
  where (p_item_ids is not null and i.id = any (p_item_ids))
     or (p_asin is not null and i.asin = p_asin)
     or (p_site is not null and i.site = p_site and i.tag_id is null);
  get diagnostics n = row_count;
  return jsonb_build_object('updated', n);
end;
$$;

comment on function public.wb_set_order_item_tags(uuid, uuid[], text, text, text) is
  'Warren Buffet: sets the Category tag on items by ids, on every row of one ASIN, or on every untagged item of one site. It does not change any charge; run wb_split_order_charges for that.';
revoke all on function public.wb_set_order_item_tags(uuid, uuid[], text, text, text) from public, anon;
grant execute on function public.wb_set_order_item_tags(uuid, uuid[], text, text, text) to authenticated, service_role;

-- ============================================================================
-- 3. A charge's splits as a comparable value
-- ============================================================================
create or replace function public.wb_order_split_state(p_transaction_id uuid)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(x.v order by x.a, x.t), '[]'::jsonb)
  from (
    select s.amount as a,
           coalesce((select string_agg(st.tag_id::text, ',' order by st.tag_id) from public.wb_split_tags st where st.split_id = s.id), '') as t,
           jsonb_build_object('amount', s.amount,
             'tags', coalesce((select jsonb_agg(st.tag_id order by st.tag_id) from public.wb_split_tags st where st.split_id = s.id), '[]'::jsonb)) as v
    from public.wb_splits s
    where s.transaction_id = p_transaction_id
  ) x;
$$;

comment on function public.wb_order_split_state(uuid) is
  'Warren Buffet: one transaction''s splits (amounts and tags) in a stable order, so wb_split_order_charges can tell whether anyone changed them.';
revoke all on function public.wb_order_split_state(uuid) from public, anon;
grant execute on function public.wb_order_split_state(uuid) to authenticated, service_role;

-- ============================================================================
-- 4. Splitting matched Amazon charges
-- ============================================================================
-- Each line_amount already holds that line's tax, shipping and discounts, so spreading by
-- it spreads them in proportion. Largest remainder makes the splits sum exactly.
create or replace function public.wb_split_order_charges(p_transaction_ids uuid[] default null)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  m            record;
  v_unsorted   uuid;
  v_category   uuid;
  v_amount     numeric;
  v_order      numeric;
  v_cents      bigint;
  v_old        uuid[];
  v_tags       uuid[];
  v_shares     bigint[];
  v_keep       jsonb;
  v_same       boolean;
  v_split      uuid;
  i            int;
  n_split      int := 0;
  n_unchanged  int := 0;
  v_hand_split uuid[] := '{}';
  v_hand_tag   uuid[] := '{}';
  v_linked     uuid[] := '{}';
  v_changed    uuid[] := '{}';
  v_failed     uuid[] := '{}';
begin
  select t.id, g.id into v_unsorted, v_category
  from public.wb_tags t join public.wb_tag_groups g on g.id = t.group_id
  where t.name = 'Amazon (unsorted)' and g.name = 'Category';
  if v_unsorted is null then
    raise exception 'wb_split_order_charges: the tag Amazon (unsorted) was not found in the Category group' using errcode = '23503';
  end if;

  for m in
    select x.id as match_id, x.order_id, x.transaction_id, x.split_state
    from public.wb_order_matches x
    where p_transaction_ids is null or x.transaction_id = any (p_transaction_ids)
    order by x.transaction_id
  loop
    begin
      select t.amount into v_amount from public.wb_transactions t where t.id = m.transaction_id for update;
      select o.amount into v_order from public.wb_orders o where o.id = m.order_id;
      if v_amount is distinct from -v_order then
        v_changed := v_changed || m.transaction_id;
        continue;
      end if;

      -- Ours, but changed since: it now belongs to whoever changed it.
      if m.split_state is not null and m.split_state <> public.wb_order_split_state(m.transaction_id) then
        update public.wb_splits set from_order = false where transaction_id = m.transaction_id;
        update public.wb_order_matches set split_state = null where id = m.match_id;
        v_hand_split := v_hand_split || m.transaction_id;
        continue;
      end if;

      select array_agg(s.id order by s.position, s.created_at, s.id) into v_old
      from public.wb_splits s where s.transaction_id = m.transaction_id;

      if m.split_state is null then
        if cardinality(v_old) > 1 then
          v_hand_split := v_hand_split || m.transaction_id;
          continue;
        end if;
        if exists (
          select 1 from public.wb_split_tags st
          where st.split_id = any (v_old) and st.group_id = v_category
            and st.source in ('claude', 'manual') and st.tag_id <> v_unsorted
        ) then
          v_hand_tag := v_hand_tag || m.transaction_id;
          continue;
        end if;
      end if;

      if exists (select 1 from public.wb_splits s where s.id = any (v_old) and s.project_id is not null)
         or exists (select 1 from public.wb_planned_matches p where p.transaction_id = m.transaction_id) then
        v_linked := v_linked || m.transaction_id;
        continue;
      end if;

      -- The shares, in cents. Untagged lines go to Amazon (unsorted).
      v_cents := round(abs(v_amount) * 100)::bigint;
      with g as (
        select coalesce(it.tag_id, v_unsorted) as tag_id, sum(it.line_amount) as w
        from public.wb_order_items it
        where it.order_id = m.order_id
        group by 1
        having sum(it.line_amount) > 0
      ), a as (
        select g.tag_id, v_cents * g.w / sum(g.w) over () as exact from g
      ), r as (
        select a.tag_id, floor(a.exact)::bigint as base,
               row_number() over (order by a.exact - floor(a.exact) desc, a.exact desc, a.tag_id) as rn,
               sum(floor(a.exact)) over () as based
        from a
      ), f as (
        select r.tag_id, r.base + case when r.rn <= v_cents - r.based then 1 else 0 end as share from r
      )
      select array_agg(f.tag_id order by f.share desc, f.tag_id), array_agg(f.share::bigint order by f.share desc, f.tag_id)
      into v_tags, v_shares
      from f where f.share > 0;
      if v_tags is null then
        v_tags := array[v_unsorted];
        v_shares := array[v_cents];
      end if;

      -- Already like this: write nothing.
      select count(*) = cardinality(v_tags) and coalesce(bool_and(c.ok), false) into v_same
      from (
        select s.amount = -(v_shares[u.ord]::numeric / 100) as ok
        from unnest(v_tags) with ordinality as u(tag_id, ord)
        join public.wb_split_tags st on st.tag_id = u.tag_id and st.split_id = any (v_old) and st.group_id = v_category
        join public.wb_splits s on s.id = st.split_id
      ) c;
      if v_same and cardinality(v_old) = cardinality(v_tags) then
        n_unchanged := n_unchanged + 1;
        continue;
      end if;

      -- Tags outside Category (Who, Tax, Label) stay on every part.
      select coalesce(jsonb_agg(to_jsonb(k)), '[]'::jsonb) into v_keep
      from (
        select distinct on (st.tag_id) st.tag_id, st.source, st.rule_id, st.replaced_rule_id
        from public.wb_split_tags st
        where st.split_id = any (v_old) and st.group_id <> v_category
        order by st.tag_id
      ) k;

      delete from public.wb_split_tags st where st.split_id = any (v_old);

      for i in 1 .. cardinality(v_tags) loop
        if i <= cardinality(v_old) then
          v_split := v_old[i];
          update public.wb_splits
          set amount = -(v_shares[i]::numeric / 100), position = i - 1, from_order = true
          where id = v_split;
        else
          insert into public.wb_splits (transaction_id, amount, position, from_order)
          values (m.transaction_id, -(v_shares[i]::numeric / 100), i - 1, true)
          returning id into v_split;
        end if;
        insert into public.wb_split_tags (split_id, tag_id, source) values (v_split, v_tags[i], 'claude');
        insert into public.wb_split_tags (split_id, tag_id, source, rule_id, replaced_rule_id)
        select v_split, (j ->> 'tag_id')::uuid, j ->> 'source', (j ->> 'rule_id')::uuid, (j ->> 'replaced_rule_id')::uuid
        from jsonb_array_elements(v_keep) j;
      end loop;
      if cardinality(v_old) > cardinality(v_tags) then
        delete from public.wb_splits where id = any (v_old[cardinality(v_tags) + 1:]);
      end if;

      update public.wb_order_matches
      set split_state = public.wb_order_split_state(m.transaction_id)
      where id = m.match_id;
      n_split := n_split + 1;
    exception when others then
      v_failed := v_failed || m.transaction_id;
    end;
  end loop;

  return jsonb_build_object(
    'split', n_split,
    'unchanged', n_unchanged,
    'skipped_hand_split', to_jsonb(v_hand_split),
    'skipped_hand_tagged', to_jsonb(v_hand_tag),
    'skipped_project_or_planned_match', to_jsonb(v_linked),
    'skipped_amount_changed', to_jsonb(v_changed),
    'failed', to_jsonb(v_failed));
end;
$$;

comment on function public.wb_split_order_charges(uuid[]) is
  'Warren Buffet: splits each matched Amazon charge (or only the given ones) by its items'' categories, one split per category, summing exactly to the charge; untagged lines go on Amazon (unsorted). Safe to rerun: it rebuilds only splits it made and has not seen changed. It skips and reports charges split or categorised by hand, charges with a project or planned match, and charges whose amount changed.';
revoke all on function public.wb_split_order_charges(uuid[]) from public, anon;
grant execute on function public.wb_split_order_charges(uuid[]) to authenticated, service_role;

-- ============================================================================
-- 5. wb_process_transactions: as before, except that a charge with order-made
--    splits keeps its tags and project. create or replace keeps its grants and comment.
-- ============================================================================
create or replace function public.wb_process_transactions(ids uuid[])
returns jsonb
language plpgsql
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
  v_from_order boolean;
  v_matched    uuid[];
  v_sub        uuid;
  v_nsubs      int;
  v_subs       uuid[] := '{}';
  v_project    uuid;
  v_psource    text;
  v_posted     uuid[] := '{}';
  v_sugg       jsonb;
  n_processed  int := 0;
  n_paired     int := 0;
  n_candidates int := 0;
  n_tags       int := 0;
  n_rules      int := 0;
  n_linked     int := 0;
  n_projects   int := 0;
begin
  if ids is null or cardinality(ids) = 0 then
    return jsonb_build_object('processed', 0, 'paired', 0, 'transfer_candidates', 0, 'rule_tags', 0, 'rules_updated', 0,
                              'subscriptions_linked', 0, 'rule_projects', 0, 'matches_suggested', 0);
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
    --    Order-made splits (P4-D10) keep their tags and project; rules still count as matched.
    v_matched := '{}';
    v_project := null;
    if not t.pending then
      v_posted := v_posted || t.id;
      select count(*)::int, (array_agg(s.id order by s.position, s.id))[1], coalesce(bool_or(s.from_order), false)
      into v_nsplits, v_split, v_from_order
      from public.wb_splits s
      where s.transaction_id = t.id;

      delete from public.wb_split_tags st
      using public.wb_splits s
      where st.split_id = s.id and s.transaction_id = t.id and st.source = 'rule' and not v_from_order;

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

        -- The first matching rule that sets a project wins.
        if r.set_project_id is not null and v_project is null then
          v_project := r.set_project_id;
        end if;

        -- Tags only on a single-split transaction; multi-split ones are left to people.
        if v_nsplits = 1 and not v_from_order then
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

      -- 5c. Project, on a single-split transaction only. A project set or removed
      --     by hand or by Claude stays; a rule's project goes when no rule sets one.
      if v_nsplits = 1 and not v_from_order then
        select s.project_source into v_psource from public.wb_splits s where s.id = v_split;
        if coalesce(v_psource, 'rule') = 'rule' then
          update public.wb_splits
          set project_id = v_project, project_source = case when v_project is null then null else 'rule' end
          where id = v_split
            and (project_id is distinct from v_project
                 or project_source is distinct from case when v_project is null then null else 'rule' end);
          if found and v_project is not null then
            n_projects := n_projects + 1;
          end if;
        end if;
      end if;

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

  -- 7. Planned match suggestions for the posted rows processed here.
  v_sugg := case when cardinality(v_posted) > 0
                 then public.wb_suggest_planned_matches(v_posted, null)
                 else jsonb_build_object('suggested', 0) end;

  return jsonb_build_object(
    'processed', n_processed,
    'paired', n_paired,
    'transfer_candidates', n_candidates,
    'rule_tags', n_tags,
    'rules_updated', n_rules,
    'subscriptions_linked', n_linked,
    'rule_projects', n_projects,
    'matches_suggested', (v_sugg ->> 'suggested')::int);
end;
$$;

commit;

-- ============================================================================
-- 6. Conformance: this is the result the SQL editor shows. Expect conformant
--    true and failures []. Then run supabase/tests/warren_buffet_p4/4_item_splits_tests.sql.
-- ============================================================================
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t)
) as result;
