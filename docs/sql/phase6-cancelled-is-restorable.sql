-- Phase 6 — `cancelled` is restorable, not permanent.
--
-- No schema change. The state set is unchanged and the CHECK constraint already
-- allows every value used. This updates the column comment only, because the
-- comment is the authoritative description of the state machine and it
-- currently says cancelled is terminal.
--
-- What changed is behaviour, not shape: "Cancel remaining" toggles to
-- "Schedule remaining", and a per-step control cancels or restores one row.
-- Nothing AUTOMATIC ever resurrects a cancelled row — only a deliberate user
-- action — which is why cancelled is still terminal to the chain itself.
--
-- The comment is dollar-quoted. An earlier version built it from adjacent
-- string literals with E'\n\n' between them, which Postgres rejects: implicit
-- concatenation of adjacent literals does not accept an escape-string literal
-- in the middle of the run. Dollar quoting takes real newlines and real
-- double quotes with no escaping at all, which is what this text is full of.

comment on column public.notification_steps.state is
$state_comment$waiting -> scheduled -> sent -> done. Also skipped (advances the chain like done), and no_subscription (the step came due but the user has no push_subscriptions row).

cancelled: set for every remaining row when an execution closes, and by "Cancel remaining" or the per-step cancel control. It is TERMINAL TO THE CHAIN — no completion, resume or dispatch moves a row out of it — but it is NOT permanent: "Schedule remaining" and the per-step restore hand the row back to the chain. Restoring recomputes the due time from NOW rather than reinstating the original due_at, which would fire immediately for a moment that has already passed. A restored row lands in waiting if the element before it is not yet completed, or scheduled at now + offset_minutes if it already is.

A manual due_at set from the execution screen puts the row in scheduled and that time WINS over the chain: completing the preceding element leaves it alone. The override is temporary, not a mode change — reverting the row hands it back, re-arming it immediately if its predecessor has already completed, so the chain link is never severed.$state_comment$;

-- ── Verify ────────────────────────────────────────────────────────────────
select col_description('public.notification_steps'::regclass, ordinal_position) as state_comment
from information_schema.columns
where table_schema = 'public'
  and table_name = 'notification_steps'
  and column_name = 'state';

-- Sanity: the constraint already permits everything the app writes.
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.notification_steps'::regclass
  and conname = 'notification_steps_state_check';
