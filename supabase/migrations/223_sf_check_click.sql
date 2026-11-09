-- Switchboard 2.0 s86pa: a sandbox check waits for Alex's click, by a single-use link, as sb_setup does (decided 2026-11-09;
-- a no-click design is its own project). Spec: docs/technical-spec-switchboard2-h8r.md 11.4, 11.6. Tables touched: none
-- (switchboard_actions' guard trigger calls this function on insert).
--
-- needs_click is fixed at insert, so an sf_check queued before this keeps running with no click. Payload checks,
-- switchboard_queue_helper, switchboard_issue_link and switchboard_pickup_helper are unchanged: the pickup already runs a
-- clicked action of any helper kind, and its 10-minute expiry now applies to no new sf_check (its link lasts 30 minutes).

create or replace function public.switchboard_needs_click(p_kind text, p_payload jsonb, p_created_by text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when p_kind = 'git' and p_payload->>'command' in ('gitpush', 'gitnewtree') then true  -- touches main: always
    when p_kind = 'git' then true       -- gitcom, gitsync: a click until the no-click project
    when p_kind = 'sf_check' then true  -- a link for now (s86pa); read-only, on a sandbox the helper proves first
    when p_kind = 'sb_setup' then true  -- writes Switchboard's config: always
    else true                           -- sql, docs and the rest of Salesforce: a click until their own steps say otherwise
  end;
$$;
comment on function public.switchboard_needs_click(text, jsonb, text) is
  'Switchboard: whether an action waits for Alex''s click, from its kind, payload and who queued it (spec 11.1, 11.4). Every kind does for now: git, sf_check (by link since s86pa), sb_setup and the rest. Called by the guard trigger, so a caller never sets needs_click.';
revoke all on function public.switchboard_needs_click(text, jsonb, text) from public, anon;
grant execute on function public.switchboard_needs_click(text, jsonb, text) to authenticated, service_role;
