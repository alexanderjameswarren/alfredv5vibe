-- 259 (numbered at s35b by claims.cmd number-migration; written at s35c from the pending draft), sb3_pages-h6v s35:
-- slice 2b, O18 kept TEST records and O24 the "Delete sandbox test data" page.
-- Schema change: two columns, two check constraints redrawn, six functions replaced, one function added.
-- Spec: docs/technical-spec-sb3_pages-h6v.md 17.1, 17.2, 17.7 (the data runs thread's answers), 17.9.
-- Each replaced body is the live one (md5 of prosrc checked against live on 2026-11-27, s35), changed only for:
--   O18 (17.1): a pre-check may carry keep_test_records: true, with keep_test in place of delete_test in its steps
--     and a rehearsal sandbox; its kept sets are recorded per run by the new switchboard_record_kept_test_records,
--     on a pass and on a FAIL at the rehearsal (failed_check rehearsal), never on ok false; preview shows them.
--   O24 (17.2): the page delete_test_data, on one sandbox only, naming the pre-check whose kept TEST records it
--     deletes (test_data_of {request_id, run_tag}); its count is every kept set not yet deleted, summed; the run ids
--     it deletes are kept in test_run_ids; consume and retry re-check the sum, the sandbox and a second delete page;
--     a correction changes only its wording; its outcome, on ok true and pass true, marks those sets deleted.
-- switchboard_record_run_evidence is not replaced: kept records are recorded by their own function, which the
-- runner calls before evidence, so the rehearsal-failure path (item b) needs no change there.
-- Functions replaced (tables as before, plus the two new columns):
--   switchboard_queue_run_request (258, live 934acd07): reads switchboard_run_links and switchboard_actions (s35:
--     the second delete page), writes switchboard_run_requests and switchboard_run_samples;
--   switchboard_consume_run_link (256, live cd9e7672); switchboard_retry_run (256, live eeab7c9b);
--   switchboard_correct_run_request (258, live 47ae4fc0); switchboard_record_run_outcome (258, live 3b5e3903);
--   switchboard_run_preview (255, live b34e0d6c).
-- Function added: switchboard_record_kept_test_records(uuid), service_role only: reads switchboard_runs,
--   switchboard_actions and switchboard_run_links, writes switchboard_run_requests.kept_test_records.
-- Grants as before: queue, consume, retry, correct and preview to authenticated; outcome and the new function to
-- service_role only; none to public or anon. The columns need no register_table: the table is registered, and its
-- grants cover new columns; each gets a comment.
-- Ends with a smoke check (section 8) that calls each changed function past every changed line and undoes
-- everything, then the conformance check. Then supabase/tests/sb3_pages-h6v/10_slice2b_test.sql runs with --test.

-- ============================================================================
-- 0. The columns and the page constraints.
-- ============================================================================
alter table public.switchboard_run_requests
  add column kept_test_records jsonb check (kept_test_records is null or jsonb_typeof(kept_test_records) = 'array'),
  add column test_run_ids uuid[];
comment on column public.switchboard_run_requests.kept_test_records is
  'O18 (s35): on a pre-check that keeps its TEST records, one entry per run that kept some: {run_id, run_tag, count, sandbox, recorded_at, deleted_by}, deleted_by the delete page request''s id once its write passed, else null. Written only by switchboard_record_kept_test_records and switchboard_record_run_outcome; the run''s own result is pruned after 30 days, so this is the durable record.';
comment on column public.switchboard_run_requests.test_run_ids is
  'O24 (s35): on a delete_test_data request, the run ids of the pre-check''s kept sets it deletes, taken by switchboard_queue_run_request when it was queued (never from the chat); the outcome marks exactly those deleted.';
alter table public.switchboard_run_requests drop constraint switchboard_run_requests_page_check;
alter table public.switchboard_run_requests add constraint switchboard_run_requests_page_check
  check (page in ('precheck', 'dataop', 'undo', 'correction', 'check', 'delete_test_data'));
alter table public.switchboard_run_requests drop constraint switchboard_run_requests_base_page_check;
alter table public.switchboard_run_requests add constraint switchboard_run_requests_base_page_check
  check (base_page in ('precheck', 'dataop', 'undo', 'check', 'delete_test_data'));

-- ============================================================================
-- 1. switchboard_queue_run_request: 258's, with keep_test_records and the delete page.
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
  v_codes  text[];
  v_tp     public.switchboard_run_requests;
  v_sum    bigint;
  v_n_open integer;
  v_ids    uuid[];
  v_sbok   boolean;
  v_other  uuid;
begin
  if v_user is null then
    raise exception 'switchboard_queue_run_request: no signed-in user.' using errcode = '28000';
  end if;
  if jsonb_typeof(p_request) is distinct from 'object' then
    raise exception 'switchboard_queue_run_request: the request must be a JSON object. No link was issued.' using errcode = '23514';
  end if;
  if v_page is null or v_page not in ('precheck', 'dataop', 'undo', 'correction', 'check', 'delete_test_data') then
    raise exception 'switchboard_queue_run_request: add page: one of precheck, dataop, undo, correction, check, delete_test_data.' using errcode = '23514';
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
  -- s35 (O18, 17.1): keep_test_records, the value true only, on a pre-check with a rehearsal sandbox; its rehearsal
  -- ends with keep_test, never delete_test. keep_test without it is refused on any page. The step codes are read
  -- with ->>, which gives null for a step that is not an object, so a malformed step never errors here.
  -- (cold review) Nulls are removed, so a malformed step can't make the tests below null and skip a refusal.
  select array_remove(coalesce(array_agg(s->>'code'), '{}'), null) into v_codes from jsonb_array_elements(p_request->'steps') s;
  if p_request ? 'keep_test_records' then
    if v_page <> 'precheck' then
      raise exception 'switchboard_queue_run_request: only a pre-check keeps its TEST records (keep_test_records). No link was issued.' using errcode = '23514';
    end if;
    if (p_request->'keep_test_records') is distinct from 'true'::jsonb then
      raise exception 'switchboard_queue_run_request: keep_test_records is true, or left out. No link was issued.' using errcode = '23514';
    end if;
    if not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_request->'orgs') = 'array' then p_request->'orgs' else '[]'::jsonb end) o
                    where jsonb_typeof(o) = 'object' and (o->>'role') = 'rehearsal' and (o->>'org_type') = 'sandbox'
                      and coalesce(btrim(o->>'alias'), '') <> ''
                      -- (cold review) Never one of the request's other orgs under another name, as 252's rule for a
                      -- correction: a delete page later trusts this alias as a sandbox.
                      and not exists (select 1 from jsonb_array_elements(p_request->'orgs') q
                                       where q is distinct from o and (q->>'alias') = (o->>'alias'))) then
      raise exception 'switchboard_queue_run_request: keep_test_records needs the rehearsal sandbox (an org with role rehearsal, org_type sandbox): the TEST records are kept there. No link was issued.' using errcode = '23514';
    end if;
    if 'delete_test' = any(v_codes) or not ('keep_test' = any(v_codes)) then
      raise exception 'switchboard_queue_run_request: a pre-check that keeps its TEST records lists keep_test, not delete_test. No link was issued.' using errcode = '23514';
    end if;
  elsif 'keep_test' = any(v_codes) then
    raise exception 'switchboard_queue_run_request: keep_test needs keep_test_records true; otherwise the rehearsal lists delete_test. No link was issued.' using errcode = '23514';
  end if;
  -- s35 (O24): a delete page counts only what the pre-check kept (counts.expected); queue's total reads total first.
  if v_page = 'delete_test_data' and coalesce((p_request->'counts') ? 'total', false) then
    raise exception 'switchboard_queue_run_request: leave counts.total out: a delete page counts only what the pre-check kept (counts.expected). No link was issued.' using errcode = '23514';
  end if;
  v_total := case when v_page = 'undo' then coalesce(p_request->'counts'->'undo_up_to', p_request->'counts'->'expected')
                  else coalesce(p_request->'counts'->'total', p_request->'counts'->'expected') end;
  if v_page in ('dataop', 'undo', 'delete_test_data') and (jsonb_typeof(v_total) is distinct from 'number' or v_total::text !~ '^[0-9]{1,9}$') then
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
  -- s35 (O24, 17.2, 17.7): a delete page names the pre-check whose kept TEST records it deletes, test_data_of
  -- {request_id, run_tag}: the caller's own pre-check in the same project, agreeing on simulation and pretend, as
  -- undo_of.request_id is checked. Its count and sandbox are the database's, never the chat's: counts.expected must be
  -- every kept set not yet deleted, summed, and each set's sandbox its one org, a sandbox with role target. The run
  -- ids of those sets are kept in test_run_ids. A second delete page for the same pre-check waits while one runs.
  if p_request ? 'test_data_of' and v_page <> 'delete_test_data' then
    raise exception 'switchboard_queue_run_request: only a delete page names the pre-check whose TEST records it deletes (test_data_of). No link was issued.' using errcode = '23514';
  end if;
  if v_page = 'delete_test_data' then
    if (case when jsonb_typeof(p_request->'orgs') = 'array' then jsonb_array_length(p_request->'orgs') else 0 end) <> 1
       or jsonb_typeof(p_request->'orgs'->0) is distinct from 'object'
       or (p_request->'orgs'->0->>'org_type') is distinct from 'sandbox'
       or (p_request->'orgs'->0->>'role') is distinct from 'target'
       or coalesce(btrim(p_request->'orgs'->0->>'alias'), '') = '' then
      raise exception 'switchboard_queue_run_request: a delete page runs on one sandbox only: one org, org_type sandbox, role target. No link was issued.' using errcode = '23514';
    end if;
    if (p_request->'operation'->>'kind') is distinct from 'delete' then
      raise exception 'switchboard_queue_run_request: a delete page''s operation kind is delete. No link was issued.' using errcode = '23514';
    end if;
    if jsonb_typeof(p_request->'test_data_of') is distinct from 'object'
       or jsonb_typeof(p_request->'test_data_of'->'request_id') is distinct from 'string'
       or (p_request->'test_data_of'->>'request_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(p_request->'test_data_of'->'run_tag') is distinct from 'string'
       or coalesce(btrim(p_request->'test_data_of'->>'run_tag'), '') = '' then
      raise exception 'switchboard_queue_run_request: add test_data_of: {request_id, run_tag}, the pre-check whose kept TEST records this deletes, its id a lower-case uuid. No link was issued.' using errcode = '23514';
    end if;
    -- Same user: another user's request is not found. Locked, so no kept set is added while this one is counted.
    select * into v_tp from public.switchboard_run_requests
     where id = (p_request->'test_data_of'->>'request_id')::uuid and user_id = v_user for update;
    if not found then
      raise exception 'switchboard_queue_run_request: no such pre-check request (%) for test_data_of.request_id. No link was issued.', p_request->'test_data_of'->>'request_id'
        using errcode = 'P0002';
    end if;
    if v_tp.base_page <> 'precheck' then
      raise exception 'switchboard_queue_run_request: request % is not a pre-check (it is a %); test_data_of.request_id names the pre-check whose TEST records this deletes. No link was issued.', v_tp.id, v_tp.base_page
        using errcode = '23514';
    end if;
    if v_tp.project_code <> v_code then
      raise exception 'switchboard_queue_run_request: the pre-check is for project %, not %; a delete page cleans up after a pre-check in its own project. No link was issued.', v_tp.project_code, v_code
        using errcode = '23514';
    end if;
    if v_tp.simulation <> v_sim then
      raise exception 'switchboard_queue_run_request: a simulation and a real request never clean up after each other; the delete page and its pre-check must both be simulations, or neither. No link was issued.' using errcode = '23514';
    end if;
    if v_tp.pretend <> v_pretend then
      raise exception 'switchboard_queue_run_request: a pretend request and a plain simulation never clean up after each other; the delete page and its pre-check must both have pretend, or neither. No link was issued.' using errcode = '23514';
    end if;
    if (p_request->'test_data_of'->>'run_tag') is distinct from (v_tp.request->>'run_tag') then
      raise exception 'switchboard_queue_run_request: test_data_of.run_tag (%) is not the pre-check''s run tag (%). No link was issued.', p_request->'test_data_of'->>'run_tag', coalesce(v_tp.request->>'run_tag', 'none')
        using errcode = '23514';
    end if;
    -- 17.7 (answer 3): every kept set not yet deleted, whatever run tag it was kept under.
    select count(*), coalesce(sum((e->>'count')::bigint), 0)::bigint,
           coalesce(array_agg((e->>'run_id')::uuid order by (e->>'run_id')::uuid), '{}'::uuid[]),
           coalesce(bool_and(coalesce((e->>'sandbox') = (p_request->'orgs'->0->>'alias'), false)), true)
      into v_n_open, v_sum, v_ids, v_sbok
      from jsonb_array_elements(case when jsonb_typeof(v_tp.kept_test_records) = 'array' then v_tp.kept_test_records else '[]'::jsonb end) e
     where (e->>'deleted_by') is null;
    if v_n_open = 0 then
      raise exception 'switchboard_queue_run_request: the pre-check has no kept TEST records left to delete. No link was issued.' using errcode = '23514';
    end if;
    if v_total::text::bigint <> v_sum then
      raise exception 'switchboard_queue_run_request: counts.expected (%) is not the TEST records the pre-check kept and has not deleted (%, in % sets). No link was issued.', v_total, v_sum, v_n_open
        using errcode = '23514';
    end if;
    if not v_sbok then
      raise exception 'switchboard_queue_run_request: the TEST records were kept in another sandbox than this page''s org (%). No link was issued.', p_request->'orgs'->0->>'alias'
        using errcode = '23514';
    end if;
    select r.id into v_other
      from public.switchboard_run_requests r
      join public.switchboard_run_links l on l.request_id = r.id
      join public.switchboard_actions a on a.id = l.action_id
     where r.user_id = v_user and r.base_page = 'delete_test_data'
       and (r.request->'test_data_of'->>'request_id') = v_tp.id::text
       and a.status = 'consumed' and (a.picked_up_at is not null or a.created_at >= now() - interval '15 minutes')
     limit 1;
    if v_other is not null then
      raise exception 'switchboard_queue_run_request: another delete page (request %) is deleting this pre-check''s TEST records now; queue again once it ends. No link was issued.', v_other
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
  -- s35: a delete page keeps the run ids it deletes (test_run_ids), taken above from the database.
  insert into public.switchboard_run_requests (user_id, project_code, page, base_page, simulation, pretend, request, evidence, total_count, test_run_ids)
  values (v_user, v_code, v_page, v_page, v_sim, v_pretend,
          p_request - array['id', 'version', 'corrected_at', 'evidence', 'simulation'],
          v_copied,
          case when jsonb_typeof(v_total) = 'number' and v_total::text ~ '^[0-9]{1,9}$' then v_total::text::integer end,
          case when v_page = 'delete_test_data' then v_ids end)
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
  'Switchboard 3: queue a run request (spec 4.1) for the signed-in caller. Refuses, before any link, a request without page, project_code, the problem label and sentence, side_effects, headline or steps; one with a sample, evidence, base_steps or base_phases (252: only a correction keeps those); a correction (use switchboard_correct_run_request); and a data operation, undo or delete page without its count. A simulation (Q7) is accepted and flagged. Pretend (s26, s26b) is request.pretend = {scenario: "<name>"} (1 to 40 of a-z, 0-9, hyphen, underscore; nothing else), only with simulation; it is kept in the stored request and sets the pretend column. A pre-check may keep its TEST records (s35, O18): keep_test_records true only, with a rehearsal sandbox org, its steps listing keep_test and not delete_test; keep_test without it is refused on any page. An undo may name the data operation it undoes (undo_of.request_id, s27): a lower-case uuid naming the caller''s own request whose base page is dataop, in the same project, agreeing on simulation and on pretend; refused on any other page, and otherwise refused naming what is wrong. A check may name the data operation that was interrupted (interrupted.request_id, s31): checked as undo_of.request_id is, and the check''s operation object and kind, and field when the data operation has one, must be that data operation''s; refused on any other page, and with no operation. A delete page (s35, O24, page delete_test_data) runs on one org, a sandbox with role target, kind delete, and names its pre-check in test_data_of {request_id, run_tag}: the caller''s own pre-check request, same project, simulation and pretend matching, run tag its own; counts.expected (no counts.total) must be every kept set not yet deleted, summed, each kept in that sandbox; refused while another delete page for the same pre-check is approved and unfinished; the sets'' run ids are kept in test_run_ids; test_data_of on any other page is refused. A data operation may name its pre-check (pre_check_request_id, s12b): the caller''s own Pre-check and Rehearsal request in the same project, on its pre-check page, with passed checks including a rehearsal in use (s31), agreeing on simulation and on pretend (both or neither; scenario names may differ), whose object, operation, records or filter, count (the write''s count is the pre-check''s total, else expected; other counts equal), field, value, file, other operation details, sandbox filter, code commit and target org all match; its checks in use are copied with their original passed_at and copied_from, so the 24 hours count from the oldest; the pre-check''s sample row moves to the new request, expires_at unchanged (s12c). Refused, naming every mismatch, otherwise, and when that pre-check already backed an approved write. Returns {request_id, version, copied_checks, moved_sample}. Called by the queue_switchboard_run_request tool (B3).';
revoke all on function public.switchboard_queue_run_request(jsonb) from public, anon;
grant execute on function public.switchboard_queue_run_request(jsonb) to authenticated;

-- ============================================================================
-- 2. switchboard_consume_run_link: 256's, with the delete page's count, kept sets, sandbox and second page.
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
  v_tp      public.switchboard_run_requests;
  v_sum     bigint;
  v_ids     uuid[];
  v_sbok    boolean;
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
    if v_row.page in ('dataop', 'undo', 'delete_test_data') and p_count is distinct from v_row.total_count then
      raise exception 'switchboard_consume_run_link: the count approved (%) is not the request''s count (%). Nothing was approved.', p_count, v_row.total_count
        using errcode = '55000';
    end if;
    -- s35 (O24, 17.2): a delete page approves only while its one org is a sandbox target and the pre-check's kept sets
    -- not yet deleted are exactly the ones it was queued for, their sum its count. The pre-check is locked after this
    -- request and its link, as the outcome locks it; nothing locks a pre-check and then a delete page.
    if v_row.page = 'delete_test_data' then
      if (case when jsonb_typeof(v_row.request->'orgs') = 'array' then jsonb_array_length(v_row.request->'orgs') else 0 end) <> 1
         or (v_row.request->'orgs'->0->>'org_type') is distinct from 'sandbox'
         or (v_row.request->'orgs'->0->>'role') is distinct from 'target' then
        raise exception 'switchboard_consume_run_link: a delete page runs on one sandbox only, and this one names another org. Nothing was approved.' using errcode = '55000';
      end if;
      select * into v_tp from public.switchboard_run_requests
       where id = (v_row.request->'test_data_of'->>'request_id')::uuid and user_id = v_user for update;
      select coalesce(sum((e->>'count')::bigint), 0)::bigint,
             coalesce(array_agg((e->>'run_id')::uuid order by (e->>'run_id')::uuid), '{}'::uuid[]),
             coalesce(bool_and(coalesce((e->>'sandbox') = (v_row.request->'orgs'->0->>'alias'), false)), true)
        into v_sum, v_ids, v_sbok
        from jsonb_array_elements(case when jsonb_typeof(v_tp.kept_test_records) = 'array' then v_tp.kept_test_records else '[]'::jsonb end) e
       where (e->>'deleted_by') is null;
      if v_ids is distinct from (select coalesce(array_agg(x order by x), '{}'::uuid[]) from unnest(v_row.test_run_ids) x)
         or v_sum is distinct from v_row.total_count::bigint then
        raise exception 'switchboard_consume_run_link: the kept TEST records changed since this delete page was queued (% now, % on the page); queue a new delete page. Nothing was approved.', v_sum, v_row.total_count
          using errcode = '55000';
      end if;
      if not v_sbok then
        raise exception 'switchboard_consume_run_link: the TEST records were kept in another sandbox than this page''s org. Nothing was approved.' using errcode = '55000';
      end if;
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
  -- s35 (O24): a second delete page for the same pre-check waits while another is approved and unfinished. A backstop:
  -- both are in the pre-check's project, so the project lock above refuses it first.
  if p_mode = 'approve' and v_row.page = 'delete_test_data' then
    select r.id into v_other
      from public.switchboard_run_requests r
      join public.switchboard_run_links l on l.request_id = r.id
      join public.switchboard_actions a on a.id = l.action_id
     where r.user_id = v_user and r.id <> v_row.id and r.base_page = 'delete_test_data'
       and (r.request->'test_data_of'->>'request_id') = (v_row.request->'test_data_of'->>'request_id')
       and a.status = 'consumed' and (a.picked_up_at is not null or a.created_at >= now() - interval '15 minutes')
     limit 1;
    if v_other is not null then
      raise exception 'switchboard_consume_run_link: another delete page (request %) is deleting these TEST records now. Nothing was approved.', v_other
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
  'Switchboard 3: Approve (p_mode approve) or "Run the pre-check and rehearsal again" (rerun) on a run page. Approves only when the link is the caller''s, not voided and (approve) unused, no other link of the same request version was used, the request is at the link''s version with the fingerprint the page showed, no check is dated in the future, the checks are within 24 hours of the oldest in use, copied ones included (not for an undo; a delete''s undo before its deadline), a data operation has every pre-check check (count, login, automation, backup, rehearsal) passed and in use, p_count equals the request''s count (dataop, undo, and s35 a delete page), the code (if any) was rehearsed (rehearsal evidence carrying its commit) and reviewed at that commit, p_desktop says running with panel and helper up, no link or run is live for the project (Q10, under the same advisory lock as switchboard_issue_link), (s12b) the pre-check whose checks it copied backs no other approved write, and (s35, O24) a delete page''s one org is a sandbox target, its pre-check''s kept sets not yet deleted are exactly test_run_ids with their sum its count, kept in that sandbox, and no other delete page for that pre-check is approved and unfinished. Locks the request, then the link, then (a delete page) its pre-check. Rerun only on expired checks, not while the last rerun is approved and unfinished, and on a used link only when its run never started (s6b), which fails the stale action and frees the link. A correction page''s Approve (s12) is recorded like a rerun (rerun_at, rerun_action_id; refused while one is approved and unfinished), so the link stays unused and approves the write once the reruns pass. A plain simulation spends the link and creates nothing else (Q7). Otherwise inserts an sf_run with payload {link_id}, plus pretend: true for a pretend request (s26), which the guard stores consumed (248); a pretend action''s expired run is mode pretend. Returns {consumed, simulated, link_id, mode, action_id, as_rerun}, and pretend when an action was made (simulated is true for a pretend request). Called by switchboard-run-pages with Alex''s JWT.';
revoke all on function public.switchboard_consume_run_link(text, text, jsonb, integer, text) from public, anon;
grant execute on function public.switchboard_consume_run_link(text, text, jsonb, integer, text) to authenticated;

-- ============================================================================
-- 3. switchboard_retry_run: 256's, with the delete page's kept sets, sandbox and second page re-checked.
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
  v_tp      public.switchboard_run_requests;
  v_sum     bigint;
  v_ids     uuid[];
  v_sbok    boolean;
  v_other   uuid;
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
  -- s35 (O24, 17.2): a resend of a delete page re-checks what consume checked at the Approve: once its run is past
  -- its 15 minutes the project is free, so the pre-check may have run again and kept more, or another page deleted.
  if v_row.page = 'delete_test_data' then
    if (case when jsonb_typeof(v_row.request->'orgs') = 'array' then jsonb_array_length(v_row.request->'orgs') else 0 end) <> 1
       or (v_row.request->'orgs'->0->>'org_type') is distinct from 'sandbox'
       or (v_row.request->'orgs'->0->>'role') is distinct from 'target' then
      raise exception 'switchboard_retry_run: a delete page runs on one sandbox only, and this one names another org. Nothing was resent.' using errcode = '55000';
    end if;
    select * into v_tp from public.switchboard_run_requests
     where id = (v_row.request->'test_data_of'->>'request_id')::uuid and user_id = v_user for update;
    select coalesce(sum((e->>'count')::bigint), 0)::bigint,
           coalesce(array_agg((e->>'run_id')::uuid order by (e->>'run_id')::uuid), '{}'::uuid[]),
           coalesce(bool_and(coalesce((e->>'sandbox') = (v_row.request->'orgs'->0->>'alias'), false)), true)
      into v_sum, v_ids, v_sbok
      from jsonb_array_elements(case when jsonb_typeof(v_tp.kept_test_records) = 'array' then v_tp.kept_test_records else '[]'::jsonb end) e
     where (e->>'deleted_by') is null;
    if v_ids is distinct from (select coalesce(array_agg(x order by x), '{}'::uuid[]) from unnest(v_row.test_run_ids) x)
       or v_sum is distinct from v_row.total_count::bigint then
      raise exception 'switchboard_retry_run: the kept TEST records changed since this delete page was queued (% now, % on the page); queue a new delete page. Nothing was resent.', v_sum, v_row.total_count
        using errcode = '55000';
    end if;
    if not v_sbok then
      raise exception 'switchboard_retry_run: the TEST records were kept in another sandbox than this page''s org. Nothing was resent.' using errcode = '55000';
    end if;
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
  -- s35 (O24): nor while another delete page for the same pre-check is approved and unfinished (a backstop, as in consume).
  if v_row.page = 'delete_test_data' then
    select r.id into v_other
      from public.switchboard_run_requests r
      join public.switchboard_run_links l on l.request_id = r.id
      join public.switchboard_actions a on a.id = l.action_id
     where r.user_id = v_user and r.id <> v_row.id and r.base_page = 'delete_test_data'
       and (r.request->'test_data_of'->>'request_id') = (v_row.request->'test_data_of'->>'request_id')
       and a.status = 'consumed' and (a.picked_up_at is not null or a.created_at >= now() - interval '15 minutes')
     limit 1;
    if v_other is not null then
      raise exception 'switchboard_retry_run: another delete page (request %) is deleting these TEST records now. Nothing was resent.', v_other
        using errcode = '55000';
    end if;
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
  'Switchboard 3: "Try again: resend this run". Only when the newest sf_run for the link never started (failed expired_not_picked_up, or consumed, never picked up, over 15 minutes old), the request is unchanged, the checks are valid (not for an undo), (s35, O24) a delete page''s one org is a sandbox target, its pre-check''s kept sets not yet deleted are still exactly test_run_ids with their sum its count, kept in that sandbox, and no other delete page for that pre-check is approved and unfinished, the desktop is ready and nothing else is live for the project (Q10). Fails a still-consumed stale action (consumed -> failed, with its run, mode pretend for a pretend action, s26) in the same step, then inserts the same sf_run again with the same payload, pretend included, so the same link id (4.5 points 2, 3). Returns {resent, link_id, action_id, replaces}. Called by switchboard-run-pages with Alex''s JWT.';
revoke all on function public.switchboard_retry_run(text, text, jsonb) from public, anon;
grant execute on function public.switchboard_retry_run(text, text, jsonb) to authenticated;

-- ============================================================================
-- 4. switchboard_correct_run_request: 258's, with the delete page's wording-only rule and the keep_test rule.
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
  v_codes   text[];
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
  -- s35: a delete page writes too.
  if v_row.base_page in ('dataop', 'undo', 'delete_test_data') then
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
  -- s35 (O24): a delete page's count, sets and sandbox are the database's, taken when it was queued, and it reruns no
  -- check; so only its wording (and what diagnosis allows) changes here. test_data_of never changes: the diff below
  -- refuses it, as every key outside c_words.
  if v_row.base_page = 'delete_test_data' and p_edit_kind not in ('wording', 'allows') then
    raise exception 'switchboard_correct_run_request: a delete page changes only its wording, so a % edit is refused; queue a new delete page instead. No link was issued.', p_edit_kind
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
  -- s35 (O18, 17.1): the steps are the run's own (c_run), so a correction that reruns the rehearsal could swap
  -- keep_test back to delete_test; the rule is checked again on the corrected steps. keep_test_records itself never
  -- changes here: it is outside c_words and c_run, so the diff above refuses it. ->> gives null for a step that is
  -- not an object.
  select array_remove(coalesce(array_agg(s->>'code'), '{}'), null) into v_codes
    from jsonb_array_elements(case when jsonb_typeof(p_request->'steps') = 'array' then p_request->'steps' else '[]'::jsonb end) s;
  if coalesce((v_row.request->'keep_test_records') = 'true'::jsonb, false) and 'delete_test' = any(v_codes) then
    raise exception 'switchboard_correct_run_request: this pre-check keeps its TEST records, so its rehearsal lists keep_test, not delete_test. No link was issued.'
      using errcode = '23514';
  end if;
  if not coalesce((v_row.request->'keep_test_records') = 'true'::jsonb, false) and 'keep_test' = any(v_codes) then
    raise exception 'switchboard_correct_run_request: keep_test needs keep_test_records true, which this request does not have; its rehearsal lists delete_test. No link was issued.'
      using errcode = '23514';
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
  'Switchboard 3: correct a run request (part 5 "Corrected"). Refuses (254, Alex s17b) every correction of a data operation, undo or (s35) delete page, wording included, once an approved write on it has started or may still start (its link''s approved action was picked up, has a run other than expired_not_picked_up, or is consumed within its 15 minutes): a further change is a new request through diagnosis; a write that never started leaves it correctable, and a pre-check is unaffected. Refuses an object or operation edit (a new request through diagnosis), (s12c) any change to pre_check_request_id, (s31b) a field or value edit on a check page, whose operation stays the interrupted data operation''s (queue a new check instead), (s35, O24) any edit but wording and allows on a delete page (queue a new delete page), and (s35, O18) corrected steps listing delete_test on a request that keeps its TEST records, or keep_test on one that does not. Each kind changes only its own row of the correction table, besides the wording (headline, side effects, problem, what diagnosis allows: diagnosis_allows and, s27b, the structured allows) and, for a kind that reruns a check, the run''s own steps, phases, details, kept, run_tag and still_valid: value operation.value; file operation.file; field operation.field and undo; records selected_by (not its kind or sandbox filter), counts, operation.steps and undo; records_filter all of selected_by, counts, operation.steps and undo; sandbox_filter selected_by.sandbox_text and not_rehearsed; code the code. A kind that reruns the rehearsal may also add one role-rehearsal sandbox org to a request with none (252). Any other change is refused, naming the field (a key set to null counts as left out), so keep_test_records and test_data_of never change. A correction never changes simulation or pretend: simulation lives in its column, and (s26b) the stored request.pretend is kept as it was, whatever the corrected request sends. A wording or allowance edit voids nothing and keeps the version and the page. Any other edit raises the version by one, makes it a correction page, keeps the request''s own steps and phases as base_steps and base_phases (252; restored by switchboard_record_run_evidence on return), voids the evidence its kind reruns (field: rehearsal, login, backup, sample; Alex s8b) and the request''s live links, and for a code edit marks older reviews superseded, in one transaction. Returns {request_id, version, voided_checks, voided_links}.';
revoke all on function public.switchboard_correct_run_request(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function public.switchboard_correct_run_request(uuid, text, jsonb, jsonb) to authenticated;

-- ============================================================================
-- 5. switchboard_record_run_outcome: 258's, with the delete page's outcome marking its kept sets deleted.
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
  if v_row.base_page not in ('dataop', 'undo', 'check', 'delete_test_data') then
    raise exception 'switchboard_record_run_outcome: run % is a % run; only a data operation, undo or check has an outcome, and a delete page. Nothing was recorded.', p_run_id, v_row.base_page
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
  -- s35 (O24, 17.7 answer 5): a delete page's run that passed (ok true, pass true: every record found was deleted and
  -- confirmed gone) marks the pre-check's kept sets it was queued for (test_run_ids) deleted, by this request's id. The
  -- pre-check is locked after this request and its link, as consume locks it. A failed run marks nothing.
  if v_row.base_page = 'delete_test_data'
     and (v_run.result->'ok') = 'true'::jsonb and (v_run.result->'pass') = 'true'::jsonb then
    update public.switchboard_run_requests p
       set kept_test_records = (select coalesce(jsonb_agg(case when (t.e->>'run_id')::uuid = any(v_row.test_run_ids) and (t.e->>'deleted_by') is null
                                                               then t.e || jsonb_build_object('deleted_by', v_row.id::text) else t.e end
                                                          order by t.ord), '[]'::jsonb)
                                  from jsonb_array_elements(p.kept_test_records) with ordinality t(e, ord)),
           updated_at = now()
     where p.id = (v_row.request->'test_data_of'->>'request_id')::uuid and p.user_id = v_row.user_id
       and jsonb_typeof(p.kept_test_records) = 'array';
  end if;
  return jsonb_build_object('recorded', true, 'already', false, 'request_id', v_row.id);
end;
$$;
comment on function public.switchboard_record_run_outcome(uuid, jsonb) is
  'Switchboard 3: keep a data operation''s, undo''s, (s31) check''s or (s35) delete page''s outcome on its request (outcome, outcome_run_id, outcome_recorded_at), since the run''s own result is pruned after 30 days. Accepted only for a finished real run of the sf_run action its link approved (link.action_id), on a request whose base page is dataop, undo, check or delete_test_data, not a plain simulation; or (s26) a finished pretend run on a pretend request, whose outcome is made up; a pretend run on a real request and a real run on a pretend one are refused. p_outcome is a JSON object of at most 64 KB, stored as given; on a check (item e) it is exactly {check: {job, at_goal, at_backup, neither}}, job one of Queued, Preparing, Processing, Holding, InProgress, Completed, Failed, Aborted or none, each count a whole number of 0 or more, checked before the once-per-run return. A delete page''s outcome is shape-free, as a data operation''s; when its run''s result has ok true and pass true, the pre-check''s kept sets named in test_run_ids get deleted_by (this request''s id), in the same transaction. A pre-check''s run, a rerun, an unfinished run and a run that never started are refused. Once per run: the same run again returns already true. A later run of the same link (a resend) replaces it; a run approved through another link of the request never does. Never touches evidence, the 24-hour clock or what can be approved. Returns {recorded, already, request_id}. Service role only: called by switchboard-runner after a write''s or check''s result.';
revoke all on function public.switchboard_record_run_outcome(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.switchboard_record_run_outcome(uuid, jsonb) to service_role;

-- ============================================================================
-- 6. switchboard_run_preview: 255's, with the pre-check's kept sets and the run's own kept_test_records.
-- ============================================================================
create or replace function public.switchboard_run_preview(p_token text)
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
  v_action  public.switchboard_actions;
  v_run     public.switchboard_runs;
  v_sample  public.switchboard_run_samples;
  v_review  public.switchboard_code_reviews;
  v_started boolean;
  v_mine    boolean;
begin
  if v_user is null then
    raise exception 'switchboard_run_preview: no signed-in user.' using errcode = '28000';
  end if;
  select * into v_link from public.switchboard_run_links
   where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') and user_id = v_user;
  if not found then
    raise exception 'switchboard_run_preview: no such link.' using errcode = 'P0002';
  end if;
  select * into v_row from public.switchboard_run_requests where id = v_link.request_id;
  select min((e->>'passed_at')::timestamptz) + interval '24 hours' into v_until
    from jsonb_array_elements(v_row.evidence) e
   where e ? 'passed_at' and coalesce((e->>'voided')::boolean, false) = false;

  -- The newest action for this link id: a resend or a rerun keeps the link id, and the newest one is the state.
  select * into v_action from public.switchboard_actions
   where user_id = v_user and kind = 'sf_run' and payload->>'link_id' = v_link.id::text
   order by created_at desc, id desc limit 1;
  if v_action.id is not null then
    select * into v_run from public.switchboard_runs where action_id = v_action.id order by started_at desc limit 1;
  end if;
  -- Not started (4.5): failed as expired_not_picked_up, or still consumed, never picked up, over 15 minutes old.
  v_started := v_action.id is not null
    and not (coalesce(v_run.failure_reason = 'expired_not_picked_up', false)
             or (v_action.status = 'consumed' and v_action.picked_up_at is null and v_action.created_at < now() - interval '15 minutes'));

  -- The sample: deleted by this read once past expires_at (part 7).
  select * into v_sample from public.switchboard_run_samples where request_id = v_row.id;
  if v_sample.id is not null and v_sample.expires_at <= now() then
    delete from public.switchboard_run_samples where id = v_sample.id;
    v_sample := null;
  end if;
  if v_link.review_id is not null then
    select * into v_review from public.switchboard_code_reviews where id = v_link.review_id;
  end if;
  -- 254: the outcome is shown only on the link whose approved run recorded it, never on a later link of the request.
  v_mine := v_row.outcome_run_id is not null and exists (
    select 1 from public.switchboard_runs r where r.id = v_row.outcome_run_id and r.action_id = v_link.action_id);

  return jsonb_build_object(
    'link_id', v_link.id,
    -- s35 (O18): a pre-check's kept sets (the column), only when it has some, so no other request's preview changes.
    'request', v_row.request || jsonb_build_object('id', v_row.id, 'page', v_row.page, 'base_page', v_row.base_page, 'version', v_row.version,
                                                   'corrected_at', v_row.corrected_at, 'evidence', v_row.evidence,
                                                   'simulation', v_row.simulation, 'rerun_at', v_link.rerun_at)
               || case when v_row.kept_test_records is not null then jsonb_build_object('kept_test_records', v_row.kept_test_records) else '{}'::jsonb end,
    'fingerprint', public.switchboard_fingerprint(v_row.request || jsonb_build_object('version', v_row.version)),
    -- The count switchboard_consume_run_link checks; the page sends exactly this with Approve.
    'total_count', v_row.total_count,
    -- 254: the write's outcome, once this link's run recorded one.
    'outcome', case when v_mine then v_row.outcome end,
    'outcome_run_id', case when v_mine then v_row.outcome_run_id end,
    'outcome_recorded_at', case when v_mine then v_row.outcome_recorded_at end,
    'link', jsonb_build_object('version', v_link.request_version, 'current', v_link.request_version = v_row.version,
                               'used_at', v_link.used_at, 'rerun_at', v_link.rerun_at,
                               'voided_at', v_link.voided_at, 'void_reason', v_link.void_reason),
    'valid_until', v_until,
    'expired', v_row.page <> 'undo' and v_until is not null and v_until <= now(),
    'run', case when v_action.id is null then null else jsonb_build_object(
             'action_id', v_action.id, 'status', v_action.status, 'consumed_at', v_action.created_at,
             'picked_up_at', v_action.picked_up_at, 'finished_at', v_run.finished_at,
             'failure_reason', v_run.failure_reason, 'not_started', not v_started,
             'rerun', v_action.id = v_link.rerun_action_id,
             -- s21b: how the run ended. Null once switchboard_prune_runs clears result; summary is kept.
             'ok', case when jsonb_typeof(v_run.result->'ok') = 'boolean' then (v_run.result->>'ok')::boolean end,
             'pass', case when jsonb_typeof(v_run.result->'pass') = 'boolean' then (v_run.result->>'pass')::boolean end,
             'summary', left(v_run.summary, 500))
             -- s35 (O18): the run's own kept_test_records, only when its result carries an object.
             || case when jsonb_typeof(v_run.result->'kept_test_records') = 'object'
                     then jsonb_build_object('kept_test_records', v_run.result->'kept_test_records') else '{}'::jsonb end end,
    'sample', case when v_sample.id is null then null else v_sample.sample end,
    'review', case when v_review.id is null then null else
               v_review.review || jsonb_build_object('id', v_review.id, 'commit', v_review.commit, 'status', v_review.status,
                                                     'superseded_by', v_review.superseded_by, 'acknowledged', v_review.acks) end);
end;
$$;
comment on function public.switchboard_run_preview(text) is
  'Switchboard 3: what a run or review page shows for its token, read at page open and at a click. Returns {link_id, request (with id, page, version, corrected_at, evidence, simulation, rerun_at, and from s35 kept_test_records when the request has kept sets), fingerprint, total_count (the request''s count, which switchboard_consume_run_link checks and the page sends with Approve; null when the request has none), outcome, outcome_run_id, outcome_recorded_at (254: the write''s outcome, null until recorded and on any link but the one whose approved run recorded it), link {version, current, used_at, rerun_at, voided_at, void_reason}, valid_until, expired (never for an undo), run (the newest sf_run for this link id: status, consumed_at, picked_up_at, finished_at, failure_reason, not_started, rerun, and from s21b ok and pass (result.ok and result.pass when booleans, null once the result is pruned) and summary (its first 500 characters), and from s35 kept_test_records when the result carries one), sample, review}. Deletes the sample when it is past expires_at. Called by switchboard-run-pages with Alex''s JWT.';
revoke all on function public.switchboard_run_preview(text) from public, anon;
grant execute on function public.switchboard_run_preview(text) to authenticated;

-- ============================================================================
-- 7. switchboard_record_kept_test_records: new (O18, 17.1, 17.7).
-- ============================================================================
create function public.switchboard_record_kept_test_records(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run    public.switchboard_runs;
  v_action public.switchboard_actions;
  v_linkid uuid;
  v_link   public.switchboard_run_links;
  v_row    public.switchboard_run_requests;
  v_kept   jsonb;
  v_list   jsonb;
begin
  select * into v_run from public.switchboard_runs where id = p_run_id;
  if not found then
    raise exception 'switchboard_record_kept_test_records: no such run.' using errcode = 'P0002';
  end if;
  select * into v_action from public.switchboard_actions where id = v_run.action_id and user_id = v_run.user_id;
  if v_action.id is null or v_action.kind <> 'sf_run' then
    raise exception 'switchboard_record_kept_test_records: that run is not a run page''s (sf_run) run.' using errcode = '23514';
  end if;
  if v_run.mode not in ('real', 'pretend') or v_run.finished_at is null then
    raise exception 'switchboard_record_kept_test_records: the run has not finished.' using errcode = '55000';
  end if;
  -- 17.7 (answer 1): kept on a pass, and on a FAIL at the rehearsal (item b's failed_check rehearsal); never ok false.
  if coalesce((v_run.result->'ok') = 'true'::jsonb, false) is not true
     or not coalesce((v_run.result->'pass') = 'true'::jsonb
                     or ((v_run.result->'pass') = 'false'::jsonb and (v_run.result->'failed_check') = '"rehearsal"'::jsonb), false) then
    raise exception 'switchboard_record_kept_test_records: TEST records are kept only on a pass, or a FAIL at the rehearsal (ok true, pass false, failed_check rehearsal); nothing is recorded.'
      using errcode = '55000';
  end if;
  -- Exactly {count, sandbox}: count 1 to 999,999,999, sandbox a name. The case guards the key removal on a scalar.
  v_kept := v_run.result->'kept_test_records';
  if not coalesce(case when jsonb_typeof(v_kept) = 'object'
                       then (v_kept - array['count', 'sandbox']) = '{}'::jsonb
                            and jsonb_typeof(v_kept->'count') = 'number' and (v_kept->'count')::text ~ '^[1-9][0-9]{0,8}$'
                            and jsonb_typeof(v_kept->'sandbox') = 'string' and coalesce(btrim(v_kept->>'sandbox'), '') <> ''
                       else false end, false) then
    raise exception 'switchboard_record_kept_test_records: the run''s kept_test_records is exactly {"count", "sandbox"}: count a whole number from 1 to 999,999,999, sandbox the rehearsal sandbox''s alias. Nothing is recorded.'
      using errcode = '23514';
  end if;

  -- The link and its request, locked request first, as the link functions do.
  v_linkid := (v_action.payload->>'link_id')::uuid;
  select * into v_link from public.switchboard_run_links where id = v_linkid and user_id = v_run.user_id;
  if v_link.id is null then
    raise exception 'switchboard_record_kept_test_records: no link for that run.' using errcode = 'P0002';
  end if;
  select * into v_row from public.switchboard_run_requests where id = v_link.request_id for update;
  select * into v_link from public.switchboard_run_links where id = v_linkid for update;
  if v_row.simulation and not v_row.pretend then
    raise exception 'switchboard_record_kept_test_records: a simulation keeps no TEST records.' using errcode = '55000';
  end if;
  if (v_run.mode = 'pretend') <> v_row.pretend then
    raise exception 'switchboard_record_kept_test_records: a pretend run records only on a pretend request, and a pretend request only from a pretend run; nothing is recorded.' using errcode = '55000';
  end if;
  -- The run must be the link's pre-check, by evidence's rule (its approval on a pre-check page or a pre-check's
  -- correction, or its rerun), on a request whose base page is precheck. Unlike evidence, a voided link, an older
  -- version or a run finished before a correction still records: the records are in the sandbox either way.
  if v_row.base_page <> 'precheck'
     or not (v_action.id = v_link.rerun_action_id
             or (v_action.id = v_link.action_id and v_row.page in ('precheck', 'correction'))) then
    raise exception 'switchboard_record_kept_test_records: that run is not a pre-check''s run or rerun.' using errcode = '55000';
  end if;
  if coalesce((v_row.request->'keep_test_records') = 'true'::jsonb, false) is not true then
    raise exception 'switchboard_record_kept_test_records: the request does not keep its TEST records (keep_test_records); nothing is recorded.' using errcode = '55000';
  end if;
  if not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v_row.request->'orgs') = 'array' then v_row.request->'orgs' else '[]'::jsonb end) o
                  where jsonb_typeof(o) = 'object' and (o->>'role') = 'rehearsal' and (o->>'org_type') = 'sandbox'
                    and (o->>'alias') = (v_kept->>'sandbox')) then
    raise exception 'switchboard_record_kept_test_records: the TEST records were kept in %, which is not the request''s rehearsal sandbox. Nothing is recorded.', v_kept->>'sandbox'
      using errcode = '23514';
  end if;
  v_list := case when jsonb_typeof(v_row.kept_test_records) = 'array' then v_row.kept_test_records else '[]'::jsonb end;
  if exists (select 1 from jsonb_array_elements(v_list) e where (e->>'run_id') = v_run.id::text) then
    return jsonb_build_object('recorded', false, 'already', true, 'request_id', v_row.id,
                              'kept', (select coalesce(sum((e->>'count')::bigint), 0) from jsonb_array_elements(v_list) e where (e->>'deleted_by') is null));
  end if;
  v_list := v_list || jsonb_build_array(jsonb_build_object(
              'run_id', v_run.id::text, 'run_tag', v_row.request->>'run_tag', 'count', v_kept->'count',
              'sandbox', v_kept->>'sandbox', 'recorded_at', now(), 'deleted_by', null));
  update public.switchboard_run_requests set kept_test_records = v_list, updated_at = now() where id = v_row.id;
  return jsonb_build_object('recorded', true, 'already', false, 'request_id', v_row.id,
                            'kept', (select coalesce(sum((e->>'count')::bigint), 0) from jsonb_array_elements(v_list) e where (e->>'deleted_by') is null));
end;
$$;
comment on function public.switchboard_record_kept_test_records(uuid) is
  'Switchboard 3 (s35, O18): record the TEST records a finished pre-check run kept in its rehearsal sandbox, from that run''s own switchboard_runs row only: result {ok: true, pass: true, or pass: false with failed_check "rehearsal", kept_test_records: {count, sandbox}}, count 1 to 999,999,999, sandbox the request''s rehearsal org. Appends {run_id, run_tag, count, sandbox, recorded_at, deleted_by: null} to the request''s kept_test_records, once per run (a repeat returns already true). Refused for ok false or any other FAIL, a malformed kept_test_records, another sandbox, a request without keep_test_records true, a run that is not the link''s pre-check or rerun on a base-page precheck request, a plain simulation, and a pretend/real mismatch. Unlike switchboard_record_run_evidence it records on a voided link, an older version and a run finished before a correction: the records are in the sandbox either way. Returns {recorded, already, request_id, kept}, kept the TEST records not yet deleted. Service role only: called by switchboard-runner, before the evidence, after a pre-check''s result.';
revoke all on function public.switchboard_record_kept_test_records(uuid) from public, anon, authenticated;
grant execute on function public.switchboard_record_kept_test_records(uuid) to service_role;

-- ============================================================================
-- 8. Smoke check: calls each changed function past every changed line, then undoes everything.
-- ============================================================================
-- The lesson of 256: PL/pgSQL plans an expression only the first time it reaches it, so a migration can apply cleanly
-- and every later call fail. Each call below reaches the lines this migration changed (named in its comment); a
-- refusal is caught only by its SQLSTATE and words, and anything else (another error, or no error where a refusal is
-- due) stops the migration and so its dry run, before Approve. It runs as Alex (the page functions read auth.uid()
-- from the JWT claims; outcome and the new function read the run's user_id), on real requests in smoke-s2b projects
-- that it makes, links, approves and runs by hand (no pickup), and undoes by raising a sentinel caught by name.
-- Three refusal bodies are not raised, only their conditions evaluated (named where they are): the new function's
-- not-sf_run, no-link and plain-simulation refusals, and the second-delete-page refusal in consume and retry, which the
-- project lock (Q10) always refuses first; test 10 names the same.
do $$
declare
  c_alex   constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_ready  constant jsonb := '{"answer": "running", "panel": true, "helper": true}';
  c_prod   constant jsonb := '{"alias": "smoke-prod", "org_type": "production", "role": "target"}';
  c_sb     constant jsonb := '{"alias": "smoke-sb", "org_type": "sandbox", "role": "rehearsal"}';
  c_sbt    constant jsonb := '{"alias": "smoke-sb", "org_type": "sandbox", "role": "target"}';
  c_why    constant jsonb := '{"reason": "A smoke check.", "items": [{"what": "Value", "old": "X", "new": "Y"}]}';
  c_tag    constant text  := 'smoke-s2b-a-s1-ab12';
  v_keep   jsonb;
  v_dbase  jsonb;
  v_out    jsonb;
  v_tok    text;
  v_tokd   text;
  v_p      jsonb;
  v_pre    uuid;
  v_dop    uuid;
  v_psim   uuid;
  v_plain  uuid;
  v_del    uuid;
  v_del2   uuid;
  v_act    uuid;
  v_act2   uuid;
  v_act3   uuid;
  v_run    uuid;
  v_msg    text;
  v_state  text;
  v_calls  integer := 0;
begin
  begin
    perform set_config('request.jwt.claim.sub', c_alex::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', c_alex, 'role', 'authenticated')::text, true);
    v_keep := jsonb_build_object(
      'page', 'precheck', 'headline', 'SMOKE CHECK: SLICE 2B', 'project_code', 'smoke-s2b-a', 'run_tag', c_tag, 'simulation', false,
      'problem', jsonb_build_object('label', 'P1', 'sentence', 'A smoke check.'),
      'side_effects', 'None, a smoke check.', 'orgs', jsonb_build_array(c_prod, c_sb),
      'operation', jsonb_build_object('kind', 'update', 'object', 'Gift__c', 'field', 'Campaign__c', 'value', 'X'),
      'selected_by', jsonb_build_object('kind', 'ids', 'text', '45 ids'),
      'counts', jsonb_build_object('expected', 45, 'total', 45),
      'keep_test_records', true, 'steps', '[{"code": "create_test"}, {"code": "keep_test"}]'::jsonb);

    -- ---- 8a. queue (O18): the page list, v_codes, and each keep_test_records rule ----
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_keep || '{"page": "nope"}'::jsonb); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%one of precheck, dataop, undo, correction, check, delete_test_data%' then
      raise exception 'smoke check: queue, the page list (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_keep || '{"page": "dataop"}'::jsonb); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%only a pre-check keeps its TEST records%' then
      raise exception 'smoke check: queue, keep_test_records off a pre-check (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_keep || '{"keep_test_records": false}'::jsonb); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%keep_test_records is true, or left out%' then
      raise exception 'smoke check: queue, keep_test_records false (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_keep || jsonb_build_object('orgs', jsonb_build_array(c_prod))); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%keep_test_records needs the rehearsal sandbox%' then
      raise exception 'smoke check: queue, keep_test_records with no rehearsal sandbox (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_keep || '{"steps": [{"code": "create_test"}, {"code": "delete_test"}]}'::jsonb); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%lists keep_test, not delete_test%' then
      raise exception 'smoke check: queue, keep_test_records with delete_test (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_keep - 'keep_test_records'); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%keep_test needs keep_test_records true%' then
      raise exception 'smoke check: queue, keep_test without keep_test_records (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    -- Accepted: through every keep_test_records line, and the insert's test_run_ids (null off a delete page).
    v_pre := (public.switchboard_queue_run_request(v_keep)->>'request_id')::uuid;
    if (select test_run_ids is not null or kept_test_records is not null from public.switchboard_run_requests where id = v_pre) then
      raise exception 'smoke check: queue, a pre-check got test_run_ids or kept_test_records';
    end if;
    v_dop := (public.switchboard_queue_run_request((v_keep - 'keep_test_records') || '{"page": "dataop", "steps": [{"code": "write"}]}'::jsonb)->>'request_id')::uuid;
    v_psim := (public.switchboard_queue_run_request(v_keep || '{"project_code": "smoke-s2b-b", "run_tag": "smoke-s2b-b-s1-ab12", "simulation": true}'::jsonb)->>'request_id')::uuid;
    v_plain := (public.switchboard_queue_run_request((v_keep - 'keep_test_records') || '{"project_code": "smoke-s2b-c", "steps": [{"code": "create_test"}, {"code": "delete_test"}]}'::jsonb)->>'request_id')::uuid;
    v_calls := v_calls + 10;

    -- ---- 8b. queue (O24): the delete page's count, test_data_of and each of its rules ----
    v_dbase := jsonb_build_object(
      'page', 'delete_test_data', 'headline', 'SMOKE CHECK: DELETE TEST DATA', 'project_code', 'smoke-s2b-a', 'run_tag', 'smoke-s2b-a-s2-cd34',
      'simulation', false, 'problem', jsonb_build_object('label', 'P1', 'sentence', 'A smoke check.'),
      'side_effects', 'None, a smoke check.', 'orgs', jsonb_build_array(c_sbt),
      'operation', '{"kind": "delete", "object": "Gift__c", "object_label": "Gift"}'::jsonb,
      'counts', '{"expected": 7}'::jsonb, 'test_data_of', jsonb_build_object('request_id', v_pre, 'run_tag', c_tag),
      'steps', '[{"code": "find_kept_test"}, {"code": "type_count"}, {"code": "delete_kept_test"}, {"code": "confirm_gone"}]'::jsonb);
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_dbase || '{"counts": {"expected": 7, "total": 7}}'::jsonb); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%leave counts.total out%' then
      raise exception 'smoke check: queue, counts.total on a delete page (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_dbase - 'counts'); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%add counts.total (or expected%' then
      raise exception 'smoke check: queue, a delete page with no count (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_keep || jsonb_build_object('test_data_of', v_dbase->'test_data_of')); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%only a delete page names the pre-check%' then
      raise exception 'smoke check: queue, test_data_of off a delete page (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_dbase || jsonb_build_object('orgs', jsonb_build_array(c_sbt, c_prod))); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%a delete page runs on one sandbox only%' then
      raise exception 'smoke check: queue, a delete page with a production org (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_dbase || '{"operation": {"kind": "update", "object": "Gift__c"}}'::jsonb); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%operation kind is delete%' then
      raise exception 'smoke check: queue, a delete page that updates (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(jsonb_set(v_dbase, '{test_data_of,request_id}', to_jsonb(upper(v_pre::text)))); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%add test_data_of: {request_id, run_tag}%' then
      raise exception 'smoke check: queue, an upper-case test_data_of.request_id (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(jsonb_set(v_dbase, '{test_data_of,request_id}', to_jsonb(gen_random_uuid()::text))); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from 'P0002' or v_msg not like '%for test_data_of.request_id%' then
      raise exception 'smoke check: queue, an unknown test_data_of.request_id (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(jsonb_set(v_dbase, '{test_data_of,request_id}', to_jsonb(v_dop::text))); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%names the pre-check whose TEST records this deletes%' then
      raise exception 'smoke check: queue, test_data_of naming a data operation (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_dbase || '{"project_code": "smoke-s2b-b"}'::jsonb); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%cleans up after a pre-check in its own project%' then
      raise exception 'smoke check: queue, a delete page in another project (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_dbase || '{"simulation": true}'::jsonb); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%the delete page and its pre-check must both be simulations%' then
      raise exception 'smoke check: queue, a simulated delete page on a real pre-check (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_dbase || jsonb_build_object('project_code', 'smoke-s2b-b', 'simulation', true, 'pretend', '{"scenario": "smoke"}'::jsonb,
                    'test_data_of', jsonb_build_object('request_id', v_psim, 'run_tag', 'smoke-s2b-b-s1-ab12')));
    exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%the delete page and its pre-check must both have pretend%' then
      raise exception 'smoke check: queue, a pretend delete page on a plain simulation (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(jsonb_set(v_dbase, '{test_data_of,run_tag}', '"smoke-s2b-a-s9-zz99"')); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%is not the pre-check''s run tag%' then
      raise exception 'smoke check: queue, another run tag (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    -- Nothing kept yet: through the sum query (no rows) to the refusal.
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_dbase); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%no kept TEST records left to delete%' then
      raise exception 'smoke check: queue, a delete page with nothing kept (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_calls := v_calls + 13;

    -- ---- 8c. switchboard_record_kept_test_records (new), and the preview's two new keys ----
    v_tok := substring(public.switchboard_issue_run_link(v_pre)->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_act := (public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, null)->>'action_id')::uuid;
    if v_act is null then raise exception 'smoke check: consume made no action for the keeping pre-check'; end if;
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_act;
    v_msg := null; v_state := null;
    begin perform public.switchboard_record_kept_test_records(gen_random_uuid()); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from 'P0002' or v_msg not like '%no such run%' then
      raise exception 'smoke check: kept, an unknown run (got %: %)', v_state, coalesce(v_msg, 'recorded');
    end if;
    -- Unfinished: through the action and sf_run test (its refusal not raised) to the finished test.
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result) values (c_alex, v_act, 'real', 'smoke check', '{"ok": true}')
    returning id into v_run;
    v_msg := null; v_state := null;
    begin perform public.switchboard_record_kept_test_records(v_run); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '55000' or v_msg not like '%the run has not finished%' then
      raise exception 'smoke check: kept, an unfinished run (got %: %)', v_state, coalesce(v_msg, 'recorded');
    end if;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'smoke check', '{"ok": false, "kept_test_records": {"count": 4, "sandbox": "smoke-sb"}}', now()) returning id into v_run;
    v_msg := null; v_state := null;
    begin perform public.switchboard_record_kept_test_records(v_run); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '55000' or v_msg not like '%TEST records are kept only on a pass%' then
      raise exception 'smoke check: kept, ok false (got %: %)', v_state, coalesce(v_msg, 'recorded');
    end if;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'smoke check', '{"ok": true, "pass": false, "kept_test_records": {"count": 4, "sandbox": "smoke-sb"}}', now()) returning id into v_run;
    v_msg := null; v_state := null;
    begin perform public.switchboard_record_kept_test_records(v_run); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '55000' or v_msg not like '%TEST records are kept only on a pass%' then
      raise exception 'smoke check: kept, a FAIL not at the rehearsal (got %: %)', v_state, coalesce(v_msg, 'recorded');
    end if;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'smoke check', '{"ok": true, "pass": true, "kept_test_records": {"count": 0, "sandbox": "smoke-sb"}}', now()) returning id into v_run;
    v_msg := null; v_state := null;
    begin perform public.switchboard_record_kept_test_records(v_run); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%is exactly {"count", "sandbox"}%' then
      raise exception 'smoke check: kept, a count of 0 (got %: %)', v_state, coalesce(v_msg, 'recorded');
    end if;
    -- A pretend run on a real request: through the link, the locks and the simulation test (its refusal not raised).
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'pretend', 'smoke check', '{"ok": true, "pass": true, "kept_test_records": {"count": 4, "sandbox": "smoke-sb"}}', now()) returning id into v_run;
    v_msg := null; v_state := null;
    begin perform public.switchboard_record_kept_test_records(v_run); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '55000' or v_msg not like '%a pretend run records only on a pretend request%' then
      raise exception 'smoke check: kept, a pretend run on a real request (got %: %)', v_state, coalesce(v_msg, 'recorded');
    end if;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'smoke check', '{"ok": true, "pass": true, "kept_test_records": {"count": 4, "sandbox": "smoke-other"}}', now()) returning id into v_run;
    v_msg := null; v_state := null;
    begin perform public.switchboard_record_kept_test_records(v_run); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%which is not the request''s rehearsal sandbox%' then
      raise exception 'smoke check: kept, another sandbox (got %: %)', v_state, coalesce(v_msg, 'recorded');
    end if;
    -- A pass, recorded; the same run again, already; a FAIL at the rehearsal, a second set (newest, for the preview).
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'smoke check', '{"ok": true, "pass": true, "kept_test_records": {"count": 4, "sandbox": "smoke-sb"}}', now()) returning id into v_run;
    v_out := public.switchboard_record_kept_test_records(v_run);
    if (v_out->>'recorded')::boolean is not true or (v_out->>'kept')::integer is distinct from 4 then
      raise exception 'smoke check: kept, a pass was not recorded (got %)', v_out;
    end if;
    v_out := public.switchboard_record_kept_test_records(v_run);
    if (v_out->>'already')::boolean is not true or (v_out->>'kept')::integer is distinct from 4 then
      raise exception 'smoke check: kept, a repeat was not already (got %)', v_out;
    end if;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, started_at, finished_at)
    values (c_alex, v_act, 'real', 'smoke check', '{"ok": true, "pass": false, "failed_check": "rehearsal", "checks": [{"check": "count", "org": "production"}], "kept_test_records": {"count": 3, "sandbox": "smoke-sb"}}',
            now() + interval '1 minute', now() + interval '1 minute') returning id into v_run;
    v_out := public.switchboard_record_kept_test_records(v_run);
    if (v_out->>'recorded')::boolean is not true or (v_out->>'kept')::integer is distinct from 7 then
      raise exception 'smoke check: kept, a FAIL at the rehearsal was not recorded as a second set (got %)', v_out;
    end if;
    -- The preview: the request's kept sets (the new request key) and the newest run's kept_test_records (the run key).
    v_p := public.switchboard_run_preview(v_tok);
    if jsonb_array_length(v_p->'request'->'kept_test_records') is distinct from 2
       or (v_p->'run'->'kept_test_records') is distinct from '{"count": 3, "sandbox": "smoke-sb"}'::jsonb then
      raise exception 'smoke check: preview, the kept sets or the run''s kept_test_records (got %, %)', v_p->'request'->'kept_test_records', v_p->'run'->'kept_test_records';
    end if;
    -- A pre-check that keeps nothing: through the pre-check test to the keep_test_records refusal.
    v_tokd := substring(public.switchboard_issue_run_link(v_plain)->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tokd);
    v_act2 := (public.switchboard_consume_run_link(v_tokd, v_p->>'fingerprint', c_ready, null)->>'action_id')::uuid;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act2, 'real', 'smoke check', '{"ok": true, "pass": true, "kept_test_records": {"count": 4, "sandbox": "smoke-sb"}}', now()) returning id into v_run;
    v_msg := null; v_state := null;
    begin perform public.switchboard_record_kept_test_records(v_run); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '55000' or v_msg not like '%the request does not keep its TEST records%' then
      raise exception 'smoke check: kept, a pre-check that keeps nothing (got %: %)', v_state, coalesce(v_msg, 'recorded');
    end if;
    v_calls := v_calls + 12;

    -- ---- 8d. queue (O24) with two kept sets: the sum, the sandbox, and an accepted delete page ----
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_dbase || '{"counts": {"expected": 6}}'::jsonb); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%counts.expected (6) is not the TEST records the pre-check kept and has not deleted (7, in 2 sets)%' then
      raise exception 'smoke check: queue, a delete page with the wrong sum (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_dbase || jsonb_build_object('orgs', jsonb_build_array(c_sbt || '{"alias": "smoke-other"}'::jsonb))); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%kept in another sandbox than this page''s org%' then
      raise exception 'smoke check: queue, a delete page on another sandbox (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    -- Accepted: through the second-page query (none) to the insert, test_run_ids the two sets' run ids.
    v_del := (public.switchboard_queue_run_request(v_dbase)->>'request_id')::uuid;
    if (select cardinality(test_run_ids) <> 2 or total_count <> 7 from public.switchboard_run_requests where id = v_del) then
      raise exception 'smoke check: queue, the delete page did not keep its two run ids and its count';
    end if;
    v_calls := v_calls + 3;

    -- ---- 8e. correct: the delete page's wording-only rule, and the keep_test rule both ways ----
    v_msg := null; v_state := null;
    begin perform public.switchboard_correct_run_request(v_del, 'records', v_dbase, c_why); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%a delete page changes only its wording, so a records edit is refused%' then
      raise exception 'smoke check: correction, a records edit on a delete page (got %: %)', v_state, coalesce(v_msg, 'corrected');
    end if;
    -- A wording edit on it: past the write gate (no write yet), the new rule and the keep_test rule (no keep_test), made.
    v_out := public.switchboard_correct_run_request(v_del, 'wording', v_dbase || '{"headline": "SMOKE CHECK: DELETE, REWORDED"}'::jsonb, c_why);
    if (v_out->>'version')::integer is distinct from 1 then
      raise exception 'smoke check: correction, a wording edit on a delete page was not made (got %)', v_out;
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_correct_run_request(v_pre, 'value', v_keep || '{"steps": [{"code": "create_test"}, {"code": "delete_test"}]}'::jsonb, c_why);
    exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%this pre-check keeps its TEST records, so its rehearsal lists keep_test%' then
      raise exception 'smoke check: correction, delete_test on a keeping pre-check (got %: %)', v_state, coalesce(v_msg, 'corrected');
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_correct_run_request(v_dop, 'value',
                    (v_keep - 'keep_test_records') || '{"page": "dataop", "steps": [{"code": "keep_test"}]}'::jsonb, c_why);
    exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%keep_test needs keep_test_records true, which this request does not have%' then
      raise exception 'smoke check: correction, keep_test on a request that keeps nothing (got %: %)', v_state, coalesce(v_msg, 'corrected');
    end if;
    v_calls := v_calls + 4;

    -- ---- 8f. consume (O24): the count, a stale sum, the sandbox, the org, then an Approve ----
    v_tokd := substring(public.switchboard_issue_run_link(v_del)->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tokd);
    v_msg := null; v_state := null;
    begin perform public.switchboard_consume_run_link(v_tokd, v_p->>'fingerprint', c_ready, 6); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '55000' or v_msg not like '%the count approved (6) is not the request''s count (7)%' then
      raise exception 'smoke check: consume, a delete page with the wrong count (got %: %)', v_state, coalesce(v_msg, 'approved');
    end if;
    -- A third set kept after the page was queued: the page's sum is stale.
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'smoke check', '{"ok": true, "pass": true, "kept_test_records": {"count": 2, "sandbox": "smoke-sb"}}', now()) returning id into v_run;
    perform public.switchboard_record_kept_test_records(v_run);
    v_msg := null; v_state := null;
    begin perform public.switchboard_consume_run_link(v_tokd, v_p->>'fingerprint', c_ready, 7); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '55000' or v_msg not like '%the kept TEST records changed since this delete page was queued (9 now, 7 on the page)%' then
      raise exception 'smoke check: consume, a stale delete page (got %: %)', v_state, coalesce(v_msg, 'approved');
    end if;
    v_del2 := (public.switchboard_queue_run_request(v_dbase || '{"counts": {"expected": 9}}'::jsonb)->>'request_id')::uuid;
    v_tokd := substring(public.switchboard_issue_run_link(v_del2)->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tokd);
    update public.switchboard_run_requests
       set kept_test_records = (select jsonb_agg(e || '{"sandbox": "smoke-x"}'::jsonb) from jsonb_array_elements(kept_test_records) e) where id = v_pre;
    v_msg := null; v_state := null;
    begin perform public.switchboard_consume_run_link(v_tokd, v_p->>'fingerprint', c_ready, 9); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '55000' or v_msg not like '%switchboard_consume_run_link: the TEST records were kept in another sandbox%' then
      raise exception 'smoke check: consume, kept in another sandbox (got %: %)', v_state, coalesce(v_msg, 'approved');
    end if;
    update public.switchboard_run_requests
       set kept_test_records = (select jsonb_agg(e || '{"sandbox": "smoke-sb"}'::jsonb) from jsonb_array_elements(kept_test_records) e) where id = v_pre;
    update public.switchboard_run_requests set request = jsonb_set(request, '{orgs}', jsonb_build_array(c_sbt, c_prod)) where id = v_del2;
    v_msg := null; v_state := null;
    begin perform public.switchboard_consume_run_link(v_tokd, public.switchboard_run_preview(v_tokd)->>'fingerprint', c_ready, 9); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '55000' or v_msg not like '%switchboard_consume_run_link: a delete page runs on one sandbox only%' then
      raise exception 'smoke check: consume, a delete page with another org (got %: %)', v_state, coalesce(v_msg, 'approved');
    end if;
    update public.switchboard_run_requests set request = jsonb_set(request, '{orgs}', jsonb_build_array(c_sbt)) where id = v_del2;
    -- Approved: through every new consume line, the second-page query (none: its refusal not raised, Q10 first).
    v_act2 := (public.switchboard_consume_run_link(v_tokd, v_p->>'fingerprint', c_ready, 9)->>'action_id')::uuid;
    if v_act2 is null then raise exception 'smoke check: consume made no action for the delete page'; end if;
    v_calls := v_calls + 5;

    -- ---- 8g. queue: a second delete page while one runs; the new function on a delete page's run ----
    v_msg := null; v_state := null;
    begin perform public.switchboard_queue_run_request(v_dbase || '{"counts": {"expected": 9}}'::jsonb); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '23514' or v_msg not like '%another delete page (request %) is deleting this pre-check''s TEST records now%' then
      raise exception 'smoke check: queue, a second delete page (got %: %)', v_state, coalesce(v_msg, 'queued');
    end if;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act2, 'real', 'smoke check', '{"ok": true, "pass": true, "kept_test_records": {"count": 4, "sandbox": "smoke-sb"}}', now()) returning id into v_run;
    v_msg := null; v_state := null;
    begin perform public.switchboard_record_kept_test_records(v_run); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '55000' or v_msg not like '%that run is not a pre-check''s run or rerun%' then
      raise exception 'smoke check: kept, a delete page''s run (got %: %)', v_state, coalesce(v_msg, 'recorded');
    end if;
    v_calls := v_calls + 2;

    -- ---- 8h. retry (O24): a resend through every new line, then a stale sum, the sandbox and the org ----
    -- Never started: the actions guard keeps created_at, so the run says so (as the 15-minute expiry writes it). The
    -- 8g run goes first, so retry reads this one, and the preview below never sees the 8g run's kept_test_records.
    delete from public.switchboard_runs where action_id = v_act2;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, failure_reason, finished_at)
    values (c_alex, v_act2, 'real', 'smoke check: never picked up', '{"ok": false, "expired": true, "reason": "expired_not_picked_up"}', 'expired_not_picked_up', now());
    v_out := public.switchboard_retry_run(v_tokd, v_p->>'fingerprint', c_ready);
    v_act3 := (v_out->>'action_id')::uuid;
    if v_act3 is null or (v_out->>'replaces')::uuid is distinct from v_act2 then
      raise exception 'smoke check: retry, the delete page was not resent (got %)', v_out;
    end if;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'smoke check', '{"ok": true, "pass": true, "kept_test_records": {"count": 5, "sandbox": "smoke-sb"}}', now()) returning id into v_run;
    perform public.switchboard_record_kept_test_records(v_run);
    v_msg := null; v_state := null;
    begin perform public.switchboard_retry_run(v_tokd, v_p->>'fingerprint', c_ready); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '55000' or v_msg not like '%switchboard_retry_run: the kept TEST records changed since this delete page was queued (14 now, 9 on the page)%' then
      raise exception 'smoke check: retry, a stale delete page (got %: %)', v_state, coalesce(v_msg, 'resent');
    end if;
    -- The fourth set goes (its entry is the list's last), so the sum is the page's again.
    update public.switchboard_run_requests set kept_test_records = kept_test_records - 3 where id = v_pre;
    update public.switchboard_run_requests
       set kept_test_records = (select jsonb_agg(e || '{"sandbox": "smoke-x"}'::jsonb) from jsonb_array_elements(kept_test_records) e) where id = v_pre;
    v_msg := null; v_state := null;
    begin perform public.switchboard_retry_run(v_tokd, v_p->>'fingerprint', c_ready); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '55000' or v_msg not like '%switchboard_retry_run: the TEST records were kept in another sandbox%' then
      raise exception 'smoke check: retry, kept in another sandbox (got %: %)', v_state, coalesce(v_msg, 'resent');
    end if;
    update public.switchboard_run_requests
       set kept_test_records = (select jsonb_agg(e || '{"sandbox": "smoke-sb"}'::jsonb) from jsonb_array_elements(kept_test_records) e) where id = v_pre;
    update public.switchboard_run_requests set request = jsonb_set(request, '{orgs}', jsonb_build_array(c_sbt, c_prod)) where id = v_del2;
    v_msg := null; v_state := null;
    begin perform public.switchboard_retry_run(v_tokd, public.switchboard_run_preview(v_tokd)->>'fingerprint', c_ready); exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '55000' or v_msg not like '%switchboard_retry_run: a delete page runs on one sandbox only%' then
      raise exception 'smoke check: retry, a delete page with another org (got %: %)', v_state, coalesce(v_msg, 'resent');
    end if;
    update public.switchboard_run_requests set request = jsonb_set(request, '{orgs}', jsonb_build_array(c_sbt)) where id = v_del2;
    v_calls := v_calls + 4;

    -- ---- 8i. outcome (O24): the delete page's pass marks its three sets deleted; a pre-check's run refused ----
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_act3;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act3, 'real', 'smoke check', '{"ok": true, "pass": true}', now()) returning id into v_run;
    v_out := public.switchboard_record_run_outcome(v_run, '{"changed": 9}'::jsonb);
    if (v_out->>'recorded')::boolean is not true
       or (select count(*) from jsonb_array_elements((select kept_test_records from public.switchboard_run_requests where id = v_pre)) e
            where (e->>'deleted_by') = v_del2::text) <> 3 then
      raise exception 'smoke check: outcome, the delete page''s pass did not mark its three sets deleted (got %)', v_out;
    end if;
    v_msg := null; v_state := null;
    begin perform public.switchboard_record_run_outcome((select id from public.switchboard_runs where action_id = v_act
                                                          and result->'kept_test_records' = '{"count": 4, "sandbox": "smoke-sb"}'::jsonb
                                                          and result->'pass' = 'true'::jsonb and mode = 'real' order by started_at limit 1), '{}'::jsonb);
    exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '55000' or v_msg not like '%only a data operation, undo or check has an outcome, and a delete page%' then
      raise exception 'smoke check: outcome on a pre-check (got %: %)', v_state, coalesce(v_msg, 'recorded');
    end if;
    -- A correction once the write ran: the write gate's new page refuses even wording.
    v_msg := null; v_state := null;
    begin perform public.switchboard_correct_run_request(v_del2, 'wording', v_dbase || '{"counts": {"expected": 9}, "headline": "X"}'::jsonb, c_why);
    exception when others then v_msg := sqlerrm; v_state := sqlstate; end;
    if v_state is distinct from '55000' or v_msg not like '%a production write already ran on this request%' then
      raise exception 'smoke check: correction, a delete page after its write (got %: %)', v_state, coalesce(v_msg, 'corrected');
    end if;
    -- The preview of a request with no kept sets and a run with none: both new keys left out.
    v_p := public.switchboard_run_preview(v_tokd);
    if (v_p->'request') ? 'kept_test_records' or (v_p->'run') ? 'kept_test_records' then
      raise exception 'smoke check: preview, kept_test_records on a delete page (got %)', v_p;
    end if;
    v_calls := v_calls + 4;

    raise exception 'slice2b_smoke_undo';
  exception when others then
    if sqlerrm <> 'slice2b_smoke_undo' then raise; end if;
  end;
  raise notice 'slice 2b smoke check: % calls as expected; everything undone.', v_calls;
end;
$$;

-- ============================================================================
-- 9. Result: must say CONFORMANT. Then run supabase/tests/sb3_pages-h6v/10_slice2b_test.sql with --test.
-- ============================================================================
select public.platform_check_conformance() as conformance;
