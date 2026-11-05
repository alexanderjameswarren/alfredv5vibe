-- Switchboard 2.0 s80: git actions in the queue. The server decides needs_click from the action type (spec 11.1),
-- the helper picks up git actions that are ready, and the clips.source comment names clip.cmd.
-- Spec: docs/technical-spec-switchboard2-h8r.md 11.1. Tables touched: switchboard_actions, switchboard_runs, clips.

-- 1. A git payload names one of the four commands; gitpush also names its mode.
alter table public.switchboard_actions
  add constraint switchboard_actions_git_payload check (
    kind <> 'git'
    or (payload->>'command' in ('gitcom', 'gitsync', 'gitnewtree'))
    or (payload->>'command' = 'gitpush' and payload->>'mode' in ('push', 'checkpoint', 'finish'))
  );

-- 2. When the helper took the action. Set once, by switchboard_pickup_git.
alter table public.switchboard_actions add column picked_up_at timestamptz;
comment on column public.switchboard_actions.picked_up_at is
  'When the helper picked the action up to run it. Set once by switchboard_pickup_git, never cleared. Empty until then.';
grant select (picked_up_at) on table public.switchboard_actions to claude_reader;

-- 3. The click rules. Every git link needs a click for the first two weeks; s85 lifts gitcom and gitsync.
create or replace function public.switchboard_needs_click(p_kind text, p_payload jsonb, p_created_by text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when p_kind = 'git' and p_payload->>'command' in ('gitpush', 'gitnewtree') then true  -- touches main: always
    when p_kind = 'git' then true  -- gitcom, gitsync: a click for the first two weeks
    else true                      -- sql, docs and Salesforce: a click until their own steps say otherwise
  end;
$$;
comment on function public.switchboard_needs_click(text, jsonb, text) is
  'Switchboard: whether an action waits for Alex''s click, from its kind, payload and who queued it (spec 11.1). gitpush and gitnewtree always do. gitcom and gitsync do for the first two weeks of git links. Everything else does for now. Called by the guard trigger, so a caller never sets needs_click.';
revoke all on function public.switchboard_needs_click(text, jsonb, text) from public, anon;
grant execute on function public.switchboard_needs_click(text, jsonb, text) to authenticated, service_role;

-- 4. The guard sets needs_click on insert and keeps it, and picked_up_at, fixed afterwards.
create or replace function public.switchboard_actions_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.fingerprint     := public.switchboard_fingerprint(new.payload);
    new.status          := 'queued';
    new.link_hash       := null;
    new.link_expires_at := null;
    new.link_used_at    := null;
    new.picked_up_at    := null;
    new.needs_click     := public.switchboard_needs_click(new.kind, new.payload, new.created_by);
    return new;
  end if;
  if new.payload is distinct from old.payload or new.fingerprint is distinct from old.fingerprint
     or new.kind is distinct from old.kind or new.headline is distinct from old.headline
     or new.needs_click is distinct from old.needs_click then
    raise exception 'switchboard_actions: payload, fingerprint, kind, headline and needs_click never change. Queue a new action.'
      using errcode = '23514';
  end if;
  if old.link_used_at is not null
     and (new.link_used_at is distinct from old.link_used_at or new.link_hash is distinct from old.link_hash
          or new.link_expires_at is distinct from old.link_expires_at) then
    raise exception 'switchboard_actions: a used link never changes.' using errcode = '23514';
  end if;
  if old.picked_up_at is not null and new.picked_up_at is distinct from old.picked_up_at then
    raise exception 'switchboard_actions: picked_up_at is set once.' using errcode = '23514';
  end if;
  new.id         := old.id;
  new.user_id    := old.user_id;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end;
$$;
comment on function public.switchboard_actions_guard() is
  'Switchboard: before insert or update on switchboard_actions. An insert gets its fingerprint and needs_click (switchboard_needs_click) and starts queued with no link. An update cannot change what will run or whether it needs a click, reopen a used link, or change picked_up_at once set, whoever makes it.';

-- 5. No link for an action that runs without a click.
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

  -- For display only: the chat's tile reads these. The token alone proves anything.
  v_kind := case when v_action.kind in ('sf_deploy', 'sf_test') then 'deploy' else v_action.kind end;
  return jsonb_build_object('action_id', v_action.id,
                            'url', v_base || '/approve/' || v_token || '?kind=' || v_kind || '&exp=' || extract(epoch from v_expires)::bigint,
                            'expires_at', v_expires, 'headline', v_action.headline);
end;
$$;
comment on function public.switchboard_issue_link(uuid) is
  'Switchboard: issue the approval link for one of the caller''s actions. Returns {action_id, url, expires_at, headline}. The url ends ?kind=<kind>&exp=<unix seconds>, for the chat''s tile. The token appears only in this result; the row keeps its hash. Refused while a link of the caller''s is live for the same project code, for an action already consumed, and for one that needs no click. An expired link can be replaced. Called by the issue_switchboard_link tool.';
revoke all on function public.switchboard_issue_link(uuid) from public, anon;
grant execute on function public.switchboard_issue_link(uuid) to authenticated;

-- 6. The helper's pickup: the oldest ready git action, one at a time per project, with its run row.
create or replace function public.switchboard_pickup_git(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action public.switchboard_actions;
  v_run    uuid;
begin
  if p_user is null then
    raise exception 'switchboard_pickup_git: no user.' using errcode = '22004';
  end if;

  -- Ready: clicked (consumed), or queued and needing no click. Not while that project has one running.
  select a.* into v_action from public.switchboard_actions a
   where a.user_id = p_user and a.kind = 'git' and a.picked_up_at is null
     and (a.status = 'consumed' or (a.status = 'queued' and not a.needs_click))
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
  insert into public.switchboard_runs (user_id, action_id, mode, summary)
  values (p_user, v_action.id, 'real', 'picked up by the helper')
  returning id into v_run;

  return jsonb_build_object('action_id', v_action.id, 'run_id', v_run, 'project_code', v_action.project_code,
                            'payload', v_action.payload, 'fingerprint', v_action.fingerprint,
                            'headline', v_action.headline, 'chat_url', v_action.chat_url);
end;
$$;
comment on function public.switchboard_pickup_git(uuid) is
  'Switchboard: hand the helper the oldest git action of p_user that is ready to run: clicked, or queued and needing no click. One at a time per project code. Sets picked_up_at, marks it consumed and opens a real run row. Returns {action_id, run_id, project_code, payload, fingerprint, headline, chat_url}, or null when nothing is ready. Called by switchboard-runner with the service role after it checks the pickup key; no other role can call it.';
revoke all on function public.switchboard_pickup_git(uuid) from public, anon, authenticated;
grant execute on function public.switchboard_pickup_git(uuid) to service_role;

-- 7. Column comments that now say more.
comment on column public.switchboard_actions.payload is
  'What will run. For kind sql: {"sql": "..."}. For kind git: {"command": "gitcom|gitsync|gitnewtree|gitpush", "mode" for gitpush: "push|checkpoint|finish", ...}. Fixed after insert.';
comment on column public.switchboard_actions.needs_click is
  'Whether it waits for Alex''s click. Set by the guard from switchboard_needs_click, never by the caller, and fixed after insert. Drives the panel''s Waiting on SQL.';
comment on column public.clips.source is
  'clipboard = captured by the Chrome extension. cli = a report pushed by the Claude CLI via clip.cmd (installed Switchboard). Enforced by clips_source_check.';
