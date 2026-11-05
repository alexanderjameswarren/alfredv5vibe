-- Purpose: notification routing step 10i. Give the Arnold morning review one name in the notification log:
-- started_by task:arnold_morning_review (step 3's backfill spelled it from the job name) becomes
-- task:arnold-morning-review, as its live prompt writes it. On 2026-11-05 there were 2 such rows:
-- 01eabd28-0654-441f-b85f-edd3b4593c34 and 5ca6fc7b-b1d3-447e-9b25-720111aebdaa. Nothing else changes.
-- Kind: one-off data repair (one update, 2 rows expected)
-- Applied: NO
--
-- The guard trigger refuses any change to started_by, so it is off for this one update only, as in 210.
-- supabase/migrations/211_started_by_arnold_morning_review.sql

begin;

alter table public.claude_notifications disable trigger claude_notifications_guard_update;

update public.claude_notifications
   set started_by = 'task:arnold-morning-review'
 where started_by = 'task:arnold_morning_review';

alter table public.claude_notifications enable trigger claude_notifications_guard_update;

commit;
