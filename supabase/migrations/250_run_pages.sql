-- 250, sb3_pages-h6v B1: the Switchboard 3 run pages and code review pages, in the database. Schema change.
-- Spec: docs/technical-spec-sb3_pages-h6v.md parts 2, 4 (4.1, 4.3, 4.3a, 4.5, 4.7), 5 (link rules), 7 (the sample),
-- 12 (Q1-Q12). Builds on 248_sf_run.sql (plumbing): the helper kind sf_run.
-- Tables created: switchboard_run_requests, switchboard_run_links, switchboard_run_samples, switchboard_code_reviews.
-- Functions created: switchboard_queue_run_request, switchboard_correct_run_request, switchboard_issue_run_link,
-- switchboard_run_preview, switchboard_consume_run_link, switchboard_cancel_run_link, switchboard_retry_run,
-- switchboard_record_code_review, switchboard_store_run_sample, switchboard_drop_run_sample.
-- Function changed: switchboard_prune_sf_results (233), one added delete. Written by the functions:
-- switchboard_actions (inserts of kind sf_run; a stale sf_run consumed -> failed) and switchboard_runs (its failed run).
-- switchboard_actions itself is not altered. Today's link machinery (switchboard_issue_link, switchboard_consume_link,
-- approve pages) is untouched.
--
-- The link rules live here, not in the page (part 5):
-- - A run is approved only through switchboard_consume_run_link, and only when: the link is the caller's, unused and
--   not voided; the request is at the link's version and its fingerprint matches what the page showed; every check the
--   request still uses is within 24 hours of the oldest (an undo has no 24-hour expiry, only a delete's undo deadline);
--   the desktop answered "running", panel and helper both up (Q9); the count the page showed equals the request's
--   count (dataop and undo); the code, if any, was rehearsed and reviewed at the same commit; and no other link or run
--   is live for the project (Q10, read only).
-- - No 30-minute clock: a link has no expiry of its own (Q2). Validity is read from the evidence each time.
-- - A simulation request (Q7) is accepted and its link is spent like any other, but it never creates a helper action
--   or a run: switchboard_actions and switchboard_runs, the real logs, never see it.
-- - Every helper action carries payload {"link_id": <the link's id>} and nothing else; the link records which action
--   is the approval (action_id) and which the rerun (rerun_action_id), so the helper reads what to run by link id.

-- ============================================================================
-- 1. switchboard_run_requests: one request per run, the request as the chat queued it, its version and evidence.
-- ============================================================================
create table public.switchboard_run_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid(),
  project_code text not null check (project_code ~ '^[a-z0-9_-]{1,40}$'),
  page         text not null check (page in ('precheck', 'dataop', 'undo', 'correction', 'check')),
  base_page    text not null check (base_page in ('precheck', 'dataop', 'undo', 'check')),
  version      integer not null default 1 check (version >= 1),
  corrected_at timestamptz,
  simulation   boolean not null default false,
  request      jsonb not null check (jsonb_typeof(request) = 'object' and octet_length(request::text) <= 200000),
  evidence     jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  total_count  integer check (total_count is null or total_count >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
comment on table public.switchboard_run_requests is
  'Switchboard 3 run pages: one run request (pre-check, data operation, undo, correction or check), as queued by the chat, with its version and the evidence of passed checks. Written only by the switchboard_*_run_* functions and the service role (sb3_pages-h6v).';
comment on column public.switchboard_run_requests.id is 'The request id.';
comment on column public.switchboard_run_requests.user_id is 'Owner (Alex).';
comment on column public.switchboard_run_requests.project_code is 'The project code; one live link or run per code (Q10).';
comment on column public.switchboard_run_requests.page is 'Which page it is: precheck, dataop, undo, correction or check.';
comment on column public.switchboard_run_requests.base_page is 'The page it was queued as; a correction page returns to it once its reruns pass (B2 sets page back). Write checks key on it.';
comment on column public.switchboard_run_requests.version is 'Raised by one by every correction that reruns a check; a link is bound to its version.';
comment on column public.switchboard_run_requests.corrected_at is 'When the last correction was made.';
comment on column public.switchboard_run_requests.simulation is 'Sample data (Q7): its link is spent, but no helper action or run is ever created.';
comment on column public.switchboard_run_requests.request is 'The request as spec 4.1 describes it, without id, version, corrected_at, evidence or the sample.';
comment on column public.switchboard_run_requests.evidence is 'Passed checks: [{check, org, passed_at, commit?, voided?}], written only by the service role from the pre-check''s result (B2), never by the chat. Valid until 24 hours after the oldest one not voided (never for an undo).';
comment on column public.switchboard_run_requests.total_count is 'The count the run writes (counts.total, or expected; undo_up_to on an undo). The page must show this count to approve.';
comment on column public.switchboard_run_requests.created_at is 'When it was queued.';
comment on column public.switchboard_run_requests.updated_at is 'Last change.';
create index switchboard_run_requests_user_code on public.switchboard_run_requests (user_id, project_code);

-- ============================================================================
-- 2. switchboard_code_reviews: a code review of the code a run carries (Salesforce code only).
-- ============================================================================
create table public.switchboard_code_reviews (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid(),
  request_id    uuid not null references public.switchboard_run_requests (id) on delete cascade,
  commit        text not null check (commit ~ '^[0-9a-f]{7,40}$'),
  review        jsonb not null check (jsonb_typeof(review) = 'object' and octet_length(review::text) <= 2000000),
  status        text not null default 'open' check (status in ('open', 'reviewed', 'changes_required', 'superseded')),
  superseded_by text check (superseded_by is null or superseded_by ~ '^[0-9a-f]{7,40}$'),
  acks          jsonb not null default '{}'::jsonb check (jsonb_typeof(acks) = 'object'),
  answers       jsonb not null default '[]'::jsonb check (jsonb_typeof(answers) = 'array' and octet_length(answers::text) <= 200000),
  answered_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check ((status = 'superseded') = (superseded_by is not null))
);
comment on table public.switchboard_code_reviews is
  'Switchboard 3 code review page: one review of a run''s code at one commit (spec 4.3, 4.3a). A newer commit supersedes it. Written by switchboard_record_code_review and the service role (sb3_pages-h6v).';
comment on column public.switchboard_code_reviews.id is 'The review id.';
comment on column public.switchboard_code_reviews.user_id is 'Owner (Alex).';
comment on column public.switchboard_code_reviews.request_id is 'The run request whose code this reviews.';
comment on column public.switchboard_code_reviews.commit is 'The reviewed commit.';
comment on column public.switchboard_code_reviews.review is 'The review as spec 4.3 describes it: files with their whole old and new text, findings, notes.';
comment on column public.switchboard_code_reviews.status is 'open, reviewed (I reviewed this code), changes_required, or superseded by a newer commit.';
comment on column public.switchboard_code_reviews.superseded_by is 'The newer commit, when superseded.';
comment on column public.switchboard_code_reviews.acks is 'Alex''s acknowledgements: {finding id: {note}}, kept across visits and questions.';
comment on column public.switchboard_code_reviews.answers is 'Alex''s answers, oldest first: [{kind: reviewed|question|changes_required, text (up to 1000 characters, the full text; the chat line carries 200), at}]. A question keeps the review open (spec 4.4). Written by switchboard-run-pages (B2).';
comment on column public.switchboard_code_reviews.answered_at is 'When Alex last answered (reviewed, a question, or changes required).';
comment on column public.switchboard_code_reviews.created_at is 'When it was recorded.';
comment on column public.switchboard_code_reviews.updated_at is 'Last change.';
create index switchboard_code_reviews_request on public.switchboard_code_reviews (request_id, created_at desc);

-- ============================================================================
-- 3. switchboard_run_links: a page link. Its id is the link id every result line and helper action carries.
-- ============================================================================
create table public.switchboard_run_links (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid(),
  request_id      uuid not null references public.switchboard_run_requests (id) on delete cascade,
  request_version integer not null check (request_version >= 1),
  review_id       uuid references public.switchboard_code_reviews (id) on delete cascade,
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  desktop         jsonb check (desktop is null or jsonb_typeof(desktop) = 'object'),
  used_at         timestamptz,
  action_id       uuid,
  rerun_at        timestamptz,
  rerun_action_id uuid,
  voided_at       timestamptz,
  void_reason     text check (void_reason is null or char_length(void_reason) <= 220),
  created_at      timestamptz not null default now(),
  check ((voided_at is null) = (void_reason is null)),
  check ((used_at is null) or (desktop is not null)),
  check ((rerun_at is null) or (desktop is not null))
);
comment on table public.switchboard_run_links is
  'Switchboard 3 page links (/run/<token>, /review/<token>). The id is the link id in every result line and in the sf_run payload; only the token''s hash is kept. No clock of its own (Q2): validity is read from the request''s evidence. Written only by the switchboard_*_run_* functions (sb3_pages-h6v).';
comment on column public.switchboard_run_links.id is 'The link id: payload.link_id on every sf_run action for this link, and the id in its result lines.';
comment on column public.switchboard_run_links.user_id is 'Owner (Alex).';
comment on column public.switchboard_run_links.request_id is 'The run request.';
comment on column public.switchboard_run_links.request_version is 'The request version the link was issued for; a correction voids it.';
comment on column public.switchboard_run_links.review_id is 'For a code review page link, the review.';
comment on column public.switchboard_run_links.token_hash is 'sha256 of the link token, hex. The token is only in the issued URL.';
comment on column public.switchboard_run_links.desktop is 'The desktop answer at the approving click: {answer, panel, helper, extension_version} (Q9).';
comment on column public.switchboard_run_links.used_at is 'When Alex approved the run (consume). Set once.';
comment on column public.switchboard_run_links.action_id is 'The newest sf_run action for the approval (a resend replaces it).';
comment on column public.switchboard_run_links.rerun_at is 'When Alex asked for the pre-check and rehearsal again on expired checks (rerun mode).';
comment on column public.switchboard_run_links.rerun_action_id is 'The sf_run action for that rerun.';
comment on column public.switchboard_run_links.voided_at is 'When it was voided: cancelled (Don''t run), corrected, or replaced.';
comment on column public.switchboard_run_links.void_reason is 'Why: "cancelled[: <note, 200 characters at most>]" or "corrected".';
comment on column public.switchboard_run_links.created_at is 'When it was issued.';
create index switchboard_run_links_request on public.switchboard_run_links (request_id);

-- ============================================================================
-- 4. switchboard_run_samples: the one sample record (two for an upsert), held at most 24 hours (part 7).
-- ============================================================================
create table public.switchboard_run_samples (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid(),
  request_id uuid not null unique references public.switchboard_run_requests (id) on delete cascade,
  sample     jsonb not null check (jsonb_typeof(sample) = 'object' and octet_length(sample::text) <= 20000),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at <= created_at + interval '24 hours')
);
comment on table public.switchboard_run_samples is
  'Switchboard 3: the sample record of a run (client data), read only by the run page with Alex''s JWT, never by an MCP tool (Q4). Deleted at run finish (switchboard_drop_run_sample), at a read past expires_at (switchboard_run_preview), and each minute by switchboard_prune_sf_results. Not audited, so no copy outlives it (sb3_pages-h6v).';
comment on column public.switchboard_run_samples.id is 'The sample id.';
comment on column public.switchboard_run_samples.user_id is 'Owner (Alex).';
comment on column public.switchboard_run_samples.request_id is 'The run request; one sample per request.';
comment on column public.switchboard_run_samples.sample is '{records: [{role, id_label, fields: [{name, now, after}], child_count?, deleted_by?, deleted_at?, days_left?}]}.';
comment on column public.switchboard_run_samples.created_at is 'When the pre-check stored it.';
comment on column public.switchboard_run_samples.expires_at is 'The checks'' valid-until, at most 24 hours after created_at.';
create index switchboard_run_samples_expires on public.switchboard_run_samples (expires_at);

-- ============================================================================
-- 5. Register: owner RLS, explicit grants, no anon. Then take writes back from authenticated: the functions write.
-- ============================================================================
select platform.register_table('public.switchboard_run_requests', p_policy_mode => 'owner', p_audited => true,
  p_notes => 'Switchboard 3 run requests. Read-only for authenticated; written by the run page functions and the service role.');
select platform.register_table('public.switchboard_code_reviews', p_policy_mode => 'owner', p_audited => true,
  p_notes => 'Switchboard 3 code reviews. Read-only for authenticated; written by switchboard_record_code_review and the service role.');
-- Links are not audited, so no token hash is copied into the audit log.
select platform.register_table('public.switchboard_run_links', p_policy_mode => 'owner', p_audited => false,
  p_secret_columns => array['token_hash'],
  p_notes => 'Switchboard 3 page links. Read-only for authenticated; written by the run page functions. Not audited (token hash).');
select platform.register_table('public.switchboard_run_samples', p_policy_mode => 'owner', p_audited => false,
  p_mcp_read => 'hidden',
  p_notes => 'Switchboard 3 sample records: client data, at most 24 hours, page only (Q4). Not audited, hidden from MCP reads, and closed to direct reads: only switchboard_run_preview returns it.');
-- Q4: no signed-in session reads a sample directly, whatever tool it uses; the page reads it through
-- switchboard_run_preview (security definer). The owner policy and the grants stay, for conformance.
create policy switchboard_run_samples_no_direct_read on public.switchboard_run_samples
  as restrictive for select to authenticated using (false);

revoke insert, update, delete on public.switchboard_run_requests from authenticated;
revoke insert, update, delete on public.switchboard_code_reviews from authenticated;
revoke insert, update, delete on public.switchboard_run_links from authenticated;
revoke insert, update, delete on public.switchboard_run_samples from authenticated;

-- ============================================================================
-- 6. switchboard_queue_run_request: the chat queues a request (B3's queue_switchboard_run_request tool).
-- ============================================================================
create function public.switchboard_queue_run_request(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user  uuid := auth.uid();
  v_page  text := p_request->>'page';
  v_code  text := p_request->>'project_code';
  v_total jsonb;
  v_id    uuid;
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
  -- The chat never supplies evidence: only the pre-check's result does, through the service role (B2).
  if p_request ? 'evidence' then
    raise exception 'switchboard_queue_run_request: leave evidence out: only the pre-check''s result records passed checks.' using errcode = '23514';
  end if;
  if p_request ? 'simulation' and jsonb_typeof(p_request->'simulation') is distinct from 'boolean' then
    raise exception 'switchboard_queue_run_request: simulation must be true or false.' using errcode = '23514';
  end if;
  v_total := case when v_page = 'undo' then coalesce(p_request->'counts'->'undo_up_to', p_request->'counts'->'expected')
                  else coalesce(p_request->'counts'->'total', p_request->'counts'->'expected') end;
  if v_page in ('dataop', 'undo') and (jsonb_typeof(v_total) is distinct from 'number' or v_total::text !~ '^[0-9]{1,9}$') then
    raise exception 'switchboard_queue_run_request: add counts.total (or expected; undo_up_to on an undo): the count the run writes.' using errcode = '23514';
  end if;

  insert into public.switchboard_run_requests (user_id, project_code, page, base_page, simulation, request, evidence, total_count)
  values (v_user, v_code, v_page, v_page, coalesce((p_request->>'simulation')::boolean, false),
          p_request - array['id', 'version', 'corrected_at', 'evidence', 'simulation'],
          '[]'::jsonb,
          case when jsonb_typeof(v_total) = 'number' and v_total::text ~ '^[0-9]{1,9}$' then v_total::text::integer end)
  returning id into v_id;
  return jsonb_build_object('request_id', v_id, 'version', 1);
end;
$$;
comment on function public.switchboard_queue_run_request(jsonb) is
  'Switchboard 3: queue a run request (spec 4.1) for the signed-in caller. Refuses, before any link, a request without page, project_code, the problem label and sentence, side_effects, headline or steps; one with a sample; a correction (use switchboard_correct_run_request); and a data operation or undo without its count. A simulation (Q7) is accepted and flagged. Returns {request_id, version}. Called by the queue_switchboard_run_request tool (B3).';
revoke all on function public.switchboard_queue_run_request(jsonb) from public, anon;
grant execute on function public.switchboard_queue_run_request(jsonb) to authenticated;

-- ============================================================================
-- 7. switchboard_correct_run_request: a correction (part 5 "Corrected"; EDIT_RERUNS, spec 3.2 d).
-- ============================================================================
create function public.switchboard_correct_run_request(p_request_id uuid, p_edit_kind text, p_request jsonb, p_changed jsonb)
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
  -- Whatever kind is named, the object and the operation never change here: that is a new request through diagnosis.
  if (p_request->'operation'->>'kind') is distinct from (v_row.request->'operation'->>'kind')
     or (p_request->'operation'->>'object') is distinct from (v_row.request->'operation'->>'object') then
    raise exception 'switchboard_correct_run_request: the object or operation changed; that needs a new request through diagnosis, not a correction. No link was issued.'
      using errcode = '23514';
  end if;
  -- A wording or allowance edit may change only the words: everything else must be as it was.
  if cardinality(v_reruns) = 0
     and (p_request - array['headline', 'side_effects', 'problem', 'diagnosis_allows', 'changed', 'page', 'id', 'version', 'corrected_at', 'simulation'])
         is distinct from (v_row.request - array['headline', 'side_effects', 'problem', 'diagnosis_allows', 'changed', 'page']) then
    raise exception 'switchboard_correct_run_request: a % edit changes only the headline, side effects, problem wording or what diagnosis allows; name the edit kind that reruns what changed.', p_edit_kind
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
  'Switchboard 3: correct a run request (part 5 "Corrected"). Refuses an object or operation edit (a new request through diagnosis). A wording or allowance edit voids nothing and keeps the version. Any other edit raises the version by one, makes it a correction page, voids the evidence its kind reruns (field: rehearsal, login, backup, sample; Alex s8b) and the request''s live links, and for a code edit marks older reviews superseded, in one transaction. Returns {request_id, version, voided_checks, voided_links}.';
revoke all on function public.switchboard_correct_run_request(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function public.switchboard_correct_run_request(uuid, text, jsonb, jsonb) to authenticated;

-- ============================================================================
-- 8. switchboard_issue_run_link: a page link, no expiry of its own (Q2). One live link per request.
-- ============================================================================
create function public.switchboard_issue_run_link(p_request_id uuid, p_review_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user  uuid := auth.uid();
  v_row   public.switchboard_run_requests;
  v_live  uuid;
  v_base  text;
  v_token text;
  v_id    uuid;
begin
  if v_user is null then
    raise exception 'switchboard_issue_run_link: no signed-in user.' using errcode = '28000';
  end if;
  -- Locks the request, so two issues at once can't both pass the checks below.
  select * into v_row from public.switchboard_run_requests where id = p_request_id and user_id = v_user for update;
  if not found then
    raise exception 'switchboard_issue_run_link: no such request.' using errcode = 'P0002';
  end if;
  -- A request version is approved once: after a used run link, a further run is a new request (or a correction).
  if p_review_id is null and exists (select 1 from public.switchboard_run_links
                                      where request_id = v_row.id and request_version = v_row.version
                                        and review_id is null and used_at is not null) then
    raise exception 'switchboard_issue_run_link: this request was already approved; a further run is a new request or a correction.'
      using errcode = '55000';
  end if;
  if p_review_id is not null and not exists (select 1 from public.switchboard_code_reviews
                                               where id = p_review_id and request_id = v_row.id and user_id = v_user) then
    raise exception 'switchboard_issue_run_link: that review is not this request''s.' using errcode = 'P0002';
  end if;
  select id into v_live from public.switchboard_run_links
   where request_id = v_row.id and request_version = v_row.version and used_at is null and voided_at is null
     and review_id is not distinct from p_review_id
   limit 1;
  if v_live is not null then
    raise exception 'switchboard_issue_run_link: link % is still live for this request. One at a time: use it, or Don''t run.', v_live
      using errcode = '55000';
  end if;
  select link_base_url into v_base from public.switchboard_settings where user_id = v_user;
  if v_base is null then
    raise exception 'switchboard_issue_run_link: no switchboard_settings row for this user.' using errcode = 'P0002';
  end if;

  -- As switchboard_issue_link: two v4 UUIDs, only the hash kept.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.switchboard_run_links (user_id, request_id, request_version, review_id, token_hash)
  values (v_user, v_row.id, v_row.version, p_review_id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'))
  returning id into v_id;
  return jsonb_build_object('link_id', v_id,
                            'url', v_base || case when p_review_id is null then '/run/' else '/review/' end || v_token,
                            'headline', v_row.request->>'headline', 'version', v_row.version);
end;
$$;
comment on function public.switchboard_issue_run_link(uuid, uuid) is
  'Switchboard 3: issue the page link for one of the caller''s run requests (or, with p_review_id, its code review). Returns {link_id, url, headline, version}; the token is only in the url, the row keeps its hash. No expiry of its own (Q2). Refused while a link for the same request, version and review is unused and not voided, and (a run link) once a run link of that version has been used: a version is approved once.';
revoke all on function public.switchboard_issue_run_link(uuid, uuid) from public, anon;
grant execute on function public.switchboard_issue_run_link(uuid, uuid) to authenticated;

-- ============================================================================
-- 9. switchboard_run_preview: what the page shows, read at page open and at a click, never on a clock.
-- ============================================================================
create function public.switchboard_run_preview(p_token text)
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

  return jsonb_build_object(
    'link_id', v_link.id,
    'request', v_row.request || jsonb_build_object('id', v_row.id, 'page', v_row.page, 'base_page', v_row.base_page, 'version', v_row.version,
                                                   'corrected_at', v_row.corrected_at, 'evidence', v_row.evidence,
                                                   'simulation', v_row.simulation, 'rerun_at', v_link.rerun_at),
    'fingerprint', public.switchboard_fingerprint(v_row.request || jsonb_build_object('version', v_row.version)),
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
  'Switchboard 3: what a run or review page shows for its token, read at page open and at a click. Returns {link_id, request (with id, page, version, corrected_at, evidence, simulation, rerun_at), fingerprint, link {version, current, used_at, rerun_at, voided_at, void_reason}, valid_until, expired (never for an undo), run (the newest sf_run for this link id: status, consumed_at, picked_up_at, finished_at, failure_reason, not_started, rerun), sample, review}. Deletes the sample when it is past expires_at. Called by switchboard-run-pages with Alex''s JWT.';
revoke all on function public.switchboard_run_preview(text) from public, anon;
grant execute on function public.switchboard_run_preview(text) to authenticated;

-- ============================================================================
-- 10. switchboard_consume_run_link: Approve (p_mode 'approve') or "Run the pre-check and rehearsal again" ('rerun').
-- ============================================================================
create function public.switchboard_consume_run_link(p_token text, p_fingerprint text, p_desktop jsonb,
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

  if v_row.simulation then
    -- Q7: accepted, the link is spent, but no helper action and no run: the real logs never see a simulation.
    update public.switchboard_run_links
       set used_at = case when p_mode = 'approve' then now() else used_at end,
           rerun_at = case when p_mode = 'rerun' then now() else rerun_at end,
           desktop = p_desktop
     where id = v_link.id;
    return jsonb_build_object('consumed', true, 'simulated', true, 'link_id', v_link.id, 'mode', p_mode, 'action_id', null);
  end if;

  -- A rerun on a link whose run never started: fail its stale action first (consumed -> failed), as the pickup would.
  -- Only if still consumed and unpicked: a pickup failing it at the same moment leaves one failed run, not two.
  if p_mode = 'rerun' and v_stuck and v_newest.status = 'consumed' then
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
  -- same link approves the data operation.
  update public.switchboard_run_links
     set used_at         = case when p_mode = 'approve' then now() when v_stuck then null else used_at end,
         action_id       = case when p_mode = 'approve' then v_action else action_id end,
         rerun_at        = case when p_mode = 'rerun' then now() else rerun_at end,
         rerun_action_id = case when p_mode = 'rerun' then v_action else rerun_action_id end,
         desktop         = p_desktop
   where id = v_link.id;
  return jsonb_build_object('consumed', true, 'simulated', false, 'link_id', v_link.id, 'mode', p_mode, 'action_id', v_action);
end;
$$;
comment on function public.switchboard_consume_run_link(text, text, jsonb, integer, text) is
  'Switchboard 3: Approve (p_mode approve) or "Run the pre-check and rehearsal again" (rerun) on a run page. Approves only when the link is the caller''s, not voided and (approve) unused, no other link of the same request version was used, the request is at the link''s version with the fingerprint the page showed, no check is dated in the future, the checks are within 24 hours (not for an undo; a delete''s undo before its deadline), a data operation has every pre-check check (count, login, automation, backup, rehearsal) passed and in use, p_count equals the request''s count (dataop, undo), the code (if any) was rehearsed (rehearsal evidence carrying its commit) and reviewed at that commit, p_desktop says running with panel and helper up, and no link or run is live for the project (Q10, under the same advisory lock as switchboard_issue_link). Locks the request, then the link. Rerun only on expired checks, not while the last rerun is approved and unfinished, and on a used link only when its run never started (s6b), which fails the stale action and frees the link. A simulation spends the link and creates nothing else (Q7). Otherwise inserts an sf_run with payload {link_id}, which the guard stores consumed (248). Returns {consumed, simulated, link_id, mode, action_id}. Called by switchboard-run-pages with Alex''s JWT.';
revoke all on function public.switchboard_consume_run_link(text, text, jsonb, integer, text) from public, anon;
grant execute on function public.switchboard_consume_run_link(text, text, jsonb, integer, text) to authenticated;

-- ============================================================================
-- 11. switchboard_cancel_run_link: Don't run, with its note (4.5 point 5).
-- ============================================================================
create function public.switchboard_cancel_run_link(p_token text, p_reason text default null)
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
  end if;
  update public.switchboard_run_links
     set voided_at = now(), void_reason = 'cancelled' || case when v_note = '' then '' else ': ' || v_note end
   where id = v_link.id;
  return jsonb_build_object('cancelled', true, 'link_id', v_link.id, 'reason', nullif(v_note, ''));
end;
$$;
comment on function public.switchboard_cancel_run_link(text, text) is
  'Switchboard 3: Don''t run. Voids an unused link with void_reason "cancelled[: <note>]", the note one line of at most 200 characters (4.5 point 5). Returns {cancelled, link_id, reason}. Called by switchboard-run-pages with Alex''s JWT.';
revoke all on function public.switchboard_cancel_run_link(text, text) from public, anon;
grant execute on function public.switchboard_cancel_run_link(text, text) to authenticated;

-- ============================================================================
-- 12. switchboard_retry_run: "Try again: resend this run", same link id (4.5 points 2 and 3).
-- ============================================================================
create function public.switchboard_retry_run(p_token text, p_fingerprint text, p_desktop jsonb)
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
  -- consumed and unpicked, so a pickup failing it at the same moment leaves one failed run.
  if v_newest.status = 'consumed' then
    update public.switchboard_actions set status = 'failed'
     where id = v_newest.id and status = 'consumed' and picked_up_at is null;
    get diagnostics v_failed = row_count;
    if v_failed = 1 then
      insert into public.switchboard_runs (user_id, action_id, mode, summary, result, failure_reason, finished_at)
      values (v_user, v_newest.id, 'real', 'expired: approved over 15 minutes ago and never picked up, never run',
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
  'Switchboard 3: "Try again: resend this run". Only when the newest sf_run for the link never started (failed expired_not_picked_up, or consumed, never picked up, over 15 minutes old), the request is unchanged, the checks are valid (not for an undo), the desktop is ready and nothing else is live for the project (Q10). Fails a still-consumed stale action (consumed -> failed, with its run) in the same step, then inserts the same sf_run again with the same payload, so the same link id (4.5 points 2, 3). Returns {resent, link_id, action_id, replaces}. Called by switchboard-run-pages with Alex''s JWT.';
revoke all on function public.switchboard_retry_run(text, text, jsonb) from public, anon;
grant execute on function public.switchboard_retry_run(text, text, jsonb) to authenticated;

-- ============================================================================
-- 13. switchboard_record_code_review: the chat records a code review; a newer commit supersedes older ones.
-- ============================================================================
create function public.switchboard_record_code_review(p_request_id uuid, p_review jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_commit text := p_review->>'commit';
  v_id     uuid;
  v_super  integer;
begin
  if v_user is null then
    raise exception 'switchboard_record_code_review: no signed-in user.' using errcode = '28000';
  end if;
  if not exists (select 1 from public.switchboard_run_requests where id = p_request_id and user_id = v_user) then
    raise exception 'switchboard_record_code_review: no such request.' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_review) is distinct from 'object' or v_commit is null or v_commit !~ '^[0-9a-f]{7,40}$' then
    raise exception 'switchboard_record_code_review: add commit: the reviewed commit hash.' using errcode = '23514';
  end if;
  if jsonb_typeof(p_review->'files') is distinct from 'array' or jsonb_array_length(p_review->'files') = 0
     or jsonb_typeof(p_review->'findings') is distinct from 'object' then
    raise exception 'switchboard_record_code_review: add files and findings (spec 4.3).' using errcode = '23514';
  end if;
  update public.switchboard_code_reviews
     set status = 'superseded', superseded_by = v_commit, updated_at = now()
   where request_id = p_request_id and status <> 'superseded' and commit <> v_commit;
  get diagnostics v_super = row_count;
  insert into public.switchboard_code_reviews (user_id, request_id, commit, review)
  values (v_user, p_request_id, v_commit, p_review - array['acknowledged', 'superseded_by', 'status'])
  returning id into v_id;
  return jsonb_build_object('review_id', v_id, 'commit', v_commit, 'superseded', v_super);
end;
$$;
comment on function public.switchboard_record_code_review(uuid, jsonb) is
  'Switchboard 3: record a code review (spec 4.3) of a request''s code at one commit. Older reviews of the request at another commit are marked superseded by it. The finer checks (notes on changed lines, labels) are codeReviewProblems'', run by the queue tool (B3) before this. Returns {review_id, commit, superseded}.';
revoke all on function public.switchboard_record_code_review(uuid, jsonb) from public, anon;
grant execute on function public.switchboard_record_code_review(uuid, jsonb) to authenticated;

-- ============================================================================
-- 14. switchboard_store_run_sample / switchboard_drop_run_sample: the pre-check's result (data runs, plumbing).
-- ============================================================================
create function public.switchboard_store_run_sample(p_request_id uuid, p_sample jsonb)
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
  if v_row.simulation then
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
  'Switchboard 3: store (or replace) a request''s sample record from its pre-check, held until the checks'' valid-until and never more than 24 hours (part 7). Refused for a simulation and without valid evidence. Service role only: called by the data runs thread through plumbing.';
revoke all on function public.switchboard_store_run_sample(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.switchboard_store_run_sample(uuid, jsonb) to service_role;

create function public.switchboard_drop_run_sample(p_request_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  delete from public.switchboard_run_samples where request_id = p_request_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
comment on function public.switchboard_drop_run_sample(uuid) is
  'Switchboard 3: delete a request''s sample when its run finishes (part 7). Returns how many (0 or 1). Service role only.';
revoke all on function public.switchboard_drop_run_sample(uuid) from public, anon, authenticated;
grant execute on function public.switchboard_drop_run_sample(uuid) to service_role;

-- ============================================================================
-- 15. switchboard_prune_sf_results (233): one added delete, the samples past expires_at, as a backstop (part 7).
-- ============================================================================
create or replace function public.switchboard_prune_sf_results()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count   integer;
  v_samples integer;
begin
  delete from public.switchboard_sf_results where expires_at <= now();
  get diagnostics v_count = row_count;
  -- sb3_pages-h6v: run page samples past their expires_at, so client data never stays when nobody reads again.
  delete from public.switchboard_run_samples where expires_at <= now();
  get diagnostics v_samples = row_count;
  return v_count + v_samples;
end;
$$;
comment on function public.switchboard_prune_sf_results() is
  'Switchboard: delete every Salesforce read result past its expires_at, and every run page sample past its expires_at (sb3_pages-h6v, part 7). Returns how many. Run each minute by the cron job switchboard-prune-sf-results; no API role can call it.';
revoke all on function public.switchboard_prune_sf_results() from public, anon, authenticated;

-- ============================================================================
-- 16. Result: must say CONFORMANT. Then run supabase/tests/sb3_pages-h6v/1_verify.sql and 2_failure_test.sql with --test.
-- ============================================================================
select public.platform_check_conformance() as conformance;
