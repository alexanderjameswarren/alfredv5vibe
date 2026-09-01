-- 009 - bring dj_known_disagreements onto the paved path
--
-- ============================================================================
-- WHY THIS EXISTS: 008 BYPASSED THE CONTRACT
-- ============================================================================
-- Migration 008 used a raw `create table` plus a hand-written RLS policy, and
-- never called platform.register_table(). check_platform_conformance caught it:
--
--   table_name:     public.dj_known_disagreements
--   issue_registry: NOT REGISTERED - migration did not call register_table()
--   issue_audit:    NOT AUDITED - no audit_trigger and no registry declaration
--
-- The check working is the paved path doing its job. But the table was live and
-- outside the contract in the meantime, which is exactly the state the registry
-- exists to make impossible to hold silently.
--
-- ⚠️ THE LESSON, AND IT IS THE ONE THIS PROJECT KEEPS RELEARNING: every other
-- table in this system goes through register_table(), and the contract says
-- every migration ends with check_platform_conformance. I wrote a careful
-- migration with detailed comments and RLS and verification blocks - and skipped
-- the one line that puts it under the rules. A migration that does everything
-- except join the system is not a careful migration.
--
-- ============================================================================
-- AUDITED => TRUE, DELIBERATELY
-- ============================================================================
-- Decided rather than defaulted, because the two neighbouring tables answer it
-- differently: platform_runs is audited => false (high-volume telemetry; an
-- audit of a log is a log of a log) and platform_schedules is audited => true.
--
-- This one is audited, and the reason is specific: THIS TABLE'S ONLY PURPOSE IS
-- TO SILENCE ALARMS. "Who suppressed which warning, and when" is precisely what
-- an audit trail is for. Three supporting facts:
--
--   1. Volume is tiny - 13 rows, changed rarely and by hand. The cost argument
--      that makes platform_runs unaudited does not apply.
--   2. Rows are hand-inserted, which is the case an audit most helps: a careless
--      or mistaken INSERT here removes a signal, and does so invisibly by
--      construction.
--   3. `decided_by` and `decided_at` are SELF-REPORTED by whoever writes the
--      row, and decided_by even has a default. They record the claim; the audit
--      trigger records the event. Those are not the same thing, and only the
--      second is independent of the writer.
--
-- ============================================================================
-- RUN check_platform_conformance AFTER THIS. It must report CONFORMANT.
-- ============================================================================

-- register_table() owns row-level security for the tables it manages, so 008's
-- hand-written policy is dropped rather than left alongside. Two policies on one
-- table are OR'd, which means the hand-written one could silently widen access
-- that register_table intended to narrow - and nothing would report it.
drop policy if exists dj_known_disagreements_owner on public.dj_known_disagreements;

select platform.register_table(
  'dj_known_disagreements',
  audited => true,
  exempt  => false
);

-- ---------------------------------------------------------------------------
-- VERIFY - the seeded rows must have survived, and RLS must still be on.
-- ---------------------------------------------------------------------------
do $$
declare n int; rls boolean;
begin
  select count(*) into n from public.dj_known_disagreements;
  if n <> 13 then
    raise exception 'Expected the 13 seeded decisions to survive registration, found %.', n;
  end if;

  select relrowsecurity into rls
    from pg_class where oid = 'public.dj_known_disagreements'::regclass;
  if not rls then
    raise exception 'Row level security is OFF after registration. Dropping 008''s '
      'policy must not have left the table unprotected.';
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'dj_known_disagreements'
  ) then
    raise exception 'No RLS policy exists after registration. 008''s policy was '
      'dropped and register_table did not replace it - the table is enabled for '
      'RLS with no policy, which denies everything.';
  end if;
end $$;

-- Then, from a tool call rather than SQL:
--   check_platform_conformance   ->  must report CONFORMANT
