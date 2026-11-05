-- Switchboard 2.0 s84c: switchboard_queue_git, so the queue_switchboard_git tool can queue a git action as Alex.
-- Authenticated cannot insert into switchboard_actions (189); this is the one way Claude does.
-- Spec: docs/technical-spec-switchboard2-h8r.md 11.3. Tables touched: switchboard_actions.

create or replace function public.switchboard_queue_git(p_project_code text, p_payload jsonb, p_headline text, p_chat_url text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_id   uuid;
begin
  if v_user is null then
    raise exception 'switchboard_queue_git: no signed-in user.' using errcode = '28000';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'switchboard_queue_git: the payload must be a JSON object.' using errcode = '23514';
  end if;
  if p_headline is null or btrim(p_headline) = '' then
    raise exception 'switchboard_queue_git: a headline is required.' using errcode = '23514';
  end if;

  -- The guard trigger sets fingerprint, status and needs_click; the table's checks refuse a bad code or payload.
  insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, chat_url, created_by)
  values (v_user, 'git', p_project_code, p_payload, btrim(p_headline), p_chat_url, 'claude')
  returning id into v_id;
  return jsonb_build_object('action_id', v_id);
end;
$$;
comment on function public.switchboard_queue_git(text, jsonb, text, text) is
  'Switchboard: queue a git action for the signed-in caller, as created_by claude, and return {action_id}. Kind git only. The guard trigger sets fingerprint, status and needs_click; the git payload check refuses an unknown command or a gitpush with no mode. The link is issued separately by switchboard_issue_link. Called by the queue_switchboard_git tool (spec 11.3).';
revoke all on function public.switchboard_queue_git(text, jsonb, text, text) from public, anon;
grant execute on function public.switchboard_queue_git(text, jsonb, text, text) to authenticated;
