-- Purpose: Warren Buffet Phase 2, Step 10 follow-up. Acknowledging rule-health findings that are deliberate (a monthly re-split, one-off charges): wb_rule_health_acks stores one acknowledgement per finding and subject (the rule, or the merchant for merchant-level findings) with the n at the time and a reason. wb_rule_health_all is every finding with its acknowledgement; wb_rule_health shows only findings not acknowledged, so an acknowledged one stays hidden until its n grows past the acknowledged n. wb_bulk_create returns a null id for an item it did not actually create (dry run, or a run that wrote nothing).
-- Kind: schema change (one table, one new view, one replaced view, one replaced function)
-- Applied: YES — 2026-10-14 by Alex. Conformance passed; 132 all 19 checks true.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p2-m4t.md sections 4.9, 6 and 8 (Step 10).
-- No real financial data in this file. Run as one block, then 132_wb_phase2_step10_acks_tests.sql;
-- check_platform_conformance must report CONFORMANT.
-- supabase/migrations/131_wb_phase2_step10_acks.sql

begin;

-- ============================================================================
-- 1. wb_rule_health_acks
-- ============================================================================
create table if not exists public.wb_rule_health_acks (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id text not null references public.contexts(id),
  finding    text not null,
  subject_id uuid not null,
  acked_n    int not null,
  reason     text not null,
  acked_by   uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint wb_rule_health_acks_subject_key unique (context_id, finding, subject_id),
  constraint wb_rule_health_acks_finding_check check (finding in (
    'never_fires', 'too_broad', 'often_overridden', 'duplicate_rules', 'rule_missing', 'merchant_no_category')),
  constraint wb_rule_health_acks_reason_check check (btrim(reason) <> ''),
  constraint wb_rule_health_acks_n_check check (acked_n >= 0)
);

comment on table public.wb_rule_health_acks is
  'App: Warren Buffet. A rule-health finding acknowledged as deliberate: one row per finding and subject (subject_id is the rule for never_fires and often_overridden, the merchant for the merchant-level findings), with the finding''s n when acknowledged and why. The finding stays hidden from wb_rule_health until its n grows past acked_n. Deleting the row un-acknowledges it.';
comment on column public.wb_rule_health_acks.acked_n is 'The finding''s n when it was acknowledged; a larger n shows the finding again.';

drop trigger if exists wb_rule_health_acks_touch_updated_at on public.wb_rule_health_acks;
create trigger wb_rule_health_acks_touch_updated_at before update on public.wb_rule_health_acks
  for each row execute function public.wb_touch_updated_at();

-- ============================================================================
-- 2. wb_rule_health_all: the findings of 127, each with its acknowledgement
-- ============================================================================
create or replace view public.wb_rule_health_all
with (security_invoker = true) as
with findings as (
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
  select 'too_broad', null, null, mp.merchant_id, m.name,
         cardinality(mp.payees), mp.n_txns,
         'Payees: ' || array_to_string((select array_agg(p order by p) from unnest(mp.payees) p), '; ')
  from merchant_payees mp
  join public.wb_merchants m on m.id = mp.merchant_id
  where cardinality(mp.payees) >= 3
    and exists (select 1 from rule_merchant r where r.merchant_id = mp.merchant_id)
  union all
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
  'App: Warren Buffet. Every rule-health finding (see wb_rule_health) with subject_id (the rule, else the merchant) and its acknowledgement: acknowledged is true while n has not grown past acked_n, with ack_reason and acked_at. security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 3. wb_rule_health: same columns as 127, acknowledged findings left out
-- ============================================================================
create or replace view public.wb_rule_health
with (security_invoker = true) as
select finding, rule_id, rule_name, merchant_id, merchant_name, n, of_n, detail
from public.wb_rule_health_all
where not acknowledged;

comment on view public.wb_rule_health is
  'App: Warren Buffet. One row per finding not acknowledged (finding, rule_id, rule_name, merchant_id, merchant_name, n, of_n, detail): never_fires, too_broad (merchant-level: 3+ distinct normalized payees on a merchant with a rule), often_overridden (n of of_n hits beaten by hand, at least 2 and 25%), duplicate_rules, rule_missing, merchant_no_category. An acknowledged finding (wb_rule_health_acks) is hidden until its n grows past the acknowledged n; wb_rule_health_all has them all. Read by get_wb_rule_health and the weekly cleanup task, which proposes fixes and never writes them. security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 4. wb_bulk_create: as in 129, but an item that was not really created
--    (dry run, or a run that wrote nothing) reports a null id
-- ============================================================================
create or replace function public.wb_bulk_create(
  p_payload    jsonb,
  p_context_id text,
  p_dry_run    boolean default true,
  p_created_by text default 'claude')
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user     uuid;
  v_results  jsonb := '[]'::jsonb;
  v_errors   int := 0;
  v_item     jsonb;
  v_name     text;
  v_group    record;
  v_parent   uuid;
  v_id       uuid;
  v_patterns text[];
  v_added    text[];
  v_existing text[];
  v_kind     text;
  v_tag_ids  uuid[];
  v_ref      text;
  v_tag      uuid;
  v_err      text;
  v_status   text;
  v_applied  boolean;
begin
  if p_created_by is null or p_created_by not in ('claude', 'manual') then
    raise exception 'wb_bulk_create: created_by must be claude or manual' using errcode = '22023';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'wb_bulk_create: payload must be an object with tags, merchants and rules' using errcode = '22023';
  end if;
  if greatest(jsonb_array_length(coalesce(p_payload -> 'tags', '[]')),
              jsonb_array_length(coalesce(p_payload -> 'merchants', '[]')),
              jsonb_array_length(coalesce(p_payload -> 'rules', '[]'))) > 50 then
    raise exception 'wb_bulk_create: at most 50 tags, 50 merchants and 50 rules per call' using errcode = '22023';
  end if;
  select coalesce(auth.uid(), c.user_id) into v_user from public.contexts c where c.id = p_context_id;
  if v_user is null then
    raise exception 'wb_bulk_create: no context % that you can see', p_context_id using errcode = '23503';
  end if;

  -- Everything runs inside one sub-block; a dry run, or any item error, rolls it all back.
  begin
    -- 1. Tags, in order, so a parent may be an earlier item.
    for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'tags', '[]'))
    loop
      v_name := btrim(v_item ->> 'name');
      v_err := null; v_id := null; v_status := 'error';
      begin
        select g.id, g.name into v_group from public.wb_tag_groups g
        where g.context_id = p_context_id and lower(g.name) = lower(btrim(v_item ->> 'group'));
        if v_group.id is null then
          v_err := format('no tag group "%s"', v_item ->> 'group');
        elsif coalesce(v_name, '') = '' then
          v_err := 'a tag needs a name';
        else
          select t.id into v_id from public.wb_tags t where t.group_id = v_group.id and lower(t.name) = lower(v_name);
          if v_id is not null then
            v_status := 'exists';
          else
            v_parent := null;
            if nullif(btrim(v_item ->> 'parent'), '') is not null then
              select t.id into v_parent from public.wb_tags t
              where t.group_id = v_group.id and lower(t.name) = lower(btrim(v_item ->> 'parent'));
              if v_parent is null then
                v_err := format('no parent tag "%s" in %s', v_item ->> 'parent', v_group.name);
              end if;
            end if;
            if v_err is null then
              insert into public.wb_tags (user_id, context_id, group_id, parent_id, name, notes)
              values (v_user, p_context_id, v_group.id, v_parent, v_name, nullif(btrim(v_item ->> 'notes'), ''))
              returning id into v_id;
              v_status := 'created';
            end if;
          end if;
        end if;
      exception when others then
        v_err := sqlerrm;
      end;
      if v_err is not null then v_errors := v_errors + 1; v_status := 'error'; end if;
      v_results := v_results || jsonb_build_object('kind', 'tag', 'name', concat_ws('/', v_group.name, v_name),
        'status', v_status, 'id', v_id, 'error', v_err);
      v_group := null;
    end loop;

    -- 2. Merchants: an existing one (by name) gets any new patterns added.
    for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'merchants', '[]'))
    loop
      v_name := btrim(v_item ->> 'name');
      v_err := null; v_id := null; v_status := 'error';
      begin
        select coalesce(array_agg(distinct lower(btrim(p))), '{}') into v_patterns
        from jsonb_array_elements_text(coalesce(v_item -> 'match_patterns', '[]')) p
        where btrim(p) <> '';
        v_kind := nullif(btrim(v_item ->> 'default_kind'), '');
        if coalesce(v_name, '') = '' then
          v_err := 'a merchant needs a name';
        elsif exists (select 1 from unnest(v_patterns) p where length(p) < 3) then
          v_err := 'a match pattern needs at least 3 characters';
        elsif v_kind is not null and v_kind not in ('spend', 'income', 'transfer', 'refund', 'investment', 'interest', 'fee') then
          v_err := format('unknown kind "%s"', v_kind);
        else
          select m.id, m.match_patterns into v_id, v_existing from public.wb_merchants m
          where m.context_id = p_context_id and lower(m.name) = lower(v_name);
          if v_id is not null then
            select coalesce(array_agg(p), '{}') into v_added
            from unnest(v_patterns) p
            where p <> all (v_existing);
            if cardinality(v_added) > 0 then
              update public.wb_merchants set match_patterns = match_patterns || v_added where id = v_id;
              v_status := 'updated';
            else
              v_status := 'exists';
            end if;
          elsif cardinality(v_patterns) = 0 then
            v_err := 'a new merchant needs match_patterns';
          else
            insert into public.wb_merchants (user_id, context_id, name, match_patterns, default_kind, notes)
            values (v_user, p_context_id, v_name, v_patterns, v_kind, nullif(btrim(v_item ->> 'notes'), ''))
            returning id into v_id;
            v_status := 'created';
          end if;
        end if;
      exception when others then
        v_err := sqlerrm;
      end;
      if v_err is not null then v_errors := v_errors + 1; v_status := 'error'; end if;
      v_results := v_results || jsonb_build_object('kind', 'merchant', 'name', v_name,
        'status', v_status, 'id', v_id, 'error', v_err);
    end loop;

    -- 3. Rules, on a merchant (by name); an active rule for that merchant is reused, never duplicated.
    for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'rules', '[]'))
    loop
      v_name := btrim(v_item ->> 'name');
      v_err := null; v_id := null; v_status := 'error'; v_tag_ids := '{}';
      begin
        v_kind := nullif(btrim(v_item ->> 'set_kind'), '');
        select m.id into v_id from public.wb_merchants m
        where m.context_id = p_context_id and lower(m.name) = lower(btrim(v_item ->> 'merchant'));
        if coalesce(v_name, '') = '' then
          v_err := 'a rule needs a name';
        elsif v_id is null then
          v_err := format('no merchant "%s"', v_item ->> 'merchant');
        elsif v_kind is not null and v_kind not in ('spend', 'income', 'transfer', 'refund', 'investment', 'interest', 'fee') then
          v_err := format('unknown kind "%s"', v_kind);
        else
          for v_ref in select * from jsonb_array_elements_text(coalesce(v_item -> 'tags', '[]'))
          loop
            select t.id into v_tag from public.wb_tags t
            join public.wb_tag_groups g on g.id = t.group_id
            where g.context_id = p_context_id
              and lower(g.name) = lower(btrim(split_part(v_ref, '/', 1)))
              and lower(t.name) = lower(btrim(substr(v_ref, length(split_part(v_ref, '/', 1)) + 2)));
            if v_tag is null then
              v_err := format('no tag "%s" (write Group/Tag)', v_ref);
              exit;
            end if;
            v_tag_ids := v_tag_ids || v_tag;
          end loop;
          if v_err is null and v_kind is null and cardinality(v_tag_ids) = 0 then
            v_err := 'say what the rule does: set_kind and/or tags';
          end if;
          if v_err is null then
            select r.id into v_tag from public.wb_rules r
            where r.active and r.match ->> 'merchant_id' = v_id::text
            order by r.priority, r.created_at limit 1;
            if v_tag is not null then
              v_id := v_tag;
              v_status := 'exists';
            else
              insert into public.wb_rules (user_id, context_id, name, priority, match, set_kind, add_tag_ids, created_by, notes)
              values (v_user, p_context_id, v_name, coalesce((v_item ->> 'priority')::int, 100),
                      jsonb_build_object('merchant_id', v_id), v_kind, v_tag_ids, p_created_by,
                      nullif(btrim(v_item ->> 'notes'), ''))
              returning id into v_id;
              v_status := 'created';
            end if;
          end if;
        end if;
      exception when others then
        v_err := sqlerrm;
      end;
      if v_err is not null then v_errors := v_errors + 1; v_status := 'error'; v_id := null; end if;
      v_results := v_results || jsonb_build_object('kind', 'rule', 'name', v_name, 'merchant', v_item ->> 'merchant',
        'status', v_status, 'id', v_id, 'error', v_err);
    end loop;

    if p_dry_run or v_errors > 0 then
      raise exception 'wb_bulk_create: roll back' using errcode = 'WB001';
    end if;
  exception when sqlstate 'WB001' then
    null; -- rolled back; the results stay
  end;

  -- Nothing written: a "created" item has no real id, so it reports none.
  v_applied := not p_dry_run and v_errors = 0;
  if not v_applied then
    select coalesce(jsonb_agg(case when r ->> 'status' = 'created' then r || '{"id": null}'::jsonb else r end
                              order by ord), '[]'::jsonb)
    into v_results
    from jsonb_array_elements(v_results) with ordinality as e(r, ord);
  end if;

  return jsonb_build_object(
    'applied', v_applied,
    'dry_run', p_dry_run,
    'counts', (select jsonb_object_agg(k, n) from (
                 select r ->> 'status' as k, count(*) as n from jsonb_array_elements(v_results) r group by 1) s),
    'results', v_results);
end;
$$;

comment on function public.wb_bulk_create(jsonb, text, boolean, text) is
  'Warren Buffet: create tags, merchants and merchant rules in one transaction, referring to each other by name (tag parent, rule merchant, rule tags as Group/Tag). Existing names are reused, an existing merchant gets new patterns added, and a merchant that already has an active rule keeps it (no duplicate). A dry run (the default) writes nothing; any item error writes nothing; then a would-be-created item reports a null id. At most 50 of each. Security invoker. Returns applied, counts and per-item results.';

-- ============================================================================
-- 5. Grants, register, policy
-- ============================================================================
grant select on public.wb_rule_health_all to authenticated, service_role;
grant select on public.wb_rule_health     to authenticated, service_role;
grant execute on function public.wb_bulk_create(jsonb, text, boolean, text) to authenticated, service_role;

select platform.register_table(
  'public.wb_rule_health_acks',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. Rule-health findings acknowledged as deliberate, with the n at the time and why. Owner OR shared-context RLS (mirrors intents).'
);

drop policy if exists wb_rule_health_acks_access on public.wb_rule_health_acks;
create policy wb_rule_health_acks_access on public.wb_rule_health_acks
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

commit;

-- ============================================================================
-- 6. Conformance: this is the result the SQL editor shows. Expect conformant
--    true and failures []. Then run 132_wb_phase2_step10_acks_tests.sql.
-- ============================================================================
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t)
) as result;
