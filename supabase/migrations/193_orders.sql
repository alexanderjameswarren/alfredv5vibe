-- Purpose: Warren Buffet Phase 4, Step 8b (run tags warren_buffet_p4-r6d-s8b-r2vq and s8b2-t6yk; spec P4-D7). Tables wb_orders (one row per shipment), wb_order_items (with refunds) and wb_order_matches (a shipment to the one card charge that matched it exactly within 0 to 3 days), and the trigger holding the match rule.
-- Kind: schema change (three new tables, one trigger function)
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p4-r6d.md P4-D7.
-- No real order data in this file. Run as one block, then supabase/tests/warren_buffet_p4/3_orders_tests.sql;
-- the conformance result at the end must be conformant true.
-- supabase/migrations/193_orders.sql

begin;

-- ============================================================================
-- 1. wb_orders: one row per shipment, because Amazon charges once per shipment
-- ============================================================================
create table if not exists public.wb_orders (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id          text not null references public.contexts(id),
  site                text not null,
  order_number        text not null,
  order_date          date not null,
  ship_date           date not null,
  amount              numeric(14,2) not null,
  order_status        text,
  shipment_status     text,
  payment_method_type text,
  buyer               text,
  created_at          timestamptz not null default now(),
  constraint wb_orders_key unique (user_id, site, order_number, ship_date),
  constraint wb_orders_site_check check (site in ('amazon', 'wholefoods')),
  constraint wb_orders_amount_check check (amount >= 0)
);

create index if not exists wb_orders_context_idx on public.wb_orders (context_id);

comment on table public.wb_orders is
  'App: Warren Buffet. One shipment: the items of one order with one ship date. Imported from Amazon''s data export (P4-D7).';
comment on column public.wb_orders.site is 'amazon or wholefoods. Only amazon shipments are matched to charges.';
comment on column public.wb_orders.order_number is 'The order id as Amazon gives it. Several shipments can share one.';
comment on column public.wb_orders.ship_date is 'Pacific date. A row naming several ship dates sits on the earliest.';
comment on column public.wb_orders.amount is 'Sum of the items'' line amounts, positive. Includes tax, shipping and discounts.';
comment on column public.wb_orders.buyer is 'Who bought it. Empty for now; holds the place for Elise''s orders.';

-- ============================================================================
-- 2. wb_order_items
-- ============================================================================
create table if not exists public.wb_order_items (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id   text not null references public.contexts(id),
  order_id     uuid not null references public.wb_orders(id) on delete cascade,
  line_no      integer not null,
  site         text not null,
  asin         text,
  product_name text not null,
  department   text,
  quantity     integer not null,
  unit_amount  numeric(14,2) not null,
  line_amount  numeric(14,2) not null,
  refunded_amount numeric(14,2),
  refund_date  date,
  order_date   date not null,
  ship_date    date not null,
  buyer        text,
  tag_id       uuid references public.wb_tags(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint wb_order_items_key unique (order_id, line_no),
  constraint wb_order_items_site_check check (site in ('amazon', 'wholefoods')),
  constraint wb_order_items_quantity_check check (quantity >= 0),
  constraint wb_order_items_amounts_check check (unit_amount >= 0 and line_amount >= 0),
  constraint wb_order_items_refund_check check (
    (refunded_amount is null and refund_date is null) or (refunded_amount > 0 and refund_date is not null))
);

create index if not exists wb_order_items_context_idx on public.wb_order_items (context_id);
create index if not exists wb_order_items_order_date_idx on public.wb_order_items (order_date desc);
create index if not exists wb_order_items_tag_idx on public.wb_order_items (tag_id);

comment on table public.wb_order_items is
  'App: Warren Buffet. One product line of a shipment, Amazon or Whole Foods. Never holds addresses, tracking, gift fields or invoices (P4-D7).';
comment on column public.wb_order_items.line_no is 'Position in the shipment. Identical lines exist, so this keeps them distinct.';
comment on column public.wb_order_items.unit_amount is 'Price of one, before tax, positive.';
comment on column public.wb_order_items.line_amount is 'Total for the line, positive. Includes tax, shipping and discounts.';
comment on column public.wb_order_items.refunded_amount is 'Total refunded on this line, positive. Empty when none was refunded or a refund could not be placed on one line.';
comment on column public.wb_order_items.refund_date is 'Pacific date of the latest refund on this line.';
comment on column public.wb_order_items.buyer is 'Who bought it. Empty for now; holds the place for Elise''s orders.';
comment on column public.wb_order_items.tag_id is 'The item''s category, set later in chat. Empty until then.';

-- ============================================================================
-- 3. wb_order_matches: exact amount, 0 to 3 days, one shipment only
-- ============================================================================
create table if not exists public.wb_order_matches (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id     text not null references public.contexts(id),
  order_id       uuid not null references public.wb_orders(id) on delete cascade,
  transaction_id uuid not null references public.wb_transactions(id) on delete cascade,
  days_apart     integer not null,
  created_at     timestamptz not null default now(),
  constraint wb_order_matches_order_key unique (order_id),
  constraint wb_order_matches_transaction_key unique (transaction_id),
  constraint wb_order_matches_days_check check (days_apart between 0 and 3)
);

create index if not exists wb_order_matches_context_idx on public.wb_order_matches (context_id);

comment on table public.wb_order_matches is
  'App: Warren Buffet. An Amazon shipment and the one card charge of exactly its amount, 0 to 3 days after it shipped. Unmatched charges have no row (P4-D7).';
comment on column public.wb_order_matches.days_apart is 'Charge date minus ship date, Pacific.';

-- The match rule, held here too so a later writer cannot break it.
create or replace function public.wb_order_matches_check()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  o public.wb_orders%rowtype;
  t public.wb_transactions%rowtype;
begin
  select * into o from public.wb_orders where id = new.order_id;
  select * into t from public.wb_transactions where id = new.transaction_id;
  if o.site is distinct from 'amazon' then
    raise exception 'wb_order_matches: only Amazon shipments are matched' using errcode = '23514';
  end if;
  if o.amount <= 0 then
    raise exception 'wb_order_matches: a shipment totalling zero is never matched' using errcode = '23514';
  end if;
  if t.amount is distinct from -o.amount then
    raise exception 'wb_order_matches: the charge must be exactly the shipment amount' using errcode = '23514';
  end if;
  if new.days_apart is distinct from
     (coalesce(t.posted_at, t.transacted_at) at time zone 'America/Los_Angeles')::date - o.ship_date then
    raise exception 'wb_order_matches: days_apart must be the charge date minus the ship date' using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.wb_order_matches_check() is
  'Warren Buffet: refuses a match unless it is an Amazon shipment above zero, the charge is exactly its amount, and days_apart is the real gap (P4-D7).';
revoke all on function public.wb_order_matches_check() from public, anon;

drop trigger if exists wb_order_matches_check on public.wb_order_matches;
create trigger wb_order_matches_check before insert or update on public.wb_order_matches
  for each row execute function public.wb_order_matches_check();

-- ============================================================================
-- 4. Registration and access: owner or shared context, as the other wb_ tables
-- ============================================================================
select platform.register_table(
  'public.wb_orders',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. One shipment from the Amazon data export. Owner OR shared-context RLS (mirrors intents).'
);
select platform.register_table(
  'public.wb_order_items',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. One product line of a shipment. Owner OR shared-context RLS (mirrors intents).'
);
select platform.register_table(
  'public.wb_order_matches',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. A shipment and its matched card charge. Owner OR shared-context RLS (mirrors intents).'
);

alter table public.wb_orders enable row level security;
alter table public.wb_order_items enable row level security;
alter table public.wb_order_matches enable row level security;

drop policy if exists wb_orders_access on public.wb_orders;
create policy wb_orders_access on public.wb_orders
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

drop policy if exists wb_order_items_access on public.wb_order_items;
create policy wb_order_items_access on public.wb_order_items
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

drop policy if exists wb_order_matches_access on public.wb_order_matches;
create policy wb_order_matches_access on public.wb_order_matches
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

commit;

-- ============================================================================
-- 5. Conformance: this is the result the SQL editor shows. Expect conformant
--    true and failures []. Then run supabase/tests/warren_buffet_p4/3_orders_tests.sql.
-- ============================================================================
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t)
) as result;
