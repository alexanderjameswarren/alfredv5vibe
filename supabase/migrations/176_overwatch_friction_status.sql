-- Purpose: Overwatch Step 25 (Phase 5). process_friction gets a status: open (the default), fixed or wont_fix, and a
-- wont_fix_reason that a wont_fix entry must have. resolved_by and resolved_at are stamped for fixed and wont_fix
-- alike and are null while open. Only open entries count toward the weekly job's three-in-30-days trigger.
-- Existing rows become open, or fixed where resolved_at is already set.
-- Kind: schema change (two columns, three checks, the open index rebuilt) plus a one-time status backfill
-- Applied: NO
--
-- Spec: docs/technical-spec-overwatch-q4n.md section 4.11. Run as one block in the SQL editor.
-- Then run supabase/tests/overwatch-q4n/19_friction_status_test.sql.
-- Safe to re-run: the columns and index are idempotent, the checks are dropped and re-added, and the backfill only
-- touches resolved rows still marked open.
-- supabase/migrations/176_overwatch_friction_status.sql

begin;

-- ============================================================================
-- 1. The columns
-- ============================================================================
alter table public.process_friction add column if not exists status text not null default 'open';
alter table public.process_friction add column if not exists wont_fix_reason text;

comment on column public.process_friction.status is
  'open (the default), fixed or wont_fix. Set by update_friction. Only open entries count toward the weekly trigger.';
comment on column public.process_friction.wont_fix_reason is
  'One line on why it will not be fixed; required when status is wont_fix, null otherwise.';
comment on column public.process_friction.resolved_by is
  'Who or what closed it (a skill change, a prompt change, or the decision not to fix); set with resolved_at for '
  'fixed and wont_fix, null while open.';
comment on column public.process_friction.resolved_at is 'When it was closed as fixed or wont_fix; null while open.';
comment on table public.process_friction is
  'OVERWATCH. Snags in how any of Alex''s workflows run, coding or not: a missed instruction, a testing format that '
  'confused him, a prompt he had to correct, a chat flow in any app that did not work. Any thread logs one with '
  'log_friction, without asking. Fixes wait for a pattern: the weekly job groups open entries by process and proposes '
  'a fix once a process has three or more open in 30 days. Closed as fixed or wont_fix (with a reason) by '
  'update_friction. Spec: docs/technical-spec-overwatch-q4n.md 4.11.';

-- ============================================================================
-- 2. Backfill: already resolved means fixed
-- ============================================================================
update public.process_friction set status = 'fixed' where resolved_at is not null and status = 'open';

-- ============================================================================
-- 3. Checks
-- ============================================================================
alter table public.process_friction drop constraint if exists process_friction_status_values;
alter table public.process_friction add constraint process_friction_status_values
  check (status in ('open', 'fixed', 'wont_fix'));

alter table public.process_friction drop constraint if exists process_friction_status_resolved;
alter table public.process_friction add constraint process_friction_status_resolved
  check ((status = 'open') = (resolved_at is null));

alter table public.process_friction drop constraint if exists process_friction_wont_fix_reason;
alter table public.process_friction add constraint process_friction_wont_fix_reason
  check (case when status = 'wont_fix' then coalesce(btrim(wont_fix_reason), '') <> ''
              else wont_fix_reason is null end);

-- ============================================================================
-- 4. The open index now follows status
-- ============================================================================
drop index if exists public.process_friction_open_idx;
create index process_friction_open_idx
  on public.process_friction (user_id, process, occurred_at desc) where status = 'open';

commit;

-- ============================================================================
-- 5. Check
-- ============================================================================
select json_build_object(
  'columns', (select coalesce(json_agg(t), '[]'::json) from (
      select count(*) as columns, count(*) filter (where col_description(a.attrelid, a.attnum) is null) as without_comment
        from pg_attribute a where a.attrelid = 'public.process_friction'::regclass and a.attnum > 0 and not a.attisdropped
    ) t),
  'by_status', (select coalesce(json_agg(t), '[]'::json) from (
      select status, count(*) as entries, count(*) filter (where resolved_at is not null) as with_resolved_at
        from public.process_friction group by status order by status
    ) t),
  'checks', (select coalesce(json_agg(t), '[]'::json) from (
      select conname from pg_constraint where conrelid = 'public.process_friction'::regclass and contype = 'c' order by 1
    ) t),
  'conformance', public.platform_check_conformance()
) as result;
