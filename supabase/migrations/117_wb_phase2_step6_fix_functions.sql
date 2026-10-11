-- Purpose: Warren Buffet Phase 2 Step 6a. "Always do this" (spec §6.1) as one implementation for the MCP tool and the Money app: wb_suggest_pattern (pure), wb_fix_plan (read: merchant, pattern, dry-run count, existing rules) and wb_apply_fix (write: create or extend the merchant, create or update the merchant rule with created_from_transaction_id, reprocess). Adds wb_transactions.notes and shows it in wb_transaction_list.
-- Kind: schema change (one column, three functions, one replaced view)
-- Applied: YES — 2026-10-11 by Alex. check_platform_conformance CONFORMANT (60 tables); 118 all 24 checks true.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p2-m4t.md sections 4.1, 6.1 and 7.
-- No real financial data in this file. Run as one block, then 118_wb_phase2_step6_tests.sql.
-- supabase/migrations/117_wb_phase2_step6_fix_functions.sql

begin;

-- ============================================================================
-- 1. wb_transactions.notes (a human column; the sync never sends it)
-- ============================================================================
alter table public.wb_transactions add column if not exists notes text;
comment on column public.wb_transactions.notes is
  'Free-text note on the transaction, written by a person or Claude. The sync never writes it.';

-- ============================================================================
-- 2. wb_suggest_pattern: the short merchant pattern a fix proposes
-- ============================================================================
-- Among the first three words of the payee, else of the clean description, the
-- shortest that is at least 4 letters and not a stop word. Editable before saving.
create or replace function public.wb_suggest_pattern(p_payee text, p_clean text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_text text;
  v_word text;
  v_best text;
  v_n    int;
  stop   text[] := array[
    'the', 'and', 'inc', 'llc', 'ltd', 'corp', 'company', 'www', 'com', 'net', 'org', 'online', 'payment',
    'payments', 'purchase', 'pos', 'debit', 'credit', 'card', 'visa', 'mastercard', 'direct', 'recurring',
    'autopay', 'bill', 'pay', 'store', 'shop', 'market', 'usa', 'transfer', 'deposit', 'withdrawal', 'mktp',
    'mktpl', 'help', 'check'];
begin
  foreach v_text in array array[p_payee, p_clean]
  loop
    continue when v_text is null;
    v_best := null;
    v_n := 0;
    foreach v_word in array regexp_split_to_array(lower(v_text), '[^a-z0-9&''.-]+')
    loop
      continue when v_word = '';
      v_n := v_n + 1;
      exit when v_n > 3;
      v_word := regexp_replace(v_word, '^[^a-z0-9]+|[^a-z0-9]+$', '', 'g');
      continue when v_word !~ '^[a-z][a-z&''.-]{3,}$' or v_word = any (stop);
      if v_best is null or length(v_word) < length(v_best) then
        v_best := v_word;
      end if;
    end loop;
    if v_best is not null then
      return v_best;
    end if;
  end loop;
  return null;
end;
$$;

comment on function public.wb_suggest_pattern(text, text) is
  'Warren Buffet: the short merchant pattern "Always do this" proposes: among the first three words of the payee, else of the clean description, the shortest of at least 4 letters that is not a stop word. Null when there is none.';

-- ============================================================================
-- 3. wb_fix_plan: what "Always do this" would do for one transaction (read only)
-- ============================================================================
-- Merchant: the transaction's own when it has one and no pattern is given;
-- otherwise the merchant named p_merchant_name (or the transaction's, or the
-- pattern in title case), created if missing, gaining the pattern if it lacks it.
create or replace function public.wb_fix_plan(p_transaction_id uuid, p_pattern text default null, p_merchant_name text default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  t          record;
  m          record;
  v_pattern  text := nullif(regexp_replace(lower(btrim(coalesce(p_pattern, ''))), '\s+', ' ', 'g'), '');
  v_name     text;
  v_merchant jsonb;
  v_dry      jsonb;
  v_rules    jsonb;
  v_warn     text[] := '{}';
begin
  select * into t from public.wb_transaction_list where id = p_transaction_id;
  if not found then
    raise exception 'wb_fix_plan: no transaction % that you can see', p_transaction_id using errcode = '23503';
  end if;
  if v_pattern is not null and length(v_pattern) < 3 then
    raise exception 'wb_fix_plan: a match pattern needs at least 3 characters' using errcode = '22023';
  end if;

  if t.merchant_id is not null and v_pattern is null then
    v_merchant := jsonb_build_object('id', t.merchant_id, 'name', t.merchant_name, 'exists', true, 'add_pattern', null);
    v_dry := public.wb_rule_preview(jsonb_build_object('merchant_id', t.merchant_id), null, 5);
  else
    v_pattern := coalesce(v_pattern, public.wb_suggest_pattern(t.payee, t.clean_description));
    if v_pattern is null then
      raise exception 'wb_fix_plan: no distinctive word to match on; pass a pattern' using errcode = '22023';
    end if;
    if t.merchant_id is not null then
      select id, name, match_patterns into m from public.wb_merchants where id = t.merchant_id;
    else
      v_name := coalesce(nullif(btrim(p_merchant_name), ''), initcap(v_pattern));
      select id, name, match_patterns into m from public.wb_merchants where lower(name) = lower(v_name) limit 1;
    end if;
    if m.id is not null then
      v_merchant := jsonb_build_object('id', m.id, 'name', m.name, 'exists', true,
        'add_pattern', case when v_pattern = any (m.match_patterns) then null else v_pattern end);
    else
      v_merchant := jsonb_build_object('id', null, 'name', v_name, 'exists', false, 'add_pattern', v_pattern);
    end if;
    v_dry := public.wb_rule_preview(null, v_pattern, 5);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'name', r.name, 'priority', r.priority, 'active', r.active, 'set_kind', r.set_kind,
           'add_tag_ids', r.add_tag_ids, 'hit_count', r.hit_count) order by r.priority, r.created_at), '[]'::jsonb)
  into v_rules
  from public.wb_rules r
  where v_merchant ->> 'id' is not null and r.match ->> 'merchant_id' = v_merchant ->> 'id';

  if (v_dry ->> 'too_narrow')::boolean then
    v_warn := v_warn || format('This would catch only %s past transaction(s): probably too narrow. Try a shorter pattern.', v_dry ->> 'count');
  end if;
  if jsonb_array_length(v_rules) > 0 then
    v_warn := v_warn || format('A rule already exists for %s: update it instead of adding another.', v_merchant ->> 'name');
  end if;

  return jsonb_build_object(
    'transaction', jsonb_build_object('id', t.id, 'txn_date', t.txn_date, 'account_label', t.account_label,
                     'payee', t.payee, 'clean_description', t.clean_description, 'kind', t.kind, 'tag_names', t.tag_names),
    'merchant', v_merchant,
    'pattern', v_pattern,
    'rule_match', jsonb_build_object('merchant_id', coalesce(v_merchant ->> 'id', '(the new merchant)')),
    'dry_run', jsonb_build_object('count', (v_dry ->> 'count')::int, 'too_narrow', (v_dry ->> 'too_narrow')::boolean,
                 'samples', v_dry -> 'samples'),
    'existing_rules', v_rules,
    'warnings', to_jsonb(v_warn),
    'ids', v_dry -> 'ids');
end;
$$;

comment on function public.wb_fix_plan(uuid, text, text) is
  'Warren Buffet: the "Always do this" plan for one transaction (spec §6.1): the merchant (existing, or to create, with a short pattern), the dry-run count with a too-narrow warning at 1 or fewer, and the existing rules for that merchant. Writes nothing.';

-- ============================================================================
-- 4. wb_apply_fix: do it — merchant, then a merchant rule, then reprocess
-- ============================================================================
-- Updating an existing rule merges tags: a new tag replaces the rule's tag from
-- the same exclusive group; other tags stay. Refuses to add a second rule for a
-- merchant unless p_add_new_rule.
create or replace function public.wb_apply_fix(
  p_transaction_id uuid,
  p_set_kind       text default null,
  p_add_tag_ids    uuid[] default '{}',
  p_pattern        text default null,
  p_merchant_name  text default null,
  p_update_rule_id uuid default null,
  p_add_new_rule   boolean default false,
  p_notes          text default null,
  p_created_by     text default 'manual')
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_plan     jsonb;
  t          record;
  v_owner    uuid;
  v_mid      uuid;
  v_created  boolean := false;
  v_rule     record;
  v_rule_id  uuid;
  v_tags     uuid[];
  v_before   uuid[] := '{}';
  v_ids      uuid[];
  v_counts   jsonb;
begin
  if p_created_by not in ('claude', 'manual') then
    raise exception 'wb_apply_fix: created_by must be claude or manual' using errcode = '22023';
  end if;
  if p_set_kind is null and coalesce(cardinality(p_add_tag_ids), 0) = 0 then
    raise exception 'wb_apply_fix: say what the rule does: a kind and/or tags' using errcode = '22023';
  end if;
  if p_set_kind is not null and p_set_kind not in ('spend', 'income', 'transfer', 'refund', 'investment', 'interest', 'fee') then
    raise exception 'wb_apply_fix: unknown kind %', p_set_kind using errcode = '22023';
  end if;
  if exists (select 1 from unnest(coalesce(p_add_tag_ids, '{}')) x(id)
             where not exists (select 1 from public.wb_tags g where g.id = x.id)) then
    raise exception 'wb_apply_fix: a tag id does not exist' using errcode = '23503';
  end if;

  v_plan := public.wb_fix_plan(p_transaction_id, p_pattern, p_merchant_name);
  select user_id, context_id into t from public.wb_transactions where id = p_transaction_id;
  v_owner := coalesce(auth.uid(), t.user_id);

  if jsonb_array_length(v_plan -> 'existing_rules') > 0 and p_update_rule_id is null and not coalesce(p_add_new_rule, false) then
    raise exception 'wb_apply_fix: a rule already exists for %; update it or add another', v_plan #>> '{merchant,name}'
      using errcode = '23505';
  end if;

  -- 1. The merchant: create it, or add the pattern.
  v_mid := (v_plan #>> '{merchant,id}')::uuid;
  if v_mid is null then
    insert into public.wb_merchants (user_id, context_id, name, match_patterns)
    values (v_owner, t.context_id, v_plan #>> '{merchant,name}', array[v_plan #>> '{merchant,add_pattern}'])
    returning id into v_mid;
    v_created := true;
  elsif v_plan #>> '{merchant,add_pattern}' is not null then
    update public.wb_merchants
    set match_patterns = array(select distinct p from unnest(match_patterns || (v_plan #>> '{merchant,add_pattern}')) p order by p)
    where id = v_mid;
  end if;

  -- 2. The rule, matching on the merchant.
  if p_update_rule_id is not null then
    select * into v_rule from public.wb_rules where id = p_update_rule_id for update;
    if not found then
      raise exception 'wb_apply_fix: no rule % that you can see', p_update_rule_id using errcode = '23503';
    end if;
    v_before := array(select x.id from public.wb_transactions x where p_update_rule_id = any (x.matched_rule_ids));
    -- Keep the rule's tags, except one from an exclusive group a new tag takes over.
    v_tags := array(
      select distinct u from (
        select old.id as u
        from unnest(v_rule.add_tag_ids) old_id
        join public.wb_tags old on old.id = old_id
        join public.wb_tag_groups og on og.id = old.group_id
        where not (og.exclusive and exists (
          select 1 from unnest(coalesce(p_add_tag_ids, '{}')) n_id
          join public.wb_tags n on n.id = n_id
          where n.group_id = old.group_id))
        union
        select n_id from unnest(coalesce(p_add_tag_ids, '{}')) n_id
      ) z);
    update public.wb_rules
    set match = jsonb_build_object('merchant_id', v_mid),
        set_kind = coalesce(p_set_kind, set_kind),
        add_tag_ids = v_tags,
        notes = coalesce(p_notes, notes)
    where id = p_update_rule_id;
    v_rule_id := p_update_rule_id;
  else
    insert into public.wb_rules (user_id, context_id, name, priority, match, set_kind, add_tag_ids,
                                 created_by, created_from_transaction_id, notes)
    values (v_owner, t.context_id, v_plan #>> '{merchant,name}', 100, jsonb_build_object('merchant_id', v_mid),
            p_set_kind, coalesce(p_add_tag_ids, '{}'), p_created_by, p_transaction_id, p_notes)
    returning id into v_rule_id;
  end if;

  -- 3. Reprocess everything the merchant and the rule now touch.
  v_ids := array(
    select distinct x from unnest(
      array[p_transaction_id]
      || array(select (jsonb_array_elements_text(coalesce(v_plan -> 'ids', '[]'::jsonb)))::uuid)
      || v_before
      || array(select w.id from public.wb_transactions w where w.merchant_id = v_mid)) x);
  v_counts := public.wb_process_transactions(v_ids);

  return jsonb_build_object(
    'merchant_id', v_mid, 'merchant_created', v_created,
    'rule_id', v_rule_id, 'rule_updated', p_update_rule_id is not null,
    'matched_now', (public.wb_rule_preview(jsonb_build_object('merchant_id', v_mid), null, 0) ->> 'count')::int,
    'reprocessed', v_counts);
end;
$$;

comment on function public.wb_apply_fix(uuid, text, uuid[], text, text, uuid, boolean, text, text) is
  'Warren Buffet: "Always do this" (spec §6.1). Creates the merchant or adds the pattern, then creates a merchant rule (created_from_transaction_id set) or updates p_update_rule_id (tags merged; a new exclusive-group tag replaces the old one), then reprocesses what they touch. Refuses a second rule for a merchant unless p_add_new_rule.';

revoke all on function public.wb_suggest_pattern(text, text) from public, anon;
revoke all on function public.wb_fix_plan(uuid, text, text) from public, anon;
revoke all on function public.wb_apply_fix(uuid, text, uuid[], text, text, uuid, boolean, text, text) from public, anon;
grant execute on function public.wb_suggest_pattern(text, text) to authenticated, service_role;
grant execute on function public.wb_fix_plan(uuid, text, text) to authenticated, service_role;
grant execute on function public.wb_apply_fix(uuid, text, uuid[], text, text, uuid, boolean, text, text) to authenticated, service_role;

-- ============================================================================
-- 5. wb_transaction_list: as in 114, plus notes at the end
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
  ), '[]'::jsonb)                                                                    as excluded_tags,
  x.notes
from public.wb_transactions x
join public.wb_accounts a on a.id = x.account_id
left join public.wb_merchants m on m.id = x.merchant_id;

comment on view public.wb_transaction_list is
  'App: Warren Buffet. Transactions with account label, merchant name, tag_names (text[], filter with overlaps), split_count, needs_review (true when the row is in wb_review_queue), excluded_tags (tags removed by hand, which no rule puts back: tag_id, tag_name, rule_id, source, removed_at) and notes. No raw jsonb. security_invoker, so wb_ RLS applies.';

commit;

-- ============================================================================
-- 6. Conformance: this is the result the SQL editor shows. Expect conformant
--    true and failures []. Then run 118_wb_phase2_step6_tests.sql.
-- ============================================================================
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t)
) as result;
