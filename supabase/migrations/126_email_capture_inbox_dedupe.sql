-- Purpose: email_capture-f4m Step 4. One inbox row per Postmark delivery: a partial unique index on inbox (user_id, source_metadata->>'messageId') for email rows, so a Postmark retry of a delivery already stored is refused (email-capture turns the 23505 into a 200 duplicate). Rows with no messageId (5 old ones) have a null key and are never in conflict.
-- Kind: schema change (one index)
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-email-capture.md, "Dedupe".
-- Input B (2026-10-13) showed no existing clashes, so the index builds without cleanup.
-- Run as one block; the last statement's result must show conformant true.
-- supabase/migrations/126_email_capture_inbox_dedupe.sql

begin;

create unique index if not exists inbox_email_message_id_key
  on public.inbox (user_id, (source_metadata->>'messageId'))
  where source_type = 'email';

comment on index public.inbox_email_message_id_key is
  'email_capture-f4m: one row per Postmark delivery (MessageID) per user. email-capture answers a violation with 200 duplicate so Postmark stops retrying. Null messageId is never in conflict.';

commit;

-- Conformance and the index, as the SQL editor's result. Expect conformant true,
-- failures [], and one index row whose indexdef ends WHERE (source_type = 'email'::text).
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t),
  'index', (select coalesce(json_agg(t), '[]'::json) from (
     select indexname, indexdef from pg_indexes
     where schemaname = 'public' and indexname = 'inbox_email_message_id_key') t)
) as result;
