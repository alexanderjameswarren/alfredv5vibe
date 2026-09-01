-- 009 - bring dj_known_disagreements onto the paved path
--
-- ============================================================================
-- WHY THIS EXISTS: 008 BYPASSED THE CONTRACT
-- ============================================================================
-- Migration 008 used a raw `create table` plus a hand-written RLS policy and
-- never called platform.register_table(). check_platform_conformance caught it:
--
--   public.dj_known_disagreements: NOT REGISTERED - migration did not call
--   platform.register_table(); NOT AUDITED - no audit_trigger and no registry
--   declaration
--
-- The check working is the paved path doing its job. But the table was live and
-- outside the contract meanwhile, which is the state the registry exists to make
-- impossible to hold silently.
--
-- ⚠️ A migration that does everything except join the system is not a careful
-- migration. 008 had detailed comments, RLS, a seed and verification blocks -
-- and skipped the single line that puts it under the rules.
--
-- ⚠️ AND THE FIRST ATTEMPT AT THIS FILE GOT THE SIGNATURE WRONG, by copying it
-- from 000_RECONSTRUCTED - a file whose own header says its register_table calls
-- are best-effort guesses. It failed with:
--
--   ERROR: function platform.register_table(unknown, audited => boolean,
--   exempt => boolean) does not exist
--
-- The real signature was verified from the DATABASE via get_platform_contract,
-- which is where the contract lives by design.
--
-- ⚠️ There was no correct example on disk to copy instead: NO migration in this
-- repo creates a table, so 000_RECONSTRUCTED's guesses were the only
-- register_table calls present. Checking a second file would not have helped.
-- Only asking the database would. **Never copy a shape from a file that says it
-- is reconstructed - and prefer the queryable authority to any file at all.**
--
-- ============================================================================
-- AUDITED => TRUE, DELIBERATELY
-- ============================================================================
-- Decided, not defaulted, because the neighbours differ: platform_runs and
-- dj_plays are audited => false (high-volume append-only telemetry; an audit of
-- a log is a log of a log), while dj_tracks and platform_schedules are true.
--
-- This one is audited, and the reason is specific: THIS TABLE'S ONLY PURPOSE IS
-- TO SILENCE ALARMS. "Who suppressed which warning, and when" is exactly what an
-- audit trail is for. Three supporting facts:
--
--   1. Volume is tiny - 13 rows, changed rarely and by hand. The cost argument
--      that exempts platform_runs does not apply.
--   2. Rows are hand-inserted, the case an audit most helps: a careless or
--      mistaken INSERT here removes a signal, invisibly by construction.
--   3. decided_by and decided_at are SELF-REPORTED by whoever writes the row,
--      and decided_by even has a default. They record the CLAIM; the audit
--      trigger records the EVENT. Only the second is independent of the writer.
--
-- p_policy_mode => 'owner': the table has its own user_id column, so the
-- standard user_id = auth.uid() policy is exactly right. 'none' is for tables
-- with custom RLS or with no user_id that reach ownership through a parent.

-- register_table() creates the owner policy itself, so 008's hand-written one is
-- dropped rather than left beside it. Two policies on one table are OR'd, which
-- means the hand-written one could silently WIDEN access that the paved path
-- intended to narrow - and nothing would report it.
drop policy if exists dj_known_disagreements_owner on public.dj_known_disagreements;

-- Schema-qualified deliberately. The parameter is regclass, so an unqualified
-- name resolves through search_path: it works in the SQL editor and drifts
-- everywhere else. (Contract rule 2.)
select platform.register_table(
  'public.dj_known_disagreements',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: DJ. Artist disagreements that have been DECIDED and must stop notifying. Authoritative; docs/dj-known-disagreements.md renders it. Audited because this table exists to silence alarms and decided_by is self-reported. Written by hand only - no tool writes it.'
);

-- ---------------------------------------------------------------------------
-- VERIFY - registration, the seeded rows, RLS, and the contract as a whole.
-- ---------------------------------------------------------------------------
do $$
declare n int; rls boolean;
begin
  -- The 13 decisions from 008 must have survived.
  select count(*) into n from public.dj_known_disagreements;
  if n <> 13 then
    raise exception 'Expected the 13 seeded decisions to survive registration, found %.', n;
  end if;

  -- Registered.
  if not exists (
    select 1 from platform.registry
     where table_name = 'public.dj_known_disagreements'
  ) then
    raise exception 'register_table did not record the table in platform.registry.';
  end if;

  -- RLS on, WITH a policy. Dropping 008's policy without a replacement would
  -- leave a table that is RLS-enabled and denies everything - which looks like
  -- working security and is a total outage.
  select relrowsecurity into rls
    from pg_class where oid = 'public.dj_known_disagreements'::regclass;
  if not rls then
    raise exception 'Row level security is OFF after registration.';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'dj_known_disagreements'
  ) then
    raise exception 'RLS is enabled but NO policy exists - the table denies '
      'everything. 008''s policy was dropped and not replaced.';
  end if;

  -- The contract's own check, run here rather than left to a later tool call.
  -- "Run check_platform_conformance as the final step of every migration block"
  -- - so do it inside the block, where failing still aborts.
  if exists (select 1 from platform.conformance_failures) then
    raise exception 'platform.conformance_failures is not empty after this '
      'migration. Run: select * from platform.conformance_failures;';
  end if;
end $$;

-- Belt and braces, from a tool call rather than SQL:
--   check_platform_conformance   ->  must report CONFORMANT
