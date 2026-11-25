-- 251, sb3_pages-h6v s12 and s12b (follow-up to 250): the correction-approval gap, the evidence write, and a pre-check's
-- checks reaching its data operation. Schema change (functions only). Spec: docs/technical-spec-sb3_pages-h6v.md 10a,
-- 10b, 10c.
-- Functions replaced: switchboard_queue_run_request, switchboard_correct_run_request, switchboard_consume_run_link,
-- switchboard_cancel_run_link (250). Function created: switchboard_record_run_evidence.
-- Tables written by them: switchboard_run_requests, switchboard_run_links, switchboard_run_samples, switchboard_actions,
-- switchboard_runs, switchboard_code_reviews (the code correction's supersede, as 250).
-- No table is altered. No data changes.
--
-- 1. The gap (10b): a correction page's Approve spent its link (used_at), so once its reruns passed and the request
--    returned to its base page, the same link was "already used" and switchboard_issue_run_link refused a new one for
--    that version: the corrected data operation could never be approved. Now a correction page's Approve is recorded
--    like a rerun (rerun_at, rerun_action_id; the s6b pattern): the link stays unused, a second one is refused while
--    the first is approved and unfinished, and once the reruns' evidence is in and the request is back on its base
--    page, the same link approves the write under every 250 rule (fresh checks, count, desktop, Q10, the fingerprint).
-- 2. The evidence write (Alex's option A, s12): the desktop helper talks only to switchboard-runner; the runner, after
--    a helper's result, calls switchboard_record_run_evidence(p_run_id) with the service role. It reads the checks
--    only from that run's own switchboard_runs row: result {ok: true, pass: true, checks: [{check, org, commit?}]},
--    passed_at = the run's finished_at. B2's /evidence logic, moved here unchanged.
-- 3. The pre-check's checks (Alex's option A, s12b): a data operation is queued naming its pre-check request
--    (pre_check_request_id). switchboard_queue_run_request copies that request's checks still in use, server-side, with
--    the time each first passed (the 24 hours count from the oldest), only when the data operation matches what the
--    pre-check checked (object, operation, records or filter, field, value, file, sandbox filter, code, target org;
--    same user, same project). One pre-check backs one approved write. The pre-check's sample moves with them (s12c).
-- 4. Corrections (s12c): each edit kind changes only its own row of the correction table, refusing and naming any
--    other field it changed, and no correction changes pre_check_request_id.

-- ============================================================================
-- 0. switchboard_queue_run_request: as 250, plus pre_check_request_id on a data operation.
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
  'Switchboard 3: queue a run request (spec 4.1) for the signed-in caller. Refuses, before any link, a request without page, project_code, the problem label and sentence, side_effects, headline or steps; one with a sample or evidence; a correction (use switchboard_correct_run_request); and a data operation or undo without its count. A simulation (Q7) is accepted and flagged. A data operation may name its pre-check (pre_check_request_id, s12b): the caller''s own Pre-check and Rehearsal request in the same project, on its pre-check page, with passed checks, whose object, operation, records or filter, count (the write''s count is the pre-check''s total, else expected; other counts equal), field, value, file, other operation details, sandbox filter, code commit and target org all match; its checks in use are copied with their original passed_at and copied_from, so the 24 hours count from the oldest; the pre-check''s sample row moves to the new request, expires_at unchanged (s12c). Refused, naming every mismatch, otherwise, and when that pre-check already backed an approved write. Returns {request_id, version, copied_checks, moved_sample}. Called by the queue_switchboard_run_request tool (B3).';
revoke all on function public.switchboard_queue_run_request(jsonb) from public, anon;
grant execute on function public.switchboard_queue_run_request(jsonb) to authenticated;

-- ============================================================================
-- 0b. switchboard_correct_run_request: as 250, but every edit kind changes only its own row of the correction table
--     (3.2 d), naming any other field it changed, and no correction changes pre_check_request_id (s12c).
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
  -- Words only: what every kind may change (250's wording rule), and what the database sets.
  c_words   constant text[] := array['headline', 'side_effects', 'problem', 'diagnosis_allows', 'changed', 'page', 'id', 'version',
                                     'corrected_at', 'simulation'];
  -- What a correction run carries of its own, for a kind that reruns a check: its steps and phases, its run folder and
  -- hashes, what it keeps, its run tag, and the still-valid list.
  c_run     constant text[] := array['steps', 'phases', 'details', 'kept', 'run_tag', 'still_valid'];
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

  if cardinality(v_reruns) = 0 then
    -- Wording or what diagnosis allows: nothing runs again, nothing is voided, no page of its own; the next page carries
    -- the block. The version stays, so a live link stays live; its page must reload, as the fingerprint changed.
    update public.switchboard_run_requests
       set request = (p_request - array['id', 'version', 'corrected_at', 'evidence', 'simulation'])
                     || jsonb_build_object('changed', p_changed || jsonb_build_object('edit_kind', p_edit_kind, 'from_version', v_row.version)),
           updated_at = now()
     where id = v_row.id;
    return jsonb_build_object('request_id', v_row.id, 'version', v_row.version, 'voided_checks', 0, 'voided_links', 0);
  end if;

  update public.switchboard_run_requests
     set version      = v_row.version + 1,
         corrected_at = now(),
         page         = 'correction',
         request      = (p_request - array['id', 'version', 'corrected_at', 'evidence', 'simulation'])
                        || jsonb_build_object('page', 'correction',
                                              'changed', p_changed || jsonb_build_object('edit_kind', p_edit_kind, 'from_version', v_row.version)),
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
  'Switchboard 3: correct a run request (part 5 "Corrected"). Refuses an object or operation edit (a new request through diagnosis), and (s12c) any change to pre_check_request_id. Each kind changes only its own row of the correction table, besides the wording (headline, side effects, problem, what diagnosis allows) and, for a kind that reruns a check, the run''s own steps, phases, details, kept, run_tag and still_valid: value operation.value; file operation.file; field operation.field and undo; records selected_by (not its kind or sandbox filter), counts, operation.steps and undo; records_filter all of selected_by, counts, operation.steps and undo; sandbox_filter selected_by.sandbox_text and not_rehearsed; code the code. Any other change is refused, naming the field (a key set to null counts as left out). A wording or allowance edit voids nothing and keeps the version. Any other edit raises the version by one, makes it a correction page, voids the evidence its kind reruns (field: rehearsal, login, backup, sample; Alex s8b) and the request''s live links, and for a code edit marks older reviews superseded, in one transaction. Returns {request_id, version, voided_checks, voided_links}.';
revoke all on function public.switchboard_correct_run_request(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function public.switchboard_correct_run_request(uuid, text, jsonb, jsonb) to authenticated;

-- ============================================================================
-- 1. switchboard_consume_run_link: as 250, but a correction page's Approve is recorded like a rerun, and a pre-check's
--    copied checks back one approved write.
-- ============================================================================
create or replace function public.switchboard_consume_run_link(p_token text, p_fingerprint text, p_desktop jsonb,
                                                               p_count integer default null, p_mode text default 'approve')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_link    public.switchboard_run_links;
  v_row     public.switchboard_run_requests;
  v_until   timestamptz;
  v_expired boolean;
  v_newest  public.switchboard_actions;
  v_reason  text;
  v_stuck   boolean := false;
  v_action  uuid;
  v_live    uuid;
  v_req     uuid;
  v_future  boolean;
  v_missing text[];
  v_failed  integer;
  v_as_rerun boolean;
  v_other   uuid;
  -- The checks a data operation's write needs, each passed and not voided (the pre-check and rehearsal, spec 3.2 a).
  c_write_checks constant text[] := array['count', 'login', 'automation', 'backup', 'rehearsal'];
begin
  if v_user is null then
    raise exception 'switchboard_consume_run_link: no signed-in user.' using errcode = '28000';
  end if;
  if p_mode is null or p_mode not in ('approve', 'rerun') then
    raise exception 'switchboard_consume_run_link: p_mode is approve or rerun.' using errcode = '22023';
  end if;
  -- Locks in the same order as switchboard_correct_run_request (the request, then its links), so the two never
  -- deadlock: of two clicks at once, the second waits and then sees the first one's use.
  select request_id into v_req from public.switchboard_run_links
   where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') and user_id = v_user;
  if v_req is null then
    raise exception 'switchboard_consume_run_link: no such link.' using errcode = 'P0002';
  end if;
  select * into v_row from public.switchboard_run_requests where id = v_req for update;
  select * into v_link from public.switchboard_run_links
   where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') and user_id = v_user
   for update;
  if v_link.voided_at is not null then
    raise exception 'switchboard_consume_run_link: this link was voided (%). Nothing was approved.', v_link.void_reason using errcode = '55000';
  end if;
  if v_link.review_id is not null then
    raise exception 'switchboard_consume_run_link: a code review link approves no run.' using errcode = '55000';
  end if;
  if v_row.version <> v_link.request_version then
    raise exception 'switchboard_consume_run_link: the request was corrected since this link was issued. Nothing was approved.' using errcode = '55000';
  end if;
  if p_fingerprint is distinct from public.switchboard_fingerprint(v_row.request || jsonb_build_object('version', v_row.version)) then
    raise exception 'switchboard_consume_run_link: the page you approved is not the current request; reload it. Nothing was approved.' using errcode = '55000';
  end if;

  -- The checks, against now: 24 hours from the oldest evidence still in use. An undo has none (Alex, s6).
  select min((e->>'passed_at')::timestamptz) + interval '24 hours',
         coalesce(bool_or((e->>'passed_at')::timestamptz > now()), false)
    into v_until, v_future
    from jsonb_array_elements(v_row.evidence) e
   where e ? 'passed_at' and coalesce((e->>'voided')::boolean, false) = false;
  v_expired := v_row.page <> 'undo' and v_until is not null and v_until <= now();
  select coalesce(array_agg(c), '{}') into v_missing from unnest(c_write_checks) c
   where not exists (select 1 from jsonb_array_elements(v_row.evidence) e
                      where e->>'check' = c and e ? 'passed_at' and coalesce((e->>'voided')::boolean, false) = false);

  -- The newest action for this link, and whether it never started (4.5): such a link counts as unused for the rerun
  -- (Alex, s6b).
  select * into v_newest from public.switchboard_actions
   where user_id = v_user and kind = 'sf_run' and payload->>'link_id' = v_link.id::text
   order by created_at desc, id desc limit 1;
  if v_newest.id is not null then
    select r.failure_reason into v_reason from public.switchboard_runs r
     where r.action_id = v_newest.id order by r.started_at desc limit 1;
    v_stuck := coalesce(v_reason = 'expired_not_picked_up', false)
               or (v_newest.status = 'consumed' and v_newest.picked_up_at is null
                   and v_newest.created_at < now() - interval '15 minutes');
  end if;

  -- s12: a correction page's Approve runs its reruns, not the write, so for a write (base page dataop or undo) it is
  -- recorded like a rerun: the link stays unused, and approves the write once the reruns pass and the request is back
  -- on its base page. A pre-check's correction has no write to come: its Approve spends the link, as in 250.
  v_as_rerun := p_mode = 'rerun' or (v_row.page = 'correction' and v_row.base_page in ('dataop', 'undo'));

  if v_future then
    raise exception 'switchboard_consume_run_link: a check is dated in the future; the evidence is wrong. Nothing was approved.' using errcode = '55000';
  end if;
  if p_mode = 'approve' then
    if v_link.used_at is not null then
      raise exception 'switchboard_consume_run_link: this link has already been used.' using errcode = '55000';
    end if;
    -- A request version is approved once, whichever of its links is clicked.
    if exists (select 1 from public.switchboard_run_links
                where request_id = v_row.id and request_version = v_row.version and id <> v_link.id
                  and review_id is null and used_at is not null) then
      raise exception 'switchboard_consume_run_link: this request was already approved through another link.' using errcode = '55000';
    end if;
    if v_expired then
      raise exception 'switchboard_consume_run_link: the checks expired at %; run the pre-check and rehearsal again. Nothing was approved.', v_until
        using errcode = '55000';
    end if;
    -- s12: a correction's reruns, approved and unfinished, wait; a second Approve is refused until they finish.
    if v_as_rerun and v_link.rerun_action_id is not null
       and exists (select 1 from public.switchboard_actions
                    where id = v_link.rerun_action_id and status = 'consumed'
                      and (picked_up_at is not null or created_at >= now() - interval '15 minutes')) then
      raise exception 'switchboard_consume_run_link: the corrected checks were already approved at %; they are still running.', v_link.rerun_at
        using errcode = '55000';
    end if;
    -- A write needs every check its pre-check makes, each passed and in use (a correction page approves its reruns,
    -- not the write; its request returns to its base page once they pass).
    if v_row.page = 'dataop' and (v_until is null or cardinality(v_missing) > 0) then
      raise exception 'switchboard_consume_run_link: not every check has passed (missing %); a data operation needs its pre-check. Nothing was approved.',
        array_to_string(v_missing, ', ') using errcode = '55000';
    end if;
    if v_row.page = 'undo' and v_row.request->'operation'->>'kind' = 'delete'
       and coalesce((v_row.request->'undo_of'->>'deadline')::timestamptz <= now(), true) then
      raise exception 'switchboard_consume_run_link: the undo deadline has passed (%). No undo is offered.', coalesce(v_row.request->'undo_of'->>'deadline_reason', 'no deadline')
        using errcode = '55000';
    end if;
    if v_row.page in ('dataop', 'undo') and p_count is distinct from v_row.total_count then
      raise exception 'switchboard_consume_run_link: the count approved (%) is not the request''s count (%). Nothing was approved.', p_count, v_row.total_count
        using errcode = '55000';
    end if;
    -- Code: the data operation runs only the commit that was rehearsed and reviewed (part 5 "Code changed").
    -- The rehearsal is proved by its evidence carrying the commit, never by the chat's code.rehearsed_at.
    if v_row.page = 'dataop' and v_row.request ? 'code' then
      if not exists (select 1 from jsonb_array_elements(v_row.evidence) e
                      where e->>'check' = 'rehearsal' and coalesce((e->>'voided')::boolean, false) = false
                        and e->>'commit' = v_row.request->'code'->>'commit')
         or not exists (select 1 from public.switchboard_code_reviews
                         where request_id = v_row.id and status = 'reviewed' and commit = v_row.request->'code'->>'commit') then
        raise exception 'switchboard_consume_run_link: the code at % was not both rehearsed and reviewed. Nothing was approved.', v_row.request->'code'->>'commit'
          using errcode = '55000';
      end if;
    end if;
  else
    if not v_expired then
      raise exception 'switchboard_consume_run_link: the checks have not expired; there is nothing to run again.' using errcode = '55000';
    end if;
    -- A rerun waits while its action is approved and not yet finished: picked up, or within its 15 minutes. One that
    -- finished (passed, failed) or never started leaves the way open for another.
    if v_link.rerun_action_id is not null
       and exists (select 1 from public.switchboard_actions
                    where id = v_link.rerun_action_id and status = 'consumed'
                      and (picked_up_at is not null or created_at >= now() - interval '15 minutes')) then
      raise exception 'switchboard_consume_run_link: the pre-check and rehearsal were already asked for again at %; a second one waits for it.', v_link.rerun_at
        using errcode = '55000';
    end if;
    if v_link.used_at is not null and not v_stuck then
      raise exception 'switchboard_consume_run_link: this link has already been used.' using errcode = '55000';
    end if;
  end if;

  -- The desktop answered at the click (Q9): the panel and the helper both running.
  if jsonb_typeof(p_desktop) is distinct from 'object' or p_desktop->>'answer' is distinct from 'running'
     or p_desktop->'panel' is distinct from 'true'::jsonb or p_desktop->'helper' is distinct from 'true'::jsonb then
    raise exception 'switchboard_consume_run_link: the desktop is not ready (panel and helper running). Nothing was approved.' using errcode = '55000';
  end if;

  -- One path per project (Q10), by a read: no live link of today's kind and no run live for the project. The same
  -- lock as switchboard_issue_link (227), so two approvals (or an approval and an issue) for one project take turns.
  -- Only this link's own stuck action is left out.
  perform pg_advisory_xact_lock(hashtextextended('switchboard_issue_link:' || v_user::text || ':' || v_row.project_code, 0));
  select a.id into v_live from public.switchboard_actions a
   where a.user_id = v_user and a.project_code = v_row.project_code
     and not (v_stuck and a.id = v_newest.id)
     and ((a.link_hash is not null and a.link_used_at is null and a.link_expires_at > now())
          or (a.status = 'consumed'
              and (a.picked_up_at is not null or coalesce(a.link_used_at, a.created_at) >= now() - interval '15 minutes')))
   limit 1;
  if v_live is not null then
    raise exception 'switchboard_consume_run_link: action % is live for %; one at a time per project. Nothing was approved.', v_live, v_row.project_code
      using errcode = '55000';
  end if;

  -- s12b: a pre-check's copied checks (still in use here) back one approved write. Under the project lock above, and
  -- copies stay within one project, so two such approvals take turns. This request itself counts too: a used link of
  -- an earlier version means its write already ran on these checks (a later correction kept them in use).
  if p_mode = 'approve' and not v_as_rerun and v_row.page = 'dataop' then
    select r.id into v_other
      from jsonb_array_elements(v_row.evidence) e, public.switchboard_run_requests r
     where e ? 'copied_from' and coalesce((e->>'voided')::boolean, false) = false
       and r.user_id = v_user
       and r.evidence @> jsonb_build_array(jsonb_build_object('copied_from', e->>'copied_from'))
       and exists (select 1 from public.switchboard_run_links l where l.request_id = r.id and l.review_id is null and l.used_at is not null)
     limit 1;
    if v_other is not null then
      raise exception 'switchboard_consume_run_link: this pre-check''s checks already backed an approved data operation (request %); run a new pre-check. Nothing was approved.', v_other
        using errcode = '55000';
    end if;
  end if;

  if v_row.simulation then
    -- Q7: accepted, the link is spent, but no helper action and no run: the real logs never see a simulation. A
    -- simulation's Approve always spends its link (as 250), a correction's too: no evidence ever comes back for it.
    update public.switchboard_run_links
       set used_at = case when p_mode = 'approve' then now() else used_at end,
           rerun_at = case when v_as_rerun then now() else rerun_at end,
           desktop = p_desktop
     where id = v_link.id;
    return jsonb_build_object('consumed', true, 'simulated', true, 'link_id', v_link.id, 'mode', p_mode, 'action_id', null,
                              'as_rerun', v_as_rerun);
  end if;

  -- A rerun on a link whose run never started: fail its stale action first (consumed -> failed), as the pickup would.
  -- Only if still consumed and unpicked: a pickup failing it at the same moment leaves one failed run, not two.
  if v_as_rerun and v_stuck and v_newest.status = 'consumed' then
    update public.switchboard_actions set status = 'failed'
     where id = v_newest.id and status = 'consumed' and picked_up_at is null;
    get diagnostics v_failed = row_count;
    if v_failed = 1 then
      insert into public.switchboard_runs (user_id, action_id, mode, summary, result, failure_reason, finished_at)
      values (v_user, v_newest.id, 'real', 'expired: approved over 15 minutes ago and never picked up, never run',
              jsonb_build_object('ok', false, 'expired', true, 'reason', 'expired_not_picked_up'), 'expired_not_picked_up', now());
    end if;
  end if;

  -- The approval: an sf_run, consumed at insert by the guard (248), carrying only the link id.
  insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
  values (v_user, 'sf_run', v_row.project_code, jsonb_build_object('link_id', v_link.id::text),
          left(coalesce(nullif(btrim(v_row.request->>'headline'), ''), 'Run page ' || v_row.page), 300), 'claude')
  returning id into v_action;
  -- A rerun on a link whose approval never started makes the link unused again (s6b), so once the rerun passes the
  -- same link approves the data operation. A correction page's Approve (s12) is recorded the same way.
  update public.switchboard_run_links
     set used_at         = case when p_mode = 'approve' and not v_as_rerun then now() when v_stuck then null else used_at end,
         action_id       = case when p_mode = 'approve' and not v_as_rerun then v_action else action_id end,
         rerun_at        = case when v_as_rerun then now() else rerun_at end,
         rerun_action_id = case when v_as_rerun then v_action else rerun_action_id end,
         desktop         = p_desktop
   where id = v_link.id;
  return jsonb_build_object('consumed', true, 'simulated', false, 'link_id', v_link.id, 'mode', p_mode, 'action_id', v_action,
                            'as_rerun', v_as_rerun);
end;
$$;
comment on function public.switchboard_consume_run_link(text, text, jsonb, integer, text) is
  'Switchboard 3: Approve (p_mode approve) or "Run the pre-check and rehearsal again" (rerun) on a run page. Approves only when the link is the caller''s, not voided and (approve) unused, no other link of the same request version was used, the request is at the link''s version with the fingerprint the page showed, no check is dated in the future, the checks are within 24 hours of the oldest in use, copied ones included (not for an undo; a delete''s undo before its deadline), a data operation has every pre-check check (count, login, automation, backup, rehearsal) passed and in use, p_count equals the request''s count (dataop, undo), the code (if any) was rehearsed (rehearsal evidence carrying its commit) and reviewed at that commit, p_desktop says running with panel and helper up, no link or run is live for the project (Q10, under the same advisory lock as switchboard_issue_link), and (s12b) the pre-check whose checks it copied backs no other approved write. Locks the request, then the link. Rerun only on expired checks, not while the last rerun is approved and unfinished, and on a used link only when its run never started (s6b), which fails the stale action and frees the link. A correction page''s Approve (s12) is recorded like a rerun (rerun_at, rerun_action_id; refused while one is approved and unfinished), so the link stays unused and approves the write once the reruns pass. A simulation spends the link and creates nothing else (Q7). Otherwise inserts an sf_run with payload {link_id}, which the guard stores consumed (248). Returns {consumed, simulated, link_id, mode, action_id, as_rerun}. Called by switchboard-run-pages with Alex''s JWT.';
revoke all on function public.switchboard_consume_run_link(text, text, jsonb, integer, text) from public, anon;
grant execute on function public.switchboard_consume_run_link(text, text, jsonb, integer, text) to authenticated;

-- ============================================================================
-- 1b. switchboard_cancel_run_link: as 250, but Don't run is refused while the link's rerun (a write's correction
--     Approve, s12) is approved and unfinished: the link is no longer "used" then, but its reruns are running.
-- ============================================================================
create or replace function public.switchboard_cancel_run_link(p_token text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_link   public.switchboard_run_links;
  v_note   text := left(btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g')), 200);
begin
  if v_user is null then
    raise exception 'switchboard_cancel_run_link: no signed-in user.' using errcode = '28000';
  end if;
  select * into v_link from public.switchboard_run_links
   where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') and user_id = v_user
   for update;
  if not found then
    raise exception 'switchboard_cancel_run_link: no such link.' using errcode = 'P0002';
  elsif v_link.used_at is not null then
    raise exception 'switchboard_cancel_run_link: this link was already approved; it cannot be cancelled here.' using errcode = '55000';
  elsif v_link.voided_at is not null then
    raise exception 'switchboard_cancel_run_link: this link was already voided (%).', v_link.void_reason using errcode = '55000';
  elsif v_link.rerun_action_id is not null
        and exists (select 1 from public.switchboard_actions
                     where id = v_link.rerun_action_id and status = 'consumed'
                       and (picked_up_at is not null or created_at >= now() - interval '15 minutes')) then
    raise exception 'switchboard_cancel_run_link: its checks are running again (approved at %); wait until they finish.', v_link.rerun_at
      using errcode = '55000';
  end if;
  update public.switchboard_run_links
     set voided_at = now(), void_reason = 'cancelled' || case when v_note = '' then '' else ': ' || v_note end
   where id = v_link.id;
  return jsonb_build_object('cancelled', true, 'link_id', v_link.id, 'reason', nullif(v_note, ''));
end;
$$;
comment on function public.switchboard_cancel_run_link(text, text) is
  'Switchboard 3: Don''t run. Voids an unused link with void_reason "cancelled[: <note>]", the note one line of at most 200 characters (4.5 point 5). Refused for an approved link, and (s12) while its rerun, a write''s correction Approve or a "Run the pre-check and rehearsal again", is approved and unfinished. Returns {cancelled, link_id, reason}. Called by switchboard-run-pages with Alex''s JWT.';
revoke all on function public.switchboard_cancel_run_link(text, text) from public, anon;
grant execute on function public.switchboard_cancel_run_link(text, text) to authenticated;

-- ============================================================================
-- 2. switchboard_record_run_evidence: the passed checks of a finished pre-check run, from its own row.
-- ============================================================================
create function public.switchboard_record_run_evidence(p_run_id uuid)
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
  update public.switchboard_run_requests
     set evidence = v_evid,
         page = v_page,
         request = case when v_back then request || jsonb_build_object('page', v_page) else request end,
         updated_at = now()
   where id = v_row.id;
  return jsonb_build_object('recorded', jsonb_array_length(v_fresh), 'already', false, 'request_id', v_row.id, 'page', v_page);
end;
$$;
comment on function public.switchboard_record_run_evidence(uuid) is
  'Switchboard 3: record the passed checks of a finished run page pre-check run (the link''s approval on a pre-check page, or its rerun, which a correction page''s Approve is) as its request''s evidence. Reads only that run''s own switchboard_runs row: result {ok: true, pass: true, checks: [{check, org, commit?}]}, passed_at = finished_at; nothing from the caller but the run id. Refused for a run not finished or not passed, a malformed check, a simulation, a voided link or one for an older version, a run finished before the last correction, and a data operation''s own run; recorded once per run. Older entries for the same checks are kept, voided. A correction returns to its base page once every check it voided is in use again (and every write check, for a data operation). Returns {recorded, already, request_id, page}. Service role only: called by switchboard-runner after a helper''s result (Alex''s option A, s12).';
revoke all on function public.switchboard_record_run_evidence(uuid) from public, anon, authenticated;
grant execute on function public.switchboard_record_run_evidence(uuid) to service_role;

-- ============================================================================
-- 3. Result: must say CONFORMANT. Then run supabase/tests/sb3_pages-h6v/3_followup_test.sql with --test.
-- ============================================================================
select public.platform_check_conformance() as conformance;
