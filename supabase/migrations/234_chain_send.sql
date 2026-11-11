-- Switchboard 2.0 s90a: the chained link. A git action may carry then: {send: "<run tag>"}: one approve link runs the
-- git command and then, only if it succeeds, sends the CLI prompt with that run tag into the same project's window at
-- Alex's tap (spec 11.9, Alex 2026-11-10 and 2026-11-11). Allowed on gitsync and on gitpush checkpoint or push; never
-- on gitcom, gitnewtree or gitpush finish. The tag must start with the action's own project code and "-s", so a chain
-- only ever sends into the window it synced or checkpointed.
-- Kind: schema change (a check constraint). Tables touched: switchboard_actions.
--
-- 207's command and mode rule is kept as it was. The whole check is coalesced to false, since a CHECK passes on NULL
-- (the 207 lesson). Every existing row has no then, so every one still meets it.

alter table public.switchboard_actions drop constraint switchboard_actions_git_payload;
alter table public.switchboard_actions
  add constraint switchboard_actions_git_payload check (
    kind <> 'git'
    or coalesce((
      -- 207: the command, and gitpush's mode.
      (coalesce(payload->>'command', '') in ('gitcom', 'gitsync', 'gitnewtree')
       or (coalesce(payload->>'command', '') = 'gitpush' and coalesce(payload->>'mode', '') in ('push', 'checkpoint', 'finish')))
      -- s90a: then, only where a chain is allowed, and only {send: <this project's run tag>}.
      and (not (payload ? 'then')
           or ((payload->>'command' = 'gitsync'
                or (payload->>'command' = 'gitpush' and payload->>'mode' in ('checkpoint', 'push')))
               and jsonb_typeof(payload->'then') = 'object'
               -- Bracketed: - binds tighter than ->, so unbracketed this read as payload -> ('then' - 'send') (s90ab).
               and (payload->'then') - 'send'::text = '{}'::jsonb
               and jsonb_typeof(payload->'then'->'send') = 'string'
               and length(payload->'then'->>'send') <= 40
               and payload->'then'->>'send' ~ '^[a-z0-9_-]+$'
               and left(payload->'then'->>'send', length(project_code) + 2) = project_code || '-s'
               and substr(payload->'then'->>'send', length(project_code) + 3) ~ '^[0-9]+[a-z]*-[a-z0-9]{4}$'))
    ), false)
  );

comment on column public.switchboard_actions.payload is
  'What will run. sql: {"sql": "..."}. git: {"command": "gitcom|gitsync|gitnewtree|gitpush", ...}, and a gitnewtree may name its "repo", an absolute path (spec 11.3); a gitsync, or a gitpush checkpoint or push, may add "then": {"send": "<run tag>"}, a prompt of the same project sent at Alex''s tap only if the command succeeds (spec 11.9, s90a). sf_check: {"check", "alias", "metadata_type" for metadata} (spec 11.4). sb_setup: {"command": "client start|org add", "client", "orgs": [...], "folder" with from_sandbox, ...} (spec 11.5). sf_read: {"alias", "production", "level": "objects|metadata|ids|data", "object", "count" or "fields" with "limit", "filters"}, never SOQL text (spec 10). Fixed after insert.';

-- Result: must say CONFORMANT. Then run supabase/tests/switchboard2-h8r/16_verify_chain_send.sql.
select public.platform_check_conformance() as conformance;
