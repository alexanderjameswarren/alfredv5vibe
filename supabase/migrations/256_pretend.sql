-- 256 (numbered at s27b by claims.cmd number-migration), sb3_pages-h6v s26 to s27b: pretend mode, item a of spec
-- section 15. Schema change. Spec: docs/technical-spec-sb3_pages-h6v.md 15.2.
-- Tables altered: switchboard_run_requests (new column pretend, and two checks: pretend needs simulation, and the
-- column is true exactly when request.pretend is present), switchboard_runs (its mode check takes pretend). Column
-- comments: switchboard_run_requests.simulation and .pretend, switchboard_runs.mode, switchboard_actions.payload. No
-- data changes: every existing request reads pretend false and has no request.pretend.
-- Functions replaced whole, each its live definition with only the pretend change (the migration each comes from):
--   switchboard_queue_run_request (252), switchboard_correct_run_request (254), switchboard_consume_run_link (251),
--   switchboard_retry_run (250), switchboard_pickup_helper (248), switchboard_pickup_git (248),
--   switchboard_record_run_evidence (252), switchboard_store_run_sample (250), switchboard_record_run_outcome (254).
--   switchboard_run_preview (255) needs no change: it returns the stored request, request.pretend included.
-- Tables read or written by them, as before: switchboard_run_requests, switchboard_runs, switchboard_actions,
-- switchboard_run_links, switchboard_run_samples, switchboard_code_reviews.
--
-- What pretend is (agreed with the data runs thread and the hub): a simulation whose run really goes to the desktop
-- helper, which makes its data up from a named scenario and opens no org connection. Pretend implies simulation, so
-- every simulation behaviour stays (the strip, SIMULATION-prefixed lines); pretend adds only that consume makes the
-- action and run, and the made-up evidence, sample and outcome are recorded, on the pretend request and nowhere else.
--
-- 1. switchboard_run_requests.pretend, not null, default false, with two checks: pretend only with simulation, and
--    pretend = (request ? 'pretend').
-- 2. switchboard_runs.mode: dry_run, real or pretend.
-- 3. switchboard_queue_run_request: request.pretend, when present, is exactly {scenario: "<name>"}, the name 1 to 40
--    of a-z, 0-9, hyphen and underscore (s26b, the data runs thread's shape: a name, never a path). It needs
--    simulation, stays in the stored request (and so in the fingerprint), and sets the column. A pre-check and its
--    data operation agree on it: both have it or neither does; the scenario names may differ.
--    s27 (O5, the data runs thread's): an undo's undo_of.request_id, when present, is a lower-case uuid naming the
--    caller's own data operation request in the same project, agreeing on simulation and on pretend; only an undo
--    carries it. Without it, as before. A correction can't change undo_of (it is no kind's field).
-- 4. switchboard_correct_run_request: the chat's pretend is never compared and never stored; the stored
--    request.pretend is kept as it was, so a correction never changes it or the column. s27b (O2): the structured
--    allows is wording, as diagnosis_allows is, so a wording or allows edit may change it.
-- 5. switchboard_consume_run_link: a pretend request is approved as a real one is (an sf_run, consumed at insert), its
--    payload {link_id, pretend: true}. It returns simulated true and pretend true. A plain simulation is unchanged.
-- 6. The expired run of a pretend sf_run is mode pretend: in consume, switchboard_retry_run and the 15-minute expiry
--    of both pickups. The 10-minute expiry is unchanged: it fails only queued no-click actions, and an sf_run always
--    needs a click (switchboard_actions_sf_run_click), so it never reaches one.
-- 7. switchboard_pickup_helper opens a pretend sf_run's run as mode pretend, and its lost-reply replay finds a real or
--    pretend run. switchboard_pickup_git hands out git only, so only its expiry changes.
-- 8. switchboard_record_run_evidence and switchboard_record_run_outcome accept a pretend run on a pretend request, and
--    refuse a plain simulation, a pretend run on a real request and a real run on a pretend one.
--    switchboard_store_run_sample accepts a pretend request.

-- ============================================================================
-- 1. The tables.
-- ============================================================================
alter table public.switchboard_run_requests
  add column pretend boolean not null default false,
  add constraint switchboard_run_requests_pretend_simulation check (not pretend or simulation),
  add constraint switchboard_run_requests_pretend_request check (pretend = (request ? 'pretend'));
comment on column public.switchboard_run_requests.pretend is
  'Pretend (s26, spec 15.2): a simulation whose run goes to the desktop helper, which makes its data up from request.pretend = {scenario: "<name>"} and opens no org connection. True exactly when request.pretend is present, and only with simulation. Consume makes its sf_run, payload {link_id, pretend: true}, and its run is mode pretend; its made-up evidence, sample and outcome are recorded on this request only. Set by switchboard_queue_run_request; never changed by a correction.';
comment on column public.switchboard_run_requests.simulation is
  'Sample data (Q7). A plain simulation''s link is spent, but no helper action or run is ever created. A pretend one (pretend true, s26) makes its action and a pretend run, with made-up data.';

alter table public.switchboard_runs drop constraint switchboard_runs_mode_valid;
alter table public.switchboard_runs
  add constraint switchboard_runs_mode_valid check (mode in ('dry_run', 'real', 'pretend'));
comment on column public.switchboard_runs.mode is
  'dry_run (rolled back), real, or pretend (s26: the run of a pretend request''s sf_run; its data is made up and it touches no org).';

comment on column public.switchboard_actions.payload is
  'What will run. sql: {"sql": "..."}. git: {"command": "gitcom|gitsync|gitnewtree|gitpush", ...}, and a gitnewtree may name its "repo", an absolute path (spec 11.3). sf_check: {"check", "alias", "metadata_type" for metadata} (spec 11.4). sb_setup: {"command": "client start|org add", "client", "orgs": [...], "folder" with from_sandbox, ...} (spec 11.5). sf_read: {"alias", "production", "level": "objects|metadata|ids|data", "object" (or "objects", 1 to 20, at metadata), "count" or "fields" with "limit", "filters"}, never SOQL text (spec 10). sf_dataop: {"alias", "repo", "plan", "stamp", "preflight_at", "object", "problem", "expected", "write", "rows", "rehearsal"?} (docs/technical-spec-dataops_alfred-d4x.md). sf_dataquery: {"alias", "org_type": "sandbox|production" (required on insert since dataquery_fixes-v3n), "repo", "run", "run_tag", "request_sha256"?, "queries": [{"step", "soql", "sha256", "file" | "label"}]} (docs/technical-spec-dataop_link-k7d.md). sf_run: {"link_id": "<run page link id, a uuid>", "pretend": true on a pretend request''s run only (s26), ...the data runs thread''s keys} (sb3_runner-r4q, for sb3_pages-h6v). Fixed after insert.';

-- ============================================================================
-- 2. switchboard_queue_run_request: 252's, plus pretend.
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
  if p_request ? 'pretend'
     and not coalesce(case when jsonb_typeof(p_request->'pretend') = 'object'
                           then (p_request->'pretend' - 'scenario') = '{}'::jsonb
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
-- 3. switchboard_correct_run_request: 254's, with pretend among the database's own keys, kept as stored.
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
  'Switchboard 3: correct a run request (part 5 "Corrected"). Refuses (254, Alex s17b) every correction of a data operation or undo, wording included, once an approved write on it has started or may still start (its link''s approved action was picked up, has a run other than expired_not_picked_up, or is consumed within its 15 minutes): a further change is a new request through diagnosis; a write that never started leaves it correctable, and a pre-check is unaffected. Refuses an object or operation edit (a new request through diagnosis), and (s12c) any change to pre_check_request_id. Each kind changes only its own row of the correction table, besides the wording (headline, side effects, problem, what diagnosis allows: diagnosis_allows and, s27b, the structured allows) and, for a kind that reruns a check, the run''s own steps, phases, details, kept, run_tag and still_valid: value operation.value; file operation.file; field operation.field and undo; records selected_by (not its kind or sandbox filter), counts, operation.steps and undo; records_filter all of selected_by, counts, operation.steps and undo; sandbox_filter selected_by.sandbox_text and not_rehearsed; code the code. A kind that reruns the rehearsal may also add one role-rehearsal sandbox org to a request with none (252). Any other change is refused, naming the field (a key set to null counts as left out). A correction never changes simulation or pretend: simulation lives in its column, and (s26b) the stored request.pretend is kept as it was, whatever the corrected request sends. A wording or allowance edit voids nothing and keeps the version and the page. Any other edit raises the version by one, makes it a correction page, keeps the request''s own steps and phases as base_steps and base_phases (252; restored by switchboard_record_run_evidence on return), voids the evidence its kind reruns (field: rehearsal, login, backup, sample; Alex s8b) and the request''s live links, and for a code edit marks older reviews superseded, in one transaction. Returns {request_id, version, voided_checks, voided_links}.';
revoke all on function public.switchboard_correct_run_request(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function public.switchboard_correct_run_request(uuid, text, jsonb, jsonb) to authenticated;

-- ============================================================================
-- 4. switchboard_consume_run_link: 251's, but a pretend request makes its sf_run, payload {link_id, pretend: true}.
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

  -- s26: a pretend request goes on below, as a real one does: its sf_run carries pretend, and the helper makes its data up.
  if v_row.simulation and not v_row.pretend then
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
  -- s26: a pretend action's expired run is mode pretend.
  if v_as_rerun and v_stuck and v_newest.status = 'consumed' then
    update public.switchboard_actions set status = 'failed'
     where id = v_newest.id and status = 'consumed' and picked_up_at is null;
    get diagnostics v_failed = row_count;
    if v_failed = 1 then
      insert into public.switchboard_runs (user_id, action_id, mode, summary, result, failure_reason, finished_at)
      values (v_user, v_newest.id, case when coalesce(v_newest.payload->'pretend' = 'true'::jsonb, false) then 'pretend' else 'real' end,
              'expired: approved over 15 minutes ago and never picked up, never run',
              jsonb_build_object('ok', false, 'expired', true, 'reason', 'expired_not_picked_up'), 'expired_not_picked_up', now());
    end if;
  end if;

  -- The approval: an sf_run, consumed at insert by the guard (248), carrying only the link id, and (s26) pretend: true
  -- for a pretend request.
  insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
  values (v_user, 'sf_run', v_row.project_code,
          jsonb_build_object('link_id', v_link.id::text)
            || case when v_row.pretend then jsonb_build_object('pretend', true) else '{}'::jsonb end,
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
  -- s26: a pretend run is still a simulation (its lines start SIMULATION); pretend says it has an action.
  return jsonb_build_object('consumed', true, 'simulated', v_row.simulation, 'pretend', v_row.pretend, 'link_id', v_link.id,
                            'mode', p_mode, 'action_id', v_action, 'as_rerun', v_as_rerun);
end;
$$;
comment on function public.switchboard_consume_run_link(text, text, jsonb, integer, text) is
  'Switchboard 3: Approve (p_mode approve) or "Run the pre-check and rehearsal again" (rerun) on a run page. Approves only when the link is the caller''s, not voided and (approve) unused, no other link of the same request version was used, the request is at the link''s version with the fingerprint the page showed, no check is dated in the future, the checks are within 24 hours of the oldest in use, copied ones included (not for an undo; a delete''s undo before its deadline), a data operation has every pre-check check (count, login, automation, backup, rehearsal) passed and in use, p_count equals the request''s count (dataop, undo), the code (if any) was rehearsed (rehearsal evidence carrying its commit) and reviewed at that commit, p_desktop says running with panel and helper up, no link or run is live for the project (Q10, under the same advisory lock as switchboard_issue_link), and (s12b) the pre-check whose checks it copied backs no other approved write. Locks the request, then the link. Rerun only on expired checks, not while the last rerun is approved and unfinished, and on a used link only when its run never started (s6b), which fails the stale action and frees the link. A correction page''s Approve (s12) is recorded like a rerun (rerun_at, rerun_action_id; refused while one is approved and unfinished), so the link stays unused and approves the write once the reruns pass. A plain simulation spends the link and creates nothing else (Q7). Otherwise inserts an sf_run with payload {link_id}, plus pretend: true for a pretend request (s26), which the guard stores consumed (248); a pretend action''s expired run is mode pretend. Returns {consumed, simulated, link_id, mode, action_id, as_rerun}, and pretend when an action was made (simulated is true for a pretend request). Called by switchboard-run-pages with Alex''s JWT.';
revoke all on function public.switchboard_consume_run_link(text, text, jsonb, integer, text) from public, anon;
grant execute on function public.switchboard_consume_run_link(text, text, jsonb, integer, text) to authenticated;

-- ============================================================================
-- 5. switchboard_retry_run: 250's, but a pretend action's expired run is mode pretend.
-- ============================================================================
create or replace function public.switchboard_retry_run(p_token text, p_fingerprint text, p_desktop jsonb)
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
  v_newest  public.switchboard_actions;
  v_reason  text;
  v_live    uuid;
  v_action  uuid;
  v_req     uuid;
  v_failed  integer;
begin
  if v_user is null then
    raise exception 'switchboard_retry_run: no signed-in user.' using errcode = '28000';
  end if;
  -- The request, then the link, as in consume and correct.
  select request_id into v_req from public.switchboard_run_links
   where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') and user_id = v_user;
  if v_req is null then
    raise exception 'switchboard_retry_run: no such link.' using errcode = 'P0002';
  end if;
  select * into v_row from public.switchboard_run_requests where id = v_req for update;
  select * into v_link from public.switchboard_run_links
   where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') and user_id = v_user
   for update;
  if v_link.voided_at is not null then
    raise exception 'switchboard_retry_run: this link was voided (%).', v_link.void_reason using errcode = '55000';
  end if;
  if v_row.version <> v_link.request_version
     or p_fingerprint is distinct from public.switchboard_fingerprint(v_row.request || jsonb_build_object('version', v_row.version)) then
    raise exception 'switchboard_retry_run: the request changed since it was approved; nothing was resent.' using errcode = '55000';
  end if;
  select min((e->>'passed_at')::timestamptz) + interval '24 hours' into v_until
    from jsonb_array_elements(v_row.evidence) e
   where e ? 'passed_at' and coalesce((e->>'voided')::boolean, false) = false;
  if v_row.page <> 'undo' and v_until is not null and v_until <= now() then
    raise exception 'switchboard_retry_run: the checks expired at %; run the pre-check and rehearsal again instead.', v_until using errcode = '55000';
  end if;

  select * into v_newest from public.switchboard_actions
   where user_id = v_user and kind = 'sf_run' and payload->>'link_id' = v_link.id::text
   order by created_at desc, id desc limit 1;
  if v_newest.id is null then
    raise exception 'switchboard_retry_run: this link was never approved; there is nothing to resend.' using errcode = '55000';
  end if;
  select r.failure_reason into v_reason from public.switchboard_runs r
   where r.action_id = v_newest.id order by r.started_at desc limit 1;
  if not (coalesce(v_reason = 'expired_not_picked_up', false)
          or (v_newest.status = 'consumed' and v_newest.picked_up_at is null
              and v_newest.created_at < now() - interval '15 minutes')) then
    raise exception 'switchboard_retry_run: the last approval (%) is not "not started"; only a run that never started is resent.', v_newest.status
      using errcode = '55000';
  end if;
  if jsonb_typeof(p_desktop) is distinct from 'object' or p_desktop->>'answer' is distinct from 'running'
     or p_desktop->'panel' is distinct from 'true'::jsonb or p_desktop->'helper' is distinct from 'true'::jsonb then
    raise exception 'switchboard_retry_run: the desktop is not ready (panel and helper running). Nothing was resent.' using errcode = '55000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('switchboard_issue_link:' || v_user::text || ':' || v_row.project_code, 0));
  select a.id into v_live from public.switchboard_actions a
   where a.user_id = v_user and a.project_code = v_row.project_code and a.id <> v_newest.id
     and ((a.link_hash is not null and a.link_used_at is null and a.link_expires_at > now())
          or (a.status = 'consumed'
              and (a.picked_up_at is not null or coalesce(a.link_used_at, a.created_at) >= now() - interval '15 minutes')))
   limit 1;
  if v_live is not null then
    raise exception 'switchboard_retry_run: action % is live for %; one at a time per project. Nothing was resent.', v_live, v_row.project_code
      using errcode = '55000';
  end if;

  -- Agreed with the hub (4.5 point 2): the stale action fails in the same step that creates the resend; only if still
  -- consumed and unpicked, so a pickup failing it at the same moment leaves one failed run. s26: a pretend action's
  -- expired run is mode pretend.
  if v_newest.status = 'consumed' then
    update public.switchboard_actions set status = 'failed'
     where id = v_newest.id and status = 'consumed' and picked_up_at is null;
    get diagnostics v_failed = row_count;
    if v_failed = 1 then
      insert into public.switchboard_runs (user_id, action_id, mode, summary, result, failure_reason, finished_at)
      values (v_user, v_newest.id, case when coalesce(v_newest.payload->'pretend' = 'true'::jsonb, false) then 'pretend' else 'real' end,
              'expired: approved over 15 minutes ago and never picked up, never run',
              jsonb_build_object('ok', false, 'expired', true, 'reason', 'expired_not_picked_up'), 'expired_not_picked_up', now());
    end if;
  end if;
  -- The same run, the same payload and so the same fingerprint, the same link id (4.5 point 3).
  insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
  values (v_user, 'sf_run', v_newest.project_code, v_newest.payload, v_newest.headline, 'claude')
  returning id into v_action;
  update public.switchboard_run_links
     set action_id       = case when v_newest.id = v_link.rerun_action_id then action_id else v_action end,
         rerun_action_id = case when v_newest.id = v_link.rerun_action_id then v_action else rerun_action_id end,
         desktop         = p_desktop
   where id = v_link.id;
  return jsonb_build_object('resent', true, 'link_id', v_link.id, 'action_id', v_action, 'replaces', v_newest.id);
end;
$$;
comment on function public.switchboard_retry_run(text, text, jsonb) is
  'Switchboard 3: "Try again: resend this run". Only when the newest sf_run for the link never started (failed expired_not_picked_up, or consumed, never picked up, over 15 minutes old), the request is unchanged, the checks are valid (not for an undo), the desktop is ready and nothing else is live for the project (Q10). Fails a still-consumed stale action (consumed -> failed, with its run, mode pretend for a pretend action, s26) in the same step, then inserts the same sf_run again with the same payload, pretend included, so the same link id (4.5 points 2, 3). Returns {resent, link_id, action_id, replaces}. Called by switchboard-run-pages with Alex''s JWT.';
revoke all on function public.switchboard_retry_run(text, text, jsonb) from public, anon;
grant execute on function public.switchboard_retry_run(text, text, jsonb) to authenticated;

-- ============================================================================
-- 6. switchboard_pickup_helper: 248's, but a pretend sf_run's run is mode pretend, and the replay finds it.
-- ============================================================================
create or replace function public.switchboard_pickup_helper(p_user uuid, p_kinds text[] default null, p_pickup_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_all    constant text[] := array['git', 'sf_check', 'sf_read', 'sb_setup', 'sf_dataop', 'sf_dataquery', 'sf_datawrite', 'sf_run'];
  c_prod   constant text[] := array['sf_dataop', 'sf_dataquery', 'sf_datawrite'];
  v_kinds  text[];
  v_action public.switchboard_actions;
  v_run    uuid;
  v_again  uuid;
begin
  if p_user is null then
    raise exception 'switchboard_pickup_helper: no user.' using errcode = '22004';
  end if;
  if p_kinds is null then
    v_kinds := array['git', 'sf_check', 'sf_read', 'sb_setup'];
  elsif cardinality(p_kinds) = 0 or array_position(p_kinds, null) is not null or not (p_kinds <@ c_all) then
    raise exception 'switchboard_pickup_helper: p_kinds must list helper kinds only (%).', array_to_string(c_all, ', ')
      using errcode = '22023';
  else
    v_kinds := p_kinds;
  end if;

  -- A no-click action must not run long after it was queued: past 10 minutes it fails, with a run saying why.
  with expired as (
    update public.switchboard_actions
       set status = 'failed'
     where user_id = p_user and kind = any(c_all) and status = 'queued' and not needs_click
       and picked_up_at is null and created_at < now() - interval '10 minutes'
    returning id
  )
  insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
  select p_user, id, 'real', 'expired before the helper picked it up: queued over 10 minutes ago, never run',
         jsonb_build_object('ok', false, 'expired', true), now()
    from expired;

  -- r2: an approved action of any helper kind not picked up within 15 minutes of its approval never runs. A production
  -- kind consumed without a click is failed at once, as before (O6). s26: a pretend sf_run's expired run is mode pretend.
  with stale as (
    update public.switchboard_actions
       set status = 'failed'
     where user_id = p_user and kind = any(c_all) and status = 'consumed' and picked_up_at is null
       and (coalesce(link_used_at, created_at) < now() - interval '15 minutes'
            or (kind = any(c_prod) and link_used_at is null))
    returning id, coalesce(kind = 'sf_run' and payload->'pretend' = 'true'::jsonb, false) as pretend
  )
  insert into public.switchboard_runs (user_id, action_id, mode, summary, result, failure_reason, finished_at)
  select p_user, id, case when pretend then 'pretend' else 'real' end, 'expired: approved over 15 minutes ago and never picked up, never run',
         jsonb_build_object('ok', false, 'expired', true, 'reason', 'expired_not_picked_up'), 'expired_not_picked_up', now()
    from stale;

  -- r2: a repeat of a pickup whose reply was lost gets the same action and run, while that run is open. A repeat
  -- sent while the first is still running waits for it here, so it sees the first one's run. s26: a pretend run too.
  if p_pickup_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('switchboard_pickup:' || p_pickup_id::text, 0));
    select r.id, a.id into v_run, v_again
      from public.switchboard_runs r
      join public.switchboard_actions a on a.id = r.action_id
     where r.user_id = p_user and r.finished_at is null and r.mode in ('real', 'pretend')
       and r.result is not null and r.result->>'pickup_id' = p_pickup_id::text
       and a.user_id = p_user and a.kind = any(v_kinds) and a.status = 'consumed' and a.picked_up_at is not null
     order by r.started_at desc
     limit 1;
    if v_again is not null then
      select * into v_action from public.switchboard_actions where id = v_again;
      return jsonb_build_object('action_id', v_action.id, 'run_id', v_run, 'kind', v_action.kind,
                                'project_code', v_action.project_code, 'payload', v_action.payload,
                                'fingerprint', v_action.fingerprint, 'headline', v_action.headline, 'chat_url', v_action.chat_url);
    end if;
  end if;

  -- Ready: clicked (consumed) within 15 minutes, or queued and needing no click. A production kind only clicked, by
  -- its link. Not while that project has one running.
  select a.* into v_action from public.switchboard_actions a
   where a.user_id = p_user and a.kind = any(v_kinds) and a.picked_up_at is null
     and ((a.status = 'consumed' and coalesce(a.link_used_at, a.created_at) >= now() - interval '15 minutes')
          or (a.status = 'queued' and not a.needs_click))
     and (not (a.kind = any(c_prod))
          or (a.status = 'consumed' and a.needs_click and a.link_used_at is not null
              and a.link_used_at >= now() - interval '15 minutes'))
     and not exists (select 1 from public.switchboard_actions b
                      where b.user_id = p_user and b.kind = any(c_all)
                        and b.project_code = a.project_code
                        and b.picked_up_at is not null and b.status = 'consumed')
   order by a.created_at, a.id
   limit 1
   for update skip locked;
  if not found then
    return null;
  end if;

  update public.switchboard_actions
     set picked_up_at = now(), status = 'consumed'
   where id = v_action.id;
  -- s26: a pretend sf_run (payload pretend: true, set by consume, copied by a resend) opens a pretend run; everything
  -- else a real one.
  insert into public.switchboard_runs (user_id, action_id, mode, summary, result)
  values (p_user, v_action.id,
          case when v_action.kind = 'sf_run' and coalesce(v_action.payload->'pretend' = 'true'::jsonb, false) then 'pretend' else 'real' end,
          'picked up by the helper',
          case when p_pickup_id is null then null else jsonb_build_object('pickup_id', p_pickup_id) end)
  returning id into v_run;

  return jsonb_build_object('action_id', v_action.id, 'run_id', v_run, 'kind', v_action.kind,
                            'project_code', v_action.project_code, 'payload', v_action.payload,
                            'fingerprint', v_action.fingerprint, 'headline', v_action.headline, 'chat_url', v_action.chat_url);
end;
$$;
comment on function public.switchboard_pickup_helper(uuid, text[], uuid) is
  'Switchboard: hand the helper the oldest action of p_user, of a kind in p_kinds (default git, sf_check, sf_read, sb_setup; sf_dataop, sf_dataquery, sf_datawrite and sf_run only when named), that is ready to run: clicked within 15 minutes, or queued and needing no click. An sf_dataop, sf_dataquery or sf_datawrite only when consumed by Alex''s click on its link; an sf_run is consumed at insert by its run page''s consume, so its 15 minutes count from created_at. Any helper action approved (consumed) over 15 minutes ago, by coalesce(link_used_at, created_at), and never picked up is marked failed with a finished run, result {ok: false, expired: true, reason: expired_not_picked_up} and failure_reason expired_not_picked_up (sb3_runner-r4q r2; O6). A queued no-click action over 10 minutes old is marked failed the same way, without the reason. One running at a time per project code, across every helper kind. Sets picked_up_at, marks it consumed and opens a real run row, or (s26) a pretend one for an sf_run whose payload has pretend: true; that action''s expired run is pretend too. With p_pickup_id the run row carries result {pickup_id} until the helper''s result replaces it, and a repeat with the same id while that run (real or pretend) is open returns the same action and run. Returns {action_id, run_id, kind, project_code, payload, fingerprint, headline, chat_url}, or null. Called by switchboard-runner with the service role after it checks the pickup key (dataops_alfred-d4x; dataop_link-k7d; dataop_write-j5w; sb3_runner-r4q).';
revoke all on function public.switchboard_pickup_helper(uuid, text[], uuid) from public, anon, authenticated;
grant execute on function public.switchboard_pickup_helper(uuid, text[], uuid) to service_role;

-- ============================================================================
-- 7. switchboard_pickup_git: 248's, but a pretend sf_run's expired run is mode pretend. It hands out git only.
-- ============================================================================
create or replace function public.switchboard_pickup_git(p_user uuid, p_pickup_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_all    constant text[] := array['git', 'sf_check', 'sf_read', 'sb_setup', 'sf_dataop', 'sf_dataquery', 'sf_datawrite', 'sf_run'];
  c_prod   constant text[] := array['sf_dataop', 'sf_dataquery', 'sf_datawrite'];
  v_action public.switchboard_actions;
  v_run    uuid;
  v_again  uuid;
begin
  if p_user is null then
    raise exception 'switchboard_pickup_git: no user.' using errcode = '22004';
  end if;

  -- r2: an approved action of any helper kind not picked up within 15 minutes of its approval never runs. s26: a
  -- pretend sf_run's expired run is mode pretend.
  with stale as (
    update public.switchboard_actions
       set status = 'failed'
     where user_id = p_user and kind = any(c_all) and status = 'consumed' and picked_up_at is null
       and (coalesce(link_used_at, created_at) < now() - interval '15 minutes'
            or (kind = any(c_prod) and link_used_at is null))
    returning id, coalesce(kind = 'sf_run' and payload->'pretend' = 'true'::jsonb, false) as pretend
  )
  insert into public.switchboard_runs (user_id, action_id, mode, summary, result, failure_reason, finished_at)
  select p_user, id, case when pretend then 'pretend' else 'real' end, 'expired: approved over 15 minutes ago and never picked up, never run',
         jsonb_build_object('ok', false, 'expired', true, 'reason', 'expired_not_picked_up'), 'expired_not_picked_up', now()
    from stale;

  -- r2: a repeat of a pickup whose reply was lost gets the same action and run, while that run is open. A repeat
  -- sent while the first is still running waits for it here, so it sees the first one's run.
  if p_pickup_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('switchboard_pickup:' || p_pickup_id::text, 0));
    select r.id, a.id into v_run, v_again
      from public.switchboard_runs r
      join public.switchboard_actions a on a.id = r.action_id
     where r.user_id = p_user and r.finished_at is null and r.mode = 'real'
       and r.result is not null and r.result->>'pickup_id' = p_pickup_id::text
       and a.user_id = p_user and a.kind = 'git' and a.status = 'consumed' and a.picked_up_at is not null
     order by r.started_at desc
     limit 1;
    if v_again is not null then
      select * into v_action from public.switchboard_actions where id = v_again;
      return jsonb_build_object('action_id', v_action.id, 'run_id', v_run, 'project_code', v_action.project_code,
                                'payload', v_action.payload, 'fingerprint', v_action.fingerprint,
                                'headline', v_action.headline, 'chat_url', v_action.chat_url);
    end if;
  end if;

  -- Ready: clicked (consumed) within 15 minutes, or queued and needing no click. Not while that project has one running.
  select a.* into v_action from public.switchboard_actions a
   where a.user_id = p_user and a.kind = 'git' and a.picked_up_at is null
     and ((a.status = 'consumed' and coalesce(a.link_used_at, a.created_at) >= now() - interval '15 minutes')
          or (a.status = 'queued' and not a.needs_click))
     and not exists (select 1 from public.switchboard_actions b
                      where b.user_id = p_user and b.kind = 'git' and b.project_code = a.project_code
                        and b.picked_up_at is not null and b.status = 'consumed')
   order by a.created_at, a.id
   limit 1
   for update skip locked;
  if not found then
    return null;
  end if;

  update public.switchboard_actions
     set picked_up_at = now(), status = 'consumed'
   where id = v_action.id;
  insert into public.switchboard_runs (user_id, action_id, mode, summary, result)
  values (p_user, v_action.id, 'real', 'picked up by the helper',
          case when p_pickup_id is null then null else jsonb_build_object('pickup_id', p_pickup_id) end)
  returning id into v_run;

  return jsonb_build_object('action_id', v_action.id, 'run_id', v_run, 'project_code', v_action.project_code,
                            'payload', v_action.payload, 'fingerprint', v_action.fingerprint,
                            'headline', v_action.headline, 'chat_url', v_action.chat_url);
end;
$$;
comment on function public.switchboard_pickup_git(uuid, uuid) is
  'Switchboard: hand the helper the oldest git action of p_user that is ready to run: clicked within 15 minutes, or queued and needing no click. One at a time per project code. Any helper action, of any kind (sf_run included), approved (consumed) over 15 minutes ago, by coalesce(link_used_at, created_at), and never picked up is marked failed first, with a finished run, result {ok: false, expired: true, reason: expired_not_picked_up} and failure_reason expired_not_picked_up (sb3_runner-r4q r2); the run is mode pretend for an sf_run whose payload has pretend: true (s26), else real. Sets picked_up_at, marks it consumed and opens a real run row. With p_pickup_id the run row carries result {pickup_id} until the helper''s result replaces it, and a repeat with the same id while that run is open returns the same action and run. Returns {action_id, run_id, project_code, payload, fingerprint, headline, chat_url}, or null when nothing is ready. Called by switchboard-runner with the service role after it checks the pickup key; no other role can call it.';
revoke all on function public.switchboard_pickup_git(uuid, uuid) from public, anon, authenticated;
grant execute on function public.switchboard_pickup_git(uuid, uuid) to service_role;

-- ============================================================================
-- 8. switchboard_record_run_evidence: 252's, but a pretend run records on a pretend request.
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
  -- s26: a pretend run is accepted here; it must be on a pretend request (checked below, once the request is read).
  if v_run.mode not in ('real', 'pretend') or v_run.finished_at is null then
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
  'Switchboard 3: record the passed checks of a finished run page pre-check run (the link''s approval on a pre-check page, or its rerun, which a correction page''s Approve is) as its request''s evidence. Reads only that run''s own switchboard_runs row: result {ok: true, pass: true, checks: [{check, org, commit?}]}, passed_at = finished_at; nothing from the caller but the run id. Refused for a run not finished or not passed, a malformed check, a plain simulation, a voided link or one for an older version, a run finished before the last correction, and a data operation''s own run; recorded once per run. A pretend run (s26) records only on a pretend request, and a pretend request only from a pretend run. Older entries for the same checks are kept, voided. A correction returns to its base page once every check it voided is in use again (and every write check, for a data operation), and (252) gets its own steps and phases back from base_steps and base_phases, a multi-object run''s write_step entries following operation.steps. Returns {recorded, already, request_id, page}. Service role only: called by switchboard-runner after a helper''s result (Alex''s option A, s12).';
revoke all on function public.switchboard_record_run_evidence(uuid) from public, anon, authenticated;
grant execute on function public.switchboard_record_run_evidence(uuid) to service_role;

-- ============================================================================
-- 9. switchboard_store_run_sample: 250's, but a pretend request holds its made-up sample.
-- ============================================================================
create or replace function public.switchboard_store_run_sample(p_request_id uuid, p_sample jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row   public.switchboard_run_requests;
  v_until timestamptz;
begin
  select * into v_row from public.switchboard_run_requests where id = p_request_id;
  if not found then
    raise exception 'switchboard_store_run_sample: no such request.' using errcode = 'P0002';
  end if;
  -- s26: a pretend request's sample is made up by the helper, so it is held like a real one.
  if v_row.simulation and not v_row.pretend then
    raise exception 'switchboard_store_run_sample: a simulation holds no client data.' using errcode = '23514';
  end if;
  if jsonb_typeof(p_sample) is distinct from 'object' or jsonb_typeof(p_sample->'records') is distinct from 'array'
     or jsonb_array_length(p_sample->'records') not between 1 and 2 then
    raise exception 'switchboard_store_run_sample: the sample is {records: [one record, or two for an upsert]}.' using errcode = '23514';
  end if;
  select min((e->>'passed_at')::timestamptz) + interval '24 hours' into v_until
    from jsonb_array_elements(v_row.evidence) e
   where e ? 'passed_at' and coalesce((e->>'voided')::boolean, false) = false;
  if v_until is null or v_until <= now() then
    raise exception 'switchboard_store_run_sample: no valid checks to hold it against; store the evidence first.' using errcode = '55000';
  end if;
  insert into public.switchboard_run_samples (user_id, request_id, sample, created_at, expires_at)
  values (v_row.user_id, v_row.id, p_sample, now(), least(v_until, now() + interval '24 hours'))
  on conflict (request_id) do update set sample = excluded.sample, created_at = excluded.created_at, expires_at = excluded.expires_at;
  return jsonb_build_object('stored', true, 'request_id', v_row.id, 'expires_at', least(v_until, now() + interval '24 hours'));
end;
$$;
comment on function public.switchboard_store_run_sample(uuid, jsonb) is
  'Switchboard 3: store (or replace) a request''s sample record from its pre-check, held until the checks'' valid-until and never more than 24 hours (part 7). Refused for a plain simulation and without valid evidence; a pretend request (s26) holds its made-up sample like a real one. Service role only: called by the data runs thread through plumbing.';
revoke all on function public.switchboard_store_run_sample(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.switchboard_store_run_sample(uuid, jsonb) to service_role;

-- ============================================================================
-- 10. switchboard_record_run_outcome: 254's, but a pretend run's outcome is kept on a pretend request.
-- ============================================================================
create or replace function public.switchboard_record_run_outcome(p_run_id uuid, p_outcome jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
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
  if v_row.base_page not in ('dataop', 'undo') then
    raise exception 'switchboard_record_run_outcome: run % is a % run; only a data operation or undo has an outcome. Nothing was recorded.', p_run_id, v_row.base_page
      using errcode = '55000';
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
  'Switchboard 3: keep a data operation''s or undo''s outcome on its request (outcome, outcome_run_id, outcome_recorded_at), since the run''s own result is pruned after 30 days. Accepted only for a finished real run of the sf_run action its link approved (link.action_id), on a request whose base page is dataop or undo, not a plain simulation; or (s26) a finished pretend run on a pretend request, whose outcome is made up; a pretend run on a real request and a real run on a pretend one are refused. p_outcome is a JSON object of at most 64 KB, stored as given. A pre-check''s run, a rerun, an unfinished run and a run that never started are refused. Once per run: the same run again returns already true. A later run of the same link (a resend) replaces it; a run approved through another link of the request never does. Never touches evidence, the 24-hour clock or what can be approved. Returns {recorded, already, request_id}. Service role only: called by switchboard-runner after a write''s result.';
revoke all on function public.switchboard_record_run_outcome(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.switchboard_record_run_outcome(uuid, jsonb) to service_role;

-- ============================================================================
-- 11. Result: must say CONFORMANT. Then run supabase/tests/sb3_pages-h6v/8_pretend_test.sql with --test.
-- ============================================================================
select public.platform_check_conformance() as conformance;
