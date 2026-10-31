-- Purpose: Switchboard 2.0 step 2.3. The queue behind approval links: switchboard_actions, switchboard_runs and
-- switchboard_settings, with the link functions switchboard_issue_link and switchboard_consume_link.
-- Kind: schema change (three tables, six functions, three triggers, one cron job) plus one seed row
-- Applied: NO
--
-- Spec: docs/technical-spec-switchboard2-h8r.md section 8.1. Run as one block in the SQL editor, then run
-- supabase/tests/switchboard2-h8r/1_verify_queue.sql.
-- Writes go only through the functions and the runner (service role): authenticated can read its own rows, change
-- only its own settings, and never reach a link column directly.
-- supabase/migrations/189_switchboard_queue.sql

begin;

-- ============================================================================
-- 1. The fingerprint: sha256 of the normalised payload.
-- ============================================================================
create or replace function public.switchboard_fingerprint(p_payload jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select encode(sha256(convert_to(
    (case when jsonb_typeof(p_payload->'sql') = 'string'
          then jsonb_set(p_payload, '{sql}', to_jsonb(btrim(replace(p_payload->>'sql', E'\r\n', E'\n'), E' \t\r\n')))
          else p_payload end)::text, 'UTF8')), 'hex');
$$;

comment on function public.switchboard_fingerprint(jsonb) is
  'Switchboard: sha256 hex of an action''s normalised payload. For a payload with sql, CRLF becomes LF and outer '
  'whitespace is trimmed, so a re-saved file keeps its fingerprint. Any other change gives a new one.';
revoke all on function public.switchboard_fingerprint(jsonb) from public, anon;
grant execute on function public.switchboard_fingerprint(jsonb) to authenticated, service_role;


-- ============================================================================
-- 2. switchboard_actions: one queue for every kind of action.
-- ============================================================================
create table if not exists public.switchboard_actions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id),
  kind            text not null,
  project_code    text not null,
  chat_url        text,
  payload         jsonb not null,
  fingerprint     text not null,
  status          text not null default 'queued',
  link_hash       text,
  link_expires_at timestamptz,
  link_used_at    timestamptz,
  created_by      text not null default 'cli',
  needs_click     boolean not null default true,
  headline        text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint switchboard_actions_kind_valid
    check (kind in ('sql', 'git', 'sf_deploy', 'sf_test', 'sf_read_prod_data', 'docs')),
  constraint switchboard_actions_project_format check (project_code ~ '^[a-z0-9_-]{1,40}$'),
  constraint switchboard_actions_status_valid
    check (status in ('queued', 'link_issued', 'consumed', 'succeeded', 'failed', 'cancelled')),
  constraint switchboard_actions_sql_payload
    check (kind <> 'sql' or jsonb_typeof(payload->'sql') = 'string'),
  constraint switchboard_actions_link_complete
    check ((link_hash is null) = (link_expires_at is null)),
  constraint switchboard_actions_used_needs_link
    check (link_used_at is null or link_hash is not null)
);

create unique index if not exists switchboard_actions_link_hash_key
  on public.switchboard_actions (link_hash) where link_hash is not null;
create index if not exists switchboard_actions_waiting_idx
  on public.switchboard_actions (user_id, project_code) where status in ('queued', 'link_issued');

comment on table public.switchboard_actions is
  'SWITCHBOARD. One queue for every action Alex approves by a link: SQL now, git and Salesforce later. The CLI queues '
  'through switchboard-runner; Claude issues the link with switchboard_issue_link; the runner consumes it with '
  'switchboard_consume_link. Authenticated can only read: every write goes through those. Payload and fingerprint '
  'never change after insert. Spec: docs/technical-spec-switchboard2-h8r.md 8.1.';
comment on column public.switchboard_actions.id is 'Row id, the action id Claude issues a link for.';
comment on column public.switchboard_actions.user_id is 'Owner. Owner RLS.';
comment on column public.switchboard_actions.kind is 'sql, git, sf_deploy, sf_test, sf_read_prod_data or docs.';
comment on column public.switchboard_actions.project_code is 'The project that queued it, e.g. switchboard2-h8r.';
comment on column public.switchboard_actions.chat_url is 'Address of the chat the result goes back to. The extension checks the tab against it.';
comment on column public.switchboard_actions.payload is 'What will run. For kind sql: {"sql": "..."}. Fixed after insert.';
comment on column public.switchboard_actions.fingerprint is 'switchboard_fingerprint(payload), set by the guard trigger. A link is bound to it.';
comment on column public.switchboard_actions.status is 'queued, link_issued, consumed, succeeded, failed or cancelled.';
comment on column public.switchboard_actions.link_hash is 'sha256 hex of the link token. The token itself is never stored. Secret: no MCP read returns it.';
comment on column public.switchboard_actions.link_expires_at is 'When the link stops working: 30 minutes after it was issued.';
comment on column public.switchboard_actions.link_used_at is 'When the link was consumed. Set once, never cleared.';
comment on column public.switchboard_actions.created_by is 'Who queued it, e.g. cli.';
comment on column public.switchboard_actions.needs_click is 'Whether it waits for Alex''s click. Drives the panel''s Waiting on SQL.';
comment on column public.switchboard_actions.headline is 'The capitals line on the click page. Built by the server from kind and payload, never written by Claude.';
comment on column public.switchboard_actions.created_at is 'Row creation.';
comment on column public.switchboard_actions.updated_at is 'Last change. Stamped by the guard trigger.';

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
    return new;
  end if;
  if new.payload is distinct from old.payload or new.fingerprint is distinct from old.fingerprint
     or new.kind is distinct from old.kind or new.headline is distinct from old.headline then
    raise exception 'switchboard_actions: payload, fingerprint, kind and headline never change. Queue a new action.'
      using errcode = '23514';
  end if;
  if old.link_used_at is not null
     and (new.link_used_at is distinct from old.link_used_at or new.link_hash is distinct from old.link_hash
          or new.link_expires_at is distinct from old.link_expires_at) then
    raise exception 'switchboard_actions: a used link never changes.' using errcode = '23514';
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
  'Switchboard: before insert or update on switchboard_actions. An insert gets its fingerprint and starts queued with '
  'no link. An update cannot change what will run or reopen a used link, whoever makes it.';
revoke all on function public.switchboard_actions_guard() from public, anon;

drop trigger if exists switchboard_actions_guard on public.switchboard_actions;
create trigger switchboard_actions_guard
  before insert or update on public.switchboard_actions
  for each row execute function public.switchboard_actions_guard();


-- ============================================================================
-- 3. switchboard_runs: one row per dry run or real run.
-- ============================================================================
create table if not exists public.switchboard_runs (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id),
  action_id        uuid not null references public.switchboard_actions (id),
  mode             text not null,
  summary          text,
  result           jsonb,
  result_pruned_at timestamptz,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,

  constraint switchboard_runs_mode_valid check (mode in ('dry_run', 'real'))
);

create index if not exists switchboard_runs_action_idx on public.switchboard_runs (action_id);
create index if not exists switchboard_runs_prune_idx
  on public.switchboard_runs (started_at) where result is not null;

comment on table public.switchboard_runs is
  'SWITCHBOARD. One row per dry run or real run of an action, written by switchboard-runner. Visible only to its owner. '
  'switchboard_prune_runs clears result after 30 days; the row stays. Not audited, so that no copy of a result outlives '
  'the prune in the audit log. Claude reads it with get_switchboard_run.';
comment on column public.switchboard_runs.id is 'Row id, the run id the chat receives as "sql <run id>".';
comment on column public.switchboard_runs.user_id is 'Owner. Owner RLS.';
comment on column public.switchboard_runs.action_id is 'The action this ran.';
comment on column public.switchboard_runs.mode is 'dry_run (rolled back) or real.';
comment on column public.switchboard_runs.summary is 'One plain line of what happened, e.g. deletes 3 rows from wb_rules.';
comment on column public.switchboard_runs.result is 'The full result. Cleared after 30 days.';
comment on column public.switchboard_runs.result_pruned_at is 'When result was cleared. Empty until then.';
comment on column public.switchboard_runs.started_at is 'When the run began.';
comment on column public.switchboard_runs.finished_at is 'When it ended. Empty while running.';

create or replace function public.switchboard_prune_runs()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update public.switchboard_runs
     set result = null, result_pruned_at = now()
   where result is not null and started_at < now() - interval '30 days';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.switchboard_prune_runs() is
  'Switchboard: clear the result of every run older than 30 days and keep the row. Returns how many. Run daily by the '
  'cron job switchboard-prune-runs; no API role can call it.';
revoke all on function public.switchboard_prune_runs() from public, anon, authenticated, service_role;


-- ============================================================================
-- 4. switchboard_settings: one row per user, holding the kill switch.
-- ============================================================================
create table if not exists public.switchboard_settings (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id),
  reads_enabled boolean not null default true,
  link_base_url text not null default 'https://alfredv5vibe.vercel.app',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint switchboard_settings_one_per_user unique (user_id),
  constraint switchboard_settings_base_format check (link_base_url ~ '^https://[^/]+$')
);

comment on table public.switchboard_settings is
  'SWITCHBOARD. One row per user: the kill switch for Claude''s read-only queries, and the address approval links are '
  'built on. Seeded for Alex by migration; authenticated can read and update it, not add or remove it.';
comment on column public.switchboard_settings.id is 'Row id.';
comment on column public.switchboard_settings.user_id is 'Owner. Owner RLS; one row per user.';
comment on column public.switchboard_settings.reads_enabled is 'The kill switch. False stops every read-only query.';
comment on column public.switchboard_settings.link_base_url is 'https://host with no trailing slash. A server setting, never code (spec 2, rule 8).';
comment on column public.switchboard_settings.created_at is 'Row creation.';
comment on column public.switchboard_settings.updated_at is 'Last change. Stamped by the guard trigger.';

create or replace function public.switchboard_settings_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.id         := old.id;
  new.user_id    := old.user_id;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.switchboard_settings_guard() is
  'Switchboard: before update on switchboard_settings. Keeps id, user_id and created_at fixed and stamps updated_at.';
revoke all on function public.switchboard_settings_guard() from public, anon;

drop trigger if exists switchboard_settings_guard on public.switchboard_settings;
create trigger switchboard_settings_guard
  before update on public.switchboard_settings
  for each row execute function public.switchboard_settings_guard();

do $$
begin
  if not exists (select 1 from auth.users where lower(email) = 'alexanderjameswarren@gmail.com') then
    raise exception 'switchboard_settings: no auth user alexanderjameswarren@gmail.com to own the seed row';
  end if;
end
$$;

insert into public.switchboard_settings (user_id)
select u.id from auth.users u
 where lower(u.email) = 'alexanderjameswarren@gmail.com'
on conflict (user_id) do nothing;


-- ============================================================================
-- 5. switchboard_issue_link: a single-use link, 30 minutes, one live at a time.
-- ============================================================================
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
  v_expires timestamptz := now() + interval '30 minutes';
begin
  if v_user is null then
    raise exception 'switchboard_issue_link: no signed-in user.' using errcode = '28000';
  end if;
  -- Two calls at once must not both find no live link.
  perform pg_advisory_xact_lock(hashtextextended('switchboard_issue_link:' || v_user::text, 0));

  select * into v_action from public.switchboard_actions
   where id = p_action_id and user_id = v_user for update;
  if not found then
    raise exception 'switchboard_issue_link: no such action.' using errcode = 'P0002';
  end if;
  if v_action.link_used_at is not null or v_action.status not in ('queued', 'link_issued') then
    raise exception 'switchboard_issue_link: this action is %, so it cannot have a new link. Queue it again.',
      v_action.status using errcode = '55000';
  end if;

  select id into v_live from public.switchboard_actions
   where user_id = v_user and link_hash is not null and link_used_at is null and link_expires_at > now()
   limit 1;
  if v_live is not null then
    raise exception 'switchboard_issue_link: another link is live (action %). One at a time: wait until it is used or expires.',
      v_live using errcode = '55000';
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

  return jsonb_build_object('action_id', v_action.id, 'url', v_base || '/approve/' || v_token,
                            'expires_at', v_expires, 'headline', v_action.headline);
end;
$$;

comment on function public.switchboard_issue_link(uuid) is
  'Switchboard: issue the approval link for one of the caller''s actions. Returns {action_id, url, expires_at, headline}. '
  'The token appears only in this result; the row keeps its hash. Refused while any link of the caller''s is live, and '
  'for an action already consumed. An expired link can be replaced. Called by the issue_switchboard_link tool.';
revoke all on function public.switchboard_issue_link(uuid) from public, anon, service_role;
grant execute on function public.switchboard_issue_link(uuid) to authenticated;


-- ============================================================================
-- 6. switchboard_consume_link: refuses a used, expired or fingerprint-mismatched link.
-- ============================================================================
create or replace function public.switchboard_consume_link(p_token text, p_fingerprint text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_hash   text := encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
  v_id     uuid;
  v_action public.switchboard_actions;
begin
  if v_user is null then
    raise exception 'switchboard_consume_link: no signed-in user.' using errcode = '28000';
  end if;

  -- One atomic update: of two clicks at once, only one gets a row back.
  update public.switchboard_actions
     set link_used_at = now(), status = 'consumed'
   where link_hash = v_hash and user_id = v_user and link_used_at is null
     and link_expires_at > now() and fingerprint = p_fingerprint
  returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('consumed', true, 'action_id', v_id);
  end if;

  select * into v_action from public.switchboard_actions where link_hash = v_hash and user_id = v_user;
  if not found then
    raise exception 'switchboard_consume_link: no such link.' using errcode = 'P0002';
  elsif v_action.link_used_at is not null then
    raise exception 'switchboard_consume_link: this link has already been used.' using errcode = '55000';
  elsif v_action.link_expires_at <= now() then
    raise exception 'switchboard_consume_link: this link has expired.' using errcode = '55000';
  end if;
  raise exception 'switchboard_consume_link: the SQL does not match what this link approved.' using errcode = '55000';
end;
$$;

comment on function public.switchboard_consume_link(text, text) is
  'Switchboard: spend an approval link, given its token and the fingerprint of the SQL about to run. Returns {consumed, '
  'action_id} once. Raises for a used, expired, unknown or mismatched link, or another user''s. A mismatch does not '
  'spend the link. Called by switchboard-runner with Alex''s JWT.';
revoke all on function public.switchboard_consume_link(text, text) from public, anon, service_role;
grant execute on function public.switchboard_consume_link(text, text) to authenticated;


-- ============================================================================
-- 7. Register: owner RLS, explicit grants, no anon. Then take writes back from authenticated.
-- ============================================================================
select platform.register_table(
  'public.switchboard_actions',
  p_policy_mode    => 'owner',
  p_audited        => true,
  p_exempt         => false,
  p_secret_columns => array['link_hash'],
  p_notes          => 'Switchboard approval queue. Read-only for authenticated; written by switchboard-runner and the link functions.'
);
select platform.register_table(
  'public.switchboard_runs',
  p_policy_mode => 'owner',
  p_audited     => false,
  p_exempt      => false,
  p_notes       => 'Switchboard run history. Not audited, so results do not outlive the 30-day prune in the audit log. Written by switchboard-runner.'
);
select platform.register_table(
  'public.switchboard_settings',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'Switchboard kill switch and link address; one row per user.'
);

revoke insert, update, delete on public.switchboard_actions from authenticated;
revoke insert, update, delete on public.switchboard_runs from authenticated;
revoke insert, delete on public.switchboard_settings from authenticated;


-- ============================================================================
-- 8. The daily prune.
-- ============================================================================
select cron.unschedule(jobid) from cron.job where jobname = 'switchboard-prune-runs';
select cron.schedule('switchboard-prune-runs', '20 11 * * *', 'select public.switchboard_prune_runs()');

commit;

-- ============================================================================
-- 9. Result: must say CONFORMANT. Then run supabase/tests/switchboard2-h8r/1_verify_queue.sql.
-- ============================================================================
select public.platform_check_conformance() as conformance;
