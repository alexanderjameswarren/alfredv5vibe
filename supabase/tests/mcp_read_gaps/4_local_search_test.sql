-- LOCAL DOCKER ONLY. Never run against the linked project.
-- After migration 163: platform_search_items as an authenticated user, against seeded rows. Rolled back.

begin;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'b@example.test')
on conflict (id) do nothing;
insert into public.contexts (id, name, user_id, shared) values
  ('ctx_a', 'Alfred', '11111111-1111-1111-1111-111111111111', false),
  ('ctx_s', 'Shared', '22222222-2222-2222-2222-222222222222', true),
  ('ctx_b', 'Private B', '22222222-2222-2222-2222-222222222222', false);
insert into public.items (id, name, description, context_id, user_id, status, archived) values
  ('i1', 'Alfred-wide style consistency and design contract', '', 'ctx_a', '11111111-1111-1111-1111-111111111111', 'active', false),
  ('i2', 'Design notes', 'about consistency of style and the contract', 'ctx_a', '11111111-1111-1111-1111-111111111111', 'someday', false),
  ('i3', 'Closed style thing', 'style consistency design contract', 'ctx_a', '11111111-1111-1111-1111-111111111111', 'closed', false),
  ('i4', 'Archived style consistency design contract', '', 'ctx_a', '11111111-1111-1111-1111-111111111111', 'active', true),
  ('i5', 'Shared style consistency design contract', '', 'ctx_s', '22222222-2222-2222-2222-222222222222', 'active', false),
  ('i6', 'Private B style consistency design contract', '', 'ctx_b', '22222222-2222-2222-2222-222222222222', 'active', false),
  ('i7', 'Loose 100% item', 'under_score', null, '11111111-1111-1111-1111-111111111111', 'active', false),
  ('i8', 'Plain', 'nothing here', 'ctx_a', '11111111-1111-1111-1111-111111111111', 'active', false);
insert into public.notes (id, user_id, target_type, target_id, body) values
  ('n1', '11111111-1111-1111-1111-111111111111', 'item', 'i8', 'secret word zebra in a note');

create temp table results (check_name text, ok boolean, detail text) on commit drop;
grant all on results to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

insert into results
select 'words matched separately; name match first; RLS shows own + shared, not private B',
       (r->'rows'->0->>'id') = 'i1' and (r->>'total')::int = 4
         and not (r::text like '%"i6"%') and not (r::text like '%"i4"%'),
       r::text
  from (select public.platform_search_items(p_search_text => 'style consistency design contract', p_limit => 10) as r) x;

insert into results
select 'status filter leaves out closed', (r->>'total')::int = 3 and not (r::text like '%"i3"%'), r::text
  from (select public.platform_search_items(p_search_text => 'style consistency design contract',
                                            p_status => array['someday', 'active', 'background']) as r) x;

insert into results
select 'archived only', (r->>'total')::int = 1 and (r->'rows'->0->>'id') = 'i4', r::text
  from (select public.platform_search_items(p_search_text => 'style contract', p_archived => 'only') as r) x;

insert into results
select 'note body is searched', (r->>'total')::int = 1 and (r->'rows'->0->>'id') = 'i8', r::text
  from (select public.platform_search_items(p_search_text => 'zebra') as r) x;

insert into results
select '% and _ are literal', (a->>'total')::int = 1 and (b->>'total')::int = 1 and (c->>'total')::int = 0, a::text || b::text || c::text
  from (select public.platform_search_items(p_search_text => '100%') as a,
               public.platform_search_items(p_search_text => 'under_score') as b,
               public.platform_search_items(p_search_text => 'under%score') as c) x;

insert into results
select 'punctuation around words is ignored', (r->>'total')::int = 4, r::text
  from (select public.platform_search_items(p_search_text => ' style, (consistency). "design" contract!') as r) x;

insert into results
select 'no_context', (r->>'total')::int = 1 and (r->'rows'->0->>'id') = 'i7', r::text
  from (select public.platform_search_items(p_no_context => true) as r) x;

insert into results
select 'offset pages, total stays', jsonb_array_length(r->'rows') = 1 and (r->>'total')::int = 4
         and (r->'rows'->0->>'id') <> 'i1', r::text
  from (select public.platform_search_items(p_search_text => 'style consistency design contract', p_limit => 1, p_offset => 1) as r) x;

reset role;

select ok, check_name, left(detail, 300) from results order by ok, check_name;
select count(*) filter (where not ok) as failed, count(*) as total from results;

rollback;
