-- Purpose: notification routing step 12. Let get_sql_read (claude_reader) read signals.decided_by.
--   claude_reader's grants are per column, given when a table is registered (platform.apply_reader_access), so the
--   decided_by column added later (214_signals_decided_by.sql) was not readable. One column grant, as
--   206_switchboard_git_actions.sql did for switchboard_actions.picked_up_at. The row rule (Alex's rows only) is
--   unchanged. decided_by is not a secret: who decided a signal, alex or chat.
-- Kind: schema change (one column grant)
-- Applied: NO
--
-- Spec: docs/technical-spec-notification_routing-d7v.md section 4.1. Then run
-- supabase/tests/notification_routing-d7v/8_reader_decided_by_verify.sql with --test.
-- Safe to re-run: a grant that is already there is a no-op.
-- supabase/migrations/217_signals_reader_decided_by.sql

grant select (decided_by) on table public.signals to claude_reader;
