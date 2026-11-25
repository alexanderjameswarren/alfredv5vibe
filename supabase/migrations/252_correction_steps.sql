-- 252, sb3_pages-h6v s14 and s14b (follow-up to 251): a write's correction gets its own steps back, a sandbox can be
-- added, and the chat can't send the kept steps. Schema change (functions only). Spec: docs/technical-spec-sb3_pages-h6v.md
-- 10c, 10d.
-- Functions replaced: switchboard_queue_run_request, switchboard_correct_run_request, switchboard_record_run_evidence
-- (251), whole.
-- Tables written by them: switchboard_run_requests, switchboard_run_links, switchboard_run_samples (the queue's sample
-- move, as 251), switchboard_code_reviews (the code correction's supersede, as 250/251). No table is altered. No data
-- changes.
--
-- 1. The steps (10d open item 1): a correction page's steps are only what its edit reruns, and 251 stored them in
--    place of the request's own, so once the reruns passed and the request returned to its base page, the write's
--    approve page listed rerun steps. Now a correction that reruns a check keeps the request's own steps and phases in
--    request.base_steps and request.base_phases (taken from the row, never from the chat; a second correction keeps
--    the first one's), and switchboard_record_run_evidence restores them when it returns the request to its base page.
--    A multi-object run's write_step entries take their object, kind and count from operation.steps on return, so a
--    records correction's step counts carry through.
-- 2. The sandbox (10d open item 2): a correction whose kind reruns the rehearsal may add one role-rehearsal sandbox org
--    {alias, org_type: sandbox, role: rehearsal} to a request that has none. Nothing else about orgs may change.
-- 3. Kept from 251 (s12c, s12d): each kind changes only its own row; pre_check_request_id never changes; the object or
--    operation is a new request; a code correction supersedes older reviews; the evidence rules, unchanged.
-- 4. The queue (Alex, s14b): switchboard_queue_run_request refuses base_steps and base_phases from the chat, naming the
--    key, as it refuses evidence; only the database's correction sets them. Everything else is 251's, unchanged.

-- ============================================================================
-- 0. switchboard_queue_run_request: as 251, but base_steps and base_phases are refused.
-- ============================================================================
create or replace function public.switchboard_queue_run_request(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_page   text := p_request->>'page';
  v_code   text := p_request->>'project_code';
  v_sim    boolean;
  v_total  jsonb;
  v_id     uuid;
  v_pre_id uuid;
  v_pre    public.switchboard_run_requests;
  v_why    text[] := '{}';
  v_copied jsonb := '[]'::jsonb;
  v_used   uuid;
  v_op_n   jsonb;
  v_op_p   jsonb;
  v_sel_n  jsonb;
  v_sel_p  jsonb;
  v_cnt_n  jsonb;
  v_cnt_p  jsonb;
  v_moved  integer := 0;
  v_key    text;
begin
  if v_user is null then
    raise exception 'switchboard_queue_run_request: no signed-in user.' using errcode = '28000';
  end if;
  if jsonb_typeof(p_request) is distinct from 'object' then
    raise exception 'switchboard_queue_run_request: the request must be a JSON object. No link was issued.' using errcode = '23514';
  end if;
  if v_page is null or v_page not in ('precheck', 'dataop', 'undo', 'correction', 'check') then
    raise exception 'switchboard_queue_run_request: add page: one of precheck, dataop, undo, correction, check.' using errcode = '23514';
  end if;
  if v_page = 'correction' then
    raise exception 'switchboard_queue_run_request: a correction is made with switchboard_correct_run_request on the request it corrects.' using errcode = '23514';
  end if;
  if v_code is null or v_code !~ '^[a-z0-9_-]{1,40}$' then
    raise exception 'switchboard_queue_run_request: add project_code.' using errcode = '23514';
  end if;
  if coalesce(btrim(p_request->'problem'->>'label'), '') = '' or coalesce(btrim(p_request->'problem'->>'sentence'), '') = '' then
    raise exception 'switchboard_queue_run_request: add the problem: its label (P1, P1a) and the problem in diagnosis''s words, then queue again. No link was issued.' using errcode = '23514';
  end if;
  if coalesce(btrim(p_request->>'side_effects'), '') = '' then
    raise exception 'switchboard_queue_run_request: add side_effects: the side effects in diagnosis''s words, then queue again. No link was issued.' using errcode = '23514';
  end if;
  if coalesce(btrim(p_request->>'headline'), '') = '' then
    raise exception 'switchboard_queue_run_request: add the headline.' using errcode = '23514';
  end if;
  if jsonb_typeof(p_request->'steps') is distinct from 'array' or jsonb_array_length(p_request->'steps') = 0 then
    raise exception 'switchboard_queue_run_request: add steps: the step codes this run will take.' using errcode = '23514';
  end if;
  if p_request ? 'sample' then
    raise exception 'switchboard_queue_run_request: leave the sample out: the pre-check stores it (switchboard_store_run_sample), never the request.' using errcode = '23514';
  end if;
  -- The chat never supplies evidence: only a pre-check's result does (switchboard_record_run_evidence), or a copy of a
  -- pre-check request's checks made here, from the database.
  if p_request ? 'evidence' then
    raise exception 'switchboard_queue_run_request: leave evidence out: only the pre-check''s result records passed checks; name the pre-check with pre_check_request_id.' using errcode = '23514';
  end if;
  -- 252: nor the steps and phases a correction keeps: only switchboard_correct_run_request sets them, from the row.
  foreach v_key in array array['base_steps', 'base_phases'] loop
    if p_request ? v_key then
      raise exception 'switchboard_queue_run_request: leave % out: only a correction keeps the request''s own steps and phases, from the database. No link was issued.', v_key
        using errcode = '23514';
    end if;
  end loop;
  if p_request ? 'simulation' and jsonb_typeof(p_request->'simulation') is distinct from 'boolean' then
    raise exception 'switchboard_queue_run_request: simulation must be true or false.' using errcode = '23514';
  end if;
  v_sim := coalesce((p_request->>'simulation')::boolean, false);
  v_total := case when v_page = 'undo' then coalesce(p_request->'counts'->'undo_up_to', p_request->'counts'->'expected')
                  else coalesce(p_request->'counts'->'total', p_request->'counts'->'expected') end;
  if v_page in ('dataop', 'undo') and (jsonb_typeof(v_total) is distinct from 'number' or v_total::text !~ '^[0-9]{1,9}$') then
    raise exception 'switchboard_queue_run_request: add counts.total (or expected; undo_up_to on an undo): the count the run writes.' using errcode = '23514';
  end if;

  -- s12b: a data operation names the pre-check whose checks passed; its checks in use are copied with their times.
  if p_request ? 'pre_check_request_id' then
    if v_page <> 'dataop' then
      raise exception 'switchboard_queue_run_request: only a data operation names its pre-check (pre_check_request_id). No link was issued.' using errcode = '23514';
    end if;
    if jsonb_typeof(p_request->'pre_check_request_id') is distinct from 'string'
       or p_request->>'pre_check_request_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'switchboard_queue_run_request: pre_check_request_id must be the pre-check request''s id (a lower-case uuid). No link was issued.' using errcode = '23514';
    end if;
    v_pre_id := (p_request->>'pre_check_request_id')::uuid;
    -- Same user: another user's request is not found. Locked, so it isn't corrected while its checks are copied.
    select * into v_pre from public.switchboard_run_requests where id = v_pre_id and user_id = v_user for update;
    if not found then
      raise exception 'switchboard_queue_run_request: no such pre-check request (%). No link was issued.', v_pre_id using errcode = 'P0002';
    end if;
    if v_pre.base_page <> 'precheck' or v_pre.page <> 'precheck' then
      raise exception 'switchboard_queue_run_request: request % is not a Pre-check and Rehearsal request on its pre-check page (it is %); name the pre-check whose checks passed. No link was issued.', v_pre_id, v_pre.page
        using errcode = '23514';
    end if;
    if v_pre.project_code <> v_code then
      raise exception 'switchboard_queue_run_request: the pre-check is for project %, not %; checks are copied only within one project. No link was issued.', v_pre.project_code, v_code
        using errcode = '23514';
    end if;
    if v_pre.simulation <> v_sim then
      raise exception 'switchboard_queue_run_request: a simulation and a real request never share checks. No link was issued.' using errcode = '23514';
    end if;
    -- What the pre-check checked must be what the write does (the correction table: an edit that reruns a check
    -- changes something the pre-check checked; wording, side effects and what diagnosis allows may differ). Each side
    -- is normalised first: a key set to null is a key left out, and a part that isn't an object (array) is empty.
    v_op_n  := case when jsonb_typeof(p_request->'operation') = 'object' then jsonb_strip_nulls(p_request->'operation') else '{}'::jsonb end;
    v_op_p  := case when jsonb_typeof(v_pre.request->'operation') = 'object' then jsonb_strip_nulls(v_pre.request->'operation') else '{}'::jsonb end;
    v_sel_n := case when jsonb_typeof(p_request->'selected_by') = 'object' then jsonb_strip_nulls(p_request->'selected_by') else '{}'::jsonb end;
    v_sel_p := case when jsonb_typeof(v_pre.request->'selected_by') = 'object' then jsonb_strip_nulls(v_pre.request->'selected_by') else '{}'::jsonb end;
    v_cnt_n := case when jsonb_typeof(p_request->'counts') = 'object' then jsonb_strip_nulls(p_request->'counts') else '{}'::jsonb end;
    v_cnt_p := case when jsonb_typeof(v_pre.request->'counts') = 'object' then jsonb_strip_nulls(v_pre.request->'counts') else '{}'::jsonb end;
    if v_op_n->'object' is distinct from v_op_p->'object' then
      v_why := v_why || 'the object'::text;
    end if;
    if v_op_n->'kind' is distinct from v_op_p->'kind' then
      v_why := v_why || 'the operation'::text;
    end if;
    if (v_sel_n - array['sandbox_text', 'not_rehearsed']) is distinct from (v_sel_p - array['sandbox_text', 'not_rehearsed']) then
      v_why := v_why || 'the records or filter'::text;
    end if;
    -- The count the write approves is the count the pre-check counted (its total, else its expected), and every other
    -- count it showed (update, create, children, links) is the same.
    if coalesce(v_cnt_p->'total', v_cnt_p->'expected') is null
       or v_total is distinct from coalesce(v_cnt_p->'total', v_cnt_p->'expected')
       or (v_cnt_p ? 'expected' and v_cnt_n->'expected' is distinct from v_cnt_p->'expected')
       or (v_cnt_n - array['total', 'expected', 'skipped', 'undo_up_to']) is distinct from (v_cnt_p - array['total', 'expected', 'skipped', 'undo_up_to']) then
      v_why := v_why || 'the count'::text;
    end if;
    if v_op_n->'field' is distinct from v_op_p->'field' then
      v_why := v_why || 'the field'::text;
    end if;
    if v_op_n->'value' is distinct from v_op_p->'value' then
      v_why := v_why || 'the value'::text;
    end if;
    if v_op_n->'file' is distinct from v_op_p->'file' then
      v_why := v_why || 'the file'::text;
    end if;
    if (v_op_n - array['kind', 'object', 'field', 'value', 'file']) is distinct from (v_op_p - array['kind', 'object', 'field', 'value', 'file']) then
      v_why := v_why || 'the operation''s other details (external id, steps)'::text;
    end if;
    if v_sel_n->'sandbox_text' is distinct from v_sel_p->'sandbox_text' then
      v_why := v_why || 'the sandbox filter'::text;
    end if;
    if (case when jsonb_typeof(p_request->'code') = 'object' then p_request->'code'->'commit' end)
       is distinct from (case when jsonb_typeof(v_pre.request->'code') = 'object' then v_pre.request->'code'->'commit' end) then
      v_why := v_why || 'the code'::text;
    end if;
    if (select coalesce(jsonb_agg(o->'alias' order by o->>'alias'), '[]'::jsonb)
          from jsonb_array_elements(case when jsonb_typeof(p_request->'orgs') = 'array' then p_request->'orgs' else '[]'::jsonb end) o
         where jsonb_typeof(o) = 'object' and o->>'role' = 'target')
       is distinct from
       (select coalesce(jsonb_agg(o->'alias' order by o->>'alias'), '[]'::jsonb)
          from jsonb_array_elements(case when jsonb_typeof(v_pre.request->'orgs') = 'array' then v_pre.request->'orgs' else '[]'::jsonb end) o
         where jsonb_typeof(o) = 'object' and o->>'role' = 'target') then
      v_why := v_why || 'the target org'::text;
    end if;
    if cardinality(v_why) > 0 then
      raise exception 'switchboard_queue_run_request: the data operation differs from what its pre-check checked: %. Queue it as the pre-check checked it, or run a new pre-check. No link was issued.', array_to_string(v_why, ', ')
        using errcode = '23514';
    end if;
    -- One pre-check backs one approved write (switchboard_consume_run_link checks it again at the click).
    select r.id into v_used from public.switchboard_run_requests r
     where r.user_id = v_user and r.evidence @> jsonb_build_array(jsonb_build_object('copied_from', v_pre_id::text))
       and exists (select 1 from public.switchboard_run_links l where l.request_id = r.id and l.review_id is null and l.used_at is not null)
     limit 1;
    if v_used is not null then
      raise exception 'switchboard_queue_run_request: this pre-check''s checks already backed an approved data operation (request %); run a new pre-check. No link was issued.', v_used
        using errcode = '23514';
    end if;
    -- The checks in use, each with the time it first passed: nothing resets on the copy.
    select coalesce(jsonb_agg(e || jsonb_build_object('copied_from', v_pre_id::text)), '[]'::jsonb) into v_copied
      from jsonb_array_elements(v_pre.evidence) e
     where e ? 'passed_at' and coalesce((e->>'voided')::boolean, false) = false;
    if jsonb_array_length(v_copied) = 0 then
      raise exception 'switchboard_queue_run_request: the pre-check has no passed checks yet; queue the data operation once its result is in. No link was issued.' using errcode = '23514';
    end if;
  end if;

  insert into public.switchboard_run_requests (user_id, project_code, page, base_page, simulation, request, evidence, total_count)
  values (v_user, v_code, v_page, v_page, v_sim,
          p_request - array['id', 'version', 'corrected_at', 'evidence', 'simulation'],
          v_copied,
          case when jsonb_typeof(v_total) = 'number' and v_total::text ~ '^[0-9]{1,9}$' then v_total::text::integer end)
  returning id into v_id;
  -- s12c: the sample moves with the checks (same expires_at), so the write's page shows it and the runner drops it
  -- from the write's own request at its final status. No sample on the pre-check: nothing moves.
  if v_pre_id is not null then
    update public.switchboard_run_samples set request_id = v_id where request_id = v_pre_id;
    get diagnostics v_moved = row_count;
  end if;
  return jsonb_build_object('request_id', v_id, 'version', 1, 'copied_checks', jsonb_array_length(v_copied),
                            'moved_sample', v_moved = 1);
end;
$$;
comment on function public.switchboard_queue_run_request(jsonb) is
  'Switchboard 3: queue a run request (spec 4.1) for the signed-in caller. Refuses, before any link, a request without page, project_code, the problem label and sentence, side_effects, headline or steps; one with a sample, evidence, base_steps or base_phases (252: only a correction keeps those); a correction (use switchboard_correct_run_request); and a data operation or undo without its count. A simulation (Q7) is accepted and flagged. A data operation may name its pre-check (pre_check_request_id, s12b): the caller''s own Pre-check and Rehearsal request in the same project, on its pre-check page, with passed checks, whose object, operation, records or filter, count (the write''s count is the pre-check''s total, else expected; other counts equal), field, value, file, other operation details, sandbox filter, code commit and target org all match; its checks in use are copied with their original passed_at and copied_from, so the 24 hours count from the oldest; the pre-check''s sample row moves to the new request, expires_at unchanged (s12c). Refused, naming every mismatch, otherwise, and when that pre-check already backed an approved write. Returns {request_id, version, copied_checks, moved_sample}. Called by the queue_switchboard_run_request tool (B3).';
revoke all on function public.switchboard_queue_run_request(jsonb) from public, anon;
grant execute on function public.switchboard_queue_run_request(jsonb) to authenticated;

-- ============================================================================
-- 1. switchboard_correct_run_request: as 251, plus base_steps and base_phases, and the rehearsal sandbox.
-- ============================================================================
create or replace function public.switchboard_correct_run_request(p_request_id uuid, p_edit_kind text, p_request jsonb, p_changed jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_row     public.switchboard_run_requests;
  v_reruns  text[];
  v_voided  integer := 0;
  v_links   integer := 0;
  v_total   jsonb;
  v_n       jsonb;
  v_o       jsonb;
  v_diff    text[];
  v_base    jsonb;
  -- Words only: what every kind may change (250's wording rule), what the database sets, and (252) the base steps
  -- and phases the database keeps.
  c_words   constant text[] := array['headline', 'side_effects', 'problem', 'diagnosis_allows', 'changed', 'page', 'id', 'version',
                                     'corrected_at', 'simulation', 'base_steps', 'base_phases'];
  -- What a correction run carries of its own, for a kind that reruns a check: its steps and phases, its run folder and
  -- hashes, what it keeps, its run tag, and the still-valid list.
  c_run     constant text[] := array['steps', 'phases', 'details', 'kept', 'run_tag', 'still_valid'];
  -- Keys the chat never sends: the database's own.
  c_set     constant text[] := array['id', 'version', 'corrected_at', 'evidence', 'simulation', 'base_steps', 'base_phases'];
begin
  if v_user is null then
    raise exception 'switchboard_correct_run_request: no signed-in user.' using errcode = '28000';
  end if;
  select * into v_row from public.switchboard_run_requests where id = p_request_id and user_id = v_user for update;
  if not found then
    raise exception 'switchboard_correct_run_request: no such request.' using errcode = 'P0002';
  end if;
  -- The checks each edit runs again (runContract.js EDIT_RERUNS; Alex s7, s8b: a field reruns the backup and sample).
  v_reruns := case p_edit_kind
    when 'wording'        then array[]::text[]
    when 'allows'         then array[]::text[]
    when 'value'          then array['rehearsal']
    when 'file'           then array['rehearsal']
    when 'field'          then array['rehearsal', 'login', 'backup', 'sample']
    when 'records'        then array['count', 'backup', 'sample']
    when 'records_filter' then array['count', 'backup', 'sample', 'rehearsal']
    when 'sandbox_filter' then array['rehearsal']
    when 'code'           then array['rehearsal', 'code_review']
  end;
  if p_edit_kind in ('object', 'operation') then
    raise exception 'switchboard_correct_run_request: a change to the % needs a new request through diagnosis, not a correction. No link was issued.', p_edit_kind
      using errcode = '23514';
  end if;
  if v_reruns is null then
    raise exception 'switchboard_correct_run_request: unknown edit kind %.', coalesce(p_edit_kind, 'null') using errcode = '23514';
  end if;
  if jsonb_typeof(p_request) is distinct from 'object' or jsonb_typeof(p_changed) is distinct from 'object'
     or coalesce(btrim(p_changed->>'reason'), '') = ''
     or jsonb_typeof(p_changed->'items') is distinct from 'array' or jsonb_array_length(p_changed->'items') = 0 then
    raise exception 'switchboard_correct_run_request: the corrected request and changed {reason, items} are required.' using errcode = '23514';
  end if;
  if p_request ? 'sample' or p_request ? 'evidence' or coalesce(p_request->>'project_code', v_row.project_code) <> v_row.project_code then
    raise exception 'switchboard_correct_run_request: a correction keeps its project code and carries no sample or evidence.' using errcode = '23514';
  end if;
  -- s12c: the pre-check a data operation's checks were copied from never changes (null and left out are the same).
  if (jsonb_strip_nulls(p_request)->'pre_check_request_id') is distinct from (jsonb_strip_nulls(v_row.request)->'pre_check_request_id') then
    raise exception 'switchboard_correct_run_request: a correction never changes pre_check_request_id; a data operation on another pre-check is a new request. No link was issued.'
      using errcode = '23514';
  end if;
  -- Whatever kind is named, the object and the operation never change here: that is a new request through diagnosis.
  if (p_request->'operation'->>'kind') is distinct from (v_row.request->'operation'->>'kind')
     or (p_request->'operation'->>'object') is distinct from (v_row.request->'operation'->>'object') then
    raise exception 'switchboard_correct_run_request: the object or operation changed; that needs a new request through diagnosis, not a correction. No link was issued.'
      using errcode = '23514';
  end if;

  -- s12c: each kind changes only its own row of the table; everything else must be as it was. Both sides normalised
  -- (a key set to null is a key left out), then the kind's own fields are taken out of both.
  v_n := jsonb_strip_nulls(p_request) - c_words;
  v_o := jsonb_strip_nulls(v_row.request) - c_words;
  if cardinality(v_reruns) > 0 then
    v_n := v_n - c_run;
    v_o := v_o - c_run;
  end if;
  -- 252: a kind that reruns the rehearsal may add the rehearsal sandbox to a request that has none: exactly one org
  -- {alias, org_type sandbox, role rehearsal}, nothing else. Taken out of the new side, every other org must be as it was.
  if 'rehearsal' = any(v_reruns)
     and jsonb_typeof(v_n->'orgs') = 'array' and jsonb_typeof(v_o->'orgs') = 'array'
     and not exists (select 1 from jsonb_array_elements(v_o->'orgs') o where o->>'role' = 'rehearsal')
     and (select count(*) from jsonb_array_elements(v_n->'orgs') o where o->>'role' = 'rehearsal') = 1
     and exists (select 1 from jsonb_array_elements(v_n->'orgs') o
                  where jsonb_typeof(o) = 'object' and o->>'role' = 'rehearsal' and o->>'org_type' = 'sandbox'
                    and coalesce(btrim(o->>'alias'), '') <> '' and (o - array['alias', 'org_type', 'role']) = '{}'::jsonb
                    -- Never one of the request's own orgs under another role (the target's alias, say).
                    and not exists (select 1 from jsonb_array_elements(v_o->'orgs') p where p->>'alias' = o->>'alias')) then
    v_n := jsonb_set(v_n, '{orgs}',
             (select coalesce(jsonb_agg(t.o order by t.ord), '[]'::jsonb)
                from jsonb_array_elements(v_n->'orgs') with ordinality t(o, ord)
               where t.o->>'role' is distinct from 'rehearsal'));
  end if;
  if p_edit_kind = 'value' then
    v_n := v_n #- '{operation,value}'; v_o := v_o #- '{operation,value}';
  elsif p_edit_kind = 'file' then
    v_n := v_n #- '{operation,file}'; v_o := v_o #- '{operation,file}';
  elsif p_edit_kind = 'field' then
    -- The field, and the undo's words that name it.
    v_n := (v_n #- '{operation,field}') - 'undo'; v_o := (v_o #- '{operation,field}') - 'undo';
  elsif p_edit_kind = 'records' then
    -- The records (selected_by's text, not its kind or its sandbox filter), their counts, a multi-object run's step
    -- counts, and the undo's words that count them. Ids to a filter is records_filter (it reruns the rehearsal).
    v_n := (v_n - array['counts', 'undo']) #- '{operation,steps}' || jsonb_build_object('selected_by',
             (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
                from jsonb_each(case when jsonb_typeof(v_n->'selected_by') = 'object' then v_n->'selected_by' else '{}'::jsonb end)
               where key in ('kind', 'sandbox_text', 'not_rehearsed')));
    v_o := (v_o - array['counts', 'undo']) #- '{operation,steps}' || jsonb_build_object('selected_by',
             (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
                from jsonb_each(case when jsonb_typeof(v_o->'selected_by') = 'object' then v_o->'selected_by' else '{}'::jsonb end)
               where key in ('kind', 'sandbox_text', 'not_rehearsed')));
  elsif p_edit_kind = 'records_filter' then
    -- The records by filter (all of selected_by, its sandbox filter too: the rehearsal reruns), their counts, step
    -- counts and the undo's words.
    v_n := (v_n - array['counts', 'undo', 'selected_by']) #- '{operation,steps}';
    v_o := (v_o - array['counts', 'undo', 'selected_by']) #- '{operation,steps}';
  elsif p_edit_kind = 'sandbox_filter' then
    v_n := v_n #- '{selected_by,sandbox_text}' #- '{selected_by,not_rehearsed}';
    v_o := v_o #- '{selected_by,sandbox_text}' #- '{selected_by,not_rehearsed}';
  elsif p_edit_kind = 'code' then
    v_n := v_n - 'code'; v_o := v_o - 'code';
  end if;
  -- 252: a records or records_filter correction may change a multi-object run's step counts, never its steps' objects,
  -- kinds or number: each operation.steps entry is compared without its count (251 left operation.steps out whole).
  if p_edit_kind in ('records', 'records_filter') then
    if jsonb_typeof(p_request->'operation'->'steps') = 'array' then
      v_n := jsonb_set(v_n, '{operation,steps}',
               (select coalesce(jsonb_agg(case when jsonb_typeof(t.s) = 'object' then t.s - 'count' else t.s end order by t.ord), '[]'::jsonb)
                  from jsonb_array_elements(jsonb_strip_nulls(p_request)->'operation'->'steps') with ordinality t(s, ord)));
    end if;
    if jsonb_typeof(v_row.request->'operation'->'steps') = 'array' then
      v_o := jsonb_set(v_o, '{operation,steps}',
               (select coalesce(jsonb_agg(case when jsonb_typeof(t.s) = 'object' then t.s - 'count' else t.s end order by t.ord), '[]'::jsonb)
                  from jsonb_array_elements(jsonb_strip_nulls(v_row.request)->'operation'->'steps') with ordinality t(s, ord)));
    end if;
  end if;
  -- Name each field that differs, one level into an object (operation.value, selected_by.text, counts.total).
  select coalesce(array_agg(distinct d.name order by d.name), '{}') into v_diff
    from (select case when jsonb_typeof(v_n->ks.k) = 'object' and jsonb_typeof(v_o->ks.k) = 'object' and ss.s is not null
                      then ks.k || '.' || ss.s else ks.k end as name
            from (select jsonb_object_keys(v_n) as k union select jsonb_object_keys(v_o)) ks
            left join lateral (
              select x.s from (select jsonb_object_keys(case when jsonb_typeof(v_n->ks.k) = 'object' then v_n->ks.k else '{}'::jsonb end) as s
                               union select jsonb_object_keys(case when jsonb_typeof(v_o->ks.k) = 'object' then v_o->ks.k else '{}'::jsonb end)) x
               where (v_n->ks.k->x.s) is distinct from (v_o->ks.k->x.s)) ss on true
           where (v_n->ks.k) is distinct from (v_o->ks.k)) d;
  if cardinality(v_diff) > 0 and cardinality(v_reruns) = 0 then
    raise exception 'switchboard_correct_run_request: a % edit changes only the headline, side effects, problem wording or what diagnosis allows (it changed %); name the edit kind that reruns what changed.', p_edit_kind, array_to_string(v_diff, ', ')
      using errcode = '23514';
  end if;
  if cardinality(v_diff) > 0 then
    raise exception 'switchboard_correct_run_request: a % correction changes only %; it also changed %. Name the edit kind for what changed, or queue a new request through diagnosis. No link was issued.',
      p_edit_kind,
      case p_edit_kind when 'value' then 'the value' when 'file' then 'the file' when 'field' then 'the field'
                       when 'records' then 'the records and their counts' when 'records_filter' then 'the records (a filter) and their counts'
                       when 'sandbox_filter' then 'the sandbox filter' when 'code' then 'the code' end,
      array_to_string(v_diff, ', ')
      using errcode = '23514';
  end if;
  if cardinality(v_reruns) = 0 and (p_request->'problem'->>'label') is distinct from (v_row.request->'problem'->>'label') then
    raise exception 'switchboard_correct_run_request: the problem label never changes in a wording edit.' using errcode = '23514';
  end if;
  v_total := case when v_row.page = 'undo' then coalesce(p_request->'counts'->'undo_up_to', p_request->'counts'->'expected')
                  else coalesce(p_request->'counts'->'total', p_request->'counts'->'expected') end;

  -- 252: the request's own steps and phases, kept by the database (never the chat's), so the base page gets them back.
  -- On its correction page already: the first correction's are kept. Otherwise: the request's own, as they are now.
  -- Each key only when present, so nothing inside a step or phase is stripped.
  v_base := case when v_row.page = 'correction'
                 then case when v_row.request ? 'base_steps' then jsonb_build_object('base_steps', v_row.request->'base_steps') else '{}'::jsonb end
                   || case when v_row.request ? 'base_phases' then jsonb_build_object('base_phases', v_row.request->'base_phases') else '{}'::jsonb end
                 else case when v_row.request ? 'steps' then jsonb_build_object('base_steps', v_row.request->'steps') else '{}'::jsonb end
                   || case when v_row.request ? 'phases' then jsonb_build_object('base_phases', v_row.request->'phases') else '{}'::jsonb end end;

  if cardinality(v_reruns) = 0 then
    -- Wording or what diagnosis allows: nothing runs again, nothing is voided, no page of its own; the next page carries
    -- the block. The version stays, so a live link stays live; its page must reload, as the fingerprint changed.
    -- 252: the page key stays the row's (a request on its correction page stays one), and kept base steps stay. On a
    -- correction page the correction's own changed block stays (the page shows what it reruns), the wording edit
    -- under changed.wording.
    update public.switchboard_run_requests
       set request = (p_request - c_set)
                     || jsonb_build_object('page', v_row.page,
                                           'changed', case when v_row.page = 'correction' and jsonb_typeof(v_row.request->'changed') = 'object'
                                                           then (v_row.request->'changed') || jsonb_build_object('wording',
                                                                  p_changed || jsonb_build_object('edit_kind', p_edit_kind, 'from_version', v_row.version))
                                                           else p_changed || jsonb_build_object('edit_kind', p_edit_kind, 'from_version', v_row.version) end)
                     || case when v_row.page = 'correction' then v_base else '{}'::jsonb end,
           updated_at = now()
     where id = v_row.id;
    return jsonb_build_object('request_id', v_row.id, 'version', v_row.version, 'voided_checks', 0, 'voided_links', 0);
  end if;

  update public.switchboard_run_requests
     set version      = v_row.version + 1,
         corrected_at = now(),
         page         = 'correction',
         request      = (p_request - c_set)
                        || jsonb_build_object('page', 'correction',
                                              'changed', p_changed || jsonb_build_object('edit_kind', p_edit_kind, 'from_version', v_row.version))
                        || v_base,
         evidence     = (select coalesce(jsonb_agg(case when e->>'check' = any(v_reruns) then e || '{"voided": true}'::jsonb else e end), '[]'::jsonb)
                           from jsonb_array_elements(v_row.evidence) e),
         total_count  = case when jsonb_typeof(v_total) = 'number' and v_total::text ~ '^[0-9]{1,9}$' then v_total::text::integer else v_row.total_count end,
         updated_at   = now()
   where id = v_row.id;
  select count(*) into v_voided from jsonb_array_elements(v_row.evidence) e
   where e->>'check' = any(v_reruns) and coalesce((e->>'voided')::boolean, false) = false;

  -- In the same transaction: the request's live links die (part 5).
  update public.switchboard_run_links
     set voided_at = now(), void_reason = 'corrected'
   where request_id = v_row.id and used_at is null and voided_at is null;
  get diagnostics v_links = row_count;
  -- A newer commit supersedes the review (part 5 "Code changed").
  if p_edit_kind = 'code' and coalesce(p_request->'code'->>'commit', '') ~ '^[0-9a-f]{7,40}$' then
    update public.switchboard_code_reviews
       set status = 'superseded', superseded_by = p_request->'code'->>'commit', updated_at = now()
     where request_id = v_row.id and status <> 'superseded' and commit <> p_request->'code'->>'commit';
  end if;
  return jsonb_build_object('request_id', v_row.id, 'version', v_row.version + 1, 'voided_checks', v_voided, 'voided_links', v_links);
end;
$$;
comment on function public.switchboard_correct_run_request(uuid, text, jsonb, jsonb) is
  'Switchboard 3: correct a run request (part 5 "Corrected"). Refuses an object or operation edit (a new request through diagnosis), and (s12c) any change to pre_check_request_id. Each kind changes only its own row of the correction table, besides the wording (headline, side effects, problem, what diagnosis allows) and, for a kind that reruns a check, the run''s own steps, phases, details, kept, run_tag and still_valid: value operation.value; file operation.file; field operation.field and undo; records selected_by (not its kind or sandbox filter), counts, operation.steps and undo; records_filter all of selected_by, counts, operation.steps and undo; sandbox_filter selected_by.sandbox_text and not_rehearsed; code the code. A kind that reruns the rehearsal may also add one role-rehearsal sandbox org to a request with none (252). Any other change is refused, naming the field (a key set to null counts as left out). A wording or allowance edit voids nothing and keeps the version and the page. Any other edit raises the version by one, makes it a correction page, keeps the request''s own steps and phases as base_steps and base_phases (252; restored by switchboard_record_run_evidence on return), voids the evidence its kind reruns (field: rehearsal, login, backup, sample; Alex s8b) and the request''s live links, and for a code edit marks older reviews superseded, in one transaction. Returns {request_id, version, voided_checks, voided_links}.';
revoke all on function public.switchboard_correct_run_request(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function public.switchboard_correct_run_request(uuid, text, jsonb, jsonb) to authenticated;

-- ============================================================================
-- 2. switchboard_record_run_evidence: as 251, but a return to the base page restores the request's own steps and phases.
-- ============================================================================
create or replace function public.switchboard_record_run_evidence(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_names  constant text[] := array['count', 'login', 'automation', 'backup', 'sample', 'rehearsal'];
  c_write  constant text[] := array['count', 'login', 'automation', 'backup', 'rehearsal'];
  v_run    public.switchboard_runs;
  v_action public.switchboard_actions;
  v_linkid uuid;
  v_link   public.switchboard_run_links;
  v_row    public.switchboard_run_requests;
  v_fresh  jsonb;
  v_names  text[];
  v_evid   jsonb;
  v_back   boolean;
  v_page   text;
  v_req    jsonb;
  v_steps  jsonb;
begin
  select * into v_run from public.switchboard_runs where id = p_run_id;
  if not found then
    raise exception 'switchboard_record_run_evidence: no such run.' using errcode = 'P0002';
  end if;
  select * into v_action from public.switchboard_actions where id = v_run.action_id and user_id = v_run.user_id;
  if v_action.id is null or v_action.kind <> 'sf_run' then
    raise exception 'switchboard_record_run_evidence: that run is not a run page''s (sf_run) run.' using errcode = '23514';
  end if;
  if v_run.mode <> 'real' or v_run.finished_at is null then
    raise exception 'switchboard_record_run_evidence: the run has not finished.' using errcode = '55000';
  end if;
  if coalesce(v_run.result->'ok', 'false'::jsonb) <> 'true'::jsonb or coalesce(v_run.result->'pass', 'false'::jsonb) <> 'true'::jsonb then
    raise exception 'switchboard_record_run_evidence: the run did not pass; no evidence is recorded.' using errcode = '55000';
  end if;
  if jsonb_typeof(v_run.result->'checks') is distinct from 'array' or jsonb_array_length(v_run.result->'checks') = 0 then
    raise exception 'switchboard_record_run_evidence: the run''s result names no checks.' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_array_elements(v_run.result->'checks') c
              where jsonb_typeof(c) is distinct from 'object'
                 or not coalesce(c->>'check' = any(c_names), false)
                 or coalesce(c->>'org', '') not in ('production', 'sandbox')
                 or (c ? 'commit' and coalesce(c->>'commit', '') !~ '^[0-9a-f]{7,40}$')
                 or (c - array['check', 'org', 'commit']) <> '{}'::jsonb) then
    raise exception 'switchboard_record_run_evidence: the run''s result has a check that isn''t {check, org, commit?}.' using errcode = '23514';
  end if;

  -- The link and its request, locked request first, as the link functions do.
  v_linkid := (v_action.payload->>'link_id')::uuid;
  select * into v_link from public.switchboard_run_links where id = v_linkid and user_id = v_run.user_id;
  if v_link.id is null then
    raise exception 'switchboard_record_run_evidence: no link for that run.' using errcode = 'P0002';
  end if;
  select * into v_row from public.switchboard_run_requests where id = v_link.request_id for update;
  select * into v_link from public.switchboard_run_links where id = v_linkid for update;
  if v_row.simulation then
    raise exception 'switchboard_record_run_evidence: a simulation records no evidence.' using errcode = '55000';
  end if;
  if v_link.voided_at is not null or v_link.request_version <> v_row.version then
    raise exception 'switchboard_record_run_evidence: the link is voided or for an older version of the request; no evidence is recorded.' using errcode = '55000';
  end if;
  -- The run must be the link's pre-check: its approval on a pre-check page (or a pre-check's correction), or its rerun
  -- (a write's correction Approve is one, s12). A data operation's own run is never evidence.
  if not (v_action.id = v_link.rerun_action_id
          or (v_action.id = v_link.action_id
              and (v_row.page = 'precheck' or (v_row.page = 'correction' and v_row.base_page = 'precheck')))) then
    raise exception 'switchboard_record_run_evidence: that run is not this link''s pre-check or rerun.' using errcode = '55000';
  end if;
  if v_row.corrected_at is not null and v_run.finished_at < v_row.corrected_at then
    raise exception 'switchboard_record_run_evidence: the run finished before the request was corrected; no evidence is recorded.' using errcode = '55000';
  end if;
  if exists (select 1 from jsonb_array_elements(v_row.evidence) e where e->>'run_id' = v_run.id::text) then
    return jsonb_build_object('recorded', 0, 'already', true, 'request_id', v_row.id, 'page', v_row.page);
  end if;
  -- Each check once per result, and never older than the evidence it would replace.
  if (select count(distinct c->>'check') from jsonb_array_elements(v_run.result->'checks') c) <> jsonb_array_length(v_run.result->'checks') then
    raise exception 'switchboard_record_run_evidence: the run''s result names a check twice.' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_array_elements(v_row.evidence) e, jsonb_array_elements(v_run.result->'checks') c
              where e->>'check' = c->>'check' and coalesce((e->>'voided')::boolean, false) = false
                and (e->>'passed_at')::timestamptz > v_run.finished_at) then
    raise exception 'switchboard_record_run_evidence: newer evidence for these checks is already in use; an older run never replaces it.' using errcode = '55000';
  end if;

  select jsonb_agg(jsonb_build_object('check', c->>'check', 'org', c->>'org', 'passed_at', v_run.finished_at, 'run_id', v_run.id)
                   || case when c ? 'commit' then jsonb_build_object('commit', c->>'commit') else '{}'::jsonb end),
         array_agg(c->>'check')
    into v_fresh, v_names
    from jsonb_array_elements(v_run.result->'checks') c;
  -- Older entries for the same checks stay, voided; the new ones are in use.
  select coalesce(jsonb_agg(case when e->>'check' = any(v_names) and coalesce((e->>'voided')::boolean, false) = false
                                 then e || '{"voided": true}'::jsonb else e end), '[]'::jsonb) || v_fresh
    into v_evid
    from jsonb_array_elements(v_row.evidence) e;
  -- A correction returns to its base page once every check it voided is in use again, and, for a data operation,
  -- every check a write needs. Its page key follows, so its fingerprint changes and an open page previews again.
  v_back := v_row.page = 'correction'
    and not exists (select 1 from jsonb_array_elements(v_evid) e
                     where coalesce((e->>'voided')::boolean, false)
                       and not exists (select 1 from jsonb_array_elements(v_evid) f
                                        where f->>'check' = e->>'check' and coalesce((f->>'voided')::boolean, false) = false))
    and (v_row.base_page <> 'dataop'
         or not exists (select 1 from unnest(c_write) w
                         where not exists (select 1 from jsonb_array_elements(v_evid) f
                                            where f->>'check' = w and coalesce((f->>'voided')::boolean, false) = false)));
  v_page := case when v_back then v_row.base_page else v_row.page end;
  v_req := v_row.request;
  if v_back then
    v_req := v_req || jsonb_build_object('page', v_page);
    -- 252: the request's own steps and phases come back, kept by switchboard_correct_run_request. A multi-object
    -- run's write_step entries take their object, kind and count from operation.steps, in order, so a records
    -- correction's step counts carry through. A request corrected before 252 has no base_steps: it keeps its steps.
    if jsonb_typeof(v_req->'base_steps') = 'array' then
      select coalesce(jsonb_agg(case when x.s->>'code' = 'write_step'
                                          and jsonb_typeof(v_req->'operation'->'steps'->(x.wn::int - 1)) = 'object'
                                     then x.s || jsonb_strip_nulls(jsonb_build_object(
                                                   'object', v_req->'operation'->'steps'->(x.wn::int - 1)->'object',
                                                   'kind',   v_req->'operation'->'steps'->(x.wn::int - 1)->'kind',
                                                   'count',  v_req->'operation'->'steps'->(x.wn::int - 1)->'count'))
                                     else x.s end order by x.ord), '[]'::jsonb)
        into v_steps
        from (select t.s, t.ord,
                     count(*) filter (where t.s->>'code' = 'write_step') over (order by t.ord) as wn
                from jsonb_array_elements(v_req->'base_steps') with ordinality t(s, ord)) x;
      v_req := (v_req - array['steps', 'phases']) || jsonb_build_object('steps', v_steps)
               || case when jsonb_typeof(v_req->'base_phases') = 'array' then jsonb_build_object('phases', v_req->'base_phases') else '{}'::jsonb end;
    end if;
    v_req := v_req - array['base_steps', 'base_phases'];
  end if;
  update public.switchboard_run_requests
     set evidence = v_evid,
         page = v_page,
         request = v_req,
         updated_at = now()
   where id = v_row.id;
  return jsonb_build_object('recorded', jsonb_array_length(v_fresh), 'already', false, 'request_id', v_row.id, 'page', v_page);
end;
$$;
comment on function public.switchboard_record_run_evidence(uuid) is
  'Switchboard 3: record the passed checks of a finished run page pre-check run (the link''s approval on a pre-check page, or its rerun, which a correction page''s Approve is) as its request''s evidence. Reads only that run''s own switchboard_runs row: result {ok: true, pass: true, checks: [{check, org, commit?}]}, passed_at = finished_at; nothing from the caller but the run id. Refused for a run not finished or not passed, a malformed check, a simulation, a voided link or one for an older version, a run finished before the last correction, and a data operation''s own run; recorded once per run. Older entries for the same checks are kept, voided. A correction returns to its base page once every check it voided is in use again (and every write check, for a data operation), and (252) gets its own steps and phases back from base_steps and base_phases, a multi-object run''s write_step entries following operation.steps. Returns {recorded, already, request_id, page}. Service role only: called by switchboard-runner after a helper''s result (Alex''s option A, s12).';
revoke all on function public.switchboard_record_run_evidence(uuid) from public, anon, authenticated;
grant execute on function public.switchboard_record_run_evidence(uuid) to service_role;

-- ============================================================================
-- 3. Result: must say CONFORMANT. Then run supabase/tests/sb3_pages-h6v/4_correction_steps_test.sql with --test.
-- ============================================================================
select public.platform_check_conformance() as conformance;
