-- Purpose: Warren Buffet Phase 3, Step 8a. Database support for the Plan tab: table wb_planned_skips (a missed due date marked Not needed); view wb_planned_unmatched (past due dates with something still unmatched, A25); view wb_project_summary (spent, received, net, budget, still due, planning); wb_unconfirm_planned_match (remove a confirmed match; never changes the stage); wb_planned_start_from_history (the first matching payment inside the burn window, for backdating a new repeating item); wb_transaction_list gains project_names.
-- Kind: schema change (one table, one trigger function, two new functions, two new views, one replaced view)
-- Applied: YES — 2026-10-19 by Alex: conformant true, failures []; check_platform_conformance CONFORMANT, 68 tables; 141 all 48 checks true.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p3-q5k.md section 3.8 and A34-A41.
-- A15: no number the help states is defined here; the burn window comes from wb_burn_rate_on, so no help comments are due.
-- No real financial data in this file. Run as one block, then 141_wb_phase3_step8_tests.sql; the
-- conformance result at the end must be conformant true.
-- supabase/migrations/140_wb_phase3_step8_plan_tab.sql

begin;

-- ============================================================================
-- 1. wb_planned_skips: a missed due date marked Not needed (A40)
-- ============================================================================
create table if not exists public.wb_planned_skips (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id      text not null references public.contexts(id),
  planned_item_id uuid not null references public.wb_planned_items(id) on delete cascade,
  occurrence_on   date,
  reason          text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint wb_planned_skips_key unique nulls not distinct (planned_item_id, occurrence_on)
);

comment on table public.wb_planned_skips is
  'App: Warren Buffet. A past due date of a planned item marked Not needed (for example a payment from before the bank sync started), so wb_planned_unmatched and the weekly cleanup leave it out. occurrence_on is the date for a recurring item and null for a one-off, as in wb_planned_matches. user_id and context_id are filled from the planned item by trigger. Deleting the planned item deletes its skips.';
comment on column public.wb_planned_skips.occurrence_on is 'The skipped due date of a recurring item; null for a one-off.';
comment on column public.wb_planned_skips.reason is 'Optional note on why the date is not needed.';

create or replace function public.wb_planned_skips_fill()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  p record;
begin
  select pi.user_id, pi.context_id, pi.interval_count into p
  from public.wb_planned_items pi where pi.id = new.planned_item_id;
  if not found then
    raise exception 'wb_planned_skips: planned item % not found', new.planned_item_id using errcode = '23503';
  end if;
  new.user_id := p.user_id;
  new.context_id := p.context_id;
  if p.interval_count is not null and new.occurrence_on is null then
    raise exception 'wb_planned_skips: a recurring planned item needs occurrence_on' using errcode = '23514';
  end if;
  if p.interval_count is null and new.occurrence_on is not null then
    raise exception 'wb_planned_skips: a one-off planned item has no occurrence_on' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists wb_planned_skips_fill on public.wb_planned_skips;
create trigger wb_planned_skips_fill before insert or update on public.wb_planned_skips
  for each row execute function public.wb_planned_skips_fill();

drop trigger if exists wb_planned_skips_touch_updated_at on public.wb_planned_skips;
create trigger wb_planned_skips_touch_updated_at before update on public.wb_planned_skips
  for each row execute function public.wb_touch_updated_at();

-- ============================================================================
-- 2. wb_planned_unmatched: past due dates not fully matched (A25, A40)
-- ============================================================================
create or replace view public.wb_planned_unmatched
with (security_invoker = true) as
with t as (select (now() at time zone 'America/Los_Angeles')::date as d),
occ as (
  -- Recurring items' past dates (drafts left out), and overdue one-offs that are not
  -- drafts, paid or cancelled.
  select o.planned_item_id, o.occurrence_on as due_on, o.occurrence_on, true as recurring
  from t
  cross join lateral public.wb_planned_occurrences(
    coalesce((select min(due_on) from public.wb_planned_items where interval_count is not null), t.d), t.d - 1, false) o
  where o.recurring
  union all
  select pi.id, pi.due_on, null::date, false
  from public.wb_planned_items pi, t
  where pi.interval_count is null
    and pi.due_on < t.d
    and pi.stage not in ('draft', 'paid', 'cancelled')
),
done as (
  select o.*,
         coalesce((select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
                   where pm.planned_item_id = o.planned_item_id and pm.status = 'confirmed'
                     and pm.occurrence_on is not distinct from o.occurrence_on), 0) as paid
  from occ o
)
select
  d.planned_item_id,
  pi.name,
  pi.project_id,
  pr.name                                                  as project_name,
  pi.merchant_id,
  m.name                                                   as merchant_name,
  d.recurring,
  d.due_on,
  d.occurrence_on,
  pi.stage,
  pi.amount,
  round(sign(pi.amount) * d.paid, 2)                       as confirmed_total,
  round(sign(pi.amount) * (abs(pi.amount) - d.paid), 2)    as remaining,
  (t.d - d.due_on)                                         as days_late,
  (t.d - d.due_on) <= pi.match_window_days                 as within_window,
  exists (select 1 from public.wb_planned_matches pm
          where pm.planned_item_id = d.planned_item_id and pm.status = 'suggested'
            and pm.occurrence_on is not distinct from d.occurrence_on) as has_suggestion
from done d
cross join t
join public.wb_planned_items pi on pi.id = d.planned_item_id
left join public.wb_projects pr on pr.id = pi.project_id
left join public.wb_merchants m on m.id = pi.merchant_id
where d.paid < abs(pi.amount)
  and not exists (select 1 from public.wb_planned_skips sk
                  where sk.planned_item_id = d.planned_item_id
                    and sk.occurrence_on is not distinct from d.occurrence_on);

comment on view public.wb_planned_unmatched is
  'App: Warren Buffet. Missed dates: every due date before today (Pacific) whose confirmed matches do not cover the amount. Recurring items give one row per past date from due_on (occurrence_on set); a one-off gives one row once its date is past, unless it is a draft, paid or cancelled (occurrence_on null). Recurring drafts are left out. A date in wb_planned_skips (Not needed) is left out. confirmed_total and remaining carry the item''s sign; days_late counts from the due date; within_window is true while a payment may still be suggested (days_late <= match_window_days); has_suggestion when one waits in Review. The weekly cleanup reads this view (A25). security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 3. wb_project_summary: one row per project (A35, A36)
-- ============================================================================
create or replace view public.wb_project_summary
with (security_invoker = true) as
with t as (select (now() at time zone 'America/Los_Angeles')::date as d,
                  coalesce((select horizon_months from public.wb_settings order by created_at limit 1), 12) as h),
pay as (
  -- Posted splits on each project. Spent is money out (negative); received is money in.
  select s.project_id,
         coalesce(sum(s.amount) filter (where s.amount < 0), 0) as spent,
         coalesce(sum(s.amount) filter (where s.amount > 0), 0) as received,
         count(*)::int                                           as payment_count,
         max((coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date) as last_payment_on
  from public.wb_splits s
  join public.wb_transactions x on x.id = s.transaction_id
  where s.project_id is not null and not x.pending
  group by s.project_id
),
items as (
  select pi.project_id,
         count(*) filter (where coalesce(pi.stage, '') <> 'cancelled')::int                                as item_count,
         count(*) filter (where pi.stage = 'draft' or pi.is_draft)::int                                    as draft_count
  from public.wb_planned_items pi
  where pi.project_id is not null
  group by pi.project_id
),
due as (
  -- What is still to come, less what is confirmed: one-offs not paid or cancelled (overdue
  -- ones included), and recurring dates from today to the end of the horizon.
  select q.project_id, q.draft,
         sum(q.left_amt) filter (where q.left_amt < 0) as due_out,
         sum(q.left_amt) filter (where q.left_amt > 0) as due_in
  from (
    select pi.project_id, pi.stage = 'draft' as draft,
           sign(pi.amount) * greatest(abs(pi.amount) - coalesce((
             select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
             where pm.planned_item_id = pi.id and pm.status = 'confirmed'), 0), 0) as left_amt
    from public.wb_planned_items pi
    where pi.project_id is not null and pi.interval_count is null and pi.stage not in ('paid', 'cancelled')
    union all
    select pi.project_id, pi.is_draft,
           sign(o.amount) * greatest(abs(o.amount) - coalesce((
             select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
             where pm.planned_item_id = o.planned_item_id and pm.status = 'confirmed'
               and pm.occurrence_on = o.occurrence_on), 0), 0)
    from t
    cross join lateral public.wb_planned_occurrences(t.d, (t.d + make_interval(months => t.h))::date - 1, true) o
    join public.wb_planned_items pi on pi.id = o.planned_item_id
    where o.recurring and pi.project_id is not null
  ) q
  group by q.project_id, q.draft
)
select
  p.id                                                         as project_id,
  p.name,
  p.status,
  p.budget,
  p.starts_on,
  p.ends_on,
  round(coalesce(pay.spent, 0), 2)                             as spent,
  round(coalesce(pay.received, 0), 2)                          as received,
  round(coalesce(pay.spent, 0) + coalesce(pay.received, 0), 2) as net,
  case when p.budget is not null then round(p.budget + coalesce(pay.spent, 0), 2) end as budget_left,
  round(coalesce((select d.due_out from due d where d.project_id = p.id and not d.draft), 0), 2) as planned_out_due,
  round(coalesce((select d.due_in  from due d where d.project_id = p.id and not d.draft), 0), 2) as planned_in_due,
  round(coalesce((select d.due_out from due d where d.project_id = p.id and d.draft), 0), 2)     as draft_out_due,
  round(coalesce((select d.due_in  from due d where d.project_id = p.id and d.draft), 0), 2)     as draft_in_due,
  coalesce(items.item_count, 0)                                as item_count,
  coalesce(items.draft_count, 0)                               as draft_count,
  coalesce(pay.payment_count, 0)                               as payment_count,
  pay.last_payment_on,
  (coalesce(items.item_count, 0) > 0
   and items.draft_count = items.item_count
   and coalesce(pay.payment_count, 0) = 0)                     as planning
from public.wb_projects p
left join pay on pay.project_id = p.id
left join items on items.project_id = p.id;

comment on view public.wb_project_summary is
  'App: Warren Buffet. One row per project. spent = posted money out on the project''s splits (negative); received = posted money in (positive, such as an insurer''s payment); net = spent + received. budget_left = budget + spent: the budget is measured against spent, not net (A36). planned_out_due and planned_in_due = what is still to come on its planned items, less what is confirmed: one-offs not paid or cancelled (overdue included) and recurring dates over the horizon; draft_out_due and draft_in_due are the same for drafts, kept apart. item_count leaves out cancelled items. planning is true when every item is a draft and nothing has been paid on the project (A35); it is derived, never stored. security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 4. wb_unconfirm_planned_match: remove a confirmed match (A39)
-- ============================================================================
create or replace function public.wb_unconfirm_planned_match(p_match_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  m      record;
  pi     record;
  v_paid numeric;
begin
  select * into m from public.wb_planned_matches where id = p_match_id for update;
  if not found then
    raise exception 'wb_unconfirm_planned_match: no match % that you can see', p_match_id using errcode = '23503';
  end if;
  if m.status <> 'confirmed' then
    raise exception 'wb_unconfirm_planned_match: this match is %, not confirmed', m.status using errcode = '22023';
  end if;
  update public.wb_planned_matches set status = 'rejected', decided_at = now() where id = p_match_id;

  select * into pi from public.wb_planned_items where id = m.planned_item_id;
  select coalesce(sum(abs(x.amount_applied)), 0) into v_paid
  from public.wb_planned_matches x
  where x.planned_item_id = pi.id and x.status = 'confirmed';

  -- The stage is never changed here (A20); the app asks whether to set it back.
  return jsonb_build_object(
    'status', 'rejected',
    'planned_item_id', pi.id,
    'stage', pi.stage,
    'confirmed_total', sign(pi.amount) * v_paid,
    'paid_not_covered', pi.interval_count is null and pi.stage = 'paid' and v_paid < abs(pi.amount));
end;
$$;

comment on function public.wb_unconfirm_planned_match(uuid) is
  'Warren Buffet: remove a confirmed planned match. The match becomes rejected, so the same pair is never suggested again. The planned item''s stage is never changed (A20); paid_not_covered is true when a paid one-off is no longer fully covered, so the app can ask whether to set it back to invoiced. Returns status, planned_item_id, stage, confirmed_total (signed) and paid_not_covered. Security invoker.';

-- ============================================================================
-- 5. wb_planned_start_from_history: backdating a new repeating item (A34)
-- ============================================================================
create or replace function public.wb_planned_start_from_history(
  p_merchant_id      uuid,
  p_amount           numeric,
  p_amount_tolerance numeric default 0,
  p_today            date default null
)
returns date
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with t as (select coalesce(p_today, (now() at time zone 'America/Los_Angeles')::date) as d),
  -- The first burn month, so every payment the burn rate counts is matched.
  w as (select coalesce((select min(b.month) from t, public.wb_burn_rate_on(t.d) b), t.d) as first_day, t.d from t)
  select min(c.d)
  from w
  join public.wb_transactions x on x.merchant_id = p_merchant_id and not x.pending
  cross join lateral (select (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date as d) c
  join public.wb_splits s on s.transaction_id = x.id
  where p_merchant_id is not null
    and coalesce(p_amount, 0) <> 0
    and c.d between w.first_day and w.d
    and sign(s.amount) = sign(p_amount)
    and abs(abs(s.amount) - abs(p_amount)) <= coalesce(p_amount_tolerance, 0)
    -- A split already fully confirmed against other planned items is not this item's.
    and coalesce((select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
                  where pm.split_id = s.id and pm.status = 'confirmed'), 0) < abs(s.amount);
$$;

comment on function public.wb_planned_start_from_history(uuid, numeric, numeric, date) is
  'Warren Buffet: the date of the earliest posted payment at the merchant, with the amount''s sign and within the tolerance, from the first burn month (wb_burn_rate_on) to p_today, leaving out splits already fully confirmed against other planned items. Null when there is none, or no merchant. Used as the first due date of a new repeating item, so every payment the burn rate counts is matched (A34). Security invoker.';

-- ============================================================================
-- 6. wb_transaction_list: as in 135, plus project_names at the end (A38)
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
    or (not x.pending and not x.reviewed and sub.status = 'watching'
        and not coalesce((select sm.not_subscription from public.wb_merchants sm where sm.id = sub.merchant_id), false)
        and x.id = (select y.id from public.wb_transactions y
                    where y.subscription_id = sub.id and not y.pending
                    order by coalesce(y.posted_at, y.transacted_at) desc, y.id desc limit 1))
    or exists (select 1 from public.wb_planned_matches pm where pm.transaction_id = x.id and pm.status = 'suggested')
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
  sub.name                                                                           as subscription_name,
  coalesce((
    select array_agg(distinct p.name order by p.name)
    from public.wb_splits s
    join public.wb_projects p on p.id = s.project_id
    where s.transaction_id = x.id
  ), '{}'::text[])                                                                   as project_names
from public.wb_transactions x
join public.wb_accounts a on a.id = x.account_id
left join public.wb_merchants m on m.id = x.merchant_id
left join public.wb_subscriptions sub on sub.id = x.subscription_id;

comment on view public.wb_transaction_list is
  'App: Warren Buffet. Transactions with account label, merchant name, tag_names (text[], filter with overlaps), split_count, needs_review (true when the row is in wb_review_queue, including a suggested planned match), excluded_tags (tags removed by hand, which no rule puts back: tag_id, tag_name, rule_id, source, removed_at), notes, the linked subscription (subscription_id, subscription_source, subscription_name), and project_names (text[], the projects on any of its splits). No raw jsonb. security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 7. Register with the platform, the shared-context policy (mirrors intents), grants
-- ============================================================================
select platform.register_table(
  'public.wb_planned_skips',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. Missed planned due dates marked Not needed. Owner OR shared-context RLS (mirrors intents).'
);

drop policy if exists wb_planned_skips_access on public.wb_planned_skips;
create policy wb_planned_skips_access on public.wb_planned_skips
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

grant select on public.wb_planned_unmatched to authenticated, service_role;
grant select on public.wb_project_summary   to authenticated, service_role;
grant select on public.wb_transaction_list  to authenticated, service_role;
grant execute on function public.wb_unconfirm_planned_match(uuid) to authenticated, service_role;
grant execute on function public.wb_planned_start_from_history(uuid, numeric, numeric, date) to authenticated, service_role;

commit;

-- ============================================================================
-- 8. Conformance: this is the result the SQL editor shows. Expect conformant
--    true and failures []. Then run 141_wb_phase3_step8_tests.sql.
-- ============================================================================
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t)
) as result;
