-- Switchboard 2.0 s86ag: switchboard_stakes now says whether a link's page waits for Alex's Approve click (Alex,
-- 2026-11-10). change: the page waits for him to scroll down and click Approve, and shows the red "Approval
-- required" bar. none: the page runs by itself and closes, with nothing to click, which today is only a sql --test
-- (the page runs the test on open; the extension posts the result and closes the tab). It is not about whether
-- anything real changes: a read-only sf_check, gitsync and gitcom all wait for the click, so they are change now.
-- Replaces 227's function. switchboard_issue_link (227) is unchanged and already calls this. Tables touched: none.

create or replace function public.switchboard_stakes(p_kind text, p_payload jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_kind = 'sql' and coalesce(p_payload->'test' = 'true'::jsonb, false) then 'none'  -- runs on open, no click
    else 'change'                                                                           -- waits for Approve
  end;
$$;
comment on function public.switchboard_stakes(text, jsonb) is
  'Switchboard: whether a link''s page waits for Alex''s Approve click (s86ag). change: it waits, and the approve page shows the red Approval required bar; every kind but one, including sf_check, gitsync, gitcom and an unknown kind. none: the page runs by itself and closes, which is only a sql --test (payload.test true). Not about whether anything real changes. Carried in the link url as &stakes=; it decides nothing.';
revoke all on function public.switchboard_stakes(text, jsonb) from public, anon;
grant execute on function public.switchboard_stakes(text, jsonb) to authenticated, service_role;
