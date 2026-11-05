-- Switchboard 2.0 s80c: the git payload check from 206 let a missing command or mode through, because
-- `null in (...)` is null and a check passes on null. Coalesce both so a missing value is refused.
-- Spec: docs/technical-spec-switchboard2-h8r.md 11.1. Tables touched: switchboard_actions.

alter table public.switchboard_actions drop constraint switchboard_actions_git_payload;
alter table public.switchboard_actions
  add constraint switchboard_actions_git_payload check (
    kind <> 'git'
    or coalesce(payload->>'command', '') in ('gitcom', 'gitsync', 'gitnewtree')
    or (coalesce(payload->>'command', '') = 'gitpush' and coalesce(payload->>'mode', '') in ('push', 'checkpoint', 'finish'))
  );
