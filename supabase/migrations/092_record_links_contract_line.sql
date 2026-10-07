-- Purpose: Record links Step 5. Append one line to COMMENT ON SCHEMA platform (the platform contract, returned by get_platform_contract) telling Claude to link records by id.
-- Kind: schema change (schema comment only)
-- Applied: NO — awaiting Alex.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here. Alex runs every file himself.
-- Progress: docs/progress-record_links-r7k.md.
-- supabase/migrations/092_record_links_contract_line.sql
--
-- No migration in this repo has ever set the platform comment, so there is no
-- repo copy to restate. This reads the LIVE comment and appends the line, so no
-- existing text can be lost. Idempotent: a second run changes nothing.

do $$
declare
  v_line constant text :=
    'When you mention any Alfred, SAM, Ken, DJ or Warren Buffet record, link it as '
    || 'https://alfredv5vibe.vercel.app/<id> using its id, instead of describing where to find it.';
  v_old text := obj_description('platform'::regnamespace, 'pg_namespace');
begin
  if v_old is null then
    raise exception 'platform schema has no comment; refusing to replace the contract with one line.';
  end if;
  if position(v_line in v_old) > 0 then
    raise notice 'Contract already contains the record-link line; nothing to do.';
    return;
  end if;
  -- The live comment uses CRLF line endings; match them.
  execute format('comment on schema platform is %L',
                 rtrim(v_old, E'\r\n') || E'\r\n\r\n' || v_line);
end;
$$;

-- After running: the combined check in the Step 5 report (conformance + line present).
