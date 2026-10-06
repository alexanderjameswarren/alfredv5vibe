-- Purpose: Warren Buffet Step 2. Phase 1 money tables (wb_accounts, wb_balance_snapshots, wb_holding_snapshots, wb_transactions), shared-context RLS mirroring intents, two security_invoker views, and the warren_buffet app value on platform_runs / platform_schedules.
-- Kind: schema change (four tables, one trigger function, two views, two check constraints)
-- Applied: YES — 2026-10-06 by Alex. Verification passed (policies match intents, RLS on, views security_invoker, warren_buffet in both app checks, anon blocked); conformance CONFORMANT (49 tables).
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here. Alex runs every file himself.
-- 088 is taken by restructure_p1-h4nz (088_restructure_p1_status.sql); independent of this file.
--
-- Spec: docs/technical-spec-warren_buffet-w7b.md sections 4 and 6.
-- No real financial data in this file, ever (spec section 3).
-- Run as one block in the SQL editor.
-- supabase/migrations/089_wb_phase1_tables.sql

begin;

-- ============================================================================
-- 1. wb_accounts
-- ============================================================================
create table if not exists public.wb_accounts (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id            text not null references public.contexts(id),
  source                text not null,
  external_id           text,
  institution           text,
  name                  text not null,
  display_name          text,
  last4                 text,
  owner                 text,
  role                  text not null default 'unassigned',
  currency              text not null default 'USD',
  credit_limit          numeric(14,2),
  reward_unit           text,
  reward_value_per_unit numeric(10,6),
  expires_on            date,
  active_from           date,
  active_until          date,
  is_hidden             boolean not null default false,
  last_synced_at        timestamptz,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint wb_accounts_source_check check (source in ('simplefin', 'manual')),
  -- Synced accounts always carry the SimpleFIN id; manual ones never do.
  constraint wb_accounts_external_id_check
    check ((source = 'simplefin') = (external_id is not null)),
  -- A plain unique constraint (NULLs distinct), not a partial index, so the
  -- sync's PostgREST upsert can target it with onConflict.
  constraint wb_accounts_source_external_id_key unique (source, external_id),
  constraint wb_accounts_last4_check check (last4 is null or last4 ~ '^[0-9]{4}$'),
  constraint wb_accounts_owner_check check (owner is null or owner in ('alex', 'elise', 'joint')),
  constraint wb_accounts_role_check check (role in (
    'unassigned', 'spending_cash', 'reserve_cash', 'credit_card', 'emergency_credit',
    'loan', 'retirement', 'taxable_investment', 'rewards', 'history_rollup', 'closed'
  )),
  constraint wb_accounts_active_window_check
    check (active_from is null or active_until is null or active_from <= active_until)
);

create index if not exists wb_accounts_context_idx on public.wb_accounts (context_id);

comment on table public.wb_accounts is
  'App: Warren Buffet. Every money account, synced from SimpleFIN or entered by hand, with a role that decides which net-worth group it counts in. The sync owns name, institution, external_id, last4 and last_synced_at; display_name, owner, role, credit_limit, reward fields, expires_on, active_from/until, is_hidden and notes are human columns the sync never overwrites.';
comment on column public.wb_accounts.name is 'As reported by SimpleFIN (or typed for a manual account). Never edited by humans; display_name is the editable label.';
comment on column public.wb_accounts.last4 is 'Last four digits only, parsed from the name when present. Never store more (spec section 3).';
comment on column public.wb_accounts.role is 'Which net-worth group the account counts in. New synced accounts arrive as unassigned and stay out of net worth until a role is set.';
comment on column public.wb_accounts.reward_value_per_unit is 'Dollar value per reward unit, chosen by Alex. Null means do not convert, and the account is left out of the rewards total.';
comment on column public.wb_accounts.active_until is 'For history_rollup accounts: the day before synced history starts, so rollups never double count with real accounts. A history_rollup with no active_until counts on no date.';

-- ============================================================================
-- 2. wb_balance_snapshots
-- ============================================================================
create table if not exists public.wb_balance_snapshots (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id        text not null references public.contexts(id),
  account_id        uuid not null references public.wb_accounts(id) on delete cascade,
  as_of             date not null,
  balance           numeric(14,2) not null,
  available_balance numeric(14,2),
  reported_at       timestamptz,
  source            text not null,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint wb_balance_snapshots_source_check check (source in ('sync', 'manual', 'import')),
  constraint wb_balance_snapshots_account_as_of_key unique (account_id, as_of)
);

comment on table public.wb_balance_snapshots is
  'App: Warren Buffet. One balance per account per day. The sync upserts its own row for today but never overwrites a manual or import row: it pre-reads today''s rows and skips any account whose row is not source = sync.';
comment on column public.wb_balance_snapshots.as_of is 'Local date, America/Los_Angeles.';
comment on column public.wb_balance_snapshots.reported_at is 'SimpleFIN balance-date for synced rows.';

-- ============================================================================
-- 3. wb_holding_snapshots
-- ============================================================================
create table if not exists public.wb_holding_snapshots (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id     text not null references public.contexts(id),
  account_id     uuid not null references public.wb_accounts(id) on delete cascade,
  as_of          date not null,
  external_id    text not null,
  symbol         text,
  description    text,
  shares         numeric(20,6),
  market_value   numeric(14,2),
  cost_basis     numeric(14,2),
  purchase_price numeric(14,4),
  currency       text,
  created_at     timestamptz not null default now(),

  constraint wb_holding_snapshots_account_as_of_external_key unique (account_id, as_of, external_id)
);

comment on table public.wb_holding_snapshots is
  'App: Warren Buffet. One row per investment position per account per day, as SimpleFIN reports it. Sync-managed.';
comment on column public.wb_holding_snapshots.external_id is 'SimpleFIN holding id.';

-- ============================================================================
-- 4. wb_transactions
-- ============================================================================
create table if not exists public.wb_transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id    text not null references public.contexts(id),
  account_id    uuid not null references public.wb_accounts(id) on delete cascade,
  external_id   text not null,
  posted_at     timestamptz,
  transacted_at timestamptz,
  amount        numeric(14,2) not null,
  description   text,
  payee         text,
  memo          text,
  mcc           text,
  pending       boolean not null default false,
  raw           jsonb not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),

  constraint wb_transactions_account_external_key unique (account_id, external_id)
);

create index if not exists wb_transactions_account_posted_idx
  on public.wb_transactions (account_id, posted_at desc);

comment on table public.wb_transactions is
  'App: Warren Buffet. Raw transactions exactly as SimpleFIN reports them; never edited. Stored from day one because SimpleFIN only returns the last 90 days. Sign: money in positive, money out negative, on every account. The sync deletes a pending row only when a later fetch covers its date and does not return it; posted rows are never deleted.';
comment on column public.wb_transactions.raw is 'Full SimpleFIN transaction object. Excluded from every list read.';
comment on column public.wb_transactions.description is 'Raw bank description, unedited. Cleanup lives in Phase 2 columns.';

-- ============================================================================
-- 5. updated_at trigger (wb_accounts, wb_balance_snapshots)
-- ============================================================================
create or replace function public.wb_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.wb_touch_updated_at() is 'Warren Buffet: stamps updated_at on wb_accounts and wb_balance_snapshots.';

drop trigger if exists wb_accounts_touch_updated_at on public.wb_accounts;
create trigger wb_accounts_touch_updated_at
  before update on public.wb_accounts
  for each row execute function public.wb_touch_updated_at();

drop trigger if exists wb_balance_snapshots_touch_updated_at on public.wb_balance_snapshots;
create trigger wb_balance_snapshots_touch_updated_at
  before update on public.wb_balance_snapshots
  for each row execute function public.wb_touch_updated_at();

-- ============================================================================
-- 6. Register with the platform, then the shared-context policy (mirrors intents)
-- ============================================================================
-- policy_mode 'none': register_table enables RLS, grants, anon-strip and audit;
-- the owner-OR-shared-context policy below is ours.
select platform.register_table(
  'public.wb_accounts',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. Money accounts, synced or manual, with a net-worth role. Owner OR shared-context RLS (mirrors intents). Audited because role, owner and limits are human edits.'
);
select platform.register_table(
  'public.wb_balance_snapshots',
  p_policy_mode => 'none',
  p_audited     => false,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. One balance per account per day; sync-managed daily series, audit off. Owner OR shared-context RLS (mirrors intents).'
);
select platform.register_table(
  'public.wb_holding_snapshots',
  p_policy_mode => 'none',
  p_audited     => false,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. Investment positions per account per day; sync-managed, audit off. Owner OR shared-context RLS (mirrors intents).'
);
select platform.register_table(
  'public.wb_transactions',
  p_policy_mode => 'none',
  p_audited     => false,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. Raw SimpleFIN transaction mirror; sync-managed, audit off until Phase 2 adds human columns. Owner OR shared-context RLS (mirrors intents).'
);

drop policy if exists wb_accounts_access on public.wb_accounts;
create policy wb_accounts_access on public.wb_accounts
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

drop policy if exists wb_balance_snapshots_access on public.wb_balance_snapshots;
create policy wb_balance_snapshots_access on public.wb_balance_snapshots
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

drop policy if exists wb_holding_snapshots_access on public.wb_holding_snapshots;
create policy wb_holding_snapshots_access on public.wb_holding_snapshots
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

drop policy if exists wb_transactions_access on public.wb_transactions;
create policy wb_transactions_access on public.wb_transactions
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

-- ============================================================================
-- 7. Views (security_invoker, so the policies above apply through them)
-- ============================================================================
create or replace view public.wb_account_latest
with (security_invoker = true) as
select
  a.id                                   as account_id,
  a.user_id,
  a.context_id,
  a.source,
  a.institution,
  a.name,
  a.display_name,
  coalesce(a.display_name, a.name)       as label,
  a.last4,
  a.owner,
  a.role,
  a.currency,
  a.credit_limit,
  a.reward_unit,
  a.reward_value_per_unit,
  a.expires_on,
  a.is_hidden,
  a.last_synced_at,
  s.as_of,
  s.balance,
  s.available_balance,
  s.source                               as snapshot_source,
  ((now() at time zone 'America/Los_Angeles')::date - s.as_of) as staleness_days
from public.wb_accounts a
left join lateral (
  select bs.as_of, bs.balance, bs.available_balance, bs.source
  from public.wb_balance_snapshots bs
  where bs.account_id = a.id
  order by bs.as_of desc
  limit 1
) s on true;

comment on view public.wb_account_latest is
  'App: Warren Buffet. Each account with its most recent balance snapshot and staleness in days (America/Los_Angeles). Null as_of means no snapshot yet. security_invoker, so wb_ RLS applies.';

-- Carry-forward: each day from the first snapshot to the latest, every account
-- counts its most recent balance on or before that day. Two limits on that:
-- a closed account stops at its own last snapshot, and a history_rollup counts
-- only inside active_from..active_until (no active_until = never counts).
create or replace view public.wb_net_worth_daily
with (security_invoker = true) as
with bounds as (
  select min(as_of) as first_day, max(as_of) as last_day
  from public.wb_balance_snapshots
),
days as (
  select generate_series(b.first_day, b.last_day, interval '1 day')::date as as_of
  from bounds b
  where b.first_day is not null
),
account_days as (
  select
    d.as_of,
    a.role,
    a.reward_value_per_unit,
    (
      select bs.balance
      from public.wb_balance_snapshots bs
      where bs.account_id = a.id
        and bs.as_of <= d.as_of
      order by bs.as_of desc
      limit 1
    ) as balance
  from days d
  cross join public.wb_accounts a
  left join lateral (
    select max(bs.as_of) as last_as_of
    from public.wb_balance_snapshots bs
    where bs.account_id = a.id
  ) l on true
  where (a.role <> 'closed' or d.as_of <= l.last_as_of)
    and (
      a.role <> 'history_rollup'
      or (a.active_until is not null
          and d.as_of <= a.active_until
          and (a.active_from is null or d.as_of >= a.active_from))
    )
),
grouped as (
  select
    as_of,
    coalesce(sum(balance) filter (where role = 'spending_cash'), 0)                           as spending_cash,
    coalesce(sum(balance) filter (where role = 'reserve_cash'), 0)                            as reserve_cash,
    coalesce(sum(balance) filter (where role in ('credit_card', 'emergency_credit')), 0)      as credit_owed,
    coalesce(sum(balance) filter (where role = 'loan'), 0)                                    as loans,
    coalesce(sum(balance) filter (where role = 'retirement'), 0)                              as retirement,
    coalesce(sum(balance) filter (where role = 'taxable_investment'), 0)                      as taxable_investments,
    coalesce(sum(round(balance * reward_value_per_unit, 2))
             filter (where role = 'rewards' and reward_value_per_unit is not null), 0)        as rewards,
    coalesce(sum(balance) filter (where role = 'history_rollup'), 0)                          as history_rollup,
    coalesce(sum(balance) filter (where role = 'closed'), 0)                                  as closed,
    coalesce(sum(balance) filter (where role = 'unassigned'), 0)                              as unassigned
  from account_days
  group by as_of
)
select
  as_of,
  spending_cash,
  reserve_cash,
  credit_owed,
  loans,
  retirement,
  taxable_investments,
  rewards,
  history_rollup,
  closed,
  unassigned,
  (spending_cash + reserve_cash + credit_owed + loans + retirement
   + taxable_investments + rewards + history_rollup + closed)                                 as net_worth
from grouped;

comment on view public.wb_net_worth_daily is
  'App: Warren Buffet. Per day, totals by role group and net worth, carrying each account''s last known balance forward on days with no snapshot. A closed account counts in its own closed column up to and including its last snapshot and never after. history_rollup accounts count only inside active_from..active_until; one with no active_until never counts. unassigned is shown but kept out of net_worth; rewards convert only where reward_value_per_unit is set. Debts are negative balances. security_invoker, so wb_ RLS applies.';

revoke all on public.wb_account_latest  from public, anon;
revoke all on public.wb_net_worth_daily from public, anon;
grant select on public.wb_account_latest  to authenticated, service_role;
grant select on public.wb_net_worth_daily to authenticated, service_role;

-- ============================================================================
-- 8. warren_buffet app value on the platform run log and schedules
-- ============================================================================
-- Live constraint checked 2026-10-06: dj, sam, alfred, workshop, ken.
-- (000_RECONSTRUCTED lists only four; the live database is the truth.)
alter table public.platform_runs drop constraint if exists platform_runs_app_check;
alter table public.platform_runs add constraint platform_runs_app_check
  check (app = any (array['dj', 'sam', 'alfred', 'workshop', 'ken', 'warren_buffet']));

alter table public.platform_schedules drop constraint if exists platform_schedules_app_check;
alter table public.platform_schedules add constraint platform_schedules_app_check
  check (app = any (array['dj', 'sam', 'alfred', 'workshop', 'ken', 'warren_buffet']));

commit;

-- ============================================================================
-- 9. After running: check_platform_conformance must report CONFORMANT.
--    select * from platform.conformance_failures;  -- empty = conformant
-- ============================================================================
