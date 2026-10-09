-- Purpose: Warren Buffet Phase 2 Step 2 (Migration A). Merchants, tag groups, tags, rules, splits and split tags; new wb_transactions columns; split, tag and owner triggers; the four seeded tag groups; default splits for existing transactions; wb_clean_description and the other pure helpers; wb_process_transactions (security invoker); views wb_review_queue, wb_spending_by_tag, wb_cash_flow_monthly.
-- Kind: schema change (six tables, ten columns, triggers, functions, three views, a four-row seed and a default-split backfill)
-- Applied: YES — 2026-10-09 by Alex. 104 passed (69/69 tests, every check true; 394 transactions = 394 splits); conformance CONFORMANT (58 tables).
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Alex runs every file himself.
-- Spec: docs/technical-spec-warren_buffet_p2-m4t.md sections 3, 4 and 5.
-- No real financial data in this file, ever. No existing transaction is processed here (that is Step 3).
-- Run as one block in the SQL editor, then 104_wb_phase2_tests.sql.
-- supabase/migrations/103_wb_phase2_tables.sql

begin;

-- ============================================================================
-- 1. wb_merchants
-- ============================================================================
create table if not exists public.wb_merchants (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id     text not null references public.contexts(id),
  name           text not null,
  match_patterns text[] not null default '{}',
  default_kind   text,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint wb_merchants_name_check check (btrim(name) <> ''),
  constraint wb_merchants_patterns_check
    check (array_position(match_patterns, null) is null and '' <> all (match_patterns)),
  constraint wb_merchants_default_kind_check check (default_kind is null or default_kind in (
    'spend', 'income', 'transfer', 'refund', 'investment', 'interest', 'fee'))
);

create unique index if not exists wb_merchants_name_key on public.wb_merchants (context_id, lower(name));

comment on table public.wb_merchants is
  'App: Warren Buffet. One clean merchant name plus the messy bank text that maps to it. Processing matches each pattern as a case-insensitive substring of the payee first, then the raw description; the longest matching pattern wins.';
comment on column public.wb_merchants.match_patterns is 'Case-insensitive substrings; a pattern must be contained in the text, never the reverse.';
comment on column public.wb_merchants.default_kind is 'Kind given to this merchant''s transactions, ahead of the sign rules but behind the investment-account rule.';

-- ============================================================================
-- 2. wb_tag_groups
-- ============================================================================
create table if not exists public.wb_tag_groups (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id         text not null references public.contexts(id),
  name               text not null,
  exclusive          boolean not null default false,
  required_for_kinds text[] not null default '{}',
  sort_order         int not null default 0,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint wb_tag_groups_name_check check (btrim(name) <> ''),
  constraint wb_tag_groups_required_kinds_check check (required_for_kinds <@ array[
    'spend', 'income', 'transfer', 'refund', 'investment', 'interest', 'fee']::text[])
);

create unique index if not exists wb_tag_groups_name_key on public.wb_tag_groups (context_id, lower(name));

comment on table public.wb_tag_groups is
  'App: Warren Buffet. Tag groups. An exclusive group allows one tag per split, enforced by a unique index on wb_split_tags; required_for_kinds keeps a transaction of those kinds in the review queue until each of its splits has a tag from the group.';

-- ============================================================================
-- 3. wb_tags
-- ============================================================================
create table if not exists public.wb_tags (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id text not null references public.contexts(id),
  group_id   uuid not null references public.wb_tag_groups(id) on delete restrict,
  parent_id  uuid references public.wb_tags(id) on delete restrict,
  name       text not null,
  is_active  boolean not null default true,
  sort_order int not null default 0,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint wb_tags_name_check check (btrim(name) <> ''),
  constraint wb_tags_not_own_parent check (parent_id is null or parent_id <> id)
);

create unique index if not exists wb_tags_group_name_key on public.wb_tags (group_id, lower(name));
create index if not exists wb_tags_parent_idx on public.wb_tags (parent_id);

comment on table public.wb_tags is
  'App: Warren Buffet. Tags within a group. parent_id must be in the same group and never forms a cycle; reports roll children up to their top parent. Deactivate a used tag (is_active = false) rather than delete it.';

-- ============================================================================
-- 4. wb_rules
-- ============================================================================
create table if not exists public.wb_rules (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id      text not null references public.contexts(id),
  name            text not null,
  priority        int not null default 100,
  active          boolean not null default true,
  match           jsonb not null,
  set_kind        text,
  set_merchant_id uuid references public.wb_merchants(id) on delete set null,
  add_tag_ids     uuid[] not null default '{}',
  created_by      text not null,
  hit_count       int not null default 0,
  last_hit_at     timestamptz,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint wb_rules_name_check check (btrim(name) <> ''),
  constraint wb_rules_created_by_check check (created_by in ('claude', 'manual')),
  constraint wb_rules_set_kind_check check (set_kind is null or set_kind in (
    'spend', 'income', 'transfer', 'refund', 'investment', 'interest', 'fee')),
  -- An object with at least one known key, each of the right type.
  constraint wb_rules_match_check check (
    jsonb_typeof(match) = 'object'
    and match <> '{}'::jsonb
    and (match - array['merchant_id', 'payee_contains', 'description_contains', 'account_ids',
                       'amount_min', 'amount_max', 'kind']) = '{}'::jsonb
    and (not match ? 'merchant_id'          or jsonb_typeof(match -> 'merchant_id') = 'string')
    and (not match ? 'payee_contains'       or length(btrim(match ->> 'payee_contains')) > 0)
    and (not match ? 'description_contains' or length(btrim(match ->> 'description_contains')) > 0)
    and (not match ? 'account_ids'          or jsonb_typeof(match -> 'account_ids') = 'array')
    and (not match ? 'amount_min'           or jsonb_typeof(match -> 'amount_min') = 'number')
    and (not match ? 'amount_max'           or jsonb_typeof(match -> 'amount_max') = 'number')
    and (not match ? 'kind'                 or (match ->> 'kind') in (
          'spend', 'income', 'transfer', 'refund', 'investment', 'interest', 'fee'))
  )
);

comment on table public.wb_rules is
  'App: Warren Buffet. Categorization rules, run by wb_process_transactions in priority order (lower first, ties oldest first). All keys present in match must match. A rule never overwrites a claude or manual kind, merchant or tag; in an exclusive group the first rule wins. hit_count and last_hit_at are computed from wb_transactions.matched_rule_ids.';
comment on column public.wb_rules.match is 'Keys: merchant_id, payee_contains, description_contains (raw or clean), account_ids (array), amount_min / amount_max (absolute amount, inclusive), kind.';
comment on column public.wb_rules.last_hit_at is 'Date of the newest transaction this rule matches.';

-- ============================================================================
-- 5. wb_transactions: Phase 2 columns (table stays unaudited)
-- ============================================================================
alter table public.wb_transactions
  add column if not exists clean_description  text,
  add column if not exists merchant_id        uuid references public.wb_merchants(id) on delete set null,
  add column if not exists merchant_source    text,
  add column if not exists kind               text,
  add column if not exists kind_source        text,
  add column if not exists transfer_pair_id   uuid references public.wb_transactions(id) on delete set null,
  add column if not exists transfer_candidate boolean not null default false,
  add column if not exists matched_rule_ids   uuid[] not null default '{}',
  add column if not exists reviewed           boolean not null default false,
  add column if not exists processed_at       timestamptz;

alter table public.wb_transactions drop constraint if exists wb_transactions_kind_check;
alter table public.wb_transactions add constraint wb_transactions_kind_check check (kind is null or kind in (
  'spend', 'income', 'transfer', 'refund', 'investment', 'interest', 'fee'));
alter table public.wb_transactions drop constraint if exists wb_transactions_kind_source_check;
alter table public.wb_transactions add constraint wb_transactions_kind_source_check
  check (kind_source is null or kind_source in ('default', 'rule', 'claude', 'manual'));
alter table public.wb_transactions drop constraint if exists wb_transactions_merchant_source_check;
alter table public.wb_transactions add constraint wb_transactions_merchant_source_check
  check (merchant_source is null or merchant_source in ('default', 'rule', 'claude', 'manual'));
alter table public.wb_transactions drop constraint if exists wb_transactions_not_own_pair;
alter table public.wb_transactions add constraint wb_transactions_not_own_pair
  check (transfer_pair_id is null or transfer_pair_id <> id);

create index if not exists wb_transactions_pair_idx on public.wb_transactions (transfer_pair_id);
create index if not exists wb_transactions_kind_posted_idx on public.wb_transactions (kind, posted_at);

comment on column public.wb_transactions.clean_description is 'Set by wb_process_transactions from the raw description; never typed by hand.';
comment on column public.wb_transactions.merchant_source is 'default, rule, claude or manual. Processing never changes a claude or manual merchant.';
comment on column public.wb_transactions.kind is 'spend, income, transfer, refund, investment, interest or fee. Null until processed.';
comment on column public.wb_transactions.kind_source is 'default, rule, claude or manual. Processing never changes a claude or manual kind, and never pairs such a row.';
comment on column public.wb_transactions.transfer_pair_id is 'The other side of a transfer between household accounts; both rows point at each other.';
comment on column public.wb_transactions.transfer_candidate is 'Processing found a transfer to pair but no unique match; it waits in the review queue.';
comment on column public.wb_transactions.matched_rule_ids is 'Rules that matched at the last processing; wb_rules.hit_count is computed from it.';
comment on column public.wb_transactions.processed_at is 'Last time wb_process_transactions touched the row. Null = never processed.';

-- ============================================================================
-- 6. wb_splits
-- ============================================================================
create table if not exists public.wb_splits (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id     text not null references public.contexts(id),
  transaction_id uuid not null references public.wb_transactions(id) on delete cascade,
  amount         numeric(14,2) not null,
  description    text,
  tax_year       int,
  position       int not null default 0,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint wb_splits_tax_year_check check (tax_year is null or tax_year between 2000 and 2100)
);

create index if not exists wb_splits_transaction_idx on public.wb_splits (transaction_id, position);

comment on table public.wb_splits is
  'App: Warren Buffet. Parts of a transaction; tags live here. Every transaction has at least one split, created by trigger, and its splits must sum to its amount (deferred check at commit). user_id and context_id are copied from the transaction by trigger.';
comment on column public.wb_splits.tax_year is 'Null means the calendar year of the transaction.';

-- ============================================================================
-- 7. wb_split_tags
-- ============================================================================
create table if not exists public.wb_split_tags (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id      text not null references public.contexts(id),
  split_id        uuid not null references public.wb_splits(id) on delete cascade,
  tag_id          uuid not null references public.wb_tags(id) on delete restrict,
  group_id        uuid not null references public.wb_tag_groups(id) on delete restrict,
  group_exclusive boolean not null,
  source          text not null,
  rule_id         uuid references public.wb_rules(id) on delete set null,
  created_at      timestamptz not null default now(),

  constraint wb_split_tags_split_tag_key unique (split_id, tag_id),
  constraint wb_split_tags_source_check check (source in ('rule', 'claude', 'manual')),
  constraint wb_split_tags_rule_check check (rule_id is null or source = 'rule')
);

-- One tag per split per exclusive group. group_exclusive is kept in step with the
-- group by trigger, since a partial index cannot look at another table.
create unique index if not exists wb_split_tags_one_per_exclusive_group
  on public.wb_split_tags (split_id, group_id) where group_exclusive;
create index if not exists wb_split_tags_tag_idx on public.wb_split_tags (tag_id);

comment on table public.wb_split_tags is
  'App: Warren Buffet. Tags on splits, with their source (rule, claude, manual). group_id, group_exclusive, user_id and context_id are filled by trigger, never typed. Rules replace only their own tags; claude and manual tags are never overwritten by a rule.';

-- ============================================================================
-- 8. Triggers
-- ============================================================================

-- 8a. updated_at (function from 089).
drop trigger if exists wb_merchants_touch_updated_at on public.wb_merchants;
create trigger wb_merchants_touch_updated_at before update on public.wb_merchants
  for each row execute function public.wb_touch_updated_at();
drop trigger if exists wb_tag_groups_touch_updated_at on public.wb_tag_groups;
create trigger wb_tag_groups_touch_updated_at before update on public.wb_tag_groups
  for each row execute function public.wb_touch_updated_at();
drop trigger if exists wb_tags_touch_updated_at on public.wb_tags;
create trigger wb_tags_touch_updated_at before update on public.wb_tags
  for each row execute function public.wb_touch_updated_at();
drop trigger if exists wb_rules_touch_updated_at on public.wb_rules;
create trigger wb_rules_touch_updated_at before update on public.wb_rules
  for each row execute function public.wb_touch_updated_at();
drop trigger if exists wb_splits_touch_updated_at on public.wb_splits;
create trigger wb_splits_touch_updated_at before update on public.wb_splits
  for each row execute function public.wb_touch_updated_at();

-- 8b. A split takes its owner and context from its transaction.
create or replace function public.wb_splits_copy_owner()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  select t.user_id, t.context_id into new.user_id, new.context_id
  from public.wb_transactions t
  where t.id = new.transaction_id;
  if not found then
    raise exception 'wb_splits: transaction % not found', new.transaction_id using errcode = '23503';
  end if;
  return new;
end;
$$;

drop trigger if exists wb_splits_copy_owner on public.wb_splits;
create trigger wb_splits_copy_owner before insert or update on public.wb_splits
  for each row execute function public.wb_splits_copy_owner();

-- 8c. A split tag takes its group (and whether it is exclusive) from its tag,
--     and its owner and context from its split.
create or replace function public.wb_split_tags_fill()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  select g.id, g.exclusive into new.group_id, new.group_exclusive
  from public.wb_tags t
  join public.wb_tag_groups g on g.id = t.group_id
  where t.id = new.tag_id;
  if not found then
    raise exception 'wb_split_tags: tag % not found', new.tag_id using errcode = '23503';
  end if;
  select s.user_id, s.context_id into new.user_id, new.context_id
  from public.wb_splits s
  where s.id = new.split_id;
  if not found then
    raise exception 'wb_split_tags: split % not found', new.split_id using errcode = '23503';
  end if;
  return new;
end;
$$;

drop trigger if exists wb_split_tags_fill on public.wb_split_tags;
create trigger wb_split_tags_fill before insert or update on public.wb_split_tags
  for each row execute function public.wb_split_tags_fill();

-- 8d. Changing a group's exclusive flag pushes it onto its split tags. Turning it
--     on fails on the unique index if a split already has two tags from the group.
create or replace function public.wb_tag_groups_push_exclusive()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  update public.wb_split_tags set group_exclusive = new.exclusive where group_id = new.id;
  return null;
end;
$$;

drop trigger if exists wb_tag_groups_push_exclusive on public.wb_tag_groups;
create trigger wb_tag_groups_push_exclusive after update of exclusive on public.wb_tag_groups
  for each row when (old.exclusive is distinct from new.exclusive)
  execute function public.wb_tag_groups_push_exclusive();

-- 8e. Tag parent: same group, no cycle. A used tag or a parent keeps its group.
create or replace function public.wb_tags_check()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_group uuid;
  v_cur   uuid := new.parent_id;
  v_depth int := 0;
begin
  if tg_op = 'UPDATE' then
    if new.group_id is distinct from old.group_id then
      if exists (select 1 from public.wb_split_tags where tag_id = old.id) then
        raise exception 'wb_tags: tag % is in use and cannot move to another group', old.id using errcode = '23514';
      end if;
      if exists (select 1 from public.wb_tags where parent_id = old.id) then
        raise exception 'wb_tags: tag % has children and cannot move to another group', old.id using errcode = '23514';
      end if;
    end if;
  end if;
  if new.parent_id is not null then
    select group_id into v_group from public.wb_tags where id = new.parent_id;
    if v_group is distinct from new.group_id then
      raise exception 'wb_tags: parent must be in the same group' using errcode = '23514';
    end if;
    while v_cur is not null loop
      if v_cur = new.id then
        raise exception 'wb_tags: parent_id would make a cycle' using errcode = '23514';
      end if;
      v_depth := v_depth + 1;
      if v_depth > 50 then
        raise exception 'wb_tags: tag tree deeper than 50' using errcode = '23514';
      end if;
      select parent_id into v_cur from public.wb_tags where id = v_cur;
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists wb_tags_check on public.wb_tags;
create trigger wb_tags_check before insert or update on public.wb_tags
  for each row execute function public.wb_tags_check();

-- 8f. Every tag a rule adds must exist.
create or replace function public.wb_rules_check_tags()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from unnest(new.add_tag_ids) x(tag_id)
    where not exists (select 1 from public.wb_tags t where t.id = x.tag_id)
  ) then
    raise exception 'wb_rules: add_tag_ids holds a tag that does not exist' using errcode = '23503';
  end if;
  return new;
end;
$$;

drop trigger if exists wb_rules_check_tags on public.wb_rules;
create trigger wb_rules_check_tags before insert or update of add_tag_ids on public.wb_rules
  for each row execute function public.wb_rules_check_tags();

-- 8g. Default split: one full-amount split for every new transaction.
create or replace function public.wb_transactions_default_split()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  insert into public.wb_splits (transaction_id, amount, position, user_id, context_id)
  values (new.id, new.amount, 0, new.user_id, new.context_id);
  return null;
end;
$$;

drop trigger if exists wb_transactions_default_split on public.wb_transactions;
create trigger wb_transactions_default_split after insert on public.wb_transactions
  for each row execute function public.wb_transactions_default_split();

-- 8h. When the sync changes an amount, a single split follows it. Two or more
--     splits are left alone and show as split_mismatch, so the sync never fails.
create or replace function public.wb_transactions_amount_follow()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (select count(*) from public.wb_splits where transaction_id = new.id) = 1 then
    update public.wb_splits set amount = new.amount where transaction_id = new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists wb_transactions_amount_follow on public.wb_transactions;
create trigger wb_transactions_amount_follow after update of amount on public.wb_transactions
  for each row when (old.amount is distinct from new.amount)
  execute function public.wb_transactions_amount_follow();

-- 8i. Split sum, checked at commit: at least one split, summing to the amount.
--     Skipped when the transaction itself is gone (cascade delete of a pending row).
create or replace function public.wb_splits_check_sum()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_ids    uuid[] := '{}';
  v_tid    uuid;
  v_amount numeric;
  v_sum    numeric;
  v_n      int;
begin
  if tg_op in ('INSERT', 'UPDATE') then
    v_ids := v_ids || new.transaction_id;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    v_ids := v_ids || old.transaction_id;
  end if;
  for v_tid in select distinct x from unnest(v_ids) x
  loop
    select amount into v_amount from public.wb_transactions where id = v_tid;
    continue when not found;
    select count(*), coalesce(sum(amount), 0) into v_n, v_sum
    from public.wb_splits where transaction_id = v_tid;
    if v_n = 0 or v_sum <> v_amount then
      raise exception 'wb_splits: the % split(s) of transaction % sum to %, not its amount %',
        v_n, v_tid, v_sum, v_amount using errcode = '23514';
    end if;
  end loop;
  return null;
end;
$$;

-- ============================================================================
-- 9. Seed: the four tag groups (structure only, no tags), owned by the Money
--    context's own user. Default splits for every existing transaction.
--    Both run before register_table, so they write no audit rows, and the
--    backfill runs before the split-sum trigger exists: deferred events still
--    queued would make register_table's ALTER TABLE fail.
-- ============================================================================
insert into public.wb_tag_groups (user_id, context_id, name, exclusive, required_for_kinds, sort_order)
select c.user_id, c.id, g.name, g.exclusive, g.kinds, g.sort_order
from public.contexts c
cross join (values
  ('Category', true,  array['spend', 'refund', 'income', 'fee']::text[], 10),
  ('Who',      true,  array[]::text[],                                   20),
  ('Tax',      false, array[]::text[],                                   30),
  ('Label',    false, array[]::text[],                                   40)
) as g(name, exclusive, kinds, sort_order)
where c.id = 'muvitejhrgt3rgi8t6q'
on conflict do nothing;

insert into public.wb_splits (transaction_id, amount, position, user_id, context_id)
select x.id, x.amount, 0, x.user_id, x.context_id
from public.wb_transactions x
where not exists (select 1 from public.wb_splits s where s.transaction_id = x.id);

-- The split-sum check (function in 8i), created only now.
drop trigger if exists wb_splits_sum_check on public.wb_splits;
create constraint trigger wb_splits_sum_check
  after insert or update or delete on public.wb_splits
  deferrable initially deferred
  for each row execute function public.wb_splits_check_sum();

-- ============================================================================
-- 10. Pure helpers (immutable; tested in 104_wb_phase2_tests.sql)
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

  -- Masked card numbers: XXXX1234, ****1234.
  s := regexp_replace(s, '[Xx*]{2,}[- ]?[0-9]{2,4}', ' ', 'g');
  -- Reference numbers: REF #AB123, CONF: 99812, TRACE 0042 ...
  s := regexp_replace(s, '\m(REF|REFERENCE|CONF|CONFIRMATION|TRACE|TRN)\M\s*(#|NO\.?|NUM|:)?\s*[A-Z0-9-]*[0-9][A-Z0-9-]*', ' ', 'gi');
  -- Codes after an asterisk ("MKTP US*2K4HJ1"); a name after one ("SQ *CAFE") stays.
  s := regexp_replace(s, '\*\s*[A-Z0-9]*[0-9][A-Z0-9]*', ' ', 'gi');
  -- Phone numbers.
  s := regexp_replace(s, '\(?[0-9]{3}\)?[-. ]?[0-9]{3}[-. ][0-9]{4}', ' ', 'g');
  -- Store numbers and digit runs of four or more.
  s := regexp_replace(s, '#\s*[0-9]+', ' ', 'g');
  s := regexp_replace(s, '\m[0-9]{4,}\M', ' ', 'g');

  s := replace(s, '*', ' ');
  s := regexp_replace(s, '\s+', ' ', 'g');
  s := btrim(s, ' -#.,:;/');

  -- Trailing "CITY ST" (one word and a state code), only when a merchant matched.
  if p_strip_location then
    s := regexp_replace(s, '\s+[A-Za-z.]+\s+(AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)$', '');
    s := btrim(s, ' -#.,:;/');
  end if;

  return nullif(s, '');
end;
$$;

comment on function public.wb_clean_description(text, boolean) is
  'Warren Buffet: readable description from raw bank text. Decodes HTML entities; drops masked card numbers, reference numbers, asterisk codes, phone numbers, store numbers and digit runs of four or more; collapses whitespace. With p_strip_location, also drops a trailing one-word city and state code.';

create or replace function public.wb_is_transfer_phrase(p_text text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(p_text ~* '(payment\s*-?\s*thank\s*you|online\s+payment|auto\s*pay|online\s+transfer|transfer\s+(to|from)|\mxfer\M|\mepay\M|card\s+payment)', false);
$$;

create or replace function public.wb_is_interest_phrase(p_text text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(p_text ~* '\minterest\M', false);
$$;

create or replace function public.wb_is_fee_phrase(p_text text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(p_text ~* '(\mfees?\M|interest\s+charge|finance\s+charge|overdraft|\mnsf\M|service\s+charge)', false);
$$;

-- Precedence (spec §5 step 3): investment account, merchant default, transfer
-- phrase, positive interest, negative fee, card refund, income, spend.
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
    when public.wb_is_transfer_phrase(concat_ws(' ', p_description, p_payee)) then 'transfer'
    when p_amount > 0 and public.wb_is_interest_phrase(concat_ws(' ', p_description, p_payee)) then 'interest'
    when p_amount < 0 and public.wb_is_fee_phrase(concat_ws(' ', p_description, p_payee)) then 'fee'
    when p_amount > 0 and p_account_role in ('credit_card', 'emergency_credit') then 'refund'
    when p_amount > 0 then 'income'
    else 'spend'
  end;
$$;

create or replace function public.wb_transfer_match(
  p_a_account uuid, p_a_amount numeric, p_a_date date,
  p_b_account uuid, p_b_amount numeric, p_b_date date)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(
    p_a_account <> p_b_account
    and p_a_amount <> 0
    and p_a_amount = -p_b_amount
    and abs(p_a_date - p_b_date) <= 5,
    false);
$$;

-- forward = matches found from the candidate; reverse = candidates found back from
-- that one match. Only one each way is safe to pair.
create or replace function public.wb_pair_decision(p_forward int, p_reverse int)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when coalesce(p_forward, 0) = 0 then 'none'
    when p_forward = 1 and p_reverse = 1 then 'pair'
    else 'ambiguous'
  end;
$$;

create or replace function public.wb_rule_matches(
  p_match jsonb, p_account_id uuid, p_amount numeric, p_payee text, p_description text,
  p_clean text, p_merchant_id uuid, p_kind text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(
    (not p_match ? 'merchant_id' or p_merchant_id::text = p_match ->> 'merchant_id')
    and (not p_match ? 'payee_contains'
         or position(lower(p_match ->> 'payee_contains') in lower(coalesce(p_payee, ''))) > 0)
    and (not p_match ? 'description_contains'
         or position(lower(p_match ->> 'description_contains') in lower(coalesce(p_description, ''))) > 0
         or position(lower(p_match ->> 'description_contains') in lower(coalesce(p_clean, ''))) > 0)
    and (not p_match ? 'account_ids' or (p_match -> 'account_ids') ? p_account_id::text)
    and (not p_match ? 'amount_min' or abs(p_amount) >= (p_match ->> 'amount_min')::numeric)
    and (not p_match ? 'amount_max' or abs(p_amount) <= (p_match ->> 'amount_max')::numeric)
    and (not p_match ? 'kind' or p_kind = p_match ->> 'kind'),
    false);
$$;

-- ============================================================================
-- 11. wb_process_transactions (spec §5). SECURITY INVOKER: RLS applies to the
--     caller, the service role bypasses it, and audit attribution is kept.
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

    update public.wb_transactions
    set clean_description  = v_clean,
        merchant_id        = v_merchant,
        merchant_source    = v_msource,
        kind               = v_kind,
        kind_source        = v_ksource,
        transfer_candidate = false
    where id = t.id;

    -- 4. Transfer pairing: posted rows on household accounts, never claude/manual.
    if not t.pending
       and t.transfer_pair_id is null
       and v_kind = 'transfer'
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
      else
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
  'Warren Buffet: clean, merchant, default kind, transfer pairing and rules for the given transactions (spec §5). Security invoker. Never changes a claude or manual kind, merchant or tag; pairs and tags posted rows only. Safe to re-run. Returns counts.';

-- Callable by signed-in users and the service role only.
revoke all on function public.wb_clean_description(text, boolean) from public, anon;
revoke all on function public.wb_is_transfer_phrase(text) from public, anon;
revoke all on function public.wb_is_interest_phrase(text) from public, anon;
revoke all on function public.wb_is_fee_phrase(text) from public, anon;
revoke all on function public.wb_default_kind(text, numeric, text, text, text) from public, anon;
revoke all on function public.wb_transfer_match(uuid, numeric, date, uuid, numeric, date) from public, anon;
revoke all on function public.wb_pair_decision(int, int) from public, anon;
revoke all on function public.wb_rule_matches(jsonb, uuid, numeric, text, text, text, uuid, text) from public, anon;
revoke all on function public.wb_process_transactions(uuid[]) from public, anon;
grant execute on function public.wb_clean_description(text, boolean) to authenticated, service_role;
grant execute on function public.wb_is_transfer_phrase(text) to authenticated, service_role;
grant execute on function public.wb_is_interest_phrase(text) to authenticated, service_role;
grant execute on function public.wb_is_fee_phrase(text) to authenticated, service_role;
grant execute on function public.wb_default_kind(text, numeric, text, text, text) to authenticated, service_role;
grant execute on function public.wb_transfer_match(uuid, numeric, date, uuid, numeric, date) to authenticated, service_role;
grant execute on function public.wb_pair_decision(int, int) to authenticated, service_role;
grant execute on function public.wb_rule_matches(jsonb, uuid, numeric, text, text, text, uuid, text) to authenticated, service_role;
grant execute on function public.wb_process_transactions(uuid[]) to authenticated, service_role;

-- ============================================================================
-- 12. Register with the platform, then the shared-context policy (mirrors intents)
-- ============================================================================
select platform.register_table(
  'public.wb_merchants',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. Merchants and the bank-text patterns that map to them. Owner OR shared-context RLS (mirrors intents).'
);
select platform.register_table(
  'public.wb_tag_groups',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. Tag groups; exclusive groups allow one tag per split. Owner OR shared-context RLS (mirrors intents).'
);
select platform.register_table(
  'public.wb_tags',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. Tags with same-group parents. Owner OR shared-context RLS (mirrors intents).'
);
select platform.register_table(
  'public.wb_rules',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. Categorization rules run by wb_process_transactions. Owner OR shared-context RLS (mirrors intents).'
);
select platform.register_table(
  'public.wb_splits',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. Parts of a transaction, summing to its amount; tags live here. Owner OR shared-context RLS (mirrors intents).'
);
select platform.register_table(
  'public.wb_split_tags',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. Tags on splits with source rule, claude or manual; exclusive groups enforced by index. Owner OR shared-context RLS (mirrors intents).'
);

drop policy if exists wb_merchants_access on public.wb_merchants;
create policy wb_merchants_access on public.wb_merchants
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

drop policy if exists wb_tag_groups_access on public.wb_tag_groups;
create policy wb_tag_groups_access on public.wb_tag_groups
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

drop policy if exists wb_tags_access on public.wb_tags;
create policy wb_tags_access on public.wb_tags
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

drop policy if exists wb_rules_access on public.wb_rules;
create policy wb_rules_access on public.wb_rules
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

drop policy if exists wb_splits_access on public.wb_splits;
create policy wb_splits_access on public.wb_splits
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

drop policy if exists wb_split_tags_access on public.wb_split_tags;
create policy wb_split_tags_access on public.wb_split_tags
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

-- ============================================================================
-- 13. Views (security_invoker, so the policies above apply through them).
--     Dates are Pacific, from coalesce(posted_at, transacted_at). Money out is negative.
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
  'App: Warren Buffet. One row per transaction and reason: no_kind, missing_required_tag (detail = group), transfer_candidate, split_mismatch. Tag and transfer reasons cover posted, unreviewed rows only; split_mismatch shows even when reviewed. price_change and new_recurring arrive in Step 7. security_invoker, so wb_ RLS applies.';

create or replace view public.wb_spending_by_tag
with (security_invoker = true) as
with recursive tag_top as (
  select t.id as tag_id, t.id as top_id
  from public.wb_tags t
  where t.parent_id is null
  union all
  select c.id, tt.top_id
  from public.wb_tags c
  join tag_top tt on c.parent_id = tt.tag_id
),
spend_splits as (
  select
    s.id as split_id,
    s.amount,
    date_trunc('month', (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles'))::date as month
  from public.wb_splits s
  join public.wb_transactions x on x.id = s.transaction_id
  where x.kind in ('spend', 'refund', 'fee')
    and not x.pending
),
tagged as (
  select ss.month, ss.split_id, ss.amount, st.group_id, st.tag_id, tt.top_id
  from spend_splits ss
  join public.wb_split_tags st on st.split_id = ss.split_id
  join tag_top tt on tt.tag_id = st.tag_id
)
select tg.month, g.id as group_id, g.name as group_name, 'leaf'::text as level,
       t.id as tag_id, t.name as tag_name, sum(tg.amount) as amount, count(distinct tg.split_id) as splits
from tagged tg
join public.wb_tag_groups g on g.id = tg.group_id
join public.wb_tags t on t.id = tg.tag_id
group by tg.month, g.id, g.name, t.id, t.name
union all
select tg.month, g.id, g.name, 'top', t.id, t.name, sum(tg.amount), count(distinct tg.split_id)
from tagged tg
join public.wb_tag_groups g on g.id = tg.group_id
join public.wb_tags t on t.id = tg.top_id
group by tg.month, g.id, g.name, t.id, t.name
union all
select ss.month, g.id, g.name, lvl.level, null::uuid, null::text, sum(ss.amount), count(*)
from spend_splits ss
cross join public.wb_tag_groups g
cross join (values ('leaf'::text), ('top'::text)) as lvl(level)
where g.exclusive
  and not exists (select 1 from public.wb_split_tags st where st.split_id = ss.split_id and st.group_id = g.id)
group by ss.month, g.id, g.name, lvl.level;

comment on view public.wb_spending_by_tag is
  'App: Warren Buffet. Per month, group and tag, the sum of split amounts for kinds spend, refund and fee (posted rows; negative = money out). level leaf = the tag itself, top = rolled up to its top parent. Exclusive groups also have an untagged row (tag_id null), so their rows add up to total spending; in open groups a split with two tags counts under both. security_invoker, so wb_ RLS applies.';

create or replace view public.wb_cash_flow_monthly
with (security_invoker = true) as
with m as (
  select
    date_trunc('month', (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles'))::date as month,
    coalesce(sum(x.amount) filter (where x.kind in ('income', 'interest')), 0)      as income,
    coalesce(sum(x.amount) filter (where x.kind in ('spend', 'refund', 'fee')), 0)  as spending,
    count(*) filter (where x.kind is null)                                         as unprocessed
  from public.wb_transactions x
  where not x.pending
  group by 1
)
select month, income, spending, income + spending as net, unprocessed
from m;

comment on view public.wb_cash_flow_monthly is
  'App: Warren Buffet. Per month (posted rows): income (income + interest), spending (spend + refund + fee, negative = money out), net, and how many rows are not yet processed. Transfers and investments excluded. security_invoker, so wb_ RLS applies.';

revoke all on public.wb_review_queue      from public, anon;
revoke all on public.wb_spending_by_tag   from public, anon;
revoke all on public.wb_cash_flow_monthly from public, anon;
grant select on public.wb_review_queue      to authenticated, service_role;
grant select on public.wb_spending_by_tag   to authenticated, service_role;
grant select on public.wb_cash_flow_monthly to authenticated, service_role;

commit;

-- ============================================================================
-- 14. After running: run 104_wb_phase2_tests.sql; check_platform_conformance
--     must report CONFORMANT.
-- ============================================================================
