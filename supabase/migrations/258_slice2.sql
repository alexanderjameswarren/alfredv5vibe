-- 258 (numbered at s31b by claims.cmd number-migration; written at s31c from the pending draft), sb3_pages-h6v s31
-- and s31b: slice 2's one migration.
-- Schema change (four functions replaced). Spec: docs/technical-spec-sb3_pages-h6v.md 15.3, 16.3, 16.4, 16.6, 16.7, 16.9.
-- Each body is the live one (md5 of prosrc checked against live on 2026-11-27), changed only for:
--   item b (15.3): switchboard_record_run_evidence keeps a failed rehearsal's passed production checks, never
--     rehearsal, and voids any rehearsal still in use; it reads {ok: true, pass: false, failed_check: 'rehearsal',
--     checks}. switchboard_queue_run_request refuses a data operation whose pre-check has no rehearsal in use.
--   O23 (16.4): switchboard_queue_run_request checks interrupted.request_id on a check page: the caller's own data
--     operation, same project, simulation and pretend matching, its object, kind and (when it has one) field the
--     check page's. A correction can't change interrupted: it is in neither c_words nor c_run, so
--     switchboard_correct_run_request's diff refuses it. s31b (Alex): that function also refuses a field or value edit
--     on a check page, so the check's operation stays the interrupted data operation's.
--   item e (16.3): switchboard_record_run_outcome accepts a check page's {check: {job, at_goal, at_backup, neither}},
--     job one of Queued, Preparing, Processing, Holding, InProgress, Completed, Failed, Aborted or none, the counts
--     whole numbers, 0 or more; checked before the once-per-run return.
-- Functions replaced:
--   switchboard_queue_run_request (257, live 76893e08): reads and writes switchboard_run_requests, reads
--     switchboard_run_links, writes switchboard_run_samples, as before;
--   switchboard_record_run_evidence (256, live e9893467): reads switchboard_runs, switchboard_actions,
--     switchboard_run_links, writes switchboard_run_requests, as before;
--   switchboard_record_run_outcome (256, live 5a69fdbc): the same tables, as before;
--   switchboard_correct_run_request (256, live 44d03965): reads and writes switchboard_run_requests, switchboard_run_links
--     and switchboard_code_reviews, reads switchboard_actions and switchboard_runs, as before.
-- Grants as before: the queue and the correction to authenticated; evidence and outcome to service_role only; none to
-- public or anon.
-- Ends with a smoke check (section 5; its parts 4a and 4b) that calls each function past every changed line and undoes everything, then
-- the conformance check. Then supabase/tests/sb3_pages-h6v/9_slice2_test.sql runs with --test.

-- ============================================================================
-- 1. switchboard_queue_run_request: 257's, with O23's interrupted.request_id and item b's rehearsal in use.
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
  v_pretend boolean;
  v_total  jsonb;
  v_id     uuid;
  v_pre_id uuid;
  v_pre    public.switchboard_run_requests;
  v_undone public.switchboard_run_requests;
  v_broke  public.switchboard_run_requests;
  v_why    text[] := '{}';
  v_diff   text[] := '{}';
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
  -- s26: pretend, a simulation whose run the helper makes up (spec 15.2). Never without simulation. s26b: its shape is
  -- {scenario: "<name>"}, a name only, never a path (the data runs thread's).
  -- The case guards the key removal, which fails on a scalar; coalesce makes a missing scenario a refusal.
  -- s27e: the lookup is parenthesised, since `-` binds tighter than `->`.
  if p_request ? 'pretend'
     and not coalesce(case when jsonb_typeof(p_request->'pretend') = 'object'
                           then ((p_request->'pretend') - 'scenario'::text) = '{}'::jsonb
                                and jsonb_typeof(p_request->'pretend'->'scenario') = 'string'
                                and p_request->'pretend'->>'scenario' ~ '^[a-z0-9_-]{1,40}$'
                           else false end, false) then
    raise exception 'switchboard_queue_run_request: pretend must be {"scenario": "<name>"}, the name 1 to 40 lower-case letters, digits, hyphens or underscores, and nothing else. No link was issued.' using errcode = '23514';
  end if;
  v_pretend := p_request ? 'pretend';
  if v_pretend and not v_sim then
    raise exception 'switchboard_queue_run_request: pretend needs simulation true: a pretend run is a simulation whose data the helper makes up. No link was issued.' using errcode = '23514';
  end if;
  v_total := case when v_page = 'undo' then coalesce(p_request->'counts'->'undo_up_to', p_request->'counts'->'expected')
                  else coalesce(p_request->'counts'->'total', p_request->'counts'->'expected') end;
  if v_page in ('dataop', 'undo') and (jsonb_typeof(v_total) is distinct from 'number' or v_total::text !~ '^[0-9]{1,9}$') then
    raise exception 'switchboard_queue_run_request: add counts.total (or expected; undo_up_to on an undo): the count the run writes.' using errcode = '23514';
  end if;
  -- s27 (O5): an undo may name the data operation it undoes, undo_of.request_id: the caller's own data operation
  -- request in the same project, as pre_check_request_id is checked. Without it, undo_of queues as before.
  if jsonb_typeof(p_request->'undo_of') = 'object' and p_request->'undo_of' ? 'request_id' then
    if v_page <> 'undo' then
      raise exception 'switchboard_queue_run_request: only an undo names the data operation it undoes (undo_of.request_id). No link was issued.' using errcode = '23514';
    end if;
    if jsonb_typeof(p_request->'undo_of'->'request_id') is distinct from 'string'
       or p_request->'undo_of'->>'request_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'switchboard_queue_run_request: undo_of.request_id must be the data operation request''s id (a lower-case uuid). No link was issued.' using errcode = '23514';
    end if;
    -- Same user: another user's request is not found.
    select * into v_undone from public.switchboard_run_requests
     where id = (p_request->'undo_of'->>'request_id')::uuid and user_id = v_user;
    if not found then
      raise exception 'switchboard_queue_run_request: no such data operation request (%) for undo_of.request_id. No link was issued.', p_request->'undo_of'->>'request_id'
        using errcode = 'P0002';
    end if;
    if v_undone.base_page <> 'dataop' then
      raise exception 'switchboard_queue_run_request: request % is not a data operation (it is a %); undo_of.request_id names the data operation this undoes. No link was issued.', v_undone.id, v_undone.base_page
        using errcode = '23514';
    end if;
    if v_undone.project_code <> v_code then
      raise exception 'switchboard_queue_run_request: the data operation is for project %, not %; an undo undoes a data operation in its own project. No link was issued.', v_undone.project_code, v_code
        using errcode = '23514';
    end if;
    -- As 15.6a proposed and the data runs thread confirmed: simulation and pretend match, as for a pre-check.
    if v_undone.simulation <> v_sim then
      raise exception 'switchboard_queue_run_request: a simulation and a real request never undo each other; the undo and its data operation must both be simulations, or neither. No link was issued.' using errcode = '23514';
    end if;
    if v_undone.pretend <> v_pretend then
      raise exception 'switchboard_queue_run_request: a pretend request and a plain simulation never undo each other; the undo and its data operation must both have pretend, or neither. No link was issued.' using errcode = '23514';
    end if;
  end if;
  -- s31 (O23): a check page may name the data operation that was interrupted, interrupted.request_id: the caller's own
  -- data operation request in the same project, agreeing on simulation and pretend, as undo_of.request_id is checked;
  -- and the check page's operation is that data operation's (object and kind, and field when it has one: an insert,
  -- delete or undelete has none). Without it, interrupted queues as before.
  if jsonb_typeof(p_request->'interrupted') = 'object' and p_request->'interrupted' ? 'request_id' then
    if v_page <> 'check' then
      raise exception 'switchboard_queue_run_request: only a check names the data operation that was interrupted (interrupted.request_id). No link was issued.' using errcode = '23514';
    end if;
    if jsonb_typeof(p_request->'interrupted'->'request_id') is distinct from 'string'
       or p_request->'interrupted'->>'request_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'switchboard_queue_run_request: interrupted.request_id must be the interrupted data operation request''s id (a lower-case uuid). No link was issued.' using errcode = '23514';
    end if;
    -- Same user: another user's request is not found.
    select * into v_broke from public.switchboard_run_requests
     where id = (p_request->'interrupted'->>'request_id')::uuid and user_id = v_user;
    if not found then
      raise exception 'switchboard_queue_run_request: no such data operation request (%) for interrupted.request_id. No link was issued.', p_request->'interrupted'->>'request_id'
        using errcode = 'P0002';
    end if;
    if v_broke.base_page <> 'dataop' then
      raise exception 'switchboard_queue_run_request: request % is not a data operation (it is a %); interrupted.request_id names the data operation that was interrupted. No link was issued.', v_broke.id, v_broke.base_page
        using errcode = '23514';
    end if;
    if v_broke.project_code <> v_code then
      raise exception 'switchboard_queue_run_request: the data operation is for project %, not %; a check looks at a data operation in its own project. No link was issued.', v_broke.project_code, v_code
        using errcode = '23514';
    end if;
    if v_broke.simulation <> v_sim then
      raise exception 'switchboard_queue_run_request: a simulation and a real request never check each other; the check and its data operation must both be simulations, or neither. No link was issued.' using errcode = '23514';
    end if;
    if v_broke.pretend <> v_pretend then
      raise exception 'switchboard_queue_run_request: a pretend request and a plain simulation never check each other; the check and its data operation must both have pretend, or neither. No link was issued.' using errcode = '23514';
    end if;
    if jsonb_typeof(p_request->'operation') is distinct from 'object' then
      raise exception 'switchboard_queue_run_request: add operation: the interrupted data operation''s object and kind, and its field when it has one. No link was issued.' using errcode = '23514';
    end if;
    if (p_request->'operation'->'object') is distinct from (v_broke.request->'operation'->'object') then
      v_diff := v_diff || format('object: the check has %s, the data operation %s',
                                 coalesce(p_request->'operation'->>'object', '(none)'), coalesce(v_broke.request->'operation'->>'object', '(none)'));
    end if;
    if (p_request->'operation'->'kind') is distinct from (v_broke.request->'operation'->'kind') then
      v_diff := v_diff || format('kind: the check has %s, the data operation %s',
                                 coalesce(p_request->'operation'->>'kind', '(none)'), coalesce(v_broke.request->'operation'->>'kind', '(none)'));
    end if;
    if jsonb_typeof(v_broke.request->'operation'->'field') = 'string'
       and (p_request->'operation'->'field') is distinct from (v_broke.request->'operation'->'field') then
      v_diff := v_diff || format('field: the check has %s, the data operation %s',
                                 coalesce(p_request->'operation'->>'field', '(none)'), v_broke.request->'operation'->>'field');
    end if;
    if cardinality(v_diff) > 0 then
      raise exception 'switchboard_queue_run_request: the check''s operation is not the interrupted data operation''s (%). No link was issued.', array_to_string(v_diff, '; ')
        using errcode = '23514';
    end if;
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
    -- s26: nor a pretend request and a plain simulation (pretend implies simulation, so both are simulations here).
    -- s26b: both have pretend or neither does; the scenario names may differ.
    if v_pre.pretend <> v_pretend then
      raise exception 'switchboard_queue_run_request: a pretend request and a plain simulation never share checks; the pre-check and the data operation must both have pretend, or neither. No link was issued.' using errcode = '23514';
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
    -- s31 (item b, 15.3): the write needs a rehearsal in use. A pre-check that failed at the rehearsal keeps its passed
    -- production checks with its rehearsal voided, so it backs no data operation until a rehearsal passes.
    if not exists (select 1 from jsonb_array_elements(v_copied) e where e->>'check' = 'rehearsal') then
      raise exception 'switchboard_queue_run_request: the pre-check has no rehearsal in use (it failed at the rehearsal, or a correction voided it); queue the data operation once a rehearsal passes. No link was issued.'
        using errcode = '23514';
    end if;
  end if;

  -- s26b: request.pretend stays in the stored request (and so in the fingerprint); the column says whether it is there.
  insert into public.switchboard_run_requests (user_id, project_code, page, base_page, simulation, pretend, request, evidence, total_count)
  values (v_user, v_code, v_page, v_page, v_sim, v_pretend,
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
  'Switchboard 3: queue a run request (spec 4.1) for the signed-in caller. Refuses, before any link, a request without page, project_code, the problem label and sentence, side_effects, headline or steps; one with a sample, evidence, base_steps or base_phases (252: only a correction keeps those); a correction (use switchboard_correct_run_request); and a data operation or undo without its count. A simulation (Q7) is accepted and flagged. Pretend (s26, s26b) is request.pretend = {scenario: "<name>"} (1 to 40 of a-z, 0-9, hyphen, underscore; nothing else), only with simulation; it is kept in the stored request and sets the pretend column. An undo may name the data operation it undoes (undo_of.request_id, s27): a lower-case uuid naming the caller''s own request whose base page is dataop, in the same project, agreeing on simulation and on pretend; refused on any other page, and otherwise refused naming what is wrong. A check may name the data operation that was interrupted (interrupted.request_id, s31): checked as undo_of.request_id is, and the check''s operation object and kind, and field when the data operation has one, must be that data operation''s; refused on any other page, and with no operation. A data operation may name its pre-check (pre_check_request_id, s12b): the caller''s own Pre-check and Rehearsal request in the same project, on its pre-check page, with passed checks including a rehearsal in use (s31), agreeing on simulation and on pretend (both or neither; scenario names may differ), whose object, operation, records or filter, count (the write''s count is the pre-check''s total, else expected; other counts equal), field, value, file, other operation details, sandbox filter, code commit and target org all match; its checks in use are copied with their original passed_at and copied_from, so the 24 hours count from the oldest; the pre-check''s sample row moves to the new request, expires_at unchanged (s12c). Refused, naming every mismatch, otherwise, and when that pre-check already backed an approved write. Returns {request_id, version, copied_checks, moved_sample}. Called by the queue_switchboard_run_request tool (B3).';
revoke all on function public.switchboard_queue_run_request(jsonb) from public, anon;
grant execute on function public.switchboard_queue_run_request(jsonb) to authenticated;

-- ============================================================================
-- 2. switchboard_record_run_evidence: 256's, with item b's rehearsal failure.
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
  v_failed boolean;
  v_void   text[];
begin
  select * into v_run from public.switchboard_runs where id = p_run_id;
  if not found then
    raise exception 'switchboard_record_run_evidence: no such run.' using errcode = 'P0002';
  end if;
  select * into v_action from public.switchboard_actions where id = v_run.action_id and user_id = v_run.user_id;
  if v_action.id is null or v_action.kind <> 'sf_run' then
    raise exception 'switchboard_record_run_evidence: that run is not a run page''s (sf_run) run.' using errcode = '23514';
  end if;
  -- s26: a pretend run is accepted here; it must be on a pretend request (checked below, once the request is read).
  if v_run.mode not in ('real', 'pretend') or v_run.finished_at is null then
    raise exception 'switchboard_record_run_evidence: the run has not finished.' using errcode = '55000';
  end if;
  -- s31 (item b, 15.3): a pre-check that stopped at the sandbox rehearsal reports {ok: true, pass: false,
  -- failed_check: 'rehearsal', checks: [the production checks that passed]}. Those are kept; any rehearsal still in
  -- use is voided. failed_check is only 'rehearsal', and only on such a result.
  v_failed := coalesce((v_run.result->'ok') = 'true'::jsonb
                       and (v_run.result->'pass') = 'false'::jsonb
                       and (v_run.result->'failed_check') = '"rehearsal"'::jsonb, false);
  if coalesce(v_run.result ? 'failed_check', false) and not v_failed then
    raise exception 'switchboard_record_run_evidence: failed_check is only "rehearsal", on a result with ok true and pass false; no evidence is recorded.' using errcode = '23514';
  end if;
  if not v_failed
     and (coalesce(v_run.result->'ok', 'false'::jsonb) <> 'true'::jsonb or coalesce(v_run.result->'pass', 'false'::jsonb) <> 'true'::jsonb) then
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
  if v_failed and exists (select 1 from jsonb_array_elements(v_run.result->'checks') c where c->>'check' = 'rehearsal') then
    raise exception 'switchboard_record_run_evidence: a run that failed at the rehearsal never records a rehearsal; list only the production checks that passed. No evidence is recorded.' using errcode = '23514';
  end if;

  -- The link and its request, locked request first, as the link functions do.
  v_linkid := (v_action.payload->>'link_id')::uuid;
  select * into v_link from public.switchboard_run_links where id = v_linkid and user_id = v_run.user_id;
  if v_link.id is null then
    raise exception 'switchboard_record_run_evidence: no link for that run.' using errcode = 'P0002';
  end if;
  select * into v_row from public.switchboard_run_requests where id = v_link.request_id for update;
  select * into v_link from public.switchboard_run_links where id = v_linkid for update;
  if v_row.simulation and not v_row.pretend then
    raise exception 'switchboard_record_run_evidence: a simulation records no evidence.' using errcode = '55000';
  end if;
  -- s26: made-up evidence only on a pretend request, and a pretend request's evidence only from a pretend run.
  if (v_run.mode = 'pretend') <> v_row.pretend then
    raise exception 'switchboard_record_run_evidence: a pretend run records evidence only on a pretend request, and a pretend request only from a pretend run; no evidence is recorded.' using errcode = '55000';
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
    return jsonb_build_object('recorded', 0, 'already', true, 'request_id', v_row.id, 'page', v_row.page, 'rehearsal_failed', v_failed);
  end if;
  -- Each check once per result, and never older than the evidence it would replace.
  if (select count(distinct c->>'check') from jsonb_array_elements(v_run.result->'checks') c) <> jsonb_array_length(v_run.result->'checks') then
    raise exception 'switchboard_record_run_evidence: the run''s result names a check twice.' using errcode = '23514';
  end if;
  -- s31: the checks this run replaces: its own, and on a rehearsal failure the rehearsal too.
  select array_agg(c->>'check') || (case when v_failed then array['rehearsal'] else array[]::text[] end)
    into v_void
    from jsonb_array_elements(v_run.result->'checks') c;
  if exists (select 1 from jsonb_array_elements(v_row.evidence) e
              where e->>'check' = any(v_void) and coalesce((e->>'voided')::boolean, false) = false
                and (e->>'passed_at')::timestamptz > v_run.finished_at) then
    raise exception 'switchboard_record_run_evidence: newer evidence for these checks is already in use; an older run never replaces it.' using errcode = '55000';
  end if;

  select jsonb_agg(jsonb_build_object('check', c->>'check', 'org', c->>'org', 'passed_at', v_run.finished_at, 'run_id', v_run.id)
                   || case when c ? 'commit' then jsonb_build_object('commit', c->>'commit') else '{}'::jsonb end),
         array_agg(c->>'check')
    into v_fresh, v_names
    from jsonb_array_elements(v_run.result->'checks') c;
  -- Older entries for the same checks stay, voided; the new ones are in use. s31: on a rehearsal failure the
  -- rehearsal in use is voided too, and none replaces it.
  select coalesce(jsonb_agg(case when e->>'check' = any(v_void) and coalesce((e->>'voided')::boolean, false) = false
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
  return jsonb_build_object('recorded', jsonb_array_length(v_fresh), 'already', false, 'request_id', v_row.id, 'page', v_page,
                            'rehearsal_failed', v_failed);
end;
$$;
comment on function public.switchboard_record_run_evidence(uuid) is
  'Switchboard 3: record the passed checks of a finished run page pre-check run (the link''s approval on a pre-check page, or its rerun, which a correction page''s Approve is) as its request''s evidence. Reads only that run''s own switchboard_runs row: result {ok: true, pass: true, checks: [{check, org, commit?}]}, passed_at = finished_at; nothing from the caller but the run id. A run that stopped at the sandbox rehearsal (s31, item b) reports {ok: true, pass: false, failed_check: "rehearsal", checks: [the production checks that passed]}: those are recorded, never a rehearsal, and any rehearsal still in use is voided, so its pre-check backs no data operation until a rehearsal passes; failed_check is refused on any other result. Refused for a run not finished or not passed, a malformed check, a plain simulation, a voided link or one for an older version, a run finished before the last correction, and a data operation''s own run; recorded once per run. A pretend run (s26) records only on a pretend request, and a pretend request only from a pretend run. Older entries for the same checks are kept, voided. A correction returns to its base page once every check it voided is in use again (and every write check, for a data operation), and (252) gets its own steps and phases back from base_steps and base_phases, a multi-object run''s write_step entries following operation.steps. Returns {recorded, already, request_id, page, rehearsal_failed}, already true with recorded 0 on a repeat. Service role only: called by switchboard-runner after a helper''s result (Alex''s option A, s12).';
revoke all on function public.switchboard_record_run_evidence(uuid) from public, anon, authenticated;
grant execute on function public.switchboard_record_run_evidence(uuid) to service_role;

-- ============================================================================
-- 3. switchboard_record_run_outcome: 256's, with item e's check outcome.
-- ============================================================================
create or replace function public.switchboard_record_run_outcome(p_run_id uuid, p_outcome jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- s31 (item e): Salesforce's job states, and none for a small run with no job (the data runs thread's answer).
  c_jobs   constant text[] := array['Queued', 'Preparing', 'Processing', 'Holding', 'InProgress', 'Completed', 'Failed', 'Aborted', 'none'];
  v_run    public.switchboard_runs;
  v_action public.switchboard_actions;
  v_link   public.switchboard_run_links;
  v_row    public.switchboard_run_requests;
begin
  if p_outcome is null or jsonb_typeof(p_outcome) <> 'object' then
    raise exception 'switchboard_record_run_outcome: the outcome must be a JSON object.' using errcode = '22023';
  end if;
  if octet_length(p_outcome::text) > 65536 then
    raise exception 'switchboard_record_run_outcome: the outcome is over 64 KB (% bytes).', octet_length(p_outcome::text) using errcode = '22023';
  end if;
  select * into v_run from public.switchboard_runs where id = p_run_id;
  if v_run.id is null then
    raise exception 'switchboard_record_run_outcome: no such run (%).', p_run_id using errcode = 'P0002';
  end if;
  -- s26: a pretend run is accepted here; it must be on a pretend request (checked below, once the request is read).
  if v_run.mode not in ('real', 'pretend') then
    raise exception 'switchboard_record_run_outcome: run % is a %, not a real or pretend run.', p_run_id, v_run.mode using errcode = '55000';
  end if;
  if v_run.finished_at is null then
    raise exception 'switchboard_record_run_outcome: run % has not finished.', p_run_id using errcode = '55000';
  end if;
  select * into v_action from public.switchboard_actions where id = v_run.action_id;
  if v_action.id is null or v_action.kind <> 'sf_run' or v_action.user_id <> v_run.user_id then
    raise exception 'switchboard_record_run_outcome: run % is not a run page''s run.', p_run_id using errcode = '55000';
  end if;
  -- The link that approved this action: action_id is set only by Approve on a page that writes or pre-checks, never by a
  -- rerun (rerun_action_id) and moved to the new action by a resend.
  select * into v_link from public.switchboard_run_links
   where id::text = v_action.payload->>'link_id' and user_id = v_run.user_id and action_id = v_run.action_id;
  if v_link.id is null then
    raise exception 'switchboard_record_run_outcome: run % is not the run its link approved (a rerun, or a superseded run). Nothing was recorded.', p_run_id
      using errcode = '55000';
  end if;
  -- Lock in consume's order (the request, then the link), then read the link again: a resend may have moved its action.
  select * into v_row from public.switchboard_run_requests where id = v_link.request_id for update;
  select * into v_link from public.switchboard_run_links where id = v_link.id for update;
  if v_link.action_id is distinct from v_run.action_id then
    raise exception 'switchboard_record_run_outcome: run % is not the run its link approved (a rerun, or a superseded run). Nothing was recorded.', p_run_id
      using errcode = '55000';
  end if;
  if v_run.failure_reason = 'expired_not_picked_up' then
    raise exception 'switchboard_record_run_outcome: run % never started; it has no outcome. Nothing was recorded.', p_run_id using errcode = '55000';
  end if;
  if v_row.base_page not in ('dataop', 'undo', 'check') then
    raise exception 'switchboard_record_run_outcome: run % is a % run; only a data operation, undo or check has an outcome. Nothing was recorded.', p_run_id, v_row.base_page
      using errcode = '55000';
  end if;
  -- s31 (item e, 16.3): a check's outcome is exactly {check: {job, at_goal, at_backup, neither}}. Checked here, before
  -- the once-per-run return below, so a bad outcome is refused even on a run that already has one. A data operation's
  -- and an undo's stay shape-free. The case guards the key removal, which fails on a scalar.
  if v_row.base_page = 'check'
     and not coalesce(case when jsonb_typeof(p_outcome->'check') = 'object'
                           then (p_outcome - 'check'::text) = '{}'::jsonb
                                and ((p_outcome->'check') - array['job', 'at_goal', 'at_backup', 'neither']) = '{}'::jsonb
                                and ((p_outcome->'check') ?& array['job', 'at_goal', 'at_backup', 'neither'])
                                and jsonb_typeof(p_outcome->'check'->'job') = 'string'
                                and (p_outcome->'check'->>'job') = any(c_jobs)
                                and not exists (select 1 from unnest(array['at_goal', 'at_backup', 'neither']) k
                                                 where jsonb_typeof(p_outcome->'check'->k) is distinct from 'number'
                                                    or (p_outcome->'check'->k)::text !~ '^[0-9]{1,9}$')
                           else false end, false) then
    raise exception 'switchboard_record_run_outcome: a check''s outcome is exactly {"check": {"job", "at_goal", "at_backup", "neither"}}: job one of %, and each count a whole number, 0 or more. Nothing was recorded.', array_to_string(c_jobs, ', ')
      using errcode = '22023';
  end if;
  if v_row.simulation and not v_row.pretend then
    raise exception 'switchboard_record_run_outcome: request % is a simulation; it has no outcome. Nothing was recorded.', v_row.id using errcode = '55000';
  end if;
  -- s26: a made-up outcome only on a pretend request, and a pretend request's outcome only from a pretend run.
  if (v_run.mode = 'pretend') <> v_row.pretend then
    raise exception 'switchboard_record_run_outcome: a pretend run''s outcome is kept only on a pretend request, and a pretend request''s only from a pretend run. Nothing was recorded.'
      using errcode = '55000';
  end if;
  if v_row.outcome_run_id = p_run_id then
    return jsonb_build_object('recorded', false, 'already', true, 'request_id', v_row.id);
  end if;
  -- A backstop (part 3 refuses a correction once a write ran, so a request is written once): the first write's outcome
  -- is the durable record of a real change, so another link never replaces it; only a later run of the same link (a
  -- resend) does.
  if v_row.outcome_run_id is not null and not exists (
       select 1 from public.switchboard_runs r join public.switchboard_actions a on a.id = r.action_id
        where r.id = v_row.outcome_run_id and a.payload->>'link_id' = v_link.id::text) then
    raise exception 'switchboard_record_run_outcome: request % already keeps the outcome of run %, approved through another link. Nothing was recorded.',
      v_row.id, v_row.outcome_run_id using errcode = '55000';
  end if;
  update public.switchboard_run_requests
     set outcome = p_outcome, outcome_run_id = p_run_id, outcome_recorded_at = now(), updated_at = now()
   where id = v_row.id;
  return jsonb_build_object('recorded', true, 'already', false, 'request_id', v_row.id);
end;
$$;
comment on function public.switchboard_record_run_outcome(uuid, jsonb) is
  'Switchboard 3: keep a data operation''s, undo''s or (s31) check''s outcome on its request (outcome, outcome_run_id, outcome_recorded_at), since the run''s own result is pruned after 30 days. Accepted only for a finished real run of the sf_run action its link approved (link.action_id), on a request whose base page is dataop, undo or check, not a plain simulation; or (s26) a finished pretend run on a pretend request, whose outcome is made up; a pretend run on a real request and a real run on a pretend one are refused. p_outcome is a JSON object of at most 64 KB, stored as given; on a check (item e) it is exactly {check: {job, at_goal, at_backup, neither}}, job one of Queued, Preparing, Processing, Holding, InProgress, Completed, Failed, Aborted or none, each count a whole number of 0 or more, checked before the once-per-run return. A pre-check''s run, a rerun, an unfinished run and a run that never started are refused. Once per run: the same run again returns already true. A later run of the same link (a resend) replaces it; a run approved through another link of the request never does. Never touches evidence, the 24-hour clock or what can be approved. Returns {recorded, already, request_id}. Service role only: called by switchboard-runner after a write''s or check''s result.';
revoke all on function public.switchboard_record_run_outcome(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.switchboard_record_run_outcome(uuid, jsonb) to service_role;

-- ============================================================================
-- 4. switchboard_correct_run_request: 256's, refusing a field or value edit on a check page (s31b, O23).
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
  v_wrote   uuid;
  v_keep    jsonb;
  -- Words only: what every kind may change (250's wording rule), what the database sets, (252) the base steps and
  -- phases the database keeps, (s26b) pretend, which the database keeps as stored (v_keep below), and (s27b, O2) the
  -- structured allows, which changes as diagnosis_allows does.
  c_words   constant text[] := array['headline', 'side_effects', 'problem', 'diagnosis_allows', 'allows', 'changed', 'page', 'id', 'version',
                                     'corrected_at', 'simulation', 'pretend', 'base_steps', 'base_phases'];
  -- What a correction run carries of its own, for a kind that reruns a check: its steps and phases, its run folder and
  -- hashes, what it keeps, its run tag, and the still-valid list.
  c_run     constant text[] := array['steps', 'phases', 'details', 'kept', 'run_tag', 'still_valid'];
  -- Keys the chat never sends: the database's own.
  c_set     constant text[] := array['id', 'version', 'corrected_at', 'evidence', 'simulation', 'pretend', 'base_steps', 'base_phases'];
begin
  if v_user is null then
    raise exception 'switchboard_correct_run_request: no signed-in user.' using errcode = '28000';
  end if;
  select * into v_row from public.switchboard_run_requests where id = p_request_id and user_id = v_user for update;
  if not found then
    raise exception 'switchboard_correct_run_request: no such request.' using errcode = 'P0002';
  end if;
  -- 254 (s17b, Alex's option A): once a write on a data operation or undo has started, or may still start, the request
  -- can't be corrected, whatever the kind; a further change is a new request through diagnosis, with its own pre-check.
  -- Started or may still start: a link's approved action (link.action_id, the write; a rerun never sets it) that was
  -- picked up, has a run other than one marked expired_not_picked_up, or is still consumed within its 15 minutes. A
  -- write that never started (failed as expired_not_picked_up, or consumed, unpicked and past 15 minutes) leaves the
  -- request correctable. Consume locks the request first, so an Approve and a correction never cross; a pickup locks
  -- only its action, so every approved action of the request is locked first and read after any pickup commits.
  if v_row.base_page in ('dataop', 'undo') then
    perform 1 from public.switchboard_actions a
     where a.id in (select l.action_id from public.switchboard_run_links l where l.request_id = v_row.id and l.action_id is not null)
       for update;
    select a.id into v_wrote
      from public.switchboard_run_links l
      join public.switchboard_actions a on a.id = l.action_id
     where l.request_id = v_row.id
       and (a.picked_up_at is not null
            or exists (select 1 from public.switchboard_runs r
                        where r.action_id = a.id and r.failure_reason is distinct from 'expired_not_picked_up')
            or (a.status = 'consumed' and a.created_at >= now() - interval '15 minutes'))
     order by a.created_at desc, a.id desc
     limit 1;
    if v_wrote is not null then
      raise exception 'switchboard_correct_run_request: a production write already ran on this request (action %); queue a new request through diagnosis. No link was issued.', v_wrote
        using errcode = '55000';
    end if;
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
  -- s31b (O23): a check page's operation is the interrupted data operation's, checked when the check was queued, and a
  -- check has nothing to rehearse; so a field or value edit, which would move it off that operation, is refused.
  if v_row.base_page = 'check' and p_edit_kind in ('field', 'value') then
    raise exception 'switchboard_correct_run_request: a check page''s operation must stay the interrupted data operation''s, so a % edit is refused; queue a new check instead. No link was issued.', p_edit_kind
      using errcode = '23514';
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
  -- s26b: the stored request.pretend, kept as it was (the chat's is dropped by c_set), so the column still matches.
  v_keep := case when v_row.request ? 'pretend' then jsonb_build_object('pretend', v_row.request->'pretend') else '{}'::jsonb end;

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
                     || case when v_row.page = 'correction' then v_base else '{}'::jsonb end
                     || v_keep,
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
                        || v_base
                        || v_keep,
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
  'Switchboard 3: correct a run request (part 5 "Corrected"). Refuses (254, Alex s17b) every correction of a data operation or undo, wording included, once an approved write on it has started or may still start (its link''s approved action was picked up, has a run other than expired_not_picked_up, or is consumed within its 15 minutes): a further change is a new request through diagnosis; a write that never started leaves it correctable, and a pre-check is unaffected. Refuses an object or operation edit (a new request through diagnosis), (s12c) any change to pre_check_request_id, and (s31b) a field or value edit on a check page, whose operation stays the interrupted data operation''s (queue a new check instead). Each kind changes only its own row of the correction table, besides the wording (headline, side effects, problem, what diagnosis allows: diagnosis_allows and, s27b, the structured allows) and, for a kind that reruns a check, the run''s own steps, phases, details, kept, run_tag and still_valid: value operation.value; file operation.file; field operation.field and undo; records selected_by (not its kind or sandbox filter), counts, operation.steps and undo; records_filter all of selected_by, counts, operation.steps and undo; sandbox_filter selected_by.sandbox_text and not_rehearsed; code the code. A kind that reruns the rehearsal may also add one role-rehearsal sandbox org to a request with none (252). Any other change is refused, naming the field (a key set to null counts as left out). A correction never changes simulation or pretend: simulation lives in its column, and (s26b) the stored request.pretend is kept as it was, whatever the corrected request sends. A wording or allowance edit voids nothing and keeps the version and the page. Any other edit raises the version by one, makes it a correction page, keeps the request''s own steps and phases as base_steps and base_phases (252; restored by switchboard_record_run_evidence on return), voids the evidence its kind reruns (field: rehearsal, login, backup, sample; Alex s8b) and the request''s live links, and for a code edit marks older reviews superseded, in one transaction. Returns {request_id, version, voided_checks, voided_links}.';
revoke all on function public.switchboard_correct_run_request(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function public.switchboard_correct_run_request(uuid, text, jsonb, jsonb) to authenticated;

-- ============================================================================
-- 5. Smoke check: calls each replaced function past every changed line, then undoes everything.
-- ============================================================================
-- The lesson of 256: PL/pgSQL plans an expression only the first time it reaches it, so a migration can apply cleanly
-- and every later call fail. Each call below reaches the lines this migration changed (named in its comment); a
-- refusal is caught only by its SQLSTATE and words, and anything else (another error, or no error where a refusal is
-- due) stops the migration and so its dry run, before Approve.
-- 4a keeps 257's two cases, as a made-up user, refused before any table is read. 4b runs as Alex (the page functions
-- read auth.uid() from the JWT claims; evidence and outcome read the run's user_id), on pretend requests in smoke-check
-- projects that it makes, links, approves and runs by hand (no pickup), and undoes by raising a sentinel caught by name.
do $$
declare
  v_base jsonb := jsonb_build_object('page', 'undo', 'project_code', 'smoke-check', 'headline', 'SMOKE CHECK',
                                     'side_effects', 'None, a smoke check.', 'steps', '[{"code": "write"}]'::jsonb,
                                     'problem', jsonb_build_object('label', 'P1', 'sentence', 'A smoke check.'),
                                     'simulation', true, 'pretend', jsonb_build_object('scenario', 'smoke'));
begin
  -- ---- 4a. 257's cases, unchanged ----
  perform set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('request.jwt.claim.sub'), 'role', 'authenticated')::text, true);
  -- Through the pretend check, refused for the missing count.
  begin
    perform public.switchboard_queue_run_request(v_base);
    raise exception 'smoke check: switchboard_queue_run_request accepted an undo with no count';
  exception when check_violation then
    if sqlerrm not like '%add counts.total%' then raise; end if;
  end;
  -- Through the pretend and count checks into undo_of, refused for a bad request_id.
  begin
    perform public.switchboard_queue_run_request(v_base || jsonb_build_object('counts', jsonb_build_object('expected', 1),
              'undo_of', jsonb_build_object('run_tag', 'smoke-check-s1-ab12', 'request_id', 'not-a-uuid')));
    raise exception 'smoke check: switchboard_queue_run_request accepted a bad undo_of.request_id';
  exception when check_violation then
    if sqlerrm not like '%undo_of.request_id must be%' then raise; end if;
  end;
end;
$$;

do $$
declare
  c_alex   constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_ready  constant jsonb := '{"answer": "running", "panel": true, "helper": true}';
  c_prod   constant jsonb := '{"alias": "smoke-prod", "org_type": "production", "role": "target"}';
  c_sb     constant jsonb := '{"alias": "smoke-sb", "org_type": "sandbox", "role": "rehearsal"}';
  c_check  constant jsonb := '{"check": {"job": "Completed", "at_goal": 45, "at_backup": 0, "neither": 0}}';
  c_why    constant jsonb := '{"reason": "A smoke check.", "items": [{"what": "Field", "old": "Campaign__c", "new": "Appeal__c"}]}';
  v_base   jsonb;
  v_chk    jsonb;
  v_fresh  jsonb;
  v_out    jsonb;
  v_tok    text;
  v_p      jsonb;
  v_pre    uuid;
  v_dop    uuid;
  v_cid    uuid;
  v_act    uuid;
  v_run    uuid;
  v_run2   uuid;
  v_msg    text;
  v_state  text;
  v_calls  integer := 0;
begin
  begin
    perform set_config('request.jwt.claim.sub', c_alex::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', c_alex, 'role', 'authenticated')::text, true);
    select jsonb_agg(jsonb_build_object('check', c, 'org', case when c = 'rehearsal' then 'sandbox' else 'production' end,
                                        'passed_at', now() - interval '2 hours'))
      into v_fresh from unnest(array['count', 'login', 'automation', 'backup', 'sample', 'rehearsal']) c;
    v_base := jsonb_build_object(
      'page', 'precheck', 'headline', 'SMOKE CHECK: SLICE 2', 'project_code', 'smoke-slice2-b', 'simulation', true,
      'pretend', jsonb_build_object('scenario', 'smoke'),
      'problem', jsonb_build_object('label', 'P1', 'sentence', 'A smoke check.'),
      'side_effects', 'None, a smoke check.', 'orgs', jsonb_build_array(c_prod, c_sb),
      'operation', jsonb_build_object('kind', 'update', 'object', 'Gift__c', 'field', 'Campaign__c', 'value', 'X'),
      'selected_by', jsonb_build_object('kind', 'ids', 'text', '45 ids'),
      'counts', jsonb_build_object('expected', 45, 'total', 45),
      'steps', '[{"code": "write"}]'::jsonb);

    -- ---- 4b-1. evidence (item b): a pre-check whose rehearsal failed ----
    v_pre := (public.switchboard_queue_run_request(v_base)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_pre;
    v_out := public.switchboard_issue_run_link(v_pre);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_act := (public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, null)->>'action_id')::uuid;
    if v_act is null then raise exception 'smoke check: consume made no action for the pre-check'; end if;
    -- failed_check on a passing result: reaches v_failed and the failed_check refusal.
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'pretend', 'smoke check', '{"ok": true, "pass": true, "failed_check": "rehearsal", "checks": [{"check": "count", "org": "production"}]}', now())
    returning id into v_run2;
    v_msg := null; v_state := null;
    begin perform public.switchboard_record_run_evidence(v_run2); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%failed_check is only "rehearsal"%' then
      raise exception 'smoke check: evidence, failed_check on a pass (got %: %)', v_state, coalesce(v_msg, 'recorded');
    end if;
    v_calls := v_calls + 1;
    -- A rehearsal failure listing a rehearsal: reaches the new pass test and the rehearsal refusal.
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'pretend', 'smoke check', '{"ok": true, "pass": false, "failed_check": "rehearsal", "checks": [{"check": "rehearsal", "org": "sandbox"}]}', now())
    returning id into v_run2;
    v_msg := null; v_state := null;
    begin perform public.switchboard_record_run_evidence(v_run2); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%never records a rehearsal%' then
      raise exception 'smoke check: evidence, rehearsal listed on a rehearsal failure (got %: %)', v_state, coalesce(v_msg, 'recorded');
    end if;
    v_calls := v_calls + 1;
    -- The rehearsal failure itself: reaches v_void, the newer-evidence test on it, the voiding, and the return.
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'pretend', 'smoke check', '{"ok": true, "pass": false, "failed_check": "rehearsal", "checks": [{"check": "count", "org": "production"}, {"check": "login", "org": "production"}]}', now())
    returning id into v_run;
    v_out := public.switchboard_record_run_evidence(v_run);
    if (v_out->>'recorded')::integer is distinct from 2 or (v_out->>'rehearsal_failed')::boolean is not true
       or (select exists (select 1 from jsonb_array_elements(evidence) e
                           where e->>'check' = 'rehearsal' and coalesce((e->>'voided')::boolean, false) = false)
             from public.switchboard_run_requests where id = v_pre) then
      raise exception 'smoke check: evidence, a rehearsal failure did not keep 2 checks and void the rehearsal (got %)', v_out;
    end if;
    v_calls := v_calls + 1;

    -- ---- 4b-2. the queue (item b): a data operation on that pre-check, which has no rehearsal in use ----
    -- Reaches the pre-check block's copy and the new rehearsal refusal.
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_base || jsonb_build_object('page', 'dataop', 'pre_check_request_id', v_pre));
    exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%the pre-check has no rehearsal in use%' then
      raise exception 'smoke check: queue, a data operation on a pre-check with no rehearsal (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_calls := v_calls + 1;
    -- record_run_outcome on the pre-check's run: reaches the changed base-page refusal and its new words.
    v_msg := null; v_state := null;
    begin perform public.switchboard_record_run_outcome(v_run, c_check); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '55000' or v_msg not like '%only a data operation, undo or check has an outcome%' then
      raise exception 'smoke check: outcome on a pre-check (got %: %)', v_state, coalesce(v_msg, 'recorded');
    end if;
    v_calls := v_calls + 1;

    -- ---- 4b-3. the queue (O23): interrupted.request_id on a check page ----
    v_dop := (public.switchboard_queue_run_request(v_base || '{"page": "dataop", "project_code": "smoke-slice2-e"}'::jsonb)->>'request_id')::uuid;
    v_chk := v_base || jsonb_build_object('page', 'check', 'project_code', 'smoke-slice2-e',
               'interrupted', jsonb_build_object('run_tag', 'smoke-slice2-e-s5-ab12', 'request_id', v_dop));
    -- Each refusal below reaches its own new line; the accepted one reaches every condition in the block.
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_base || jsonb_build_object('page', 'dataop', 'project_code', 'smoke-slice2-e',
                    'interrupted', jsonb_build_object('run_tag', 'x', 'request_id', v_dop)));
    exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%only a check names the data operation that was interrupted%' then
      raise exception 'smoke check: queue, interrupted.request_id off a check (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(jsonb_set(v_chk, '{interrupted,request_id}', '"not-a-uuid"'));
    exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%interrupted.request_id must be%' then
      raise exception 'smoke check: queue, a bad interrupted.request_id (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(jsonb_set(v_chk, '{interrupted,request_id}', to_jsonb(gen_random_uuid()::text)));
    exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from 'P0002' or v_msg not like '%for interrupted.request_id%' then
      raise exception 'smoke check: queue, an unknown interrupted.request_id (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(jsonb_set(v_chk, '{interrupted,request_id}', to_jsonb(v_pre::text)));
    exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%interrupted.request_id names the data operation that was interrupted%' then
      raise exception 'smoke check: queue, interrupted.request_id naming a pre-check (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_chk || '{"project_code": "smoke-slice2-f"}'::jsonb);
    exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%a check looks at a data operation in its own project%' then
      raise exception 'smoke check: queue, a check in another project (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request((v_chk - 'pretend') || '{"simulation": false}'::jsonb);
    exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%never check each other; the check and its data operation must both be simulations%' then
      raise exception 'smoke check: queue, a real check of a simulation (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_chk - 'pretend');
    exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%the check and its data operation must both have pretend%' then
      raise exception 'smoke check: queue, a plain-simulation check of a pretend one (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_chk - 'operation');
    exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%add operation: the interrupted data operation''s object and kind%' then
      raise exception 'smoke check: queue, a check with no operation (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_chk || jsonb_build_object('operation',
                    jsonb_build_object('kind', 'delete', 'object', 'Contact', 'field', 'Other__c')));
    exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514'
       or v_msg not like '%(object: the check has Contact, the data operation Gift__c; kind: the check has delete, the data operation update; field: the check has Other__c, the data operation Campaign__c)%' then
      raise exception 'smoke check: queue, a check of another operation (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_cid := (public.switchboard_queue_run_request(v_chk)->>'request_id')::uuid;
    if v_cid is null then raise exception 'smoke check: queue, the matching check was not queued'; end if;
    v_calls := v_calls + 10;

    -- ---- 4b-3a. the correction (s31b): field and value refused on a check page, a field edit allowed elsewhere ----
    -- A field edit on the check: reaches the new base-page test and its refusal. A value edit: the same, the other kind.
    v_msg := null; v_state := null;
    begin perform public.switchboard_correct_run_request(v_cid, 'field', jsonb_set(v_chk, '{operation,field}', '"Appeal__c"'), c_why);
    exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%a check page''s operation must stay the interrupted data operation''s, so a field edit is refused%' then
      raise exception 'smoke check: correction, a field edit on a check (got %: %)', v_state, coalesce(v_msg, 'corrected');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_correct_run_request(v_cid, 'value', jsonb_set(v_chk, '{operation,value}', '"Y"'), c_why);
    exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%so a value edit is refused%' then
      raise exception 'smoke check: correction, a value edit on a check (got %: %)', v_state, coalesce(v_msg, 'corrected');
    end if;
    -- A field edit on the data operation (no link, no write): passes the new test, to the version raise.
    v_out := public.switchboard_correct_run_request(v_dop, 'field',
               jsonb_set(v_base || '{"page": "dataop", "project_code": "smoke-slice2-e"}'::jsonb, '{operation,field}', '"Appeal__c"'), c_why);
    if (v_out->>'version')::integer is distinct from 2 then
      raise exception 'smoke check: correction, a field edit on a data operation was not made (got %)', v_out;
    end if;
    v_calls := v_calls + 3;

    -- ---- 4b-4. outcome (item e): the check page's run ----
    v_out := public.switchboard_issue_run_link(v_cid);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_act := (public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, null)->>'action_id')::uuid;
    if v_act is null then raise exception 'smoke check: consume made no action for the check'; end if;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'pretend', 'smoke check', '{"ok": true}', now()) returning id into v_run;
    -- A bad job: reaches the base-page gate (check passes it) and the shape refusal.
    v_msg := null; v_state := null;
    begin perform public.switchboard_record_run_outcome(v_run, jsonb_set(c_check, '{check,job}', '"Running"'));
    exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '22023' or v_msg not like '%a check''s outcome is exactly%' then
      raise exception 'smoke check: outcome, a bad job (got %: %)', v_state, coalesce(v_msg, 'recorded');
    end if;
    -- A good one: past the shape check, the pretend rules and the once-per-run return, to the update.
    v_out := public.switchboard_record_run_outcome(v_run, c_check);
    if (v_out->>'recorded')::boolean is not true
       or not exists (select 1 from public.switchboard_run_requests where id = v_cid and outcome = c_check and outcome_run_id = v_run) then
      raise exception 'smoke check: outcome, a good check outcome was not recorded (got %)', v_out;
    end if;
    -- A bad count on the same run, which already has one: refused before the once-per-run return.
    v_msg := null; v_state := null;
    begin perform public.switchboard_record_run_outcome(v_run, jsonb_set(c_check, '{check,neither}', '-1'));
    exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '22023' or v_msg not like '%a check''s outcome is exactly%' then
      raise exception 'smoke check: outcome, a bad count after one was kept (got %: %)', v_state, coalesce(v_msg, 'recorded');
    end if;
    v_calls := v_calls + 3;

    raise exception 'slice2_smoke_undo';
  exception when others then
    if sqlerrm <> 'slice2_smoke_undo' then raise; end if;
  end;
  raise notice 'slice 2 smoke check: % calls as expected; everything undone.', v_calls;
end;
$$;

-- ============================================================================
-- 6. Result: must say CONFORMANT. Then run supabase/tests/sb3_pages-h6v/9_slice2_test.sql with --test.
-- ============================================================================
select public.platform_check_conformance() as conformance;
