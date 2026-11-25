-- 255, sb3_pages-h6v s21b (follow-up to 254): the run page learns how its run ended. Schema change: one
-- function replaced. Spec: docs/technical-spec-sb3_pages-h6v.md 14.8.
-- Function: switchboard_run_preview (254's, replaced whole). No table changes, no data changes.
-- Tables read: switchboard_run_links, switchboard_run_requests, switchboard_actions, switchboard_runs,
-- switchboard_run_samples (the expired-sample delete, as 250), switchboard_code_reviews.
--
-- Why (s21, the live end-to-end test): a run the helper refused has status failed, result {ok:false}, its reason in
-- summary and no failure_reason (only the 15-minute expiry writes that, 247), so the page, which saw only
-- failure_reason, said "finished". PASS and FAIL both end succeeded; which one is only in result.pass.
--
-- switchboard_run_preview: 254's, unchanged, plus three fields on `run`:
--   ok       result.ok, a boolean, or null
--   pass     result.pass, a boolean, or null
--   summary  the run's summary, its first 500 characters, or null
-- switchboard_prune_runs clears result after 30 days and keeps summary, so a pruned run has ok and pass null and
-- its summary still there. ok and pass are read only when they are JSON booleans, so a malformed result reads null
-- and never breaks the preview.

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
             'rerun', v_action.id = v_link.rerun_action_id,
             -- s21b: how the run ended. Null once switchboard_prune_runs clears result; summary is kept.
             'ok', case when jsonb_typeof(v_run.result->'ok') = 'boolean' then (v_run.result->>'ok')::boolean end,
             'pass', case when jsonb_typeof(v_run.result->'pass') = 'boolean' then (v_run.result->>'pass')::boolean end,
             'summary', left(v_run.summary, 500)) end,
    'sample', case when v_sample.id is null then null else v_sample.sample end,
    'review', case when v_review.id is null then null else
               v_review.review || jsonb_build_object('id', v_review.id, 'commit', v_review.commit, 'status', v_review.status,
                                                     'superseded_by', v_review.superseded_by, 'acknowledged', v_review.acks) end);
end;
$$;
comment on function public.switchboard_run_preview(text) is
  'Switchboard 3: what a run or review page shows for its token, read at page open and at a click. Returns {link_id, request (with id, page, version, corrected_at, evidence, simulation, rerun_at), fingerprint, total_count (the request''s count, which switchboard_consume_run_link checks and the page sends with Approve; null when the request has none), outcome, outcome_run_id, outcome_recorded_at (254: the write''s outcome, null until recorded and on any link but the one whose approved run recorded it), link {version, current, used_at, rerun_at, voided_at, void_reason}, valid_until, expired (never for an undo), run (the newest sf_run for this link id: status, consumed_at, picked_up_at, finished_at, failure_reason, not_started, rerun, and from s21b ok and pass (result.ok and result.pass when booleans, null once the result is pruned) and summary (its first 500 characters)), sample, review}. Deletes the sample when it is past expires_at. Called by switchboard-run-pages with Alex''s JWT.';
revoke all on function public.switchboard_run_preview(text) from public, anon;
grant execute on function public.switchboard_run_preview(text) to authenticated;

-- Result: must say CONFORMANT. Then run supabase/tests/sb3_pages-h6v/7_preview_run_end_test.sql with --test.
select public.platform_check_conformance() as conformance;
