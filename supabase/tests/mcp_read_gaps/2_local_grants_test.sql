-- LOCAL DOCKER ONLY. Never run against the linked project.
-- After migrations 158-162: with default privileges that grant nothing (Supabase from 2026-10-30), a table registered with
-- platform.register_table and a view granted with platform.grant_table are fully usable by authenticated and service_role
-- and unreachable by anon. Everything runs in one transaction and is rolled back.

begin;

-- What Supabase does from 2026-10-30: no default grants for new tables.
alter default privileges for role postgres in schema public revoke all on tables from authenticated, service_role, anon;
alter default privileges for role postgres in schema public revoke all on sequences from authenticated, service_role, anon;

create table public.zz_grant_probe (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid(),
  note text
);
comment on table public.zz_grant_probe is 'Local grant test.';
select platform.register_table('public.zz_grant_probe');

create view public.zz_grant_probe_v with (security_invoker = true) as select id, note from public.zz_grant_probe;
comment on view public.zz_grant_probe_v is 'Local grant test.';
select platform.grant_table('public.zz_grant_probe_v');

create temp table results (check_name text, ok boolean, detail text) on commit drop;
grant all on results to authenticated, anon;

insert into results
select 'privilege ' || rl.role || ' ' || pv.priv || ' on ' || o.rel,
       has_table_privilege(rl.role, o.rel, pv.priv) = (rl.role <> 'anon'),
       has_table_privilege(rl.role, o.rel, pv.priv)::text
  from (values ('public.zz_grant_probe'), ('public.zz_grant_probe_v')) as o(rel)
 cross join (values ('authenticated'), ('service_role'), ('anon')) as rl(role)
 cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as pv(priv);

-- As a signed-in user: write, read, update and delete through RLS.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
insert into public.zz_grant_probe (note) values ('written as authenticated');
insert into results select 'authenticated reads its row', count(*) = 1, count(*)::text from public.zz_grant_probe;
insert into results select 'authenticated reads the view', count(*) = 1, count(*)::text from public.zz_grant_probe_v;
update public.zz_grant_probe set note = 'updated';
insert into results select 'authenticated updated', count(*) = 1, count(*)::text from public.zz_grant_probe where note = 'updated';
delete from public.zz_grant_probe;
insert into results select 'authenticated deleted', count(*) = 0, count(*)::text from public.zz_grant_probe;
reset role;

-- As anon: every read is refused.
set local role anon;
do $$
declare
  v_rel text;
begin
  foreach v_rel in array array['public.zz_grant_probe', 'public.zz_grant_probe_v', 'public.items', 'public.allowed_emails'] loop
    begin
      execute format('select 1 from %s limit 1', v_rel);
      insert into results values ('anon refused on ' || v_rel, false, 'read succeeded');
    exception when insufficient_privilege then
      insert into results values ('anon refused on ' || v_rel, true, sqlerrm);
    end;
  end loop;
  begin
    perform public.get_platform_contract();
    insert into results values ('anon refused on get_platform_contract()', false, 'call succeeded');
  exception when insufficient_privilege then
    insert into results values ('anon refused on get_platform_contract()', true, sqlerrm);
  end;
end;
$$;
reset role;

insert into results select 'anon_exposure empty', count(*) = 0, coalesce(string_agg(object_name, ', '), '') from platform.anon_exposure;
insert into results select 'conformance', c like 'CONFORMANT%', c from platform.check_conformance() c;

select ok, check_name, detail from results order by ok, check_name;
select count(*) filter (where not ok) as failed, count(*) as total from results;

rollback;
