-- Purpose: Warren Buffet Phase 2 Step 3 fix. Payments to people (Venmo, Zelle, Visa Direct, PayPal, Cash App) are spend or income, not transfer candidates, unless a unique opposite match exists on a household account. wb_clean_description also strips phone numbers in more shapes, help URLs, reference codes, masked account digits and trailing lot numbers, and with a merchant drops only the trailing state code, no longer the word before it.
-- Kind: schema change (replaces wb_clean_description, wb_default_kind and wb_process_transactions; adds wb_is_p2p_phrase)
-- Applied: YES — 2026-10-09 by Alex. 104 then 85/85; after the 105 re-run the Venmo row is spend and there are no transfer candidates.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p2-m4t.md section 5. Tests: 104_wb_phase2_tests.sql.
-- No real financial data in this file. Run as one block, then re-run 104, 105 and 106.
-- supabase/migrations/107_wb_phase2_cleaning_p2p_fix.sql

begin;

-- ============================================================================
-- 1. Payments to people
-- ============================================================================
create or replace function public.wb_is_p2p_phrase(p_text text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(p_text ~* '(\mvenmo\M|\mzelle\M|visa\s+direct|\mpaypal\M|cash\s*app|square\s+cash)', false);
$$;

comment on function public.wb_is_p2p_phrase(text) is
  'Warren Buffet: true for payments to or from people (Venmo, Zelle, Visa Direct, PayPal, Cash App). Such a row is not a transfer by phrase; it pairs only when a unique opposite match exists on a household account.';

-- A transfer phrase on a payment to a person ("Transfer to Venmo") does not make it a transfer.
create or replace function public.wb_default_kind(
  p_account_role text, p_amount numeric, p_description text, p_payee text, p_merchant_kind text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_account_role in ('retirement', 'taxable_investment') then 'investment'
    when p_merchant_kind is not null then p_merchant_kind
    when public.wb_is_transfer_phrase(concat_ws(' ', p_description, p_payee))
         and not public.wb_is_p2p_phrase(concat_ws(' ', p_description, p_payee)) then 'transfer'
    when p_amount > 0 and public.wb_is_interest_phrase(concat_ws(' ', p_description, p_payee)) then 'interest'
    when p_amount < 0 and public.wb_is_fee_phrase(concat_ws(' ', p_description, p_payee)) then 'fee'
    when p_amount > 0 and p_account_role in ('credit_card', 'emergency_credit') then 'refund'
    when p_amount > 0 then 'income'
    else 'spend'
  end;
$$;

-- ============================================================================
-- 2. Cleaning
-- ============================================================================
create or replace function public.wb_clean_description(p_raw text, p_strip_location boolean default false)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  s    text := p_raw;
  m    text[];
  code int;
begin
  if s is null then
    return null;
  end if;

  -- HTML entities: numeric, then hex, then named, with &amp; last so it decodes once.
  loop
    m := regexp_match(s, '(&#([0-9]{1,7});)');
    exit when m is null;
    code := m[2]::int;
    s := replace(s, m[1], case when code between 1 and 55295 or code between 57344 and 1114111
                               then chr(code) else ' ' end);
  end loop;
  loop
    m := regexp_match(s, '(&#[xX]([0-9A-Fa-f]{1,6});)');
    exit when m is null;
    code := ('x' || lpad(m[2], 8, '0'))::bit(32)::int;
    s := replace(s, m[1], case when code between 1 and 55295 or code between 57344 and 1114111
                               then chr(code) else ' ' end);
  end loop;
  s := replace(s, '&nbsp;', ' ');
  s := replace(s, '&quot;', '"');
  s := replace(s, '&apos;', '''');
  s := replace(s, '&lt;', '<');
  s := replace(s, '&gt;', '>');
  s := replace(s, '&amp;', '&');

  -- URLs with a path ("g.co/helppay#CA", "amzn.com/bill"); a bare "AMAZON.COM" stays.
  s := regexp_replace(s, '(https?://)?\m([a-z0-9-]+\.)+[a-z]{2,6}/[^ ]*', ' ', 'gi');
  -- Masked account numbers and any short number after them: XXXX1234, ****1234, "XXXXX6   937".
  s := regexp_replace(s, '[Xx*]{3,}[0-9]{0,4}(\s+[0-9]{1,4})?\M', ' ', 'g');
  -- Reference numbers: REF #AB123, CONF: 99812, TRACE 0042 ...
  s := regexp_replace(s, '\m(REF|REFERENCE|CONF|CONFIRMATION|TRACE|TRN)\M\s*(#|NO\.?|NUM|:)?\s*[A-Z0-9-]*[0-9][A-Z0-9-]*', ' ', 'gi');
  -- Codes after an asterisk ("MKTP US*2K4HJ1"); a name after one ("SQ *CAFE") stays.
  s := regexp_replace(s, '\*\s*[A-Z0-9]*[0-9][A-Z0-9]*', ' ', 'gi');
  -- Phone numbers: 888-555-1234, (888) 555-1234, 888.555.1234, 888-5551234, 1-888-555-1234.
  s := regexp_replace(s, '(\m1[-. ])?\(?\m[0-9]{3}\)?[-. ]?[0-9]{3}[-. ]?[0-9]{4}\M', ' ', 'g');
  -- Upper-case codes of five or more that mix letters and digits, starting with a letter ("PTQV5S").
  s := regexp_replace(s, '\m[A-Z](?=[A-Z0-9]{4,}\M)[A-Z]*[0-9][A-Z0-9]*\M', ' ', 'g');
  -- Dates, with a leading "ON": "ON 10/02/26", "09/02/2026".
  s := regexp_replace(s, '(\mON\s+)?\m[0-9]{1,2}/[0-9]{1,2}(/[0-9]{2,4})?\M', ' ', 'gi');
  -- Store numbers and digit runs of four or more.
  s := regexp_replace(s, '#\s*[0-9]+', ' ', 'g');
  s := regexp_replace(s, '\m[0-9]{4,}\M', ' ', 'g');

  s := replace(s, '*', ' ');
  s := regexp_replace(s, '\s+', ' ', 'g');
  s := btrim(s, ' -#.,:;/\');

  -- Trailing state code, only when a merchant matched. The city stays: without a
  -- city list, "one word before the state" also ate merchant words ("PET STORE AZ").
  if p_strip_location then
    s := regexp_replace(s, '\s+(AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)$', '');
    s := btrim(s, ' -#.,:;/\');
  end if;

  return nullif(s, '');
end;
$$;

comment on function public.wb_clean_description(text, boolean) is
  'Warren Buffet: readable description from raw bank text. Decodes HTML entities; drops URLs with a path, masked account numbers (and a short number after them), reference numbers, asterisk codes, phone numbers, mixed letter-digit codes, dates, store numbers and digit runs of four or more; collapses whitespace. With p_strip_location, also drops a trailing state code (the city stays).';

-- ============================================================================
-- 3. wb_process_transactions: a payment to a person is tried for a pair but never
--    flagged as a transfer candidate. Everything else as in 103.
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

    -- 5. Rules: posted rows only. Rule tags are replaced; claude/manual tags stay.
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
  'Warren Buffet: clean, merchant, default kind, transfer pairing and rules for the given transactions (spec §5). Security invoker. Never changes a claude or manual kind, merchant or tag; pairs and tags posted rows only; a payment to a person pairs only on a unique match and is never a transfer candidate. Safe to re-run. Returns counts.';

-- create or replace keeps existing grants; the new function needs its own.
revoke all on function public.wb_is_p2p_phrase(text) from public, anon;
grant execute on function public.wb_is_p2p_phrase(text) to authenticated, service_role;

commit;
