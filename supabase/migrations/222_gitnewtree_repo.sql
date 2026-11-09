-- Switchboard 2.0 s86k: a gitnewtree may name its repo (switchboard s86j), since a worktree that does not exist yet
-- cannot be found from its project code. Spec: docs/technical-spec-switchboard2-h8r.md 11.3. Tables touched: switchboard_actions.
--
-- 207's git payload check is unchanged. This adds a second check: a git row's "repo" is allowed only on a gitnewtree,
-- and is then an absolute Windows path (C:\...) with no "..", no forbidden character and no trailing backslash.
-- The helper still requires it to be a repos.json key. No row has a repo today, so the check is validated.

alter table public.switchboard_actions
  add constraint switchboard_actions_git_repo check (
    kind <> 'git'
    or not coalesce(payload ? 'repo', false)
    or (coalesce(payload->>'command' = 'gitnewtree', false)
        and coalesce(jsonb_typeof(payload->'repo') = 'string', false)
        and coalesce(length(payload->>'repo') <= 240, false)
        and coalesce(payload->>'repo' ~ '^[A-Za-z]:(\\[^\\/:*?"<>|[:cntrl:]]+)+$', false)
        and coalesce(strpos(payload->>'repo', '..') = 0, false))
  );

comment on column public.switchboard_actions.payload is
  'What will run. sql: {"sql": "..."}. git: {"command": "gitcom|gitsync|gitnewtree|gitpush", ...}, and a gitnewtree may name its "repo", an absolute path (spec 11.3). sf_check: {"check", "alias", "metadata_type" for metadata} (spec 11.4). sb_setup: {"command": "client start|org add", "client", "orgs": [...], "folder" with from_sandbox, ...} (spec 11.5). Fixed after insert.';
