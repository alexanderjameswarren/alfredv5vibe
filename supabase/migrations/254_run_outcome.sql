-- 254, sb3_pages-h6v s17 and s17b (follow-up to 250-253): a write's outcome, kept on its request; and once a write
-- has run, the request can't be corrected. Schema change: three columns and three functions. Spec:
-- docs/technical-spec-sb3_pages-h6v.md 10f.
-- Table altered: switchboard_run_requests (outcome, outcome_run_id, outcome_recorded_at, all null by default). No data
-- changes.
-- Functions: switchboard_record_run_outcome (new, service role only); switchboard_run_preview (253's, replaced whole);
-- switchboard_correct_run_request (252's, replaced whole).
-- Tables read: switchboard_runs, switchboard_actions, switchboard_run_links, switchboard_run_samples (the preview's
-- expired-sample delete, as 250), switchboard_code_reviews (the code correction's supersede, as 252).
--
-- Why (agreed with plumbing and the hub): the runner keeps only {ok, exit_code, pass, checks} on the run row, and
-- switchboard_prune_runs clears a run's result after 30 days, so a data operation's or undo's outcome needs a durable
-- home on its request. The outcome's shape belongs to the data runs thread; this migration stores any JSON object of
-- at most 64 KB and never reads inside it.
--
-- 1. switchboard_record_run_outcome(p_run_id, p_outcome): accepted only for a finished real run whose action is the
--    sf_run its link approved (link.action_id = the run's action_id) on a data operation or undo request (base_page),
--    not a simulation. A pre-check's run, a rerun (a correction's Approve or the expired-checks rerun: those set
--    rerun_action_id, never action_id), an unfinished run, a dry run and a run that never started
--    (expired_not_picked_up) are refused. Once per run: a second call for the same run returns already true and changes
--    nothing. A later run of the same link (a resend after a run that never started) replaces it, since only the link's
--    current action is accepted; a run approved through another link never replaces the first write's outcome (a
--    backstop: with part 3 a request can't be written twice). Locks the request, then the link, as consume does, and
--    checks the link's action again under the lock. It never touches evidence, the 24-hour clock, the page, the
--    version or what can be approved.
-- 2. switchboard_run_preview: 253's, unchanged, plus outcome, outcome_run_id and outcome_recorded_at, returned only on
--    the link whose approved run recorded the outcome (null on any other link of the request).
-- 3. switchboard_correct_run_request (s17b, Alex's option A on spec 10f): 252's, unchanged except one refusal, first:
--    on a data operation or undo request, every correction kind (wording included) is refused once an approved write on
--    it has started or may still start: a link's approved action (link.action_id) that was picked up, has a run (other
--    than one marked expired_not_picked_up), or is still consumed and within its 15 minutes. Only a write that never
--    started leaves the request correctable. A further change is a new request through diagnosis, with its own
--    pre-check. Pre-check requests are unaffected.

-- ============================================================================
-- 1. The columns.
-- ============================================================================
alter table public.switchboard_run_requests
  add column outcome             jsonb check (outcome is null or (jsonb_typeof(outcome) = 'object' and octet_length(outcome::text) <= 65536)),
  add column outcome_run_id      uuid,
  add column outcome_recorded_at timestamptz,
  add constraint switchboard_run_requests_outcome_whole
    check ((outcome is null) = (outcome_run_id is null) and (outcome is null) = (outcome_recorded_at is null));
comment on column public.switchboard_run_requests.outcome is
  'A data operation''s or undo''s outcome, as its run reported it (a JSON object, at most 64 KB; its shape is the data runs thread''s). Written only by switchboard_record_run_outcome (service role); kept after the run''s own result is pruned. Null until the write''s run records one.';
comment on column public.switchboard_run_requests.outcome_run_id is 'The switchboard_runs row whose outcome this is: the run of the action the request''s link approved.';
comment on column public.switchboard_run_requests.outcome_recorded_at is 'When the outcome was recorded.';

-- ============================================================================
-- 2. switchboard_record_run_outcome: the write's outcome, from the runner, once per run.
-- ============================================================================
create function public.switchboard_record_run_outcome(p_run_id uuid, p_outcome jsonb)
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
  if v_run.mode <> 'real' then
    raise exception 'switchboard_record_run_outcome: run % is a %, not a real run.', p_run_id, v_run.mode using errcode = '55000';
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
  if v_row.simulation then
    raise exception 'switchboard_record_run_outcome: request % is a simulation; it has no outcome. Nothing was recorded.', v_row.id using errcode = '55000';
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
  'Switchboard 3: keep a data operation''s or undo''s outcome on its request (outcome, outcome_run_id, outcome_recorded_at), since the run''s own result is pruned after 30 days. Accepted only for a finished real run of the sf_run action its link approved (link.action_id), on a request whose base page is dataop or undo, not a simulation; p_outcome is a JSON object of at most 64 KB, stored as given. A pre-check''s run, a rerun, an unfinished run and a run that never started are refused. Once per run: the same run again returns already true. A later run of the same link (a resend) replaces it; a run approved through another link of the request never does. Never touches evidence, the 24-hour clock or what can be approved. Returns {recorded, already, request_id}. Service role only: called by switchboard-runner after a write''s result.';
revoke all on function public.switchboard_record_run_outcome(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.switchboard_record_run_outcome(uuid, jsonb) to service_role;

-- ============================================================================
-- 3. switchboard_run_preview: 253's, plus the outcome.
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
    'request', v_row.request || jsonb_build_object('id', v_row.id, 'page', v_row.page, 'base_page', v_row.base_page, 'version', v_row.version,
                                                   'corrected_at', v_row.corrected_at, 'evidence', v_row.evidence,
                                                   'simulation', v_row.simulation, 'rerun_at', v_link.rerun_at),
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
             'rerun', v_action.id = v_link.rerun_action_id) end,
    'sample', case when v_sample.id is null then null else v_sample.sample end,
    'review', case when v_review.id is null then null else
               v_review.review || jsonb_build_object('id', v_review.id, 'commit', v_review.commit, 'status', v_review.status,
                                                     'superseded_by', v_review.superseded_by, 'acknowledged', v_review.acks) end);
end;
$$;
comment on function public.switchboard_run_preview(text) is
  'Switchboard 3: what a run or review page shows for its token, read at page open and at a click. Returns {link_id, request (with id, page, version, corrected_at, evidence, simulation, rerun_at), fingerprint, total_count (the request''s count, which switchboard_consume_run_link checks and the page sends with Approve; null when the request has none), outcome, outcome_run_id, outcome_recorded_at (254: the write''s outcome, null until recorded and on any link but the one whose approved run recorded it), link {version, current, used_at, rerun_at, voided_at, void_reason}, valid_until, expired (never for an undo), run (the newest sf_run for this link id: status, consumed_at, picked_up_at, finished_at, failure_reason, not_started, rerun), sample, review}. Deletes the sample when it is past expires_at. Called by switchboard-run-pages with Alex''s JWT.';
revoke all on function public.switchboard_run_preview(text) from public, anon;
grant execute on function public.switchboard_run_preview(text) to authenticated;

-- ============================================================================
-- 4. switchboard_correct_run_request: as 252, plus (s17b) no correction once a write has run or may still start.
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
  'Switchboard 3: correct a run request (part 5 "Corrected"). Refuses (254, Alex s17b) every correction of a data operation or undo, wording included, once an approved write on it has started or may still start (its link''s approved action was picked up, has a run other than expired_not_picked_up, or is consumed within its 15 minutes): a further change is a new request through diagnosis; a write that never started leaves it correctable, and a pre-check is unaffected. Refuses an object or operation edit (a new request through diagnosis), and (s12c) any change to pre_check_request_id. Each kind changes only its own row of the correction table, besides the wording (headline, side effects, problem, what diagnosis allows) and, for a kind that reruns a check, the run''s own steps, phases, details, kept, run_tag and still_valid: value operation.value; file operation.file; field operation.field and undo; records selected_by (not its kind or sandbox filter), counts, operation.steps and undo; records_filter all of selected_by, counts, operation.steps and undo; sandbox_filter selected_by.sandbox_text and not_rehearsed; code the code. A kind that reruns the rehearsal may also add one role-rehearsal sandbox org to a request with none (252). Any other change is refused, naming the field (a key set to null counts as left out). A wording or allowance edit voids nothing and keeps the version and the page. Any other edit raises the version by one, makes it a correction page, keeps the request''s own steps and phases as base_steps and base_phases (252; restored by switchboard_record_run_evidence on return), voids the evidence its kind reruns (field: rehearsal, login, backup, sample; Alex s8b) and the request''s live links, and for a code edit marks older reviews superseded, in one transaction. Returns {request_id, version, voided_checks, voided_links}.';
revoke all on function public.switchboard_correct_run_request(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function public.switchboard_correct_run_request(uuid, text, jsonb, jsonb) to authenticated;

-- ============================================================================
-- 5. Result: must say CONFORMANT. Then run supabase/tests/sb3_pages-h6v/6_run_outcome_test.sql with --test.
-- ============================================================================
select public.platform_check_conformance() as conformance;
