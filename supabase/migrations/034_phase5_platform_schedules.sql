-- MOVED 2026-09-18 from docs/sql/phase5-platform-schedules.sql
-- Originally written 2026-09-04. Content unchanged below this header.
-- Purpose: Phase 5: register the dispatcher in platform_schedules so a silent failure becomes visible. Staleness detection only; it runs nothing.
-- Kind: data insert
-- Applied: unknown
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here, not the order they were run; the original
-- date above is the historical record. Alex runs every file himself.

-- Phase 5 — register the dispatcher in platform_schedules.
--
-- ⚠️ platform_schedules is STALENESS DETECTION ONLY. It describes what SHOULD
-- run and executes nothing. pg_cron is what actually runs the job; this row is
-- what makes a silent failure visible, by giving something to compare
-- last-seen-activity against.
--
-- The cadence vocabulary is daily/weekly, which cannot express "every minute".
-- The dispatcher is therefore registered at the coarsest honest granularity —
-- if a whole day passes with no dispatch activity, something is broken. The
-- per-step timing lives entirely in notification_steps.due_at and is not
-- describable here.
--
-- ⚠️ COLUMN NAMES ARE UNVERIFIED. Both MCP connectors were down when this was
-- drafted, so it is written from the create_platform_schedule tool's shape
-- rather than from the live table. Run step 0 first and adjust if it disagrees.

-- ── 0. Check the shape before inserting ────────────────────────────────────
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'platform_schedules'
order by ordinal_position;

-- ── 1. Register (adjust column names to match step 0) ──────────────────────
-- insert into public.platform_schedules (name, cadence, description, owner)
-- values (
--   'notify-dispatch',
--   'daily',
--   'Edge function notify-dispatch, run every minute by pg_cron job '
--     || '"notify-dispatch-every-minute", sends due notification_steps as Web Push. '
--     || 'Staleness only: a day with no activity means cron, pg_net, or the '
--     || 'function is broken. Real cadence is per-minute and is not expressible here.',
--   'alfred'
-- );

-- ── 2. Confirm ─────────────────────────────────────────────────────────────
-- select * from public.platform_schedules where name = 'notify-dispatch';
