-- 257 (numbered at s27e by claims.cmd number-migration), sb3_pages-h6v s27e: fix 256's switchboard_queue_run_request.
-- Schema change (a function replaced). Spec: docs/technical-spec-sb3_pages-h6v.md 15.2.
-- The break: 256's pretend shape check had `(p_request->'pretend' - 'scenario')`. In PostgreSQL `-` binds tighter
-- than `->`, so it parsed as `p_request -> ('pretend' - 'scenario')`, unknown minus unknown, and PL/pgSQL plans the
-- whole IF condition the first time it reaches it, pretend or not. So every queue call failed with "operator is not
-- unique: unknown - unknown" (42725).
-- The fix: parentheses around the key lookup and an explicit text cast, `((p_request->'pretend') - 'scenario'::text)`.
-- Nothing else changes: the body is 256's with that one line, the comment and grants as 256 left them.
-- Function replaced: switchboard_queue_run_request (256). Tables it reads or writes, as before:
-- switchboard_run_requests, switchboard_run_links, switchboard_run_samples.
-- Ends with a smoke check that queues nothing (see section 2) and the conformance check.

-- ============================================================================
-- 1. switchboard_queue_run_request: 256's, with the pretend shape check parenthesised.
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
  'Switchboard 3: queue a run request (spec 4.1) for the signed-in caller. Refuses, before any link, a request without page, project_code, the problem label and sentence, side_effects, headline or steps; one with a sample, evidence, base_steps or base_phases (252: only a correction keeps those); a correction (use switchboard_correct_run_request); and a data operation or undo without its count. A simulation (Q7) is accepted and flagged. Pretend (s26, s26b) is request.pretend = {scenario: "<name>"} (1 to 40 of a-z, 0-9, hyphen, underscore; nothing else), only with simulation; it is kept in the stored request and sets the pretend column. An undo may name the data operation it undoes (undo_of.request_id, s27): a lower-case uuid naming the caller''s own request whose base page is dataop, in the same project, agreeing on simulation and on pretend; refused on any other page, and otherwise refused naming what is wrong. A data operation may name its pre-check (pre_check_request_id, s12b): the caller''s own Pre-check and Rehearsal request in the same project, on its pre-check page, with passed checks, agreeing on simulation and on pretend (both or neither; scenario names may differ), whose object, operation, records or filter, count (the write''s count is the pre-check''s total, else expected; other counts equal), field, value, file, other operation details, sandbox filter, code commit and target org all match; its checks in use are copied with their original passed_at and copied_from, so the 24 hours count from the oldest; the pre-check''s sample row moves to the new request, expires_at unchanged (s12c). Refused, naming every mismatch, otherwise, and when that pre-check already backed an approved write. Returns {request_id, version, copied_checks, moved_sample}. Called by the queue_switchboard_run_request tool (B3).';
revoke all on function public.switchboard_queue_run_request(jsonb) from public, anon;
grant execute on function public.switchboard_queue_run_request(jsonb) to authenticated;

-- ============================================================================
-- 2. Smoke check: queues nothing, fails loudly if the function can't run its checks.
-- ============================================================================
-- An empty request is refused at the first lines, before PL/pgSQL plans the pretend check, so it would not catch
-- this break. Each call below is refused on purpose after passing through the pretend check (and, the second, the
-- undo_of check), with a check_violation naming the expected refusal. Any other error, or no error, stops the
-- migration (and its dry run, before Approve). The calls are refused before any table is read or written, and the
-- caller is a made-up user.
do $$
declare
  v_base jsonb := jsonb_build_object('page', 'undo', 'project_code', 'smoke-check', 'headline', 'SMOKE CHECK',
                                     'side_effects', 'None, a smoke check.', 'steps', '[{"code": "write"}]'::jsonb,
                                     'problem', jsonb_build_object('label', 'P1', 'sentence', 'A smoke check.'),
                                     'simulation', true, 'pretend', jsonb_build_object('scenario', 'smoke'));
begin
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

-- ============================================================================
-- 3. Result: must say CONFORMANT. Then rerun supabase/tests/sb3_pages-h6v/8_pretend_test.sql with --test.
-- ============================================================================
select public.platform_check_conformance() as conformance;
