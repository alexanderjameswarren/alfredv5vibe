-- Switchboard 2.0 s86ac: a link says what is at stake, "change" or "none" (Alex, 2026-11-10: no green anywhere), so
-- the chat's tile and the approve page can show it. Spec: docs/technical-spec-switchboard2-h8r.md 11. Tables touched:
-- none (switchboard_issue_link updates switchboard_actions, as in 206).
--
-- switchboard_issue_link is 206's, unchanged but for &stakes=<value> after kind in the url. No later migration
-- replaced it (208, 218, 220 and 223 leave it as it was).

create or replace function public.switchboard_stakes(p_kind text, p_payload jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_kind = 'sql' then case when coalesce(p_payload->'test' = 'true'::jsonb, false) then 'none' else 'change' end
    when p_kind = 'sf_check' then 'none'                                                     -- read only, on a sandbox
    when p_kind = 'git' and p_payload->>'command' in ('gitsync', 'gitcom') then 'none'       -- inside the worktree
    else 'change'                         -- gitpush, gitnewtree, sb_setup, sf_deploy, sf_test and any unknown kind
  end;
$$;
comment on function public.switchboard_stakes(text, jsonb) is
  'Switchboard: what an action puts at stake, change or none (s86ac). none: a sql test (payload.test true), sf_check, git gitsync and gitcom. change: everything else, including an unknown kind. Shown on the link''s tile and the approve page; it decides nothing.';
revoke all on function public.switchboard_stakes(text, jsonb) from public, anon;
grant execute on function public.switchboard_stakes(text, jsonb) to authenticated, service_role;

create or replace function public.switchboard_issue_link(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_action  public.switchboard_actions;
  v_live    uuid;
  v_base    text;
  v_token   text;
  v_kind    text;
  v_expires timestamptz := now() + interval '30 minutes';
begin
  if v_user is null then
    raise exception 'switchboard_issue_link: no signed-in user.' using errcode = '28000';
  end if;

  select * into v_action from public.switchboard_actions
   where id = p_action_id and user_id = v_user;
  if not found then
    raise exception 'switchboard_issue_link: no such action.' using errcode = 'P0002';
  end if;

  -- Two calls at once for one project must not both find no live link. The row is read again under the lock.
  perform pg_advisory_xact_lock(hashtextextended('switchboard_issue_link:' || v_user::text || ':' || v_action.project_code, 0));
  select * into v_action from public.switchboard_actions
   where id = p_action_id and user_id = v_user for update;
  if v_action.link_used_at is not null or v_action.status not in ('queued', 'link_issued') then
    raise exception 'switchboard_issue_link: this action is %, so it cannot have a new link. Queue it again.',
      v_action.status using errcode = '55000';
  end if;
  if not v_action.needs_click then
    raise exception 'switchboard_issue_link: this action runs without a click, so it has no link.' using errcode = '55000';
  end if;

  select id into v_live from public.switchboard_actions
   where user_id = v_user and project_code = v_action.project_code
     and link_hash is not null and link_used_at is null and link_expires_at > now()
   limit 1;
  if v_live is not null then
    raise exception 'switchboard_issue_link: another link is live for % (action %). One at a time per project: wait until it is used or expires.',
      v_action.project_code, v_live using errcode = '55000';
  end if;

  select link_base_url into v_base from public.switchboard_settings where user_id = v_user;
  if v_base is null then
    raise exception 'switchboard_issue_link: no switchboard_settings row for this user.' using errcode = 'P0002';
  end if;

  -- Two v4 UUIDs: 244 random bits from the server's strong source. Only the hash is kept.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  update public.switchboard_actions
     set link_hash = encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
         link_expires_at = v_expires,
         status = 'link_issued'
   where id = v_action.id;

  -- For display only: the chat's tile reads these. The token alone proves anything. Stakes from the real kind.
  v_kind := case when v_action.kind in ('sf_deploy', 'sf_test') then 'deploy' else v_action.kind end;
  return jsonb_build_object('action_id', v_action.id,
                            'url', v_base || '/approve/' || v_token || '?kind=' || v_kind
                                   || '&stakes=' || public.switchboard_stakes(v_action.kind, v_action.payload)
                                   || '&exp=' || extract(epoch from v_expires)::bigint,
                            'expires_at', v_expires, 'headline', v_action.headline);
end;
$$;
comment on function public.switchboard_issue_link(uuid) is
  'Switchboard: issue the approval link for one of the caller''s actions. Returns {action_id, url, expires_at, headline}. The url ends ?kind=<kind>&stakes=<change|none>&exp=<unix seconds>, for the chat''s tile (stakes since s86ac, from switchboard_stakes). The token appears only in this result; the row keeps its hash. Refused while a link of the caller''s is live for the same project code, for an action already consumed, and for one that needs no click. An expired link can be replaced. Called by the issue_switchboard_link tool.';
revoke all on function public.switchboard_issue_link(uuid) from public, anon;
grant execute on function public.switchboard_issue_link(uuid) to authenticated, service_role;
