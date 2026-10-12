-- Purpose: Restructure Phase 3, step 8. Correct public.clips' platform registry note, which still says triage hard-deletes inbox rows. Processing and discarding both archive now; nothing deletes inbox rows.
-- Kind: registry metadata (one row in platform.registry; no schema, RLS or data change)
-- Applied: YES — confirmed 2026-10-12, CONFORMANT
--
-- Spec: docs/technical-spec-restructure_p3.md. Run as one block in the SQL editor.
-- supabase/migrations/122_restructure_p3_clips_registry_note.sql
--
-- A direct update of the note rather than a second register_table call: the
-- repo has no precedent for re-registering, and register_table also sets up
-- RLS and grants, which this change must not touch. Columns as read in 052.

do $$
declare
  n int;
begin
  update platform.registry
     set notes = 'App: Alfred Clipboard. One row per captured page or pushed CLI report; holds the heavy page text, links and slice paths so the paired inbox row stays light. inbox_id has no FK: it predates the decision that inbox rows are archived, never deleted (processing and discarding both archive).'
   where table_name = 'public.clips';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'Expected to update 1 platform.registry row for public.clips, updated %.', n;
  end if;
end
$$;

-- Must return CONFORMANT.
select public.platform_check_conformance();
