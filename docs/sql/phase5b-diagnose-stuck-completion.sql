-- Diagnostic — why did ticking "Marinate" change nothing?
--
-- The state machine has been ruled out by test: planCompletion handles a `sent`
-- row correctly and produces BOTH the done transition and the next row's
-- scheduling. So the failure is in the WRITE, and these queries say which kind.
--
-- Run against the affected execution.

-- ── 1. Ownership — the leading hypothesis ──────────────────────────────────
--
-- The dispatcher updates rows with the SERVICE ROLE, which bypasses RLS. If
-- anything in that path cleared or altered user_id, the row would stop matching
-- the owner policy and the browser's UPDATE would be silently refused — while
-- neighbouring rows the dispatcher never touched stay writable.
--
-- Look for: a NULL or differing user_id on exactly the row that was sent.
select seq,
       text,
       state,
       user_id,
       due_at,
       sent_at,
       completed_at,
       user_id is null              as user_id_is_null,
       user_id = (select auth.uid()) as owned_by_me
from public.notification_steps
where execution_id = '<EXECUTION_ID>'
order by seq;

-- ── 2. Do all rows in this execution agree on owner? ───────────────────────
-- More than one row here means the dispatcher changed ownership.
select user_id, count(*), array_agg(seq order by seq) as seqs
from public.notification_steps
where execution_id = '<EXECUTION_ID>'
group by user_id;

-- ── 3. What can this user actually write? ──────────────────────────────────
-- Run as the signed-in user, not as service role. A row visible here is one the
-- owner policy admits; a row missing from this list but present in query 1 is
-- the smoking gun.
select seq, state
from public.notification_steps
where execution_id = '<EXECUTION_ID>'
order by seq;

-- ── 4. The policies themselves ─────────────────────────────────────────────
select polname,
       polcmd,
       pg_get_expr(polqual, polrelid)      as using_expr,
       pg_get_expr(polwithcheck, polrelid) as with_check_expr
from pg_policy
where polrelid = 'public.notification_steps'::regclass;

-- ── 5. Audit trail for the row that will not move ──────────────────────────
-- notification_steps is registered p_audited => true, so every UPDATE should
-- have left a trace. Adjust the table name if the audit table is named
-- differently.
-- select * from platform.audit_log
--  where table_name = 'notification_steps'
--  order by created_at desc limit 20;
